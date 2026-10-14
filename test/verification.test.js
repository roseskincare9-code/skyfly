import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { setup, resetDatabase, csrfToken, signUp, ORIGIN } from './helpers.js';
import { seedLarose } from '../src/scripts/seed-larose.js';

const calls = [];
const mock = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    calls.push({ url: req.url, body: JSON.parse(body || '{}') });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(req.url.startsWith('/meta') ? '{"events_received":1}' : '{"code":0,"message":"OK"}');
  });
});
await new Promise((r) => mock.listen(0, r));
const base = `http://127.0.0.1:${mock.address().port}`;

const { pool, app } = setup({ encryptionKey: randomBytes(32), metaGraphBase: `${base}/meta`, tiktokApiBase: `${base}/tiktok` });
let owner;
let businessId;
let n = 0;

const post = async (path, fields) => {
  const _csrf = await csrfToken(owner, path.split('/').slice(0, -1).join('/') || path);
  return owner.post(path).type('form').send({ _csrf, ...fields });
};

async function placeOrder() {
  n += 1;
  const res = await request(app).post('/api/public/orders').set('Origin', ORIGIN).send({
    landingPage: 'larosenigeria', idempotencyKey: `verify-key-${Date.now()}-${n}`,
    customer: { name: 'Tolu Ade', phone: '08035550199', address: '4 Verify Road, Lagos', state: 'Lagos' },
    items: [{ product: 'package-4', quantity: 1 }],
  }).expect(201);
  const { rows: [o] } = await pool.query('SELECT id FROM orders WHERE reference = $1', [res.body.reference]);
  return { ...res.body, id: o.id };
}

before(async () => {
  await resetDatabase(pool);
  owner = await signUp(app, { email: 'owner@larose.test' });
  businessId = await seedLarose(pool, 'owner@larose.test');
});
after(async () => {
  await pool.end();
  mock.close();
});

describe('order connection is only verified by a real saved submission', () => {
  test('a registered page starts as not connected', async () => {
    const list = await owner.get(`/businesses/${businessId}/landing-pages`).expect(200);
    assert.match(list.text, /Not connected/);
    assert.doesNotMatch(list.text, /verified/);
  });

  test('the first saved browser order verifies it, and the page says which order', async () => {
    const order = await placeOrder();
    const { rows: [lp] } = await pool.query("SELECT * FROM landing_pages WHERE slug = 'larosenigeria'");
    assert.equal(lp.order_connected_reference, order.reference);
    const list = await owner.get(`/businesses/${businessId}/landing-pages`).expect(200);
    assert.match(list.text, new RegExp(`Orders connected ✓ verified[\\s\\S]*first order ${order.reference}`));
    // A later order doesn't overwrite the first proof.
    await placeOrder();
    const { rows: [again] } = await pool.query("SELECT order_connected_reference FROM landing_pages WHERE slug = 'larosenigeria'");
    assert.equal(again.order_connected_reference, order.reference);
  });

  test('uploading code alone is "found, not verified"; publishing a new version needs re-verification', async () => {
    const { rows: [lp] } = await pool.query("SELECT id FROM landing_pages WHERE slug = 'larosenigeria'");
    const path = `/businesses/${businessId}/landing-pages/${lp.id}`;
    const _csrf = await csrfToken(owner, path);
    await owner.post(`${path}/upload`).field('_csrf', _csrf)
      .attach('file', Buffer.from('<html><head></head><body><form data-skyfly-form><input name="name"></form></body></html>'), 'index.html').expect(302);
    const { rows: [v] } = await pool.query('SELECT id FROM page_versions WHERE landing_page_id = $1', [lp.id]);
    const pub = await post(`${path}/publish`, { version_id: v.id });
    assert.equal(pub.status, 302);
    const { rows: [after] } = await pool.query('SELECT order_connected_at FROM landing_pages WHERE id = $1', [lp.id]);
    assert.equal(after.order_connected_at, null);
    const page = await owner.get(path).expect(200);
    assert.match(page.text, /Connection code found, not verified/);
  });
});

