// Live end-to-end check of the real Larose page -> Skyfly (production) -> Google Sheet backup.
// Places ONE clearly labelled test order ("TEST ORDER …", saved as a test order) through
// the live page, plus one labelled fallback test row, and checks every step.
//
//   SKYFLY_URL=https://<service>.onrender.com [RENDER_API_KEY=…] node test/e2e/live.e2e.js
//
// Meta/TikTok pixel calls are intercepted and counted, never sent, so no test data reaches the ad platforms.
// With RENDER_API_KEY, the Skyfly service is restarted to prove the order survives a restart.
import { chromium } from 'playwright-core';

const SKYFLY = (process.env.SKYFLY_URL || '').replace(/\/+$/, '');
const PAGE = process.env.LANDING_URL || 'https://roseskincare9-code.github.io/Larosenigeria/';
const SHEET = 'https://sheetdb.io/api/v1/m111fq96ve953';
const RUN = process.env.GITHUB_RUN_ID || String(Date.now());
const NAME = `TEST ORDER Skyfly E2E ${RUN} please ignore`;
const FB_NAME = `TEST ORDER Skyfly E2E ${RUN} fallback please ignore`;
if (!/^https:\/\/[a-z0-9-]+\.onrender\.com$/.test(SKYFLY) || /\/\/skyfly\.onrender\.com/.test(SKYFLY)) {
  throw new Error('Set SKYFLY_URL to the verified Skyfly service address');
}

