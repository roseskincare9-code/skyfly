// Live end-to-end check of the real Larose page -> Skyfly (production) -> Google Sheet backup.
// Places ONE clearly labelled test order ("TEST ORDER …", saved as a test order) through
// the live page, plus one labelled fallback test row, and checks every step.
//
//   SKYFLY_URL=https://<service>.onrender.com [RENDER_API_KEY=…] node test/e2e/live.e2e.js
//
// Meta/TikTok pixel calls are intercepted and counted, never sent, so no test data reaches the ad platforms.
// With RENDER_API_KEY, the Skyfly service is restarted to prove the order survives a restart.
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright-core';

const SKYFLY = (process.env.SKYFLY_URL || '').replace(/\/+$/, '');
const PAGE = process.env.LANDING_URL || 'https://roseskincare9-code.github.io/Larosenigeria/';
// The same Larose page hosted on Skyfly (/p/larose-skincare/) runs in a browser sandbox: its
// requests carry "Origin: null" and it has its own form key.
const HOSTED = PAGE.startsWith(SKYFLY);
const PAGE_KEY = process.env.PAGE_KEY || (HOSTED ? 'larose-skincare' : 'larosenigeria');
// Larose's Meta pixels: the main one (in the page's own code) and "Pixel New" (added in Skyfly).
const LAROSE_PIXELS = ['1357015185691765', '1087347357386553', '1105657388903531', '1653102723149813', '1130654146607839', '4389240701387003'];
const PAGE_ORIGIN = HOSTED ? 'null' : 'https://roseskincare9-code.github.io';
const SHEET = 'https://sheetdb.io/api/v1/m111fq96ve953';
const RUN = process.env.GITHUB_RUN_ID || String(Date.now());
const NAME = `TEST ORDER Skyfly E2E ${RUN} please ignore`;
const FB_NAME = `TEST ORDER Skyfly E2E ${RUN} fallback please ignore`;
if (!/^https:\/\/[a-z0-9-]+\.onrender\.com$/.test(SKYFLY) || /\/\/skyfly\.onrender\.com/.test(SKYFLY)) {
  throw new Error('Set SKYFLY_URL to the verified Skyfly service address');
}

