// Server-side Google Sheet backup (SheetDB): copy, status, retries without duplicates, recovery.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { startSheetDbMock } from './sheetdb-mock.js';
import request from 'supertest';
import { resetDatabase, csrfToken, signUp, ORIGIN, makeConfig } from './helpers.js';
import { createPool } from '../src/db.js';
import { createApp } from '../src/app.js';
import { testDatabaseUrl } from './helpers.js';
import { seedLarose } from '../src/scripts/seed-larose.js';
import { syncDue, syncOrder, rowKey, adoptLegacyUrls } from '../src/services/sheets.js';

const mock = await startSheetDbMock();
const sheet = { get rows() { return mock.rows('testsheet01'); }, set down(v) { mock.state.down = v; }, set acceptButFail(v) { mock.state.acceptButFail = v; } };
const SHEET = mock.url('testsheet01');
const key = randomBytes(32);
const sync = () => syncDue(pool, { key });

const config = makeConfig({ encryptionKey: key });
const pool = createPool(testDatabaseUrl(), false);
const kicked = [];
const app = createApp({ pool, config, onOrderSaved: (id) => kicked.push(id) });
let owner;
let businessId;
let connectionId;
let n = 0;

const order = (name = 'Ngozi Adeyemi') => request(app).post('/api/public/orders').set('Origin', ORIGIN).send({
  landingPage: 'larosenigeria', idempotencyKey: `sheet-test-key-${String(n += 1).padStart(6, '0')}`,
  customer: { name, phone: '08051234567', address: '14 Admiralty Way, Lekki', state: 'Lagos', notes: 'Gate is blue' },
  items: [{ product: 'package-3', quantity: 2 }],
});
const statusOf = async (ref) => (await pool.query('SELECT * FROM orders WHERE reference = $1', [ref])).rows[0];
// In production a new order's first copy waits 3 minutes; tests move the clock forward instead.
const duePending = () => pool.query("UPDATE orders SET sheet_sync_next_at = now() WHERE sheet_sync_status = 'pending'");
const dueNow = () => pool.query("UPDATE orders SET sheet_sync_next_at = now() WHERE sheet_sync_status IN ('failed', 'pending')");

before(async () => {
  await resetDatabase(pool);
  owner = await signUp(app, { email: 'owner@larose.test' });
  businessId = await seedLarose(pool, 'owner@larose.test');
  assert.equal((await pool.query('SELECT sheet_backup_url FROM businesses WHERE id = $1', [businessId])).rows[0].sheet_backup_url, 'https://sheetdb.io/api/v1/m111fq96ve953');
  // The URL saved before central Google Sheets becomes the business's default connection, encrypted.
  await pool.query('UPDATE businesses SET sheet_backup_url = $1 WHERE id = $2', [SHEET, businessId]);
  await adoptLegacyUrls(pool, key);
  const { rows: [b] } = await pool.query('SELECT sheet_backup_url, default_sheet_connection_id FROM businesses WHERE id = $1', [businessId]);
  assert.equal(b.sheet_backup_url, null);
  const { rows: [c] } = await pool.query('SELECT * FROM sheet_connections WHERE id = $1', [b.default_sheet_connection_id]);
  assert.equal(c.business_id, businessId);
  assert.ok(!c.api_url_enc.includes('testsheet01'), 'the URL is stored encrypted');
  assert.equal(c.api_hint, 'et01');
  connectionId = c.id;
});
after(async () => { await pool.end(); mock.close(); });

