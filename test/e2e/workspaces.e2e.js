// End-to-end in a real browser (desktop and iPhone sizes): platform owner creates a client
// business and invites the client; the client joins, sees only their workspace, builds an
// email automation; the owner expires and renews the subscription. Screenshots of each screen.
//   node --env-file-if-exists=.env.test test/e2e/workspaces.e2e.js
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { chromium, devices } from 'playwright-core';
import { createPool } from '../../src/db.js';
import { seedLarose } from '../../src/scripts/seed-larose.js';
import { resetDatabase, testDatabaseUrl } from '../helpers.js';
import { superAdminSignIn } from './admin-signin.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const shots = path.join(root, 'test/e2e/screenshots/workspaces');
mkdirSync(shots, { recursive: true });
const DASH = 'http://localhost:3111';

const pool = createPool(testDatabaseUrl(), false);
await resetDatabase(pool);
const server = spawn('node', ['src/server.js'], {
  cwd: root,
  env: {
    ...process.env, PORT: '3111', NODE_ENV: 'development', DATABASE_URL: testDatabaseUrl(), SESSION_SECRET: 'e2e-secret-workspaces',
    ALLOW_SIGNUP: 'first', AUTO_SETUP_LAROSE: 'false', ALLOWED_ORIGINS: '', PUBLIC_BASE_URL: DASH,
    SKYFLY_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  },
  stdio: ['ignore', 'inherit', 'inherit'],
});
for (let i = 0; i < 50; i += 1) {
  try { if ((await fetch(`${DASH}/healthz`)).ok) break; } catch { /* starting */ }
  await new Promise((r) => setTimeout(r, 200));
}

const browser = await chromium.launch();
let failed = 0;
const step = async (name, fn) => {
  try { await fn(); console.log(`  ✓ ${name}`); } catch (err) { failed += 1; console.log(`  ✗ ${name}: ${err.message}`); }
};
// Opens a page in both sizes, checks it fits a phone screen, and saves screenshots.
async function both(ctxs, url, name) {
  for (const [size, ctx] of Object.entries(ctxs)) {
    const p = ctx.pages()[0];
    const res = await p.goto(url);
    assert.ok(res.status() < 400 || res.status() === 402, `${name} (${size}): HTTP ${res.status()}`);
    if (size === 'mobile') {
      const w = await p.evaluate(() => document.documentElement.scrollWidth);
      assert.ok(w <= 390, `${name}: no sideways scrolling on a phone (page is ${w}px wide)`);
    }
    await p.screenshot({ path: path.join(shots, `${name}-${size}.png`), fullPage: true });
  }
}
async function login(ctx, email, password) {
  const p = ctx.pages()[0] ?? await ctx.newPage();
  await p.goto(`${DASH}/login`);
  await p.fill('#email', email);
  await p.fill('#password', password);
  await p.click('button[type=submit]');
  await p.waitForLoadState('load');
  return p;
}

