// End-to-end test: the real (patched) Larose landing page served from a different
// origin submits to a running Skyfly server, in mobile Chromium.
//
//   npm run test:e2e
// Requires a local *_test database in .env.test. Screenshots go to test/e2e/screenshots/.
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { chromium, devices } from 'playwright-core';
import { createPool } from '../../src/db.js';
import { seedLarose, LAROSE_META_PIXEL_ID, LAROSE_PIXEL_NEW_ID, LAROSE_AD_ACCOUNT_PIXELS, LAROSE_SKINCARE_PIXEL } from '../../src/scripts/seed-larose.js';
import { resetDatabase, testDatabaseUrl } from '../helpers.js';

const LAROSE_PIXELS = [LAROSE_META_PIXEL_ID, LAROSE_PIXEL_NEW_ID, ...LAROSE_AD_ACCOUNT_PIXELS.map((x) => x.id), LAROSE_SKINCARE_PIXEL.id];

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const shots = path.join(root, 'test/e2e/screenshots');
mkdirSync(shots, { recursive: true });
const SKYFLY = 'http://localhost:3100';
const LANDING_ORIGIN = 'http://127.0.0.1:3200';
// The original, unpatched Larose page (Larosenigeria commit c7423d0), as the input to patch.py.
const landingSource = process.env.LANDING_SOURCE || path.join(root, 'test/fixtures/larosenigeria-original.html');

const pool = createPool(testDatabaseUrl(), false);
await resetDatabase(pool);

// Build the patched landing page pointing at this Skyfly instance.
const patched = path.join(root, 'test/e2e/.landing.html');
execFileSync('python3', [path.join(root, 'integrations/larosenigeria/patch.py'), landingSource, patched, SKYFLY]);
// The owner's confirmed prices (2026-10-22), as on the live page: Package 1 ₦26,500, 2 ₦36,500, 3 ₦58,000.
writeFileSync(patched, readFileSync(patched, 'utf8')
  .replace(/23,500/g, '26,500').replace(/data-price="23500"/g, 'data-price="26500"')
  .replace(/33,000/g, '36,500').replace(/data-price="33000"/g, 'data-price="36500"')
  .replace(/51,500/g, '58,000').replace(/data-price="51500"/g, 'data-price="58000"'));
