// Additional named pixels ("Pixel New" on Larose, next to its main Meta pixel): listed by name on the
// Pixels screen, loaded once on the business's pages, and given Purchase once per saved order with
// the saved total in NGN (never for a failed or test order, never twice on a retry). Meta is a stand-in.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { setup, resetDatabase, signUp, ORIGIN } from './helpers.js';
import { seedLarose, LAROSE_META_PIXEL_ID, LAROSE_PIXEL_NEW_ID, LAROSE_AD_ACCOUNT_PIXELS } from '../src/scripts/seed-larose.js';
import { encrypt } from '../src/lib/secrets.js';
import { browserConfig, retryEvent } from '../src/services/pixels.js';
import { clearOriginCache } from '../src/lib/origins.js';

const calls = [];
let failing = false;
const mock = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    calls.push({ url: req.url, body: JSON.parse(body || '{}') });
    res.writeHead(failing ? 503 : 200, { 'Content-Type': 'application/json' });
    res.end(failing ? '{"error":{"message":"Service unavailable"}}' : '{"events_received":1}');
  });
});
await new Promise((r) => mock.listen(0, r));
const encryptionKey = randomBytes(32);
const { pool, app, config } = setup({ encryptionKey, metaGraphBase: `http://127.0.0.1:${mock.address().port}/meta` });
const settle = () => new Promise((r) => setTimeout(r, 150));
let larose; let owner; let n = 0;
const order = (overrides = {}) => request(app).post('/api/public/orders').set('Origin', ORIGIN).send({
  landingPage: 'larosenigeria', idempotencyKey: `additional-pixels-${String(n += 1).padStart(6, '0')}`,
  customer: { name: 'Ngozi Eze', phone: '08031112222', address: '5 Allen Avenue, Ikeja', state: 'Lagos' },
  items: [{ product: 'package-2', quantity: 1 }], ...overrides,
});
const pixelsCalled = () => calls.map((c) => c.url.split('/')[2]).sort();

before(async () => {
  await resetDatabase(pool);
  owner = await signUp(app, { email: 'owner@larose.test' });
  larose = await seedLarose(pool, 'owner@larose.test');
  // These tests cover Pixel New next to the main pixel; the ad-account pixels have their own tests.
  await pool.query('DELETE FROM additional_pixels WHERE pixel_id = ANY($1)', [LAROSE_AD_ACCOUNT_PIXELS.map((p) => p.id)]);
  clearOriginCache();
});
after(async () => { await pool.end(); mock.close(); });

