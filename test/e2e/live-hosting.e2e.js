// Live check of Skyfly's own page hosting on production, using the labelled demo site
// (/p/skyfly-demo/, test mode: its orders are test orders; Skyfly's own Meta pixel, no Google Sheet).
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
// Meta's script loads normally; its event hits are counted and answered here, never sent to Meta.
const pixelHits = [];
await phone.route(/^https:\/\/([a-z0-9-]+\.)*(facebook\.(com|net)|tiktok\.com)\//, (r) => {
  const u = new URL(r.request().url());
  adRequests.push(u.href);
  if (/\/tr\/?$/.test(u.pathname)) {
    // Query string, urlencoded or multipart body.
    let text = `${u.search} ${r.request().postData() || ''}`;
    try { text = decodeURIComponent(text.replace(/\+/g, ' ')); } catch { /* keep as is */ }
    const field = (n) => text.match(new RegExp(`[?&\\s]${n}=([^&\\s]+)`))?.[1] ?? text.match(new RegExp(`name="${n}"\\r?\\n\\r?\\n([^\\r\\n]+)`))?.[1] ?? null;
    pixelHits.push({ id: field('id'), ev: field('ev') });
    return r.fulfill({ status: 200, contentType: 'image/gif', body: '' });
  }
  return u.hostname.endsWith('facebook.net') ? r.continue() : r.abort();
});
const shop = await phone.newPage();
let reply = null;
shop.on('response', async (r) => { if (r.url().endsWith('/api/public/orders') && r.request().method() === 'POST' && r.status() !== 500) reply = await r.json().catch(() => null); });
const fill = async () => {
  await shop.waitForSelector('.sky-opt');
  await shop.locator('.sky-opt').nth(1).click();
  await shop.selectOption('#sky-qty', '2');
  await shop.fill('#sky-name', NAME); await shop.fill('#sky-phone', '08012345678');
  await shop.fill('#sky-address', 'TEST ORDER - do not deliver, automated check'); await shop.fill('#sky-state', 'Lagos');
  if (catalog.upsell) await shop.locator('[data-skyfly-upsell] button:text-is("Add")').click();
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
  const addon = catalog.upsell?.price ?? 0;
  assert(reply?.saved === true && reply.reference === reference && reply.business === 'skyfly-demo', JSON.stringify(reply));
  assert(reply.total === duo.price * 2 + addon && reply.currency === 'NGN', `total ${reply.total} ${reply.currency}`);
  assert(reply.test === true, 'demo orders must be test orders');
  await shop.screenshot({ path: 'live-screenshots/demo-confirmation-mobile.png' });
  return `${reference}, ₦${reply.total.toLocaleString('en-NG')} (${duo.name} × 2${addon ? ` + add-on ₦${addon.toLocaleString('en-NG')}` : ''}, priced by Skyfly), test order`;
});

await step('E2. The upsell: shown with what is included, Add updates the total, saved as an add-on and priced by Skyfly', async () => {
  if (!catalog.upsell) throw new Blocked('no upsell set on the demo page on this deployment');
  const line = (reply.items || []).find((i) => i.upsell);
  assert(line && line.name === catalog.upsell.name && line.total === catalog.upsell.price && line.quantity === 1, JSON.stringify(reply.items));
  return `"${catalog.upsell.headline}": ${line.name} ₦${line.total.toLocaleString('en-NG')} saved as add-on`;
});

