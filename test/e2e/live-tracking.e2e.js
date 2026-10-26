// Live check of Tracking & Pixels on the deployed Skyfly, on the import test business only (owner B
// of the live-test accounts). Through the dashboard, with no redeploy: adds 3 Meta, 3 TikTok and 2 X
// test tracking IDs, checks the live page loads each once (third-party scripts are stubbed in the
// browser, so nothing reaches Meta, TikTok or X), switches one off, checks owner A cannot reach them
// and Larose's page keeps its own pixels, then removes every ID it added. Places no order.
//
//   SKYFLY_URL=https://<service>.onrender.com SKYFLY_OWNER_PASSWORD=… node test/e2e/live-tracking.e2e.js
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { chromium, devices } from 'playwright-core';

const SKYFLY = (process.env.SKYFLY_URL || '').replace(/\/+$/, '');
if (!/^https:\/\/[a-z0-9-]+\.onrender\.com$|^http:\/\/localhost:\d+$/.test(SKYFLY) || /\/\/skyfly\.onrender\.com/.test(SKYFLY)) throw new Error('Set SKYFLY_URL to the verified Skyfly service address');
const PASSWORD = process.env.SKYFLY_OWNER_PASSWORD;
if (!PASSWORD) throw new Error('No live-test sign-in: run this through the "Live import test" workflow');
const OWNER = 'e2e-owner-b@skyfly.invalid';
const OTHER = 'e2e-owner-a@skyfly.invalid';
const NAME = 'Skyfly Import Test';
// Test-only IDs (not real ad accounts), different on each run.
const n = String(process.env.GITHUB_RUN_ID || Date.now()).slice(-6).padStart(6, '0');
const IDS = {
  meta: [1, 2, 3].map((i) => `99${n}0000000${i}`),
  tiktok: [1, 2, 3].map((i) => `E2ETRACK${n}00000${i}`),
  x: [1, 2].map((i) => `e2e${n.slice(-4)}${i}`),
};
const LAROSE_IDS = ['1357015185691765', '1087347357386553', '1105657388903531', '1653102723149813', '1130654146607839', '4389240701387003'];
const shots = path.resolve('live-screenshots');
mkdirSync(shots, { recursive: true });

let failed = 0;
async function step(name, fn) {
  try { const info = await fn(); console.log(`PASS  ${name}${info ? ` — ${info}` : ''}`); return true; }
  catch (err) { failed += 1; console.log(`FAIL  ${name} — ${err.message.split('\n')[0]}`); return false; }
}
const assert = (c, m) => { if (!c) throw new Error(m); };

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
async function signIn(email) {
  const ctx = await browser.newContext({ ...devices['iPhone 13'] });
  const p = await ctx.newPage();
  p.setDefaultTimeout(20000);
  await p.goto(`${SKYFLY}/login`);
  await p.fill('#email', email); await p.fill('#password', PASSWORD);
  await Promise.all([p.waitForLoadState('load'), p.click('main button[type=submit]')]);
  assert(!p.url().endsWith('/login'), `sign-in refused for ${email}`);
  return p;
}
const larose = async () => (await (await fetch(`${SKYFLY}/api/public/pages/larosenigeria/tracking`)).json()).pixels.map((p) => p.id);

