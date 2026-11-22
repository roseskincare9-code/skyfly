// Migration 062: Larose's new line-up (500g ₦20,500 as the main offer … Facial Set ₦17,000). New codes
// are added beside the old packages, so the page that is live keeps taking orders until the new one
// is published; past orders, other businesses and a product the owner already made stay as they were.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import request from 'supertest';
import { setup, resetDatabase, signUp, ORIGIN } from './helpers.js';
import { seedLarose } from '../src/scripts/seed-larose.js';
import { clearOriginCache } from '../src/lib/origins.js';

const MIGRATION = readFileSync(new URL('../migrations/062_larose_new_pricing.sql', import.meta.url), 'utf8');
const PAGE = readFileSync(new URL('../src/import/larose-skincare.html', import.meta.url), 'utf8');
const NEW = { 'soap-500g': 20500, 'soap-500g-oil': 30500, 'soap-1l': 26500, 'soap-1l-oil': 36500, 'soap-2l': 44500, 'soap-2l-oil': 54500, 'facial-set': 17000 };
const { pool, app } = setup({});
let larose; let other; let oldOrder;
const order = (items, key) => request(app).post('/api/public/orders').set('Origin', ORIGIN).send({
  landingPage: 'larosenigeria', idempotencyKey: key,
  customer: { name: 'Pricing Check', phone: '08031112222', address: '5 Ring Road, Ibadan', state: 'Oyo' }, items,
});

before(async () => {
  await resetDatabase(pool);
  await signUp(app, { email: 'owner@larose.test' });
  larose = await seedLarose(pool, 'owner@larose.test');
  clearOriginCache();
  const { rows: [u] } = await pool.query("INSERT INTO users (email, password_hash, name) VALUES ('other@shop.test', 'x', 'Other') RETURNING id");
  other = (await pool.query("INSERT INTO businesses (owner_id, name, slug, currency) VALUES ($1, 'Other Shop', 'other-shop', 'NGN') RETURNING id", [u.id])).rows[0].id;
  await pool.query("INSERT INTO ad_profiles (business_id, prices, offer) VALUES ($1, 'old prices', 'old offer'), ($2, 'their prices', 'their offer')", [larose, other]);
  oldOrder = (await order([{ product: 'package-1', quantity: 1, unitPrice: 26500 }], 'larose-newprice-old-0001').expect(201)).body;
  await pool.query(MIGRATION);
  await pool.query(MIGRATION); // running again changes nothing
});
after(() => pool.end());

test('adds the seven products at the exact prices, on both Larose pages, once', async () => {
  const { rows } = await pool.query(
    `SELECT p.code, p.price_minor, p.active, array_agg(lp.slug ORDER BY lp.slug) AS pages FROM products p
       LEFT JOIN landing_page_products lpp ON lpp.product_id = p.id LEFT JOIN landing_pages lp ON lp.id = lpp.landing_page_id
      WHERE p.business_id = $1 AND p.code = ANY($2::text[]) GROUP BY p.code, p.price_minor, p.active`, [larose, Object.keys(NEW)]);
  assert.deepEqual(Object.fromEntries(rows.map((r) => [r.code, Number(r.price_minor) / 100])), NEW);
  assert.ok(rows.every((r) => r.active && r.pages.includes('larosenigeria')));
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM products WHERE business_id = $1', [other])).rows[0].n, 0);
});

test('the 500g at ₦20,500 and the Facial Set on its own are priced by Skyfly; delivery is not charged automatically', async () => {
  const a = await order([{ product: 'soap-500g', quantity: 1, unitPrice: 20500 }], 'larose-newprice-500g-0001').expect(201);
  assert.equal(a.body.total, 20500);
  const { rows: [o] } = await pool.query('SELECT total_minor, delivery_fee_minor FROM orders WHERE reference = $1', [a.body.reference]);
  assert.equal(Number(o.total_minor), 2050000); assert.equal(Number(o.delivery_fee_minor), 0);
  const f = await order([{ product: 'facial-set', quantity: 1, unitPrice: 17000 }], 'larose-newprice-face-0001').expect(201);
  assert.equal(f.body.total, 17000);
  assert.equal((await order([{ product: 'soap-500g', quantity: 1, unitPrice: 26500 }], 'larose-newprice-bad-0001').expect(409)).body.error, 'PRICE_CHANGED');
});

test('the page that is live now keeps working, and past orders keep their price', async () => {
  await order([{ product: 'package-1', quantity: 1, unitPrice: 26500 }], 'larose-newprice-old-0002').expect(201);
  const { rows: [o] } = await pool.query('SELECT total_minor FROM orders WHERE reference = $1', [oldOrder.reference]);
  assert.equal(Number(o.total_minor), 2650000);
});

test("the Media Buyer's prices and offer are updated for Larose only", async () => {
  const { rows } = await pool.query('SELECT business_id, prices, offer FROM ad_profiles ORDER BY business_id');
  const l = rows.find((r) => Number(r.business_id) === Number(larose)); const x = rows.find((r) => Number(r.business_id) === Number(other));
  assert.match(l.prices, /500g African Soap ₦20,500/); assert.match(l.offer, /₦3,000/);
  assert.equal(x.prices, 'their prices'); assert.equal(x.offer, 'their offer');
});

test('the Skyfly-hosted page sells exactly these products at these prices, 500g first and selected', () => {
  const opts = [...PAGE.matchAll(/<option value="[^"]+" data-product="([^"]+)" data-price="(\d+)"( selected)?>/g)];
  assert.deepEqual(Object.fromEntries(opts.map((m) => [m[1], Number(m[2])])), NEW);
  assert.equal(opts[0][1], 'soap-500g'); assert.equal(opts[0][3], ' selected');
  for (const old of ['₦58,000', '₦93,500', '₦202,000', 'package-1', 'today only', 'Promo ends']) assert.ok(!PAGE.includes(old), old);
  assert.match(PAGE, /an additional ₦3,000 delivery fee may apply/);
  // Purchase is still sent only after Skyfly has saved the order.
  assert.match(PAGE, /if\(res&&res\.ok&&data&&data\.ok&&data\.reference\)\{[\s\S]*?Skyfly\.trackPurchase\(data\)/);
});
