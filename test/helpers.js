import request from 'supertest';
import { createPool } from '../src/db.js';
import { migrate } from '../src/migrate.js';
import { createLoadControl } from '../src/services/load.js';
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
  const load = createLoadControl({ pool, config });
  return { pool, config, load, app: createApp({ pool, config, load }) };
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

// Adds a tracking ID (Tracking & Pixels) straight to the database, as the dashboard saves it.
// pages: landing page ids it tracks (allPages: every page of the business).
export async function addTrackingPixel(pool, businessId, {
  platform = 'meta', pixelId, name = null, enabled = true, allPages = true, pages = [],
  events = ['PageView', 'ViewContent', 'InitiateCheckout', 'Lead', 'Purchase'], settings = {},
  serverPurchase = false, tokenEnc = null, testCode = null, installMethod = 'id',
} = {}) {
  const { rows: [p] } = await pool.query(
    `INSERT INTO tracking_pixels (business_id, platform, name, pixel_id, enabled, all_pages, events, settings, server_purchase, access_token_enc, test_event_code, install_method)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
    [businessId, platform, name ?? `${platform} ${pixelId}`, pixelId, enabled, allPages, events, JSON.stringify(settings), serverPurchase, tokenEnc, testCode, installMethod]);
  for (const pageId of pages) await pool.query('INSERT INTO tracking_pixel_pages (tracking_pixel_id, landing_page_id) VALUES ($1, $2)', [p.id, pageId]);
  return p;
}
