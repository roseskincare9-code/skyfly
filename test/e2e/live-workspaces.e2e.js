// Live end-to-end check of client workspaces on the deployed Skyfly, as the platform owner.
// Creates two clearly labelled TEST businesses (never touches Larose or real clients), test
// accounts via the real invitation links, TEST ORDER orders, then checks isolation and the
// subscription lock and renewal on test business B. Screenshots go to the workflow artifacts.
//
//   SKYFLY_URL=https://<service>.onrender.com SKYFLY_OWNER_EMAIL=… SKYFLY_OWNER_PASSWORD=… node test/e2e/live-workspaces.e2e.js
// The owner's sign-in comes from GitHub secrets; it is never printed.
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { chromium, devices } from 'playwright-core';

const SKYFLY = (process.env.SKYFLY_URL || '').replace(/\/+$/, '');
const OWNER = { email: process.env.SKYFLY_OWNER_EMAIL, password: process.env.SKYFLY_OWNER_PASSWORD };
const LOCAL = process.env.LIVE_DRY_RUN === '1' && /^http:\/\/localhost:\d+$/.test(SKYFLY); // rehearsal against a local server
if (!LOCAL && (!/^https:\/\/[a-z0-9-]+\.onrender\.com$/.test(SKYFLY) || /\/\/skyfly\.onrender\.com/.test(SKYFLY))) throw new Error('Set SKYFLY_URL to the verified Skyfly service');
if (!OWNER.email || !OWNER.password) throw new Error('Add the SKYFLY_OWNER_EMAIL and SKYFLY_OWNER_PASSWORD repository secrets first');
const RUN = process.env.GITHUB_RUN_ID || String(Date.now());
const shots = path.resolve('live-screenshots');
mkdirSync(shots, { recursive: true });

let failed = 0;
async function step(name, fn) {
  try { const info = await fn(); console.log(`PASS  ${name}${info ? ` — ${info}` : ''}`); return true; } catch (err) { failed += 1; console.log(`FAIL  ${name} — ${err.message.split('\n')[0]}`); return false; }
}
const assert = (c, m) => { if (!c) throw new Error(m); };
const browser = await chromium.launch();
const desktop = () => browser.newContext({ viewport: { width: 1280, height: 860 } });
const phone = () => browser.newContext({ ...devices['iPhone 13'] });
const csrf = async (page) => page.locator('input[name=_csrf]').first().inputValue();
async function signIn(ctx, email, password) {
  const p = ctx.pages()[0] ?? await ctx.newPage();
  await p.goto(`${SKYFLY}/login`);
  await p.fill('#email', email);
  await p.fill('#password', password);
  await Promise.all([p.waitForLoadState('load'), p.click('main button[type=submit]')]);
  assert(!p.url().endsWith('/login'), 'sign-in refused');
  return p;
}
async function shot(ctx, url, name) {
  const p = ctx.pages()[0];
  const res = await p.goto(url);
  const w = await p.evaluate(() => document.documentElement.scrollWidth);
  await p.screenshot({ path: path.join(shots, `${name}.png`), fullPage: true });
  return { status: res.status(), width: w };
}

const owner = await desktop();
const ownerPhone = await phone();
const biz = {};

await step('1. The deployed app loads and protected pages require sign-in', async () => {
  const h = await fetch(`${SKYFLY}/healthz`, { signal: AbortSignal.timeout(90000) });
  assert(h.ok, `/healthz HTTP ${h.status}`);
  for (const p of ['/', '/admin', '/businesses/1/orders', '/businesses/1/settings']) {
    const r = await fetch(`${SKYFLY}${p}`, { redirect: 'manual' });
    assert(r.status === 302 && /\/login$/.test(r.headers.get('location')), `${p}: HTTP ${r.status}`);
  }
  return 'healthz 200; /, /admin and workspace pages redirect to /login';
});