const patchedHtml = readFileSync(patched, 'utf8');
assert.ok(!patchedHtml.includes('7039361243'), 'old WhatsApp number must not remain on the page');
// WhatsApp stays as voluntary support (floating button, "Chat With Us", footer, confirmation), all on the new number;
// ordering happens on the website, so no "order on WhatsApp" links remain.
assert.equal((patchedHtml.match(/wa\.me\/2349049206695/g) || []).length, 4, '4 voluntary WhatsApp links, all on the new number');
assert.ok(!/wa\.me\/[^"']*want%20to%20order/.test(patchedHtml), 'no order-on-WhatsApp links');
assert.ok(!patchedHtml.includes('skyOldSuccess') && !patchedHtml.includes('skySheet('), 'no unconfirmed Sheet-only success path');
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
  // Stand-in for Meta's pixel script: records every fbq call instead of sending it to Meta.
  const fbCalls = [];
  await context.exposeBinding('recordFb', (_src, args) => fbCalls.push(args));
  await context.route('https://connect.facebook.net/**', (route) => route.fulfill({
    contentType: 'text/javascript',
    body: 'fbq.callMethod=function(){window.recordFb(Array.prototype.slice.call(arguments));};'
      + 'var q=fbq.queue.splice(0);q.forEach(function(a){fbq.callMethod.apply(null,a);});',
  }));
  const openedPages = [];
  const purchases = () => fbCalls.filter((a) => (a[0] === 'track' && a[1] === 'Purchase') || (a[0] === 'trackSingle' && a[2] === 'Purchase'));
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
  // Any window the landing page opens by itself (e.g. WhatsApp) would show up here.
  shop.on('popup', (p) => openedPages.push(p.url()));
  const fillForm = async () => {
    await shop.goto(`${LANDING_ORIGIN}/Larosenigeria/?utm_source=facebook&utm_campaign=e2e-oct`);
    await shop.click('text=Order Power Glow');
    assert.equal(await shop.inputValue('#pr'), 'Package 3 – Power Glow – ₦58,000');
    await shop.fill('#fn', 'Ngozi Adeyemi');
    await shop.fill('#addr', '14 Admiralty Way, Lekki Phase 1');
    await shop.fill('#ph', '08051234567');
    await shop.fill('#em', 'ngozi@example.com');
    await shop.selectOption('#st', 'Lagos');
    await shop.selectOption('#qty', '2');
    await shop.fill('#nt', 'Gate is blue');
    const summary = await shop.textContent('#skySum');
    assert.match(summary, /Package 3 – Power Glow × 2/);
    assert.match(summary, /Total: ₦116,000 · pay on delivery/);
  };

  // The page has its own Meta Pixel code (the main pixel), so Skyfly adds no second copy of Meta's
  // script; the dashboard still learns that every pixel loaded here ("Tag loaded").
  await step('"Tag loaded": the page reports every Larose pixel, its own main pixel included, as loaded', async () => {
    await shop.goto(`${LANDING_ORIGIN}/Larosenigeria/`);
    const seen = async () => (await pool.query("SELECT pixel_id, browser_seen_page FROM tracking_pixels WHERE platform = 'meta' AND browser_seen_at IS NOT NULL")).rows;
    for (let i = 0; i < 60 && (await seen()).length < LAROSE_PIXELS.length; i += 1) await shop.waitForTimeout(250);
    assert.deepEqual((await seen()).map((r) => r.pixel_id).sort(), [...LAROSE_PIXELS].sort());
    assert.ok((await seen()).every((r) => r.browser_seen_page === 'larosenigeria'));
  });

  await step('empty form shows a helpful error without calling the API', async () => {
    await shop.goto(`${LANDING_ORIGIN}/Larosenigeria/`);
    await shop.click('#sb');
    await shop.waitForSelector('#skyErr', { state: 'visible' });
    assert.match(await shop.textContent('#skyErr'), /Please fill in all required fields/);
    assert.ok(fbCalls.some((a) => a.includes('PageView')), 'PageView fired on load');
    // A. a visit, B. looking at a product, C. clicking Order without completing: none is a Purchase.
    await shop.click('text=Order Power Glow');
    await shop.click('a.btng[href="#order"] >> nth=0');
    assert.equal(purchases().length, 0, 'viewing the page, a product and clicking Order is not a Purchase');
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
    assert.equal(purchases().length, 0, 'a refused submission is not a Purchase');
  });

  await step('Skyfly unreachable: no success shown, nothing saved anywhere, details kept, the page never opens WhatsApp', async () => {
    await fillForm();
    await shop.route(`${SKYFLY}/api/public/orders`, (route) => route.abort('connectionrefused'));
    await shop.click('#sb');
    await shop.waitForSelector('#skyErr', { state: 'visible', timeout: 60000 });
    assert.match(await shop.textContent('#skyErr'), /has not been placed yet/);
    assert.equal(await shop.isVisible('#sb2'), false, 'no confirmation without a saved order');
    assert.equal(sheetRows.length, 0, 'the page no longer writes to the Google Sheet');
    assert.equal(await shop.inputValue('#ph'), '08051234567');
    assert.equal(await shop.isEnabled('#sb'), true);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM orders')).rows[0].n, 0);
    assert.equal(purchases().length, 0, 'a failed submission is not a Purchase');
    assert.equal(openedPages.length, 0, 'no WhatsApp (or any other) window was opened');
    assert.ok(new URL(shop.url()).pathname.startsWith('/Larosenigeria/'), 'customer stays on the page');
    await shop.screenshot({ path: path.join(shots, '2-landing-unreachable-error.png') });
  });

  let reference;
  await step('retry with repeated clicks saves exactly one order and shows the confirmation on the page', async () => {
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
    await shop.waitForSelector('#sb2', { state: 'visible' });
    assert.equal(calls, 1, 'only one request should be sent');
    reference = (await shop.textContent('#skyRef')).trim();
    assert.ok(new URL(shop.url()).pathname.startsWith('/Larosenigeria/'), 'stays on the landing page');
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM orders');
    assert.equal(rows[0].n, 1);
    // Saved orders are copied to the Google Sheet by Skyfly's server (with retries), not by the page.
    assert.equal(sheetRows.length, 0);
    const { rows: [o] } = await pool.query('SELECT sheet_sync_status FROM orders WHERE reference = $1', [reference]);
    assert.equal(o.sheet_sync_status, 'pending', 'queued for the server-side Google Sheet copy');
    // Exactly one Purchase, after the save, for the saved order's value, keyed by its reference.
    const p = purchases();
    // One per Larose pixel: the main pixel, "Pixel New" and the ad-account pixels.
    assert.deepEqual(p.map((a) => [a[0], a[1], a[2]]), LAROSE_PIXELS.map((id) => ['trackSingle', id, 'Purchase']),
      `one Purchase per pixel (got ${JSON.stringify(p)}; all calls: ${JSON.stringify(fbCalls.map((a) => a.slice(0, 3)))})`);
    for (const a of p) {
      assert.equal(a[3].value, 116000);
      assert.equal(a[3].currency, 'NGN');
      assert.equal(a[4].eventID, `purchase_${reference}`);
    }
  });

  await step('the saved order has trusted product, quantity, price and attribution', async () => {
    const { rows: [o] } = await pool.query('SELECT * FROM orders WHERE reference = $1', [reference]);
    const { rows: items } = await pool.query('SELECT * FROM order_items WHERE order_id = $1', [o.id]);
    assert.equal(o.customer_name, 'Ngozi Adeyemi');
    assert.equal(o.phone, '+2348051234567');
    assert.equal(o.state, 'Lagos');
    assert.equal(o.customer_notes, 'Gate is blue');
    assert.equal(o.total_minor, 11600000);
    assert.equal(o.utm_source, 'facebook');
    assert.equal(o.utm_campaign, 'e2e-oct');
    assert.match(o.source_url, /^http:\/\/127\.0\.0\.1:3200\/Larosenigeria\//);
    assert.deepEqual(items.map((i) => [i.product_code, i.quantity, i.unit_price_minor]), [['package-3', 2, 5800000]]);
  });

  await step('on-page confirmation: reference, package, quantity, confirmed total, next steps; WhatsApp only if the customer chooses', async () => {
    const conf = await shop.textContent('#sb2');
    assert.match(conf, /Thank you, Ngozi! Your order is confirmed\./);
    assert.match(conf, new RegExp(`Order reference: ${reference}`));
    assert.match(conf, /Package: Package 3 – Power Glow/);
    assert.match(conf, /Quantity: 2/);
    assert.match(conf, /Total \(pay on delivery\): ₦116,000/);
    assert.match(conf, /What happens next: our team will call you within 1 hour/);
    assert.match(await shop.getAttribute('#skyView', 'href'), new RegExp(`/o/${reference}\\?t=`));
    assert.equal(openedPages.length, 0, 'WhatsApp is never opened automatically');
    assert.equal(await shop.getAttribute('.wafbtn', 'href'), 'https://wa.me/2349049206695?text=Hi%20Larose!%20I%20have%20a%20question.');
    assert.equal(await shop.isVisible('.wafbtn'), true, 'floating WhatsApp button still there');
    const width = await shop.evaluate(() => document.documentElement.scrollWidth);
    assert.ok(width <= 390, `no horizontal scroll on mobile (got ${width})`);
    await shop.screenshot({ path: path.join(shots, '3-confirmation-mobile.png'), fullPage: false });
    // The order details link opens Skyfly's own confirmation (read from the database).
    const details = await context.newPage();
    await details.goto(await shop.getAttribute('#skyView', 'href'));
    assert.equal(await details.textContent('#ref'), reference);
    assert.equal((await details.textContent('#total')).trim(), '₦116,000');
    await details.close();
  });

  await step('refreshing keeps the confirmation, creates no order and no second Purchase', async () => {
    await shop.reload();
    await shop.waitForSelector('#sb2', { state: 'visible' });
    assert.match(await shop.textContent('#skyConf'), new RegExp(reference));
    assert.equal(await shop.isVisible('#sb'), false, 'the form is not offered again for the same order');
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM orders');
    assert.equal(rows[0].n, 1);
    assert.equal(sheetRows.length, 0);
    assert.equal(purchases().length, LAROSE_PIXELS.length, 'refreshing is not a second Purchase (still one per pixel)');
  });

  await step('reply lost after saving: the retry returns the same order, no fallback, no duplicate', async () => {
    await shop.click('#skyAgain');
    await shop.waitForSelector('#sb', { state: 'visible' });
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
    await shop.waitForSelector('#sb2', { state: 'visible', timeout: 60000 });
    await shop.unroute(`${SKYFLY}/api/public/orders`);
    assert.equal(calls, 2);
    const { rows } = await pool.query("SELECT count(*)::int AS n FROM orders WHERE customer_name = 'Lost Reply'");
    assert.equal(rows[0].n, 1, 'exactly one order');
    const lost = (await pool.query("SELECT reference FROM orders WHERE customer_name = 'Lost Reply'")).rows[0].reference;
    assert.equal(purchases().filter((a) => a[4].eventID === `purchase_${lost}`).length, LAROSE_PIXELS.length, 'one Purchase per pixel for the order whose reply was lost');
    // J. two different orders: two Purchases per pixel, one per order.
    assert.deepEqual(purchases().map((a) => a[4].eventID), [...LAROSE_PIXELS.map(() => `purchase_${reference}`), ...LAROSE_PIXELS.map(() => `purchase_${lost}`)]);
    assert.equal(sheetRows.length, before, 'no fallback row: the order was saved in Skyfly');
    await pool.query("DELETE FROM orders WHERE customer_name = 'Lost Reply'");
    sheetRows.splice(before);
    await shop.goto(`${LANDING_ORIGIN}/Larosenigeria/`);
  });

  await step('the new order is visible and manageable in the dashboard (mobile)', async () => {
    await page.goto(`${SKYFLY}/`);
    await page.click('main >> text=Larose Natural Skincare Nigeria');
    assert.match(await page.textContent('body'), /₦116,000\s*Pending value/);
    await page.screenshot({ path: path.join(shots, '4-dashboard-overview-mobile.png'), fullPage: true });
    await page.click('label.menu-btn');
    await page.click('aside.sidebar >> text=Orders');
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
