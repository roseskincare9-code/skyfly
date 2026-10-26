// End-to-end: Tracking & Pixels with several Meta, TikTok and X IDs on one live page (mobile Chromium).
// IDs are added and switched off from the dashboard while the server keeps running (no redeploy).
// Checks: each ID loads once, only on its assigned pages; disabling one leaves the others; events
// reach the intended IDs; Purchase only after a saved real order (never for a test order), once per
// ID with the order's event ID; "tag loaded" is reported back; another business's IDs never load.
//   npm run test:e2e:tracking
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { chromium, devices } from 'playwright-core';
import { createPool } from '../../src/db.js';
import { seedLarose, LAROSE_META_PIXEL_ID, LAROSE_PIXEL_NEW_ID, LAROSE_AD_ACCOUNT_PIXELS } from '../../src/scripts/seed-larose.js';
import { resetDatabase, testDatabaseUrl, addTrackingPixel } from '../helpers.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const shots = path.join(root, 'test/e2e/screenshots/tracking');
mkdirSync(shots, { recursive: true });
const DASH = 'http://localhost:3103';
const PAGES = 'http://127.0.0.1:3103';
const LAROSE_IDS = [LAROSE_META_PIXEL_ID, LAROSE_PIXEL_NEW_ID, ...LAROSE_AD_ACCOUNT_PIXELS.map((p) => p.id)];
const META_PAGE = '5000000000000001'; // assigned to the new page only
const META_OTHER_PAGE = '5000000000000002'; // assigned to the Larose page only
const TT = ['D7E2EMULTI0000000001', 'D7E2EMULTI0000000002', 'D7E2EMULTI0000000003'];
const X = [{ id: 'o1e2ea', buy: 'b1buy', start: 'b1ic' }, { id: 'o2e2eb', buy: 'b2buy', start: '' }];

const PAGE_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Multi Track</title></head>
<body><h1>Multi Track</h1>
<form data-skyfly-form id="order" style="display:grid;gap:8px;padding:16px">
  <input name="name" placeholder="Name"><input name="phone" placeholder="Phone"><input name="address" placeholder="Address">
  <select name="state"><option>Lagos</option><option>Abuja</option></select>
  <select name="product"><option value="">Choose</option><option data-product="package-2" data-price="36500">Combo ₦36,500</option></select>
  <input name="quantity" value="1"><button type="submit">Order now</button>
