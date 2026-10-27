// Live check of Larose's Meta pixels on the deployed page: the main pixel (1357015185691765, in the
// page's own code), "Pixel New" (1087347357386553) and the ad-account pixels (migration 029), loaded by
// Skyfly. Places NO order: the
// order API is answered by the test (a failure, then a saved-order reply), and every pixel hit is
// intercepted and counted, never sent, so nothing reaches Meta, Skyfly's orders or the Sheet.
//
//   SKYFLY_URL=https://<service>.onrender.com [LANDING_URL=…] node test/e2e/live-pixels.e2e.js
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright-core';

const SKYFLY = (process.env.SKYFLY_URL || '').replace(/\/+$/, '');
const PAGE = process.env.LANDING_URL || 'https://roseskincare9-code.github.io/Larosenigeria/';
const HOSTED = PAGE.startsWith(SKYFLY);
const PAGE_KEY = HOSTED ? 'larose-skincare' : 'larosenigeria';
const PIXELS = {
  '1357015185691765': 'main pixel', '1087347357386553': 'Pixel New',
  '1105657388903531': 'Skyfly', '1653102723149813': 'Skindrips', '1130654146607839': 'Skindrip', '4389240701387003': 'Moon fly',
  // "skincare" (migration 034) is assigned to the GitHub Pages Larose page only.
  ...(HOSTED ? {} : { '1395209215400304': 'skincare' }),
};
const IDS = Object.keys(PIXELS);
// Optional: a pixel that must be on the page (e.g. one just added in the dashboard).
const EXPECT = (process.env.EXPECT_PIXEL || '').trim();
if (EXPECT && !/^\d{10,20}$/.test(EXPECT)) throw new Error('EXPECT_PIXEL should be a Meta pixel ID (10–20 digits)');
if (!/^https:\/\/[a-z0-9-]+\.onrender\.com$/.test(SKYFLY) || /\/\/skyfly\.onrender\.com/.test(SKYFLY)) {
  throw new Error('Set SKYFLY_URL to the verified Skyfly service address');
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
async function step(name, fn) {
  try { console.log(`PASS  ${name}\n      ${await fn()}`); } catch (err) { failed += 1; console.log(`FAIL  ${name}\n      ${err.message}`); }
}
const assert = (ok, msg) => { if (!ok) throw new Error(msg); };
console.log(`Page: ${PAGE}\nSkyfly: ${SKYFLY}\n`);

await step('Skyfly lists every Larose pixel for this page once, by ID, with no token', async () => {
  const res = await fetch(`${SKYFLY}/api/public/pages/${PAGE_KEY}/tracking`);
  const raw = await res.text();
  const cfg = JSON.parse(raw);
  // Every other Meta pixel set up for this page in the dashboard (e.g. one the owner added under
  // Tracking & Pixels) gets the same checks.
  for (const p of cfg.pixels) {
    if (p.provider === 'meta' && !PIXELS[p.id]) { PIXELS[p.id] = `dashboard pixel ${p.id}`; IDS.push(p.id); }
  }
  if (EXPECT && !PIXELS[EXPECT]) throw new Error(`pixel ${EXPECT} is not set up for this page: add it under Tracking & Pixels → Meta → Connect Meta Pixel (tick this page)`);
  for (const id of IDS) {
    const p = cfg.pixels.find((x) => x.provider === 'meta' && x.id === id);
    assert(p && p.events.includes('PageView') && p.events.includes('InitiateCheckout') && p.events.includes('Purchase'), `${PIXELS[id]} ${id}: ${JSON.stringify(cfg.pixels)}`);
  }
  assert(cfg.pixels.filter((p) => IDS.includes(p.id)).length === IDS.length, 'a pixel is listed twice');
  assert(!/token|EAA[A-Za-z0-9]{20,}|secret/i.test(raw), 'token-like value in the public config');
  return cfg.pixels.map((p) => `${p.provider} ${p.id} [${p.events.join(', ')}]`).join('; ');
});

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
});
const hits = [];
await ctx.route(/https:\/\/([a-z0-9-]+\.)*facebook\.com\//, (route) => {
  const r = route.request();
  const u = new URL(r.url());
  if (!/\/tr\/?$/.test(u.pathname)) return route.continue(); // the official pixel script and its config load normally
  let text = `${u.search} ${r.postData() || ''}`;
  try { text = decodeURIComponent(text.replace(/\+/g, ' ')); } catch { /* keep */ }
  const field = (name) => {
    const n = name.replace(/[[\]]/g, '\\$&');
    return text.match(new RegExp(`[?&\\s]${n}=([^&\\s]+)`))?.[1] ?? text.match(new RegExp(`name="${n}"\\r?\\n\\r?\\n([^\\r\\n]+)`))?.[1] ?? null;
  };
  hits.push({ id: field('id'), ev: field('ev'), eid: field('eid'), value: field('cd[value]'), currency: field('cd[currency]') });
  return route.fulfill({ status: 200, contentType: 'image/gif', body: '' }); // counted, never sent
});
// Meta's per-pixel configuration, fetched by the official pixel script for each pixel it initialises.
// Meta serves it for any well-formed ID, so it shows the pixel was initialised, not that the account works.
const configs = {};
ctx.on('response', (r) => { const m = r.url().match(/connect\.facebook\.net\/signals\/config\/(\d+)/); if (m) configs[m[1]] = r.status(); });
// "Tag loaded": the page tells Skyfly which pixels' scripts loaded (the dashboard status). Watched,
// not changed: it only updates that status, as any visitor's browser does.
const seenReports = [];
ctx.on('request', (r) => { if (r.url() === `${SKYFLY}/api/public/pixels-seen`) seenReports.push({ body: r.postData() || '', status: null, req: r }); });
ctx.on('response', (r) => { const s = seenReports.find((x) => x.req === r.request()); if (s) s.status = r.status(); });
const pageErrors = [];
const count = (from, id, ev) => hits.slice(from).filter((h) => h.id === id && h.ev === ev).length;
const summary = (from) => IDS.map((id) => `${PIXELS[id]}: ${[...new Set(hits.slice(from).filter((h) => h.id === id).map((h) => h.ev))].map((ev) => `${ev}×${count(from, id, ev)}`).join(', ') || 'none'}`).join(' | ');
const waitFor = async (fn, ms = 15000) => { for (let i = 0; i < ms / 250 && !fn(); i += 1) await sleep(250); };