let failed = 0;
let blockedSteps = 0;
// BLOCKED: the check could not run for a reason outside the code (a provider limit or a missing credential).
class Blocked extends Error {}
async function step(name, fn) {
  try { const info = await fn(); console.log(`PASS  ${name}${info ? ` — ${info}` : ''}`); return true; }
  catch (err) {
    if (err instanceof Blocked) { blockedSteps += 1; console.log(`BLOCKED  ${name} — ${err.message}`); return false; }
    failed += 1; console.log(`FAIL  ${name} — ${err.message}`); return false;
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Skyfly writes to the first tab, or to the "Skyfly Orders" tab it adds when the first tab has no column row.
const TABS = ['', 'Skyfly Orders'];
const tabUrl = (path, tab, params = {}) => {
  const q = new URLSearchParams(params);
  if (tab) q.set('sheet', tab);
  return `${SHEET}${path}?${q}`;
};
async function sheetSearch(text) {
  const all = [];
  for (const tab of TABS) {
    const res = await fetch(tabUrl('/search', tab, { source: `*${text}*` }));
    if (res.ok) all.push(...(await res.json()).map((r) => ({ ...r, tab: tab || 'first tab' })));
  }
  return all;
}
async function waitForSheetRows(text, want, seconds = 120) {
  let rows = [];
  for (let i = 0; i < seconds / 30; i += 1) {
    rows = await sheetSearch(text);
    if (rows.length >= want) break;
    await sleep(30000);
  }
  return rows;
}

// The owner's dashboard lists the order exactly once under Larose (needs the owner sign-in secrets).
async function dashboardCheck(reference) {
  if (!process.env.SKYFLY_OWNER_EMAIL || !process.env.SKYFLY_OWNER_PASSWORD) throw new Blocked('needs the SKYFLY_OWNER_EMAIL and SKYFLY_OWNER_PASSWORD repository secrets to sign in to the dashboard');
  const owner = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const d = await owner.newPage();
  await d.goto(`${SKYFLY}/login`);
  await d.fill('#email', process.env.SKYFLY_OWNER_EMAIL);
  await d.fill('#password', process.env.SKYFLY_OWNER_PASSWORD);
  await Promise.all([d.waitForLoadState('load'), d.click('button[type=submit]')]);
  assert(!d.url().endsWith('/login'), 'sign-in refused');
  await d.goto(`${SKYFLY}/`);
  const href = await d.getAttribute('a:text-is("Larose Natural Skincare Nigeria")', 'href');
  assert(href, 'Larose business not in the dashboard');
  await d.goto(`${SKYFLY}${href}/orders?q=${encodeURIComponent(reference)}`);
  const rows = await d.getByRole('link', { name: reference, exact: true }).count();
  assert(rows === 1, `${rows} rows for ${reference} in the Larose orders list`);
  await d.getByRole('link', { name: reference, exact: true }).click();
  const sheet = (await d.textContent('#sheet')).replace(/\s+/g, ' ').trim();
  const detail = (await d.textContent('main')).replace(/\s+/g, ' ');
  assert(detail.includes(reference) && /TEST ORDER/.test(detail) && /₦[\d,]+/.test(detail), 'order page lacks the reference, the TEST ORDER customer or a total');
  await d.screenshot({ path: 'live-screenshots/dashboard-test-order.png', fullPage: true });
  await owner.close();
  return `1 row in ${href}/orders; order page shows the reference, TEST ORDER customer and total ${detail.match(/₦[\d,]+/)[0]}; sheet copy: ${sheet.slice(0, 220)}`;
}

const ready = await step('A. Larose Natural Skincare Nigeria is set up on the live Skyfly (page, products, Meta Pixel)', async () => {
  const h = await fetch(`${SKYFLY}/healthz`, { signal: AbortSignal.timeout(90000) });
  assert(h.ok, `/healthz HTTP ${h.status}`);
  const t = await fetch(`${SKYFLY}/api/public/pages/${PAGE_KEY}/tracking`);
  assert(t.ok, `Larose is not set up (tracking HTTP ${t.status})`);
  const cfg = await t.json();
  const meta = (cfg.pixels || []).find((p) => p.provider === 'meta');
  assert(meta?.id === '1357015185691765', `Meta Pixel in Skyfly: ${JSON.stringify(cfg.pixels)}`);
  // The browser only ever receives public pixel IDs: no Conversions API / Events API token.
  const raw = JSON.stringify(cfg);
  assert(!/token|EAA[A-Za-z0-9]{20,}|secret/i.test(raw), 'the public tracking config contains a token-like value');
  return `pixels: ${cfg.pixels.map((p) => `${p.provider} ${p.id}`).join(', ')}; no token in the public config`;
});
if (!ready) process.exit(1);

const browser = await chromium.launch();
// A normal phone browser identity: Meta's pixel script sends nothing for "HeadlessChrome".
const ctx = await browser.newContext({
  viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
});
// Count pixel calls without sending them (no test data reaches Meta or TikTok).
const pixelEvents = [];
const pixelSeen = [];
await ctx.route(/https:\/\/([a-z0-9-]+\.)*(facebook\.com|tiktok\.com|tiktokw\.us)\//, (route) => {
  const r = route.request();
  const u = new URL(r.url());
  pixelSeen.push(`${r.method()} ${u.host}${u.pathname}`);
  if (!/\/tr\/?$|\/api\/v2\/pixel/.test(u.pathname)) return route.continue(); // pixel scripts and config load normally
  // Event hits (query string, urlencoded or multipart body): counted, never sent.
  let text = `${u.search} ${r.postData() || ''}`;
  try { text = decodeURIComponent(text.replace(/\+/g, ' ')); } catch { /* keep as is */ }
  const field = (name) => {
    const n = name.replace(/[[\]]/g, '\\$&');
    return text.match(new RegExp(`[?&\\s]${n}=([^&\\s]+)`))?.[1] ?? text.match(new RegExp(`name="${n}"\\r?\\n\\r?\\n([^\\r\\n]+)`))?.[1] ?? null;
  };
  pixelEvents.push({ host: u.host, id: field('id'), ev: field('ev') || field('event') || '?', eid: field('eid'), value: field('cd[value]'), currency: field('cd[currency]') });
  return route.fulfill({ status: 200, contentType: 'image/gif', body: '' });
});
const page = await ctx.newPage();
let apiBody = null; let apiReply = null; const sheetPosts = []; const navigations = [];
page.on('request', (r) => {
  if (r.url().startsWith(`${SKYFLY}/api/public/orders`) && r.method() === 'POST') apiBody = r.postData();
  if (r.url().startsWith(SHEET) && r.method() === 'POST') sheetPosts.push(r.postData());
});
let landingLoads = 0;
// Skyfly loads the business's other pixels (e.g. "Pixel New") just after the page has loaded, so
// before leaving a page load the test waits until every Larose pixel has sent that load's PageView.
async function pixelsSettled() {
  for (let i = 0; i < 80 && !LAROSE_PIXELS.every((id) => pixelEvents.filter((e) => e.id === id && e.ev === 'PageView').length >= landingLoads); i += 1) await sleep(250);
}
page.on('framenavigated', (f) => { if (f === page.mainFrame()) { navigations.push(f.url()); if (f.url().startsWith(PAGE)) landingLoads += 1; } });
page.on('response', async (r) => {
  if (r.url().startsWith(`${SKYFLY}/api/public/orders`) && r.request().method() === 'POST') apiReply = await r.json().catch(() => null);
});

await step('K. The live Larose page opens and points at this Skyfly service', async () => {
  const res = await page.goto(`${PAGE}?skyfly_e2e=${RUN}`, { waitUntil: 'load' });
  assert(res.status() === 200, `HTTP ${res.status()}`);
  const api = await page.evaluate('typeof SKYFLY_API === "string" ? SKYFLY_API : null');
  assert(api === SKYFLY, `page SKYFLY_API is ${JSON.stringify(api)}`);
  await page.waitForFunction('window.Skyfly && window.Skyfly.version', null, { timeout: 30000 });
  await pixelsSettled();
  // Every product image loads (scrolling, so lazily loaded images load too).
  await page.evaluate(async () => { for (let y = 0; y < document.body.scrollHeight; y += 500) { window.scrollTo(0, y); await new Promise((r) => setTimeout(r, 120)); } window.scrollTo(0, 0); });
  await page.waitForTimeout(1500);
  const imgs = await page.evaluate(() => [...document.images].filter((i) => !/facebook\.com\/tr/.test(i.src)).map((i) => i.complete && i.naturalWidth > 0));
  assert(imgs.length && imgs.every(Boolean), `${imgs.filter((x) => !x).length} of ${imgs.length} images did not load`);
  const width = await page.evaluate(() => document.documentElement.scrollWidth);
  assert(width <= 400, `horizontal scroll on a phone (${width}px)`);
  return `${PAGE} (HTTP 200, Skyfly SDK loaded, all ${imgs.length} images loaded, fits a phone screen${HOSTED ? `, Skyfly-hosted sandbox, form key ${PAGE_KEY}` : ''})`;
});

// CHECK_REFERENCE=<order reference>: no order is placed. Checks the page's products and prices
// against Skyfly, the order summary total (and the add-on box, simulated when none is set),
// and that the given order is listed once in the Larose dashboard.
const CHECK = (process.env.CHECK_REFERENCE || '').trim();
if (CHECK) {
  let catalog = null;
  await step('P. The page offers exactly Skyfly\'s products for this page, at Skyfly\'s prices', async () => {
    catalog = await (await fetch(`${SKYFLY}/api/public/pages/${PAGE_KEY}/catalog`)).json();
    const shown = await page.$$eval('#pr option[data-product]', (os) => os.map((o) => ({ code: o.dataset.product, price: Number(o.dataset.price), label: o.textContent.trim() })));
    const want = catalog.products.map((p) => `${p.code}=${p.price}`).sort().join(', ');
    const got = shown.map((o) => `${o.code}=${o.price}`).sort().join(', ');
    assert(shown.length && got === want, `page offers [${got}], Skyfly has [${want}]`);
    for (const o of shown) assert(o.label.includes(`₦${o.price.toLocaleString('en-NG')}`), `label "${o.label}" does not show ₦${o.price}`);
    return shown.map((o) => o.label.replace(/^\W+/, '')).join('; ');
  });
  await step('Q. Clicking a package\'s Order button selects it, shows it at the top of the form and scrolls there; the form asks only for name, phone, email and address', async () => {
    const pick = catalog.products.find((p) => p.code === 'package-2') || catalog.products[0];
    await page.click('text=Order Starter Combo');
    await page.waitForTimeout(1200);
    assert(await page.inputValue('#pr') === (await page.$eval(`#pr option[data-product="${pick.code}"]`, (o) => o.value)), 'the clicked package is not selected');
    const chosen = (await page.textContent('#skyPick')).replace(/\s+/g, ' ');
    const price = `₦${pick.price.toLocaleString('en-NG')}`;
    assert(chosen.includes('Starter Glow Combo') && chosen.includes(price), `selected package shown as "${chosen}"`);
    const inView = await page.$eval('#fn', (el) => { const r = el.getBoundingClientRect(); return r.top >= 0 && r.top < innerHeight; });
    assert(inView, 'the form is not on screen after the click');
    const fields = await page.$$eval('#formContent input:not([type=checkbox]), #formContent select, #formContent textarea', (els) => els.filter((e) => e.id !== 'skyfly_hp').map((e) => e.id));
    assert(JSON.stringify(fields) === JSON.stringify(['pr', 'fn', 'ph', 'em', 'addr']), `fields: ${fields.join(', ')}`);
    const sum = (await page.textContent('#skySum')).replace(/\s+/g, ' ');
    assert(sum.includes(price), `summary "${sum}"`);
    return `"${chosen}"; form on screen; fields: package, full name, phone, email, address; summary ${price}`;
  });
  await step('R. The optional Facial Set starts unticked; ticking adds its price to the summary and total, unticking removes it', async () => {
    let up = catalog.upsell; let simulated = false;
    if (!up) {
      // No add-on is chosen for this page yet: the page is shown one in the browser only, to check its display and arithmetic.
      simulated = true;
      up = { code: 'sim-addon', name: 'Simulated add-on', price: 5000, headline: 'Add a simulated add-on', text: 'browser-only check' };
      const p2 = await ctx.newPage();
      await p2.route(`${SKYFLY}/api/public/pages/${PAGE_KEY}/catalog`, (r) => r.fulfill({ contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ ...catalog, upsell: up }) }));
      await p2.goto(`${PAGE}?skyfly_e2e=${RUN}-upsell`, { waitUntil: 'load' });
      await p2.waitForSelector('#skyAddBtn', { timeout: 30000 });
      var view = p2;
    } else { var view = page; await view.waitForSelector('#skyAddBtn', { timeout: 30000 }); }
    const pick = catalog.products.find((p) => p.code === 'package-3') || catalog.products[0];
    await view.selectOption('#pr', { index: 1 + catalog.products.indexOf(pick) });
    assert(!(await view.isChecked('#skyAddBtn')), 'the add-on is ticked before the customer chose it');
    const offer = (await view.textContent('#skyUp')).replace(/\s+/g, ' ');
    assert(offer.includes(`Add ${up.name} for ₦${up.price.toLocaleString('en-NG')}`), `offer "${offer}"`);
    if (up.compareAt) assert(offer.includes(`₦${up.compareAt.toLocaleString('en-NG')}`), `usual price missing in "${offer}"`);
    await view.check('#skyAddBtn');
    const sum = (await view.textContent('#skySum')).replace(/\s+/g, ' ');
    const total = `₦${(pick.price + up.price).toLocaleString('en-NG')}`;
    assert(sum.includes(`${up.name} (add-on)`) && sum.includes(total), `summary after ticking: "${sum}" (expected ${total})`);
    await view.uncheck('#skyAddBtn');
    const back = (await view.textContent('#skySum')).replace(/\s+/g, ' ');
    assert(back.includes(`₦${pick.price.toLocaleString('en-NG')}`) && !back.includes(total) && !back.includes('(add-on)'), `summary after unticking: "${back}"`);
    if (simulated) await view.close();
    return `${pick.name} + ${up.name} → ${total}; unticking restores the total${simulated ? ' (SIMULATED add-on in the browser only: no add-on is chosen for Larose yet; nothing submitted)' : ''}`;
  });
  await step(`L. Order ${CHECK} is listed exactly once in the Larose Natural Skincare Nigeria dashboard, with its Google Sheet status`, () => dashboardCheck(CHECK));
  await browser.close();
  if (blockedSteps) console.log(`\n${blockedSteps} check(s) BLOCKED (provider limit or missing credential, see above)`);
  console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks that could run passed (no order was placed)');
  process.exit(failed ? 1 : 0);
}

