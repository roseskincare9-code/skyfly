// The live Larose page, also hosted on Skyfly (/p/larose-skincare/) in the Larose business:
// imported and published once at start-up; the GitHub Pages page record is never touched,
// and an existing page with that key is never overwritten.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { setup, resetDatabase, signUp } from './helpers.js';
import { seedLarose } from '../src/scripts/seed-larose.js';
import { ensureLaroseHostedPage } from '../src/services/setup.js';

const { pool, app, config } = setup();
let biz;
const quiet = { log() {} };
before(async () => {
  await resetDatabase(pool);
  await signUp(app, { email: 'owner@larose.test' });
  biz = await seedLarose(pool, 'owner@larose.test');
});
after(() => pool.end());

test('imported and published once in the Larose business; the GitHub Pages page is unchanged', async () => {
  const { rows: [before1] } = await pool.query("SELECT * FROM landing_pages WHERE slug = 'larosenigeria'");
  const id = await ensureLaroseHostedPage(pool, config, quiet);
  assert.ok(id);
  const { rows: [lp] } = await pool.query("SELECT * FROM landing_pages WHERE slug = 'larose-skincare'");
  assert.equal(String(lp.business_id), String(biz));
  assert.equal(lp.status, 'active');
  assert.ok(lp.published_version_id);
  assert.equal(lp.test_mode, false);
  const { rows: [{ n }] } = await pool.query('SELECT count(*)::int AS n FROM landing_page_products WHERE landing_page_id = $1', [lp.id]);
  assert.equal(n, 5, 'same 5 packages');
  const { rows: [after1] } = await pool.query("SELECT * FROM landing_pages WHERE slug = 'larosenigeria'");
  assert.deepEqual(after1, before1, 'the live page record is untouched');
  // Served publicly in the sandbox with the Larose pixel only and its own form key.
  const page = await request(app).get('/p/larose-skincare/').expect(200);
  assert.match(page.headers['content-security-policy'], /^sandbox /);
  assert.ok(page.text.includes('const SKYFLY_PAGE="larose-skincare";'));
  assert.ok(!page.text.includes('data-page="larosenigeria"'), 'no second SDK tag for the other page');
  assert.match(page.text, /window\.__SKYFLY__=.*"1357015185691765"/);
  assert.ok(!page.text.includes('1325736489534601'), 'not the Skyfly admin/test pixel');
  // A second start-up changes nothing.
  assert.equal(await ensureLaroseHostedPage(pool, config, quiet), null);
  const { rows: [{ c }] } = await pool.query("SELECT count(*)::int AS c FROM page_versions WHERE landing_page_id = $1", [lp.id]);
  assert.equal(c, 1);
});

test('a test order from the hosted page (Origin: null) is saved once in the Larose business', async () => {
  const body = { landingPage: 'larose-skincare', idempotencyKey: 'skyh-hostedtest-0001-x', customer: { name: 'TEST ORDER hosted', phone: '08031234567', address: '4 Allen Avenue, Ikeja', state: 'Lagos' },
    items: [{ product: 'package-3', quantity: 2, unitPrice: 51500 }] };
  const r = await request(app).post('/api/public/orders').set('Origin', 'null').send(body).expect(201);
  assert.equal(r.body.business, 'larose-nigeria');
  assert.equal(r.body.total, 103000);
  assert.equal(r.body.test, true);
  const again = await request(app).post('/api/public/orders').set('Origin', 'null').send(body).expect(200);
  assert.equal(again.body.reference, r.body.reference);
  // Another site cannot use this page's form key.
  await request(app).post('/api/public/orders').set('Origin', 'https://evil.example').send({ ...body, idempotencyKey: 'skyh-hostedtest-0002-x' }).expect(403);
});
