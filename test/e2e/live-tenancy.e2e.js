// Live check of business owners' sign-in and isolation on the deployed Skyfly, with the restricted
// live-test accounts (see ensureE2eAccount): owner A owns only the demo shop, owner B only the import
// test business, and the manager account belongs to both (switching). One sign-in per workflow run,
// for all three (SKYFLY_OWNER_PASSWORD, set by scripts/e2e-login.mjs). Places no order; invites one
// reserved test address (e2e-…@skyfly.invalid), which the server disables with the others.
//
//   SKYFLY_URL=https://<service>.onrender.com SKYFLY_OWNER_PASSWORD=… node test/e2e/live-tenancy.e2e.js
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { chromium, devices } from 'playwright-core';

const SKYFLY = (process.env.SKYFLY_URL || '').replace(/\/+$/, '');
if (!/^https:\/\/[a-z0-9-]+\.onrender\.com$|^https:\/\/getskyfly\.com$|^http:\/\/localhost:\d+$/.test(SKYFLY) || /\/\/skyfly\.onrender\.com/.test(SKYFLY)) throw new Error('Set SKYFLY_URL to the verified Skyfly service address');
const PASSWORD = process.env.SKYFLY_OWNER_PASSWORD;
const RUN = process.env.GITHUB_RUN_ID || String(Date.now());
const ACCOUNTS = { A: 'e2e-owner-a@skyfly.invalid', B: 'e2e-owner-b@skyfly.invalid', manager: 'e2e-tests@skyfly.invalid' };
const NAMES = { A: 'Skyfly Demo Shop (test)', B: 'Skyfly Import Test (test)' };
const REF = { A: /\bDM-[A-Z0-9]{7}\b/, B: /\bIT-[A-Z0-9]{7}\b/ };
const SECTIONS = ['', '/orders', '/customers', '/products', '/landing-pages', '/settings', '/integrations', '/pixels', '/google-sheets', '/email', '/email-contacts', '/api-keys', '/team', '/orders/export.csv'];
// Secret-looking values that must never appear in a dashboard page.
const SECRET = /BEGIN PRIVATE KEY|\bEAA[A-Za-z0-9]{30,}|\bre_[A-Za-z0-9_]{20,}|xkeysib-[a-f0-9]{20,}|"private_key"/;
const shots = path.resolve('live-screenshots');
mkdirSync(shots, { recursive: true });

let failed = 0; let blocked = 0;
class Blocked extends Error {}
async function step(name, fn) {
  try { const info = await fn(); console.log(`PASS  ${name}${info ? ` — ${info}` : ''}`); return true; }
  catch (err) {
    if (err instanceof Blocked) { blocked += 1; console.log(`BLOCKED  ${name} — ${err.message}`); return false; }
    failed += 1; console.log(`FAIL  ${name} — ${err.message.split('\n')[0]}`); return false;
  }
}
const assert = (c, m) => { if (!c) throw new Error(m); };
if (!PASSWORD) throw new Error('No live-test sign-in: run this through the "Live import test" workflow');

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const desktop = () => browser.newContext({ viewport: { width: 1280, height: 900 } });
async function signIn(ctx, email, password = PASSWORD) {
  const p = ctx.pages()[0] ?? await ctx.newPage();
  await p.goto(`${SKYFLY}/login`);
  await p.fill('#email', email); await p.fill('#password', password);
  await Promise.all([p.waitForLoadState('load'), p.click('main button[type=submit]')]);
  assert(!p.url().endsWith('/login'), `sign-in refused for ${email}`);
  return p;
}
const idOf = (url) => url.match(/\/businesses\/(\d+)/)?.[1];
const ids = {};
const ctxs = {};

for (const key of ['A', 'B']) {
  await step(`T1-${key}. Owner ${key} signs in, lands in their only business, logs out (dashboard protected again), signs in again`, async () => {
    ctxs[key] = await desktop();
    const p = await signIn(ctxs[key], ACCOUNTS[key]);
    ids[key] = idOf(p.url());
    assert(ids[key], `landed on ${p.url()}`);
    assert((await p.textContent('main')).includes(NAMES[key].replace(' (test)', '')), 'own business name not shown');
    await Promise.all([p.waitForURL(/\/login$/), p.click('form.logout button')]);
    const after = await p.request.get(`${SKYFLY}/businesses/${ids[key]}`, { maxRedirects: 0 });
    assert(after.status() === 302 && /\/login/.test(after.headers().location || ''), `after logout: HTTP ${after.status()}`);
    await signIn(ctxs[key], ACCOUNTS[key]);
    return `${NAMES[key]} is business #${ids[key]}`;
  });
}

