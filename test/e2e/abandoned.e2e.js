// End-to-end test of abandoned checkouts in mobile Chromium: a landing page on its own website with
// Skyfly's drop-in checkout, a running Skyfly server, and two businesses.
//   1. a customer starts checking out → progress saved in Skyfly as they go
//   2. refresh → nothing lost on this device
//   3. connection lost while typing → saved once it is back
//   4. the page is closed straight after typing → still saved
//   5. idle → abandoned; only its own business sees it
//   6. a resume link on another device brings back the products → order placed (double-tapped) →
//      one order; the checkout shows as recovered
//
//   npm run test:e2e:abandoned
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { chromium, devices } from 'playwright-core';
import { createPool } from '../../src/db.js';
import { hashPassword } from '../../src/lib/passwords.js';
import { resetDatabase, testDatabaseUrl } from '../helpers.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const shots = path.join(root, 'test/e2e/screenshots/abandoned');
mkdirSync(shots, { recursive: true });
const SKYFLY = 'http://localhost:3500';
const SHOP = 'http://127.0.0.1:3201';
const pool = createPool(testDatabaseUrl(), false);
await resetDatabase(pool);

const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Glow shop</title></head>
<body><h1>Glow shop</h1><div data-skyfly-checkout="shop-a"></div><script src="${SKYFLY}/sdk/skyfly.js" data-page="shop-a"></script></body></html>`;
const shop = createServer((req, res) => {
  if (req.url.startsWith('/shop/')) { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(html); }
  res.writeHead(404).end();
}).listen(3201);

const server = spawn('node', ['src/server.js'], {
  cwd: root,
  env: { ...process.env, PORT: '3500', NODE_ENV: 'development', DATABASE_URL: testDatabaseUrl(), SESSION_SECRET: 'e2e-secret', ALLOW_SIGNUP: 'true', PUBLIC_BASE_URL: SKYFLY },
  stdio: ['ignore', 'ignore', 'inherit'],
});
for (let i = 0; i < 100; i += 1) {
  try { if ((await fetch(`${SKYFLY}/healthz`)).ok) break; } catch { /* starting */ }
  await new Promise((r) => setTimeout(r, 200));
}

// Two businesses, each with its own owner, product and page.
const ids = {};
for (const biz of ['a', 'b']) {
  const { rows: [u] } = await pool.query("INSERT INTO users (email, password_hash, name) VALUES ($1, $2, 'Owner') RETURNING id", [`owner-${biz}@shop.test`, await hashPassword('owner-password-123')]);
  const { rows: [b] } = await pool.query(
    "INSERT INTO businesses (owner_id, name, slug, currency, order_prefix, subscription_status) VALUES ($1, $2, $3, 'NGN', $4, 'internal') RETURNING id",
    [u.id, `Shop ${biz.toUpperCase()}`, `shop-${biz}`, biz === 'a' ? 'SA' : 'SB']);
  await pool.query("INSERT INTO business_members (business_id, user_id, role) VALUES ($1, $2, 'owner')", [b.id, u.id]);
  const { rows: [lp] } = await pool.query("INSERT INTO landing_pages (business_id, name, slug, url, status) VALUES ($1, $2, $3, $4, 'active') RETURNING id", [b.id, `Page ${biz}`, `shop-${biz}`, `${SHOP}/shop/`]);
  for (const [code, name, price] of [['starter', 'Starter Glow', 2650000], ['combo', 'Glow Combo', 3650000]]) {
    const { rows: [p] } = await pool.query('INSERT INTO products (business_id, code, name, price_minor) VALUES ($1, $2, $3, $4) RETURNING id', [b.id, code, name, price]);
    await pool.query('INSERT INTO landing_page_products (landing_page_id, product_id) VALUES ($1, $2)', [lp.id, p.id]);
  }
  if (biz === 'a') {
    const { rows: [up] } = await pool.query("INSERT INTO products (business_id, code, name, price_minor) VALUES ($1, 'facial-set', 'Facial Set', 1700000) RETURNING id", [b.id]);
    await pool.query('UPDATE landing_pages SET upsell_product_id = $2 WHERE id = $1', [lp.id, up.id]);
  }
  ids[biz] = b.id;
}

const browser = await chromium.launch();
const results = [];
const step = async (name, fn) => { await fn(); results.push(name); console.log(`  ✓ ${name}`); };
const sessions = async () => (await pool.query('SELECT * FROM checkout_sessions ORDER BY id')).rows;
const waitFor = async (check, what, ms = 15000) => {
  for (let t = 0; t < ms; t += 250) { const v = await check(); if (v) return v; await new Promise((r) => setTimeout(r, 250)); }
  throw new Error(`timed out waiting for ${what}`);
};

try {
  const phone = await browser.newContext({ ...devices['iPhone 13'] });
  const page = await phone.newPage();
  let token;

  await step('a customer chooses a package, quantity and the add-on and types their details: saved in Skyfly as they go, priced by Skyfly', async () => {
    await page.goto(`${SHOP}/shop/?utm_source=facebook&utm_campaign=oct`);
    await page.waitForSelector('input[name=sky_product]');
    await page.check('input[name=sky_product][value=combo]');
    await page.selectOption('#sky-qty', '2');
    await page.click('[data-addon]');
    await page.fill('#sky-name', 'Ngozi Adeyemi');
    await page.fill('#sky-phone', '08051234567');
    await page.fill('#sky-address', '14 Admiralty Way, Lekki');
    const s = await waitFor(async () => (await sessions()).find((x) => x.address === '14 Admiralty Way, Lekki'), 'the saved session');
    token = s.token;
    assert.equal(String(s.business_id), String(ids.a));
    assert.equal(s.status, 'active');
    assert.equal(s.phone, '+2348051234567');
    assert.deepEqual(s.items.map((i) => [i.code, i.quantity, i.upsell]), [['combo', 2, false], ['facial-set', 1, true]]);
    assert.equal(Number(s.total_minor), 2 * 3650000 + 1700000);
    assert.equal(s.utm_campaign, 'oct');
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM orders')).rows[0].n, 0, 'no order');
    await page.screenshot({ path: path.join(shots, '1-checkout-in-progress.png') });
  });

  await step('refresh: the package, quantity, add-on and typed details are all still there', async () => {
    await page.reload();
    await page.waitForSelector('input[name=sky_product]');
    assert.equal(await page.isChecked('input[name=sky_product][value=combo]'), true);
    assert.equal(await page.inputValue('#sky-qty'), '2');
    assert.match(await page.textContent('[data-addon]'), /Added/);
    assert.equal(await page.inputValue('#sky-name'), 'Ngozi Adeyemi');
    assert.equal(await page.inputValue('#sky-address'), '14 Admiralty Way, Lekki');
    assert.equal((await sessions()).length, 1, 'the same session continues');
  });

  await step('the connection drops while typing: nothing is lost, and it is saved as soon as the connection is back', async () => {
    await phone.setOffline(true);
    await page.fill('#sky-email', 'ngozi@example.com');
    await page.waitForTimeout(2500);
    assert.equal((await sessions())[0].email, null, 'not saved while offline');
    await phone.setOffline(false);
    await waitFor(async () => (await sessions())[0].email === 'ngozi@example.com', 'the save after reconnecting', 25000);
  });

  await step('the customer types a note and closes the page straight away: the last change is still saved', async () => {
    await page.fill('#sky-notes', 'Call before delivery');
    await page.close({ runBeforeUnload: true });
    await waitFor(async () => (await sessions())[0].notes === 'Call before delivery', 'the save on closing the page');
  });

  await step('after the idle time the checkout is abandoned, shown to its own business only (status, contact, products, value)', async () => {
    await pool.query("UPDATE checkout_sessions SET last_activity_at = now() - interval '2 hours'");
    const owner = await browser.newContext({ ...devices['iPhone 13'] });
    const o = await owner.newPage();
    await o.goto(`${SKYFLY}/login`);
    await o.fill('#email', 'owner-a@shop.test'); await o.fill('#password', 'owner-password-123');
    await Promise.all([o.waitForLoadState('load'), o.click('main button[type=submit]')]);
    await o.goto(`${SKYFLY}/businesses/${ids.a}/checkouts`);
    const list = await o.textContent('main');
    assert.match(list, /Abandoned/);
    assert.match(list, /Ngozi Adeyemi/);
    assert.match(list, /Glow Combo × 2, Facial Set × 1 \(add-on\)/);
    assert.match(list, /₦90,000/);
    const width = await o.evaluate(() => document.documentElement.scrollWidth);
    assert.ok(width <= 390, `list scrolls sideways (${width}px)`);
    await o.screenshot({ path: path.join(shots, '2-dashboard-abandoned.png'), fullPage: true });
    await o.click('main a[href*="/checkouts/"] >> nth=0');
    assert.match(await o.getAttribute('[data-contact=whatsapp]', 'href'), /^https:\/\/wa\.me\/2348051234567\?text=/);
    await o.screenshot({ path: path.join(shots, '3-dashboard-follow-up.png'), fullPage: true });
    const other = await browser.newContext();
    const b = await other.newPage();
    await b.goto(`${SKYFLY}/login`);
    await b.fill('#email', 'owner-b@shop.test'); await b.fill('#password', 'owner-password-123');
    await Promise.all([b.waitForLoadState('load'), b.click('main button[type=submit]')]);
    const r = await b.request.get(`${SKYFLY}/businesses/${ids.a}/checkouts`, { maxRedirects: 0 });
    assert.equal(r.status(), 404);
    await b.goto(`${SKYFLY}/businesses/${ids.b}/checkouts?status=all`);
    assert.doesNotMatch(await b.textContent('main'), /Ngozi/);
    await owner.close(); await other.close();
  });

  await step('a resume link on another phone brings back the products (not the personal details); the order is placed, tapped twice → one order; the checkout is recovered', async () => {
    const other = await browser.newContext({ ...devices['iPhone 13'] });
    const p = await other.newPage();
    await p.goto(`${SHOP}/shop/?skyfly_checkout=${token}`);
    await p.waitForSelector('input[name=sky_product]');
    assert.equal(await p.isChecked('input[name=sky_product][value=combo]'), true);
    assert.equal(await p.inputValue('#sky-qty'), '2');
    assert.match(await p.textContent('[data-addon]'), /Added/);
    assert.equal(await p.inputValue('#sky-name'), '', 'personal details never travel in a link');
    await p.fill('#sky-name', 'Ngozi Adeyemi');
    await p.fill('#sky-phone', '08051234567');
    await p.fill('#sky-address', '14 Admiralty Way, Lekki');
    await p.click('button[type=submit]');
    await p.waitForSelector('[data-place]');
    await p.click('[data-place]');
    await p.click('[data-place]', { force: true, noWaitAfter: true }).catch(() => {});
    await p.waitForSelector('[data-skyfly-reference]');
    const ref = (await p.textContent('[data-skyfly-reference]')).trim();
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM orders')).rows[0].n, 1, 'exactly one order');
    const s = (await sessions())[0];
    assert.equal(s.status, 'recovered');
    const { rows: [o] } = await pool.query('SELECT id, total_minor FROM orders WHERE reference = $1', [ref]);
    assert.equal(String(s.order_id), String(o.id));
    assert.equal(Number(o.total_minor), 9000000);
    assert.equal((await sessions()).length, 1, 'no extra session');
    await p.screenshot({ path: path.join(shots, '4-order-placed.png') });
    // A new checkout on this phone afterwards is a new session (the old one is finished).
    await p.click('[data-again]');
    await p.fill('#sky-name', 'Next customer');
    await waitFor(async () => (await sessions()).length === 2, 'a new session');
    assert.equal((await sessions())[0].status, 'recovered');
    await other.close();
  });

  console.log(`\nAbandoned checkouts E2E passed: ${results.length} steps. Screenshots: ${shots}`);
} finally {
  await browser.close();
  server.kill();
  shop.close();
  await pool.end();
}