const page = await ctx.newPage();
page.on('pageerror', (e) => pageErrors.push(String(e.message).slice(0, 160)));
let mode = 'fail';
let orderCalls = 0;
const ref = `LR-SIM${String(process.env.GITHUB_RUN_ID || Date.now()).replace(/\D/g, '').slice(-5).padStart(5, '0')}`;
await page.route(`${SKYFLY}/api/public/orders`, (route) => {
  if (route.request().method() !== 'POST') return route.continue();
  orderCalls += 1;
  return mode === 'fail'
    ? route.fulfill({ status: 500, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': HOSTED ? '*' : 'https://roseskincare9-code.github.io' }, body: JSON.stringify({ ok: false, error: 'SERVER_ERROR', message: 'We could not save your order. Please try again in a moment.' }) })
    : route.fulfill({ status: 201, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': HOSTED ? '*' : 'https://roseskincare9-code.github.io' },
      body: JSON.stringify({ ok: true, saved: true, reference: ref, business: 'larose-nigeria', purchaseEventId: `purchase_${ref}`, total: 58000, currency: 'NGN', confirmationUrl: `${SKYFLY}/o/${ref}?t=simulated`, replayed: mode === 'replayed', test: false }) });
});

await step('Page load: PageView once for each pixel; no InitiateCheckout, Lead or Purchase', async () => {
  await page.goto(`${PAGE}?skyfly_pixel_check=${Date.now()}`, { waitUntil: 'load' });
  await waitFor(() => IDS.every((id) => count(0, id, 'PageView') >= 1));
  await sleep(3000);
  for (const id of IDS) {
    assert(count(0, id, 'PageView') === 1, `${PIXELS[id]} PageView ×${count(0, id, 'PageView')} (${summary(0)})`);
    for (const ev of ['InitiateCheckout', 'Lead', 'Purchase']) assert(count(0, id, ev) === 0, `${PIXELS[id]} ${ev} on load (${summary(0)})`);
  }
  for (const id of IDS) assert(configs[id], `${PIXELS[id]} ${id}: the pixel script never initialised it (no configuration request)`);
  return `${summary(0)}\n      Meta pixel configuration: ${IDS.map((id) => `${PIXELS[id]} ${id} HTTP ${configs[id]}`).join(', ')}`;
});

await step('Tag loaded: the page tells Skyfly that every pixel loaded here (dashboard "Tag loaded")', async () => {
  await waitFor(() => IDS.every((id) => seenReports.some((r) => r.body.includes(`"${id}"`))), 10000);
  const reported = [...new Set(seenReports.flatMap((r) => { try { return JSON.parse(r.body).pixels.map((p) => p.id); } catch { return []; } }))];
  const state = await page.evaluate(() => ({ fbq: typeof window.fbq, callMethod: typeof window.fbq?.callMethod,
    fbevents: [...document.scripts].filter((s) => /fbevents\.js/.test(s.src)).length, skyfly: [...document.scripts].some((s) => /skyfly/.test(s.src)) }));
  const detail = `reports sent: ${seenReports.length} (HTTP ${seenReports.map((r) => r.status).join(', ') || '-'}); IDs reported: ${reported.join(', ') || 'none'}; page: fbq ${state.fbq}, fbevents.js loaded (callMethod ${state.callMethod}), fbevents.js script tags ${state.fbevents}, Skyfly script ${state.skyfly}; page errors: ${pageErrors.join(' | ') || 'none'}`;
  for (const id of IDS) assert(reported.includes(id), `${PIXELS[id]} ${id} not reported. ${detail}`);
  assert(seenReports.every((r) => r.status === 200), `report refused. ${detail}`);
  return detail;
});

await step('Starting the order form: InitiateCheckout once for each pixel', async () => {
  await page.click('text=Order Power Glow');
  await page.fill('#fn', 'Pixel Check (simulated, no order)');
  await page.fill('#ph', '08012345678');
  await waitFor(() => IDS.every((id) => count(0, id, 'InitiateCheckout') >= 1));
  await sleep(1500);
  for (const id of IDS) assert(count(0, id, 'InitiateCheckout') === 1, `${PIXELS[id]} InitiateCheckout ×${count(0, id, 'InitiateCheckout')} (${summary(0)})`);
  return summary(0);
});

await step('Incomplete form, then an order API error: no Lead and no Purchase for either pixel', async () => {
  await page.fill('#addr', '');
  await page.click('#sb');
  await sleep(1500);
  const invalidCalls = orderCalls;
  await page.fill('#addr', 'TEST - simulated reply, no order is created');
  await page.fill('#em', 'skyfly-e2e@example.com');
  await page.click('#sb');
  await page.waitForSelector('#skyErr', { state: 'visible', timeout: 90000 });
  await sleep(2500);
  for (const id of IDS) for (const ev of ['Lead', 'Purchase']) assert(count(0, id, ev) === 0, `${PIXELS[id]} ${ev} without a saved order (${summary(0)})`);
  assert(!(await page.isVisible('#sb2')), 'confirmation shown for a failed order');
  return `order API calls: ${invalidCalls} for the incomplete form, ${orderCalls - invalidCalls} for the failed save; ${summary(0)}`;
});

let afterSave;
await step('Saved-order reply: Lead and Purchase once for each pixel; Purchase has the saved total in NGN and event ID purchase_<reference>', async () => {
  mode = 'saved';
  await page.click('#sb');
  await page.waitForSelector('#sb2 #skyRef', { state: 'visible', timeout: 60000 });
  await waitFor(() => IDS.every((id) => count(0, id, 'Purchase') >= 1));
  await sleep(2500);
  for (const id of IDS) {
    assert(count(0, id, 'Lead') === 1, `${PIXELS[id]} Lead ×${count(0, id, 'Lead')} (${summary(0)})`);
    const p = hits.filter((h) => h.id === id && h.ev === 'Purchase');
    assert(p.length === 1, `${PIXELS[id]} Purchase ×${p.length} (${summary(0)})`);
    assert(p[0].eid === `purchase_${ref}` && Number(p[0].value) === 58000 && p[0].currency === 'NGN', `${PIXELS[id]} Purchase ${JSON.stringify(p[0])}`);
  }
  afterSave = hits.length;
  await page.screenshot({ path: 'live-screenshots/pixels-saved.png' });
  return summary(0);
});

await step('Refresh, and the same reply again (retry / duplicate): no second Purchase', async () => {
  await page.reload({ waitUntil: 'load' });
  await sleep(4000);
  if (HOSTED) {
    // Sandboxed hosting has no browser storage, so the page shows the form again after a refresh;
    // sending the same details again returns the same order ("replayed"): shown, never counted again.
    mode = 'replayed';
    await page.click('text=Order Power Glow');
    await page.fill('#fn', 'Pixel Check (simulated, no order)');
    await page.fill('#ph', '08012345678');
    await page.fill('#addr', 'TEST - simulated reply, no order is created');
    await page.fill('#em', 'skyfly-e2e@example.com');
    await page.click('#sb');
    await page.waitForSelector('#sb2 #skyRef', { state: 'visible', timeout: 60000 });
  } else {
    await page.evaluate((r) => window.Skyfly && window.Skyfly.trackPurchase({ ok: true, saved: true, reference: r, total: 58000, currency: 'NGN', test: false }), ref);
  }
  await sleep(2500);
  for (const id of IDS) assert(count(afterSave, id, 'Purchase') === 0 && count(afterSave, id, 'Lead') === 0, `${PIXELS[id]} after refresh/repeat: ${summary(afterSave)}`);
  return `after refresh: ${summary(afterSave)}`;
});

await browser.close();
console.log(failed ? `\n${failed} check(s) failed` : '\nAll pixel checks passed (no order created; pixel hits intercepted, not sent to Meta)');
process.exit(failed ? 1 : 0);
