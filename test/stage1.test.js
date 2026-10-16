import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { setup, resetDatabase, csrfToken, signUp, ORIGIN, openClientSignup } from './helpers.js';
import { seedLarose } from '../src/scripts/seed-larose.js';
import { clearOriginCache } from '../src/lib/origins.js';

// Global extra origins are empty here, so only each page's own website is allowed.
const { pool, app } = setup({ allowedOrigins: [] });
let owner;
let businessId;
let n = 0;

const body = (overrides = {}) => {
  n += 1;
  return {
    landingPage: 'larosenigeria',
    idempotencyKey: `stage1-key-${Date.now()}-${n}-abcdef`,
    customer: { name: 'Bola Ade', phone: '08031234567', address: '3 Broad Street, Lagos', state: 'Lagos' },
    items: [{ product: 'package-1', quantity: 1 }],
    ...overrides,
  };
};

before(async () => {
  await resetDatabase(pool);
  owner = await signUp(app, { email: 'owner@larose.test' });
  businessId = await seedLarose(pool, 'owner@larose.test');
  await openClientSignup(pool);
  clearOriginCache();
});
after(() => pool.end());

describe('order API authentication', () => {
  test('the landing page\'s own website can submit', async () => {
    await request(app).post('/api/public/orders').set('Origin', ORIGIN).send(body()).expect(201);
  });

  test('a request with no Origin and no API key is refused', async () => {
    const res = await request(app).post('/api/public/orders').send(body()).expect(401);
    assert.equal(res.body.error, 'UNAUTHORIZED');
  });

  test('another registered website cannot submit orders for this page', async () => {
    const other = await signUp(app, { name: 'Other', email: 'other@shop.test' });
    let _csrf = await csrfToken(other, '/');
    await other.post('/businesses').type('form').send({ _csrf, name: 'Other Shop' }).expect(302);
    await pool.query(
      `INSERT INTO landing_pages (business_id, slug, name, url, status)
       SELECT id, 'other-page', 'Other', 'https://other.example/shop', 'active' FROM businesses WHERE slug = 'other-shop'`,
    );
    clearOriginCache();
    const res = await request(app).post('/api/public/orders').set('Origin', 'https://other.example').send(body()).expect(403);
    assert.equal(res.body.error, 'ORIGIN_NOT_ALLOWED');
  });

  test('API keys: shown once, stored hashed, work server-to-server, and can be revoked', async () => {
    const _csrf = await csrfToken(owner, `/businesses/${businessId}/api-keys`);
    const created = await owner.post(`/businesses/${businessId}/api-keys`).type('form').send({ _csrf, name: 'Webhook' }).expect(201);
    const key = created.text.match(/id="new-key">(sky_[A-Za-z0-9_-]+)</)[1];
    const { rows: [stored] } = await pool.query('SELECT * FROM api_keys WHERE name = $1', ['Webhook']);
    assert.notEqual(stored.key_hash, key);
    assert.ok(!JSON.stringify(stored).includes(key));
    const list = await owner.get(`/businesses/${businessId}/api-keys`).expect(200);
    assert.ok(!list.text.includes(key), 'key is not shown again');

    const res = await request(app).post('/api/public/orders').set('Authorization', `Bearer ${key}`).send(body()).expect(201);
    const { rows: [o] } = await pool.query('SELECT source FROM orders WHERE reference = $1', [res.body.reference]);
    assert.equal(o.source, 'api');

    await request(app).post('/api/public/orders').set('Authorization', 'Bearer sky_wrongwrongwrongwrongwrong').send(body()).expect(401);
    // A key can't submit to another business's page.
    assert.equal((await request(app).post('/api/public/orders').set('Authorization', `Bearer ${key}`)
      .send(body({ landingPage: 'other-page' })).expect(403)).body.error, 'FORBIDDEN');

    const csrf2 = await csrfToken(owner, `/businesses/${businessId}/api-keys`);
    await owner.post(`/businesses/${businessId}/api-keys/${stored.id}/revoke`).type('form').send({ _csrf: csrf2 }).expect(302);
    await request(app).post('/api/public/orders').set('Authorization', `Bearer ${key}`).send(body()).expect(401);
  });
});

