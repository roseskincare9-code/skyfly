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

// ---------- the dashboard, signed in as the restricted live-test account ----------
let dash = null; let bizHref = null;
async function signIn() {
  if (!process.env.SKYFLY_OWNER_EMAIL || !process.env.SKYFLY_OWNER_PASSWORD) throw new Blocked('no dashboard sign-in for the tests (run the "Live import test" workflow, which signs in as the restricted live-test account)');
  if (dash) return dash;
  dash = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  await dash.goto(`${SKYFLY}/login`);
  await dash.fill('#email', process.env.SKYFLY_OWNER_EMAIL); await dash.fill('#password', process.env.SKYFLY_OWNER_PASSWORD);
  await Promise.all([dash.waitForLoadState('load'), dash.click('button[type=submit]')]);
  assert(!dash.url().endsWith('/login'), 'sign-in refused');
  await dash.goto(`${SKYFLY}/?all=1`);
  bizHref = await dash.getAttribute('a:text-is("Skyfly Import Test (test)")', 'href');
  assert(bizHref, 'import test business not listed');
  return dash;
}
const money = (n) => `₦${n.toLocaleString('en-NG')}`;
async function orderRow(ref, expect) {
  const d = await signIn();
  await d.goto(`${SKYFLY}${bizHref}/orders?q=${ref}`);
  const rows = await d.getByRole('link', { name: ref, exact: true }).count();
  assert(rows === 1, `${rows} rows for ${ref} in ${bizHref}/orders`);
  await d.getByRole('link', { name: ref, exact: true }).click();
  const text = (await d.textContent('main')).replace(/\s+/g, ' ');
  for (const e of expect) assert(text.includes(e), `order page lacks "${e}"`);
  return `1 row in ${bizHref}/orders; order page shows ${expect.join(', ')}`;
}

await step('H. The order appears exactly once in the import test business\'s Orders, with its options, delivery and total', () =>
  orderRow(reference, ['Glow Duo Set (Size: 50ml)', 'Delivery', money(2500), money(38000), 'TEST ORDER']));

let pageUrl = null; let liveUrl = null; let ref2 = null;
const PAGE_NAME = 'Dashboard import test';
await step('I. Owner: import an AI-made page in the dashboard; Publish connects its checkout itself and gives a checked public address', async () => {
  const d = await signIn();
  await d.goto(`${SKYFLY}${bizHref}/landing-pages`);
  const original = (await import('node:fs')).readFileSync(new URL('../../src/demo/import-sample/index.html', import.meta.url), 'utf8')
    .replace('Aurora Glow Radiance Serum</h1>', `Aurora Glow Radiance Serum</h1><p data-run>Dashboard import, run ${RUN}</p>`);
  const existing = d.locator(`.card:has(h2:has-text("${PAGE_NAME}")) a:text-is("Manage")`);
  if (await existing.count()) {
    await Promise.all([d.waitForURL(/landing-pages\/\d+(\?|$)/), existing.first().click()]);
    pageUrl = d.url().split('?')[0];
    await d.setInputFiles('#file', { name: 'index.html', mimeType: 'text/html', buffer: Buffer.from(original) });
    await Promise.all([d.waitForURL(/done=uploaded/), d.click('form[action$="/upload"] button[type=submit]')]);
  } else {
    await d.fill('#imp-name', PAGE_NAME);
    await d.setInputFiles('#imp-file', { name: 'index.html', mimeType: 'text/html', buffer: Buffer.from(original) });
    await Promise.all([d.waitForURL(/done=uploaded/), d.click('form[enctype][action$="/landing-pages/upload"] button[type=submit]')]);
    pageUrl = d.url().split('?')[0];
  }
  const before = (await d.textContent('#workflow')).replace(/\s+/g, ' ');
  assert(/Button "Order on WhatsApp" goes to WhatsApp/.test(before), 'WhatsApp purchase button not detected');
  await Promise.all([d.waitForURL(/done=published_connected/), d.click('#workflow form[action$="/publish"] button[type=submit]')]);
  liveUrl = await d.getAttribute('#live-url', 'href');
  const check = (await d.textContent('[data-live-check]')).replace(/\s+/g, ' ');
  assert(/Live ✓/.test(check), `live check: ${check}`);
  assert(await d.inputValue('#live-url-text') === liveUrl, 'copy-link field differs');
  const res = await fetch(liveUrl);
  const html = await res.text();
  assert(res.status === 200 && html.includes(`run ${RUN}`) && /data-skyfly-form="[^"]+" data-skyfly-exclusive/.test(html) && /data-skyfly-option="Size"/.test(html), `published page HTTP ${res.status}`);
  return `${liveUrl} — connected automatically on Publish (form, 3 WhatsApp buttons, Size option), "Live ✓", Copy link shown`;
});

await step('I2. Owner: import a page from its public web address; it is saved as a draft under this business, its WhatsApp buttons found for connecting', async () => {
  const d = await signIn();
  await d.goto(`${SKYFLY}${bizHref}/landing-pages`);
  const source = `${SKYFLY}/p/${SLUG}/`; // the published import test page (public, https)
  await d.fill('#url-name', `URL import test ${RUN}`);
  await d.fill('#url-addr', source);
  await Promise.all([d.waitForURL(/done=uploaded/), d.click('form[action$="/landing-pages/import-url"] button[type=submit]')]);
  const draft = d.url().split('?')[0];
  const flow = (await d.textContent('#workflow')).replace(/\s+/g, ' ');
  assert(/goes to WhatsApp|saves orders in Skyfly|Skyfly checkout on the page/.test(flow), `workflow: ${flow.slice(0, 200)}`);
  // Tidy up: archive the draft (never published).
  const settings = d.locator(`form[action$="${new URL(draft).pathname}"]`);
  await settings.locator('select[name=status]').selectOption('archived');
  await Promise.all([d.waitForURL(/landing-pages$/), settings.locator('button[type=submit]').click()]);
  return `${source} imported as a draft (${new URL(draft).pathname}); checkout detection shown; draft archived`;
});

