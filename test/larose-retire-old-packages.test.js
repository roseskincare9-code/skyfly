// Migration 064: the old Larose packages are switched off (never deleted) once the six new packages are live.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import request from 'supertest';
import { setup, resetDatabase, signUp, ORIGIN } from './helpers.js';
import { seedLarose } from '../src/scripts/seed-larose.js';
import { clearOriginCache } from '../src/lib/origins.js';

const NEW_PRICING = readFileSync(new URL('../migrations/062_larose_new_pricing.sql', import.meta.url), 'utf8');
const RETIRE = readFileSync(new URL('../migrations/064_larose_retire_old_packages.sql', import.meta.url), 'utf8');
const { pool, app } = setup({});
let larose; let other; let oldOrder;
const order = (items, key) => request(app).post('/api/public/orders').set('Origin', ORIGIN).send({
  landingPage: 'larosenigeria', idempotencyKey: key,
  customer: { name: 'Retire Check', phone: '08031112222', address: '5 Ring Road, Ibadan', state: 'Oyo' }, items,
});

before(async () => {
  await resetDatabase(pool);
  await signUp(app, { email: 'owner@larose.test' });
  larose = await seedLarose(pool, 'owner@larose.test');
  clearOriginCache();
  const { rows: [u] } = await pool.query("INSERT INTO users (email, password_hash, name) VALUES ('other@shop.test', 'x', 'Other') RETURNING id");
  other = (await pool.query("INSERT INTO businesses (owner_id, name, slug, currency) VALUES ($1, 'Other Shop', 'other-shop', 'NGN') RETURNING id", [u.id])).rows[0].id;
  await pool.query("INSERT INTO products (business_id, code, name, price_minor, active) VALUES ($1, 'package-1', 'Their package', 100000, true)", [other]);
  await pool.query(NEW_PRICING);
  oldOrder = (await order([{ product: 'package-1', quantity: 1, unitPrice: 26500 }], 'larose-retire-old-0001').expect(201)).body;
  await pool.query(RETIRE);
  await pool.query(RETIRE); // running again changes nothing
});
after(() => pool.end());

test('the page catalog lists exactly the six packages in order, with the Facial Set as the add-on', async () => {
  const r = await request(app).get('/api/public/pages/larosenigeria/catalog').set('Origin', ORIGIN).expect(200);
  assert.deepEqual(r.body.products.map((p) => p.code), ['soap-500g', 'soap-500g-oil', 'soap-1l', 'soap-1l-oil', 'soap-2l', 'soap-2l-oil']);
  assert.equal(r.body.upsell.code, 'facial-set');
});

test('old packages are switched off, not deleted; past orders keep their items and price', async () => {
  const { rows } = await pool.query("SELECT code, active FROM products WHERE business_id = $1 AND code LIKE 'package-%' ORDER BY code", [larose]);
  assert.equal(rows.length, 5); assert.ok(rows.every((p) => p.active === false));
  const { rows: [o] } = await pool.query('SELECT total_minor FROM orders WHERE reference = $1', [oldOrder.reference]);
  assert.equal(Number(o.total_minor), 2650000);
  const { rows: items } = await pool.query('SELECT oi.product_code, oi.product_id FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE o.reference = $1', [oldOrder.reference]);
  assert.equal(items.length, 1); assert.equal(items[0].product_code, 'package-1'); assert.ok(items[0].product_id, 'still linked to the (switched-off) product');
});

test('a new order for an old package is refused; new packages still order', async () => {
  const r = await order([{ product: 'package-1', quantity: 1, unitPrice: 26500 }], 'larose-retire-old-0002');
  assert.ok(r.status >= 400 && r.status < 500, `status ${r.status}`);
  const ok = await order([{ product: 'soap-1l', quantity: 1, unitPrice: 26500 }, { product: 'facial-set', quantity: 1, upsell: true, unitPrice: 17000 }], 'larose-retire-new-0001').expect(201);
  assert.equal(ok.body.total, 43500);
});

test("another business's product with the same code is untouched", async () => {
  const { rows: [p] } = await pool.query("SELECT active FROM products WHERE business_id = $1 AND code = 'package-1'", [other]);
  assert.equal(p.active, true);
});