await step('E3. Thank-you message (only after the save) with a WhatsApp button for the configured number and the order reference', async () => {
  const ok = (await shop.textContent('.sky-ok')).replace(/\s+/g, ' ');
  assert(/Thank you! We have received your order\./.test(ok) && /Our team will contact you shortly to confirm the details and delivery\./.test(ok), ok.slice(0, 200));
  assert(!/24 hours/.test(ok), 'promises 24 hours');
  const wa = await shop.getAttribute('[data-skyfly-whatsapp]', 'href');
  assert(new RegExp(`^https://wa\\.me/2349049206695\\?text=.*${reference}`).test(wa), `WhatsApp link ${wa}`);
  return `WhatsApp ${wa.slice(0, 40)}… (reference prefilled)`;
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

await step('H. The demo page loads only Skyfly\'s own Meta pixel (1325736489534601): PageView fires on the published page; no Purchase for this test order (intercepted, nothing sent to Meta)', async () => {
  const cfg = await shop.evaluate(() => window.__SKYFLY__ && window.__SKYFLY__.pixels);
  const ids = (cfg || []).map((p) => p.id);
  assert(ids.length === 0 || (ids.length === 1 && ids[0] === '1325736489534601'), `pixels on the page: ${JSON.stringify(cfg)}`);
  // Every event hit belongs to Skyfly's own pixel (hits are answered here, never sent to Meta).
  const foreign = pixelHits.filter((h) => h.id && h.id !== '1325736489534601');
  assert(foreign.length === 0, `events for other pixels: ${JSON.stringify(foreign)}`);
  const other = adRequests.filter((u) => !/connect\.facebook\.net\//.test(u) && !/facebook\.com\/tr\/?(\?|$)/.test(u));
  assert(other.length === 0, `unexpected ad requests: ${other.join(', ')}`);
  assert(!pixelHits.some((h) => h.ev === 'Purchase'), 'Purchase sent for a test order');
  if (!ids.length) return 'no pixel configured on this deployment';
  const views = pixelHits.filter((h) => h.id === '1325736489534601' && h.ev === 'PageView').length;
  assert(views >= 1, `no PageView for 1325736489534601 (hits: ${JSON.stringify(pixelHits)})`);
  return `pixel ${ids[0]}: PageView ×${views} on the published page, no Purchase for the test order (events: ${[...new Set(pixelHits.map((h) => h.ev))].join(', ')}; intercepted, not sent to Meta)`;
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

await step('K. Owner: import a labelled test page, add the checkout, publish, open it, edit and republish, then unpublish', async () => {
  if (!process.env.SKYFLY_OWNER_EMAIL || !process.env.SKYFLY_OWNER_PASSWORD) throw new Blocked('needs the SKYFLY_OWNER_EMAIL and SKYFLY_OWNER_PASSWORD repository secrets to sign in');
  const d = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  await d.goto(`${SKYFLY}/login`);
  await d.fill('#email', process.env.SKYFLY_OWNER_EMAIL); await d.fill('#password', process.env.SKYFLY_OWNER_PASSWORD);
  await Promise.all([d.waitForLoadState('load'), d.click('button[type=submit]')]);
  await d.goto(`${SKYFLY}/`);
  const href = await d.getAttribute('a:text-is("Skyfly Demo Shop (test)")', 'href');
  assert(href, 'demo business not in the dashboard');
  const name = `TEST page ${RUN}`;
  const html = (v) => `<!doctype html><html><head><meta charset="utf-8"><title>${name}</title></head><body><h1>${name} v${v}</h1></body></html>`;
  // A business has a landing page limit (4 by default): test pages left by earlier runs are archived
  // first (archived pages don't count), so this run's import always has room.
  const archive = async (manageUrl) => {
    await d.goto(manageUrl);
    await d.selectOption('#status', 'archived');
    await Promise.all([d.waitForLoadState('load'), d.click('form.card >> button:text-is("Save")')]);
  };
  await d.goto(`${SKYFLY}${href}/landing-pages`);
  const leftovers = [];
  for (const card of await d.locator('.card:has(h2:has-text("TEST page "))').all()) {
    if (await card.locator('.pill.archived').count()) continue;
    leftovers.push(new URL(await card.locator('a:text-is("Manage")').getAttribute('href'), SKYFLY).href);
  }
  for (const u of leftovers) await archive(u);
  await d.goto(`${SKYFLY}${href}/landing-pages`);
  await d.fill('#imp-name', name);
  await d.setInputFiles('#imp-file', { name: 'index.html', mimeType: 'text/html', buffer: Buffer.from(html(1)) });
  await Promise.all([d.waitForURL(/done=uploaded|error=/), d.click('form[enctype] button[type=submit]')]);
  assert(/done=uploaded/.test(d.url()), `import refused: ${decodeURIComponent(d.url().split('error=')[1] ?? '')}`);
  const pageUrl = d.url().split('?')[0];
  await Promise.all([d.waitForURL(/done=checkout/), d.click('button:text-is("Add Skyfly checkout")')]);
  // Test mode on and the demo products connected, in Page settings.
  await d.check('input[name=test_mode]');
  for (const box of await d.locator('input[name=products]').all()) await box.check();
  await Promise.all([d.waitForLoadState('load'), d.click('form.card >> button:text-is("Save")')]);
  await d.goto(pageUrl);
  await Promise.all([d.waitForURL(/done=published/), d.locator('button:text-is("Publish this version")').first().click()]);
  const live = await d.getAttribute('#live-url', 'href');
  const v1 = await fetch(live);
  const t1 = await v1.text();
  assert(v1.status === 200 && t1.includes(`${name} v1`) && t1.includes('data-skyfly-checkout'), `published page HTTP ${v1.status}`);
  await d.setInputFiles('#file', { name: 'index.html', mimeType: 'text/html', buffer: Buffer.from(html(2)) });
  await Promise.all([d.waitForURL(/done=uploaded/), d.click('form[action$="/upload"] button[type=submit]')]);
  assert((await (await fetch(live)).text()).includes(`${name} v1`), 'changed before republishing');
  await Promise.all([d.waitForURL(/done=published/), d.locator('button:text-is("Publish this version")').first().click()]);
  const t2 = await (await fetch(live)).text();
  assert(t2.includes(`${name} v2`), 'republished version not served');
  await Promise.all([d.waitForURL(/done=unpublished/), d.click('button:text-is("Unpublish")')]);
  const gone = await fetch(live);
  assert(gone.status === 404, `after unpublishing HTTP ${gone.status}`);
  await archive(pageUrl); // leaves the business's page allowance as it was
  return `${live}: v1 published, v2 republished at the same address, unpublished (404), archived${leftovers.length ? ` (${leftovers.length} earlier test page(s) archived first)` : ''}`;
});

await browser.close();
if (blocked) console.log(`\n${blocked} check(s) BLOCKED (missing credential, see above)`);
console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks that could run passed');
process.exit(failed ? 1 : 0);