const ownerOk = await step('1. Platform owner signs in, logs out, and signs in again', async () => {
  const p = await signIn(owner, OWNER.email, OWNER.password);
  await Promise.all([p.waitForURL(/\/login$/), p.click('form.logout button')]);
  const after = await p.goto(`${SKYFLY}/admin`);
  assert(after.url().endsWith('/login'), 'still signed in after logout');
  await signIn(owner, OWNER.email, OWNER.password);
  await signIn(ownerPhone, OWNER.email, OWNER.password);
  const admin = await shot(owner, `${SKYFLY}/admin`, '01-owner-dashboard-desktop');
  const m = await shot(ownerPhone, `${SKYFLY}/admin`, '01-owner-dashboard-mobile');
  assert(admin.status === 200 && m.status === 200, 'Platform admin did not open');
  assert(m.width <= 390, `phone layout scrolls sideways (${m.width}px)`);
  const text = await owner.pages()[0].textContent('main');
  assert(/Larose Natural Skincare Nigeria/.test(text), 'Larose is not listed');
  return 'Platform admin opens on desktop and phone; Larose listed';
});
if (!ownerOk) { await browser.close(); console.log(`\n${failed} check(s) failed`); process.exit(1); }

const larose = { orders: null };
await step('2. Larose records are intact (read-only)', async () => {
  const p = owner.pages()[0];
  await p.goto(`${SKYFLY}/admin`);
  const row = await p.locator('tr', { hasText: 'Larose Natural Skincare Nigeria' }).textContent();
  larose.orders = Number(row.match(/(\d+) orders/)[1]);
  return `${larose.orders} non-test orders; status Internal`;
});

for (const key of ['A', 'B']) {
  await step(`2. Owner creates TEST business ${key} with a test subscription and gets an invitation link`, async () => {
    const p = owner.pages()[0];
    await p.goto(`${SKYFLY}/admin/businesses/new`);
    const today = new Date().toISOString().slice(0, 10);
    biz[key] = { name: `TEST Business ${key} ${RUN}`, email: `test-${key.toLowerCase()}-${RUN}@example.test`, password: `Test-${RUN}-${key}-pass!` };
    await p.fill('#name', biz[key].name);
    await p.fill('#owner_email', biz[key].email);
    await p.fill('#price', '1');
    await p.fill('#started_on', today);
    await p.fill('#expires_on', new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10));
    await p.fill('#notes', 'Automated live test business. Safe to ignore.');
    await p.click('main button[type=submit]');
    const text = await p.textContent('main');
    const link = text.match(/https?:\/\/[^\s]+\/invite\/[A-Za-z0-9_-]+/);
    assert(link, 'no invitation link shown');
    biz[key].invite = link[0];
    biz[key].id = Number((await p.getAttribute('a.btn[href^="/admin/businesses/"]', 'href')).match(/\d+$/)[0]);
    return `#${biz[key].id}`;
  });
  await step(`1. Test account ${key} registers through the invitation and its dashboard opens`, async () => {
    biz[key].ctx = await desktop();
    const p = await biz[key].ctx.newPage();
    await p.goto(biz[key].invite);
    await p.fill('#name', `Test Client ${key}`);
    await p.fill('#password', biz[key].password);
    await Promise.all([p.waitForURL(new RegExp(`/businesses/${biz[key].id}$`)), p.click('main button[type=submit]')]);
    await Promise.all([p.waitForURL(/\/login$/), p.click('form.logout button')]);
    await signIn(biz[key].ctx, biz[key].email, biz[key].password);
    assert(p.url().endsWith(`/businesses/${biz[key].id}`), `landed on ${p.url()}`);
    return 'registered, logged out, signed in again';
  });
  await step(`3. TEST business ${key}: product and landing page set up through the dashboard`, async () => {
    const p = biz[key].ctx.pages()[0];
    await p.goto(`${SKYFLY}/businesses/${biz[key].id}/products`);
    await p.fill('#name', `Test serum ${key}`);
    await p.fill('#code', `test-serum-${key.toLowerCase()}`);
    await p.fill('#price', key === 'A' ? '12000' : '8000');
    await p.click('main form button[type=submit] >> nth=-1');
    await p.goto(`${SKYFLY}/businesses/${biz[key].id}/landing-pages/new`);
    biz[key].origin = `https://test-${key.toLowerCase()}-${RUN}.example.test`;
    await p.fill('#name', `Test page ${key}`);
    await p.fill('#url', `${biz[key].origin}/`);
    biz[key].slug = `test-${key.toLowerCase()}-${RUN}`;
    await p.fill('#slug', biz[key].slug);
    await p.selectOption('#status', 'active');
    await p.check('input[name=products]');
    await Promise.all([p.waitForURL(/landing-pages$/), p.click('main form.card button[type=submit]')]);
    return `form key ${biz[key].slug}`;
  });
}