let dash; let biz; let page; let liveUrl; const added = [];
const laroseBefore = await larose();
try {
  await step('L1. Owner B opens Tracking & Pixels: Meta, TikTok and X tabs; the business has a published page', async () => {
    dash = await signIn(OWNER);
    biz = dash.url().match(/\/businesses\/(\d+)/)?.[1];
    assert(biz, `landed on ${dash.url()}`);
    assert((await dash.textContent('main')).includes(NAME), 'not the import test business');
    await dash.goto(`${SKYFLY}/businesses/${biz}/pixels`);
    const tabs = await dash.$$eval('[data-tab]', (els) => els.map((e) => e.getAttribute('data-tab')));
    assert(tabs.join() === 'meta,tiktok,x', `tabs: ${tabs}`);
    await dash.goto(`${SKYFLY}/businesses/${biz}/landing-pages`);
    liveUrl = (await dash.content()).match(/href="(https?:\/\/[^"]+\/([a-z0-9-]+)\/)" target="_blank" rel="noopener">Open ↗/)?.[1];
    assert(liveUrl, 'no published page address on Landing Pages');
    page = liveUrl.match(/\/([a-z0-9-]+)\/$/)[1];
    return `business #${biz}, page ${liveUrl}`;
  });

  if (!liveUrl) throw new Error('stopped: the business or its page was not found');
  const add = async (platform, id, i, extra = {}) => {
    await dash.goto(`${SKYFLY}/businesses/${biz}/pixels/new?platform=${platform}`);
    await dash.fill('#name', `E2E ${platform} ${i}`);
    await dash.fill('#pixel_id', id);
    if (i === 1) await dash.check('input[name=all_pages]');
    else await dash.locator('input[name=pages]').first().check();
    for (const [e, v] of Object.entries(extra)) await dash.fill(`#x_event_${e}`, v);
    await Promise.all([dash.waitForLoadState('load'), dash.click('[data-tracking-form] button[type=submit]')]);
    assert(/done=added/.test(dash.url()), `${platform} ${id} not added: ${(await dash.textContent('[role=alert]', { timeout: 2000 }).catch(() => '')) || dash.url()}`);
    added.push(id);
  };

  await step('L2. Adds 3 Meta, 3 TikTok and 2 X tracking IDs from the dashboard (no redeploy); each is listed on its tab', async () => {
    for (const [i, id] of IDS.meta.entries()) await add('meta', id, i + 1);
    for (const [i, id] of IDS.tiktok.entries()) await add('tiktok', id, i + 1);
    for (const [i, id] of IDS.x.entries()) await add('x', id, i + 1, { Purchase: `p${n.slice(-4)}${i}` });
    for (const pl of ['meta', 'tiktok', 'x']) {
      await dash.goto(`${SKYFLY}/businesses/${biz}/pixels?platform=${pl}`);
      for (const id of IDS[pl]) assert(await dash.locator(`tr[data-pixel="${id}"][data-enabled="true"]`).count() === 1, `${id} not listed as enabled`);
    }
    await dash.screenshot({ path: path.join(shots, 'tracking-x-tab.png'), fullPage: true });
    return `${added.length} IDs added`;
  });

  await step('L3. The live page config lists every new ID once, with no token', async () => {
    const cfg = await (await fetch(`${SKYFLY}/api/public/pages/${page}/tracking`)).json();
    const got = cfg.pixels.map((p) => `${p.provider}:${p.id}`);
    for (const pl of ['meta', 'tiktok', 'x']) for (const id of IDS[pl]) assert(got.filter((g) => g === `${pl}:${id}`).length === 1, `${pl} ${id}: ${got.filter((g) => g.endsWith(id)).length}×`);
    assert(!/token|secret/i.test(JSON.stringify(cfg)), 'token-like value in the page config');
    assert(!got.some((g) => LAROSE_IDS.some((l) => g.endsWith(l))), 'a Larose pixel is on the test page');
    return `${got.length} IDs on the page`;
  });

  await step('L4. In a browser, the live page starts each ID once (Meta, TikTok, X scripts stubbed)', async () => {
    const ctx = await browser.newContext({ ...devices['iPhone 13'] });
    const fb = []; const tw = [];
    await ctx.exposeBinding('recordFb', (_s, a) => fb.push(a));
    await ctx.exposeBinding('recordTw', (_s, a) => tw.push(a));
    await ctx.route('https://connect.facebook.net/**', (r) => r.fulfill({ contentType: 'text/javascript', body: 'fbq.callMethod=function(){window.recordFb(Array.prototype.slice.call(arguments));};fbq.queue.splice(0).forEach(function(a){fbq.callMethod.apply(null,a);});' }));
    await ctx.route('https://analytics.tiktok.com/**', (r) => r.fulfill({ contentType: 'text/javascript', body: '' }));
    await ctx.route('https://static.ads-twitter.com/**', (r) => r.fulfill({ contentType: 'text/javascript', body: 'twq.queue.splice(0).forEach(function(a){window.recordTw(Array.prototype.slice.call(a));});twq.exe=function(){window.recordTw(Array.prototype.slice.call(arguments));};' }));
    const p = await ctx.newPage();
    await p.goto(`${liveUrl}?skyfly_debug=1`);
    await p.waitForFunction(() => window.twq && window.twq.exe, null, { timeout: 20000 });
    await p.waitForTimeout(1000);
    const inits = fb.filter((c) => c[0] === 'init').map((c) => c[1]);
    for (const id of IDS.meta) assert(inits.filter((x) => x === id).length === 1, `Meta ${id} started ${inits.filter((x) => x === id).length}×`);
    const tt = await p.evaluate(() => Object.keys(window.ttq._i || {}));
    for (const id of IDS.tiktok) assert(tt.includes(id), `TikTok ${id} not started`);
    const configs = tw.filter((c) => c[0] === 'config').map((c) => c[1]);
    for (const id of IDS.x) assert(configs.filter((x) => x === id).length === 1, `X ${id} started ${configs.filter((x) => x === id).length}×`);
    assert(!fb.some((c) => c[2] === 'Purchase') && !tw.some((c) => c[0] === 'event'), 'a Purchase without an order');
    const rows = await p.$$eval('[data-skyfly-debug-pixel]', (els) => els.length);
    await p.screenshot({ path: path.join(shots, 'tracking-check-panel.png') });
    await ctx.close();
    return `${inits.length} Meta, ${tt.length} TikTok, ${configs.length} X started; check panel lists ${rows}`;
  });

  await step('L5. Switching one TikTok ID off removes only it from the live page', async () => {
    await dash.goto(`${SKYFLY}/businesses/${biz}/pixels?platform=tiktok`);
    await Promise.all([dash.waitForLoadState('load'), dash.locator(`tr[data-pixel="${IDS.tiktok[2]}"] button:has-text("Disable")`).click()]);
    const cfg = await (await fetch(`${SKYFLY}/api/public/pages/${page}/tracking`)).json();
    const ids = cfg.pixels.map((p) => p.id);
    assert(!ids.includes(IDS.tiktok[2]), 'the disabled ID is still on the page');
    assert([...IDS.meta, ...IDS.tiktok.slice(0, 2), ...IDS.x].every((id) => ids.includes(id)), 'another ID disappeared');
  });

  await step('L6. Owner A (another business) gets "not found" for these IDs; Larose\'s page keeps exactly its pixels', async () => {
    const other = await signIn(OTHER);
    const pid = (await dash.getAttribute(`tr[data-pixel="${IDS.tiktok[0]}"] a:has-text("Edit")`, 'href')).match(/pixels\/(\d+)\/edit/)[1];
    for (const s of ['', `/${pid}/edit`, `/${pid}/verify`, `/${pid}/remove`]) {
      const r = await other.request.get(`${SKYFLY}/businesses/${biz}/pixels${s}`, { maxRedirects: 0 });
      assert(r.status() === 404, `${s || '/'}: HTTP ${r.status()}`);
    }
    await other.context().close();
    const now = await larose();
    assert(JSON.stringify(now) === JSON.stringify(laroseBefore), `Larose changed: ${laroseBefore} → ${now}`);
    return `Larose page: ${now.length} Meta pixels, unchanged`;
  });
} catch (err) {
  failed += 1; console.log(`FAIL  ${err.message}`);
} finally {
  await step('L7. Removes every tracking ID this run added (typing the ID to confirm)', async () => {
    if (!dash || !biz) return 'nothing added';
    for (const pl of ['meta', 'tiktok', 'x']) {
      await dash.goto(`${SKYFLY}/businesses/${biz}/pixels?platform=${pl}`);
      for (const id of IDS[pl]) {
        const row = dash.locator(`tr[data-pixel="${id}"]`);
        if (!(await row.count())) continue;
        await dash.goto(SKYFLY + await row.locator('a:has-text("Remove")').getAttribute('href'));
        await dash.fill('#confirm', id);
        await Promise.all([dash.waitForLoadState('load'), dash.click('button:has-text("Remove tracking ID")')]);
        await dash.goto(`${SKYFLY}/businesses/${biz}/pixels?platform=${pl}`);
      }
    }
    const cfg = await (await fetch(`${SKYFLY}/api/public/pages/${page}/tracking`)).json();
    const left = cfg.pixels.filter((p) => added.includes(p.id));
    assert(!left.length, `still on the page: ${left.map((p) => p.id)}`);
    return `${added.length} removed`;
  });
  await browser.close();
}
console.log(failed ? `\n${failed} check(s) failed` : '\nLive tracking check passed');
process.exit(failed ? 1 : 0);