let reference = null;
let confirmationUrl = null;
await step('C/H. A test order placed through the real checkout is saved; the confirmation appears only after Skyfly\'s reply (not WhatsApp)', async () => {
  await page.click('text=Order Power Glow');
  await page.fill('#fn', NAME);
  await page.fill('#ph', '08012345678');
  await page.fill('#addr', 'TEST ORDER - do not deliver, automated check');
  await page.fill('#em', 'skyfly-e2e@example.com');
  // The optional Facial Set (just before Place Order): its picture from the page's images, unticked
  // until chosen; this test order includes it, so Skyfly must save it as an add-on at ₦17,000.
  let addOn = false;
  if (await page.$('#skyAddBtn')) {
    await page.$eval('#skyUp', (el) => el.scrollIntoView());
    await page.waitForFunction(() => { const i = document.querySelector('#skyUp img'); return i && i.complete && i.naturalWidth > 0; }, null, { timeout: 30000 });
    const img = await page.$eval('#skyUp img', (i) => i.currentSrc);
    assert(/\/Larosenigeria\/images\/facial-set-(480|800)\.(webp|jpg)$/.test(img), `Facial Set image: ${img}`);
    assert(!(await page.isChecked('#skyAddBtn')), 'the Facial Set was ticked before the customer chose it');
    await page.check('#skyAddBtn');
    addOn = true;
  }
  const expected = addOn ? 75000 : 58000;
  const summary = (await page.textContent('#skySum')).replace(/\s+/g, ' ');
  assert(/Power Glow/.test(summary) && summary.includes(`₦${expected.toLocaleString('en-NG')}`) && (!addOn || /Facial Set \(add-on\)/.test(summary)), `order summary: ${summary}`);
  assert(await page.isVisible('.wafbtn'), 'floating WhatsApp button missing');
  await page.click('#sb');
  // On-page confirmation (current page) or Skyfly's confirmation page (older page version).
  await Promise.race([page.waitForSelector('#sb2 #skyRef', { state: 'visible', timeout: 120000 }), page.waitForURL(/\/o\/LR-/, { timeout: 120000 })]);
  assert(apiReply && apiReply.ok, `API reply ${JSON.stringify(apiReply)}`);
  reference = apiReply.reference;
  confirmationUrl = apiReply.confirmationUrl;
  // The success reply is the proof of a saved order: persistent reference, verified total, currency, business, event ID.
  assert(apiReply.saved === true && apiReply.business === 'larose-nigeria' && apiReply.purchaseEventId === `purchase_${reference}`
    && apiReply.total === expected && apiReply.currency === 'NGN' && apiReply.test === true, `reply fields ${JSON.stringify({ ...apiReply, confirmationUrl: undefined })}`);
  // What Skyfly saved and priced: Power Glow ₦58,000 and, when ticked, the Facial Set add-on ₦17,000.
  const saved = (apiReply.items || []).map((i) => [i.name, i.quantity, i.total, Boolean(i.upsell)]);
  assert(JSON.stringify(saved) === JSON.stringify([['Package 3 – Power Glow', 1, 58000, false], ...(addOn ? [['Facial Set', 1, 17000, true]] : [])]), `saved items ${JSON.stringify(saved)}`);
  mkdirSync('live-screenshots', { recursive: true });
  await page.screenshot({ path: 'live-screenshots/larose-test-order-confirmation.png', fullPage: false });
  const text = await page.textContent('body');
  assert(text.includes(reference) && /(What happens next|We have received your order|received successfully)/.test(text), 'confirmation content');
  const wa = await page.getAttribute('#skyWa', 'href').catch(() => null);
  if (wa) assert(new RegExp(`^https://wa\\.me/2349049206695\\?text=.*${reference}`).test(wa), `WhatsApp link ${wa}`);
  if (await page.$('#skyRef')) {
    assert((await page.textContent('#skyRef')).trim() === reference, 'reference on the page differs from Skyfly\'s');
    assert((await page.textContent('#skyConf')).includes(`Total (pay on delivery): ₦${expected.toLocaleString('en-NG')}`), 'confirmed total');
  }
  assert(!navigations.some((u) => /wa\.me|whatsapp\.com/.test(u)), 'navigated to WhatsApp');
  return `${reference}: ${saved.map(([n, q, t, u]) => `${n} × ${q} ₦${t.toLocaleString('en-NG')}${u ? ' (add-on)' : ''}`).join(' + ')} = ₦${apiReply.total.toLocaleString('en-NG')} ${apiReply.currency}, business ${apiReply.business}, event ID ${apiReply.purchaseEventId}; page wrote ${sheetPosts.length} sheet row(s) itself`;
});

