// "No saved order, no Purchase. One saved order, one Purchase." Acceptance tests for the
// server side of purchase tracking: the order API's success reply, server-side Purchase
// (Meta Conversions API / TikTok Events API), deduplication, retries and business isolation.
// Meta and TikTok are stand-ins here: nothing reaches real ad reports.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { setup, resetDatabase, signUp, ORIGIN, openClientSignup } from './helpers.js';
import { seedLarose } from '../src/scripts/seed-larose.js';
import { encrypt } from '../src/lib/secrets.js';
import { retryEvent } from '../src/services/pixels.js';
import { clearOriginCache } from '../src/lib/origins.js';

const calls = [];
let failing = false;
const mock = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    calls.push({ url: req.url, body: JSON.parse(body || '{}') });
    if (failing) { res.writeHead(503, { 'Content-Type': 'application/json' }); return res.end('{"error":{"message":"Service unavailable"}}'); }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(req.url.startsWith('/meta') ? '{"events_received":1}' : '{"code":0,"message":"OK"}');
  });
});
await new Promise((r) => mock.listen(0, r));
const base = `http://127.0.0.1:${mock.address().port}`;
const encryptionKey = randomBytes(32);
const { pool, app, config } = setup({ encryptionKey, metaGraphBase: `${base}/meta/v26.0`, tiktokApiBase: `${base}/tiktok/v1.3` });

const LAROSE_PIXEL = '111111111111111';
const OTHER_PIXEL = '222222222222222';
const OTHER_ORIGIN = 'https://other-shop.example.test';
let larose;
let other;
let n = 0;

const send = (body, origin = ORIGIN) => request(app).post('/api/public/orders').set('Origin', origin).send(body);
const orderBody = (overrides = {}) => ({
  landingPage: 'larosenigeria', idempotencyKey: `purchase-tracking-${String(n += 1).padStart(6, '0')}`,
  customer: { name: 'Chiamaka Obi', phone: '08031112222', address: '5 Allen Avenue, Ikeja', state: 'Lagos', email: 'chiamaka@example.test' },
  items: [{ product: 'package-2', quantity: 2 }], ...overrides,
});
const counts = async () => (await pool.query("SELECT (SELECT count(*)::int FROM orders) AS orders, (SELECT count(*)::int FROM conversion_events) AS events")).rows[0];
const settle = () => new Promise((r) => setTimeout(r, 150)); // server-side Purchase is sent after the reply
const metaCalls = () => calls.filter((c) => c.url.startsWith('/meta'));

before(async () => {
  await resetDatabase(pool);
  await signUp(app, { email: 'owner@larose.test' });
  larose = await seedLarose(pool, 'owner@larose.test');
  await openClientSignup(pool);
  // Larose: Meta (browser + server) and TikTok, both counting Purchase when the order is saved.
  await pool.query(
    `UPDATE pixel_settings SET pixel_id = $2, events = ARRAY['PageView','InitiateCheckout','Lead','Purchase'], server_purchase = true, access_token_enc = $3
      WHERE business_id = $1 AND provider = 'meta'`, [larose, LAROSE_PIXEL, encrypt(encryptionKey, 'META-LAROSE-TOKEN')]);
  await pool.query(
    `INSERT INTO pixel_settings (business_id, provider, enabled, pixel_id, events, server_purchase, access_token_enc)
     VALUES ($1, 'tiktok', true, 'C4LAROSE0000000000', ARRAY['PageView','Lead','Purchase'], true, $2)`, [larose, encrypt(encryptionKey, 'TT-LAROSE-TOKEN')]);
  // A second business with its own page, product and Meta pixel.
  const { rows: [u] } = await pool.query("INSERT INTO users (email, password_hash, name) VALUES ('other@shop.test', 'x', 'Other') RETURNING id");
  other = (await pool.query("INSERT INTO businesses (owner_id, name, slug, currency) VALUES ($1, 'Other Shop', 'other-shop', 'NGN') RETURNING id", [u.id])).rows[0].id;
  await pool.query("INSERT INTO business_members (business_id, user_id, role) VALUES ($1, $2, 'owner')", [other, u.id]);
  const p = (await pool.query("INSERT INTO products (business_id, code, name, price_minor) VALUES ($1, 'glow-oil', 'Glow oil', 1500000) RETURNING id", [other])).rows[0].id;
  const lp = (await pool.query("INSERT INTO landing_pages (business_id, slug, name, url, status) VALUES ($1, 'other-page', 'Other page', $2, 'active') RETURNING id", [other, `${OTHER_ORIGIN}/`])).rows[0].id;
  await pool.query('INSERT INTO landing_page_products (landing_page_id, product_id) VALUES ($1, $2)', [lp, p]);
  await pool.query(
    `INSERT INTO pixel_settings (business_id, provider, enabled, pixel_id, events, server_purchase, access_token_enc)
     VALUES ($1, 'meta', true, $2, ARRAY['PageView','Purchase'], true, $3)`, [other, OTHER_PIXEL, encrypt(encryptionKey, 'META-OTHER-TOKEN')]);
  clearOriginCache();
});
after(async () => { await pool.end(); mock.close(); });

