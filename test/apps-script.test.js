// Google Sheets through the business's own Apps Script (no SheetDB): connect with the generated
// script's key, column row written by the script, one row per order even on retries, text kept
// as text, wrong key and Google quota errors handled, other businesses unaffected.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { resetDatabase, csrfToken, signUp, ORIGIN, makeConfig, testDatabaseUrl } from './helpers.js';
import { createPool } from '../src/db.js';
import { createApp } from '../src/app.js';
import { seedLarose } from '../src/scripts/seed-larose.js';
import { syncDue, SHEET_COLUMNS } from '../src/services/sheets.js';

// Stand-in for a deployed Apps Script web app, following the script's own rules: a key check,
// the column row on first use, a search before every append, and Google's POST -> 302 -> GET reply.
const script = { key: null, rows: [], header: null, quota: false, requests: 0 };
const pending = new Map();
const server = createServer((req, res) => {
  script.requests += 1;
  const u = new URL(req.url, 'http://x');
  const reply = (o) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
  const find = (q) => script.rows.filter((r) => String(r.source).includes(q));
  if (u.pathname === '/echo') return reply(pending.get(u.searchParams.get('id')));
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    if (script.quota) return reply({ ok: false, error: 'Service invoked too many times for one day: urlfetch.' });
    const p = req.method === 'POST' ? JSON.parse(body) : Object.fromEntries(u.searchParams);
    let out;
    if (p.key !== script.key) out = { ok: false, error: 'Wrong key' };
    else {
      script.header ??= [...SHEET_COLUMNS];
      if (req.method === 'GET' && p.action === 'tabs') out = { ok: true, tabs: [{ name: 'Laroseorders', rows: 41, columns: 6, firstRow: ['Date', 'Name'] }, { name: 'Skyfly Orders', rows: 1, columns: 14, firstRow: [] }] };
      else if (req.method === 'GET' && p.action === 'keys') out = { ok: true, columns: script.header };
      else if (req.method === 'GET' && p.action === 'search') out = { ok: true, rows: find(p.q) };
      else if (req.method === 'POST' && ((p.id && script.rows.some((r) => r.skyflyId === p.id)) || (p.ref && find(p.ref).length))) out = { ok: true, created: 0, existing: true };
      else if (req.method === 'POST') { script.rows.push(p.row); out = { ok: true, created: 1 }; }
      else out = { ok: false, error: 'Unknown action' };
    }
    if (req.method !== 'POST') return reply(out);
    const id = randomBytes(6).toString('hex');
    pending.set(id, out);
    res.writeHead(302, { Location: `/echo?id=${id}` });
    res.end();
  });
});
await new Promise((r) => server.listen(0, r));
const scriptUrl = `http://127.0.0.1:${server.address().port}/macros/s/AKfycbTestDeployment0123456789/exec`;

const key = randomBytes(32);
const pool = createPool(testDatabaseUrl(), false);
const app = createApp({ pool, config: makeConfig({ encryptionKey: key }) });
const sync = async () => {
  await pool.query("UPDATE orders SET sheet_sync_next_at = now() WHERE sheet_sync_status IN ('pending', 'failed')");
  return syncDue(pool, { key });
};
let owner; let base; let n = 0;
const order = (name) => request(app).post('/api/public/orders').set('Origin', ORIGIN).send({
  landingPage: 'larosenigeria', idempotencyKey: `as-test-key-${String(n += 1).padStart(6, '0')}`,
  customer: { name, phone: '08051234567', address: '3 Test Close, Ikeja', state: 'Lagos' }, items: [{ product: 'package-1', quantity: 2 }],
}).expect(201);
const orderRow = async (ref) => (await pool.query('SELECT * FROM orders WHERE reference = $1', [ref])).rows[0];

before(async () => {
  await resetDatabase(pool);
  owner = await signUp(app, { email: 'owner@larose.test' });
  const biz = await seedLarose(pool, 'owner@larose.test');
  base = `/businesses/${biz}`;
  await pool.query('UPDATE businesses SET sheet_backup_url = NULL WHERE id = $1', [biz]);
});
after(async () => { await pool.end(); server.close(); });