try {
  const owner = { desktop: await browser.newContext({ viewport: { width: 1280, height: 860 } }), mobile: await browser.newContext({ ...devices['iPhone 13'] }) };
  const client = { desktop: await browser.newContext({ viewport: { width: 1280, height: 860 } }), mobile: await browser.newContext({ ...devices['iPhone 13'] }) };
  let invite;
  let bizId;

  await step('the first account becomes the platform owner (Larose kept as an internal business)', async () => {
    const p = await owner.desktop.newPage();
    await p.goto(`${DASH}/signup`);
    await p.fill('#name', 'Platform Owner');
    await p.fill('#email', 'owner@skyfly.test');
    await p.fill('#password', 'owner-password-123');
    await p.click('button[type=submit]');
    await p.waitForLoadState('load');
    await seedLarose(pool, 'owner@skyfly.test');
    await login(owner.mobile, 'owner@skyfly.test', 'owner-password-123');
    await superAdminSignIn(p, DASH, 'owner@skyfly.test', 'owner-password-123');
    await superAdminSignIn(owner.mobile.pages()[0], DASH, 'owner@skyfly.test', 'owner-password-123');
    await p.goto(`${DASH}/admin`);
    assert.match(await p.textContent('main'), /Larose Natural Skincare Nigeria[\s\S]*Internal/);
  });

  await step('platform owner creates a client business with a subscription and gets an invitation link', async () => {
    const p = owner.desktop.pages()[0];
    await p.goto(`${DASH}/admin/businesses/new`);
    await p.fill('#name', 'Glow Test Shop');
    await p.fill('#owner_email', 'client@glow.test');
    await p.fill('#price', '15000');
    const today = (await pool.query("SELECT (now() AT TIME ZONE 'Africa/Lagos')::date::text AS d")).rows[0].d;
    await p.fill('#started_on', today);
    await p.fill('#expires_on', new Date(Date.parse(`${today}T00:00:00Z`) + 30 * 864e5).toISOString().slice(0, 10));
    await p.click('main button[type=submit]');
    invite = (await p.textContent('main')).match(/http:\/\/localhost:3111\/invite\/[A-Za-z0-9_-]+/)[0];
    bizId = (await pool.query("SELECT id FROM businesses WHERE name = 'Glow Test Shop'")).rows[0].id;
  });

  await step('the client joins with the link and lands in their own dashboard only', async () => {
    const p = await client.desktop.newPage();
    await p.goto(invite);
    await p.fill('#name', 'Glow Client');
    await p.fill('#password', 'client-password-123');
    await p.click('main button[type=submit]');
    await p.waitForURL(`${DASH}/businesses/${bizId}`);
    const nav = await p.textContent('nav.side-nav');
    for (const s of ['Overview', 'Orders', 'Products', 'Customers', 'Landing Pages', 'Email Contacts', 'Email Automations', 'Tracking & Pixels', 'Integrations', 'Subscription', 'Settings']) assert.ok(nav.includes(s), s);
    assert.ok(!nav.includes('Platform admin'));
    const larose = (await pool.query("SELECT id FROM businesses WHERE slug = 'larose-nigeria'")).rows[0].id;
    const other = await p.goto(`${DASH}/businesses/${larose}/orders`);
    assert.equal(other.status(), 404, 'Larose is not visible to the client');
    await login(client.mobile, 'client@glow.test', 'client-password-123');
  });

  await step('client builds an email automation (shows the sending-setup requirement first)', async () => {
    const p = client.desktop.pages()[0];
    await p.goto(`${DASH}/businesses/${bizId}/email`);
    assert.match(await p.textContent('main'), /Email sending is not set up yet/);
    await p.check('input[value=processing]');
    await p.click('text=Create as draft');
    await p.waitForURL(/automations\/\d+/);
    assert.match(await p.textContent('main'), /Day 1 at 10:00[\s\S]*Day 2[\s\S]*Day 3/);
  });

  await step('screens fit desktop and phone: owner dashboard, subscription controls, client dashboard, automation builder', async () => {
    const auto = (await pool.query('SELECT id FROM email_automations WHERE business_id = $1', [bizId])).rows[0].id;
    const tpl = (await pool.query('SELECT id FROM email_templates WHERE business_id = $1 ORDER BY id LIMIT 1', [bizId])).rows[0].id;
    await both(owner, `${DASH}/admin`, '01-owner-dashboard');
    await both(owner, `${DASH}/admin/businesses/${bizId}`, '02-subscription-controls');
    await both(client, `${DASH}/businesses/${bizId}`, '03-client-dashboard');
    await both(client, `${DASH}/businesses/${bizId}/email`, '04-email-automations');
    await both(client, `${DASH}/businesses/${bizId}/email/automations/${auto}`, '05-automation-builder');
    await both(client, `${DASH}/businesses/${bizId}/email/templates/${tpl}`, '06-template-editor');
    await both(client, `${DASH}/businesses/${bizId}/email-contacts`, '07-email-contacts');
    await both(client, `${DASH}/businesses/${bizId}/subscription`, '08-client-subscription');
  });

  await step('expired subscription locks the client out (data kept); renewal by the owner restores access', async () => {
    await pool.query("UPDATE businesses SET subscription_expires_on = (now() AT TIME ZONE timezone)::date - 1 WHERE id = $1", [bizId]);
    const p = client.desktop.pages()[0];
    const res = await p.goto(`${DASH}/businesses/${bizId}/orders`);
    assert.equal(res.status(), 402);
    assert.match(await p.textContent('main'), /Subscription expired[\s\S]*Nothing has been deleted/);
    await both(client, `${DASH}/businesses/${bizId}/orders`, '09-client-locked');
    const o = owner.desktop.pages()[0];
    await o.goto(`${DASH}/admin/businesses/${bizId}`);
    await o.fill('#reference', 'TEST renewal');
    await o.click('button:text-is("Renew")');
    await o.waitForURL(/done=renewed/);
    const again = await p.goto(`${DASH}/businesses/${bizId}/orders`);
    assert.equal(again.status(), 200);
  });
} finally {
  await browser.close();
  server.kill();
  await pool.end();
}
console.log(failed ? `\n${failed} step(s) failed` : `\nAll steps passed. Screenshots: ${shots}`);
process.exit(failed ? 1 : 0);
