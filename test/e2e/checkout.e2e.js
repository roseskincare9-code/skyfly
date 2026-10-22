// End-to-end: import a page with no order form, add Skyfly's drop-in checkout, publish it on
// the Skyfly address (/p/<slug>/, sandboxed), order on a phone: validation, a failed save,
// review, an upsell added with one button, a saved order shown once with the thank-you message and
// WhatsApp hand-off, Purchase once with the server total; desktop view; the order in the dashboard.
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
    await pool.query('DELETE FROM additional_pixels'); // this test covers one pixel (see additional-pixels.test.js)
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
    assert.equal(await dash.inputValue('#live-url-text'), pageUrl, 'copyable public address');
    assert.equal(await dash.locator('button[data-copy="live-url-text"]').count(), 1);
  });

  await step('owner offers an upsell on the page (one of the business\'s products)', async () => {
    await pool.query("INSERT INTO products (business_id, code, name, price_minor, sort_order) VALUES ($1, 'glow-toner', 'Glow Toner', 850000, 9)", [businessId]);
    await dash.goto(`${DASH}/businesses/${businessId}/landing-pages/${pageId}`);
    await dash.selectOption('#upsell_product_id', { label: 'Glow Toner — ₦8,500' });
    await dash.fill('#upsell_headline', 'Add a Glow Toner');
    await dash.fill('#upsell_text', '100ml toner, used after washing');
    await Promise.all([dash.waitForURL(/landing-pages$/), dash.click('form:has(#upsell_product_id) button[type=submit]')]);
    const { rows: [lp] } = await pool.query('SELECT upsell_headline, status FROM landing_pages WHERE id = $1', [pageId]);
    assert.equal(lp.upsell_headline, 'Add a Glow Toner');
    assert.equal(lp.status, 'active', 'still published');
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
    assert.ok(opts.some((t) => /₦36,500/.test(t)), `options: ${opts}`);
    assert.ok(fbCalls.some((a) => a.includes('PageView')), 'PageView on visit');
    assert.equal(purchases().length, 0, 'a visit is not a Purchase');
  });

  await step('choosing a package and quantity updates the total; missing details are explained, nothing is sent', async () => {
    await shop.locator('.sky-opt', { hasText: 'Package 2' }).click();
    await shop.selectOption('#sky-qty', '2');
    assert.match(await shop.textContent('[data-total]'), /₦73,000/);
    let posts = 0; shop.on('request', (r) => { if (r.url().endsWith('/api/public/orders') && r.method() === 'POST') posts += 1; });
    await shop.click('text=Review my order');
    assert.match(await shop.textContent('[data-err]'), /your name, your phone number, your delivery address/);
    assert.equal(posts, 0);
    assert.equal(purchases().length, 0, 'clicking without completing is not a Purchase');
  });

  await step('the upsell shows what is included; Add updates the total (Remove takes it off again)', async () => {
    const box = shop.locator('[data-skyfly-upsell]');
    assert.match(await box.textContent(), /Add a Glow Toner.*100ml toner.*Glow Toner · ₦8,500/s);
    await box.locator('button:text-is("Add")').click();
    assert.match(await shop.textContent('[data-total]'), /Package 2.*× 2 \+ Glow Toner.*₦81,500/s);
    await box.locator('button[data-addon]').click();
    assert.match(await shop.textContent('[data-total]'), /₦73,000/);
    await box.locator('button[data-addon]').click();
    assert.match(await shop.textContent('[data-total]'), /₦81,500/);
    assert.equal(purchases().length, 0, 'adding the upsell is not a Purchase');
  });

  await step('a failed save shows an honest error, no confirmation, no order, no Purchase', async () => {
    await shop.fill('#sky-name', 'Ada Checkout'); await shop.fill('#sky-phone', '08031234567');
    await shop.fill('#sky-address', '4 Allen Avenue, Ikeja'); await shop.fill('#sky-state', 'Lagos');
    await shop.click('text=Review my order');
    assert.match(await shop.textContent('.sky-rows'), /Package 2.*× 2.*Add-on.*Glow Toner.*₦81,500/s);
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
  await step('placing the order (tapped twice) saves it once with the add-on and shows the thank-you message, total and WhatsApp hand-off', async () => {
    await shop.click('text=Place my order');
    await shop.click('[data-place]', { force: true, noWaitAfter: true }).catch(() => {});
    await shop.waitForSelector('.sky-ok');
    reference = (await shop.textContent('[data-skyfly-reference]')).trim();
    const saved = await orders();
    assert.equal(saved.length, 1);
    assert.equal(saved[0].reference, reference);
    assert.equal(Number(saved[0].total_minor), 8150000, 'priced by Skyfly, add-on included');
    assert.equal(String(saved[0].landing_page_id), pageId);
    const { rows: lines } = await pool.query('SELECT product_code, is_upsell FROM order_items i JOIN orders o ON o.id = i.order_id WHERE o.reference = $1 ORDER BY i.id', [reference]);
    assert.deepEqual(lines.map((l) => [l.product_code, l.is_upsell]), [['package-2', false], ['glow-toner', true]]);
    const ok = await shop.textContent('.sky-ok');
    assert.match(ok, /Thank you! We have received your order\./);
    assert.match(ok, /Our team will contact you shortly to confirm the details and delivery\./);
    assert.match(ok, /Glow Toner × 1 \(add-on\)/);
    assert.match(ok, /₦81,500/);
    assert.ok(!/24 hours/.test(ok));
    const wa = await shop.getAttribute('[data-skyfly-whatsapp]', 'href');
    assert.match(wa, new RegExp(`^https://wa\\.me/2349049206695\\?text=.*${reference}`), wa);
    const p = purchases();
    assert.equal(p.length, 1, 'one Purchase for the saved order');
    assert.equal(p[0][3].value, 81500);
    assert.equal(p[0][3].currency, 'NGN');
    assert.equal(p[0][4].eventID, `purchase_${reference}`);
    await shop.screenshot({ path: path.join(shots, 'confirmation-mobile.png') });
    const w = await shop.evaluate(() => document.documentElement.scrollWidth);
    assert.ok(w <= 393, `no horizontal scroll (got ${w})`);
  });

  await step('refreshing and sending the same details again (no storage in the sandbox) returns the same order: no duplicate, no second Purchase', async () => {
    await shop.reload();
    await shop.waitForSelector('.sky-opt');
    await shop.locator('.sky-opt', { hasText: 'Package 2' }).click();
    await shop.selectOption('#sky-qty', '2');
    await shop.fill('#sky-name', 'Ada Checkout'); await shop.fill('#sky-phone', '08031234567');
    await shop.fill('#sky-address', '4 Allen Avenue, Ikeja'); await shop.fill('#sky-state', 'Lagos');
    await shop.locator('[data-skyfly-upsell] button:text-is("Add")').click();
    await shop.click('text=Review my order');
    await shop.click('text=Place my order');
    await shop.waitForSelector('.sky-ok');
    assert.equal((await shop.textContent('[data-skyfly-reference]')).trim(), reference);
    assert.equal((await orders()).length, 1, 'still one order');
    assert.equal(purchases().length, 1, 'still one Purchase');
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
