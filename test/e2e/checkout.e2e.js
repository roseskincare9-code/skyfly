// End-to-end: import a page with no order form, add Skyfly's drop-in checkout, publish it on
// the Skyfly address (/p/<slug>/, sandboxed), order on a phone: validation, a failed save,
// review, a saved order shown once, Purchase once; desktop view; the order in the dashboard.
//   npm run test:e2e:checkout
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

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const shots = path.join(root, 'test/e2e/screenshots/checkout');
mkdirSync(shots, { recursive: true });
const DASH = 'http://localhost:3111';
const PAGE_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Glow Drop</title><style>body{margin:0;font-family:sans-serif}header{padding:24px 16px;background:#f3eefe}</style></head>
<body><header><h1>Glow Drop serum</h1><p>Clearer skin in 14 days.</p></header>
<script>try{localStorage.setItem('x','1')}catch(e){window.storageBlocked=true}</script></body></html>`;

const pool = createPool(testDatabaseUrl(), false);
await resetDatabase(pool);
const server = spawn('node', ['src/server.js'], {
  cwd: root,
  env: {
    ...process.env, PORT: '3111', NODE_ENV: 'development', DATABASE_URL: testDatabaseUrl(), SESSION_SECRET: 'e2e-secret',
    ALLOW_SIGNUP: 'true', ALLOWED_ORIGINS: '', PUBLIC_BASE_URL: DASH, PAGES_BASE_URL: '',
    SKYFLY_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  },
  stdio: ['ignore', 'inherit', 'inherit'],
});
for (let i = 0; i < 50; i += 1) {
  try { if ((await fetch(`${DASH}/healthz`)).ok) break; } catch { /* starting */ }
  await new Promise((r) => setTimeout(r, 200));
}

const browser = await chromium.launch();
let dashPage = null;
const step = async (name, fn) => {
  try { await fn(); } catch (err) { console.log(`  ✗ ${name}${dashPage ? ` (dashboard at ${dashPage.url()})` : ''}`); throw err; }
  console.log(`  ✓ ${name}`);
};
const orders = async () => (await pool.query("SELECT reference, total_minor, is_test, landing_page_id FROM orders WHERE customer_name LIKE 'Ada %' ORDER BY id")).rows;

try {
  const dash = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  dashPage = dash;
  let businessId; let pageUrl; let pageId;

  await step('owner imports a page that has no order form; Skyfly says so and adds its checkout', async () => {
    await dash.goto(`${DASH}/signup`);
    await dash.fill('#name', 'Rose Owner'); await dash.fill('#email', 'owner@larose.test'); await dash.fill('#password', 'a-very-long-password');
    await dash.click('button[type=submit]');
    await dash.waitForURL(`${DASH}/`);
    businessId = await seedLarose(pool, 'owner@larose.test');
    await dash.goto(`${DASH}/businesses/${businessId}/landing-pages`);
    await dash.fill('#imp-name', 'Glow Drop');
    await dash.setInputFiles('#imp-file', { name: 'index.html', mimeType: 'text/html', buffer: Buffer.from(PAGE_HTML) });
    await Promise.all([dash.waitForURL(/landing-pages\/\d+\?done=uploaded/), dash.click('form[enctype] button[type=submit]')]);
    pageId = dash.url().match(/landing-pages\/(\d+)/)[1];
    const report = await dash.textContent('#report');
    assert.match(report, /no order form/);
    assert.match(report, /uses browser storage/);
    const [resp] = await Promise.all([dash.waitForResponse((r) => r.url().includes('/add-checkout')), dash.click('button:text-is("Add Skyfly checkout")')]);
    if (resp.status() !== 302) console.log('add-checkout', resp.status(), (await resp.text()).slice(0, 300));
    await dash.waitForURL(/done=checkout/);
    await pool.query("INSERT INTO landing_page_products (landing_page_id, product_id) SELECT $1, id FROM products WHERE business_id = $2 AND code IN ('package-1', 'package-2', 'package-3')", [pageId, businessId]);
    await Promise.all([dash.waitForURL(/done=published/), dash.locator('button:text-is("Publish this version")').first().click()]);
    pageUrl = await dash.getAttribute('#live-url', 'href');
    assert.equal(pageUrl, `${DASH}/p/glow-drop/`);
  });

  const phone = await browser.newContext({ ...devices['Pixel 5'] });
  const fbCalls = [];
  // Later routes win: block other sites first, then stand in for Meta's pixel script.
  await phone.route(/^https?:\/\/(?!localhost|127\.0\.0\.1)/, (route) => route.abort());
  await phone.exposeBinding('recordFb', (_src, args) => fbCalls.push(args));
  await phone.route('https://connect.facebook.net/**', (route) => route.fulfill({
    contentType: 'text/javascript',
    body: 'fbq.callMethod=function(){window.recordFb(Array.prototype.slice.call(arguments));};var q=fbq.queue.splice(0);q.forEach(function(a){fbq.callMethod.apply(null,a);});',
  }));
  const purchases = () => fbCalls.filter((a) => a[0] === 'trackSingle' && a[2] === 'Purchase');
  const shop = await phone.newPage();

  await step('the published page opens publicly in a sandbox and shows the checkout with Skyfly prices', async () => {
    const res = await shop.goto(pageUrl);
    assert.equal(res.status(), 200);
    assert.match(res.headers()['content-security-policy'], /^sandbox /);
    assert.equal(await shop.evaluate(() => window.origin), 'null', 'page has no access to the dashboard origin');
    assert.equal(await shop.evaluate(() => window.storageBlocked === true), true);
    await shop.waitForSelector('.sky-opt');
    const opts = await shop.locator('.sky-opt').allTextContents();
    assert.equal(opts.length, 3);
    assert.ok(opts.some((t) => /₦33,000/.test(t)), `options: ${opts}`);
    assert.ok(fbCalls.some((a) => a.includes('PageView')), 'PageView on visit');
    assert.equal(purchases().length, 0, 'a visit is not a Purchase');
  });

  await step('choosing a package and quantity updates the total; missing details are explained, nothing is sent', async () => {
    await shop.locator('.sky-opt', { hasText: 'Package 2' }).click();
    await shop.selectOption('#sky-qty', '2');
    assert.match(await shop.textContent('[data-total]'), /₦66,000/);
    let posts = 0; shop.on('request', (r) => { if (r.url().endsWith('/api/public/orders') && r.method() === 'POST') posts += 1; });
    await shop.click('text=Review my order');
    assert.match(await shop.textContent('[data-err]'), /your name, your phone number, your delivery address/);
    assert.equal(posts, 0);
    assert.equal(purchases().length, 0, 'clicking without completing is not a Purchase');
  });

  await step('a failed save shows an honest error, no confirmation, no order, no Purchase', async () => {
    await shop.fill('#sky-name', 'Ada Checkout'); await shop.fill('#sky-phone', '08031234567');
    await shop.fill('#sky-address', '4 Allen Avenue, Ikeja'); await shop.fill('#sky-state', 'Lagos');
    await shop.click('text=Review my order');
    assert.match(await shop.textContent('.sky-rows'), /Package 2.*× 2/);
    await shop.route('**/api/public/orders', (route) => route.fulfill({ status: 500, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': 'null' }, body: '{"ok":false,"message":"We could not save your order. Please try again in a moment."}' }));
    await shop.click('text=Place my order');
    await shop.waitForSelector('[data-err]:not([hidden])', { timeout: 10000 }).catch(async (e) => { console.log('BOX:', await shop.textContent('.sky-co')); throw e; });
    assert.match(await shop.textContent('[data-err]'), /has not been placed yet/);
    assert.equal(await shop.locator('.sky-ok').count(), 0);
    assert.equal((await orders()).length, 0);
    assert.equal(purchases().length, 0);
    await shop.unroute('**/api/public/orders');
  });

  let reference;
  await step('placing the order (tapped twice) saves it once and confirms it with Skyfly\'s reference and total', async () => {
    await shop.click('text=Place my order');
    await shop.click('[data-place]', { force: true, noWaitAfter: true }).catch(() => {});
    await shop.waitForSelector('.sky-ok');
    reference = (await shop.textContent('[data-skyfly-reference]')).trim();
    const saved = await orders();
    assert.equal(saved.length, 1);
    assert.equal(saved[0].reference, reference);
    assert.equal(Number(saved[0].total_minor), 6600000, 'priced by Skyfly');
    assert.equal(String(saved[0].landing_page_id), pageId);
    assert.match(await shop.textContent('.sky-ok'), /₦66,000/);
    const p = purchases();
    assert.equal(p.length, 1, 'one Purchase for the saved order');
    assert.equal(p[0][3].value, 66000);
    assert.equal(p[0][3].currency, 'NGN');
    assert.equal(p[0][4].eventID, `purchase_${reference}`);
    await shop.screenshot({ path: path.join(shots, 'confirmation-mobile.png') });
    const w = await shop.evaluate(() => document.documentElement.scrollWidth);
    assert.ok(w <= 393, `no horizontal scroll (got ${w})`);
  });

  await step('a desktop visitor sees the same page and checkout', async () => {
    const desk = await (await browser.newContext({ viewport: { width: 1366, height: 800 } })).newPage();
    await desk.route(/^https?:\/\/(?!localhost|127\.0\.0\.1)/, (route) => route.abort());
    await desk.goto(pageUrl);
    await desk.waitForSelector('.sky-opt');
    await desk.screenshot({ path: path.join(shots, 'page-desktop.png') });
    await desk.close();
  });

  await step('the order appears exactly once in the Larose dashboard', async () => {
    await dash.goto(`${DASH}/businesses/${businessId}/orders?q=${reference}`);
    const rows = await dash.getByRole('link', { name: reference, exact: true }).count();
    if (rows !== 1) console.log('ORDERS PAGE:', (await dash.textContent('main')).replace(/\s+/g, ' ').slice(0, 600));
    assert.equal(rows, 1);
  });
  console.log('\nCheckout E2E passed');
} finally {
  await browser.close();
  server.kill();
  await pool.end();
}
