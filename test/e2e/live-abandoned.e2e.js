// Live check of abandoned checkouts on the deployed Skyfly, on the labelled demo shop (test mode)
// with the restricted live-test owners (owner A: demo shop; owner B: import test business). A
// customer starts a TEST checkout on a phone and leaves; it shows as in progress, then abandoned
// (idle time set to the 10-minute minimum for this run, then put back), to owner A only; the
// resume link brings back the products; the order is placed once; the checkout shows as
// recovered. Pixel calls are intercepted, never sent. Takes about 12 minutes.
//
//   SKYFLY_URL=https://<service>.onrender.com SKYFLY_OWNER_PASSWORD=… node test/e2e/live-abandoned.e2e.js
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { chromium, devices } from 'playwright-core';

const SKYFLY = (process.env.SKYFLY_URL || '').replace(/\/+$/, '');
if (!/^https:\/\/[a-z0-9-]+\.onrender\.com$|^https:\/\/getskyfly\.com$|^http:\/\/localhost:\d+$/.test(SKYFLY) || /\/\/skyfly\.onrender\.com/.test(SKYFLY)) throw new Error('Set SKYFLY_URL to the verified Skyfly service address');
const PASSWORD = process.env.SKYFLY_OWNER_PASSWORD;
if (!PASSWORD) throw new Error('No live-test sign-in: run this through the "Live import test" workflow');
const RUN = process.env.GITHUB_RUN_ID || String(Date.now());
const NAME = `TEST ORDER abandoned ${RUN}`;
const PAGE = `${SKYFLY}/p/skyfly-demo/`;
const WAIT_MINUTES = Number(process.env.ABANDON_WAIT_MINUTES || 13);
const shots = path.resolve('live-screenshots');
mkdirSync(shots, { recursive: true });

