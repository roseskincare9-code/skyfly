// Migration 028: the Facial Set as Larose's optional add-on (₦17,000, usual price ₦25,000).
// Created for Larose only, offered on its two pages unless they already have an add-on, and
// always priced by Skyfly (a changed price from the browser is refused).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import request from 'supertest';
import { setup, resetDatabase, signUp, ORIGIN } from './helpers.js';
import { seedLarose } from '../src/scripts/seed-larose.js';
import { clearOriginCache } from '../src/lib/origins.js';

const MIGRATION = readFileSync(new URL('../migrations/028_larose_facial_set.sql', import.meta.url), 'utf8');
const { pool, app } = setup({});
let larose; let n = 0;
const order = (items) => request(app).post('/api/public/orders').set('Origin', ORIGIN).send({
  landingPage: 'larosenigeria', idempotencyKey: `facial-set-${String(n += 1).padStart(6, '0')}`,
  customer: { name: 'Ada Obi', phone: '08031112222', email: 'ada@example.test', address: '12 Admiralty Way, Lekki' }, items,
});

before(async () => {
  await resetDatabase(pool);
  await signUp(app, { email: 'owner@larose.test' });
  larose = await seedLarose(pool, 'owner@larose.test');
  await pool.query("INSERT INTO landing_pages (business_id, slug, name, status) VALUES ($1, 'larose-skincare', 'Larose (Skyfly)', 'active')", [larose]);
  clearOriginCache();
});
after(() => pool.end());

test('creates the Facial Set for Larose and offers it on both Larose pages; running again changes nothing', async () => {
  await pool.query(MIGRATION);
  await pool.query(MIGRATION);
  const { rows: products } = await pool.query("SELECT business_id, name, price_minor, compare_at_price_minor, active FROM products WHERE code = 'facial-set'");
  assert.deepEqual(products.map((p) => [p.business_id, p.name, Number(p.price_minor), Number(p.compare_at_price_minor), p.active]), [[larose, 'Facial Set', 1700000, 2500000, true]]);
  const { rows: pages } = await pool.query("SELECT lp.slug, p.code FROM landing_pages lp JOIN products p ON p.id = lp.upsell_product_id WHERE lp.business_id = $1 ORDER BY lp.slug COLLATE \"C\"", [larose]);
  assert.deepEqual(pages.map((r) => [r.slug, r.code]), [['larose-skincare', 'facial-set'], ['larosenigeria', 'facial-set']]);
  const { rows: [linked] } = await pool.query("SELECT count(*)::int AS n FROM landing_page_products x JOIN products p ON p.id = x.product_id WHERE p.code = 'facial-set'");
  assert.equal(linked.n, 0, 'an add-on, not one of the packages');
});

test('an add-on the owner already chose is kept', async () => {
  const { rows: [p] } = await pool.query("INSERT INTO products (business_id, code, name, price_minor) VALUES ($1, 'toner', 'Toner', 800000) RETURNING id", [larose]);
  await pool.query("UPDATE landing_pages SET upsell_product_id = $2 WHERE business_id = $1 AND slug = 'larose-skincare'", [larose, p.id]);
  await pool.query(MIGRATION);
  const { rows: [r] } = await pool.query("SELECT upsell_product_id FROM landing_pages WHERE slug = 'larose-skincare'");
  assert.equal(String(r.upsell_product_id), String(p.id));
});

test('the page gets the add-on with its usual price; Skyfly prices it at ₦17,000 and refuses a different price', async () => {
  const cat = await request(app).get('/api/public/pages/larosenigeria/catalog').expect(200);
  assert.deepEqual([cat.body.upsell.code, cat.body.upsell.name, cat.body.upsell.price, cat.body.upsell.compareAt], ['facial-set', 'Facial Set', 17000, 25000]);
  const ok = await order([{ product: 'package-2', quantity: 1 }, { product: 'facial-set', quantity: 1, upsell: true, unitPrice: 17000 }]).expect(201);
  const pkg = Number((await pool.query("SELECT price_minor FROM products WHERE business_id = $1 AND code = 'package-2'", [larose])).rows[0].price_minor) / 100;
  assert.equal(ok.body.total, pkg + 17000);
  assert.deepEqual(ok.body.items.map((i) => [i.name, i.total, i.upsell]), [['Package 2 – Starter Glow Combo', pkg, false], ['Facial Set', 17000, true]]);
  assert.equal((await order([{ product: 'package-2', quantity: 1 }, { product: 'facial-set', quantity: 1, upsell: true, unitPrice: 1000 }]).expect(409)).body.error, 'PRICE_CHANGED');
  assert.equal((await order([{ product: 'facial-set', quantity: 1, upsell: true }]).expect(400)).body.error, 'VALIDATION', 'the add-on alone is not an order');
});
