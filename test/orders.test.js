import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { setup, resetDatabase, csrfToken, signUp, ORIGIN } from './helpers.js';
import { seedLarose } from '../src/scripts/seed-larose.js';

const { pool, app } = setup();
let owner;
let businessId;
let n = 0;

function orderBody(overrides = {}) {
  n += 1;
  return {
    landingPage: 'larosenigeria',
    idempotencyKey: `test-key-${Date.now()}-${n}-abcdef`,
    customer: {
      name: 'Ada Obi', phone: '0803 123 4567', email: 'ada@example.com',
      address: '12 Allen Avenue, Ikeja', state: 'Lagos', notes: 'Call after 5pm',
    },
    items: [{ product: 'package-2', quantity: 2, unitPrice: 33000 }],
    attribution: { pageUrl: 'https://roseskincare9-code.github.io/Larosenigeria/?utm_source=facebook&utm_campaign=oct', utm_source: 'facebook', utm_campaign: 'oct' },
    ...overrides,
  };
}

const post = (body, origin = ORIGIN) => {
  const r = request(app).post('/api/public/orders');
  if (origin) r.set('Origin', origin);
  return r.send(body);
};

before(async () => {
  await resetDatabase(pool);
  owner = await signUp(app, { email: 'owner@larose.test' });
  businessId = await seedLarose(pool, 'owner@larose.test');
});
after(() => pool.end());

