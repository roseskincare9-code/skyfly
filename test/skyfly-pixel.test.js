// Skyfly's own Meta Pixel (1325736489534601): loaded on Skyfly-owned pages only (the demo shop,
// including pages added later), never on a customer business's pages; Purchase only for a saved
// order, once, with its value and currency; test orders go only to Meta's Test events.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { setup, resetDatabase, signUp, ORIGIN } from './helpers.js';
import { seedLarose } from '../src/scripts/seed-larose.js';
import { ensureDemoSite } from '../src/services/setup.js';
import { browserConfig } from '../src/services/pixels.js';
import { clearOriginCache } from '../src/lib/origins.js';

const SKYFLY_PIXEL = '1325736489534601';
const calls = [];
const mock = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    calls.push({ url: req.url, body: JSON.parse(body || '{}') });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"events_received":1}');
  });
});
await new Promise((r) => mock.listen(0, r));
const { pool, app, config } = setup({
  pagesBaseUrl: '', encryptionKey: randomBytes(32), metaGraphBase: `http://127.0.0.1:${mock.address().port}/meta`,
  skyflyPixel: { id: SKYFLY_PIXEL, businesses: ['skyfly-demo'], accessToken: 'SKYFLY-CAPI-TOKEN-0123456789', testEventCode: 'TEST55555' },
});
const settle = () => new Promise((r) => setTimeout(r, 200));
let demo; let larose; let n = 0;
const demoOrder = (name = 'Demo Buyer') => request(app).post('/api/public/orders').set('Origin', 'null').send({
  landingPage: 'skyfly-demo', idempotencyKey: `skyfly-pixel-${String(n += 1).padStart(6, '0')}`,
  customer: { name, phone: '08012345678', address: '1 Demo Street, Ikeja', state: 'Lagos' }, items: [{ product: 'demo-serum', quantity: 2 }],
});

before(async () => {
  await resetDatabase(pool);
  await signUp(app, { email: 'owner@larose.test' });
  larose = await seedLarose(pool, 'owner@larose.test');
  await ensureDemoSite(pool, { demoSite: true }, { log() {} });
  demo = (await pool.query("SELECT id, business_id, slug FROM landing_pages WHERE slug = 'skyfly-demo'")).rows[0];
  clearOriginCache();
});
after(async () => { await pool.end(); mock.close(); });

describe('where the Skyfly pixel loads', () => {
  test('the published Skyfly demo page loads the Skyfly pixel, once, with no token in the page', async () => {
    const page = await request(app).get('/p/skyfly-demo/').expect(200);
    const cfg = JSON.parse(page.text.match(/window\.__SKYFLY__=(\{.*?\});<\/script>/)[1]);
    assert.deepEqual(cfg.pixels.map((p) => [p.provider, p.id]), [['meta', SKYFLY_PIXEL]]);
    assert.ok(cfg.pixels[0].events.includes('PageView') && cfg.pixels[0].events.includes('InitiateCheckout') && cfg.pixels[0].events.includes('Purchase'));
    assert.equal(page.text.split('/sdk/skyfly.js').length - 1, 1, 'one SDK, so one pixel load and one PageView');
    assert.ok(!page.text.includes('SKYFLY-CAPI-TOKEN') && !page.text.includes('TEST55555'));
  });

  test('a page the Skyfly business adds later gets it too; Larose\'s pages keep only Larose\'s own pixel', async () => {
    const { rows: [later] } = await pool.query("INSERT INTO landing_pages (business_id, slug, name, status) VALUES ($1, 'skyfly-new', 'New Skyfly page', 'active') RETURNING id, business_id, slug", [demo.business_id]);
    assert.deepEqual((await browserConfig(pool, later, config)).pixels.map((p) => p.id), [SKYFLY_PIXEL]);
    const res = await request(app).get('/api/public/pages/larosenigeria/tracking').expect(200);
    assert.ok(res.body.pixels.length >= 1);
    assert.ok(res.body.pixels.every((p) => p.id !== SKYFLY_PIXEL), 'customer businesses never get the Skyfly pixel');
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM pixel_settings WHERE pixel_id = $1', [SKYFLY_PIXEL]);
    assert.equal(rows[0].n, 0, 'nothing stored: it comes from the server config');
  });
});

