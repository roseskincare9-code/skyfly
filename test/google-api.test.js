// Google Sheets through Google's Sheets API with Skyfly's service account (no Apps Script):
// the owner shares the spreadsheet with the service account's email and pastes its link.
// A stand-in for Google (sign-in + Sheets API) holds a spreadsheet with a historical tab.
// Covered: the historical tab is never changed, Skyfly writes only to its own tab, one row per
// order across retries and across tabs, text stays text, an unshared sheet or Google's quota
// leaves orders safe in Skyfly, one business per spreadsheet, and the read-only row count.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes, generateKeyPairSync, createVerify } from 'node:crypto';
import request from 'supertest';
import { setup, resetDatabase, csrfToken, signUp, ORIGIN } from './helpers.js';
import { seedLarose } from '../src/scripts/seed-larose.js';
import { syncDue, SHEET_COLUMNS } from '../src/services/sheets.js';
import { googleSelfCheck, readServiceAccount } from '../src/services/googleSheetsApi.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const EMAIL = 'skyfly-sheets@skyfly-test.iam.gserviceaccount.com';
const SHEET_ID = '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';
const HISTORY = [['Date', 'Name', 'Phone', 'source'], ...Array.from({ length: 40 }, (_, i) => [`2026-09-${String((i % 28) + 1).padStart(2, '0')}`, `Customer ${i}`, `+23480${i}`, `Website | old order ${i}`])];

// ---- stand-in for Google ----
const google = { shared: true, quota: false, disabled: false, tabs: null, tokens: 0, calls: 0 };
const reset = () => { google.tabs = [{ title: 'Laroseorders', values: HISTORY.map((r) => [...r]) }]; };
reset();
const tabOf = (range) => {
  const m = decodeURIComponent(range).match(/^'((?:[^']|'')+)'(?:!([A-Z]+)(\d+))?$/);
  return { tab: google.tabs.find((t) => t.title === m[1].replace(/''/g, "'")), col: m[2], row: m[3] && Number(m[3]) };
};
const colIndex = (c) => [...c].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
const server = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const u = new URL(req.url, 'http://x');
    const send = (status, o) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (u.pathname === '/token') {
      const assertion = new URLSearchParams(body).get('assertion');
      const [h, p, sig] = assertion.split('.');
      const ok = createVerify('RSA-SHA256').update(`${h}.${p}`).verify(publicKey, Buffer.from(sig, 'base64url'));
      const claims = JSON.parse(Buffer.from(p, 'base64url'));
      if (!ok || claims.iss !== EMAIL || !/spreadsheets/.test(claims.scope)) return send(400, { error: 'invalid_grant' });
      google.tokens += 1;
      return send(200, { access_token: 'test-access-token', expires_in: 3600 });
    }
    google.calls += 1;
    if (req.headers.authorization !== 'Bearer test-access-token') return send(401, { error: { message: 'no token' } });
    if (google.quota) return send(429, { error: { message: 'Quota exceeded' } });
    if (google.disabled) return send(403, { error: { message: 'Google Sheets API has not been used in project skyfly-test before or it is disabled.' } });
    const m = u.pathname.match(/^\/v4\/spreadsheets\/([^/:]+)(.*)$/);
    if (!m || m[1] !== SHEET_ID || !google.shared) return send(403, { error: { message: 'The caller does not have permission' } });
    const rest = m[2];
    if (req.method === 'GET' && rest === '') return send(200, { sheets: google.tabs.map((t) => ({ properties: { title: t.title } })) });
    if (req.method === 'GET' && rest === '/values:batchGet') {
      return send(200, { valueRanges: u.searchParams.getAll('ranges').map((r) => ({ range: r, values: tabOf(r).tab.values.map((row) => row.map(String)) })) });
    }
    if (req.method === 'POST' && rest === ':batchUpdate') {
      for (const r of JSON.parse(body).requests) google.tabs.push({ title: r.addSheet.properties.title, values: [] });
      return send(200, {});
    }
    const v = rest.match(/^\/values\/([^:]+)(:append)?$/);
    if (v && req.method === 'PUT' && u.searchParams.get('valueInputOption') === 'RAW') {
      const { tab, col } = tabOf(v[1]);
      const row = (tab.values[0] ??= []);
      JSON.parse(body).values[0].forEach((val, i) => { row[colIndex(col) + i] = val; });
      return send(200, {});
    }
    if (v && v[2] && req.method === 'POST' && u.searchParams.get('valueInputOption') === 'RAW') {
      tabOf(v[1]).tab.values.push(JSON.parse(body).values[0]);
      return send(200, { updates: { updatedRows: 1 } });
    }
    return send(400, { error: { message: `unexpected ${req.method} ${u.pathname}` } });
  });
});
await new Promise((r) => server.listen(0, r));
const base0 = `http://127.0.0.1:${server.address().port}`;