const order = (key, name, extra = {}) => fetch(`${SKYFLY}/api/public/orders`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Origin: biz[key].origin },
  body: JSON.stringify({ landingPage: biz[key].slug, idempotencyKey: `live-ws-${RUN}-${key}-${name.length}-${extra.n ?? 0}`, customer: { name, phone: '08012345678', address: 'TEST ORDER - automated check, do not deliver', state: 'Lagos' }, items: [{ product: extra.product ?? `test-serum-${key.toLowerCase()}`, quantity: 2 }] }),
}).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));

await step('3. Orders from each test page land in their own business, totals correct; duplicates and bad submissions create nothing', async () => {
  const a = await order('A', `TEST ORDER live A ${RUN}`);
  const b = await order('B', `TEST ORDER live B ${RUN}`);
  assert(a.status === 201 && b.status === 201, `HTTP ${a.status}/${b.status} ${JSON.stringify(a.body).slice(0, 120)}`);
  assert(a.body.total === 24000 && b.body.total === 16000, `totals ${a.body.total}/${b.body.total}`);
  assert(a.body.test === true, 'TEST ORDER is flagged as a test');
  const dup = await order('A', `TEST ORDER live A ${RUN}`);
  assert(dup.status === 200 && dup.body.reference === a.body.reference && dup.body.replayed, 'duplicate was not replayed');
  const cross = await order('A', `TEST ORDER cross ${RUN}`, { product: 'test-serum-b', n: 1 });
  assert(cross.status === 400, `cross-business product accepted (HTTP ${cross.status})`);
  const bad = await fetch(`${SKYFLY}/api/public/orders`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: biz.A.origin }, body: JSON.stringify({ landingPage: biz.A.slug, idempotencyKey: `live-ws-bad-${RUN}-000`, customer: { name: 'X', phone: '1', address: 'x' }, items: [{ product: 'test-serum-a', quantity: 1 }] }) });
  assert(bad.status === 400, `invalid order HTTP ${bad.status}`);
  biz.A.ref = a.body.reference; biz.B.ref = b.body.reference;
  const p = biz.A.ctx.pages()[0];
  await p.goto(`${SKYFLY}/businesses/${biz.A.id}/orders`);
  await p.reload();
  const list = await p.textContent('main');
  assert(list.includes(a.body.reference) && !list.includes(b.body.reference), 'A sees the wrong orders');
  const rows = (list.match(new RegExp(`TEST ORDER live A ${RUN}`, 'g')) || []).length;
  assert(rows === 1, `A's order listed ${rows} times`);
  return `A ${a.body.reference} ₦24,000, B ${b.body.reference} ₦16,000; duplicate → same reference; bad/cross orders refused; visible after refresh`;
});

await step('2. Neither test business can open the other\'s orders, customers, products, settings or integrations', async () => {
  const p = biz.A.ctx.pages()[0];
  const blocked = [];
  for (const s of ['', '/orders', '/customers', '/products', '/settings', '/integrations', '/pixels', '/google-sheets', '/email', '/email-contacts', '/api-keys', '/team', '/orders/export.csv']) {
    const r = await p.request.get(`${SKYFLY}/businesses/${biz.B.id}${s}`, { maxRedirects: 0 });
    if (r.status() !== 404) blocked.push(`${s || '/'}: HTTP ${r.status()}`);
    const r2 = await biz.B.ctx.pages()[0].request.get(`${SKYFLY}/businesses/${biz.A.id}${s}`, { maxRedirects: 0 });
    if (r2.status() !== 404) blocked.push(`B→A ${s || '/'}: HTTP ${r2.status()}`);
  }
  assert(!blocked.length, blocked.join(', '));
  const larosePage = await p.request.get(`${SKYFLY}/admin`, { maxRedirects: 0 });
  assert(larosePage.status() === 404, 'test client can open Platform admin');
  return '13 sections each way → 404; Platform admin → 404 for clients';
});