await step('D. The order persists: the confirmation page (read from the database) still shows it after a refresh', async () => {
  await page.reload({ waitUntil: 'load' });
  await pixelsSettled();
  if (await page.$('#skyRef')) assert((await page.textContent('#skyRef')).trim() === reference, 'on-page confirmation lost on refresh');
  await page.goto(confirmationUrl, { waitUntil: 'load' });
  await page.reload({ waitUntil: 'load' });
  const text = await page.textContent('body');
  assert(text.includes(reference) && text.includes('TEST ORDER Skyfly E2E'), 'order not shown after refresh');
  // The confirmation is read from the database: the saved order belongs to Larose's business.
  assert(text.includes('Larose Natural Skincare Nigeria'), 'the confirmation does not name the Larose business');
  return `${reference} shown after reload, read from the database under Larose Natural Skincare Nigeria`;
});

await step('F. Sending the same submission again returns the same order (no duplicate)', async () => {
  assert(apiBody && reference, 'no first submission');
  const res = await fetch(`${SKYFLY}/api/public/orders`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: PAGE_ORIGIN }, body: apiBody,
  });
  const data = await res.json();
  assert(res.status === 200 && data.reference === reference && data.replayed === true, `HTTP ${res.status} ${JSON.stringify(data).slice(0, 200)}`);
  return `HTTP 200, same reference ${data.reference}, replayed`;
});