const key = randomBytes(32);
const serviceAccount = { client_email: EMAIL, private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
const { pool, app } = setup({ encryptionKey: key, google: { serviceAccount, apiBase: base0, tokenUrl: `${base0}/token` } });
const LINK = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit#gid=0`;
let owner; let base; let n = 0;
const order = (name, extra = {}) => request(app).post('/api/public/orders').set('Origin', ORIGIN).send({
  landingPage: 'larosenigeria', idempotencyKey: `gapi-test-key-${String(n += 1).padStart(6, '0')}`,
  customer: { name, phone: '08051234567', address: '3 Test Close, Ikeja', state: 'Lagos', ...extra }, items: [{ product: 'package-1', quantity: 2 }],
}).expect(201);
const orderRow = async (ref) => (await pool.query('SELECT * FROM orders WHERE reference = $1', [ref])).rows[0];
const sync = async () => {
  await pool.query("UPDATE orders SET sheet_sync_next_at = now() WHERE sheet_sync_status IN ('pending', 'failed')");
  await pool.query('UPDATE sheet_connections SET quota_until = NULL');
  return syncDue(pool, { key });
};
const skyflyTab = () => google.tabs.find((t) => t.title === 'Skyfly Orders');
const rowsFor = (ref) => google.tabs.flatMap((t) => t.values.filter((r) => r.some((c) => String(c).includes(ref))));

before(async () => {
  await resetDatabase(pool);
  owner = await signUp(app, { email: 'owner@larose.test' });
  const biz = await seedLarose(pool, 'owner@larose.test');
  base = `/businesses/${biz}`;
  await pool.query('UPDATE businesses SET sheet_backup_url = NULL WHERE id = $1', [biz]);
});
after(async () => { await pool.end(); server.close(); });

describe('connecting by sharing the sheet with Skyfly (no Apps Script)', () => {
  test('the page names the email to share with; connecting checks the sheet and reports the tabs read-only', async () => {
    const page = await owner.get(`${base}/google-sheets`).expect(200);
    assert.ok(page.text.includes(`<code data-google-email>${EMAIL}</code>`));
    assert.ok(page.text.indexOf('id="add-google"') < page.text.indexOf('Connected spreadsheets'), 'offered first while nothing direct is connected');
    assert.ok(!page.text.includes('BEGIN PRIVATE KEY'), 'the key never reaches the page');
    // Not shared yet: an honest error that names the email; nothing in the spreadsheet changes.
    google.shared = false;
    let _csrf = await csrfToken(owner, `${base}/google-sheets`);
    await owner.post(`${base}/google-sheets/connections`).type('form').send({ _csrf, kind: 'google_api', name: 'Laroseorders', spreadsheet_url: LINK, make_default: 'on' }).expect(302);
    let { rows: [c] } = await pool.query("SELECT * FROM sheet_connections WHERE name = 'Laroseorders'");
    assert.equal(c.provider, 'google_api');
    assert.equal(c.check_status, 'error');
    assert.match(c.check_detail, new RegExp(`add ${EMAIL.replace(/\./g, '\\.')} as Editor`));
    assert.deepEqual(google.tabs, [{ title: 'Laroseorders', values: HISTORY }]);
    // Shared: "Check connection" succeeds and lists the tabs.
    google.shared = true;
    _csrf = await csrfToken(owner, `${base}/google-sheets`);
    await owner.post(`${base}/google-sheets/connections/${c.id}/check`).type('form').send({ _csrf }).expect(302);
    ({ rows: [c] } = await pool.query('SELECT * FROM sheet_connections WHERE id = $1', [c.id]));
    assert.equal(c.check_status, 'ok', c.check_detail);
    assert.equal(c.sheet_tab, 'Skyfly Orders');
    assert.match(c.check_detail, /Tabs: Laroseorders \(40 rows below row 1, not changed\); Skyfly Orders \(Skyfly writes here\)\./);
    assert.deepEqual(google.tabs[0], { title: 'Laroseorders', values: HISTORY }, 'the historical tab is exactly as it was');
    assert.deepEqual(skyflyTab().values, [SHEET_COLUMNS]);
  });

  test('an order is copied once to Skyfly\'s tab, text stays text, and retrying never adds a second row', async () => {
    const o = await order('=HYPERLINK("x") Ada');
    await sync();
    const row = await orderRow(o.body.reference);
    assert.equal(row.sheet_sync_status, 'synced', row.sheet_sync_error);
    const mine = skyflyTab().values.filter((r) => r[SHEET_COLUMNS.indexOf('orderId')] === o.body.reference);
    assert.equal(mine.length, 1);
    const cell = (c) => mine[0][SHEET_COLUMNS.indexOf(c)];
    assert.equal(cell('phone'), '+2348051234567');
    assert.equal(cell('fullName'), '=HYPERLINK("x") Ada', 'stored as plain text (written RAW, never run as a formula)');
    assert.equal(cell('quantity'), 2);
    assert.equal(cell('skyflyId'), row.idempotency_key);
    await pool.query("UPDATE orders SET sheet_sync_status = 'failed', sheet_sync_attempts = 1 WHERE id = $1", [row.id]);
    await sync();
    assert.equal(rowsFor(o.body.reference).length, 1, 'still one row');
    assert.deepEqual(google.tabs[0], { title: 'Laroseorders', values: HISTORY });
  });

  test('an order already in another tab (e.g. copied earlier) is not added again', async () => {
    const o = await order('Already There');
    google.tabs[0].values.push(['2026-10-18', 'Already There', '+2348051234567', `Website | Skyfly ${o.body.reference} | ID x`]);
    await sync();
    assert.equal((await orderRow(o.body.reference)).sheet_sync_status, 'synced');
    assert.equal(rowsFor(o.body.reference).length, 1);
    google.tabs[0].values.pop();
  });

  test('Google unavailable or over quota: the order stays saved in Skyfly and is copied later, once', async () => {
    google.quota = true;
    const o = await order('Quota Customer');
    await pool.query("UPDATE orders SET sheet_sync_next_at = now() WHERE reference = $1", [o.body.reference]);
    await syncDue(pool, { key });
    let row = await orderRow(o.body.reference);
    assert.equal(row.sheet_sync_status, 'failed');
    assert.equal(row.sheet_sync_attempts, 0, 'a quota pause is not an attempt');
    assert.match(row.sheet_sync_error, /quota/);
    google.quota = false;
    google.shared = false;
    await sync();
    row = await orderRow(o.body.reference);
    assert.match(row.sheet_sync_error, /Share and add .* as Editor/);
    google.shared = true;
    await sync();
    assert.equal((await orderRow(o.body.reference)).sheet_sync_status, 'synced');
    assert.equal(rowsFor(o.body.reference).length, 1);
  });

  test('the order page counts the order\'s rows in the real spreadsheet (read-only)', async () => {
    const o = await order('Count Me');
    await sync();
    const { id } = await orderRow(o.body.reference);
    const _csrf = await csrfToken(owner, `${base}/orders/${id}`);
    const r = await owner.post(`${base}/orders/${id}/sheet-check`).type('form').send({ _csrf }).expect(302);
    const shown = await owner.get(r.headers.location.replace(/#.*/, '')).expect(200);
    assert.match(shown.text, new RegExp(`The spreadsheet Laroseorders \\(Skyfly Orders\\) has 1 row for ${o.body.reference}\\.`));
  });

  test('a spreadsheet connected to one business cannot be connected by another', async () => {
    const other = await signUp(app, { email: 'other@shop.test' });
    const { rows: [u] } = await pool.query("SELECT id FROM users WHERE email = 'other@shop.test'");
    const { rows: [b] } = await pool.query("INSERT INTO businesses (owner_id, name, slug, currency) VALUES ($1, 'Other', 'other-biz', 'NGN') RETURNING id", [u.id]);
    await pool.query("INSERT INTO business_members (business_id, user_id, role) VALUES ($1, $2, 'owner')", [b.id, u.id]);
    const _csrf = await csrfToken(other, `/businesses/${b.id}/google-sheets`);
    const res = await other.post(`/businesses/${b.id}/google-sheets/connections`).type('form').send({ _csrf, kind: 'google_api', spreadsheet_url: LINK });
    assert.equal(res.status, 409);
    assert.match(res.text, /already connected to another business/);
  });
});

describe('server setting and startup check (yes/no only, never the key)', () => {
  test('the key file is read safely, with a reason when it cannot be used', () => {
    const file = JSON.stringify({ type: 'service_account', project_id: 'skyfly-test', client_email: EMAIL, private_key: serviceAccount.private_key });
    assert.equal(readServiceAccount(file).account.client_email, EMAIL);
    assert.equal(readServiceAccount(Buffer.from(file).toString('base64')).account.project_id, 'skyfly-test');
    assert.match(readServiceAccount('{"client_email": ').problem, /not valid JSON/);
    assert.match(readServiceAccount(JSON.stringify({ type: 'authorized_user' })).problem, /not a service account key/);
    assert.match(readServiceAccount(JSON.stringify({ client_email: EMAIL })).problem, /no private key/);
    for (const r of [readServiceAccount('{"client_email": '), readServiceAccount(JSON.stringify({ client_email: EMAIL }))]) assert.ok(!JSON.stringify(r).includes('PRIVATE'));
  });

  test('startup check: sign-in works and the Sheets API is reported enabled, or disabled with what to do', async () => {
    let r = await googleSelfCheck();
    assert.equal(r.configured, true);
    assert.equal(r.auth, 'ok');
    assert.equal(r.sheetsApi, 'enabled');
    assert.ok(!JSON.stringify(r).includes('PRIVATE KEY'));
    google.disabled = true;
    r = await googleSelfCheck();
    assert.match(r.sheetsApi, /^disabled: enable the Google Sheets API/);
    google.disabled = false;
  });
});

describe('key file uploaded as a Render secret file', () => {
  test('Skyfly finds a service account key among the secret files when no setting holds it', async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const dir = mkdtempSync(`${tmpdir()}/secrets-`);
    writeFileSync(`${dir}/notes.txt`, 'not a key');
    writeFileSync(`${dir}/skyfly-sheets-key.json`, JSON.stringify({ type: 'service_account', project_id: 'skyfly-test', client_email: EMAIL, private_key: serviceAccount.private_key }));
    const saved = { ...process.env };
    for (const k of Object.keys(process.env)) if (k.toUpperCase().replace(/-/g, '_') === 'GOOGLE_SERVICE_ACCOUNT_JSON') delete process.env[k];
    process.env.SECRET_FILES_DIR = dir;
    process.env.SESSION_SECRET ||= 'test-secret';
    try {
      const { loadConfig } = await import('../src/config.js');
      const c = loadConfig();
      assert.equal(c.google.serviceAccount.client_email, EMAIL);
      assert.equal(c.google.setting, 'secret file skyfly-sheets-key.json');
    } finally { process.env = saved; }
  });
});