describe('copying orders to the Google Sheet from the server', () => {
  test('a new website order is copied once, with the Skyfly reference, and marked as copied', async () => {
    const res = await order();
    assert.equal(res.status, 201);
    assert.equal(kicked.length, 1, 'the sync is started right away');
    assert.equal((await statusOf(res.body.reference)).sheet_sync_status, 'pending');
    await duePending(); await sync();
    const o = await statusOf(res.body.reference);
    assert.equal(o.sheet_sync_status, 'synced');
    assert.ok(o.sheet_synced_at);
    assert.equal(sheet.rows.length, 1);
    const row = sheet.rows[0];
    assert.match(row.source, new RegExp(`Skyfly ${res.body.reference} \\| ID sheet-te`));
    assert.equal(row.fullName, 'Ngozi Adeyemi');
    assert.equal(row.package, 'Package 3 – Power Glow x2');
    assert.equal(row.address, '14 Admiralty Way, Lekki, Lagos');
    assert.equal(row.total, 116000);
    await duePending(); await sync();
    assert.equal(sheet.rows.length, 1, 'nothing is copied twice');
  });

  test('a new order waits before its first copy, then the server checks the sheet first', async () => {
    const res = await order('Delayed Copy Customer');
    await sync();
    assert.equal((await statusOf(res.body.reference)).sheet_sync_status, 'pending', 'not copied in the first minutes');
    // An older landing page already wrote this order itself:
    sheet.rows.push({ source: `Larose Nigeria Landing Page 2026 | Skyfly ${res.body.reference} | ID abcdabcd`, fullName: 'Delayed Copy Customer' });
    await duePending(); await sync();
    assert.equal((await statusOf(res.body.reference)).sheet_sync_status, 'synced');
    assert.equal(sheet.rows.filter((r) => r.source.includes(res.body.reference)).length, 1, 'not written a second time');
  });

  test('a repeated submission (same key) is not copied again', async () => {
    const next = n;
    n = 0; // replay the very first order
    const again = await order();
    n = next;
    assert.equal(again.status, 200);
    assert.equal(again.body.replayed, true);
    await duePending(); await sync();
    assert.equal(sheet.rows.filter((r) => r.source.includes(again.body.reference)).length, 1);
  });

  test('when the sheet is down the order is safe, marked failed with the reason, and retried later', async () => {
    sheet.down = true;
    const res = await order('Sheet Down Customer');
    await duePending(); await sync();
    let o = await statusOf(res.body.reference);
    assert.equal(o.sheet_sync_status, 'failed');
    assert.equal(o.sheet_sync_attempts, 1);
    assert.match(o.sheet_sync_error, /HTTP 503/);
    assert.ok(new Date(o.sheet_sync_next_at) > new Date(), 'retry scheduled');
    const page = await owner.get(`/businesses/${businessId}/orders/${o.id}`).expect(200);
    assert.match(page.text, /Copy failed — will retry automatically/);
    assert.match(page.text, /Retry now/);
    const overview = await owner.get(`/businesses/${businessId}`).expect(200);
    assert.match(overview.text, /1 order not yet copied to the Google Sheet/);
    const list = await owner.get(`/businesses/${businessId}/orders?sheet=failed`).expect(200);
    assert.match(list.text, new RegExp(res.body.reference));

    await duePending(); await sync();
    assert.equal((await statusOf(res.body.reference)).sheet_sync_attempts, 1, 'not retried before its time');
    sheet.down = false;
    await dueNow();
    await duePending(); await sync();
    o = await statusOf(res.body.reference);
    assert.equal(o.sheet_sync_status, 'synced');
    assert.equal(sheet.rows.filter((r) => r.source.includes(res.body.reference)).length, 1);
  });

  test('if a write landed but the reply was lost, the retry finds the row and does not add a second one', async () => {
    sheet.acceptButFail = true;
    const res = await order('Lost Reply Customer');
    await duePending(); await sync();
    assert.equal((await statusOf(res.body.reference)).sheet_sync_status, 'failed');
    sheet.acceptButFail = false;
    await dueNow();
    await duePending(); await sync();
    assert.equal((await statusOf(res.body.reference)).sheet_sync_status, 'synced');
    assert.equal(sheet.rows.filter((r) => r.source.includes(res.body.reference)).length, 1);
  });

  test('"Retry now" on an order and "Retry all failed" queue it immediately', async () => {
    sheet.down = true;
    const res = await order('Retry Button Customer');
    await duePending(); await sync();
    sheet.down = false;
    const o = await statusOf(res.body.reference);
    const _csrf = await csrfToken(owner, `/businesses/${businessId}/orders/${o.id}`);
    await owner.post(`/businesses/${businessId}/orders/${o.id}/sheet-retry`).type('form').send({ _csrf }).expect(302);
    await duePending(); await sync();
    assert.equal((await statusOf(res.body.reference)).sheet_sync_status, 'synced');
  });

  test('test orders are never copied to the sheet, and their saved status is left as it is', async () => {
    const before = sheet.rows.length;
    const res = await order('TEST ORDER Skyfly E2E please ignore');
    const o = await statusOf(res.body.reference);
    assert.equal(o.is_test, true);
    await duePending(); await sync();
    assert.equal(sheet.rows.length, before, 'no row added');
    assert.equal(await syncOrder(pool, o.id, { key }), 'skipped', 'a direct call is refused too');
    assert.equal(sheet.rows.length, before);
    const after = await statusOf(res.body.reference);
    assert.deepEqual([after.sheet_sync_status, after.sheet_sync_attempts], [o.sheet_sync_status, o.sheet_sync_attempts], 'nothing written');
  });

  test('with no sheet set, orders are marked "not copied" instead of failing', async () => {
    await pool.query('UPDATE businesses SET default_sheet_connection_id = NULL WHERE id = $1', [businessId]);
    const res = await order('No Sheet Customer');
    await duePending(); await sync();
    assert.equal((await statusOf(res.body.reference)).sheet_sync_status, 'skipped');
    await pool.query('UPDATE businesses SET default_sheet_connection_id = $1 WHERE id = $2', [connectionId, businessId]);
  });
});