for (const [me, other] of [['A', 'B'], ['B', 'A']]) {
  await step(`T2-${me}. Owner ${me} opens every section of its own business and none of business ${other}'s, Larose's or any other; no Platform admin`, async () => {
    const p = ctxs[me].pages()[0];
    const own = []; const leaks = [];
    for (const s of SECTIONS) {
      const r = await p.request.get(`${SKYFLY}/businesses/${ids[me]}${s}`, { maxRedirects: 0 });
      if (r.status() !== 200) own.push(`${s || '/'}: HTTP ${r.status()}`);
    }
    assert(!own.length, `own sections not opening: ${own.join(', ')}`);
    const refused = [];
    for (let id = 1; id <= 10; id += 1) {
      if (String(id) === ids[me]) continue;
      for (const s of SECTIONS) {
        const r = await p.request.get(`${SKYFLY}/businesses/${id}${s}`, { maxRedirects: 0 });
        if (r.status() !== 404) leaks.push(`#${id}${s}: HTTP ${r.status()}`);
      }
      refused.push(id);
    }
    assert(!leaks.length, leaks.join(', '));
    const admin = await p.request.get(`${SKYFLY}/admin`, { maxRedirects: 0 });
    assert(admin.status() === 404, `Platform admin: HTTP ${admin.status()}`);
    return `${SECTIONS.length} sections open (HTTP 200); businesses ${refused.join(', ')} × ${SECTIONS.length} sections → 404; /admin → 404`;
  });

  await step(`T3-${me}. Owner ${me}'s pages show no data of business ${other} and no secret values (orders, customers, products, pages, pixels, Google Sheets, email, settings, API keys)`, async () => {
    const p = ctxs[me].pages()[0];
    const found = [];
    for (const s of SECTIONS.filter((x) => !x.endsWith('.csv'))) {
      const html = await (await p.request.get(`${SKYFLY}/businesses/${ids[me]}${s}`)).text();
      if (html.includes(NAMES[other].replace(' (test)', ''))) found.push(`${s || '/'}: ${other}'s name`);
      if (REF[other].test(html)) found.push(`${s || '/'}: ${other}'s order reference ${html.match(REF[other])[0]}`);
      // Email addresses are left out here: /team lists the platform owner, whose address may name Larose.
      if (/Larose/i.test(html.replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, ''))) found.push(`${s || '/'}: Larose`);
      if (SECRET.test(html)) found.push(`${s || '/'}: a secret-looking value`);
    }
    const csv = await (await p.request.get(`${SKYFLY}/businesses/${ids[me]}/orders/export.csv`)).text();
    if (REF[other].test(csv)) found.push(`orders CSV: ${other}'s order`);
    assert(!found.length, found.join('; '));
    const mine = await (await p.request.get(`${SKYFLY}/businesses/${ids[me]}/orders`)).text();
    return `${SECTIONS.length - 1} pages + orders CSV checked; own orders listed: ${(mine.match(new RegExp(REF[me].source, 'g')) || []).length}`;
  });
}

await step('T4. Switching: an account in both test businesses moves between them; each shows only its own orders, products and pixel settings', async () => {
  const ctx = await desktop();
  const p = await signIn(ctx, ACCOUNTS.manager);
  await p.goto(`${SKYFLY}/?all=1`);
  const listed = await p.locator('main a[href^="/businesses/"]').evaluateAll((as) => [...new Set(as.map((a) => a.getAttribute('href').match(/^\/businesses\/(\d+)$/)?.[1]).filter(Boolean))]);
  assert(listed.length === 2 && listed.includes(ids.A) && listed.includes(ids.B), `businesses listed: ${listed.join(', ')}`);
  const seen = [];
  for (const [me, other] of [['A', 'B'], ['B', 'A'], ['A', 'B']]) {
    await p.goto(`${SKYFLY}/?all=1`);
    await Promise.all([p.waitForURL(new RegExp(`/businesses/${ids[me]}$`)), p.click(`main a[href="/businesses/${ids[me]}"] >> nth=0`)]);
    // The business switcher lists both businesses (this account belongs to both); the page content must not.
    for (const s of ['/orders', '/products', '/pixels']) {
      await p.goto(`${SKYFLY}/businesses/${ids[me]}${s}`);
      const main = await p.textContent('main');
      assert(!REF[other].test(main) && !main.includes(NAMES[other].replace(' (test)', '')), `${NAMES[me]} ${s} shows ${other}'s data`);
    }
    seen.push(NAMES[me]);
  }
  await ctx.close();
  return `switched ${seen.join(' → ')}; no cross-business data`;
});

