// Live check of the universal import on the deployed service, with the labelled import test site
// (/p/skyfly-import-test/: an AI-style page whose form and buttons sent orders to WhatsApp,
// imported and connected automatically, published in test mode in its own test business).
// Places ONE clearly labelled TEST ORDER. Pixel calls are intercepted, never sent.
//
//   SKYFLY_URL=https://<service>.onrender.com node test/e2e/live-import.e2e.js
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright-core';

const SKYFLY = (process.env.SKYFLY_URL || '').replace(/\/+$/, '');
if (!/^https:\/\/[a-z0-9-]+\.onrender\.com$|^http:\/\/localhost:\d+$/.test(SKYFLY) || /\/\/skyfly\.onrender\.com/.test(SKYFLY)) throw new Error('Set SKYFLY_URL to the verified Skyfly service address');
const SLUG = 'skyfly-import-test';
const PAGE = `${SKYFLY}/p/${SLUG}/`;
const RUN = process.env.GITHUB_RUN_ID || String(Date.now());
const NAME = `TEST ORDER Skyfly import E2E ${RUN} please ignore`;

let failed = 0; let blocked = 0;
class Blocked extends Error {}
async function step(name, fn) {
  try { const info = await fn(); console.log(`PASS  ${name}${info ? ` — ${info}` : ''}`); return true; }
  catch (err) {
    if (err instanceof Blocked) { blocked += 1; console.log(`BLOCKED  ${name} — ${err.message}`); return false; }
    failed += 1; console.log(`FAIL  ${name} — ${err.message}`); return false;
  }
}
const assert = (c, m) => { if (!c) throw new Error(m); };

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const ctx = await browser.newContext({
  viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
});
await ctx.route(/https:\/\/([a-z0-9-]+\.)*(facebook\.com|facebook\.net|tiktok\.com)\//, (r) => r.fulfill({ status: 204, body: '' }));
const navigations = []; const popups = []; const posts = []; const replies = [];
const page = await ctx.newPage();
ctx.on('page', (p) => { if (p !== page) { popups.push(p.url()); p.on('framenavigated', (f) => popups.push(f.url())); } });
page.on('framenavigated', (f) => { if (f === page.mainFrame()) navigations.push(f.url()); });
page.on('request', (r) => { if (r.method() === 'POST' && r.url().startsWith(`${SKYFLY}/api/public/orders`)) posts.push(r.postData()); });
page.on('response', async (r) => { if (r.request().method() === 'POST' && r.url().startsWith(`${SKYFLY}/api/public/orders`)) replies.push({ status: r.status(), body: await r.json().catch(() => null) }); });
const toWhatsApp = () => navigations.concat(popups).filter((u) => /wa\.me|whatsapp\.com/.test(u));

await step('A. The imported page is published at its generated address and opens on a phone without signing in', async () => {
  const res = await page.goto(PAGE, { waitUntil: 'load' });
  assert(res.status() === 200, `HTTP ${res.status()}`);
  await page.waitForFunction('window.Skyfly && window.Skyfly.version', null, { timeout: 30000 });
  assert(await page.isVisible('text=Aurora Glow Radiance Serum'), 'page content missing');
  assert(await page.$('form[data-skyfly-form="skyfly-import-test"][data-skyfly-exclusive]'), 'order form not connected');
  const width = await page.evaluate(() => document.documentElement.scrollWidth);
  assert(width <= 400, `horizontal scroll on a phone (${width}px)`);
  assert(!/\/login/.test(page.url()), 'redirected to sign-in');
  return `${PAGE} (HTTP 200, connected order form, Skyfly SDK loaded, fits a phone screen)`;
});

await step('B. "Order on WhatsApp" and "Order now" open the Skyfly order form with the product chosen — no WhatsApp', async () => {
  await page.click('text=Order on WhatsApp');
  await page.waitForTimeout(800);
  assert((await page.$eval('#pkg', (s) => s.options[s.selectedIndex].dataset.product)) === 'radiance-serum', 'Radiance Serum not chosen');
  await page.click('button:has-text("Order now")');
  await page.waitForTimeout(800);
  assert((await page.$eval('#pkg', (s) => s.options[s.selectedIndex].dataset.product)) === 'glow-duo', 'Glow Duo not chosen');
  assert(!toWhatsApp().length, `went to WhatsApp: ${toWhatsApp()}`);
  assert(page.url().startsWith(PAGE), `left the page: ${page.url()}`);
  return 'buttons that went to WhatsApp now choose the product in the order form';
});

await step('C. Invalid details are refused with a clear message and no confirmation', async () => {
  await page.fill('#fullname', NAME);
  await page.fill('#phone_number', '12');
  await page.fill('#addr', 'TEST ORDER - do not deliver, automated check');
  await page.click('button:has-text("Send my order")');
  await page.waitForSelector('[data-skyfly-error]', { state: 'visible', timeout: 60000 });
  const msg = (await page.textContent('[data-skyfly-error]')).trim();
  assert(replies.length === 1 && replies[0].status === 400, `reply ${JSON.stringify(replies)}`);
  assert(page.url().startsWith(PAGE) && !toWhatsApp().length, 'navigated after an invalid order');
  return `HTTP 400, shown: "${msg.slice(0, 90)}"`;
});

let reference = null; let confirmation = null;
await step('D. A labelled test order (double-clicked) is saved once under the import test business; the thank-you page follows the save', async () => {
  await page.fill('#phone_number', '08031234567');
  await page.fill('#city', 'Lagos');
  await page.selectOption('#size', { label: '50ml (+₦5,000 serum / +₦8,000 duo)' });
  const before = posts.length;
  await Promise.all([
    page.waitForURL(/\/o\/IT-[A-Z0-9]+/, { timeout: 120000 }),
    page.dblclick('button:has-text("Send my order")'),
  ]);
  const ok = replies.filter((r) => r.status === 201 || r.status === 200);
  assert(ok.length >= 1, `replies ${JSON.stringify(replies.slice(-3))}`);
  const r = ok[0].body;
  // Glow Duo Set ₦27,500 + 50ml ₦8,000 + delivery ₦2,500 (free only from ₦50,000), all priced by Skyfly.
  assert(r.saved === true && r.business === 'skyfly-import-test' && r.test === true && r.total === 38000 && r.deliveryFee === 2500 && r.currency === 'NGN', `reply ${JSON.stringify({ ...r, confirmationUrl: undefined })}`);
  assert(r.items?.[0]?.name === 'Glow Duo Set (Size: 50ml)', `items ${JSON.stringify(r.items)}`);
  assert(new Set(ok.map((x) => x.body.reference)).size === 1, 'two different orders from a double click');
  reference = r.reference; confirmation = page.url();
  return `${reference}, Glow Duo Set (Size: 50ml) ₦35,500 + delivery ₦2,500 = ₦38,000 (priced by Skyfly), business skyfly-import-test, test order; ${posts.length - before} submission(s) for the double click, 1 order`;
});

await step('E. The thank-you page shows the reference, the order summary and the WhatsApp button (optional, after the save)', async () => {
  assert(reference, 'no order');
  const text = (await page.textContent('body')).replace(/\s+/g, ' ');
  assert(text.includes(reference) && /Glow Duo Set \(Size: 50ml\)/.test(text) && /Delivery\s*₦2,500/.test(text) && /₦38,000/.test(text), 'reference/summary missing');
  const wa = await page.getAttribute('a[href*="wa.me"]', 'href');
  assert(wa && new RegExp(`^https://wa\\.me/2349049206695\\?text=.*${reference}`).test(decodeURIComponent(wa)), `WhatsApp link ${wa}`);
  assert(!toWhatsApp().length, 'opened WhatsApp automatically');
  mkdirSync('live-screenshots', { recursive: true });
  await page.screenshot({ path: 'live-screenshots/import-test-thank-you.png' });
  return `${reference}, Glow Duo Set (Size: 50ml) × 1, delivery ₦2,500, total ₦38,000; WhatsApp button to 09049206695 with the reference (not opened automatically)`;
});

await step('F. Sending the same submission again returns the same order (no duplicate)', async () => {
  const body = JSON.parse(posts.at(-1));
  const res = await fetch(`${SKYFLY}/api/public/orders`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'null' }, body: JSON.stringify(body) });
  const data = await res.json();
  assert(res.status === 200 && data.reference === reference && data.replayed === true, `HTTP ${res.status} ${JSON.stringify(data).slice(0, 200)}`);
  return `HTTP 200, same reference ${reference}, replayed`;
});