// SheetDB's free plan has a small monthly request quota: check the column row once, and skip
// the row checks when the sheet cannot take rows anyway.
let sheetReady = false;
await step('G. The Google Sheet (SheetDB) accepts rows: a tab has Skyfly\'s column row', async () => {
  if (process.env.SHEET_CHECKS === 'off') throw new Blocked('skipped in this run: the historical Google Sheet is not touched (SHEET_CHECKS=off); test orders are never copied to a sheet');
  const found = [];
  const problems = [];
  for (const tab of TABS) {
    const res = await fetch(tabUrl('/keys', tab));
    const body = await res.json().catch(() => ({}));
    // Quota used up: stop here rather than spend more requests that cannot succeed.
    if (res.status === 429) throw new Blocked(`SheetDB HTTP 429 ${JSON.stringify(body).slice(0, 120)} (monthly request quota used up). This is Larose's old SheetDB link; the direct Laroseorders link is checked by the "Live integrations check" workflow`);
    if (res.ok && Array.isArray(body) && ['fullName', 'phone', 'package', 'source'].every((c) => body.includes(c))) found.push(`${tab || 'first tab'}: ${body.join(', ')}`);
    else problems.push(`${tab || 'first tab'}: HTTP ${res.status} ${JSON.stringify(body).slice(0, 120)}`);
    if (found.length) break;
  }
  assert(found.length, problems.join(' | '));
  sheetReady = true;
  return found.join(' | ');
});

