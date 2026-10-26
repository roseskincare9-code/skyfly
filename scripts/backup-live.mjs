// Downloads a full backup of the live Skyfly database through the supported route
// (Platform admin → System → Download full backup, /admin/backup.json) and checks it.
// Prints only the file's size, checksum, migrations and row counts — never customer data.
//   SKYFLY_URL=https://… SKYFLY_OWNER_EMAIL=… SKYFLY_OWNER_PASSWORD=… node scripts/backup-live.mjs backup.json
import { createWriteStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const [out = 'backup.json'] = process.argv.slice(2);
const SKYFLY = (process.env.SKYFLY_URL || '').replace(/\/+$/, '');
const { SKYFLY_OWNER_EMAIL: email, SKYFLY_OWNER_PASSWORD: password } = process.env;
const backupKey = process.env.SKYFLY_BACKUP_KEY || '';
if (!backupKey && (!email || !password)) {
  console.log('BLOCKED  Backup download — needs SKYFLY_BACKUP_KEY on Render (with the RENDER_API_KEY secret here) or the SKYFLY_OWNER_EMAIL and SKYFLY_OWNER_PASSWORD repository secrets.');
  process.exit(2);
}

let res;
if (backupKey) {
  // The server's backup key: no sign-in, this one download only.
  await fetch(`${SKYFLY}/healthz`, { signal: AbortSignal.timeout(90000) }).catch(() => {});
  res = await fetch(`${SKYFLY}/admin/backup.json`, { headers: { Authorization: `Bearer ${backupKey}` }, redirect: 'manual' });
  if (res.status !== 200) { console.log(`FAIL  Backup download with the backup key: HTTP ${res.status} (is this version of Skyfly deployed, and the key the one on Render?).`); process.exit(1); }
} else {
// Sign in like a browser: the login page's CSRF token and cookie, then the form.
const jar = new Map();
const cookies = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
const keep = (res) => { for (const c of res.headers.getSetCookie?.() ?? []) { const [kv] = c.split(';'); const i = kv.indexOf('='); jar.set(kv.slice(0, i), kv.slice(i + 1)); } };
await fetch(`${SKYFLY}/healthz`, { signal: AbortSignal.timeout(90000) }).catch(() => {});
const loginPage = await fetch(`${SKYFLY}/login`);
keep(loginPage);
const csrf = (await loginPage.text()).match(/name="_csrf" value="([^"]+)"/)?.[1];
const login = await fetch(`${SKYFLY}/login`, {
  method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookies() },
  body: new URLSearchParams({ _csrf: csrf, email, password }),
});
keep(login);
if (login.status !== 302) { console.log(`FAIL  Sign-in refused (HTTP ${login.status}). Check the secrets.`); process.exit(1); }

res = await fetch(`${SKYFLY}/admin/backup.json`, { headers: { Cookie: cookies() }, redirect: 'manual' });
if (res.status !== 200) { console.log(`FAIL  Backup download HTTP ${res.status} (the account must be the platform owner).`); process.exit(1); }
}
await pipeline(Readable.fromWeb(res.body), createWriteStream(out));

const raw = await readFile(out);
const size = (await stat(out)).size;
const backup = JSON.parse(raw.toString('utf8'));
if (backup.format !== 'skyfly-backup-v1') throw new Error(`Unexpected format ${backup.format}`);
console.log(`PASS  Backup downloaded: ${(size / 1024).toFixed(1)} KB, sha256 ${createHash('sha256').update(raw).digest('hex')}`);
console.log(`      Created ${backup.createdAt}; ${backup.migrations.length} migrations, latest ${backup.migrations.at(-1)}`);
const rows = Object.fromEntries(Object.entries(backup.tables).map(([t, v]) => [t, v.rows.length]));
console.log('      Rows per table:');
for (const [t, n] of Object.entries(rows)) console.log(`        ${t.padEnd(26)} ${n}`);
// Aggregates only (no names, phones or addresses).
// Rows are stored as arrays in column order.
const objects = (t) => { const { columns, rows: r } = backup.tables[t]; return r.map((row) => (Array.isArray(row) ? Object.fromEntries(columns.map((c, i) => [c, row[i]])) : row)); };
const biz = objects('businesses').map((b) => ({ id: b.id, slug: b.slug, status: b.subscription_status }));
const orders = objects('orders');
console.log('      Orders per business (real / test):');
for (const b of biz) {
  const mine = orders.filter((o) => String(o.business_id) === String(b.id));
  const latest = mine.map((o) => o.created_at).sort().at(-1);
  console.log(`        ${b.slug.padEnd(26)} ${mine.filter((o) => !o.is_test).length} / ${mine.filter((o) => o.is_test).length}  (subscription ${b.status}${latest ? `, latest order ${latest}` : ''})`);
}
console.log(`      Integration settings present: sheet connections ${rows.sheet_connections ?? 0}, pixel settings ${rows.pixel_settings ?? 0}, email settings ${rows.email_settings ?? 0}, API keys ${rows.api_keys ?? 0}`);