describe('payment status', () => {
  test('is separate from fulfilment and keeps its own history', async () => {
    const { body: r } = await request(app).post('/api/public/orders').set('Origin', ORIGIN).send(body()).expect(201);
    const { rows: [o] } = await pool.query('SELECT id FROM orders WHERE reference = $1', [r.reference]);
    const path = `/businesses/${businessId}/orders/${o.id}`;
    let _csrf = await csrfToken(owner, path);
    await owner.post(`${path}/status`).type('form').send({ _csrf, kind: 'payment', status: 'paid', note: 'Transfer received' }).expect(302);
    _csrf = await csrfToken(owner, path);
    await owner.post(`${path}/status`).type('form').send({ _csrf, kind: 'fulfillment', status: 'dispatched' }).expect(302);
    _csrf = await csrfToken(owner, path);
    await owner.post(`${path}/status`).type('form').send({ _csrf, kind: 'payment', status: 'bogus' }).expect(400);

    const { rows: [after] } = await pool.query('SELECT status, payment_status FROM orders WHERE id = $1', [o.id]);
    assert.deepEqual(after, { status: 'dispatched', payment_status: 'paid' });
    const { rows: h } = await pool.query('SELECT kind, from_status, to_status FROM order_status_history WHERE order_id = $1 ORDER BY id', [o.id]);
    assert.deepEqual(h.map((x) => [x.kind, x.from_status, x.to_status]), [
      ['fulfillment', null, 'pending'], ['payment', 'unpaid', 'paid'], ['fulfillment', 'pending', 'dispatched'],
    ]);

    const page = await owner.get(path).expect(200);
    assert.match(page.text, /Payment: Unpaid → <strong>Paid<\/strong>/);
    const paidList = await owner.get(`/businesses/${businessId}/orders?payment=paid`).expect(200);
    assert.match(paidList.text, new RegExp(r.reference));
    const csv = await owner.get(`/businesses/${businessId}/orders/export.csv?payment=paid`).expect(200);
    assert.match(csv.text.split('\r\n')[0], /Reference,Date \(UTC\),Status,Payment,Source/);
    assert.match(csv.text, new RegExp(`${r.reference},[^,]+,Dispatched,Paid,web`));
  });
});

describe('manual orders', () => {
  test('owner can enter an order with a custom price and statuses', async () => {
    const { rows: [p] } = await pool.query("SELECT id FROM products WHERE code = 'package-2'");
    const _csrf = await csrfToken(owner, `/businesses/${businessId}/orders/new`);
    const res = await owner.post(`/businesses/${businessId}/orders/new`).type('form').send({
      _csrf, name: 'Kemi Phone-Order', phone: '0812 345 6789', address: '9 Market Road, Ibadan', state: 'Oyo',
      product_0: p.id, quantity_0: 3, price_0: '30,000', status: 'confirmed', payment_status: 'pending',
    }).expect(302);
    const id = res.headers.location.match(/orders\/(\d+)/)[1];
    const { rows: [o] } = await pool.query('SELECT * FROM orders WHERE id = $1', [id]);
    assert.equal(o.source, 'manual');
    assert.equal(o.status, 'confirmed');
    assert.equal(o.payment_status, 'pending');
    assert.equal(o.phone, '+2348123456789');
    assert.equal(o.total_minor, 9000000);
    assert.match(o.reference, /^LR-/);
    const { rows: audit } = await pool.query("SELECT * FROM audit_log WHERE action = 'order.created_manually' AND entity_id = $1", [o.reference]);
    assert.equal(audit.length, 1);
  });

  test('invalid manual orders show field errors and keep the typed values', async () => {
    const _csrf = await csrfToken(owner, `/businesses/${businessId}/orders/new`);
    const res = await owner.post(`/businesses/${businessId}/orders/new`).type('form')
      .send({ _csrf, name: 'Typed Name', phone: '12', address: '' }).expect(400);
    assert.match(res.text, /valid phone number/);
    assert.match(res.text, /Add at least one product/);
    assert.match(res.text, /value="Typed Name"/);
  });
});

describe('audit log', () => {
  test('records logins, failed logins and changes, visible to the owner only', async () => {
    const agent = request.agent(app);
    const _csrf = await csrfToken(agent, '/login');
    await agent.post('/login').type('form').send({ _csrf, email: 'owner@larose.test', password: 'nope-nope-nope' }).expect(401);
    const { rows } = await pool.query("SELECT action FROM audit_log WHERE action LIKE 'login.%'");
    assert.ok(rows.some((r) => r.action === 'login.failed'));
    const page = await owner.get(`/businesses/${businessId}/activity`).expect(200);
    assert.match(page.text, /payment_status_changed/);
    assert.match(page.text, /api_key\.created/);
    assert.doesNotMatch(page.text, /sky_[A-Za-z0-9_-]{20,}/, 'no API key secrets in the log');
    const stranger = await signUp(app, { name: 'S', email: 'stranger@x.test' });
    await stranger.get(`/businesses/${businessId}/activity`).expect(404);
  });
});