await step('G. The order is in the Google Sheet exactly once, even after Skyfly\'s own delayed copy has run', async () => {
  if (!sheetReady) throw new Blocked('not checked: the sheet cannot take rows (see the check above); the order stays saved in Skyfly and is copied when the sheet accepts rows');
  const rows = await waitForSheetRows(reference, 1, 300);
  assert(rows.length >= 1, `no sheet row for ${reference}`);
  // Skyfly's server copy runs ~3 minutes after the order and must find the page's row instead of adding one.
  await sleep(sheetPosts.length ? 240000 : 30000);
  const again = await sheetSearch(reference);
  assert(again.length === 1, `${again.length} rows for ${reference} (duplicate)`);
  return `1 row in ${again[0].tab}: "${again[0].source}" (written by ${sheetPosts.length ? 'the page; Skyfly found it and did not add another' : 'Skyfly'})`;
});

await step(`I. Meta Pixels ${LAROSE_PIXELS.join(', ')} (main, "Pixel New", ad accounts): Purchase counted at save is configured; this TEST ORDER sends each pixel PageView once per page load, InitiateCheckout, Lead once and no Purchase (test orders never count)`, async () => {
  const cfg = await (await fetch(`${SKYFLY}/api/public/pages/${PAGE_KEY}/tracking`)).json();
  const out = [];
  for (const id of LAROSE_PIXELS) {
    const metaCfg = (cfg.pixels || []).find((p) => p.provider === 'meta' && p.id === id);
    assert(metaCfg?.events.includes('Purchase'), `pixel ${id} in the live config: ${JSON.stringify(cfg.pixels)}`);
    const meta = pixelEvents.filter((e) => e.host.endsWith('facebook.com') && e.id === id);
    const count = (ev) => meta.filter((e) => e.ev === ev).length;
    const summary = [...new Set(meta.map((e) => e.ev))].map((ev) => `${ev}×${count(ev)}`).join(', ');
    // One PageView per load of the landing page (the refresh check reloads it once).
    assert(count('PageView') === landingLoads, `${id}: PageView ${count('PageView')} for ${landingLoads} page loads (${summary}); requests seen: ${pixelSeen.slice(0, 8).join(', ') || 'none'}`);
    assert(count('InitiateCheckout') >= 1 && count('InitiateCheckout') <= landingLoads, `${id}: InitiateCheckout ${count('InitiateCheckout')} (${summary})`);
    assert(count('Lead') === 1, `${id}: Lead ${count('Lead')} (${summary})`);
    assert(count('Purchase') === 0, `${id}: Purchase ${count('Purchase')} (${summary})`);
    out.push(`${id}: ${summary}`);
  }
  return `${out.join('; ')} (intercepted, not sent to Meta)`;
});