// Google Sheet set-up per business (names, statuses and counts only; never order or customer details).
const conns = objects('sheet_connections');
const bizRows = objects('businesses');
const pages = objects('landing_pages');
console.log('      Spreadsheet connections:');
for (const c of conns) {
  const b = bizRows.find((x) => String(x.id) === String(c.business_id));
  const isDefault = String(b?.default_sheet_connection_id) === String(c.id);
  const onPages = pages.filter((p) => String(p.sheet_connection_id) === String(c.id)).map((p) => p.slug);
  console.log(`        #${c.id} ${b?.slug}: "${c.name}" (${c.provider}, tab ${c.sheet_tab || 'first'}) — check ${c.check_status ?? 'none'}${isDefault ? ', BUSINESS DEFAULT' : ''}${onPages.length ? `, used by pages ${onPages.join(', ')}` : ''}; created ${c.created_at}; backlog released ${c.backlog_released_at ?? 'no'}; last success ${c.last_success_at ?? 'never'}; last error ${String(c.last_error ?? 'none').slice(0, 120)}`);
}
for (const b of bizRows) {
  const mine = orders.filter((o) => String(o.business_id) === String(b.id));
  if (!mine.length) continue;
  const by = {};
  for (const o of mine) {
    const k = `${o.is_test ? 'test' : 'real'} ${o.sheet_sync_status}${o.sheet_connection_id ? ` → #${o.sheet_connection_id}` : ''}`;
    by[k] = (by[k] || 0) + 1;
  }
  console.log(`      Sheet status of ${b.slug} orders (default sheet #${b.default_sheet_connection_id ?? 'none'}): ${Object.entries(by).map(([k, v]) => `${k}: ${v}`).join('; ')}`);
  const reasons = {};
  for (const o of mine.filter((x) => !x.is_test && x.sheet_sync_error)) reasons[String(o.sheet_sync_error).slice(0, 140)] = (reasons[String(o.sheet_sync_error).slice(0, 140)] || 0) + 1;
  for (const [r, v] of Object.entries(reasons)) console.log(`        real orders waiting because: "${r}" (${v})`);
  const real = mine.filter((o) => !o.is_test).map((o) => o.created_at).sort();
  if (real.length) console.log(`        real orders: ${real.length}, first ${real[0]}, last ${real.at(-1)}`);
}

// Eligibility of the real orders still waiting for a sheet copy (reference, date, page, total, status;
// no names, phones or addresses). "looks like a test" and "possible repeat" are computed here and shown as flags only.
const items = objects('order_items');
const pageSlug = (id) => pages.find((p) => String(p.id) === String(id))?.slug ?? 'none';
for (const b of bizRows) {
  const waiting = orders.filter((o) => String(o.business_id) === String(b.id) && !o.is_test && ['pending', 'failed'].includes(o.sheet_sync_status));
  if (!waiting.length) continue;
  console.log(`      Real orders of ${b.slug} waiting for a sheet copy (${waiting.length}):`);
  for (const o of waiting.sort((x, y) => String(x.created_at).localeCompare(String(y.created_at)))) {
    const lines = items.filter((i) => String(i.order_id) === String(o.id));
    const testy = /\btest\b/i.test(`${o.customer_name} ${o.address} ${o.email ?? ''} ${o.customer_notes ?? ''}`);
    const repeat = orders.filter((x) => x.id !== o.id && String(x.business_id) === String(o.business_id) && x.phone === o.phone
      && Math.abs(new Date(x.created_at) - new Date(o.created_at)) < 24 * 3600 * 1000).map((x) => x.reference);
    console.log(`        ${o.reference}  ${o.created_at}  page ${pageSlug(o.landing_page_id)}  ${lines.map((i) => `${i.product_name} x${i.quantity}${i.is_upsell ? ' (add-on)' : ''}`).join(' + ')}  total ${Number(o.total_minor) / 100} ${o.currency ?? ''}  status ${o.status}  sheet ${o.sheet_sync_status}${o.sheet_connection_id ? ` → #${o.sheet_connection_id}` : ''}, attempts ${o.sheet_sync_attempts}${testy ? '  FLAG: details mention "test"' : ''}${repeat.length ? `  FLAG: same phone within 24h as ${repeat.join(', ')}` : ''}`);
  }
}