describe('Purchase for the Skyfly pixel', () => {
  test('a test order (the demo page is in test mode) goes only to Test events, with value and currency', async () => {
    calls.length = 0;
    const res = await demoOrder();
    assert.equal(res.status, 201);
    assert.equal(res.body.test, true, 'the browser does not fire Purchase for it');
    await settle();
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, new RegExp(`^/meta/${SKYFLY_PIXEL}/events`));
    assert.equal(calls[0].body.test_event_code, 'TEST55555');
    const [ev] = calls[0].body.data;
    assert.equal(ev.event_name, 'Purchase');
    assert.equal(ev.custom_data.value, 25000);
    assert.equal(ev.custom_data.currency, 'NGN');
  });

  test('a real saved order sends one Purchase with the browser\'s event ID; a retry sends nothing more; a failed one sends none', async () => {
    await pool.query('UPDATE landing_pages SET test_mode = false WHERE id = $1', [demo.id]);
    calls.length = 0;
    const bad = await request(app).post('/api/public/orders').set('Origin', 'null').send({ landingPage: 'skyfly-demo', idempotencyKey: 'skyfly-pixel-bad-000001', customer: { name: 'A', phone: '1', address: 'x' }, items: [] });
    assert.equal(bad.status, 400);
    const body = { landingPage: 'skyfly-demo', idempotencyKey: 'skyfly-pixel-real-000001', customer: { name: 'Real Buyer', phone: '08012345678', address: '1 Demo Street, Ikeja' }, items: [{ product: 'demo-duo', quantity: 1 }] };
    const res = await request(app).post('/api/public/orders').set('Origin', 'null').send(body).expect(201);
    assert.equal(res.body.test, false);
    assert.equal(res.body.purchaseEventId, `purchase_${res.body.reference}`);
    await settle();
    assert.equal(calls.length, 1);
    const [ev] = calls[0].body.data;
    assert.equal(calls[0].body.test_event_code, undefined, 'a real order is a real conversion');
    assert.equal(ev.event_id, `purchase_${res.body.reference}`, 'same as the browser Purchase, so Meta counts one');
    assert.equal(ev.custom_data.value, 22000);
    assert.equal(ev.custom_data.currency, 'NGN');
    await request(app).post('/api/public/orders').set('Origin', 'null').send(body).expect(200);
    await settle();
    assert.equal(calls.length, 1, 'retry: no second Purchase');
    await pool.query('UPDATE landing_pages SET test_mode = true WHERE id = $1', [demo.id]);
  });

  test('Larose orders never reach the Skyfly pixel', async () => {
    calls.length = 0;
    await request(app).post('/api/public/orders').set('Origin', ORIGIN).send({
      landingPage: 'larosenigeria', idempotencyKey: 'skyfly-pixel-larose-0001',
      customer: { name: 'Larose Buyer', phone: '08031112222', address: '5 Allen Avenue, Ikeja' }, items: [{ product: 'package-1', quantity: 1 }],
    }).expect(201);
    await settle();
    assert.ok(calls.every((c) => !c.url.includes(SKYFLY_PIXEL)));
  });
});

describe('dashboard', () => {
  test('Larose\'s pixel page does not mention the Skyfly pixel', async () => {
    const owner = await signUp(app, { email: 'second@larose.test' });
    await pool.query("INSERT INTO business_members (business_id, user_id, role) SELECT $1, id, 'owner' FROM users WHERE email = 'second@larose.test' ON CONFLICT DO NOTHING", [larose]);
    const page = await owner.get(`/businesses/${larose}/pixels`).expect(200);
    assert.match(page.text, /Tracking pixels/);
    assert.ok(!page.text.includes('data-skyfly-pixel') && !page.text.includes(SKYFLY_PIXEL));
  });
});