if (process.env.RENDER_API_KEY && process.env.RESTART_CHECK === 'yes') {
  await step('D. The order survives a restart of the Skyfly service', async () => {
    const api = (path, init = {}) => fetch(`https://api.render.com/v1${path}`, { ...init, headers: { Authorization: `Bearer ${process.env.RENDER_API_KEY}`, Accept: 'application/json' } });
    const owners = (await (await api('/owners?limit=50')).json()).map((o) => o.owner ?? o);
    const owner = owners.find((o) => o.name.toLowerCase() === 'skyfly');
    const svc = (await (await api(`/services?ownerId=${owner.id}&name=skyfly&limit=20`)).json()).map((s) => s.service ?? s).find((s) => s.name === 'skyfly');
    const r = await api(`/services/${svc.id}/restart`, { method: 'POST' });
    assert(r.ok, `restart HTTP ${r.status}`);
    await sleep(20000);
    for (let i = 0; i < 30; i += 1) {
      try { if ((await fetch(`${SKYFLY}/healthz`, { signal: AbortSignal.timeout(15000) })).ok) break; } catch { /* restarting */ }
      await sleep(5000);
    }
    await page.goto(confirmationUrl, { waitUntil: 'load' });
    assert((await page.textContent('body')).includes(reference), 'order missing after restart');
    return `service restarted; ${reference} still there`;
  });
}

await step('G. With Skyfly unreachable the customer sees an honest error: no confirmation, no Sheet write, no WhatsApp', async () => {
  const p2 = await ctx.newPage();
  let blocked = 0; let sheetCalls = 0;
  await p2.route(`${SKYFLY}/api/public/orders`, (route) => { blocked += 1; return route.abort(); });
  p2.on('request', (r) => { if (r.url().startsWith(SHEET)) sheetCalls += 1; });
  const popups = []; p2.on('popup', (x) => popups.push(x.url()));
  await p2.goto(`${PAGE}?skyfly_e2e=${RUN}-unreachable`, { waitUntil: 'load' });
  await p2.fill('#fn', FB_NAME);
  await p2.fill('#ph', '08012345678');
  await p2.fill('#addr', 'TEST ORDER - do not deliver, automated check');
  await p2.fill('#em', 'skyfly-e2e@example.com');
  await p2.selectOption('#pr', { index: 1 });
  await p2.click('#sb');
  await p2.waitForSelector('#skyErr', { state: 'visible', timeout: 120000 });
  const err = await p2.textContent('#skyErr');
  const confirmed = await p2.isVisible('#sb2');
  await p2.screenshot({ path: 'live-screenshots/larose-unreachable-error.png', fullPage: false });
  await p2.close();
  assert(blocked >= 1, 'Skyfly was not called');
  assert(!confirmed, 'a confirmation was shown without a saved order');
  assert(sheetCalls === 0, `the page wrote to the Google Sheet (${sheetCalls})`);
  assert(!popups.length, `opened ${popups.join(', ')}`);
  return `error shown: "${err.trim().slice(0, 80)}…"`;
});