describe('public order API', () => {
  test('CORS preflight is allowed for the GitHub Pages origin only', async () => {
    const ok = await request(app).options('/api/public/orders').set('Origin', ORIGIN)
      .set('Access-Control-Request-Method', 'POST').set('Access-Control-Request-Headers', 'content-type');
    assert.equal(ok.status, 204);
    assert.equal(ok.headers['access-control-allow-origin'], ORIGIN);

    const bad = await request(app).options('/api/public/orders').set('Origin', 'https://evil.example');
    assert.equal(bad.status, 403);
    assert.equal(bad.headers['access-control-allow-origin'], undefined);
  });

  test('saves a valid order with server-side prices and returns a reference', async () => {
    const res = await post(orderBody()).expect(201);
    assert.equal(res.body.ok, true);
    assert.match(res.body.reference, /^LR-[2-9A-HJKMNP-TV-Z]{7}$/);
    assert.equal(res.body.total, 66000);
    assert.equal(res.headers['access-control-allow-origin'], ORIGIN);
    assert.match(res.body.confirmationUrl, new RegExp(`^http://skyfly.test/o/${res.body.reference}\\?t=[A-Za-z0-9_-]{32}$`));

    const { rows: [order] } = await pool.query('SELECT * FROM orders WHERE reference = $1', [res.body.reference]);
    assert.equal(order.phone, '+2348031234567');
    assert.equal(order.total_minor, 6600000);
    assert.equal(order.status, 'new');
    assert.equal(order.state, 'Lagos');
    assert.equal(order.customer_notes, 'Call after 5pm');
    assert.equal(order.utm_source, 'facebook');
    assert.equal(order.utm_campaign, 'oct');
    const { rows: items } = await pool.query('SELECT * FROM order_items WHERE order_id = $1', [order.id]);
    assert.equal(items.length, 1);
    assert.equal(items[0].product_code, 'package-2');
    assert.equal(items[0].unit_price_minor, 3300000);
    assert.equal(items[0].quantity, 2);
    assert.equal(items[0].line_total_minor, 6600000);
  });

  test('a tampered price is rejected and nothing is saved', async () => {
    const before = (await pool.query('SELECT count(*)::int AS n FROM orders')).rows[0].n;
    const res = await post(orderBody({ items: [{ product: 'package-5', quantity: 1, unitPrice: 100 }] })).expect(409);
    assert.equal(res.body.error, 'PRICE_CHANGED');
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM orders')).rows[0].n, before);
  });

  test('without a displayed price the server price is still used', async () => {
    const res = await post(orderBody({ items: [{ product: 'package-5', quantity: 1 }] })).expect(201);
    assert.equal(res.body.total, 202000);
  });

  test('invalid fields return field-level errors', async () => {
    const res = await post(orderBody({ customer: { name: '', phone: '123', address: 'x', email: 'nope' } })).expect(400);
    assert.equal(res.body.error, 'VALIDATION');
    assert.deepEqual(Object.keys(res.body.fields).sort(), ['address', 'email', 'name', 'phone']);
  });

  test('unknown product, bad quantity and unknown landing page are rejected', async () => {
    assert.equal((await post(orderBody({ items: [{ product: 'free-stuff', quantity: 1 }] })).expect(400)).body.error, 'UNKNOWN_PRODUCT');
    assert.equal((await post(orderBody({ items: [{ product: 'package-1', quantity: 0 }] })).expect(400)).body.error, 'VALIDATION');
    assert.equal((await post(orderBody({ items: [{ product: 'package-1', quantity: 2.5 }] })).expect(400)).body.error, 'VALIDATION');
    assert.equal((await post(orderBody({ landingPage: 'nope' })).expect(400)).body.error, 'UNKNOWN_LANDING_PAGE');
  });

  test('inactive products and paused pages stop taking orders', async () => {
    await pool.query("UPDATE products SET active = false WHERE code = 'package-3'");
    assert.equal((await post(orderBody({ items: [{ product: 'package-3', quantity: 1 }] })).expect(400)).body.error, 'UNKNOWN_PRODUCT');
    await pool.query("UPDATE products SET active = true WHERE code = 'package-3'");

    await pool.query("UPDATE landing_pages SET status = 'paused' WHERE slug = 'larosenigeria'");
    assert.equal((await post(orderBody()).expect(400)).body.error, 'UNKNOWN_LANDING_PAGE');
    await pool.query("UPDATE landing_pages SET status = 'active' WHERE slug = 'larosenigeria'");
  });

  test('malformed JSON and the honeypot are rejected', async () => {
    const res = await request(app).post('/api/public/orders').set('Origin', ORIGIN).set('Content-Type', 'application/json').send('{bad');
    assert.equal(res.status, 400);
    assert.equal(res.body.ok, false);
    await post(orderBody({ website: 'http://spam' })).expect(400);
  });

  test('repeated submissions with the same key create exactly one order', async () => {
    const body = orderBody();
    const results = await Promise.all(Array.from({ length: 8 }, () => post(body)));
    const statuses = results.map((r) => r.status).sort();
    assert.deepEqual(statuses, [200, 200, 200, 200, 200, 200, 200, 201]);
    assert.equal(new Set(results.map((r) => r.body.reference)).size, 1);
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM orders WHERE idempotency_key = $1', [body.idempotencyKey]);
    assert.equal(rows[0].n, 1);
  });

  test('reusing a key with different details is refused', async () => {
    const body = orderBody();
    await post(body).expect(201);
    const res = await post({ ...body, items: [{ product: 'package-1', quantity: 1 }] }).expect(409);
    assert.equal(res.body.error, 'IDEMPOTENCY_CONFLICT');
  });

  test('database failure returns a retryable JSON error', async () => {
    const broken = setup();
    await broken.pool.end();
    const res = await request(broken.app).post('/api/public/orders').set('Origin', ORIGIN).send(orderBody());
    assert.equal(res.status, 500);
    assert.equal(res.body.error, 'SERVER_ERROR');
    assert.match(res.body.message, /try again/);
    assert.equal(res.headers['access-control-allow-origin'], ORIGIN);
  });
});

