import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createPool } from '../src/db.js';
import { migrate } from '../src/migrate.js';
import { createApp } from '../src/app.js';

// Runs against a disposable local database named in .env.test (never production).
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl || !/_test\b/.test(databaseUrl)) {
  throw new Error('Tests require DATABASE_URL pointing at a *_test database (see .env.test)');
}

const config = { isProduction: false, sessionSecret: 'test-secret', allowSignup: true, databaseUrl };
const pool = createPool(databaseUrl, false);
const app = createApp({ pool, config });

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(pool);
});

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
  const agent = request.agent(app);
  const signup = await agent
    .post('/signup')
    .type('form')
    .send({ name: 'Owner', email: 'owner@example.com', password: 'correct-horse-battery' });
  assert.equal(signup.status, 302);

  await agent.post('/businesses').type('form').send({ name: 'Rose Skincare' }).expect(302);
  const dashboard = await agent.get('/').expect(200);
  assert.match(dashboard.text, /Rose Skincare/);
  assert.match(dashboard.text, /rose-skincare/);

  await agent.post('/logout').expect(302);
  await agent.get('/').expect(302);

  await agent
    .post('/login')
    .type('form')
    .send({ email: 'owner@example.com', password: 'wrong-password' })
    .expect(401);
  await agent
    .post('/login')
    .type('form')
    .send({ email: 'owner@example.com', password: 'correct-horse-battery' })
    .expect(302);
  await agent.get('/').expect(200);
});

test('a user cannot view another user\'s business', async () => {
  const other = request.agent(app);
  await other
    .post('/signup')
    .type('form')
    .send({ name: 'Other', email: 'other@example.com', password: 'another-long-password' })
    .expect(302);
  const { rows } = await pool.query("SELECT id FROM businesses WHERE slug = 'rose-skincare'");
  await other.get(`/businesses/${rows[0].id}`).expect(404);
});