await step('J. Purchase fires only for a saved-order reply, once, with the order\'s value and currency (live page + live SDK; SIMULATED reply: no order is created and nothing is sent to Meta)', async () => {
  const p3 = await ctx.newPage();
  const start = pixelEvents.length;
  const purchases = () => pixelEvents.slice(start).filter((e) => e.host.endsWith('facebook.com') && e.ev === 'Purchase');
  const ref = `LR-SIM${String(RUN).replace(/\D/g, '').slice(-5).padStart(5, '0')}`;
  let mode = 'fail';
  const replies = [];
  p3.on('requestfailed', (r) => { if (r.url().includes('/api/public/orders')) replies.push(`${r.method()} failed: ${r.failure()?.errorText}`); });
  p3.on('response', (r) => { if (r.url().includes('/api/public/orders')) replies.push(`${r.request().method()} ${r.status()}`); });
  await p3.route(`${SKYFLY}/api/public/orders`, (route) => (mode === 'fail'
    ? route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'SERVER_ERROR', message: 'We could not save your order. Please try again in a moment.' }) })
    : route.fulfill({ status: 201, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': HOSTED ? '*' : 'https://roseskincare9-code.github.io' },
      body: JSON.stringify({ ok: true, saved: true, reference: ref, business: 'larose-nigeria', purchaseEventId: `purchase_${ref}`, total: 58000, currency: 'NGN', confirmationUrl: `${SKYFLY}/o/${ref}?t=simulated`, replayed: mode === 'replayed', test: false }) })));
  await p3.goto(`${PAGE}?skyfly_e2e=${RUN}-purchase`, { waitUntil: 'load' });
  await p3.click('text=Order Power Glow');
  await p3.fill('#fn', 'Simulated Reply Check');
  await p3.fill('#ph', '08012345678');
  await p3.fill('#addr', 'TEST - simulated reply, no order is created');
  await p3.fill('#em', 'skyfly-e2e@example.com');
  await sleep(1500);
  assert(purchases().length === 0, `Purchase after a visit and clicks: ${purchases().length}`);
  await p3.click('#sb');
  await p3.waitForSelector('#skyErr', { state: 'visible', timeout: 60000 });
  await sleep(1500);
  assert(purchases().length === 0, `Purchase after a failed order: ${purchases().length}`);
  assert(!(await p3.isVisible('#sb2')), 'confirmation shown for a failed order');
  mode = 'saved';
  await p3.click('#sb');
  await p3.waitForSelector('#sb2 #skyRef', { state: 'visible', timeout: 60000 }).catch(async (e) => {
    throw new Error(`no confirmation for the simulated saved reply; page error: "${((await p3.textContent('#skyErr').catch(() => '')) || '').slice(0, 160)}", button: "${await p3.textContent('#sb').catch(() => '')}", replies seen: ${replies.join(', ')}`);
  });
  for (let i = 0; i < 20 && purchases().length === 0; i += 1) await sleep(500);
  for (let i = 0; i < 10 && purchases().length < LAROSE_PIXELS.length; i += 1) await sleep(500);
  const p = purchases();
  assert(p.length === LAROSE_PIXELS.length, `${p.length} Purchase event(s) after the saved reply: ${JSON.stringify(p)}`);
  for (const id of LAROSE_PIXELS) {
    const one = p.filter((e) => e.id === id);
    assert(one.length === 1 && one[0].eid === `purchase_${ref}` && Number(one[0].value) === 58000 && one[0].currency === 'NGN', `Purchase for pixel ${id}: ${JSON.stringify(one)}`);
  }
  await p3.reload({ waitUntil: 'load' });
  if (HOSTED) {
    // Sandboxed hosting has no browser storage: after a refresh the customer sees the form again.
    // Sending the same details again returns the same order (replayed): shown, never counted twice.
    mode = 'replayed';
    await p3.click('text=Order Power Glow');
    await p3.fill('#fn', 'Simulated Reply Check'); await p3.fill('#ph', '08012345678');
    await p3.fill('#addr', 'TEST - simulated reply, no order is created'); await p3.fill('#em', 'skyfly-e2e@example.com');
    await p3.click('#sb');
    await p3.waitForSelector('#sb2 #skyRef', { state: 'visible', timeout: 30000 });
  } else {
    await p3.waitForSelector('#sb2 #skyRef', { state: 'visible', timeout: 30000 });
    // The same reply again (a repeated submission or a network retry returns the same order).
    await p3.evaluate((r) => window.Skyfly.trackPurchase({ ok: true, saved: true, reference: r, total: 58000, currency: 'NGN', test: false }), ref);
  }
  await sleep(3000);
  assert(purchases().length === LAROSE_PIXELS.length, `${purchases().length} Purchase events after a refresh and a repeated reply`);
  await p3.screenshot({ path: 'live-screenshots/larose-simulated-purchase.png', fullPage: false });
  await p3.close();
  return `failed order → 0; saved reply → 1 Purchase per pixel (${p.map((e) => e.id).join(' and ')}, eventID ${p[0].eid}, value ${p[0].value} ${p[0].currency}); refresh + repeated reply → still 1 each (intercepted, not sent to Meta)`;
});

await step('L. The test order appears exactly once in the Larose Natural Skincare Nigeria dashboard, with its Google Sheet status', () => {
  assert(reference, 'no test order was placed');
  return dashboardCheck(reference);
});

await browser.close();
if (blockedSteps) console.log(`\n${blockedSteps} check(s) BLOCKED (provider limit or missing credential, see above)`);
console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks that could run passed');
process.exit(failed ? 1 : 0);