await step("G. Another business's products can't be ordered through this page, and this business's products can't be ordered through Larose's", async () => {
  const send = (landingPage, product) => fetch(`${SKYFLY}/api/public/orders`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'null' }, body: JSON.stringify({
    landingPage, idempotencyKey: `live-import-cross-${RUN}-${landingPage}`.slice(0, 90),
    customer: { name: NAME, phone: '08031234567', address: 'TEST ORDER - do not deliver' }, items: [{ product, quantity: 1 }] }) });
  const a = await send(SLUG, 'package-3');
  const b = await send('larose-skincare', 'glow-duo');
  assert(a.status === 400 && b.status === 400, `HTTP ${a.status} / ${b.status}`);
  return `Larose product on the import test page → HTTP ${a.status}; import test product on Larose's page → HTTP ${b.status}`;
});

await step('H. The order appears exactly once in the import test business dashboard', async () => {
  if (!process.env.SKYFLY_OWNER_EMAIL || !process.env.SKYFLY_OWNER_PASSWORD) throw new Blocked('needs the SKYFLY_OWNER_EMAIL and SKYFLY_OWNER_PASSWORD repository secrets (platform owner) to sign in; the start-up "Orders check" log lists it from the database');
  const d = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  await d.goto(`${SKYFLY}/login`);
  await d.fill('#email', process.env.SKYFLY_OWNER_EMAIL); await d.fill('#password', process.env.SKYFLY_OWNER_PASSWORD);
  await Promise.all([d.waitForLoadState('load'), d.click('button[type=submit]')]);
  await d.goto(`${SKYFLY}/?all=1`);
  const href = await d.getAttribute('a:text-is("Skyfly Import Test (test)")', 'href');
  assert(href, 'business not listed');
  await d.goto(`${SKYFLY}${href}/orders?q=${reference}`);
  const rows = await d.getByRole('link', { name: reference, exact: true }).count();
  assert(rows === 1, `${rows} rows`);
  return `1 row in ${href}/orders`;
});

await browser.close();
if (blocked) console.log(`\n${blocked} check(s) BLOCKED (missing credential, see above)`);
console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks that could run passed');
process.exit(failed ? 1 : 0);
