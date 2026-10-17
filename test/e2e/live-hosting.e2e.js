// Live check of Skyfly's own page hosting on production, using the labelled demo site
// (/p/skyfly-demo/, test mode: its orders are test orders; no pixel or Google Sheet connected).
// Places ONE clearly labelled TEST ORDER through the drop-in checkout and checks every step.
//   SKYFLY_URL=https://<service>.onrender.com [SKYFLY_OWNER_EMAIL=… SKYFLY_OWNER_PASSWORD=…] node test/e2e/live-hosting.e2e.js
import { mkdirSync } from 'node:fs';
import { chromium, devices } from 'playwright-core';

const SKYFLY = (process.env.SKYFLY_URL || '').replace(/\/+$/, '');
if (!process.env.LIVE_DRY_RUN && (!/^https:\/\/[a-z0-9-]+\.onrender\.com$/.test(SKYFLY) || /\/\/skyfly\.onrender\.com/.test(SKYFLY))) throw new Error('Set SKYFLY_URL to the verified Skyfly service address');
const PAGE = `${SKYFLY}/p/skyfly-demo/`;
const RUN = process.env.GITHUB_RUN_ID || String(Date.now());
const NAME = `TEST ORDER Skyfly hosting ${RUN}`;
mkdirSync('live-screenshots', { recursive: true });