describe('Pixel New next to the main Larose pixel', () => {
  test('is stored by name, and the main pixel is unchanged', async () => {
    const { rows: [x] } = await pool.query('SELECT * FROM additional_pixels WHERE business_id = $1', [larose]);
    assert.deepEqual([x.name, x.provider, x.pixel_id, x.enabled], ['Pixel New', 'meta', LAROSE_PIXEL_NEW_ID, true]);
    assert.ok(x.events.includes('PageView') && x.events.includes('InitiateCheckout') && x.events.includes('Purchase'));
    const { rows: main } = await pool.query("SELECT pixel_id FROM pixel_settings WHERE business_id = $1 AND provider = 'meta'", [larose]);
    assert.deepEqual(main.map((r) => r.pixel_id), [LAROSE_META_PIXEL_ID]);
  });

  test('the page config lists both pixels once each, with no token', async () => {
    await pool.query('UPDATE additional_pixels SET server_purchase = true, access_token_enc = $1', [encrypt(encryptionKey, 'PIXEL-NEW-SECRET-TOKEN-123')]);
    const res = await request(app).get('/api/public/pages/larosenigeria/tracking').expect(200);
    assert.deepEqual(res.body.pixels.map((p) => p.id), [LAROSE_META_PIXEL_ID, LAROSE_PIXEL_NEW_ID]);
    assert.ok(!JSON.stringify(res.body).includes('SECRET') && !JSON.stringify(res.body).includes('access_token'));
  });

  test('the same ID as the main pixel is listed only once', async () => {
    const { rows: [page] } = await pool.query("SELECT id, business_id, slug FROM landing_pages WHERE slug = 'larosenigeria'");
    await pool.query("INSERT INTO additional_pixels (business_id, provider, name, pixel_id) VALUES ($1, 'meta', 'Copy', $2)", [larose, LAROSE_META_PIXEL_ID]);
    assert.deepEqual((await browserConfig(pool, page, config)).pixels.map((p) => p.id), [LAROSE_META_PIXEL_ID, LAROSE_PIXEL_NEW_ID]);
    await pool.query("DELETE FROM additional_pixels WHERE name = 'Copy'");
  });

  test('a saved order: one server Purchase for each pixel with a token, saved total in NGN, shared event ID', async () => {
    await pool.query("UPDATE pixel_settings SET server_purchase = true, access_token_enc = $2 WHERE business_id = $1 AND provider = 'meta'", [larose, encrypt(encryptionKey, 'MAIN-PIXEL-SECRET-TOKEN-12')]);
    calls.length = 0;
    const res = await order();
    assert.equal(res.status, 201);
    await settle();
    assert.deepEqual(pixelsCalled(), [LAROSE_META_PIXEL_ID, LAROSE_PIXEL_NEW_ID].sort());
    for (const c of calls) {
      const [ev] = c.body.data;
      assert.deepEqual([ev.event_name, ev.event_id, ev.custom_data.value, ev.custom_data.currency, ev.custom_data.order_id],
        ['Purchase', `purchase_${res.body.reference}`, res.body.total, 'NGN', res.body.reference]);
    }
    // The same submission again (retry / double tap): same order, nothing sent twice.
    calls.length = 0;
    const again = await request(app).post('/api/public/orders').set('Origin', ORIGIN).send({
      landingPage: 'larosenigeria', idempotencyKey: `additional-pixels-${String(n).padStart(6, '0')}`,
      customer: { name: 'Ngozi Eze', phone: '08031112222', address: '5 Allen Avenue, Ikeja', state: 'Lagos' }, items: [{ product: 'package-2', quantity: 1 }],
    });
    assert.equal(again.body.reference, res.body.reference);
    await settle();
    assert.equal(calls.length, 0);
  });

  test('an invalid order or a test order: no Purchase for either pixel', async () => {
    calls.length = 0;
    assert.equal((await order({ customer: { name: '', phone: '1' } })).status, 400);
    const t = await order({ customer: { name: 'TEST ORDER Ngozi', phone: '08031112222', address: '5 Allen Avenue', state: 'Lagos' } });
    assert.equal(t.body.test, true);
    await settle();
    assert.equal(calls.length, 0);
  });

  test('a failed send is recorded per pixel and retried once, with the same event ID', async () => {
    failing = true; calls.length = 0;
    const res = await order();
    await settle();
    failing = false;
    const { rows: events } = await pool.query(
      'SELECT e.* FROM conversion_events e JOIN orders o ON o.id = e.order_id WHERE o.reference = $1 ORDER BY e.pixel_id', [res.body.reference]);
    assert.deepEqual(events.map((e) => [e.pixel_id, e.status]), [[LAROSE_PIXEL_NEW_ID, 'failed'], [LAROSE_META_PIXEL_ID, 'failed']]);
    calls.length = 0;
    for (const e of events) assert.equal((await retryEvent(pool, config, e.id, larose)).ok, true);
    assert.deepEqual(pixelsCalled(), [LAROSE_META_PIXEL_ID, LAROSE_PIXEL_NEW_ID].sort());
    assert.equal((await retryEvent(pool, config, events[1].id, larose)), null, 'a sent event is not sent again');
  });
});

describe('Pixels screen', () => {
  test('shows Pixel New by name; the owner can switch it off and remove it, without touching the main pixel', async () => {
    const agent = owner;
    const page = await agent.get(`/businesses/${larose}/pixels`).expect(200);
    assert.match(page.text, /Additional pixels/);
    assert.match(page.text, new RegExp(`Pixel New <span class="muted">· Meta pixel ${LAROSE_PIXEL_NEW_ID}`));
    assert.ok(!page.text.includes('PIXEL-NEW-SECRET'), 'the token is never shown');
    const csrf = page.text.match(/name="_csrf" value="([^"]+)"/)[1];
    const { rows: [x] } = await pool.query('SELECT id FROM additional_pixels WHERE business_id = $1', [larose]);
    // A second pixel with the main pixel's ID is refused (it would double every event).
    const dup = await agent.post(`/businesses/${larose}/pixels/additional`).type('form').send({ _csrf: csrf, name: 'Dup', provider: 'meta', pixel_id: LAROSE_META_PIXEL_ID });
    assert.equal(dup.status, 400);
    await agent.post(`/businesses/${larose}/pixels/additional`).type('form')
      .send({ _csrf: csrf, id: x.id, name: 'Pixel New', pixel_id: LAROSE_PIXEL_NEW_ID, events: ['PageView', 'Purchase'], server_purchase: 'on' }).expect(302);
    const { rows: [off] } = await pool.query('SELECT enabled, events, access_token_enc IS NOT NULL AS token FROM additional_pixels WHERE id = $1', [x.id]);
    assert.deepEqual([off.enabled, off.events, off.token], [false, ['PageView', 'Purchase'], true], 'off, token kept');
    const cfg = await request(app).get('/api/public/pages/larosenigeria/tracking').expect(200);
    assert.deepEqual(cfg.body.pixels.map((p) => p.id), [LAROSE_META_PIXEL_ID]);
    await agent.post(`/businesses/${larose}/pixels/additional/remove`).type('form').send({ _csrf: csrf, id: x.id }).expect(302);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM additional_pixels')).rows[0].n, 0);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM pixel_settings WHERE pixel_id = $1", [LAROSE_META_PIXEL_ID])).rows[0].n, 1);
  });
});
