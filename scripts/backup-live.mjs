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
if (!email || !password) {
  console.log('BLOCKED  Backup download — needs the SKYFLY_OWNER_EMAIL and SKYFLY_OWNER_PASSWORD repository secrets (the platform owner\'s sign-in).');
  process.exit(2);
}

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

const res = await fetch(`${SKYFLY}/admin/backup.json`, { headers: { Cookie: cookies() }, redirect: 'manual' });
if (res.status !== 200) { console.log(`FAIL  Backup download HTTP ${res.status} (the account must be the platform owner).`); process.exit(1); }
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
