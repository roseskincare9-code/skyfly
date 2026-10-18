// TEMPORARY live check of Skyfly's own Meta pixel (1325736489534601) on the demo page.
// 1. Render: latest deploy, health, which pixel settings exist (names only, never values);
//    optionally stores the Meta test event code and redeploys.
// 2. A real browser opens the demo page with Meta reachable: pixel ID and PageView requests.
// 3. One labelled TEST ORDER; a simulated failed save; a repeated submission.
// Removed after the check.
import { chromium, devices } from 'playwright-core';

const RENDER = 'https://api.render.com/v1';
const PIXEL = '1325736489534601';
const TEST_CODE = process.env.TEST_EVENT_CODE || '';
let failed = 0; let blocked = 0;
const line = (s, name, d = '') => console.log(`${s.padEnd(7)} ${name}${d ? ` — ${d}` : ''}`);
const pass = (n, d) => line('PASS', n, d);
const fail = (n, d) => { failed += 1; line('FAIL', n, d); };
const block = (n, d) => { blocked += 1; line('BLOCKED', n, d); };
const info = (n, d) => line('INFO', n, d);

async function render(path, opts = {}) {
  const res = await fetch(`${RENDER}${path}`, {
    ...opts,
    headers: { Authorization: `Bearer ${process.env.RENDER_API_KEY}`, Accept: 'application/json', 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(60000),
  });
  const text = await res.text();
  if (res.status >= 300) throw new Error(`Render API ${opts.method || 'GET'} ${path.split('?')[0]} -> HTTP ${res.status}`);
  return text ? JSON.parse(text) : null;
}

// ---------- 1. Render ----------
const owners = (await render('/owners?limit=20')).map((o) => o.owner ?? o);
let svc = null;
for (const o of owners) {
  const services = (await render(`/services?ownerId=${encodeURIComponent(o.id)}&limit=100`)).map((x) => x.service ?? x);
  svc ||= services.find((x) => x.name === 'skyfly');
}
if (!svc) throw new Error('skyfly service not found');
const SKYFLY = svc.serviceDetails.url.replace(/\/+$/, '');
const PAGE = `${SKYFLY}/p/skyfly-demo/`;
const latest = async () => (await render(`/services/${svc.id}/deploys?limit=1`)).map((d) => d.deploy ?? d)[0];

let d = await latest();
info('Render: latest deploy', `${d.status}, commit ${d.commit?.id?.slice(0, 7)}, "${(d.commit?.message || '').split('\n')[0]}", finished ${d.finishedAt}`);

const keys = async () => new Set((await render(`/services/${svc.id}/env-vars?limit=100`)).map((e) => (e.envVar ?? e).key));
let env = await keys();
const has = (k) => (env.has(k) ? 'set' : 'not set');
info('Render environment (names only, values never read)', ['SKYFLY_ENCRYPTION_KEY', 'SKYFLY_META_PIXEL_ID', 'SKYFLY_PIXEL_BUSINESSES', 'SKYFLY_META_ACCESS_TOKEN', 'SKYFLY_META_TEST_EVENT_CODE'].map((k) => `${k}: ${has(k)}`).join('; '));

if (TEST_CODE) {
  if (!/^TEST\d{3,10}$/.test(TEST_CODE)) throw new Error('unexpected test event code format');
  await render(`/services/${svc.id}/env-vars/SKYFLY_META_TEST_EVENT_CODE`, { method: 'PUT', body: JSON.stringify({ value: TEST_CODE }) });
  env = await keys();
  pass('Stored SKYFLY_META_TEST_EVENT_CODE in Render (server-side only)', has('SKYFLY_META_TEST_EVENT_CODE'));
  const dep = await render(`/services/${svc.id}/deploys`, { method: 'POST', body: JSON.stringify({ clearCache: 'do_not_clear' }) });
  const depId = (dep.deploy ?? dep).id;
  for (let i = 0; i < 60; i += 1) {
    await new Promise((r) => setTimeout(r, 10000));
    d = (await render(`/services/${svc.id}/deploys/${depId}`));
    d = d.deploy ?? d;
    if (['live', 'build_failed', 'update_failed', 'canceled', 'deactivated'].includes(d.status)) break;
  }
  (d.status === 'live' ? pass : fail)('Redeploy with the test event code', `${d.status}, commit ${d.commit?.id?.slice(0, 7)}`);
}

const health = await (await fetch(`${SKYFLY}/healthz`, { signal: AbortSignal.timeout(90000) })).json().catch(() => ({}));
(health.status === 'ok' ? pass : fail)('Live app healthy (GET /healthz, database connected)', `status ${health.status}`);
try {
  const logs = await render(`/logs?ownerId=${encodeURIComponent(svc.ownerId)}&resource=${svc.id}&limit=100&direction=backward&type=app`);
  const errs = (logs.logs || []).map((l) => l.message || '').filter((m) => /error/i.test(m)).map((m) => m.split('\n')[0].replace(/[^\s@]+@[^\s@]+/g, '<email>').slice(0, 160));
  info('Render app logs: recent lines containing "error"', errs.length ? errs.slice(0, 5).join(' | ') : 'none');
} catch (err) { info('Render app logs', err.message); }

// ---------- 2. PageView in a real browser (Meta reachable) ----------
const browser = await chromium.launch();
const ctx = await browser.newContext({ ...devices['Pixel 5'] });
const tr = []; // requests to Meta's event endpoint
ctx.on('request', (r) => {
  const u = r.url();
  if (/^https:\/\/www\.facebook\.com\/tr\/?\?/.test(u) || (/^https:\/\/www\.facebook\.com\/tr\/?$/.test(u) && r.method() === 'POST')) {
    const q = new URL(u).searchParams;
    const body = r.postData() || '';
    const p = q.get('id') ? q : new URLSearchParams(body);
    tr.push({ id: p.get('id'), ev: p.get('ev'), eid: p.get('eid'), value: p.get('cd[value]'), currency: p.get('cd[currency]'), req: r });
  }
});
const shop = await ctx.newPage();
const statuses = [];
shop.on('response', (r) => { if (/facebook\.com\/tr/.test(r.url())) statuses.push(r.status()); });
let reply = null;
shop.on('response', async (r) => { if (r.url().endsWith('/api/public/orders') && r.request().method() === 'POST' && r.status() !== 500) reply = await r.json().catch(() => null); });
const pageViews = () => tr.filter((t) => t.ev === 'PageView');

await shop.goto(PAGE, { waitUntil: 'load' });
await shop.waitForSelector('.sky-opt', { timeout: 60000 });
await shop.waitForTimeout(6000);
const cfg = await shop.evaluate(() => window.__SKYFLY__ && window.__SKYFLY__.pixels);
const ids = (cfg || []).map((p) => p.id);
(ids.length === 1 && ids[0] === PIXEL ? pass : fail)('The demo page is configured with pixel 1325736489534601 only', JSON.stringify(ids));
const pageJs = await shop.evaluate(() => document.documentElement.outerHTML);
(!/EAA[A-Za-z0-9]{20,}/.test(pageJs) && !pageJs.includes('access_token') ? pass : fail)('No access token in the page');
const loaded = await shop.evaluate(() => Boolean(window.fbq && window.fbq.loaded));
(loaded ? pass : fail)("Meta's pixel script (fbevents.js) loaded and initialised", `fbq.loaded=${loaded}`);
const pv1 = pageViews();
(pv1.length === 1 && pv1[0].id === PIXEL ? pass : fail)('First visit: exactly one PageView request to Meta for pixel 1325736489534601', `${pv1.length} PageView request(s), ids ${pv1.map((t) => t.id).join(',')}, Meta HTTP ${statuses.join(',') || 'none'}`);
await shop.reload({ waitUntil: 'load' });
await shop.waitForSelector('.sky-opt', { timeout: 60000 });
await shop.waitForTimeout(6000);
(pageViews().length === 2 ? pass : fail)('After a refresh: one more PageView (one per visit, no duplicates)', `${pageViews().length} PageView request(s) in total for 2 visits`);
info('All events sent to Meta so far', tr.map((t) => `${t.ev}(${t.id})`).join(', '));

// ---------- 3. Orders (only when server-side Purchase can actually be sent) ----------
if (!env.has('SKYFLY_META_ACCESS_TOKEN')) {
  block('Server-side Purchase to Meta Test events (code applied)', 'SKYFLY_META_ACCESS_TOKEN is still not set in Render, so no new test order was placed (the earlier one, DM-BMD3K9C, already covers the order flow)');
  info('Meta Events Manager', 'Claude has no access to Events Manager; whether Meta shows these events must be checked there');
  await browser.close();
  console.log(`\n${failed} failed, ${blocked} blocked`);
  process.exit(failed ? 1 : 0);
}
const NAME = `TEST ORDER Skyfly pixel check ${process.env.GITHUB_RUN_ID || Date.now()}`;
const fill = async () => {
  await shop.waitForSelector('.sky-opt');
  await shop.locator('.sky-opt').nth(0).click();
  await shop.selectOption('#sky-qty', '1');
  await shop.fill('#sky-name', NAME); await shop.fill('#sky-phone', '08012345678');
  await shop.fill('#sky-address', 'TEST ORDER - do not deliver, automated pixel check'); await shop.fill('#sky-state', 'Lagos');
  await shop.click('text=Review my order');
};
const purchases = () => tr.filter((t) => t.ev === 'Purchase');

await fill();
await shop.route('**/api/public/orders', (r) => r.fulfill({ status: 500, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': 'null' }, body: '{"ok":false,"message":"We could not save your order. Please try again in a moment."}' }));
await shop.click('text=Place my order');
await shop.waitForSelector('[data-err]:not([hidden])', { timeout: 30000 });
await shop.waitForTimeout(2000);
(purchases().length === 0 ? pass : fail)('A failed save (simulated server error, no order created) sends no Purchase', `${purchases().length} Purchase request(s)`);
await shop.unroute('**/api/public/orders');

await shop.click('text=Place my order');
await shop.waitForSelector('.sky-ok', { timeout: 60000 });
const reference = (await shop.textContent('[data-skyfly-reference]')).trim();
(reply?.saved === true && reply.reference === reference && reply.test === true ? pass : fail)('One labelled TEST ORDER saved in the Skyfly database before any Purchase', `${reference}, ₦${reply?.total} ${reply?.currency}, test order: ${reply?.test}, Purchase event ID purchase_${reference}`);
const conf = await (await fetch(reply.confirmationUrl)).text();
(conf.includes(reference) ? pass : fail)('The order is stored (confirmation page read from the database shows it)', reply.confirmationUrl.replace(/\?t=.*/, '?t=…'));
await shop.waitForTimeout(3000);
(purchases().length === 0 ? pass : fail)('Browser: no Purchase for a test order (test orders never count as real sales)', `${purchases().length} Purchase request(s)`);

await shop.reload({ waitUntil: 'load' });
await fill();
await shop.click('text=Place my order');
await shop.waitForSelector('.sky-ok', { timeout: 60000 });
const again = (await shop.textContent('[data-skyfly-reference]')).trim();
(again === reference && reply.replayed === true ? pass : fail)('Refresh + same submission again: same order, no duplicate', `${again}, replayed ${reply.replayed}`);

if (!env.has('SKYFLY_META_ACCESS_TOKEN')) {
  block('Server-side Purchase to Meta Test events (code applied) for this order', 'SKYFLY_META_ACCESS_TOKEN is not set in Render, so Skyfly cannot call the Conversions API; nothing was sent');
} else {
  info('Server-side Purchase', `token is set: Skyfly sent Purchase for ${reference} with the test event code; only Meta Events Manager → Test events can confirm it arrived`);
}
info('Meta Events Manager', 'Claude has no access to Events Manager; whether Meta shows these events must be checked there');
await browser.close();
console.log(`\n${failed} failed, ${blocked} blocked`);
process.exit(failed ? 1 : 0);