describe('test orders', () => {
  test('are excluded from sales figures and never sent as purchases', async () => {
    await pool.query('UPDATE orders SET is_test = true');
    const order = await placeOrder();
    // Set up Meta server-side Purchase.
    const pixPath = `/businesses/${businessId}/pixels`;
    let _csrf = await csrfToken(owner, pixPath);
    await owner.post(pixPath).type('form').send({
      _csrf, provider: 'meta', enabled: 'on', pixel_id: '123456789012345', events: ['PageView'], server_purchase: 'on', access_token: 'EAAB-verify-token-123456789',
    }).expect(302);

    const path = `/businesses/${businessId}/orders/${order.id}`;
    _csrf = await csrfToken(owner, path);
    await owner.post(`${path}/test`).type('form').send({ _csrf, is_test: 'true' }).expect(302);
    _csrf = await csrfToken(owner, path);
    await owner.post(`${path}/status`).type('form').send({ _csrf, kind: 'payment', status: 'paid' }).expect(302);
    assert.equal(calls.length, 0, 'no Purchase for a test order');

    const overview = await owner.get(`/businesses/${businessId}`).expect(200);
    assert.match(overview.text, /₦0<\/div><div class="l">Paid revenue/);
    assert.match(overview.text, /<div class="n">0<\/div><div class="l">Total orders/);
    const detail = await owner.get(path).expect(200);
    assert.match(detail.text, /This is a test order/);

    const only = await owner.get(`/businesses/${businessId}/orders?test=only`).expect(200);
    assert.match(only.text, new RegExp(order.reference));
    const hidden = await owner.get(`/businesses/${businessId}/orders?test=exclude`).expect(200);
    assert.doesNotMatch(hidden.text, new RegExp(order.reference));
    const csv = await owner.get(`/businesses/${businessId}/orders/export.csv?test=only`).expect(200);
    assert.match(csv.text.split('\r\n')[0], /Source,Test order,Customer/);
    assert.match(csv.text, new RegExp(`${order.reference},[^\\r]*,Paid,web,yes,`));
  });

  test('a real paid order counts and sends one Purchase', async () => {
    const order = await placeOrder();
    const path = `/businesses/${businessId}/orders/${order.id}`;
    const _csrf = await csrfToken(owner, path);
    await owner.post(`${path}/status`).type('form').send({ _csrf, kind: 'payment', status: 'paid' }).expect(302);
    assert.equal(calls.length, 1);
    const overview = await owner.get(`/businesses/${businessId}`).expect(200);
    assert.match(overview.text, /₦93,500<\/div><div class="l">Paid revenue/);
  });
});

describe('pixel: configured vs verified', () => {
  const pixPath = () => `/businesses/${businessId}/pixels`;
  const status = (html, provider) => html.match(new RegExp(`<dl class="kv"[^>]*data-status="${provider}">([\\s\\S]*?)</dl>`))[1].replace(/\s+/g, ' ');

  test('server Purchase became verified when the platform accepted a real event', async () => {
    const page = await owner.get(pixPath()).expect(200);
    const meta = status(page.text, 'meta');
    assert.match(meta, /Configured<\/dt><dd>Yes: pixel 123456789012345 is on/);
    assert.match(meta, /Browser events<\/dt><dd> <span class="pill pending">Not verified/);
    assert.match(meta, /Server Purchase<\/dt><dd> <span class="pill active">Verified<\/span> <span class="muted">Meta accepted an event/);
    assert.match(status(page.text, 'tiktok'), /Configured<\/dt><dd>No/);
  });

  test('browser events are verified only when the owner confirms, and reset when the ID changes', async () => {
    let _csrf = await csrfToken(owner, pixPath());
    const off = await owner.post(`${pixPath()}/browser-verified`).type('form').send({ _csrf, provider: 'tiktok', verified: 'true' }).expect(400);
    assert.match(off.text, /Turn the pixel on/);

    _csrf = await csrfToken(owner, pixPath());
    await owner.post(`${pixPath()}/browser-verified`).type('form').send({ _csrf, provider: 'meta', verified: 'true' }).expect(302);
    let page = await owner.get(pixPath()).expect(200);
    assert.match(status(page.text, 'meta'), /Browser events<\/dt><dd> <span class="pill active">Verified<\/span> <span class="muted">confirmed by you on/);
    const { rows: [a] } = await pool.query("SELECT browser_verified_by FROM pixel_settings WHERE provider = 'meta'");
    assert.ok(a.browser_verified_by);

    _csrf = await csrfToken(owner, pixPath());
    await owner.post(pixPath()).type('form').send({ _csrf, provider: 'meta', enabled: 'on', pixel_id: '555555555555555', events: ['PageView'], server_purchase: 'on' }).expect(302);
    page = await owner.get(pixPath()).expect(200);
    const meta = status(page.text, 'meta');
    assert.match(meta, /Browser events<\/dt><dd> <span class="pill pending">Not verified/);
    assert.match(meta, /Server Purchase<\/dt><dd> <span class="pill pending">Not verified/);
  });

  test('a successful test Purchase verifies the server connection', async () => {
    let _csrf = await csrfToken(owner, pixPath());
    await owner.post(pixPath()).type('form').send({ _csrf, provider: 'meta', enabled: 'on', pixel_id: '555555555555555', events: ['PageView'], server_purchase: 'on', test_event_code: 'TEST999' }).expect(302);
    _csrf = await csrfToken(owner, pixPath());
    await owner.post(`${pixPath()}/test`).type('form').send({ _csrf, provider: 'meta' }).expect(200);
    const page = await owner.get(pixPath()).expect(200);
    assert.match(status(page.text, 'meta'), /Server Purchase<\/dt><dd> <span class="pill active">Verified/);
    assert.equal(calls.at(-1).body.test_event_code, 'TEST999');
  });
});
