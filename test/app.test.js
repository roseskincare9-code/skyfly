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
