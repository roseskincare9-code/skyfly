// Migration 026: Larose's confirmed prices for its first three packages. Only a package still at
// its old price changes; a price the owner set in Products, packages 4–5, other businesses and
// past orders stay exactly as they were.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setup, resetDatabase, signUp, ORIGIN } from './helpers.js';
import { seedLarose, LAROSE_PACKAGES } from '../src/scripts/seed-larose.js';
import { clearOriginCache } from '../src/lib/origins.js';
import request from 'supertest';

const MIGRATION = readFileSync(new URL('../migrations/026_larose_prices.sql', import.meta.url), 'utf8');
const { pool, app } = setup({});
let larose; let other;
const prices = async (businessId) => Object.fromEntries((await pool.query(
  'SELECT code, price_minor FROM products WHERE business_id = $1 ORDER BY code', [businessId])).rows.map((r) => [r.code, Number(r.price_minor) / 100]));

before(async () => {
  await resetDatabase(pool);
  await signUp(app, { email: 'owner@larose.test' });
  larose = await seedLarose(pool, 'owner@larose.test');
  clearOriginCache();
  // As in production before the change: the old prices, and an order placed at one of them.
  await pool.query(`UPDATE products SET price_minor = CASE code WHEN 'package-1' THEN 2350000 WHEN 'package-2' THEN 3300000 WHEN 'package-3' THEN 5150000 ELSE price_minor END
    WHERE business_id = $1`, [larose]);
  const { rows: [u] } = await pool.query("INSERT INTO users (email, password_hash, name) VALUES ('other@shop.test', 'x', 'Other') RETURNING id");
  other = (await pool.query("INSERT INTO businesses (owner_id, name, slug, currency) VALUES ($1, 'Other Shop', 'other-shop', 'NGN') RETURNING id", [u.id])).rows[0].id;
  await pool.query("INSERT INTO products (business_id, code, name, price_minor) VALUES ($1, 'package-1', 'Other package', 2350000)", [other]);
});
after(() => pool.end());

test('the confirmed prices are the seed prices for new setups', () => {
  assert.deepEqual(LAROSE_PACKAGES.map((p) => [p.code, p.price]),
    [['package-1', 26500], ['package-2', 36500], ['package-3', 58000], ['package-4', 93500], ['package-5', 202000]]);
});

test('only Larose packages 1–3 still at their old price change; everything else stays as it was', async () => {
  const old = await request(app).post('/api/public/orders').set('Origin', ORIGIN).send({
    landingPage: 'larosenigeria', idempotencyKey: 'larose-prices-old-000001',
    customer: { name: 'Before Change', phone: '08031112222', address: '5 Allen Avenue, Ikeja', state: 'Lagos' },
    items: [{ product: 'package-3', quantity: 2, unitPrice: 51500 }],
  }).expect(201);
  assert.equal(old.body.total, 103000);
  await pool.query("UPDATE products SET price_minor = 3400000 WHERE business_id = $1 AND code = 'package-2'", [larose]); // set by the owner
  await pool.query(MIGRATION);
  assert.deepEqual(await prices(larose), { 'package-1': 26500, 'package-2': 34000, 'package-3': 58000, 'package-4': 93500, 'package-5': 202000 });
  assert.deepEqual(await prices(other), { 'package-1': 23500 }, 'another business is untouched');
  const { rows: [o] } = await pool.query('SELECT total_minor FROM orders WHERE reference = $1', [old.body.reference]);
  assert.equal(Number(o.total_minor), 10300000, 'a past order keeps its price');
  await pool.query(MIGRATION); // running again changes nothing
  assert.deepEqual(await prices(larose), { 'package-1': 26500, 'package-2': 34000, 'package-3': 58000, 'package-4': 93500, 'package-5': 202000 });
});

test('after the change: the new page price is accepted and priced by Skyfly; the old page price is refused, never charged', async () => {
  const send = (unitPrice, key) => request(app).post('/api/public/orders').set('Origin', ORIGIN).send({
    landingPage: 'larosenigeria', idempotencyKey: key,
    customer: { name: 'After Change', phone: '08031112222', address: '5 Allen Avenue, Ikeja', state: 'Lagos' },
    items: [{ product: 'package-3', quantity: 2, unitPrice }],
  });
  const ok = await send(58000, 'larose-prices-new-000001').expect(201);
  assert.equal(ok.body.total, 116000);
  assert.equal((await send(51500, 'larose-prices-new-000002').expect(409)).body.error, 'PRICE_CHANGED');
});