describe('no saved order, no Purchase', () => {
  test('D. validation fails: 400, no order, no Purchase', async () => {
    calls.length = 0;
    const before = await counts();
    const res = await send(orderBody({ customer: { name: 'A', phone: '123', address: 'x' } }));
    assert.equal(res.status, 400);
    assert.equal(res.body.ok, false);
    assert.equal(res.body.saved, undefined);
    await settle();
    assert.deepEqual(await counts(), before);
    assert.equal(calls.length, 0);
  });

  test('E. the request fails before saving (unknown page, website not allowed, broken request): no order, no Purchase', async () => {
    calls.length = 0;
    const before = await counts();
    assert.equal((await send(orderBody({ landingPage: 'no-such-page' }))).status, 400);
    assert.equal((await send(orderBody(), 'https://evil.example.test')).status, 403);
    assert.equal((await request(app).post('/api/public/orders').set('Origin', ORIGIN).set('Content-Type', 'application/json').send('{"broken"')).status, 400);
    // A price the page shows that differs from Skyfly's price is refused, not trusted.
    const price = await send(orderBody({ items: [{ product: 'package-2', quantity: 1, unitPrice: 1 }] }));
    assert.equal(price.status, 409);
    await settle();
    assert.deepEqual(await counts(), before);
    assert.equal(calls.length, 0);
  });

  test('F. the database save fails: no success reply, no order, no Purchase', async () => {
    calls.length = 0;
    const before = await counts();
    // Make the save fail inside the order transaction (after the order row, at its items).
    await pool.query(`CREATE OR REPLACE FUNCTION fail_items() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'disk full (test)'; END $$ LANGUAGE plpgsql;
                      CREATE TRIGGER fail_items BEFORE INSERT ON order_items FOR EACH ROW EXECUTE FUNCTION fail_items();`);
    try {
      const res = await send(orderBody());
      assert.equal(res.status, 500);
      assert.equal(res.body.ok, false);
      assert.equal(res.body.reference, undefined, 'no order reference without a saved order');
    } finally {
      await pool.query('DROP TRIGGER fail_items ON order_items; DROP FUNCTION fail_items();');
    }
    await settle();
    assert.deepEqual(await counts(), before, 'the half-written order was rolled back');
    assert.equal(calls.length, 0);
  });
});