describe('Google Sheet backup screen and recovery', () => {
  const fallback = {
    timestamp: '2026-10-16T08:00:00.000Z', fullName: 'Chioma Fallback', address: '5 Allen Avenue, Ikeja, Lagos', phone: '08031234567',
    email: '', package: 'Package 2 – Starter Glow Combo – ₦33,000 x3', state: 'Lagos', quantity: 3, notes: 'Call first',
    source: 'Larose Nigeria Landing Page 2026 | NOT IN SKYFLY (unreachable) | ID abcd1234',
  };

  test('the URL must be a SheetDB API URL', async () => {
    const _csrf = await csrfToken(owner, `/businesses/${businessId}/google-sheets`);
    const res = await owner.post(`/businesses/${businessId}/google-sheets/connections`).type('form').send({ _csrf, name: 'Bad', api_url: 'https://evil.example/x' });
    assert.equal(res.status, 400);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM sheet_connections WHERE business_id = $1', [businessId])).rows[0].n, 1);
  });

  test('orders that reached only the sheet are listed and can be added once, without a second sheet row', async () => {
    sheet.rows.push(fallback);
    const before = sheet.rows.length;
    const page = await owner.get(`/businesses/${businessId}/google-sheets?check=1`).expect(200);
    assert.match(page.text, /Chioma Fallback/);
    const link = page.text.match(/href="(\/businesses\/\d+\/orders\/new\?[^"]+)"/)[1].replaceAll('&amp;', '&');
    const form = await owner.get(link).expect(200);
    assert.match(form.text, /value="Chioma Fallback"/);
    assert.match(form.text, /value="5 Allen Avenue, Ikeja"/);
    assert.match(form.text, new RegExp(`name="sheet_row_key" value="${rowKey(fallback)}"`));

    const values = Object.fromEntries(new URL(link, 'http://x').searchParams);
    const _csrf = form.text.match(/name="_csrf" value="([^"]+)"/)[1];
    const saved = await owner.post(`/businesses/${businessId}/orders/new`).type('form').send({ _csrf, ...values, status: 'pending', payment_status: 'unpaid' });
    assert.equal(saved.status, 302, saved.text.slice(0, 400));
    const { rows: [o] } = await pool.query("SELECT o.*, (SELECT json_agg(json_build_object('code', product_code, 'qty', quantity)) FROM order_items WHERE order_id = o.id) AS items FROM orders o WHERE customer_name = 'Chioma Fallback'");
    assert.deepEqual(o.items, [{ code: 'package-2', qty: 3 }]);
    assert.equal(o.phone, '+2348031234567');
    assert.equal(o.sheet_sync_status, 'synced');
    await duePending(); await sync();
    assert.equal(sheet.rows.length, before, 'no second sheet row');

    const _csrf2 = await csrfToken(owner, link);
    const again = await owner.post(`/businesses/${businessId}/orders/new`).type('form').send({ _csrf: _csrf2, ...values, status: 'pending', payment_status: 'unpaid' });
    assert.equal(again.status, 409);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM orders WHERE customer_name = 'Chioma Fallback'")).rows[0].n, 1);
    const listed = await owner.get(`/businesses/${businessId}/google-sheets?check=1`).expect(200);
    assert.match(listed.text, new RegExp(`In Skyfly</span> <a href="[^"]+">${o.reference}`));
  });

  test('another account cannot see or change this business\'s sheet backup', async () => {
    const other = await signUp(app, { email: 'other@shop.test' });
    await other.get(`/businesses/${businessId}/google-sheets`).expect(404);
  });
});
