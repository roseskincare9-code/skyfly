// End-to-end: import a ZIP landing page, preview, publish, pixels, order via
// the connected form, dashboard, Paid -> server Purchase. Mobile Chromium.
//   npm run test:e2e:hosting
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { chromium, devices } from 'playwright-core';
import yazl from 'yazl';
import { createPool } from '../../src/db.js';
import { seedLarose } from '../../src/scripts/seed-larose.js';
import { resetDatabase, testDatabaseUrl } from '../helpers.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const shots = path.join(root, 'test/e2e/screenshots');
mkdirSync(shots, { recursive: true });
const DASH = 'http://localhost:3101';
const PAGES = 'http://127.0.0.1:3101';

// A tiny real PNG (2x2 pink) so we can check images actually render.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP4/58BCBj+M4AZDP/BAADq0Qf5o8sMZgAAAABJRU5ErkJggg==', 'base64');
const PAGE_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Glow Promo</title><link rel="stylesheet" href="css/style.css"></head>
<body><h1 id="title">Glow Promo</h1><img id="logo" src="img/logo.png" width="40" height="40" alt="logo">
<form data-skyfly-form id="order">
  <input name="name" placeholder="Name"><input name="phone" placeholder="Phone"><input name="address" placeholder="Address">
  <select name="state"><option>Lagos</option><option>Abuja</option></select>
  <select name="product"><option value="">Choose</option><option data-product="package-2" data-price="33000">Combo ₦33,000</option></select>
  <input name="quantity" value="1"><button type="submit">Order now</button>
