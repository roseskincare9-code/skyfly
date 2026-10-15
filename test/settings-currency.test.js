import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { setup, resetDatabase, csrfToken, signUp, ORIGIN } from './helpers.js';

const { pool, app } = setup();
let owner;
let id;

async function saveSettings(fields) {
  const _csrf = await csrfToken(owner, `/businesses/${id}/settings`);
  return owner.post(`/businesses/${id}/settings`).type('form').send({ _csrf, name: 'Larose UK', order_prefix: 'LU', ...fields });
}

before(async () => {
  await resetDatabase(pool);
  owner = await signUp(app, { email: 'owner@larose.test' });
  const _csrf = await csrfToken(owner, '/');
  await owner.post('/businesses').type('form').send({ _csrf, name: 'Larose UK' }).expect(302);
  ({ rows: [{ id }] } = await pool.query("SELECT id FROM businesses WHERE name = 'Larose UK'"));
});
after(() => pool.end());

test('a new business can be switched to GBP, and prices are entered and shown in pounds', async () => {
  assert.equal((await saveSettings({ currency: 'GBP' })).status, 302);
  assert.equal((await pool.query('SELECT currency FROM businesses WHERE id = $1', [id])).rows[0].currency, 'GBP');
  const _csrf = await csrfToken(owner, `/businesses/${id}/products`);
  await owner.post(`/businesses/${id}/products`).type('form').send({ _csrf, name: 'Package 1 – The Starter Glow', code: 'uk-package-1', price: '£75' }).expect(302);
  const list = await owner.get(`/businesses/${id}/products`).expect(200);
  assert.match(list.text, /Price \(GBP\)/);
  assert.match(list.text, /value="75"/);
  assert.equal((await saveSettings({ currency: 'XYZ' })).status, 400);
});

test('once the business has an order, its currency can no longer change', async () => {
  const { rows: [p] } = await pool.query('SELECT id FROM products WHERE business_id = $1', [id]);
  await pool.query(
    "INSERT INTO landing_pages (business_id, slug, name, url, status) VALUES ($1, 'larose-uk', 'Larose UK', 'https://roseskincare9-code.github.io/Larose-Skincare-/', 'active')",
    [id],
  );
  await pool.query("INSERT INTO landing_page_products (landing_page_id, product_id) SELECT id, $1 FROM landing_pages WHERE slug = 'larose-uk'", [p.id]);
  const res = await request(app).post('/api/public/orders').set('Origin', ORIGIN).send({
    landingPage: 'larose-uk', idempotencyKey: 'uk-currency-test-000001',
    customer: { name: 'Uk Test', phone: '+447700900123', address: '1 Test Street, London' },
    items: [{ product: 'uk-package-1', quantity: 1 }],
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.currency, 'GBP');
  assert.equal(res.body.total, 75);
  const page = await owner.get(`/businesses/${id}/settings`).expect(200);
  assert.match(page.text, /Fixed because this business already has orders/);
  await saveSettings({ currency: 'NGN' });
  assert.equal((await pool.query('SELECT currency FROM businesses WHERE id = $1', [id])).rows[0].currency, 'GBP');
});