await step('1. Client dashboard on desktop and phone', async () => {
  const d = await shot(biz.A.ctx, `${SKYFLY}/businesses/${biz.A.id}`, '02-client-dashboard-desktop');
  const ph = await phone();
  await signIn(ph, biz.A.email, biz.A.password);
  const m = await shot(ph, `${SKYFLY}/businesses/${biz.A.id}`, '02-client-dashboard-mobile');
  await shot(biz.A.ctx, `${SKYFLY}/businesses/${biz.A.id}/email`, '03-email-automations-desktop');
  await ph.close();
  assert(d.status === 200 && m.status === 200, 'dashboard did not open');
  assert(m.width <= 390, `phone layout scrolls sideways (${m.width}px)`);
  return 'opens; no sideways scrolling on a phone';
});

await step('7. Expired subscription locks TEST business B (dashboard and API key); data kept; renewal restores access', async () => {
  // An API key for B, created while active.
  const bp = biz.B.ctx.pages()[0];
  await bp.goto(`${SKYFLY}/businesses/${biz.B.id}/api-keys`);
  await bp.fill('#name', 'Live test key');
  await bp.click('main form button[type=submit] >> nth=-1');
  const key = (await bp.textContent('#new-key')).trim();
  const apiOrder = () => fetch(`${SKYFLY}/api/public/orders`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ landingPage: biz.B.slug, idempotencyKey: `live-ws-api-${RUN}-0001`, customer: { name: `TEST ORDER api ${RUN}`, phone: '08012345678', address: 'TEST ORDER - automated check' }, items: [{ product: 'test-serum-b', quantity: 1 }] }) });
  // Owner marks B expired.
  const o = owner.pages()[0];
  await o.goto(`${SKYFLY}/admin/businesses/${biz.B.id}`);
  await o.selectOption('#subscription_status', 'expired');
  await Promise.all([o.waitForURL(/done=saved/), o.click('form[action$="/subscription"] button[type=submit]')]);
  const locked = await bp.goto(`${SKYFLY}/businesses/${biz.B.id}/orders`);
  assert(locked.status() === 402, `client still has access (HTTP ${locked.status()})`);
  assert(/Subscription expired/.test(await bp.textContent('main')), 'no renewal screen');
  await shot(biz.B.ctx, `${SKYFLY}/businesses/${biz.B.id}`, '04-client-locked-desktop');
  const api = await apiOrder();
  assert(api.status === 402, `API key still works (HTTP ${api.status})`);
  const ownerView = await o.goto(`${SKYFLY}/businesses/${biz.B.id}/orders`);
  assert(ownerView.status() === 200 && (await o.textContent('main')).includes(biz.B.ref), 'B\'s order not visible to the owner while expired');
  // Renewal.
  await o.goto(`${SKYFLY}/admin/businesses/${biz.B.id}`);
  await o.fill('#reference', 'LIVE TEST renewal');
  await Promise.all([o.waitForURL(/done=renewed/), o.click('button:text-is("Renew")')]);
  await shot(owner, `${SKYFLY}/admin/businesses/${biz.B.id}`, '05-subscription-controls-desktop');
  const back = await bp.goto(`${SKYFLY}/businesses/${biz.B.id}/orders`);
  assert(back.status() === 200 && (await bp.textContent('main')).includes(biz.B.ref), 'access or order not back after renewal');
  const api2 = await apiOrder();
  assert(api2.status === 201, `API key not restored (HTTP ${api2.status})`);
  return 'locked: dashboard 402, API 402, owner still sees the order; renewed: dashboard 200, order present, API 201';
});

await step('2. Larose records unchanged after the test', async () => {
  const p = owner.pages()[0];
  await p.goto(`${SKYFLY}/admin`);
  const row = await p.locator('tr', { hasText: 'Larose Natural Skincare Nigeria' }).textContent();
  const now = Number(row.match(/(\d+) orders/)[1]);
  assert(now === larose.orders, `Larose order count changed ${larose.orders} → ${now}`);
  return `${now} non-test orders, unchanged`;
});

await browser.close();
console.log(failed ? `\n${failed} check(s) failed` : '\nAll live workspace checks passed');
process.exit(failed ? 1 : 0);