let failed = 0;
async function step(name, fn) {
  try { const info = await fn(); console.log(`PASS  ${name}${info ? ` — ${info}` : ''}`); return true; }
  catch (err) { failed += 1; console.log(`FAIL  ${name} — ${err.message}`); return false; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function sheetSearch(text) {
  const res = await fetch(`${SHEET}/search?source=${encodeURIComponent(`*${text}*`)}`);
  assert(res.ok, `SheetDB search HTTP ${res.status}`);
  return res.json();
}
async function waitForSheetRows(text, want, seconds = 120) {
  let rows = [];
  for (let i = 0; i < seconds / 10; i += 1) {
    rows = await sheetSearch(text);
    if (rows.length >= want) break;
    await sleep(10000);
  }
  return rows;
}

const ready = await step('A. Larose Natural Skincare Nigeria is set up on the live Skyfly (page, products, Meta Pixel)', async () => {
  const h = await fetch(`${SKYFLY}/healthz`, { signal: AbortSignal.timeout(90000) });
  assert(h.ok, `/healthz HTTP ${h.status}`);
  const t = await fetch(`${SKYFLY}/api/public/pages/larosenigeria/tracking`);
  assert(t.ok, `Larose is not set up (tracking HTTP ${t.status})`);
  const cfg = await t.json();
  const meta = (cfg.pixels || []).find((p) => p.provider === 'meta');
  assert(meta?.id === '1357015185691765', `Meta Pixel in Skyfly: ${JSON.stringify(cfg.pixels)}`);
  return `pixels: ${cfg.pixels.map((p) => `${p.provider} ${p.id}`).join(', ')}`;
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
  const text = `${u.search} ${r.postData() || ''}`;
  const field = (name) => text.match(new RegExp(`[?&\\s]${name}=([^&\\s]+)`))?.[1] ?? text.match(new RegExp(`name="${name}"\\r?\\n\\r?\\n([^\\r\\n]+)`))?.[1] ?? null;
  pixelEvents.push({ host: u.host, id: field('id'), ev: field('ev') || field('event') || '?' });
  return route.fulfill({ status: 200, contentType: 'image/gif', body: '' });
});
const page = await ctx.newPage();
let apiBody = null; let apiReply = null; const sheetPosts = []; const navigations = [];
page.on('request', (r) => {
  if (r.url().startsWith(`${SKYFLY}/api/public/orders`) && r.method() === 'POST') apiBody = r.postData();
  if (r.url().startsWith(SHEET) && r.method() === 'POST') sheetPosts.push(r.postData());
});
page.on('framenavigated', (f) => { if (f === page.mainFrame()) navigations.push(f.url()); });
page.on('response', async (r) => {
  if (r.url().startsWith(`${SKYFLY}/api/public/orders`) && r.request().method() === 'POST') apiReply = await r.json().catch(() => null);
});

await step('K. The live Larose page opens and points at this Skyfly service', async () => {
  const res = await page.goto(`${PAGE}?skyfly_e2e=${RUN}`, { waitUntil: 'load' });
  assert(res.status() === 200, `HTTP ${res.status()}`);
  const api = await page.evaluate('typeof SKYFLY_API === "string" ? SKYFLY_API : null');
  assert(api === SKYFLY, `page SKYFLY_API is ${JSON.stringify(api)}`);
  await page.waitForFunction('window.Skyfly && window.Skyfly.version', null, { timeout: 30000 });
  return `${PAGE} (HTTP 200, Skyfly SDK loaded)`;
});

let reference = null;
let confirmationUrl = null;
await step('C/H. A test order placed through the real checkout is saved and the confirmation page opens (not WhatsApp)', async () => {
  await page.click('text=Order Power Glow');
  await page.fill('#fn', NAME);
  await page.fill('#ph', '08012345678');
  await page.fill('#addr', 'TEST ORDER - do not deliver, automated check');
  await page.selectOption('#st', 'Lagos');
  await page.selectOption('#qty', '2');
  await page.fill('#nt', 'Automated end-to-end test. Please ignore.');
  if (await page.$('#skySum')) { // order summary (newer page version)
    const summary = await page.textContent('#skySum');
    assert(/Power Glow × 2/.test(summary) && /₦103,000/.test(summary), `order summary: ${summary}`);
  }
  await Promise.all([page.waitForURL(/\/o\/LR-/, { timeout: 120000 }), page.click('#sb')]);
  assert(apiReply && apiReply.ok, `API reply ${JSON.stringify(apiReply)}`);
  reference = apiReply.reference;
  confirmationUrl = page.url();
  const text = await page.textContent('body');
  assert(text.includes(reference) && /What happens next/.test(text), 'confirmation page content');
  assert(!navigations.some((u) => /wa\.me|whatsapp\.com/.test(u)), 'navigated to WhatsApp');
  return `${reference}, total ₦${apiReply.total.toLocaleString('en-NG')}; page wrote ${sheetPosts.length} sheet row(s) itself`;
});

await step('D. The order persists: the confirmation page (read from the database) still shows it after a refresh', async () => {
  await page.reload({ waitUntil: 'load' });
  const text = await page.textContent('body');
  assert(text.includes(reference) && text.includes('TEST ORDER Skyfly E2E'), 'order not shown after refresh');
  return `${reference} shown after reload`;
});

await step('F. Sending the same submission again returns the same order (no duplicate)', async () => {
  assert(apiBody && reference, 'no first submission');
  const res = await fetch(`${SKYFLY}/api/public/orders`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://roseskincare9-code.github.io' }, body: apiBody,
  });
  const data = await res.json();
  assert(res.status === 200 && data.reference === reference && data.replayed === true, `HTTP ${res.status} ${JSON.stringify(data).slice(0, 200)}`);
  return `HTTP 200, same reference ${data.reference}, replayed`;
});

await step('G. The Google Sheet (SheetDB) accepts rows: it has a header row', async () => {
  const res = await fetch(`${SHEET}/keys`);
  const body = await res.json().catch(() => ({}));
  assert(res.ok && Array.isArray(body) && body.length, `SheetDB /keys HTTP ${res.status}: ${JSON.stringify(body).slice(0, 200)}`);
  return `columns: ${body.join(', ')}`;
});

await step('G. The order is in the Google Sheet exactly once, even after Skyfly\'s own delayed copy has run', async () => {
  const rows = await waitForSheetRows(reference, 1, 300);
  assert(rows.length >= 1, `no sheet row for ${reference}`);
  // Skyfly's server copy runs ~3 minutes after the order and must find the page's row instead of adding one.
  await sleep(sheetPosts.length ? 240000 : 30000);
  const again = await sheetSearch(reference);
  assert(again.length === 1, `${again.length} rows for ${reference} (duplicate)`);
  return `1 row: "${again[0].source}" (written by ${sheetPosts.length ? 'the page; Skyfly found it and did not add another' : 'Skyfly'})`;
});

await step('I. Meta Pixel: PageView once, Lead once for the order, no browser Purchase', async () => {
  const meta = pixelEvents.filter((e) => e.host.endsWith('facebook.com') && e.id === '1357015185691765');
  const count = (ev) => meta.filter((e) => e.ev === ev).length;
  const summary = [...new Set(meta.map((e) => e.ev))].map((ev) => `${ev}×${count(ev)}`).join(', ');
  assert(count('PageView') === 1, `PageView ${count('PageView')} (${summary}); requests seen: ${pixelSeen.slice(0, 8).join(', ') || 'none'}`);
  assert(count('Lead') === 1, `Lead ${count('Lead')} (${summary})`);
  assert(count('Purchase') === 0, `Purchase ${count('Purchase')} (${summary})`);
  return `${summary} (intercepted, not sent to Meta)`;
});

if (process.env.RENDER_API_KEY) {
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

await step('G. Fallback: with Skyfly unreachable the order still reaches the Google Sheet, marked NOT IN SKYFLY', async () => {
  const p2 = await ctx.newPage();
  let blocked = 0;
  await p2.route(`${SKYFLY}/api/public/orders`, (route) => { blocked += 1; return route.abort(); });
  await p2.goto(`${PAGE}?skyfly_e2e=${RUN}-fallback`, { waitUntil: 'load' });
  await p2.fill('#fn', FB_NAME);
  await p2.fill('#ph', '08012345678');
  await p2.fill('#addr', 'TEST ORDER - do not deliver, automated fallback check');
  await p2.selectOption('#st', 'Lagos');
  await p2.selectOption('#pr', { index: 1 });
  await p2.click('#sb');
  await p2.waitForSelector('#sb2', { state: 'visible', timeout: 90000 });
  assert(blocked >= 1, 'Skyfly was not called');
  const rows = await waitForSheetRows(`${RUN} fallback`, 1, 60);
  await p2.close();
  assert(rows.length === 1, `${rows.length} matching sheet rows`);
  assert(/NOT IN SKYFLY/.test(rows[0].source), `source: ${rows[0].source}`);
  return `Skyfly calls blocked: ${blocked}; sheet row "${rows[0].source}" (listed in Skyfly → Google Sheet backup for recovery)`;
});

await browser.close();
console.log(failed ? `\n${failed} check(s) failed` : '\nAll live checks passed');
process.exit(failed ? 1 : 0);
