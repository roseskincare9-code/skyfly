// End-to-end onboarding of real-style businesses, only through the dashboard (no code, no seed):
// the platform admin creates two businesses and invites their owners; each owner sets a WhatsApp
// number, adds a product and a Meta pixel, imports a landing page, edits it, saves and publishes
// it, copies its public address (stable after re-login and republishing), and a customer orders on
// the published page on a phone: the order is saved under the right business, shown in its
// dashboard, the WhatsApp hand-off uses that business's own number, and pixels fire PageView once
// and Purchase once after the save. Business B's "WhatsApp direct" page can't be published without
// its own number, and neither owner can see the other's data. Isolated: local server, test database.
//   npm run test:e2e:onboarding
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { chromium, devices } from 'playwright-core';
import { createPool } from '../../src/db.js';
import { resetDatabase, testDatabaseUrl } from '../helpers.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const shots = path.join(root, 'test/e2e/screenshots/onboarding');
mkdirSync(shots, { recursive: true });
const DASH = 'http://localhost:3104';
const PAGES = 'http://127.0.0.1:3104';
const PIXEL_A = '2100000000000041';

// A page made elsewhere: its "Order" buttons go to some other WhatsApp number (Skyfly re-points them).
const pageHtml = (title) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title><style>body{font-family:sans-serif;margin:0;padding:16px}h1{color:#7b2d8b}</style></head>
<body><h1>${title}</h1><p>Natural glow serum for every skin type. Gentle, fast and made with care.</p>
<a class="cta" href="https://wa.me/2348000000000?text=I%20want%20to%20order">Order on WhatsApp</a></body></html>`;
const pageFile = (name) => { const p = path.join(root, `test/e2e/.${name}.html`); writeFileSync(p, pageHtml(name === 'glow' ? 'Glow Serum Promo' : 'Second Shop Promo')); return p; };

const pool = createPool(testDatabaseUrl(), false);
await resetDatabase(pool);
const server = spawn('node', ['src/server.js'], {
  cwd: root,
  env: {
    ...process.env, PORT: '3104', NODE_ENV: 'development', DATABASE_URL: testDatabaseUrl(), SESSION_SECRET: 'e2e-secret',
    ALLOW_SIGNUP: 'first', ALLOWED_ORIGINS: '', PUBLIC_BASE_URL: DASH, PAGES_BASE_URL: PAGES,
    SKYFLY_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  },
  stdio: ['ignore', 'inherit', 'inherit'],
});
for (let i = 0; i < 50; i += 1) {
  try { if ((await fetch(`${DASH}/healthz`)).ok) break; } catch { /* starting */ }
  await new Promise((r) => setTimeout(r, 200));
}

let passed = 0;
async function step(name, fn) {
  try { await fn(); passed += 1; console.log(`  ✓ ${name}`); } catch (err) { console.error(`  ✗ ${name}\n`, err); throw err; }
}
const browser = await chromium.launch();
const expires = new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10);

try {
  const admin = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  const invites = {};

  await step('the platform admin signs up and creates two businesses, each with an invitation for its owner', async () => {
    await admin.goto(`${DASH}/signup`);
    await admin.fill('#name', 'Platform Owner'); await admin.fill('#email', 'platform@skyfly.test'); await admin.fill('#password', 'a-very-long-password');
    await Promise.all([admin.waitForLoadState('load'), admin.click('button[type=submit]')]);
    for (const [key, name, email] of [['a', 'Glow Test Shop', 'owner-a@glow.test'], ['b', 'Second Test Shop', 'owner-b@second.test']]) {
      await admin.goto(`${DASH}/admin/businesses/new`);
      await admin.fill('#name', name); await admin.fill('[name=owner_email]', email);
      await admin.selectOption('#subscription_status', 'trial'); await admin.fill('#expires_on', expires);
      await Promise.all([admin.waitForLoadState('load'), admin.click('form[action="/admin/businesses"] button[type=submit]')]);
      if (!(await admin.locator('.notice code').count())) throw new Error(`no invitation link: ${(await admin.textContent('main')).replace(/\s+/g, ' ').slice(0, 400)}`);
      invites[key] = (await admin.textContent('.notice code')).trim();
      assert.match(invites[key], /\/invite\//);
    }
  });

  const owners = {};
  await step('each owner registers with the invitation link and lands in their own business only', async () => {
    for (const [key, name] of [['a', 'Owner A'], ['b', 'Owner B']]) {
      const p = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
      await p.goto(invites[key]);
      await p.fill('#name', name); await p.fill('#password', 'another-long-password');
      await Promise.all([p.waitForURL(/\/businesses\/\d+/), p.click('button:text-is("Create account and join")')]);
      owners[key] = { page: p, base: new URL(p.url()).pathname.match(/^\/businesses\/\d+/)[0] };
    }
    assert.notEqual(owners.a.base, owners.b.base);
  });

  const setUp = async (o, { whatsapp, product, code, price }) => {
    const p = o.page;
    if (whatsapp) {
      await p.goto(`${DASH}${o.base}/settings`);
      await p.fill('#whatsapp_number', whatsapp);
      await Promise.all([p.waitForLoadState('load'), p.click('button:text-is("Save settings")')]);
    }
    await p.goto(`${DASH}${o.base}/products`);
    await p.fill('#name', product); await p.fill('#code', code); await p.fill('#price', String(price));
    await Promise.all([p.waitForLoadState('load'), p.locator(`form[action="${o.base}/products"] button[type=submit]`).click()]);
  };
  await step('owner A sets the business WhatsApp number and adds a product; owner B adds a product (no WhatsApp number yet)', async () => {
    await setUp(owners.a, { whatsapp: '08031112222', product: 'Glow Serum', code: 'glow-serum', price: 15000 });
    await setUp(owners.b, { product: 'Second Cream', code: 'second-cream', price: 9000 });
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM products")).rows[0].n, 2);
  });

  await step('owner A adds a Meta pixel in Tracking & Pixels (no code)', async () => {
    const p = owners.a.page;
    await p.goto(`${DASH}${owners.a.base}/pixels/new?platform=meta`);
    await p.fill('#name', 'Glow ads'); await p.fill('#pixel_id', PIXEL_A); await p.check('input[name=all_pages]');
    await Promise.all([p.waitForURL(/done=added/), p.click('button:text-is("Save and start tracking")')]);
  });

  // Import → connect checkout and product → edit → save → publish; returns the public address.
  const importAndPublish = async (o, { file, name, productLabel, destination }) => {
    const p = o.page;
    await p.goto(`${DASH}${o.base}/landing-pages`);
    assert.match(await p.textContent('[data-page-allowance]'), /0 of 4 landing pages used/);
    await p.fill('#imp-name', name);
    await p.setInputFiles('#imp-file', file);
    await Promise.all([p.waitForURL(/done=uploaded/), p.click('form[enctype] button[type=submit]')]);
    const pageUrl = p.url().split('?')[0];
    await Promise.all([p.waitForURL(/done=checkout/), p.click('button:text-is("Add Skyfly checkout")')]);
    for (const box of await p.locator('input[name=products]').all()) await box.check();
    await p.check(`input[name=order_destination][value=${destination}]`);
    await Promise.all([p.waitForLoadState('load'), p.click('form.card >> button:text-is("Save")')]);
    // Edit in the builder: the headline, saved as a new version.
    await p.goto(pageUrl);
    await Promise.all([p.waitForLoadState('load'), p.locator('a:text-is("Edit")').first().click()]);
    await p.evaluate(() => document.querySelectorAll('details').forEach((d) => { d.open = true; }));
    const headline = p.locator('input[id^=text_]').first();
    assert.ok(/Promo/.test(await headline.inputValue()), 'the headline is editable');
    await headline.fill(`${name} — edited`);
    await Promise.all([p.waitForLoadState('load'), p.locator('button:text-is("Save as new version")').first().click()]);
    await p.goto(pageUrl);
    return { pageUrl, productLabel };
  };
  const publish = async (p, pageUrl) => {
    await p.goto(pageUrl);
    await Promise.all([p.waitForLoadState('load'), p.locator('button:text-is("Publish this version")').first().click()]);
  };

  let a;
  await step('owner A imports a landing page, connects the checkout and product, edits the headline, saves and publishes it', async () => {
    a = await importAndPublish(owners.a, { file: pageFile('glow'), name: 'Glow Serum Promo', productLabel: 'Glow Serum', destination: 'checkout_whatsapp' });
    await publish(owners.a.page, a.pageUrl);
    assert.match(owners.a.page.url(), /done=published/, `not published: ${owners.a.page.url()}`);
    a.live = await owners.a.page.getAttribute('#live-url', 'href');
    assert.match(a.live, new RegExp(`^${PAGES}/glow-serum-promo/$`));
    assert.equal(await owners.a.page.locator('[data-copy="live-url-text"]').count(), 1, 'a Copy link button');
    const html = await (await fetch(a.live)).text();
    assert.match(html, /Glow Serum Promo — edited/, 'the edited version is live');
  });

  await step('the public address stays the same after logging out and in, and after editing and republishing (no second page)', async () => {
    const p = owners.a.page;
    await p.goto(`${DASH}/logout`).catch(() => {});
    await p.context().clearCookies();
    await p.goto(`${DASH}/login`);
    await p.fill('#email', 'owner-a@glow.test'); await p.fill('#password', 'another-long-password');
    await Promise.all([p.waitForLoadState('load'), p.click('button[type=submit]')]);
    await p.goto(a.pageUrl);
    assert.equal(await p.getAttribute('#live-url', 'href'), a.live);
    await Promise.all([p.waitForLoadState('load'), p.locator('a:text-is("Edit")').first().click()]);
    await p.evaluate(() => document.querySelectorAll('details').forEach((d) => { d.open = true; }));
    await p.locator('input[id^=text_]').first().fill('Glow Serum Promo — second edit');
    await Promise.all([p.waitForLoadState('load'), p.locator('button:text-is("Save as new version")').first().click()]);
    await publish(p, a.pageUrl);
    assert.equal(await p.getAttribute('#live-url', 'href'), a.live, 'same address after republishing');
    assert.match(await (await fetch(a.live)).text(), /second edit/);
    const { rows } = await pool.query("SELECT count(*)::int AS n FROM landing_pages WHERE slug LIKE 'glow-serum-promo%'");
    assert.equal(rows[0].n, 1, 'republishing does not create another page');
  });

  // The customer's phone: Meta's script is replaced by a recorder (nothing is sent to Meta).
  const phone = await browser.newContext({ ...devices['Pixel 5'] });
  const fb = [];
  await phone.exposeBinding('recordFb', (_src, args) => fb.push(args));
  await phone.route('https://connect.facebook.net/**', (route) => route.fulfill({
    contentType: 'text/javascript',
    body: 'fbq.callMethod=function(){window.recordFb(Array.prototype.slice.call(arguments));};var q=fbq.queue.splice(0);q.forEach(function(a){fbq.callMethod.apply(null,a);});',
  }));
  const events = (ev) => fb.filter((x) => x[0] === 'trackSingle' && x[1] === PIXEL_A && x[2] === ev);
  let reference;
  await step('a customer orders on the published page on a phone: saved under business A, thank-you with A\'s own WhatsApp number and the reference', async () => {
    const shop = await phone.newPage();
    await shop.goto(a.live);
    await shop.waitForTimeout(1500);
    assert.equal(events('PageView').length, 1, 'PageView once');
    await shop.click('text=Order on WhatsApp');
    await shop.waitForSelector('#sky-name', { timeout: 8000 }).catch(async (e) => {
      await shop.screenshot({ path: path.join(shots, 'a-debug.png'), fullPage: true });
      console.log('PAGE:', (await shop.content()).slice(0, 3000));
      throw e;
    });
    await shop.fill('#sky-name', 'Ada Test'); await shop.fill('#sky-phone', '08012345678');
    await shop.fill('#sky-address', '1 Test Street, Ikeja'); await shop.fill('#sky-state', 'Lagos');
    await shop.click('text=Review my order');
    await shop.click('text=Place my order');
    await shop.waitForSelector('.sky-ok', { timeout: 30000 });
    reference = (await shop.textContent('[data-skyfly-reference]')).trim();
    const wa = await shop.getAttribute('[data-skyfly-whatsapp]', 'href');
    assert.match(wa, new RegExp(`^https://wa\\.me/2348031112222\\?text=.*${reference}`), wa);
    assert.ok(!/2349049206695|2348000000000/.test(wa), 'never Larose\'s number or the page\'s old number');
    await shop.waitForTimeout(800);
    assert.equal(events('Purchase').length, 1, 'Purchase once, after the save');
    assert.equal(events('Purchase')[0][4]?.eventID, `purchase_${reference}`);
    // A refresh is not a second order or Purchase.
    await shop.reload();
    await shop.waitForTimeout(1200);
    assert.equal(events('Purchase').length, 1);
    await shop.screenshot({ path: path.join(shots, 'a-confirmation.png') });
    const { rows } = await pool.query(
      'SELECT b.name, o.total_minor FROM orders o JOIN businesses b ON b.id = o.business_id WHERE o.reference = $1', [reference]);
    assert.deepEqual(rows, [{ name: 'Glow Test Shop', total_minor: 1500000 }]);
  });

  await step('the order shows in business A\'s dashboard (with its product), and nowhere else', async () => {
    const p = owners.a.page;
    await p.goto(`${DASH}${owners.a.base}/orders`);
    assert.match(await p.textContent('body'), new RegExp(reference));
    const b = owners.b.page;
    await b.goto(`${DASH}${owners.b.base}/orders`);
    assert.doesNotMatch(await b.textContent('body'), new RegExp(reference));
    const res = await b.goto(`${DASH}${owners.a.base}/orders`);
    assert.equal(res.status(), 404, 'owner B cannot open business A');
    const px = await b.goto(`${DASH}${owners.a.base}/pixels`);
    assert.equal(px.status(), 404);
  });

  let bPage;
  await step('business B: a "WhatsApp direct" page cannot be published without B\'s own WhatsApp number (clear reason)', async () => {
    bPage = await importAndPublish(owners.b, { file: pageFile('second'), name: 'Second Shop Promo', productLabel: 'Second Cream', destination: 'whatsapp' });
    await publish(owners.b.page, bPage.pageUrl);
    assert.doesNotMatch(owners.b.page.url(), /done=published/);
    assert.match(await owners.b.page.textContent('body'), /no WhatsApp number, so customers could not order/);
  });

  await step('after B sets its number, the page publishes and its WhatsApp hand-off goes to B\'s number (not A\'s, not Larose\'s); no order is saved', async () => {
    const p = owners.b.page;
    await p.goto(`${DASH}${owners.b.base}/settings`);
    await p.fill('#whatsapp_number', '08059998888');
    await Promise.all([p.waitForLoadState('load'), p.click('button:text-is("Save settings")')]);
    await publish(p, bPage.pageUrl);
    assert.match(p.url(), /done=published/, (await p.locator('.error').allTextContents()).join(' | '));
    const live = await p.getAttribute('#live-url', 'href');
    const shop = await phone.newPage();
    await shop.goto(live);
    await shop.click('text=Order on WhatsApp');
    const link = await shop.waitForSelector('[data-skyfly-whatsapp-direct]');
    const href = await link.getAttribute('href');
    assert.match(href, /^https:\/\/wa\.me\/2348059998888\?text=.*Second%20Cream/, href);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM orders o JOIN businesses b ON b.id = o.business_id WHERE b.name = 'Second Test Shop'")).rows[0].n, 0);
    // B has no pixel: A's pixel never loads on B's page.
    const cfg = await shop.evaluate(() => (window.__SKYFLY__?.pixels || []).map((x) => x.id));
    assert.ok(!cfg.includes(PIXEL_A), 'no cross-business tracking');
  });

  await step('unpublishing takes A\'s page offline; republishing brings it back at the same address', async () => {
    const p = owners.a.page;
    await p.goto(a.pageUrl);
    await Promise.all([p.waitForURL(/done=unpublished/), p.click('button:text-is("Unpublish")')]);
    assert.equal((await fetch(a.live)).status, 404);
    await publish(p, a.pageUrl);
    assert.equal((await fetch(a.live)).status, 200);
  });

  console.log(`\nOnboarding E2E passed: ${passed} steps. Screenshots: ${shots}`);
} finally {
  await browser.close();
  server.kill();
  await pool.end();
}