describe('confirmation page', () => {
  test('shows the order with a WhatsApp link containing the reference', async () => {
    const { body } = await post(orderBody()).expect(201);
    const path = new URL(body.confirmationUrl).pathname + new URL(body.confirmationUrl).search;
    const page = await request(app).get(path).expect(200);
    assert.match(page.text, new RegExp(body.reference));
    assert.match(page.text, /Package 2 – Starter Glow Combo/);
    assert.match(page.text, /₦66,000/);
    assert.match(page.text, /\+234•+567/); // masked phone
    assert.doesNotMatch(page.text, /Allen Avenue/); // full address not exposed
    const wa = page.text.match(/href="(https:\/\/wa\.me\/[^"]+)"/)[1].replace(/&amp;/g, '&');
    const url = new URL(wa);
    assert.equal(url.pathname, '/2347039361243');
    assert.match(url.searchParams.get('text'), new RegExp(body.reference));
  });

  test('requires the secret token', async () => {
    const { body } = await post(orderBody()).expect(201);
    await request(app).get(`/o/${body.reference}`).expect(404);
    await request(app).get(`/o/${body.reference}?t=wrong`).expect(404);
  });

  test('uses the WhatsApp number from settings', async () => {
    await pool.query("UPDATE businesses SET whatsapp_number = '+2348000000001' WHERE id = $1", [businessId]);
    const { body } = await post(orderBody()).expect(201);
    const u = new URL(body.confirmationUrl);
    const page = await request(app).get(u.pathname + u.search).expect(200);
    assert.match(page.text, /wa\.me\/2348000000001/);
    await pool.query("UPDATE businesses SET whatsapp_number = '+2347039361243' WHERE id = $1", [businessId]);
  });
});

