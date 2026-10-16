import request from 'supertest';
import { createPool } from '../src/db.js';
import { migrate } from '../src/migrate.js';
import { createApp } from '../src/app.js';

// Tests run against a disposable local database named in .env.test (never production).
export function testDatabaseUrl() {
  const url = process.env.DATABASE_URL;
  if (!url || !/_test\b/.test(url)) {
    throw new Error('Tests require DATABASE_URL pointing at a *_test database (see .env.test)');
  }
  return url;
}

export const ORIGIN = 'https://roseskincare9-code.github.io';

export function makeConfig(overrides = {}) {
  const config = {
    isProduction: false,
    sessionSecret: 'test-secret',
    allowSignup: true,
    databaseUrl: testDatabaseUrl(),
    allowedOrigins: [ORIGIN],
    publicBaseUrl: 'http://skyfly.test',
    pagesBaseUrl: 'http://pages.test',
    orderRateLimit: 1000,
    ...overrides,
  };
  const hostOf = (u) => (u ? new URL(u).hostname : null);
  return { pagesHost: hostOf(config.pagesBaseUrl), dashboardHost: hostOf(config.publicBaseUrl), ...config };
}

export async function resetDatabase(pool) {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(pool);
}

export function setup(overrides) {
  const pool = createPool(testDatabaseUrl(), false);
  const config = makeConfig(overrides);
  return { pool, config, app: createApp({ pool, config }) };
}

// Lets accounts other than the platform owner create their own business (platform setting).
export async function openClientSignup(pool, trialDays = 7) {
  await pool.query("UPDATE platform_settings SET value = '\"open\"' WHERE key = 'client_signup'");
  await pool.query('UPDATE platform_settings SET value = $1 WHERE key = $2', [JSON.stringify(trialDays), 'trial_days']);
}

export async function csrfToken(agent, path = '/login') {
  const res = await agent.get(path);
  const match = res.text.match(/name="_csrf" value="([^"]+)"/);
  if (!match) throw new Error(`No CSRF token on ${path}`);
  return match[1];
}

export async function signUp(app, { name = 'Owner', email, password = 'correct-horse-battery' }) {
  const agent = request.agent(app);
  const _csrf = await csrfToken(agent, '/signup');
  const res = await agent.post('/signup').type('form').send({ _csrf, name, email, password });
  if (res.status !== 302) throw new Error(`Sign-up failed with ${res.status}`);
  return agent;
}