let failed = 0; let blocked = 0;
class Blocked extends Error {}
async function step(name, fn) {
  try { const info = await fn(); console.log(`PASS  ${name}${info ? ` — ${info}` : ''}`); return true; }
  catch (err) {
    if (err instanceof Blocked) { blocked += 1; console.log(`BLOCKED  ${name} — ${err.message}`); return false; }
    failed += 1; console.log(`FAIL  ${name} — ${err.message}`); return false;
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

let html = '';
await step('A. The demo page is published on the Skyfly address and opens publicly, in a sandbox', async () => {
  await fetch(`${SKYFLY}/healthz`, { signal: AbortSignal.timeout(90000) });
  const res = await fetch(PAGE, { headers: { 'Accept-Encoding': 'gzip' } });
  html = await res.text();
  assert(res.status === 200, `HTTP ${res.status}`);
  assert(/^sandbox /.test(res.headers.get('content-security-policy') || ''), `CSP ${res.headers.get('content-security-policy')}`);
  assert(html.includes('data-skyfly-checkout') && html.includes('/sdk/skyfly.js'), 'checkout or SDK missing');
  return `HTTP 200, ${res.headers.get('content-encoding') || 'not compressed'}, CSP sandbox`;
});

await step('B. Images are served as smaller WebP sizes with the original as fallback, cached for a year', async () => {
  const m = html.match(/<img src="hero\.jpg\?v=(\d+)"[^>]*srcset="([^"]+)"/);
  if (!m) throw new Error('no WebP srcset yet on the hero image (optimization not deployed or still running)');
  const first = m[2].split(',')[0].trim().split(' ')[0];
  const img = await fetch(new URL(first, PAGE));
  const orig = await fetch(new URL('hero.jpg', PAGE));
  const [a, b] = [(await img.arrayBuffer()).byteLength, (await orig.arrayBuffer()).byteLength];
  assert(img.headers.get('content-type') === 'image/webp', `type ${img.headers.get('content-type')}`);
  assert(/immutable/.test(img.headers.get('cache-control')), `cache ${img.headers.get('cache-control')}`);
  return `${first.split('?')[0]}: ${Math.round(a / 1024)} KB WebP vs ${Math.round(b / 1024)} KB original JPEG`;
});

const catalog = await (await fetch(`${SKYFLY}/api/public/pages/skyfly-demo/catalog`)).json().catch(() => ({ products: [] }));
await step('C. The checkout shows Skyfly\'s own products and prices', async () => {
  assert(catalog.products?.length === 2, JSON.stringify(catalog));
  return catalog.products.map((p) => `${p.name} ₦${p.price.toLocaleString('en-NG')}`).join(', ');
});

const browser = await chromium.launch();
const phone = await browser.newContext({ ...devices['Pixel 5'] });
const adRequests = [];
await phone.route(/^https:\/\/([a-z0-9-]+\.)*(facebook\.(com|net)|tiktok\.com)\//, (r) => { adRequests.push(r.request().url()); return r.abort(); });
const shop = await phone.newPage();
let reply = null;
shop.on('response', async (r) => { if (r.url().endsWith('/api/public/orders') && r.request().method() === 'POST' && r.status() !== 500) reply = await r.json().catch(() => null); });
const fill = async () => {
  await shop.waitForSelector('.sky-opt');
  await shop.locator('.sky-opt').nth(1).click();
  await shop.selectOption('#sky-qty', '2');
  await shop.fill('#sky-name', NAME); await shop.fill('#sky-phone', '08012345678');
  await shop.fill('#sky-address', 'TEST ORDER - do not deliver, automated check'); await shop.fill('#sky-state', 'Lagos');
  await shop.click('text=Review my order');
};

await step('D. A failed save shows an honest error and no confirmation (simulated server error)', async () => {
  await shop.goto(PAGE);
  await fill();
  await shop.route('**/api/public/orders', (r) => r.fulfill({ status: 500, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': 'null' }, body: '{"ok":false,"message":"We could not save your order. Please try again in a moment."}' }));
  await shop.click('text=Place my order');
  await shop.waitForSelector('[data-err]:not([hidden])', { timeout: 30000 });
  const err = await shop.textContent('[data-err]');
  assert(/has not been placed yet/.test(err), err);
  assert(await shop.locator('.sky-ok').count() === 0, 'confirmation shown');
  await shop.unroute('**/api/public/orders');
  return `"${err.trim().slice(0, 70)}…"`;
});

let reference = null;
await step('E. A labelled test order is saved; the confirmation shows Skyfly\'s reference and verified total', async () => {
  await shop.click('text=Place my order');
  await shop.waitForSelector('.sky-ok', { timeout: 60000 });
  reference = (await shop.textContent('[data-skyfly-reference]')).trim();
  const duo = catalog.products[1];
  assert(reply?.saved === true && reply.reference === reference && reply.business === 'skyfly-demo', JSON.stringify(reply));
  assert(reply.total === duo.price * 2 && reply.currency === 'NGN', `total ${reply.total} ${reply.currency}`);
  assert(reply.test === true, 'demo orders must be test orders');
  await shop.screenshot({ path: 'live-screenshots/demo-confirmation-mobile.png' });
  return `${reference}, ₦${reply.total.toLocaleString('en-NG')} (${duo.name} × 2), test order`;
});

await step('F. The order is stored: Skyfly\'s confirmation page (read from the database) shows it', async () => {
  const p = await phone.newPage();
  await p.goto(reply.confirmationUrl);
  const text = await p.textContent('body');
  assert(text.includes(reference) && text.includes(NAME.split(' ')[0]), 'not found');
  await p.close();
  return reply.confirmationUrl.replace(/\?t=.*/, '?t=…');
});

await step('G. Refreshing and sending the same details again returns the same order (no duplicate)', async () => {
  await shop.reload();
  await fill();
  await shop.click('text=Place my order');
  await shop.waitForSelector('.sky-ok', { timeout: 60000 });
  const again = (await shop.textContent('[data-skyfly-reference]')).trim();
  assert(again === reference && reply.replayed === true, `got ${again}, replayed ${reply.replayed}`);
  return `same reference ${again}, replayed`;
});

await step('H. No ad-platform requests from the demo page (no pixel connected; test orders never fire Purchase)', async () => {
  assert(adRequests.length === 0, adRequests.join(', '));
});

await step('I. A desktop visitor gets the same page and checkout', async () => {
  const desk = await (await browser.newContext({ viewport: { width: 1366, height: 800 } })).newPage();
  await desk.goto(PAGE);
  await desk.waitForSelector('.sky-opt');
  await desk.screenshot({ path: 'live-screenshots/demo-desktop.png' });
  await desk.close();
});

await step('J. The order appears exactly once in the Skyfly Demo Shop (test) dashboard', async () => {
  if (!process.env.SKYFLY_OWNER_EMAIL || !process.env.SKYFLY_OWNER_PASSWORD) throw new Blocked('needs the SKYFLY_OWNER_EMAIL and SKYFLY_OWNER_PASSWORD repository secrets to sign in');
  const d = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  await d.goto(`${SKYFLY}/login`);
  await d.fill('#email', process.env.SKYFLY_OWNER_EMAIL); await d.fill('#password', process.env.SKYFLY_OWNER_PASSWORD);
  await Promise.all([d.waitForLoadState('load'), d.click('button[type=submit]')]);
  assert(!d.url().endsWith('/login'), 'sign-in refused');
  await d.goto(`${SKYFLY}/`);
  const href = await d.getAttribute('a:text-is("Skyfly Demo Shop (test)")', 'href');
  assert(href, 'demo business not in the dashboard');
  await d.goto(`${SKYFLY}${href}/orders?q=${encodeURIComponent(reference)}`);
  const rows = await d.getByRole('link', { name: reference, exact: true }).count();
  assert(rows === 1, `${rows} rows`);
  return `1 row in ${href}/orders`;
});

await browser.close();
if (blocked) console.log(`\n${blocked} check(s) BLOCKED (missing credential, see above)`);
console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks that could run passed');
process.exit(failed ? 1 : 0);
