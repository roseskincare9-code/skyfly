// End-to-end test: the real (patched) Larose landing page served from a different
// origin submits to a running Skyfly server, in mobile Chromium.
//
//   npm run test:e2e
// Requires a local *_test database in .env.test. Screenshots go to test/e2e/screenshots/.
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { chromium, devices } from 'playwright-core';
import { createPool } from '../../src/db.js';
import { seedLarose } from '../../src/scripts/seed-larose.js';
import { resetDatabase, testDatabaseUrl } from '../helpers.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const shots = path.join(root, 'test/e2e/screenshots');
mkdirSync(shots, { recursive: true });
const SKYFLY = 'http://localhost:3100';
const LANDING_ORIGIN = 'http://127.0.0.1:3200';
const landingSource = process.env.LANDING_SOURCE;
if (!landingSource) throw new Error('Set LANDING_SOURCE to the original Larosenigeria index.html');

const pool = createPool(testDatabaseUrl(), false);
await resetDatabase(pool);

// Build the patched landing page pointing at this Skyfly instance.
const patched = path.join(root, 'test/e2e/.landing.html');
execFileSync('python3', [path.join(root, 'integrations/larosenigeria/patch.py'), landingSource, patched, SKYFLY]);
const patchedHtml = readFileSync(patched, 'utf8');
assert.ok(!patchedHtml.includes('7039361243'), 'old WhatsApp number must not remain on the page');
assert.equal((patchedHtml.match(/wa\.me\/2349049206695/g) || []).length, 5, 'all 5 WhatsApp links use the new number');
const landing = createServer((req, res) => {
  if (req.url.startsWith('/Larosenigeria/')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(readFileSync(patched));
  }
  res.writeHead(404).end();
}).listen(3200);

const server = spawn('node', ['src/server.js'], {
  cwd: root,
  env: {
    ...process.env, PORT: '3100', NODE_ENV: 'development', DATABASE_URL: testDatabaseUrl(), SESSION_SECRET: 'e2e-secret',
    ALLOW_SIGNUP: 'true', ALLOWED_ORIGINS: LANDING_ORIGIN, PUBLIC_BASE_URL: SKYFLY,
  },
  stdio: ['ignore', 'inherit', 'inherit'],
});
for (let i = 0; i < 50; i += 1) {
  try { if ((await fetch(`${SKYFLY}/healthz`)).ok) break; } catch { /* starting */ }
  await new Promise((r) => setTimeout(r, 200));
}

const browser = await chromium.launch();
const results = [];
const step = async (name, fn) => {
  await fn();
  results.push(name);
  console.log(`  ✓ ${name}`);
};

