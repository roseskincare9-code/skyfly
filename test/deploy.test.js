import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { setup, resetDatabase, csrfToken } from './helpers.js';
import { loadConfig } from '../src/config.js';

describe('Render configuration', () => {
  const saved = { ...process.env };
  after(() => { process.env = saved; });

  test('production uses the Render address when PUBLIC_BASE_URL is not set', () => {
    process.env = { ...saved, NODE_ENV: 'production', DATABASE_URL: 'postgres://x', SESSION_SECRET: 'x'.repeat(40), RENDER_EXTERNAL_HOSTNAME: 'skyfly-abc1.onrender.com' };
    delete process.env.PUBLIC_BASE_URL;
    const config = loadConfig();
    assert.equal(config.publicBaseUrl, 'https://skyfly-abc1.onrender.com');
    assert.equal(config.dashboardHost, 'skyfly-abc1.onrender.com');
    assert.equal(config.renderHost, 'skyfly-abc1.onrender.com');
  });

  test('an explicit PUBLIC_BASE_URL wins, and production still fails without any address', () => {
    process.env = { ...saved, NODE_ENV: 'production', DATABASE_URL: 'postgres://x', SESSION_SECRET: 'x'.repeat(40),
      RENDER_EXTERNAL_HOSTNAME: 'skyfly-abc1.onrender.com', PUBLIC_BASE_URL: 'https://app.example.com/' };
    assert.equal(loadConfig().publicBaseUrl, 'https://app.example.com');
    delete process.env.RENDER_EXTERNAL_HOSTNAME;
    delete process.env.PUBLIC_BASE_URL;
    assert.throws(() => loadConfig(), /PUBLIC_BASE_URL is required/);
  });

  test('Render-generated secrets (base64 of 32 bytes) are accepted as the encryption key', () => {
    process.env = { ...saved, NODE_ENV: 'production', DATABASE_URL: 'postgres://x', SESSION_SECRET: 'x'.repeat(40),
      RENDER_EXTERNAL_HOSTNAME: 'a.onrender.com', SKYFLY_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64') };
    assert.equal(loadConfig().encryptionKey.length, 32);
  });
});

describe('ALLOW_SIGNUP=first', () => {
  const { pool, app } = setup({ allowSignup: true, signupFirstOnly: true });
  before(() => resetDatabase(pool));
  after(() => pool.end());

  const signup = async (email) => {
    const agent = request.agent(app);
    const page = await agent.get('/signup');
    if (page.status !== 200) return page.status;
    const _csrf = page.text.match(/name="_csrf" value="([^"]+)"/)[1];
    return (await agent.post('/signup').type('form').send({ _csrf, name: 'X', email, password: 'a-long-password', confirm: 'a-long-password' })).status;
  };

  test('the first account can be created, and then sign-up closes by itself', async () => {
    const login = await request(app).get('/login');
    assert.match(login.text, /href="\/signup"/);
    assert.equal(await signup('owner@first.test'), 302);
    assert.equal(await signup('intruder@first.test'), 404);
    const after = await request(app).get('/login');
    assert.doesNotMatch(after.text, /href="\/signup"/);
  });

  test('a direct POST cannot bypass it', async () => {
    const agent = request.agent(app);
    const _csrf = await csrfToken(agent, '/login');
    await agent.post('/signup').type('form').send({ _csrf, name: 'X', email: 'sneaky@first.test', password: 'a-long-password' }).expect(404);
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM users');
    assert.equal(rows[0].n, 1);
  });
});