describe('Apps Script spreadsheet connection', () => {
  test('the page gives a script with a private key; connecting with its web app URL checks the sheet', async () => {
    const page = await owner.get(`${base}/google-sheets`).expect(200);
    const scriptKey = page.text.match(/name="script_key" value="([A-Za-z0-9_-]{32})"/)[1];
    assert.ok(page.text.includes(`var KEY = &#39;${scriptKey}&#39;;`), 'the script shown contains the same key');
    assert.match(page.text, /Deploy → New deployment/);
    script.key = scriptKey;
    const _csrf = await csrfToken(owner, `${base}/google-sheets`);
    // Without the key the URL alone is refused.
    const bad = await owner.post(`${base}/google-sheets/connections`).type('form').send({ _csrf, kind: 'apps_script', name: 'Direct', api_url: scriptUrl, script_key: '' });
    assert.equal(bad.status, 400);
    const res = await owner.post(`${base}/google-sheets/connections`).type('form')
      .send({ _csrf, kind: 'apps_script', name: 'Direct', api_url: scriptUrl, script_key: scriptKey, make_default: 'on' });
    assert.equal(res.status, 302);
    const { rows: [c] } = await pool.query("SELECT * FROM sheet_connections WHERE name = 'Direct'");
    assert.equal(c.provider, 'apps_script');
    assert.equal(c.check_status, 'ok');
    assert.equal(c.sheet_tab, 'Skyfly Orders', 'Skyfly\'s own tab by default');
    assert.match(c.check_detail, /Tabs: Laroseorders \(40 rows below row 1, not changed\); Skyfly Orders \(Skyfly writes here\)\./);
    assert.ok(!c.api_url_enc.includes(scriptKey), 'stored encrypted');
    assert.ok(!scriptKey.endsWith(c.api_hint), 'the hint never shows part of the key');
    const after = await owner.get(`${base}/google-sheets`).expect(200);
    assert.match(after.text, /Google Apps Script<\/dt>/);
  });

  test('an order is copied once with Skyfly\'s columns; retrying never adds a second row', async () => {
    const o = await order('Apps Script Customer');
    await sync();
    const row = await orderRow(o.body.reference);
    assert.equal(row.sheet_sync_status, 'synced');
    const mine = script.rows.filter((r) => r.source.includes(o.body.reference));
    assert.equal(mine.length, 1);
    assert.equal(mine[0].phone, '+2348051234567', 'the phone number stays text with its +');
    assert.equal(mine[0].quantity, 2);
    assert.deepEqual(Object.keys(mine[0]), SHEET_COLUMNS);
    assert.equal(mine[0].skyflyId, row.idempotency_key, 'the row carries the Skyfly order ID used to prevent duplicates');
    await pool.query("UPDATE orders SET sheet_sync_status = 'failed', sheet_sync_attempts = 1 WHERE id = $1", [row.id]);
    await sync();
    assert.equal(script.rows.filter((r) => r.source.includes(o.body.reference)).length, 1, 'still one row');

    // The owner can count the order's rows in the real spreadsheet from the order page (read-only).
    const _csrf = await csrfToken(owner, `${base}/orders/${row.id}`);
    const before = script.rows.length;
    const check = await owner.post(`${base}/orders/${row.id}/sheet-check`).type('form').send({ _csrf }).expect(302);
    const shown = await owner.get(check.headers.location.replace(/#.*/, '')).expect(200);
    assert.match(shown.text, new RegExp(`The spreadsheet Direct \\(Skyfly Orders\\) has 1 row for ${o.body.reference}\\.`));
    assert.equal(script.rows.length, before, 'checking adds nothing');
    const stranger = await signUp(app, { email: 'stranger@other.test' });
    const sc = await csrfToken(stranger, '/');
    const denied = await stranger.post(`${base}/orders/${row.id}/sheet-check`).type('form').send({ _csrf: sc });
    assert.ok([403, 404].includes(denied.status), `another account gets ${denied.status}`);
  });

  test('a Google quota error pauses the sheet (the order waits safely); a wrong key is reported', async () => {
    script.quota = true;
    const o = await order('Quota Customer');
    await sync();
    const waiting = await orderRow(o.body.reference);
    assert.equal(waiting.sheet_sync_status, 'failed');
    assert.equal(waiting.sheet_sync_attempts, 0, 'a quota pause is not an attempt');
    assert.match(waiting.sheet_sync_error, /too many times/);
    script.quota = false;
    await pool.query("UPDATE sheet_connections SET quota_until = NULL WHERE name = 'Direct'");
    await sync();
    assert.equal((await orderRow(o.body.reference)).sheet_sync_status, 'synced');

    const realKey = script.key;
    script.key = 'changed-in-the-script';
    const o2 = await order('Wrong Key Customer');
    await sync();
    assert.match((await orderRow(o2.body.reference)).sheet_sync_error, /Wrong key/);
    script.key = realKey;
    await sync();
    assert.equal((await orderRow(o2.body.reference)).sheet_sync_status, 'synced');
  });
});

describe('switching to a working sheet', () => {
  test('orders that were waiting (e.g. for SheetDB\'s quota) go to the new default sheet at once, once each', async () => {
    const waiting = await order('Waiting For Quota');
    await pool.query("UPDATE orders SET sheet_sync_status = 'failed', sheet_sync_error = 'Waiting: SheetDB''s monthly request limit is used up.', sheet_sync_next_at = now() + interval '6 hours' WHERE reference = $1", [waiting.body.reference]);
    const page = await owner.get(`${base}/google-sheets`).expect(200);
    const scriptKey = page.text.match(/name="script_key" value="([A-Za-z0-9_-]{32})"/)[1];
    script.key = scriptKey;
    const _csrf = await csrfToken(owner, `${base}/google-sheets`);
    await owner.post(`${base}/google-sheets/connections`).type('form')
      .send({ _csrf, kind: 'apps_script', name: 'New sheet', api_url: scriptUrl.replace('AKfycbTestDeployment0123456789', 'AKfycbSecondDeployment98765432'), script_key: scriptKey, make_default: 'on' }).expect(302);
    const queued = await orderRow(waiting.body.reference);
    assert.equal(queued.sheet_sync_status, 'pending', 'no 6-hour wait');
    assert.ok(new Date(queued.sheet_sync_next_at) <= new Date());
    await syncDue(pool, { key });
    assert.equal((await orderRow(waiting.body.reference)).sheet_sync_status, 'synced');
    assert.equal(script.rows.filter((r) => r.orderId === waiting.body.reference).length, 1);
  });
});