try {
  const context = await browser.newContext({ ...devices['iPhone 13'] });
  // Third-party assets (fonts, pixel, images) are not needed for the test.
  await context.route(/^https?:\/\/(?!localhost|127\.0\.0\.1)/, (route) => route.abort());
  // Stand-in for SheetDB: records each row the page sends. sheetDown simulates an outage.
  const sheetRows = [];
  let sheetDown = false;
  await context.route('https://sheetdb.io/**', (route) => {
    if (sheetDown) return route.abort('connectionrefused');
    sheetRows.push(JSON.parse(route.request().postData()).data);
    return route.fulfill({ status: 201, contentType: 'application/json', body: '{"created":1}' });
  });
  const page = await context.newPage();

  await step('admin pages redirect to login when signed out', async () => {
    await page.goto(`${SKYFLY}/businesses/1/orders`);
    assert.equal(new URL(page.url()).pathname, '/login');
  });

  await step('owner signs up and the Larose business is seeded', async () => {
    await page.goto(`${SKYFLY}/signup`);
    await page.fill('#name', 'Rose Owner');
    await page.fill('#email', 'owner@larose.test');
    await page.fill('#password', 'a-very-long-password');
    await page.click('button[type=submit]');
    await page.waitForURL(`${SKYFLY}/`);
    await seedLarose(pool, 'owner@larose.test');
  });

  const shop = await context.newPage();
  const fillForm = async () => {
    await shop.goto(`${LANDING_ORIGIN}/Larosenigeria/?utm_source=facebook&utm_campaign=e2e-oct`);
    await shop.click('text=Order Power Glow');
    assert.equal(await shop.inputValue('#pr'), 'Package 3 – Power Glow – ₦51,500');
    await shop.fill('#fn', 'Ngozi Adeyemi');
    await shop.fill('#addr', '14 Admiralty Way, Lekki Phase 1');
    await shop.fill('#ph', '08051234567');
    await shop.fill('#em', 'ngozi@example.com');
    await shop.selectOption('#st', 'Lagos');
    await shop.selectOption('#qty', '2');
    await shop.fill('#nt', 'Gate is blue');
    const summary = await shop.textContent('#skySum');
    assert.match(summary, /Package 3 – Power Glow × 2/);
    assert.match(summary, /Total: ₦103,000 · pay on delivery/);
  };

  await step('empty form shows a helpful error without calling the API', async () => {
    await shop.goto(`${LANDING_ORIGIN}/Larosenigeria/`);
    await shop.click('#sb');
    await shop.waitForSelector('#skyErr', { state: 'visible' });
    assert.match(await shop.textContent('#skyErr'), /Please fill in all required fields/);
    await shop.screenshot({ path: path.join(shots, '1-landing-validation-error.png') });
  });

  await step('server-side validation error: shown to the customer, nothing sent anywhere', async () => {
    await fillForm();
    await shop.fill('#ph', '123');
    await shop.click('#sb');
    await shop.waitForSelector('#skyErr', { state: 'visible' });
    assert.match(await shop.textContent('#skyErr'), /valid phone number/);
    assert.equal(await shop.inputValue('#fn'), 'Ngozi Adeyemi');
    assert.equal(sheetRows.length, 0);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM orders')).rows[0].n, 0);
  });

  await step('Skyfly unreachable: order falls back to the Google Sheet (not lost), original success box shown', async () => {
    await fillForm();
    await shop.route(`${SKYFLY}/api/public/orders`, (route) => route.abort('connectionrefused'));
    await shop.click('#sb');
    await shop.waitForSelector('#sb2', { state: 'visible' });
    assert.equal(sheetRows.length, 1);
    assert.match(sheetRows[0].source, /NOT IN SKYFLY \(unreachable\)/);
    assert.equal(sheetRows[0].fullName, 'Ngozi Adeyemi');
    assert.match(sheetRows[0].package, /Power Glow.* x2$/);
    assert.equal(sheetRows[0].address, '14 Admiralty Way, Lekki Phase 1, Lagos');
    assert.match(await shop.getAttribute('#waFinal', 'href'), /^https:\/\/wa\.me\/2349049206695\?text=/);
    await shop.screenshot({ path: path.join(shots, '2-landing-fallback-to-sheet.png') });
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM orders')).rows[0].n, 0);
    sheetRows.length = 0;
  });

  await step('Skyfly and the Sheet both down: error shown, details kept, retry possible', async () => {
    await fillForm();
    sheetDown = true;
    await shop.click('#sb');
    await shop.waitForSelector('#skyErr', { state: 'visible' });
    assert.match(await shop.textContent('#skyErr'), /couldn't reach our order system/);
    assert.equal(await shop.inputValue('#ph'), '08051234567');
    assert.equal(await shop.isEnabled('#sb'), true);
    sheetDown = false;
  });

  let reference;
  await step('retry with repeated clicks saves exactly one order and redirects', async () => {
    await shop.unroute(`${SKYFLY}/api/public/orders`);
    // Slow the API slightly so the extra clicks land while the first request is in flight.
    let calls = 0;
    await shop.route(`${SKYFLY}/api/public/orders`, async (route) => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 400));
      await route.continue();
    });
    await shop.click('#sb');
    await shop.click('#sb', { force: true, noWaitAfter: true }).catch(() => {});
    await shop.click('#sb', { force: true, noWaitAfter: true }).catch(() => {});
    await shop.waitForURL(/\/o\/LR-/);
    assert.equal(calls, 1, 'only one request should be sent');
    reference = new URL(shop.url()).pathname.split('/').pop();
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM orders');
    assert.equal(rows[0].n, 1);
    // Saved orders are copied to the Google Sheet by Skyfly's server (with retries), not by the page.
    assert.equal(sheetRows.length, 0);
    const { rows: [o] } = await pool.query('SELECT sheet_sync_status FROM orders WHERE reference = $1', [reference]);
    assert.equal(o.sheet_sync_status, 'pending', 'queued for the server-side Google Sheet copy');
  });

  await step('the saved order has trusted product, quantity, price and attribution', async () => {
    const { rows: [o] } = await pool.query('SELECT * FROM orders WHERE reference = $1', [reference]);
    const { rows: items } = await pool.query('SELECT * FROM order_items WHERE order_id = $1', [o.id]);
    assert.equal(o.customer_name, 'Ngozi Adeyemi');
    assert.equal(o.phone, '+2348051234567');
    assert.equal(o.state, 'Lagos');
    assert.equal(o.customer_notes, 'Gate is blue');
    assert.equal(o.total_minor, 10300000);
    assert.equal(o.utm_source, 'facebook');
    assert.equal(o.utm_campaign, 'e2e-oct');
    assert.match(o.source_url, /^http:\/\/127\.0\.0\.1:3200\/Larosenigeria\//);
    assert.deepEqual(items.map((i) => [i.product_code, i.quantity, i.unit_price_minor]), [['package-3', 2, 5150000]]);
  });

  await step('confirmation page shows reference, items, total and WhatsApp link', async () => {
    assert.equal(await shop.textContent('#ref'), reference);
    assert.match(await shop.textContent('body'), /Package 3 – Power Glow\s*× 2/);
    assert.equal((await shop.textContent('#total')).trim(), '₦103,000');
    const wa = new URL(await shop.getAttribute('#wa', 'href'));
    assert.equal(wa.host, 'wa.me');
    assert.equal(wa.pathname, '/2349049206695');
    assert.match(wa.searchParams.get('text'), new RegExp(`order ${reference}`));
    const width = await shop.evaluate(() => document.documentElement.scrollWidth);
    assert.ok(width <= 390, `no horizontal scroll on mobile (got ${width})`);
    await shop.screenshot({ path: path.join(shots, '3-confirmation-mobile.png'), fullPage: true });
  });

  await step('going back and submitting again does not duplicate the order', async () => {
    await shop.goBack();
    await shop.waitForSelector('#sb');
    // Browsers may restore the form; refill to be sure, then resubmit identical details.
    await fillForm();
    await shop.click('#sb');
    await shop.waitForURL(/\/o\/LR-/);
    assert.equal(new URL(shop.url()).pathname.split('/').pop(), reference);
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM orders');
    assert.equal(rows[0].n, 1);
    assert.equal(sheetRows.length, 0);
  });

  await step('reply lost after saving: the retry returns the same order, no fallback, no duplicate', async () => {
    await shop.goto(`${LANDING_ORIGIN}/Larosenigeria/`);
    await shop.click('text=Order Starter Glow Soap');
    await shop.fill('#fn', 'Lost Reply'); await shop.fill('#addr', '9 Retry Close, Yaba'); await shop.fill('#ph', '08099990000');
    await shop.selectOption('#st', 'Lagos');
    const before = sheetRows.length;
    let calls = 0;
    await shop.route(`${SKYFLY}/api/public/orders`, async (route) => {
      calls += 1;
      if (calls === 1) { await route.fetch(); return route.abort('connectionreset'); } // saved, but the reply never arrives
      return route.continue();
    });
    await shop.click('#sb');
    await shop.waitForURL(/\/o\/LR-/);
    await shop.unroute(`${SKYFLY}/api/public/orders`);
    assert.equal(calls, 2);
    const { rows } = await pool.query("SELECT count(*)::int AS n FROM orders WHERE customer_name = 'Lost Reply'");
    assert.equal(rows[0].n, 1, 'exactly one order');
    assert.equal(sheetRows.length, before, 'no fallback row: the order was saved in Skyfly');
    await pool.query("DELETE FROM orders WHERE customer_name = 'Lost Reply'");
    sheetRows.splice(before);
    await shop.goto(`${LANDING_ORIGIN}/Larosenigeria/`);
  });

  await step('the new order is visible and manageable in the dashboard (mobile)', async () => {
    await page.goto(`${SKYFLY}/`);
    await page.click('text=Larose Natural Skincare Nigeria');
    assert.match(await page.textContent('body'), /₦103,000\s*Pending value/);
    await page.screenshot({ path: path.join(shots, '4-dashboard-overview-mobile.png'), fullPage: true });
    await page.click('nav.sub >> text=Orders');
    assert.match(await page.textContent('body'), new RegExp(reference));
    await page.screenshot({ path: path.join(shots, '5-orders-mobile.png'), fullPage: true });
    await page.click(`text=${reference}`);
    assert.equal(await page.getAttribute('a.btn.wa', 'href').then((h) => new URL(h).pathname), '/2348051234567');
    const statusForm = page.locator('form:has(input[name=kind][value=fulfillment])');
    await statusForm.locator('select').selectOption('confirmed');
    await statusForm.locator('textarea').fill('Confirmed by phone');
    await statusForm.locator('button').click();
    await page.waitForSelector('.notice');
    assert.match(await page.textContent('h1'), /Confirmed/);
    await page.screenshot({ path: path.join(shots, '6-order-detail-mobile.png'), fullPage: true });
  });

  await step('logging out protects the dashboard again', async () => {
    await page.click('text=Log out');
    await page.goto(`${SKYFLY}/businesses/1/orders/1`);
    assert.equal(new URL(page.url()).pathname, '/login');
  });

  console.log(`\nE2E passed: ${results.length} steps`);
} finally {
  await browser.close();
  server.kill();
  landing.close();
  await pool.end();
}
