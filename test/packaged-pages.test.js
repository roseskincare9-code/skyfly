// Packaged owner pages (landing-pages/install/*): installed into exactly the manifest's business (ID AND
// address name must match), original file kept as version 1, connection markers only in version 2,
// products added (never changed), published, never re-installed over an existing page; orders from it
// land in that business only.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, cpSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { setup, resetDatabase } from './helpers.js';
import { installPackagedPage, applyConnect } from '../src/services/packagedPages.js';

const SRC = path.resolve('landing-pages/install/exfoliating-3-in-1-combo');
const { pool, app } = setup({ allowedOrigins: [] });
const quiet = { log: () => {}, error: () => {} };
let target; let other; let dir;

function packageFor(business, extra = {}) {
  const d = mkdtempSync(path.join(tmpdir(), 'pkg-'));
  cpSync(SRC, d, { recursive: true });
  const m = JSON.parse(readFileSync(path.join(d, 'manifest.json'), 'utf8'));
  m.business = { ...m.business, id: business.id, slug: business.slug };
  Object.assign(m.page, extra);
  writeFileSync(path.join(d, 'manifest.json'), JSON.stringify(m));
  return d;
}

before(async () => {
  await resetDatabase(pool);
  const { rows: [u] } = await pool.query("INSERT INTO users (email, password_hash, name) VALUES ('owner@3in1.test', 'x', 'Owner') RETURNING id");
  ({ rows: [target] } = await pool.query("INSERT INTO businesses (owner_id, name, slug, currency) VALUES ($1, '3 in 1 Exfoliating package', '3-in-1-exfoliating-package-e71584', 'USD') RETURNING id, slug", [u.id]));
  await pool.query("INSERT INTO business_members (business_id, user_id, role) VALUES ($1, $2, 'owner')", [target.id, u.id]);
  const { rows: [u2] } = await pool.query("INSERT INTO users (email, password_hash, name) VALUES ('owner@larose.test', 'x', 'Larose') RETURNING id");
  ({ rows: [other] } = await pool.query("INSERT INTO businesses (owner_id, name, slug, currency) VALUES ($1, 'Larose Natural Skincare Nigeria', 'larose-nigeria', 'NGN') RETURNING id, slug", [u2.id]));
  await pool.query("INSERT INTO business_members (business_id, user_id, role) VALUES ($1, $2, 'owner')", [other.id, u2.id]);
  dir = packageFor(target);
});
after(() => pool.end());

test('the shipped manifest targets business #11 "3-in-1-exfoliating-package-e71584" only, in NGN', () => {
  const m = JSON.parse(readFileSync(path.join(SRC, 'manifest.json'), 'utf8'));
  assert.deepEqual([m.business.id, m.business.slug, m.business.currency], [11, '3-in-1-exfoliating-package-e71584', 'NGN']);
  // Every connection step applies exactly once to the original page; nothing else changes.
  const original = readFileSync(path.join(SRC, 'index.html'), 'utf8');
  const connected = applyConnect(original, m.connect);
  const strip = (s) => s.replace(/\n\s*<select id="skyProduct"[\s\S]*?<\/select>/, '').replace(/\n.*Skyfly: the chosen package's product code/, '').replace(/ data-skyfly-[a-z-]+(="[^"]*")?/g, '');
  assert.equal(strip(connected), original);
});

test('wrong business (ID or address name) → nothing installed', async () => {
  const d = packageFor({ id: other.id, slug: '3-in-1-exfoliating-package-e71584' });
  assert.equal((await installPackagedPage(pool, app.locals?.config ?? { publicBaseUrl: 'http://skyfly.test' }, d, { log: quiet })).status, 'skipped_business');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM landing_pages')).rows[0].n, 0);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM products')).rows[0].n, 0);
});

test('installs into the target business: products, original + connected versions, published; NGN', async () => {
  const r = await installPackagedPage(pool, { publicBaseUrl: 'http://skyfly.test' }, dir, { log: quiet });
  assert.equal(r.status, 'published', JSON.stringify(r));
  assert.equal(r.url, 'http://skyfly.test/p/exfoliating-3-in-1-combo/');
  const { rows: [page] } = await pool.query('SELECT * FROM landing_pages WHERE id = $1', [r.pageId]);
  assert.equal(page.business_id, target.id);
  assert.equal(page.status, 'active');
  assert.equal(Number(page.published_version_id), r.versions[1]);
  const { rows: products } = await pool.query('SELECT business_id, code, price_minor FROM products ORDER BY sort_order');
  assert.deepEqual(products.map((p) => `${p.business_id}:${p.code}:${p.price_minor}`), [`${target.id}:combo1:5950000`, `${target.id}:combo2:10900000`, `${target.id}:combo3:16850000`, `${target.id}:complete-facial-set:2200000`]);
  assert.equal((await pool.query('SELECT currency FROM businesses WHERE id = $1', [target.id])).rows[0].currency, 'NGN');
  // Version 1 keeps the original index.html byte for byte; 13 files each.
  const { rows: files } = await pool.query("SELECT v.id, f.path, f.sha256 FROM page_versions v JOIN page_files f ON f.version_id = v.id WHERE v.landing_page_id = $1 ORDER BY v.id, f.path", [r.pageId]);
  const orig = files.find((f) => f.id === r.versions[0] && f.path === 'index.html');
  assert.equal(orig.sha256, '34bbddaef36eaabe6b5a1b277835e9857b22b4a7976f0aff01cdf18b23c44d85');
  assert.equal(files.filter((f) => f.id === r.versions[0]).length, 13);
  assert.equal(files.filter((f) => f.id === r.versions[1]).length, 13);
  // Nothing in the other business.
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM products WHERE business_id = $1', [other.id])).rows[0].n, 0);
});

test('the published page serves the original design with Skyfly connected; its images load', async () => {
  const res = await request(app).get('/p/exfoliating-3-in-1-combo/').expect(200);
  assert.match(res.text, /Tried Everything and Nothing Works\?/);
  assert.match(res.text, /data-skyfly-form data-skyfly-exclusive/);
  assert.match(res.text, /sdk\/skyfly\.js/);
  const img = await request(app).get('/p/exfoliating-3-in-1-combo/images/combo-hero.webp');
  assert.equal(img.status, 200);
  assert.match(img.headers['content-type'], /image\/webp/);
});

test('an order from the page (package 2 + the add-on) is priced by Skyfly in ₦ and saved in this business only', async () => {
  const r = await request(app).post('/api/public/orders').set('Origin', 'null').send({
    landingPage: 'exfoliating-3-in-1-combo', idempotencyKey: 'pkg-test-order-000000001',
    customer: { name: 'TEST ORDER Ada', phone: '08031234567', address: '12 Allen Avenue, Ikeja, Lagos' },
    items: [{ product: 'combo2', quantity: 1 }, { product: 'complete-facial-set', quantity: 1, upsell: true }],
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.currency, 'NGN');
  assert.equal(r.body.total, 131000);
  const { rows: [o] } = await pool.query('SELECT business_id, is_test FROM orders WHERE reference = $1', [r.body.reference]);
  assert.deepEqual([o.business_id, o.is_test], [target.id, true]);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM orders WHERE business_id = $1', [other.id])).rows[0].n, 0);
});

test('never installed twice: a second start-up changes nothing', async () => {
  const before = (await pool.query('SELECT count(*)::int AS n FROM page_versions')).rows[0].n;
  assert.equal((await installPackagedPage(pool, { publicBaseUrl: 'http://skyfly.test' }, dir, { log: quiet })).status, 'exists');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM page_versions')).rows[0].n, before);
});