const invitee = { email: `e2e-invitee-${RUN}@skyfly.invalid`, password: `Invitee-${RUN}-pass!` };
await step('T5. Registration by invitation: owner A invites a new (test) address as Staff; it registers, lands in business A only, has no settings access, logs out and signs in again', async () => {
  const p = ctxs.A.pages()[0];
  await p.goto(`${SKYFLY}/businesses/${ids.A}/team`);
  await p.fill('#email', invitee.email);
  await p.selectOption('#role', 'staff');
  await Promise.all([p.waitForLoadState('load'), p.click('main form[action$="/team/invite"] button[type=submit]')]);
  const link = (await p.textContent('main')).match(/https?:\/\/[^\s]+\/invite\/[A-Za-z0-9_-]+/);
  assert(link, 'no invitation link shown');
  const ctx = await desktop();
  const j = await ctx.newPage();
  await j.goto(link[0]);
  await j.fill('#name', 'Live test invitee');
  await j.fill('#password', invitee.password);
  await Promise.all([j.waitForURL(new RegExp(`/businesses/${ids.A}$`)), j.click('main button[type=submit]')]);
  const settings = await j.request.get(`${SKYFLY}/businesses/${ids.A}/settings`, { maxRedirects: 0 });
  assert(settings.status() === 403, `Staff → settings: HTTP ${settings.status()}`);
  const orders = await j.request.get(`${SKYFLY}/businesses/${ids.A}/orders`, { maxRedirects: 0 });
  assert(orders.status() === 200, `Staff → orders: HTTP ${orders.status()}`);
  const otherBiz = await j.request.get(`${SKYFLY}/businesses/${ids.B}`, { maxRedirects: 0 });
  assert(otherBiz.status() === 404, `Staff of A → business B: HTTP ${otherBiz.status()}`);
  await Promise.all([j.waitForURL(/\/login$/), j.click('form.logout button')]);
  await signIn(ctx, invitee.email, invitee.password);
  assert(j.url().endsWith(`/businesses/${ids.A}`), `landed on ${j.url()}`);
  invitee.ctx = ctx;
  return `${invitee.email} registered with the one-time link; orders 200, settings 403, business B 404; signed out and in again`;
});

await step('T6. Password recovery: "Forgot your password?" gives the same answer for a real and an unknown address and reveals nothing', async () => {
  const ctx = await desktop();
  const p = await ctx.newPage();
  const ask = async (email) => {
    await p.goto(`${SKYFLY}/forgot-password`);
    await p.fill('#email', email);
    await Promise.all([p.waitForLoadState('load'), p.click('main button[type=submit]')]);
    return (await p.textContent('main')).replace(/\s+/g, ' ').trim();
  };
  const known = await ask(invitee.email);
  const unknown = await ask(`nobody-${RUN}@example.test`);
  await ctx.close();
  assert(known === unknown.replace(`nobody-${RUN}@example.test`, invitee.email), `answers differ: "${known.slice(0, 80)}" / "${unknown.slice(0, 80)}"`);
  return `same answer for both ("${known.slice(0, 90)}…")`;
});

await step('T6b. Password recovery: the emailed reset link works end to end', async () => {
  throw new Blocked('Skyfly has no email sender set up (SKYFLY_NOTIFY_* in Render), so no reset email can be sent; the link itself is covered by the automated tests');
});

await step('T7. Owner A removes the invited account; it can no longer open business A', async () => {
  const p = ctxs.A.pages()[0];
  await p.goto(`${SKYFLY}/businesses/${ids.A}/team`);
  const row = p.locator('tr', { hasText: invitee.email });
  await Promise.all([p.waitForLoadState('load'), row.locator('form[action$="/remove"] button').click()]);
  assert(!(await p.textContent('main')).includes(invitee.email), 'still listed');
  const r = await invitee.ctx.pages()[0].request.get(`${SKYFLY}/businesses/${ids.A}`, { maxRedirects: 0 });
  assert(r.status() === 404, `after removal: HTTP ${r.status()}`);
  await invitee.ctx.close();
  return 'removed; business A → 404 for that account';
});

await step('T8. Owner dashboard and orders on a phone: open, no sideways scrolling', async () => {
  const ctx = await browser.newContext({ ...devices['iPhone 13'] });
  const p = await signIn(ctx, ACCOUNTS.A);
  const widths = [];
  for (const s of ['', '/orders', '/settings', '/team']) {
    await p.goto(`${SKYFLY}/businesses/${ids.A}${s}`, { waitUntil: 'load' });
    widths.push(await p.evaluate(() => document.documentElement.scrollWidth));
    await p.screenshot({ path: path.join(shots, `tenancy-owner-a${s.replace('/', '-') || '-dashboard'}-phone.png`) });
  }
  await ctx.close();
  assert(widths.every((w) => w <= 390), `page widths ${widths.join(', ')} px`);
  return `dashboard, orders, settings, team: ${widths.join(', ')} px wide (screen 390)`;
});

await step('T9. Creating a business and subscription expiry/renewal (platform owner only)', async () => {
  throw new Blocked('needs the platform owner\'s sign-in (SKYFLY_OWNER_EMAIL / SKYFLY_OWNER_PASSWORD repository secrets) for "Live workspace test"; covered locally by test/e2e/live-workspaces.e2e.js and the automated tests');
});

await browser.close();
if (blocked) console.log(`\n${blocked} check(s) BLOCKED (see above)`);
console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks that could run passed');
process.exit(failed ? 1 : 0);
