// Browser check of the owner's 3-in-1 page installed by the packaged-page installer: on a phone and on a
// desktop, the page looks as supplied, its own order form (package picker + add-on) saves the order in ₦ in
// the page's business only, and the customer lands on Skyfly's confirmation page.
// Screenshots: test/e2e/screenshots/3in1.
//   node --env-file-if-exists=.env.test test/e2e/packaged-3in1.e2e.js
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, cpSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import { chromium, devices } from 'playwright-core';
import { createPool } from '../../src/db.js';
import { resetDatabase, testDatabaseUrl } from '../helpers.js';
import { installPackagedPage } from '../../src/services/packagedPages.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const shots = path.join(root, 'test/e2e/screenshots/3in1');
mkdirSync(shots, { recursive: true });
const DASH = 'http://localhost:3123';
const pool = createPool(testDatabaseUrl(), false);
await resetDatabase(pool);
const { rows: [u] } = await pool.query("INSERT INTO users (email, password_hash, name) VALUES ('owner@3in1.test', 'x', 'Owner') RETURNING id");
const { rows: [b] } = await pool.query("INSERT INTO businesses (owner_id, name, slug, currency) VALUES ($1, '3 in 1 Exfoliating package', '3-in-1-exfoliating-package-e71584', 'NGN') RETURNING id, slug", [u.id]);
await pool.query("INSERT INTO business_members (business_id, user_id, role) VALUES ($1, $2, 'owner')", [b.id, u.id]);
const { rows: [other] } = await pool.query("INSERT INTO businesses (owner_id, name, slug, currency) VALUES ($1, 'Larose Natural Skincare Nigeria', 'larose-nigeria', 'NGN') RETURNING id", [u.id]);
// The shipped package, retargeted at this test database's business (production targets #11).
const dir = mkdtempSync(path.join(tmpdir(), 'pkg-'));
cpSync(path.join(root, 'landing-pages/install/exfoliating-3-in-1-combo'), dir, { recursive: true });
const m = JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
m.business = { ...m.business, id: b.id, slug: b.slug };
writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(m));
const inst = await installPackagedPage(pool, { publicBaseUrl: DASH }, dir, { log: { log: () => {} } });
assert.equal(inst.status, 'published', JSON.stringify(inst));

const server = spawn('node', ['src/server.js'], {
  cwd: root,
  env: { ...process.env, PORT: '3123', NODE_ENV: 'development', DATABASE_URL: testDatabaseUrl(), SESSION_SECRET: 'e2e', ALLOW_SIGNUP: 'true', ALLOWED_ORIGINS: '', PUBLIC_BASE_URL: DASH, PAGES_BASE_URL: '', SKYFLY_ENCRYPTION_KEY: randomBytes(32).toString('base64') },
  stdio: ['ignore', 'ignore', 'inherit'],
});
for (let i = 0; i < 60; i += 1) { try { if ((await fetch(`${DASH}/healthz`)).ok) break; } catch { /* starting */ } await new Promise((r) => setTimeout(r, 250)); }

// This machine's Chromium when present (local runs); Playwright's own download otherwise.
const browser = await chromium.launch(existsSync('/opt/pw-browsers/chromium') ? { executablePath: '/opt/pw-browsers/chromium' } : {});
let failed = false;
const step = async (name, fn) => { try { await fn(); console.log(`  ✓ ${name}`); } catch (err) { failed = true; console.log(`  ✗ ${name}: ${String(err.message).split('\n')[0]}`); } };
const URL_ = `${DASH}/p/exfoliating-3-in-1-combo/`;
try {
  for (const [label, ctxOpts, pkg, addon, name] of [
    ['phone (iPhone 13)', devices['iPhone 13'], 'combo2', true, 'TEST ORDER Mobile Ada'],
    ['desktop (1366×900)', { viewport: { width: 1366, height: 900 } }, 'combo1', false, 'TEST ORDER Desktop Ada'],
  ]) {
    const ctx = await browser.newContext(ctxOpts);
    // No requests leave the machine (fonts etc.): the page must still work.
    await ctx.route(/^https?:\/\/(?!localhost)/, (route) => route.abort());
    const page = await ctx.newPage();
    const errors = []; page.on('pageerror', (e) => errors.push(e.message));
    await step(`${label}: the page loads as supplied (headline, ₦ prices, images)`, async () => {
      await page.goto(URL_);
      await page.waitForSelector('#priceGrid .pkg');
      const t = await page.textContent('body');
      assert.match(t, /Tried Everything and Nothing Works\?/);
      assert.match(t, /₦59,500/); assert.match(t, /₦109,000/); assert.match(t, /₦168,500/);
      const broken = await page.$$eval('img', (imgs) => imgs.filter((i) => i.loading !== 'lazy' && i.complete && i.naturalWidth === 0).map((i) => i.src));
      assert.deepEqual(broken, []);
      const hero = await page.$eval('#heroFrame img', (i) => i.naturalWidth);
      assert.ok(hero > 0, 'hero image loaded');
      await page.screenshot({ path: path.join(shots, `${label.split(' ')[0]}-top.png`) });
    });
    await step(`${label}: order with the page's own form (${pkg}${addon ? ' + Complete Facial Set' : ''})`, async () => {
      await page.click(`#pickList label[data-id="${pkg}"]`);
      if (addon) await page.check('#bumpChk');
      await page.fill('#fullName', name);
      await page.fill('#address', '12 Allen Avenue, Ikeja, Lagos');
      await page.fill('#phone', '08031234567');
      await page.locator('#orderForm').scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(shots, `${label.split(' ')[0]}-form.png`) });
      await Promise.all([page.waitForURL(/\/o\/[A-Z0-9-]+\?t=/, { timeout: 20000 }), page.click('#submitBtn')]);
      await page.waitForSelector('#ref');
      const ref = (await page.textContent('#ref')).trim();
      const { rows: [o] } = await pool.query('SELECT business_id, currency, total_minor, is_test FROM orders WHERE reference = $1', [ref]);
      const { rows: items } = await pool.query('SELECT product_code, is_upsell FROM order_items i JOIN orders o ON o.id = i.order_id WHERE o.reference = $1 ORDER BY i.id', [ref]);
      assert.equal(o.business_id, b.id, 'saved in the 3-in-1 business');
      assert.equal(o.currency, 'NGN');
      assert.equal(Number(o.total_minor), (pkg === 'combo2' ? 10900000 : 5950000) + (addon ? 2200000 : 0));
      assert.equal(o.is_test, true);
      assert.deepEqual(items.map((i) => i.product_code), addon ? [pkg, 'complete-facial-set'] : [pkg]);
      await page.screenshot({ path: path.join(shots, `${label.split(' ')[0]}-confirmation.png`), fullPage: true });
      console.log(`      order ${ref}: ₦${(Number(o.total_minor) / 100).toLocaleString('en-NG')}, business #${o.business_id}`);
    });
    if (errors.length) { failed = true; console.log(`  ✗ ${label}: page script errors: ${errors.join(' | ')}`); }
    await ctx.close();
  }
  await step('no order reached any other business', async () => {
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM orders WHERE business_id <> $1', [b.id])).rows[0].n, 0);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM orders WHERE business_id = $1', [other.id])).rows[0].n, 0);
  });
} finally {
  await browser.close(); server.kill(); await pool.end();
}
if (failed) process.exit(1);
console.log('3-in-1 page browser check passed.');
