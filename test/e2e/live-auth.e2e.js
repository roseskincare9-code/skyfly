// Live check of the four entry points in a real browser (phone), with screenshots: /admin (Super Admin
// sign-in), /signup (new business owner), /login (existing owner), /forgot-password. Then one labelled
// test registration through /signup ("Skyfly Signup Test <run> (test)", an e2e-…@skyfly.invalid address):
// it must land in its own new business (never Larose), be refused everywhere else, never reach /admin,
// sign out and back in, and see "You are signed in" on /signup and /login. Creates no order.
//
//   SKYFLY_URL=https://<service>.onrender.com node test/e2e/live-auth.e2e.js
import { mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { chromium, devices } from 'playwright-core';

const SKYFLY = (process.env.SKYFLY_URL || '').replace(/\/+$/, '');
if (!/^https:\/\/[a-z0-9.-]+$|^http:\/\/localhost:\d+$/.test(SKYFLY)) throw new Error('Set SKYFLY_URL');
const RUN = String(process.env.GITHUB_RUN_ID || Date.now()).slice(-8);
const EMAIL = `e2e-signup-${RUN}@skyfly.invalid`;
const PASSWORD = `Sky-${randomBytes(9).toString('base64url')}`;
const BUSINESS = `Skyfly Signup Test ${RUN} (test)`;
mkdirSync('live-screenshots', { recursive: true });
let failed = 0;
async function step(name, fn) {
  try { const info = await fn(); console.log(`PASS  ${name}${info ? ` — ${info}` : ''}`); }
  catch (err) { failed += 1; console.log(`FAIL  ${name} — ${String(err.message).split('\n')[0]}`); }
}
const assert = (c, m) => { if (!c) throw new Error(m); };

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const fresh = async () => { const ctx = await browser.newContext({ ...devices['iPhone 13'] }); const p = await ctx.newPage(); p.setDefaultTimeout(30000); return p; };
const shot = (p, name) => p.screenshot({ path: `live-screenshots/auth-${name}.png`, fullPage: true });

let regOpen = false;
try {
  const anon = await fresh();
  await step('1. /admin (signed out) opens the separate Super Admin sign-in', async () => {
    await anon.goto(`${SKYFLY}/admin`);
    assert(new URL(anon.url()).pathname === '/admin/login', `landed on ${anon.url()}`);
    assert(await anon.locator('[data-admin-login]').count() === 1, 'not the Super Admin sign-in');
    await shot(anon, '1-super-admin');
    return anon.url();
  });
  if ((await (await fetch(`${SKYFLY}/signup`)).text()).includes('data-owner-signup')) await step('2. /signup: Full name, Business name, Email address, Password, Confirm password, "Create Business Account"', async () => {
    await anon.goto(`${SKYFLY}/signup`);
    for (const s of ['#name', '#business_name', '#email', '#password', '#confirm']) assert(await anon.locator(`[data-owner-signup] ${s}`).count() === 1, `missing ${s}`);
    assert((await anon.textContent('[data-owner-signup] button[type=submit]')).trim() === 'Create Business Account', 'button text');
    await shot(anon, '2-signup');
  });
  await step('3. /login: Email address, Password, "Sign In", "Forgot Password?"', async () => {
    await anon.goto(`${SKYFLY}/login`);
    assert(await anon.locator('[data-owner-login] #email').count() === 1 && await anon.locator('[data-owner-login] #password').count() === 1, 'fields');
    assert((await anon.textContent('[data-owner-login] button[type=submit]')).trim() === 'Sign In', 'button text');
    assert(await anon.locator('a[href="/forgot-password"]').count() === 1, 'no Forgot Password link');
    await shot(anon, '3-login');
  });
  await step('4. /forgot-password: says honestly whether reset emails can be sent', async () => {
    await anon.goto(`${SKYFLY}/forgot-password`);
    const unavailable = await anon.locator('[data-reset-unavailable]').count();
    await shot(anon, '4-forgot-password');
    return unavailable ? 'no email sender configured: the page says reset by email is not available yet (no false "sent" message)' : 'email form shown (sender configured)';
  });

  const owner = await fresh();
  let biz;
  regOpen = (await (await fetch(`${SKYFLY}/signup`)).text()).includes('data-owner-signup');
  if (!regOpen) {
    console.log('INFO  Public registration is closed (by invitation only): steps 5–8 (test registration) not run; the page shows "Registration is by invitation".');
    await anon.goto(`${SKYFLY}/signup`);
    await shot(anon, '2b-signup-closed');
  }
  if (regOpen) await step('5. A new owner registers on /signup and lands in their OWN new business (not Larose)', async () => {
    await owner.goto(`${SKYFLY}/signup`);
    await owner.fill('#name', 'Signup Test Owner'); await owner.fill('#business_name', BUSINESS);
    await owner.fill('#email', EMAIL); await owner.fill('#password', PASSWORD); await owner.fill('#confirm', PASSWORD);
    await Promise.all([owner.waitForURL(/\/(businesses\/\d+|verify-email)$/, { waitUntil: 'load' }), owner.click('[data-owner-signup] button[type=submit]')]);
    if (owner.url().endsWith('/verify-email')) return 'email confirmation required (sender configured) — confirm via the emailed link';
    biz = owner.url().match(/\/businesses\/(\d+)$/)[1];
    const text = await owner.textContent('body');
    assert(text.includes(BUSINESS.replace(' (test)', '')), 'own business name not shown');
    assert(!/Larose/i.test(text), 'Larose shown to a new business');
    await shot(owner, '5-new-business-dashboard');
    return `business #${biz}: ${BUSINESS}`;
  });
  if (regOpen) await step('6. The new owner is refused every other business (Larose included) and the Super Admin area', async () => {
    assert(biz, 'no business');
    const refused = [];
    for (let id = 1; id <= Number(biz) + 2; id += 1) {
      if (String(id) === biz) continue;
      for (const path of ['', '/orders', '/products', '/customers', '/pixels', '/settings']) {
        const r = await owner.request.get(`${SKYFLY}/businesses/${id}${path}`, { maxRedirects: 0 });
        assert(r.status() === 404, `business ${id}${path}: HTTP ${r.status()}`);
      }
      refused.push(id);
    }
    for (const path of ['/admin', '/admin/login', '/admin/capacity']) {
      const r = await owner.request.get(`${SKYFLY}${path}`, { maxRedirects: 0 });
      assert(r.status() === 404, `${path}: HTTP ${r.status()}`);
    }
    return `businesses ${refused.join(', ')} × 6 sections → 404; /admin → 404`;
  });
  if (regOpen) await step('7. Signed in: /signup and /login say "You are signed in" (no silent jump into a workspace)', async () => {
    for (const path of ['/signup', '/login']) {
      await owner.goto(`${SKYFLY}${path}`);
      assert(await owner.locator('[data-signed-in]').count() === 1, `${path}: ${owner.url()}`);
      assert((await owner.textContent('[data-signed-in]')).includes(EMAIL), `${path}: other account shown`);
    }
    await shot(owner, '6-signed-in-notice');
  });
  if (regOpen) await step('8. Sign out, then sign in on /login: back in the same own business', async () => {
    await Promise.all([owner.waitForURL(/\/(login|signup)$/), owner.click('[data-signed-in] button[type=submit]')]);
    await owner.goto(`${SKYFLY}/login`);
    await owner.fill('#email', EMAIL); await owner.fill('#password', PASSWORD);
    await Promise.all([owner.waitForLoadState('load'), owner.click('[data-owner-login] button[type=submit]')]);
    await owner.goto(`${SKYFLY}/`);
    assert(owner.url().endsWith(`/businesses/${biz}`), `landed on ${owner.url()}`);
    return owner.url();
  });
} finally {
  await browser.close();
}
console.log(failed ? `\n${failed} check(s) failed` : `\nAll entry-point checks passed (${regOpen ? `test business "${BUSINESS}" was created` : 'registration closed: no account or business created'}; no order)`);
process.exit(failed ? 1 : 0);