</form><script src="js/app.js"></script></body></html>`;

function zip(entries) {
  return new Promise((resolve) => {
    const z = new yazl.ZipFile();
    for (const [name, content] of Object.entries(entries)) z.addBuffer(Buffer.from(content), name);
    const chunks = [];
    z.outputStream.on('data', (c) => chunks.push(c)).on('end', () => resolve(Buffer.concat(chunks)));
    z.end();
  });
}
const zipPath = path.join(root, 'test/e2e/.glow-promo.zip');
writeFileSync(zipPath, await zip({
  'glow-promo/index.html': PAGE_HTML,
  'glow-promo/css/style.css': 'body{margin:0;font-family:sans-serif} #title{color:rgb(123, 45, 139)} form{display:grid;gap:8px;padding:16px} input,select,button{font-size:16px;padding:10px}',
  'glow-promo/js/app.js': 'window.pageScriptRan = true;',
  'glow-promo/img/logo.png': PNG,
}));

// Fake Meta / TikTok server-side APIs.
const apiCalls = [];
const mock = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    apiCalls.push({ url: req.url, body: JSON.parse(body || '{}') });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(req.url.startsWith('/meta') ? '{"events_received":1}' : '{"code":0,"message":"OK"}');
  });
}).listen(3102);

const pool = createPool(testDatabaseUrl(), false);
await resetDatabase(pool);
const server = spawn('node', ['src/server.js'], {
  cwd: root,
  env: {
    ...process.env, PORT: '3101', NODE_ENV: 'development', DATABASE_URL: testDatabaseUrl(), SESSION_SECRET: 'e2e-secret',
    ALLOW_SIGNUP: 'true', ALLOWED_ORIGINS: '', PUBLIC_BASE_URL: DASH, PAGES_BASE_URL: PAGES,
    SKYFLY_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    META_GRAPH_BASE: 'http://127.0.0.1:3102/meta/v26.0', TIKTOK_API_BASE: 'http://127.0.0.1:3102/tiktok/v1.3',
  },
  stdio: ['ignore', 'inherit', 'inherit'],
});
for (let i = 0; i < 50; i += 1) {
  try { if ((await fetch(`${DASH}/healthz`)).ok) break; } catch { /* starting */ }
  await new Promise((r) => setTimeout(r, 200));
}

const browser = await chromium.launch();
const step = async (name, fn) => { await fn(); console.log(`  ✓ ${name}`); };
const noSideScroll = async (page, label) => {
  const w = await page.evaluate(() => document.documentElement.scrollWidth);
  assert.ok(w <= 390, `${label}: no horizontal scroll on mobile (got ${w}px)`);
};

try {
  const context = await browser.newContext({ ...devices['iPhone 13'] });
  // Record what the browser pixels are asked to do, instead of calling Meta/TikTok.
  const fbCalls = [];
  await context.exposeBinding('recordFb', (_src, args) => fbCalls.push(args));
  // Routes run newest-first: block other third-party requests, then stub the Meta pixel script.
  await context.route(/^https?:\/\/(?!localhost|127\.0\.0\.1)/, (route) => route.abort());
  await context.route('https://connect.facebook.net/**', (route) => route.fulfill({
    contentType: 'text/javascript',
    body: 'fbq.callMethod=function(){window.recordFb(Array.prototype.slice.call(arguments));};'
      + 'var q=fbq.queue.splice(0);q.forEach(function(a){fbq.callMethod.apply(null,a);});',
  }));
  const dash = await context.newPage();
  let pageId;
  let liveUrl;

  await step('owner signs up; business seeded', async () => {
    await dash.goto(`${DASH}/signup`);
    await dash.fill('#name', 'Rose Owner');
    await dash.fill('#email', 'owner@larose.test');
    await dash.fill('#password', 'a-very-long-password');
    await dash.click('button[type=submit]');
    await dash.waitForURL(`${DASH}/`);
    await seedLarose(pool, 'owner@larose.test');
    await pool.query('DELETE FROM additional_pixels'); // this test covers the page's own pixels (see additional-pixels.test.js)
  });

  await step('import a ZIP landing page from the dashboard', async () => {
    await dash.goto(`${DASH}/businesses/1/landing-pages`);
    await dash.fill('#imp-name', 'Glow Promo');
    await dash.setInputFiles('#imp-file', zipPath);
    await dash.click('button:has-text("Upload")');
    await dash.waitForURL(/landing-pages\/\d+\?done=uploaded/);
    pageId = dash.url().match(/landing-pages\/(\d+)/)[1];
    const text = await dash.textContent('#report');
    assert.match(text, /Skyfly connection code found in this upload/);
    assert.match(await dash.textContent('#connection'), /Connection code found, not verified/);
    await noSideScroll(dash, 'page manager');
    await dash.screenshot({ path: path.join(shots, 'h1-imported-page-mobile.png'), fullPage: true });
  });

  await step('connect a product to the page', async () => {
    const settingsForm = dash.locator(`form[action$="/landing-pages/${pageId}"]`);
    await settingsForm.locator('input[name=products] >> nth=1').check(); // package-2
    await settingsForm.locator('button[type=submit]').click();
    await dash.waitForURL(/landing-pages$/);
  });

  await step('preview shows the page with CSS, image and JS working, without tracking', async () => {
    await dash.goto(`${DASH}/businesses/1/landing-pages/${pageId}`);
    const href = await dash.getAttribute('a:has-text("Open on pages address")', 'href');
    assert.ok(href.startsWith(`${PAGES}/_preview/`), 'preview is on the pages host');
    const p = await context.newPage();
    await p.goto(href);
    assert.equal(await p.evaluate(() => getComputedStyle(document.getElementById('title')).color), 'rgb(123, 45, 139)');
    assert.equal(await p.evaluate(() => document.getElementById('logo').naturalWidth), 2);
    assert.equal(await p.evaluate(() => window.pageScriptRan), true);
    assert.equal(await p.evaluate(() => typeof window.Skyfly), 'undefined');
    await p.close();
  });

  await step('configure Meta and TikTok pixels', async () => {
    await dash.goto(`${DASH}/businesses/1/pixels`);
    const meta = dash.locator('#meta');
    await meta.locator('input[name=enabled]').check();
    await meta.locator('input[name=pixel_id]').fill('123456789012345');
    await meta.locator('input[name=server_purchase]').check();
    await meta.locator('input[name=access_token]').fill('EAAB-e2e-meta-token-0123456789');
    await meta.locator('form[action$="/pixels"] button[type=submit]').click();
    await dash.waitForSelector('.notice');
    const tiktok = dash.locator('#tiktok');
    await tiktok.locator('input[name=enabled]').check();
    await tiktok.locator('input[name=pixel_id]').fill('C4E2ETEST1234567890A');
    await tiktok.locator('form[action$="/pixels"] button[type=submit]').click();
    await dash.waitForSelector('.notice');
    await noSideScroll(dash, 'pixels');
  });

  await step('install TikTok by pasting its pixel code: only the matching box shows, the ID is read from the code', async () => {
    const tiktok = dash.locator('#tiktok');
    await tiktok.locator('input[name=install_method][value=code]').check();
    if (await tiktok.locator('input[name=pixel_id]').isVisible()) throw new Error('Pixel ID box still shown in code mode');
    await tiktok.locator('textarea[name=pixel_code]').fill(`<script>
