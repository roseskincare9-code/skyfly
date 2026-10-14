import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { setup, resetDatabase, csrfToken, signUp } from './helpers.js';

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
  await agent.get('/').expect(200);
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
  let home = await agent.get('/').expect(200);
  assert.match(home.text, /Set up Larose Natural Skincare Nigeria/);
  const _csrf = home.text.match(/name="_csrf" value="([^"]+)"/)[1];
  const res = await agent.post('/setup/larose').type('form').send({ _csrf }).expect(302);
  const id = res.headers.location.match(/businesses\/(\d+)/)[1];
  const { rows: products } = await pool.query('SELECT code, price_minor FROM products WHERE business_id = $1 ORDER BY sort_order', [id]);
  assert.deepEqual(products.map((p) => p.price_minor / 100), [23500, 33000, 51500, 93500, 202000]);
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
  await other.post('/setup/larose').type('form').send({ _csrf: otherCsrf }).expect(409);
});