let failed = 0;
async function step(name, fn) {
  try { const info = await fn(); console.log(`PASS  ${name}${info ? ` — ${info}` : ''}`); return true; }
  catch (err) { failed += 1; console.log(`FAIL  ${name} — ${err.message.split('\n')[0]}`); return false; }
}
const assert = (c, m) => { if (!c) throw new Error(m); };
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const phone = () => browser.newContext({ ...devices['iPhone 13'] });
async function signIn(email) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const p = await ctx.newPage();
  await p.goto(`${SKYFLY}/login`);
  await p.fill('#email', email); await p.fill('#password', PASSWORD);
  await Promise.all([p.waitForLoadState('load'), p.click('main button[type=submit]')]);
  if (p.url().endsWith('/login')) throw new Error(`sign-in refused for ${email}`);
  return p;
}
const blockPixels = (ctx) => ctx.route(/https:\/\/([a-z0-9-]+\.)*(facebook\.com|facebook\.net|tiktok\.com)\//, (r) => r.fulfill({ status: 204, body: '' }));

const a = await signIn('e2e-owner-a@skyfly.invalid');
const A = a.url().match(/\/businesses\/(\d+)/)?.[1];
const b = await signIn('e2e-owner-b@skyfly.invalid');
const B = b.url().match(/\/businesses\/(\d+)/)?.[1];
let originalMinutes = null; let detailUrl = null; let link = null;

const setMinutes = async (minutes) => {
  await a.goto(`${SKYFLY}/businesses/${A}/checkouts`);
  await a.fill('#abandoned_after_minutes', String(minutes));
  await Promise.all([a.waitForLoadState('load'), a.click('form[action$="/checkouts/settings"] button')]);
};
const listText = async (status) => { await a.goto(`${SKYFLY}/businesses/${A}/checkouts?status=${status}&test=include`); return a.textContent('main'); };

await step('LA1. Owner A opens Abandoned Checkouts (separate from Orders) and sets the idle time to 10 minutes for this run', async () => {
  assert(A && B, `businesses: A ${A}, B ${B}`);
  await a.goto(`${SKYFLY}/businesses/${A}/checkouts`);
  assert(/Abandoned checkouts/.test(await a.textContent('main h1')), 'section missing');
  originalMinutes = await a.inputValue('#abandoned_after_minutes');
  await setMinutes(10);
  return `was ${originalMinutes} minutes; now 10`;
});

await step('LA2. A customer on a phone chooses a package and the add-on, types their details and leaves without ordering: saved, shown to owner A as in progress, not as an order', async () => {
  const ctx = await phone(); await blockPixels(ctx);
  const p = await ctx.newPage();
  await p.goto(PAGE, { waitUntil: 'load' });
  await p.waitForSelector('input[name=sky_product]', { timeout: 30000 });
  await p.check('input[name=sky_product] >> nth=1');
  if (await p.$('[data-addon]')) await p.click('[data-addon]');
  await p.fill('#sky-name', NAME);
  await p.fill('#sky-phone', '08012345678');
  await p.fill('#sky-address', 'TEST ORDER - automated check, do not deliver');
  await p.waitForTimeout(3000);
  await p.close({ runBeforeUnload: true });
  await ctx.close();
  let text = '';
  for (let i = 0; i < 10 && !text.includes(NAME); i += 1) { await a.waitForTimeout(2000); text = await listText('active'); }
  assert(text.includes(NAME), 'not listed as in progress');
  detailUrl = await a.getAttribute(`tr:has-text("${NAME}") a[href*="/checkouts/"]`, 'href');
  await a.goto(`${SKYFLY}/businesses/${A}/orders`);
  assert(!(await a.textContent('main')).includes(NAME), 'shown under Orders');
  return `listed as In progress (${detailUrl}); not under Orders`;
});

await step('LA3. Owner B cannot see owner A\'s checkout (list, detail, follow-up)', async () => {
  await b.goto(`${SKYFLY}/businesses/${B}/checkouts?status=all&test=include`);
  assert(!(await b.textContent('main')).includes(NAME), 'listed for owner B');
  for (const url of [`/businesses/${A}/checkouts`, detailUrl, detailUrl.replace(`/businesses/${A}/`, `/businesses/${B}/`)]) {
    const r = await b.request.get(`${SKYFLY}${url}`, { maxRedirects: 0 });
    assert(r.status() === 404, `${url}: HTTP ${r.status()}`);
  }
  return 'list, detail and the same checkout under B\'s address → 404';
});

await step(`LA4. After 10 idle minutes the checkout is abandoned (checked for up to ${WAIT_MINUTES} minutes), with contact details, products, value and follow-up`, async () => {
  const start = Date.now();
  let text = '';
  while (Date.now() - start < WAIT_MINUTES * 60000) {
    text = await listText('abandoned');
    if (text.includes(NAME)) break;
    await a.waitForTimeout(30000);
  }
  assert(text.includes(NAME), 'not abandoned in time');
  await a.goto(`${SKYFLY}${detailUrl}`);
  const detail = await a.textContent('main');
  assert(/Abandoned/.test(detail) && detail.includes('08012345678'.slice(1)) && /₦/.test(detail), 'detail incomplete');
  assert(/^https:\/\/wa\.me\/2348012345678\?text=/.test(await a.getAttribute('[data-contact=whatsapp]', 'href')), 'no WhatsApp follow-up');
  link = (await a.textContent('[data-follow-up] code')).trim();
  await a.screenshot({ path: path.join(shots, 'abandoned-detail.png'), fullPage: true });
  return `abandoned after ${Math.round((Date.now() - start) / 60000)} more minute(s); WhatsApp/call follow-up and resume link shown`;
});

await step('LA5. The resume link brings back the products on another phone; the order is placed (tapped twice) once; the checkout shows as recovered with that order', async () => {
  const ctx = await phone(); await blockPixels(ctx);
  const p = await ctx.newPage();
  await p.goto(link, { waitUntil: 'load' });
  await p.waitForSelector('input[name=sky_product]', { timeout: 30000 });
  assert(await p.isChecked('input[name=sky_product] >> nth=1'), 'package not restored');
  assert((await p.inputValue('#sky-name')) === '', 'personal details came back through the link');
  await p.fill('#sky-name', NAME);
  await p.fill('#sky-phone', '08012345678');
  await p.fill('#sky-address', 'TEST ORDER - automated check, do not deliver');
  await p.click('form button[type=submit]');
  await p.waitForSelector('[data-place]');
  await p.click('[data-place]');
  await p.click('[data-place]', { force: true, noWaitAfter: true }).catch(() => {});
  await p.waitForSelector('[data-skyfly-reference]', { timeout: 60000 });
  const ref = (await p.textContent('[data-skyfly-reference]')).trim();
  await ctx.close();
  await a.goto(`${SKYFLY}${detailUrl}`);
  const detail = await a.textContent('main');
  assert(/Recovered/.test(detail) && detail.includes(ref), `detail: ${detail.replace(/\s+/g, ' ').slice(0, 160)}`);
  await a.goto(`${SKYFLY}/businesses/${A}/orders?q=${encodeURIComponent(ref)}`);
  const rows = await a.locator(`tbody tr:has-text("${ref}")`).count();
  assert(rows === 1, `order listed ${rows} times`);
  return `${ref}: one order; checkout Recovered`;
});

await step('LA6. The idle time is put back', async () => {
  await setMinutes(originalMinutes || 60);
  return `${originalMinutes || 60} minutes`;
});

await browser.close();
console.log(failed ? `\n${failed} check(s) failed` : '\nAll abandoned-checkout checks passed');
process.exit(failed ? 1 : 0);