</form></body></html>`;

const apiCalls = [];
const mock = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    apiCalls.push({ url: req.url, body: JSON.parse(body || '{}') });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(req.url.startsWith('/meta') ? '{"events_received":1}' : '{"code":0,"message":"OK"}');
  });
}).listen(3104);

const pool = createPool(testDatabaseUrl(), false);
await resetDatabase(pool);
const server = spawn('node', ['src/server.js'], {
  cwd: root,
  env: {
    ...process.env, PORT: '3103', NODE_ENV: 'development', DATABASE_URL: testDatabaseUrl(), SESSION_SECRET: 'e2e-secret',
    ALLOW_SIGNUP: 'true', ALLOWED_ORIGINS: '', PUBLIC_BASE_URL: DASH, PAGES_BASE_URL: PAGES,
    SKYFLY_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    META_GRAPH_BASE: 'http://127.0.0.1:3104/meta/v26.0', TIKTOK_API_BASE: 'http://127.0.0.1:3104/tiktok/v1.3',
  },
  stdio: ['ignore', 'inherit', 'inherit'],
});
for (let i = 0; i < 50; i += 1) {
  try { if ((await fetch(`${DASH}/healthz`)).ok) break; } catch { /* starting */ }
  await new Promise((r) => setTimeout(r, 200));
}

const browser = await chromium.launch();
let passed = 0;
const step = async (name, fn) => { await fn(); passed += 1; console.log(`  ✓ ${name}`); };
const noSideScroll = async (page, label) => {
  const w = await page.evaluate(() => document.documentElement.scrollWidth);
  assert.ok(w <= 390, `${label}: no horizontal scroll on mobile (got ${w}px)`);
};
const count = (list, pred) => list.filter(pred).length;

try {
  const context = await browser.newContext({ ...devices['iPhone 13'] });
  // Record what each platform's script is asked to do, instead of calling Meta, TikTok or X.
  const fb = []; const tt = []; const tw = [];
  await context.exposeBinding('recordFb', (_s, a) => fb.push(a));
  await context.exposeBinding('recordTt', (_s, a) => tt.push(a));
  await context.exposeBinding('recordTw', (_s, a) => tw.push(a));
  await context.route(/^https?:\/\/(?!localhost|127\.0\.0\.1)/, (route) => route.abort());
  await context.route('https://connect.facebook.net/**', (route) => route.fulfill({
    contentType: 'text/javascript',
    body: 'fbq.callMethod=function(){window.recordFb(Array.prototype.slice.call(arguments));};var q=fbq.queue.splice(0);q.forEach(function(a){fbq.callMethod.apply(null,a);});',
  }));
  await context.route('https://analytics.tiktok.com/**', (route) => route.fulfill({
    contentType: 'text/javascript',
    // Every TikTok pixel's queued calls, and later ones, are recorded with its ID.
    body: 'Object.keys(ttq._i).forEach(function(id){var a=ttq._i[id];if(a._rec)return;a._rec=1;a.splice(0).forEach(function(c){window.recordTt([id].concat(c));});a.push=function(c){window.recordTt([id].concat(c));};});',
  }));
  await context.route('https://static.ads-twitter.com/**', (route) => route.fulfill({
    contentType: 'text/javascript',
    body: 'twq.queue.splice(0).forEach(function(a){window.recordTw(Array.prototype.slice.call(a));});twq.exe=function(){window.recordTw(Array.prototype.slice.call(arguments));};',
  }));
  const dash = await context.newPage();
  let pageId; let laroseId; let liveUrl;

  await step('owner signs up; Larose (6 Meta pixels) is set up; a new page is imported, connected and published', async () => {
    await dash.goto(`${DASH}/signup`);
    await dash.fill('#name', 'Rose Owner'); await dash.fill('#email', 'owner@larose.test'); await dash.fill('#password', 'a-very-long-password');
    await dash.click('button[type=submit]');
    await dash.waitForURL(`${DASH}/`);
    await seedLarose(pool, 'owner@larose.test');
    laroseId = (await pool.query("SELECT id FROM landing_pages WHERE slug = 'larosenigeria'")).rows[0].id;
    await dash.goto(`${DASH}/businesses/1/landing-pages`);
    await dash.fill('#imp-name', 'Multi Track');
    await dash.setInputFiles('#imp-file', { name: 'index.html', mimeType: 'text/html', buffer: Buffer.from(PAGE_HTML) });
    await Promise.all([dash.waitForURL(/landing-pages\/\d+\?done=uploaded/), dash.click('form[enctype] button[type=submit]')]);
    pageId = dash.url().match(/landing-pages\/(\d+)/)[1];
    const settingsForm = dash.locator(`form[action$="/landing-pages/${pageId}"]`);
    await settingsForm.locator('input[name=products] >> nth=1').check();
    await settingsForm.locator('button[type=submit]').click();
    await dash.waitForURL(/landing-pages$/);
    await dash.goto(`${DASH}/businesses/1/landing-pages/${pageId}`);
    await dash.click('button:has-text("Publish this version")');
    await dash.waitForURL(/done=published/);
    liveUrl = await dash.getAttribute('#live-url', 'href');
    assert.equal(liveUrl, `${PAGES}/multi-track/`);
  });

  const addId = async (platform, fields) => {
    await dash.goto(`${DASH}/businesses/1/pixels?platform=${platform}`);
    await dash.click('[data-add]');
    await dash.waitForURL(new RegExp(`pixels/new\\?platform=${platform}`));
    await dash.fill('#name', fields.name);
    await dash.fill('#pixel_id', fields.id);
    if (fields.allPages) await dash.check('input[name=all_pages]');
    for (const p of fields.pages ?? []) await dash.check(`input[name=pages][value="${p}"]`);
    for (const [e, v] of Object.entries(fields.xEvents ?? {})) if (v) await dash.fill(`#x_event_${e}`, v);
    await dash.click('[data-tracking-form] button[type=submit]');
    await dash.waitForURL(new RegExp(`pixels\\?platform=${platform}&done=added`));
  };

  await step('add Meta, TikTok and X tracking IDs from the dashboard, each assigned to chosen pages (server keeps running)', async () => {
    await addId('meta', { name: 'Meta for Multi Track', id: META_PAGE, pages: [pageId] });
    await addId('meta', { name: 'Meta for Larose page', id: META_OTHER_PAGE, pages: [laroseId] });
    await addId('tiktok', { name: 'TikTok A', id: TT[0], pages: [pageId] });
    await addId('tiktok', { name: 'TikTok B', id: TT[1], allPages: true });
    await addId('tiktok', { name: 'TikTok C', id: TT[2], pages: [pageId] });
    await addId('x', { name: 'X main', id: X[0].id, pages: [pageId], xEvents: { Purchase: `tw-${X[0].id}-${X[0].buy}`, InitiateCheckout: X[0].start } });
    await addId('x', { name: 'X second', id: X[1].id, pages: [pageId], xEvents: { Purchase: X[1].buy } });
    const tab = await dash.textContent('nav[role=tablist]');
    assert.match(tab, /Meta[\s\S]*8 on \/ 8[\s\S]*TikTok[\s\S]*3 on \/ 3[\s\S]*X[\s\S]*2 on \/ 2/);
    assert.equal(await dash.locator('tr[data-pixel]').count(), 2);
    await noSideScroll(dash, 'X tab');
    await dash.screenshot({ path: path.join(shots, 't1-x-tab-mobile.png'), fullPage: true });
    await dash.goto(`${DASH}/businesses/1/pixels/new?platform=x`);
    await noSideScroll(dash, 'add X form');
    await dash.screenshot({ path: path.join(shots, 't2-add-x-mobile.png'), fullPage: true });
  });

  // Another business with an X and a Meta ID on all of its pages: never on Larose's pages.
  const { rows: [u] } = await pool.query("INSERT INTO users (email, password_hash, name) VALUES ('other@shop.test', 'x', 'Other') RETURNING id");
  const other = (await pool.query("INSERT INTO businesses (owner_id, name, slug, currency) VALUES ($1, 'Other Shop', 'other-shop', 'NGN') RETURNING id", [u.id])).rows[0].id;
  await addTrackingPixel(pool, other, { platform: 'meta', pixelId: '6000000000000001' });
  await addTrackingPixel(pool, other, { platform: 'x', pixelId: 'o9other', settings: { eventIds: { Purchase: 'o9buy' } } });

  const shop = await context.newPage();
  shop.on('pageerror', (e) => console.log('    [page error]', e.message));
  const loadPage = async (query = '') => {
    fb.length = 0; tt.length = 0; tw.length = 0;
    await shop.goto(`${liveUrl}${query}`);
    await shop.waitForFunction(() => window.Skyfly && window.twq && window.twq.exe && window.ttq && Object.values(window.ttq._i).every((a) => a._rec));
    await shop.waitForTimeout(300);
  };
  const metaInits = () => fb.filter((c) => c[0] === 'init').map((c) => c[1]);
  const ttIds = (name) => [...new Set(tt.filter((c) => c[1] === name || c[2] === name).map((c) => c[0]))];

  await step('the live page loads every assigned ID once: 7 Meta, 3 TikTok, 2 X; nothing from other pages or businesses', async () => {
    await loadPage();
    assert.deepEqual(metaInits().sort(), [...LAROSE_IDS, META_PAGE].sort());
    for (const id of [...LAROSE_IDS, META_PAGE]) assert.equal(count(fb, (c) => c[0] === 'trackSingle' && c[1] === id && c[2] === 'PageView'), 1, `PageView once for ${id}`);
    assert.equal(count(fb, (c) => c[2] === 'PageView'), 7);
    assert.ok(!metaInits().includes(META_OTHER_PAGE) && !metaInits().includes('6000000000000001'));
    assert.deepEqual(ttIds('page').sort(), [...TT].sort());
    for (const id of TT) assert.equal(count(tt, (c) => c[0] === id && c[1] === 'page'), 1);
    assert.deepEqual(tw.filter((c) => c[0] === 'config').map((c) => c[1]).sort(), X.map((x) => x.id).sort());
    assert.ok(!JSON.stringify(tw).includes('o9other'));
    assert.ok(!/token/i.test(await shop.evaluate(() => JSON.stringify(window.__SKYFLY__))));
  });

  await step('the page reports which tags loaded; the dashboard shows "Tag loaded" for them', async () => {
    await shop.waitForTimeout(2500); // the report goes once, shortly after the scripts load
    const { rows } = await pool.query('SELECT platform, pixel_id FROM tracking_pixels WHERE business_id = 1 AND browser_seen_at IS NOT NULL ORDER BY 1, 2');
    const seen = rows.map((r) => `${r.platform}:${r.pixel_id}`);
    for (const id of [META_PAGE, ...LAROSE_IDS]) assert.ok(seen.includes(`meta:${id}`), id);
    for (const id of TT) assert.ok(seen.includes(`tiktok:${id}`), id);
    for (const x of X) assert.ok(seen.includes(`x:${x.id}`), x.id);
    assert.ok(!seen.includes(`meta:${META_OTHER_PAGE}`), 'not on this page, so not reported');
    await dash.goto(`${DASH}/businesses/1/pixels?platform=x`);
    assert.match(await dash.textContent(`tr[data-pixel="${X[0].id}"] [data-statuses]`), /Tag loaded/);
  });

  await step('switching one TikTok ID off from the dashboard removes only it; the others keep tracking', async () => {
    await dash.goto(`${DASH}/businesses/1/pixels?platform=tiktok`);
    await dash.locator(`tr[data-pixel="${TT[2]}"] button:has-text("Disable")`).click();
    await dash.waitForURL(/done=off/);
    assert.equal(await dash.getAttribute(`tr[data-pixel="${TT[2]}"]`, 'data-enabled'), 'false');
    await loadPage();
    assert.deepEqual(ttIds('page').sort(), [TT[0], TT[1]].sort());
    assert.equal(metaInits().length, 7);
    assert.equal(tw.filter((c) => c[0] === 'config').length, 2);
  });

  const fillOrder = async (name, phone) => {
    await shop.click('input[name=name]');
    await shop.fill('input[name=name]', name);
    await shop.fill('input[name=phone]', phone);
    await shop.fill('input[name=address]', '22 Glow Street, Abuja');
    await shop.selectOption('select[name=state]', 'Abuja');
    await shop.selectOption('select[name=product]', { index: 1 });
    await shop.click('button[type=submit]');
    await shop.waitForURL(/\/o\/LR-/);
    await shop.waitForTimeout(300);
    return new URL(shop.url()).pathname.split('/').pop();
  };
  const purchases = () => ({
    meta: fb.filter((c) => c[2] === 'Purchase'),
    tiktok: tt.filter((c) => c[1] === 'track' && c[2] === 'CompletePayment'),
    x: tw.filter((c) => c[0] === 'event' && /-b\dbuy$/.test(c[1])),
  });

  await step('InitiateCheckout reaches each ID once (X only where it has that event ID); a test order sends no Purchase anywhere', async () => {
    await loadPage();
    await shop.click('input[name=name]');
    await shop.click('input[name=phone]');
    assert.equal(count(fb, (c) => c[2] === 'InitiateCheckout'), 7);
    assert.equal(count(tt, (c) => c[2] === 'InitiateCheckout'), 2);
    assert.deepEqual(tw.filter((c) => c[0] === 'event').map((c) => c[1]), [`tw-${X[0].id}-${X[0].start}`]);
    const calls = apiCalls.length;
    const ref = await fillOrder('TEST ORDER tracking e2e', '0809 111 2222');
    const p = purchases();
    assert.deepEqual([p.meta.length, p.tiktok.length, p.x.length], [0, 0, 0], `no Purchase for test order ${ref}`);
    const { rows: [o] } = await pool.query('SELECT is_test FROM orders WHERE reference = $1', [ref]);
    assert.equal(o.is_test, true);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(apiCalls.length, calls, 'and no server Purchase');
  });

  await step('a real saved order: one Purchase per ID on the page (7 Meta, 2 TikTok, 2 X), with the order\'s event ID and total', async () => {
    await loadPage();
    const ref = await fillOrder('Halima Bello', '0809 333 4444');
    const { rows: [o] } = await pool.query('SELECT is_test, total_minor FROM orders WHERE reference = $1', [ref]);
    assert.equal(o.is_test, false);
    const p = purchases();
    assert.deepEqual(p.meta.map((c) => c[1]).sort(), [...LAROSE_IDS, META_PAGE].sort());
    for (const c of p.meta) assert.deepEqual([c[0], c[3].value, c[3].currency, c[4]], ['trackSingle', o.total_minor / 100, 'NGN', { eventID: `purchase_${ref}` }]);
    assert.deepEqual(p.tiktok.map((c) => c[0]).sort(), [TT[0], TT[1]].sort());
    for (const c of p.tiktok) assert.deepEqual(c[4], { event_id: `purchase_${ref}` });
    assert.deepEqual(p.x.map((c) => c[1]).sort(), [`tw-${X[0].id}-${X[0].buy}`, `tw-${X[1].id}-${X[1].buy}`].sort());
    for (const c of p.x) assert.deepEqual(c[2], { value: o.total_minor / 100, currency: 'NGN', conversion_id: `purchase_${ref}` });
    assert.ok(!tt.some((c) => c[0] === TT[2]), 'the disabled ID gets nothing');
    assert.ok(!fb.some((c) => c[1] === META_OTHER_PAGE), 'the other page\'s ID gets nothing');
  });

  await step('the check panel (?skyfly_debug=1) lists every ID on the page and its events', async () => {
    await loadPage('?skyfly_debug=1');
    await shop.waitForSelector('#skyfly-debug');
    const rows = await shop.$$eval('[data-skyfly-debug-pixel]', (els) => els.map((e) => e.getAttribute('data-skyfly-debug-pixel')));
    assert.equal(rows.length, 7 + 2 + 2);
    assert.ok(rows.includes(`x:${X[0].id}`) && rows.includes(`tiktok:${TT[0]}`) && rows.includes(`meta:${META_PAGE}`));
    assert.match(await shop.textContent('#skyfly-debug'), /PageView/);
    await shop.screenshot({ path: path.join(shots, 't3-check-panel-mobile.png') });
  });

  await step('removing an ID asks for confirmation and leaves the others; the Larose page keeps its pixels', async () => {
    const { rows: [x2] } = await pool.query('SELECT id FROM tracking_pixels WHERE pixel_id = $1', [X[1].id]);
    await dash.goto(`${DASH}/businesses/1/pixels/${x2.id}/remove`);
    assert.match(await dash.textContent('[data-dependencies]'), /Multi Track/);
    await noSideScroll(dash, 'remove');
    await dash.fill('#confirm', X[1].id);
    await dash.click('button:has-text("Remove tracking ID")');
    await dash.waitForURL(/done=removed/);
    await loadPage();
    assert.deepEqual(tw.filter((c) => c[0] === 'config').map((c) => c[1]), [X[0].id]);
    const cfg = await (await fetch(`${DASH}/api/public/pages/larosenigeria/tracking`)).json();
    assert.deepEqual(cfg.pixels.map((p) => p.id), [...LAROSE_IDS, META_OTHER_PAGE, TT[1]]);
  });

  console.log(`\nTracking E2E passed: ${passed} steps. Screenshots: ${shots}`);
} finally {
  await browser.close();
  server.kill();
  mock.close();
  await pool.end();
}
