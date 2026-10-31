import pg from 'pg';
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
  // Tests start from "by invitation only" (migration 041 opens public registration in production);
  // each test that needs open registration opens it itself.
  await pool.query("UPDATE platform_settings SET value = '\"invite_only\"' WHERE key = 'client_signup'");
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

export async function signUp(app, { name = 'Owner', email, password = 'correct-horse-battery', business = null }) {
  const agent = request.agent(app);
  const page = await agent.get('/signup');
  // Public sign-up creates a business too. Tests that want a plain account (no business yet) get one
  // made directly, then sign in as usual.
  if (page.status !== 200 && page.status !== 302) throw new Error(`Sign-up failed with ${page.status}`);
  if (page.status === 200 && /name="business_name"/.test(page.text) && !business) {
    const client = new pg.Client({ connectionString: testDatabaseUrl() });
    await client.connect();
    try {
      const { hashPassword } = await import('../src/lib/passwords.js');
      const { rowCount } = await client.query(
        'INSERT INTO users (email, password_hash, name, email_verified_at) VALUES ($1, $2, $3, now()) ON CONFLICT (email) DO NOTHING', [email, await hashPassword(password), name]);
      if (!rowCount) throw new Error('Sign-up failed with 409');
    } finally { await client.end(); }
    const _c = await csrfToken(agent, '/login');
    const login = await agent.post('/login').type('form').send({ _csrf: _c, email, password });
    if (login.status !== 302) throw new Error(`Sign-in failed with ${login.status}`);
    await adminSignIn(agent, { email, password }).catch(() => {});
    return agent;
  }
  const _csrf = page.text.match(/name="_csrf" value="([^"]+)"/)[1];
  const res = await agent.post('/signup').type('form').send({ _csrf, name, email, password, confirm: password, ...(business ? { business_name: business } : {}) });
  if (res.status !== 302) throw new Error(`Sign-up failed with ${res.status}`);
  // With an email sender configured the new account must confirm its email: tests stand in for the click.
  if (res.headers.location === '/verify-email') await confirmEmail(email);
  // The platform owner (the first account in tests) also signs in to Super Admin, as the owner does in
  // the browser before using platform administration. Business owners get "not found" here.
  await adminSignIn(agent, { email, password }).catch(() => {});
  return agent;
}

// Marks an account's email as confirmed (as the emailed confirmation link does).
export async function confirmEmail(email) {
  const client = new pg.Client({ connectionString: testDatabaseUrl() });
  await client.connect();
  try { await client.query('UPDATE users SET email_verified_at = now() WHERE email = $1', [email]); } finally { await client.end(); }
}

export async function adminSignIn(agent, { email, password = 'correct-horse-battery' }) {
  const page = await agent.get('/admin/login');
  if (page.status !== 200) return page;
  const _csrf = page.text.match(/name="_csrf" value="([^"]+)"/)[1];
  return agent.post('/admin/login').type('form').send({ _csrf, email, password, next: '/admin' });
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