!function (w, d, t) {
  w.TiktokAnalyticsObject=t;var ttq=w[t]=w[t]||[];ttq.methods=["page","track"],ttq.setAndDefer=function(t,e){t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}};for(var i=0;i<ttq.methods.length;i++)ttq.setAndDefer(ttq,ttq.methods[i]);ttq.load=function(e,n){var r="https://analytics.tiktok.com/i18n/pixel/events.js";n=document.createElement("script");n.async=!0,n.src=r+"?sdkid="+e+"&lib="+t;e=document.getElementsByTagName("script")[0];e.parentNode.insertBefore(n,e)};
  ttq.load('C4E2ETEST1234567890A');
  ttq.page();
}(window, document, 'ttq');
</script>`);
    await tiktok.locator('form[action$="/pixels"] button[type=submit]').click();
    await dash.waitForSelector('.notice');
    const text = await dash.locator('#tiktok').textContent();
    if (!text.includes('Pasted pixel code (Pixel ID C4E2ETEST1234567890A read from it)')) throw new Error('code install not shown');
    await noSideScroll(dash, 'pixels');
    await dash.screenshot({ path: path.join(shots, 'h2-pixels-mobile.png'), fullPage: true });
  });

  await step('publish; the live page works on the pages host', async () => {
    await dash.goto(`${DASH}/businesses/1/landing-pages/${pageId}`);
    await dash.click('button:has-text("Publish this version")');
    await dash.waitForURL(/done=published/);
    liveUrl = await dash.getAttribute('#live-url', 'href');
    assert.equal(liveUrl, `${PAGES}/glow-promo/`);
  });

  const shop = await context.newPage();
  shop.on('console', (m) => { if (m.type() === 'error') console.log('    [page console]', m.text()); });
  shop.on('pageerror', (e) => console.log('    [page error]', e.message));
  await step('live page: assets load, PageView fires once per pixel', async () => {
    await shop.goto(`${liveUrl}?utm_source=facebook&utm_campaign=launch&fbclid=CLICK123`);
    await shop.waitForFunction(() => window.Skyfly && window.ttq);
    assert.equal(await shop.evaluate(() => getComputedStyle(document.getElementById('title')).color), 'rgb(123, 45, 139)');
    assert.equal(await shop.evaluate(() => document.getElementById('logo').naturalWidth), 2);
    await shop.waitForTimeout(300);
    assert.deepEqual(fbCalls.filter((c) => c[0] === 'init').map((c) => c[1]), ['123456789012345']);
    assert.equal(fbCalls.filter((c) => c[2] === 'PageView').length, 1);
    const tt = await shop.evaluate(() => window.ttq._i['C4E2ETEST1234567890A'].map((c) => c[0]));
    assert.deepEqual(tt, ['page']);
  });

  await step('page scripts cannot read the dashboard or its cookie', async () => {
    const result = await shop.evaluate(async (dashUrl) => {
      try {
        const r = await fetch(`${dashUrl}/businesses/1/orders`, { credentials: 'include' });
        return `read ${r.status}`;
      } catch (e) {
        return 'blocked';
      }
    }, DASH);
    assert.equal(result, 'blocked');
    assert.doesNotMatch(await shop.evaluate(() => document.cookie), /skyfly\.sid/);
  });

  let reference;
  await step('form: InitiateCheckout once, errors keep details, Lead and Purchase once each after the save', async () => {
    await shop.click('input[name=name]');
    await shop.click('input[name=phone]');
    await shop.click('input[name=address]');
    assert.equal(fbCalls.filter((c) => c[2] === 'InitiateCheckout').length, 1);
    await shop.fill('input[name=name]', 'Halima Bello');
    await shop.fill('input[name=phone]', '123');
    await shop.fill('input[name=address]', '22 Glow Street, Abuja');
    await shop.selectOption('select[name=state]', 'Abuja');
    await shop.selectOption('select[name=product]', { index: 1 });
    await shop.fill('input[name=quantity]', '2');
    await shop.click('button[type=submit]');
    await shop.waitForSelector('[data-skyfly-error]', { state: 'visible' });
    assert.match(await shop.textContent('[data-skyfly-error]'), /valid phone number/);
    assert.equal(await shop.inputValue('input[name=name]'), 'Halima Bello');
    assert.equal(fbCalls.filter((c) => c[2] === 'Lead').length, 0, 'no Lead without a saved order');
    await shop.screenshot({ path: path.join(shots, 'h3-live-page-error-mobile.png'), fullPage: true });

    await shop.fill('input[name=phone]', '0809 111 2222');
    await shop.click('button[type=submit]');
    await shop.click('button[type=submit]', { force: true, noWaitAfter: true }).catch(() => {});
    await shop.waitForURL(/\/o\/LR-/);
    reference = new URL(shop.url()).pathname.split('/').pop();
    const leads = fbCalls.filter((c) => c[2] === 'Lead');
    assert.equal(leads.length, 1);
    assert.deepEqual(leads[0][4], { eventID: `lead_${reference}` });
    // One Purchase after the save (double click included), keyed by the order reference.
    const purchases = fbCalls.filter((c) => c[2] === 'Purchase');
    assert.equal(purchases.length, 1, `one Purchase (got ${purchases.length})`);
    assert.deepEqual(purchases[0][4], { eventID: `purchase_${reference}` });
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM orders');
    assert.equal(rows[0].n, 1);
  });

  await step('order stored with product, price, page and campaign', async () => {
    const { rows: [o] } = await pool.query('SELECT o.*, lp.slug FROM orders o JOIN landing_pages lp ON lp.id = o.landing_page_id WHERE reference = $1', [reference]);
    assert.equal(o.slug, 'glow-promo');
    assert.equal(o.total_minor, 6600000);
    assert.equal(o.utm_campaign, 'launch');
    assert.match(o.fbc, /^fb\.1\.\d+\.CLICK123$/);
    assert.equal(o.payment_status, 'unpaid');
  });

  await step('the page now shows its order connection as verified by that order', async () => {
    await dash.goto(`${DASH}/businesses/1/landing-pages/${pageId}`);
    assert.match(await dash.textContent('#connection'), new RegExp(`Orders connected ✓ verified[\\s\\S]*${reference}`));
    await dash.goto(`${DASH}/businesses/1/pixels`);
    const meta = await dash.textContent('[data-status=meta]');
    assert.match(meta, /Configured\s*Yes/);
    assert.match(meta, /Browser events\s*Not verified/);
    // Purchase is counted when the order is saved: the server event went out then, with the browser's event ID.
    assert.equal(apiCalls.length, 1, 'one server Purchase, at save');
    assert.equal(apiCalls[0].body.data[0].event_id, `purchase_${reference}`);
    assert.match(meta, /Server Purchase\s*Verified/);
  });

  await step('dashboard shows the order; marking Paid later sends no second Purchase', async () => {
    await dash.goto(`${DASH}/businesses/1/orders`);
    assert.match(await dash.textContent('body'), new RegExp(reference));
    await noSideScroll(dash, 'orders');
    await dash.screenshot({ path: path.join(shots, 'h4-orders-mobile.png'), fullPage: true });
    await dash.click(`text=${reference}`);
    const payment = dash.locator('form:has(input[name=kind][value=payment])');
    await payment.locator('select').selectOption('paid');
    await payment.locator('button').click();
    await dash.waitForSelector('.notice');
    assert.equal(apiCalls.length, 1, 'still the one Purchase sent at save');
    assert.equal(apiCalls[0].body.data[0].event_name, 'Purchase');
    assert.match(await dash.textContent('body'), /Purchase to Meta[\s\S]*sent/);
    await noSideScroll(dash, 'order detail');
    await dash.screenshot({ path: path.join(shots, 'h5-order-paid-mobile.png'), fullPage: true });

    await payment.locator('select').selectOption('unpaid');
    await payment.locator('button').click();
    await dash.waitForSelector('.notice');
    await dash.locator('form:has(input[name=kind][value=payment]) select').selectOption('paid');
    await dash.locator('form:has(input[name=kind][value=payment]) button').click();
    await dash.waitForSelector('.notice');
    assert.equal(apiCalls.length, 1, 'no duplicate Purchase');
    await dash.goto(`${DASH}/businesses/1/pixels`);
    assert.match(await dash.textContent('[data-status=meta]'), /Server Purchase\s*Verified\s*Meta accepted an event/);
    await dash.screenshot({ path: path.join(shots, 'h7-pixel-status-mobile.png'), fullPage: true });
  });

  await step('overview shows paid revenue; unpublish takes the page offline', async () => {
    await dash.goto(`${DASH}/businesses/1`);
    assert.match(await dash.textContent('body'), /₦66,000\s*Paid revenue/);
    await noSideScroll(dash, 'overview');
    await dash.screenshot({ path: path.join(shots, 'h6-overview-mobile.png'), fullPage: true });
    await dash.goto(`${DASH}/businesses/1/landing-pages/${pageId}`);
    await dash.click('button:has-text("Unpublish")');
    await dash.waitForURL(/done=unpublished/);
    const res = await shop.goto(liveUrl);
    assert.equal(res.status(), 404);
  });

  console.log('\nHosting E2E passed');
} finally {
  await browser.close();
  server.kill();
  mock.close();
  await pool.end();
}