await step('J. A phone order on that page saves under the import test business (Glow Duo 30ml + delivery), shown once in Orders', async () => {
  assert(liveUrl, 'no page');
  const p = await ctx.newPage();
  p.on('framenavigated', (f) => { if (f === p.mainFrame()) navigations.push(f.url()); });
  let reply = null;
  p.on('response', async (r) => { if (r.request().method() === 'POST' && r.url().startsWith(`${SKYFLY}/api/public/orders`)) reply = await r.json().catch(() => null); });
  await p.goto(liveUrl, { waitUntil: 'load' });
  await p.waitForFunction('window.Skyfly && window.Skyfly.version', null, { timeout: 30000 });
  await p.click('button:has-text("Order now")');
  await p.selectOption('#size', { label: '30ml' });
  await p.fill('#fullname', `${NAME} dashboard`); await p.fill('#phone_number', '08031234567');
  await p.fill('#addr', 'TEST ORDER - do not deliver, automated check'); await p.fill('#city', 'Lagos');
  await Promise.all([p.waitForURL(/\/o\/IT-[A-Z0-9]+/, { timeout: 120000 }), p.click('button:has-text("Send my order")')]);
  assert(reply?.saved && reply.business === 'skyfly-import-test' && reply.total === 30000 && reply.test === true, `reply ${JSON.stringify({ ...reply, confirmationUrl: undefined })}`);
  ref2 = reply.reference;
  const text = (await p.textContent('body')).replace(/\s+/g, ' ');
  assert(text.includes(ref2) && /Glow Duo Set \(Size: 30ml\)/.test(text), 'confirmation');
  assert(!toWhatsApp().length, 'went to WhatsApp');
  await p.close();
  return `${ref2}: Glow Duo Set (Size: 30ml) ₦27,500 + delivery ₦2,500 = ₦30,000; ${await orderRow(ref2, ['Glow Duo Set (Size: 30ml)', money(30000)])}`;
});

await step('K. Owner: edit the page and republish (same address, still connected), unpublish (offline), republish (back)', async () => {
  assert(pageUrl && liveUrl, 'no page');
  const d = await signIn();
  await d.goto(pageUrl);
  await Promise.all([d.waitForURL(/\/versions\/\d+\/edit$/), d.locator('a:text-is("Edit")').first().click()]);
  const field = d.locator(`input[value="Dashboard import, run ${RUN}"], textarea:has-text("Dashboard import, run ${RUN}")`).first();
  if (!(await field.count())) {
    const found = await d.locator('input[name^="text_"]').evaluateAll((x) => x.map((e) => e.value).filter((v) => /run/.test(v)));
    throw new Error(`run text not found in the editor (${d.url()}): ${found.join(' | ')}`);
  }
  // Texts sit in collapsible groups in the editor: the value is set directly, as typing would.
  await field.evaluate((el, v) => { el.value = v; }, `Edited in the dashboard, run ${RUN}`);
  await Promise.all([d.waitForURL(/done=edited/), d.locator('form[action$="/edit"] button[type=submit]').first().click()]);
  await Promise.all([d.waitForURL(/done=published/), d.click('#workflow form[action$="/publish"] button[type=submit]')]);
  assert(await d.getAttribute('#live-url', 'href') === liveUrl, 'address changed after editing');
  const edited = await (await fetch(liveUrl)).text();
  assert(edited.includes(`Edited in the dashboard, run ${RUN}`) && /data-skyfly-form=/.test(edited), 'edited version not served or not connected');
  await Promise.all([d.waitForURL(/done=unpublished/), d.click('button:text-is("Unpublish")')]);
  const off = await fetch(liveUrl);
  assert(off.status === 404, `after unpublishing HTTP ${off.status}`);
  await Promise.all([d.waitForURL(/done=published/), d.click('button:text-is("Republish")')]);
  const back = await fetch(liveUrl);
  assert(back.status === 200, `after republishing HTTP ${back.status}`);
  return `${liveUrl}: edited version republished at the same address (still connected), unpublished → 404, republished → 200`;
});

await step('L. The test account sees only the two test businesses; other businesses (e.g. Larose) and their orders are refused', async () => {
  const d = await signIn();
  await d.goto(`${SKYFLY}/?all=1`);
  const names = (await d.locator('main a').evaluateAll((as) => as.filter((a) => /^\/businesses\/\d+$/.test(a.getAttribute('href') || '')).map((a) => a.textContent.trim()))).filter(Boolean);
  assert(!names.some((n) => /Larose/i.test(n)), `listed: ${names.join(', ')}`);
  const mine = new Set((await d.locator('main a[href^="/businesses/"]').evaluateAll((as) => as.map((a) => a.getAttribute('href').match(/^\/businesses\/(\d+)/)?.[1]))).filter(Boolean));
  const refused = [];
  for (let id = 1; id <= 8; id += 1) {
    if (mine.has(String(id))) continue;
    const r = await d.request.get(`${SKYFLY}/businesses/${id}/orders`, { maxRedirects: 0 });
    assert(r.status() === 404, `business ${id} orders: HTTP ${r.status()}`);
    refused.push(id);
  }
  return `listed: ${[...new Set(names)].join(', ')}; orders of businesses ${refused.join(', ')} → 404`;
});

await browser.close();
if (blocked) console.log(`\n${blocked} check(s) BLOCKED (missing credential, see above)`);
console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks that could run passed');
process.exit(failed ? 1 : 0);
