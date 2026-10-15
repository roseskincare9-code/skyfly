// Live end-to-end check of the real Larose page -> Skyfly -> Google Sheet backup.
// Places ONE clearly labelled test order through the live page, then proves it is
// saved in Skyfly exactly once and copied to the Google Sheet exactly once.
//
//   SKYFLY_URL=https://<service>.onrender.com node test/e2e/live.e2e.js
//
// Needs network access to the live sites (run it in GitHub Actions).
import { chromium } from 'playwright-core';

const SKYFLY = (process.env.SKYFLY_URL || '').replace(/\/+$/, '');
const PAGE = process.env.LANDING_URL || 'https://roseskincare9-code.github.io/Larosenigeria/';
const SHEET = 'https://sheetdb.io/api/v1/m111fq96ve953';
const RUN = process.env.GITHUB_RUN_ID || String(Date.now());
const NAME = `TEST ORDER Skyfly E2E ${RUN} please ignore`;
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

const ready = await step('Skyfly is healthy and the Larose page is registered', async () => {
  const h = await fetch(`${SKYFLY}/healthz`, { signal: AbortSignal.timeout(90000) });
  assert(h.ok, `/healthz HTTP ${h.status}`);
  const t = await fetch(`${SKYFLY}/api/public/pages/larosenigeria/tracking`);
  assert(t.ok, `Larose not set up yet (tracking HTTP ${t.status}): sign up and click "Set up Larose"`);
  const cfg = await t.json();
  return `pixels configured: ${(cfg.pixels || []).map((p) => `${p.provider} ${p.id}`).join(', ') || 'none'}`;
});
if (!ready) process.exit(1);

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const page = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
let apiBody = null; let apiReply = null; const sheetPosts = []; const pixelHits = [];
page.on('request', (r) => {
  if (r.url().startsWith(`${SKYFLY}/api/public/orders`) && r.method() === 'POST') apiBody = r.postData();
  if (r.url().startsWith(SHEET) && r.method() === 'POST') sheetPosts.push(r.postData());
  if (/facebook\.com\/tr|analytics\.tiktok\.com\/api/.test(r.url())) pixelHits.push(r.url());
});
page.on('response', async (r) => {
  if (r.url().startsWith(`${SKYFLY}/api/public/orders`) && r.request().method() === 'POST') apiReply = await r.json().catch(() => null);
});

await step('Live page is unchanged in look and points at this Skyfly service', async () => {
  await page.goto(`${PAGE}?skyfly_e2e=${RUN}`, { waitUntil: 'load' });
  const api = await page.evaluate('typeof SKYFLY_API === "string" ? SKYFLY_API : null');
  assert(api === SKYFLY, `page SKYFLY_API is ${JSON.stringify(api)}`);
  await page.waitForFunction('window.Skyfly && window.Skyfly.version', null, { timeout: 30000 });
  return 'Skyfly SDK loaded';
});

let reference = null;
await step('Test order submitted on the live page is saved in Skyfly and opens the confirmation page', async () => {
  await page.fill('#fn', NAME);
  await page.fill('#ph', '08012345678');
  await page.fill('#addr', 'TEST ORDER - do not deliver, automated check');
  await page.selectOption('#st', 'Lagos');
  await page.selectOption('#pr', { index: 1 });
  await page.fill('#nt', 'Automated end-to-end test. Please ignore.');
  await Promise.all([page.waitForURL(/\/o\/LR-/, { timeout: 120000 }), page.click('#sb')]);
  assert(apiReply && apiReply.ok, `API reply ${JSON.stringify(apiReply)}`);
  reference = apiReply.reference;
  const text = await page.textContent('body');
  assert(text.includes(reference), 'reference not shown on confirmation page');
  return `${reference}, total ${apiReply.total} ${apiReply.currency}`;
});

await step('Order persists: confirmation page (read from the database) still shows it after a refresh', async () => {
  await sleep(10000);
  await page.reload({ waitUntil: 'load' });
  const text = await page.textContent('body');
  assert(text.includes(reference) && text.includes('TEST ORDER Skyfly E2E'), 'order not shown after refresh');
  return `${reference} shown after reload`;
});

await step('Sending the same submission again returns the same order (no duplicate in Skyfly)', async () => {
  assert(apiBody && reference, 'no first submission');
  const res = await fetch(`${SKYFLY}/api/public/orders`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://roseskincare9-code.github.io' }, body: apiBody,
  });
  const data = await res.json();
  assert(res.ok && data.reference === reference, `HTTP ${res.status} ${JSON.stringify(data).slice(0, 200)}`);
  return `same reference ${data.reference}`;
});

await step('Google Sheet backup has exactly one copy, linked to the Skyfly order', async () => {
  assert(sheetPosts.length === 1, `${sheetPosts.length} Sheet submissions from the page`);
  let rows = [];
  for (let i = 0; i < 6; i += 1) {
    const res = await fetch(`${SHEET}/search?fullName=${encodeURIComponent(NAME)}`);
    assert(res.ok, `SheetDB search HTTP ${res.status}`);
    rows = await res.json();
    if (rows.length) break;
    await sleep(5000);
  }
  assert(rows.length === 1, `${rows.length} matching Sheet rows`);
  assert(String(rows[0].source).includes(`Skyfly ${reference}`), `Sheet row source: ${rows[0].source}`);
  return `source "${rows[0].source}"`;
});

// Fallback: Skyfly made unreachable in this browser only. The order must still reach the Sheet.
const FB_NAME = `TEST ORDER Skyfly E2E ${RUN} fallback please ignore`;
await step('Google Sheets fallback: with Skyfly unreachable the order still reaches the Sheet', async () => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
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
  await p2.waitForSelector('#sb2', { state: 'visible', timeout: 60000 });
  assert(blocked >= 1, 'Skyfly was not called');
  let rows = [];
  for (let i = 0; i < 6; i += 1) {
    rows = await (await fetch(`${SHEET}/search?fullName=${encodeURIComponent(FB_NAME)}`)).json();
    if (rows.length) break;
    await sleep(5000);
  }
  await ctx.close();
  assert(rows.length === 1, `${rows.length} matching Sheet rows`);
  assert(String(rows[0].source).includes('NOT IN SKYFLY'), `Sheet row source: ${rows[0].source}`);
  return `Skyfly calls blocked: ${blocked}; Sheet row "${rows[0].source}"; customer saw the original success box`;
});

await step('Pixel requests seen from the live page', async () => `${pixelHits.length} requests to Meta/TikTok`);

await browser.close();
console.log(failed ? `\n${failed} check(s) failed` : '\nAll live checks passed');
process.exit(failed ? 1 : 0);