describe('one saved order, one Purchase', () => {
  let first;
  test('G. a saved order replies with its persistent ID, total, currency and business, and sends exactly one Purchase per platform', async () => {
    calls.length = 0;
    const res = await send(orderBody());
    assert.equal(res.status, 201);
    first = res.body;
    assert.equal(first.ok, true);
    assert.equal(first.saved, true);
    assert.match(first.reference, /^LR-[A-Z0-9]{7}$/);
    assert.equal(first.total, 73000);
    assert.equal(first.currency, 'NGN');
    assert.equal(first.business, 'larose-nigeria');
    assert.equal(first.purchaseEventId, `purchase_${first.reference}`);
    const { rows: [o] } = await pool.query('SELECT total_minor, business_id FROM orders WHERE reference = $1', [first.reference]);
    assert.deepEqual([o.total_minor, o.business_id], [7300000, larose], 'committed before the reply');
    await settle();
    const meta = metaCalls();
    const tiktok = calls.filter((c) => c.url.startsWith('/tiktok'));
    assert.equal(meta.length, 1);
    assert.equal(tiktok.length, 1);
    assert.equal(meta[0].url.split('?')[0], `/meta/v26.0/${LAROSE_PIXEL}/events`);
    assert.equal(meta[0].body.data[0].event_name, 'Purchase');
    assert.equal(meta[0].body.data[0].custom_data.value, 73000);
    assert.equal(meta[0].body.data[0].custom_data.currency, 'NGN');
    assert.equal(tiktok[0].body.data[0].event, 'CompletePayment');
  });

  test('M. browser and server send the same event name and event ID, so Meta and TikTok count one', async () => {
    const meta = metaCalls().at(-1).body.data[0];
    assert.equal(meta.event_id, first.purchaseEventId, 'server event_id = the ID the browser pixel uses');
    const tiktok = calls.filter((c) => c.url.startsWith('/tiktok')).at(-1).body.data[0];
    assert.equal(tiktok.event_id, first.purchaseEventId);
    // The browser SDK sends Meta "Purchase" with eventID purchase_<reference>, and TikTok "CompletePayment".
    const sdk = await request(app).get('/sdk/skyfly.js');
    assert.match(sdk.text, /track\('Purchase', \{ data: \{ value: data\.total, currency: data\.currency[^}]*\}, eventId: 'purchase_' \+ data\.reference \}/);
    assert.match(sdk.text, /Purchase: 'CompletePayment'/);
  });

  test('H. opening the order confirmation again (or refreshing it) sends nothing', async () => {
    calls.length = 0;
    const page = await request(app).get(new URL(first.confirmationUrl).pathname + new URL(first.confirmationUrl).search).expect(200);
    await request(app).get(new URL(first.confirmationUrl).pathname + new URL(first.confirmationUrl).search).expect(200);
    assert.doesNotMatch(page.text, /fbq|ttq|skyfly\.js|Purchase/, 'the confirmation page loads no pixel');
    await settle();
    assert.equal(calls.length, 0);
  });

  test('I. the same submission sent again (double tap, network retry): same order, no second Purchase', async () => {
    calls.length = 0;
    const body = orderBody();
    const replies = [];
    for (let i = 0; i < 3; i += 1) replies.push(await send(body));
    assert.deepEqual(replies.map((r) => r.status), [201, 200, 200]);
    assert.equal(new Set(replies.map((r) => r.body.reference)).size, 1);
    assert.deepEqual(replies.map((r) => r.body.replayed), [false, true, true]);
    await settle();
    assert.equal(metaCalls().length, 1);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM orders WHERE reference = $1', [replies[0].body.reference])).rows[0].n, 1);
  });

  test('J. two genuinely different orders from the same customer: two orders, two Purchases', async () => {
    calls.length = 0;
    const a = await send(orderBody());
    const b = await send(orderBody({ items: [{ product: 'package-3', quantity: 1 }] }));
    assert.equal(a.status, 201);
    assert.equal(b.status, 201);
    assert.notEqual(a.body.reference, b.body.reference);
    await settle();
    assert.deepEqual(metaCalls().map((c) => c.body.data[0].event_id).sort(), [`purchase_${a.body.reference}`, `purchase_${b.body.reference}`].sort());
  });

  test('K. the ad platform fails after the order is saved: the order stands, the failure is recorded, and a retry sends the same event once', async () => {
    calls.length = 0;
    failing = true;
    const res = await send(orderBody());
    assert.equal(res.status, 201, 'the customer is told the truth: the order is saved');
    await settle();
    failing = false;
    const { rows: [o] } = await pool.query('SELECT id FROM orders WHERE reference = $1', [res.body.reference]);
    const { rows: events } = await pool.query('SELECT * FROM conversion_events WHERE order_id = $1 ORDER BY provider', [o.id]);
    assert.deepEqual(events.map((e) => [e.provider, e.status]), [['meta', 'failed'], ['tiktok', 'failed']]);
    assert.match(events[0].last_error, /503|unavailable/i);
    const ordersBefore = (await counts()).orders;
    calls.length = 0;
    for (const e of events) assert.equal((await retryEvent(pool, config, e.id, larose)).ok, true);
    assert.deepEqual(calls.map((c) => c.body.data[0].event_id), [`purchase_${res.body.reference}`, `purchase_${res.body.reference}`]);
    assert.equal((await counts()).orders, ordersBefore, 'retrying tracking never creates an order');
    const { rows: after } = await pool.query("SELECT count(*)::int AS n FROM conversion_events WHERE order_id = $1 AND status = 'sent'", [o.id]);
    assert.equal(after[0].n, 2);
  });

  test('test orders ("TEST ORDER …") are saved but never sent as a Purchase', async () => {
    calls.length = 0;
    const res = await send(orderBody({ customer: { name: 'TEST ORDER tracking check', phone: '08031112222', address: '5 Allen Avenue, Ikeja' } }));
    assert.equal(res.status, 201);
    assert.equal(res.body.test, true);
    await settle();
    assert.equal(calls.length, 0);
  });

  test('with a test event code saved, a test order\'s server Purchase goes only to Test events (value, currency, labelled), once', async () => {
    await pool.query("UPDATE pixel_settings SET test_event_code = 'TEST98765' WHERE business_id = $1 AND provider = 'meta'", [larose]);
    calls.length = 0;
    const body = orderBody({ customer: { name: 'TEST ORDER test events check', phone: '08031112222', address: '5 Allen Avenue, Ikeja' } });
    const res = await send(body);
    assert.equal(res.status, 201);
    assert.equal(res.body.test, true, 'the browser is told not to fire Purchase');
    await settle();
    assert.equal(calls.length, 1, 'Meta only: TikTok has no test event code, so nothing goes to TikTok');
    const [call] = metaCalls();
    assert.equal(call.body.test_event_code, 'TEST98765', 'marked as a test: shown in Test events, not counted in reports');
    const [ev] = call.body.data;
    assert.equal(ev.event_name, 'Purchase');
    assert.equal(ev.event_id, `test_purchase_${res.body.reference}`);
    assert.equal(ev.custom_data.value, res.body.total);
    assert.equal(ev.custom_data.currency, 'NGN');
    assert.ok(!JSON.stringify(call.body).includes('META-LAROSE-TOKEN'), 'the token is in the request URL only, never in the event');
    const { rows } = await pool.query("SELECT e.event_name, e.test_mode, e.status FROM conversion_events e JOIN orders o ON o.id = e.order_id WHERE o.reference = $1", [res.body.reference]);
    assert.deepEqual(rows, [{ event_name: 'Purchase (test)', test_mode: true, status: 'sent' }]);
    const again = await send(body);
    assert.equal(again.body.reference, res.body.reference);
    await settle();
    assert.equal(calls.length, 1, 'a repeated submission sends nothing more');
    await pool.query("UPDATE pixel_settings SET test_event_code = NULL WHERE business_id = $1 AND provider = 'meta'", [larose]);
  });
});

