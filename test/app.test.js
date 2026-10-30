import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { setup, resetDatabase, csrfToken, signUp, makeConfig, adminSignIn } from './helpers.js';

const { pool, app } = setup();

before(() => resetDatabase(pool));
after(() => pool.end());

test('health check reports database ok', async () => {
  const res = await request(app).get('/healthz');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { status: 'ok' });
});

test('dashboard redirects to login when signed out', async () => {
  const res = await request(app).get('/');
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/login');
});

test('owner can sign up, create a business, log out and log back in', async () => {
  const agent = await signUp(app, { email: 'owner@example.com' });

  let _csrf = await csrfToken(agent, '/');
  await agent.post('/businesses').type('form').send({ _csrf, name: 'Rose Skincare' }).expect(302);
  const dashboard = await agent.get('/').expect(200);
  assert.match(dashboard.text, /Rose Skincare/);

  _csrf = await csrfToken(agent, '/');
  await agent.post('/logout').type('form').send({ _csrf }).expect(302);
  await agent.get('/').expect(302);

  _csrf = await csrfToken(agent, '/login');
  await agent.post('/login').type('form').send({ _csrf, email: 'owner@example.com', password: 'wrong-password' }).expect(401);
  await agent.post('/login').type('form').send({ _csrf, email: 'owner@example.com', password: 'correct-horse-battery' }).expect(302);
  // A normal sign-in opens the owner's own business; platform administration needs the Super Admin sign-in.
  const home = await agent.get('/').expect(302);
  assert.match(home.headers.location, /^\/businesses\/\d+$/);
  assert.equal((await agent.get('/admin')).headers.location, '/admin/login?next=%2Fadmin');
});

test('a user cannot view another user\'s business', async () => {
  const other = await signUp(app, { name: 'Other', email: 'other@example.com', password: 'another-long-password' });
  const { rows } = await pool.query("SELECT id FROM businesses WHERE slug = 'rose-skincare'");
  await other.get(`/businesses/${rows[0].id}`).expect(404);
  await other.get(`/businesses/${rows[0].id}/orders`).expect(404);
  await other.get(`/businesses/${rows[0].id}/orders/export.csv`).expect(404);
});

test('POST without a CSRF token is rejected', async () => {
  const agent = await signUp(app, { name: 'Third', email: 'third@example.com' });
  await agent.post('/businesses').type('form').send({ name: 'Sneaky' }).expect(403);
});

test('one-click Larose setup creates the business, packages and landing page once', async () => {
  const agent = await signUp(app, { name: 'Larose Owner', email: 'larose-owner@example.com' });
  // The Larose setup is offered to the platform owner.
  await pool.query("UPDATE users SET is_platform_admin = true WHERE email = 'larose-owner@example.com'");
  await adminSignIn(agent, { email: 'larose-owner@example.com' });
  let home = await agent.get('/').expect(200);
  assert.match(home.text, /Set up Larose Natural Skincare Nigeria/);
  const _csrf = home.text.match(/name="_csrf" value="([^"]+)"/)[1];
  const res = await agent.post('/setup/larose').type('form').send({ _csrf }).expect(302);
  const id = res.headers.location.match(/businesses\/(\d+)/)[1];
  const { rows: products } = await pool.query('SELECT code, price_minor FROM products WHERE business_id = $1 ORDER BY sort_order', [id]);
  assert.deepEqual(products.map((p) => p.price_minor / 100), [26500, 36500, 58000, 93500, 202000]);
  const { rows: [lp] } = await pool.query("SELECT status, url FROM landing_pages WHERE slug = 'larosenigeria'");
  assert.equal(lp.status, 'active');
  assert.equal(lp.url, 'https://roseskincare9-code.github.io/Larosenigeria/');
  const { rows: [biz] } = await pool.query('SELECT whatsapp_number FROM businesses WHERE id = $1', [id]);
  assert.equal(biz.whatsapp_number, '+2349049206695');
  home = await agent.get('/').expect(200);
  assert.doesNotMatch(home.text, /Set up Larose Natural Skincare Nigeria/, 'offer disappears once done');
  // Another account cannot take it over.
  const other = await signUp(app, { name: 'Other', email: 'not-larose@example.com' });
  const otherCsrf = await csrfToken(other, '/');
  await other.post('/setup/larose').type('form').send({ _csrf: otherCsrf }).expect(404);
});

test('health check shows the background jobs\' last runs (times and counts only)', async () => {
  const { createApp } = await import('../src/app.js');
  const workers = { email: { lastRunAt: '2026-10-17T10:00:00.000Z', lastOkAt: '2026-10-17T10:00:00.000Z', lastError: null, last: { planned: 0, cancelled: 0, sent: 0 } }, sheets: null, startedAt: '2026-10-17T09:59:00.000Z' };
  const res = await request(createApp({ pool, config: makeConfig(), workers })).get('/healthz').expect(200);
  assert.deepEqual(res.body, { status: 'ok', workers });
});