describe('dashboard', () => {
  test('order pages require login', async () => {
    await request(app).get(`/businesses/${businessId}/orders`).expect(302).expect('Location', '/login');
    await request(app).get(`/businesses/${businessId}/orders/export.csv`).expect(302);
  });

  test('new orders appear in the list, search and CSV export', async () => {
    const { body } = await post(orderBody({ customer: { name: 'Chioma Eze', phone: '07039990000', address: '5 Aba Road, PH', state: 'Rivers' } })).expect(201);
    const list = await owner.get(`/businesses/${businessId}/orders`).expect(200);
    assert.match(list.text, new RegExp(body.reference));

    const byPhone = await owner.get(`/businesses/${businessId}/orders?q=07039990000`).expect(200);
    assert.match(byPhone.text, /Chioma Eze/);
    assert.doesNotMatch(byPhone.text, /Ada Obi/);

    const byStatus = await owner.get(`/businesses/${businessId}/orders?status=delivered`).expect(200);
    assert.doesNotMatch(byStatus.text, new RegExp(body.reference));

    const csv = await owner.get(`/businesses/${businessId}/orders/export.csv?q=Chioma`).expect(200);
    assert.match(csv.headers['content-type'], /text\/csv/);
    assert.match(csv.text, new RegExp(`${body.reference},`));
    assert.match(csv.text, /Package 1|Package 2/);
  });

  test('CSV export neutralises spreadsheet formulas', async () => {
    await post(orderBody({ customer: { name: '=HYPERLINK("x")', phone: '08031112222', address: '1 Test Street', state: 'Lagos' } })).expect(201);
    const csv = await owner.get(`/businesses/${businessId}/orders/export.csv?q=HYPERLINK`).expect(200);
    assert.match(csv.text, /"'=HYPERLINK\(""x""\)"/);
  });

  test('owner can update status and the overview counts it as a sale', async () => {
    const { body } = await post(orderBody({ items: [{ product: 'package-4', quantity: 1, unitPrice: 93500 }] })).expect(201);
    const { rows: [order] } = await pool.query('SELECT id FROM orders WHERE reference = $1', [body.reference]);
    const detail = await owner.get(`/businesses/${businessId}/orders/${order.id}`).expect(200);
    assert.match(detail.text, /href="tel:\+2348031234567"/);
    assert.match(detail.text, /wa\.me\/2348031234567/);

    const _csrf = await csrfToken(owner, `/businesses/${businessId}/orders/${order.id}`);
    await owner.post(`/businesses/${businessId}/orders/${order.id}/status`).type('form')
      .send({ _csrf, status: 'delivered', note: 'Paid cash on delivery' }).expect(302);
    const { rows: [updated] } = await pool.query('SELECT status FROM orders WHERE id = $1', [order.id]);
    assert.equal(updated.status, 'delivered');
    const { rows: history } = await pool.query('SELECT * FROM order_status_history WHERE order_id = $1 ORDER BY id', [order.id]);
    assert.deepEqual(history.map((h) => h.to_status), ['new', 'delivered']);

    const overview = await owner.get(`/businesses/${businessId}`).expect(200);
    assert.match(overview.text, /₦93,500[\s\S]*Delivered sales/);
    // Totals across several statuses must be added as numbers, not concatenated.
    const { rows: [pipeline] } = await pool.query(
      "SELECT sum(total_minor)::bigint AS t FROM orders WHERE business_id = $1 AND status IN ('new', 'pending_confirmation')", [businessId]);
    assert.ok(pipeline.t > 0);
    const expected = `₦${(pipeline.t / 100).toLocaleString('en-NG')}`;
    assert.match(overview.text, new RegExp(`${expected}</div><div class="l">Awaiting confirmation`));
  });

  test('another owner cannot see or update these orders', async () => {
    const intruder = await signUp(app, { name: 'Intruder', email: 'intruder@example.com' });
    const { rows: [order] } = await pool.query('SELECT id FROM orders LIMIT 1');
    await intruder.get(`/businesses/${businessId}/orders/${order.id}`).expect(404);
    const _csrf = await csrfToken(intruder, '/');
    await intruder.post(`/businesses/${businessId}/orders/${order.id}/status`).type('form').send({ _csrf, status: 'cancelled' }).expect(404);
  });

  test('landing pages can be duplicated, exported and imported', async () => {
    const pages = await owner.get(`/businesses/${businessId}/landing-pages`).expect(200);
    assert.match(pages.text, /https:\/\/roseskincare9-code\.github\.io\/Larosenigeria\//);
    const { rows: [lp] } = await pool.query("SELECT id FROM landing_pages WHERE slug = 'larosenigeria'");

    let _csrf = await csrfToken(owner, `/businesses/${businessId}/landing-pages`);
    await owner.post(`/businesses/${businessId}/landing-pages/${lp.id}/duplicate`).type('form').send({ _csrf }).expect(302);
    const { rows: [copy] } = await pool.query("SELECT * FROM landing_pages WHERE slug = 'larosenigeria-copy'");
    assert.equal(copy.status, 'draft');
    const { rows: copyProducts } = await pool.query('SELECT count(*)::int AS n FROM landing_page_products WHERE landing_page_id = $1', [copy.id]);
    assert.equal(copyProducts[0].n, 5);

    const exported = await owner.get(`/businesses/${businessId}/landing-pages/${lp.id}/export.json`).expect(200);
    assert.equal(exported.body.format, 'skyfly.landing-page.v1');
    assert.equal(exported.body.products.length, 5);

    _csrf = await csrfToken(owner, `/businesses/${businessId}/landing-pages`);
    await owner.post(`/businesses/${businessId}/landing-pages/import`).type('form')
      .send({ _csrf, json: JSON.stringify(exported.body) }).expect(302);
    const { rows: imported } = await pool.query("SELECT slug, status FROM landing_pages WHERE slug LIKE 'larosenigeria-%' ORDER BY id");
    assert.deepEqual(imported.map((r) => r.slug), ['larosenigeria-copy', 'larosenigeria-2']);
  });

  test('product price changes apply to new orders only', async () => {
    const { rows: [p] } = await pool.query("SELECT id FROM products WHERE code = 'package-1'");
    const { body: first } = await post(orderBody({ items: [{ product: 'package-1', quantity: 1 }] })).expect(201);
    const _csrf = await csrfToken(owner, `/businesses/${businessId}/products`);
    await owner.post(`/businesses/${businessId}/products/${p.id}`).type('form')
      .send({ _csrf, name: 'Package 1 – Starter Glow Soap (1kg Soap)', price: '25,000', sort_order: 1, active: 'on' }).expect(302);
    const { body: second } = await post(orderBody({ items: [{ product: 'package-1', quantity: 1 }] })).expect(201);
    assert.equal(first.total, 23500);
    assert.equal(second.total, 25000);
    // The live page still shows ₦23,500, so its orders are refused until the page is updated.
    assert.equal((await post(orderBody({ items: [{ product: 'package-1', quantity: 1, unitPrice: 23500 }] })).expect(409)).body.error, 'PRICE_CHANGED');
  });
});