describe('L. each business uses only its own pixels', () => {
  test('an order on another business\'s page goes to that business\'s pixel only, and its page config lists only its pixel', async () => {
    calls.length = 0;
    const res = await send({
      landingPage: 'other-page', idempotencyKey: `purchase-tracking-other-${Date.now()}`,
      customer: { name: 'Bisi Other', phone: '08035556666', address: '9 Other Road, Yaba' }, items: [{ product: 'glow-oil', quantity: 1 }],
    }, OTHER_ORIGIN);
    assert.equal(res.status, 201);
    assert.equal(res.body.business, 'other-shop');
    await settle();
    assert.deepEqual(calls.map((c) => c.url.split('?')[0]), [`/meta/v26.0/${OTHER_PIXEL}/events`], 'not Larose\'s Meta or TikTok');
    const otherCfg = (await request(app).get('/api/public/pages/other-page/tracking')).body;
    const laroseCfg = (await request(app).get('/api/public/pages/larosenigeria/tracking')).body;
    assert.deepEqual(otherCfg.pixels.map((p) => p.id), [OTHER_PIXEL]);
    assert.ok(!laroseCfg.pixels.some((p) => p.id === OTHER_PIXEL));
    assert.doesNotMatch(JSON.stringify([otherCfg, laroseCfg]), /TOKEN|access_token/, 'no secrets in what the browser receives');
    // A Larose product can't be ordered through the other business's page.
    const cross = await send({ landingPage: 'other-page', idempotencyKey: `purchase-tracking-cross-${Date.now()}`,
      customer: { name: 'Cross Shop', phone: '08035556666', address: '9 Other Road, Yaba' }, items: [{ product: 'package-2', quantity: 1 }] }, OTHER_ORIGIN);
    assert.equal(cross.status, 400);
  });
});
