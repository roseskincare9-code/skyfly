// Live end-to-end check on the deployed Skyfly, in a real browser, of the whole new-customer journey:
//   1. public registration at /signup (no invitation; Cloudflare Turnstile is completed by the browser like a
//      person would — never bypassed: if Cloudflare asks for more, the test stops and says so);
//   2. the real verification email (Resend's test inbox delivered+…@resend.dev, read back through the
//      Resend API) and its link → the owner's own new business workspace;
//   3. isolation for the new account (other businesses and the Super Admin area: 404);
//   4. Business Pro paid on Paystack's checkout in TEST MODE (Paystack test card; the run stops before any
//      card is entered unless Skyfly recorded the payment as test mode), activated after Paystack's
//      confirmation; dates checked;
//   5. Agency VIP paid with the browser's return to Skyfly BLOCKED, so only Paystack's signed webhook can
//      activate it; renewal starts the day after the Business Pro period;
//   6. a declined test card changes nothing.
// Creates one labelled "(test)" business; no orders; touches no other business. Prints no secrets.
//   SKYFLY_URL=https://getskyfly.com RESEND_API_KEY=… node test/e2e/live-billing.e2e.js
import { spawnSync } from 'node:child_process';
import { mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Turnstile treats a visible browser like a person's: run headed under a virtual display when available.
if (!process.env.DISPLAY && !process.env.XVFB_WRAPPED && spawnSync('which', ['xvfb-run']).status === 0) {
  const r = spawnSync('xvfb-run', ['-a', process.execPath, fileURLToPath(import.meta.url)], { stdio: 'inherit', env: { ...process.env, XVFB_WRAPPED: '1' } });
  process.exit(r.status ?? 1);
}
const { chromium } = await import('playwright-core');

const SKYFLY = (process.env.SKYFLY_URL || '').replace(/\/+$/, '');
if (!/^https:\/\/getskyfly\.com$|^https:\/\/[a-z0-9-]+\.onrender\.com$|^http:\/\/localhost:\d+$/.test(SKYFLY)) throw new Error('Set SKYFLY_URL');
const RUN = String(process.env.GITHUB_RUN_ID || Date.now()).slice(-8);
const EMAIL = `delivered+billing${RUN}@resend.dev`;
const PASSWORD = `Bv-${Math.random().toString(36).slice(2)}-${RUN}`;
const BUSINESS = `Billing Verify ${RUN} (test)`;
// Paystack's published test cards (test mode only; they cannot move real money).
const CARD_OK = { number: '4084084084084081', cvv: '408', expiry: '12/30' };
const CARD_DECLINED = { number: '4084080000005408', cvv: '001', expiry: '12/30' };
mkdirSync('live-screenshots', { recursive: true });

let failed = 0; let blocked = 0;
const step = async (name, fn) => {
  try { const info = await fn(); console.log(`PASS  ${name}${info ? ` — ${info}` : ''}`); return true; }
  catch (err) {
    const m = String(err.message).split('\n')[0].slice(0, 400);
    if (err.blocked) { blocked += 1; console.log(`BLOCKED  ${name} — ${m}`); } else { failed += 1; console.log(`FAIL  ${name} — ${m}`); }
    return false;
  }
};
const ok = (c, m) => { if (!c) throw new Error(m); };
const block = (m) => Object.assign(new Error(m), { blocked: true });
const resend = async (path) => {
  const r = await fetch(`https://api.resend.com${path}`, { headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}` } });
  if (r.status !== 200) throw new Error(`Resend API → HTTP ${r.status}`);
  return r.json();
};
const addMonthMinusDay = (d) => { const [y, m, day] = d.split('-').map(Number); const t = new Date(Date.UTC(y, m, day)); if (t.getUTCDate() !== day) t.setUTCDate(0); t.setUTCDate(t.getUTCDate() - 1); return t.toISOString().slice(0, 10); };
const nextDay = (d) => new Date(Date.parse(`${d}T00:00:00Z`) + 864e5).toISOString().slice(0, 10);

const browser = await chromium.launch({ headless: !process.env.DISPLAY, ...(existsSync('/opt/pw-browsers/chromium') ? { executablePath: '/opt/pw-browsers/chromium' } : {}) });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'en-NG' });
const page = await ctx.newPage();
let biz = null; let link = null; let pro = null;

async function subscriptionState() {
  const r = await ctx.request.get(`${SKYFLY}/businesses/${biz}/subscription`);
  const t = await r.text();
  const rows = [...t.matchAll(/<tr>\s*<td>([\d-]+)<\/td>\s*<td>([^<]+)<\/td>\s*<td>([^<]+)<\/td>\s*<td><span[^>]*>([^<]+)<\/span><\/td>\s*<td>([^<]+)<\/td>\s*<td><code>([^<]+)<\/code>/g)]
    .map((m) => ({ plan: m[2].trim(), amount: m[3].trim(), status: m[4].trim(), period: m[5].trim(), reference: m[6].trim() }));
  return {
    http: r.status(), plan: t.match(/data-plan>([^<]+)</)?.[1]?.trim(), status: t.match(/data-sub-status="([^"]+)"/)?.[1],
    paidUntil: t.match(/data-paid-until>([\d-]+)/)?.[1] ?? null, started: t.match(/<dt>Started<\/dt><dd>([\d-]+)/)?.[1] ?? null, rows, text: t,
  };
}

// Fills Paystack's hosted card form (it may sit in the page or in a frame) and submits it.
async function payOnPaystack(card, label) {
  await page.waitForURL(/checkout\.paystack\.com/, { timeout: 60000 });
  const findIn = async (sel) => { for (const f of page.frames()) { const l = f.locator(sel).first(); if (await l.count().catch(() => 0)) return l; } return null; };
  let num = null;
  for (let i = 0; i < 40 && !num; i += 1) { num = await findIn('input[autocomplete="cc-number"], input[name="cardNumber"], input[id*="card-number" i], input[placeholder*="0000"]'); if (!num) await page.waitForTimeout(500); }
  if (!num) { const card = await findIn('text=/^\\s*Card\\s*$/i'); if (card) { await card.click(); num = await findIn('input[autocomplete="cc-number"], input[name="cardNumber"], input[id*="card-number" i], input[placeholder*="0000"]'); } }
  ok(num, 'card number field not found on Paystack checkout');
  await num.fill(card.number);
  (await findIn('input[autocomplete="cc-exp"], input[name="expiry"], input[id*="expiry" i], input[placeholder*="MM"]'))?.fill(card.expiry);
  (await findIn('input[autocomplete="cc-csc"], input[name="cvv"], input[id*="cvv" i], input[placeholder*="123"]'))?.fill(card.cvv);
  await page.screenshot({ path: `live-screenshots/paystack-${label}-card.png` });
  const pay = await findIn('button:has-text("Pay")');
  ok(pay, 'Pay button not found on Paystack checkout');
  await pay.click();
  // Some test cards ask for a PIN / OTP (Paystack test values).
  for (let i = 0; i < 20; i += 1) {
    if (!/checkout\.paystack\.com/.test(page.url())) return;
    const pin = await findIn('input[name="pin"], input[id*="pin" i]');
    if (pin) { await pin.fill('0000'); (await findIn('button:has-text("Continue"), button:has-text("Authorize"), button:has-text("Submit")'))?.click(); }
    const otp = await findIn('input[name="otp"], input[id*="otp" i]');
    if (otp) { await otp.fill('123456'); (await findIn('button:has-text("Continue"), button:has-text("Authorize"), button:has-text("Submit")'))?.click(); }
    await page.waitForTimeout(1500);
  }
}

// Starts a checkout from Skyfly; refuses to go further unless Skyfly recorded it as a TEST-mode payment.
async function startCheckout(planLabel) {
  await page.goto(`${SKYFLY}/businesses/${biz}/subscription`);
  const btn = page.locator(`button[data-pay="${planLabel === 'Business Pro' ? 'business_pro' : 'agency_vip'}"]`);
  ok(await btn.count(), (await page.content()).includes('data-billing-off') ? 'online plan payment is not on (PAYSTACK_SECRET_KEY not set on the service)' : 'no Pay button');
  await btn.click();
  await page.waitForURL(/checkout\.paystack\.com/, { timeout: 60000 });
  const s = await subscriptionState();
  const row = s.rows[0];
  ok(row && row.status === 'Awaiting confirmation', 'payment not recorded as awaiting confirmation');
  if (!row.plan.includes('(test)')) throw block('Skyfly recorded this payment as LIVE mode: stopped before entering any card (the service has a live Paystack key)');
  ok(row.amount.replace(/[^\d]/g, '') === (planLabel === 'Business Pro' ? '19900000' : '39900000'), `amount ${row.amount}`);
  return row.reference;
}

try {
  // Page script errors and failed requests seen anywhere during the run.
  const consoleErrors = [];
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(`console: ${m.text()}`); });
  const btn = { visible: false, clickable: false };
  await step('Signup button: /login shows "Create Your Business Account" and clicking it opens /signup', async () => {
    await page.goto(`${SKYFLY}/login`);
    const cta = page.locator('[data-signup-cta] a');
    await page.screenshot({ path: 'live-screenshots/login.png', fullPage: true });
    ok(await cta.count(), 'no signup button on /login (it is shown only while registration is open)');
    ok(await cta.first().isVisible(), 'signup button present but not visible');
    btn.visible = true;
    await Promise.all([page.waitForURL(/\/signup/, { timeout: 30000 }), cta.first().click()]);
    btn.clickable = true;
    return `"${(await cta.first().textContent().catch(() => 'button'))?.trim()}" → ${page.url()}`;
  });
  await step('Signup page: the form and its submit button are visible and enabled', async () => {
    const r = await page.goto(`${SKYFLY}/signup`);
    await page.screenshot({ path: 'live-screenshots/signup.png', fullPage: true });
    const html = await page.content();
    ok(/name="business_name"/.test(html), `HTTP ${r.status()}: ${/opens soon/i.test(html) ? 'page shows "Business registration opens soon" (no form)' : 'no registration form'}`);
    const submit = page.locator('form button[type="submit"]').last();
    ok(await submit.isVisible() && await submit.isEnabled(), 'submit button hidden or disabled');
    return `HTTP ${r.status()}, submit "${(await submit.textContent())?.trim()}" visible and enabled`;
  });
  const registered = await step('Registration: /signup shows the real form and a new owner registers without an invitation', async () => {
    await page.goto(`${SKYFLY}/signup`);
    const html = await page.content();
    ok(/name="business_name"/.test(html), /opens soon/i.test(html) ? 'registration still closed ("opens soon")' : 'no registration form');
    for (const f of ['name', 'business_name', 'email', 'password', 'confirm', 'accept_terms']) ok(await page.locator(`[name="${f}"]`).count(), `missing field ${f}`);
    await page.fill('[name="name"]', 'Billing Verify Owner');
    await page.fill('[name="business_name"]', BUSINESS);
    await page.fill('[name="email"]', EMAIL);
    if (await page.locator('[name="phone"]').count()) await page.fill('[name="phone"]', '+234 800 000 0010');
    await page.fill('[name="password"]', PASSWORD);
    await page.fill('[name="confirm"]', PASSWORD);
    await page.check('[name="accept_terms"]');
    if (/data-turnstile|cf-turnstile/.test(html)) {
      let token = '';
      for (let i = 0; i < 60 && !token; i += 1) {
        token = await page.locator('[name="cf-turnstile-response"]').first().inputValue().catch(() => '');
        if (!token && i === 10) { const f = page.frames().find((x) => /challenges\.cloudflare\.com/.test(x.url())); await f?.locator('input[type="checkbox"]').click().catch(() => {}); }
        if (!token) await page.waitForTimeout(1000);
      }
      await page.screenshot({ path: 'live-screenshots/signup-form.png' });
      if (!token) throw block('Cloudflare Turnstile did not pass this automated browser (it is not bypassed): one person must register once by hand');
    }
    await Promise.all([page.waitForURL(/\/verify-email/, { timeout: 30000 }), page.click('button[type="submit"]')]);
    const home = await ctx.request.get(`${SKYFLY}/`, { maxRedirects: 0 });
    ok(/verify-email/.test(home.headers().location || ''), 'dashboard opened before the email was confirmed');
    return `${EMAIL.replace(/\+.*@/, '+…@')} → "Confirm your email" page; dashboard locked until confirmed`;
  });

  if (registered) await step('Email verification: the Resend email arrives with a getskyfly.com link', async () => {
    ok(process.env.RESEND_API_KEY, 'no Resend key available to read the test inbox');
    for (let i = 0; i < 18 && !link; i += 1) {
      const hit = ((await resend('/emails?limit=50')).data || []).find((e) => (e.to || []).includes(EMAIL));
      if (hit) {
        const full = await resend(`/emails/${hit.id}`);
        link = (`${full.html || ''} ${full.text || ''}`.match(/https?:\/\/[^\s"'<>]+\/verify-email\/[A-Za-z0-9_-]{40,60}/) || [])[0];
        ok(link && link.startsWith(`${SKYFLY}/verify-email/`), 'no getskyfly.com confirmation link in the email');
        return `subject "${full.subject}", from ${full.from}`;
      }
      await page.waitForTimeout(5000);
    }
    throw new Error('the email did not arrive in Resend within 90 s');
  });

  if (link) await step('Automatic business creation: the link opens the owner\'s own new business, role Owner', async () => {
    await page.goto(link);
    await page.goto(`${SKYFLY}/`);
    const m = page.url().match(/\/businesses\/(\d+)/);
    ok(m, `landed on ${page.url()}`);
    biz = Number(m[1]);
    ok((await page.content()).includes(BUSINESS.replace(' (test)', '')), 'own business name not shown');
    const team = await ctx.request.get(`${SKYFLY}/businesses/${biz}/team`);
    ok(team.status() === 200 && /Owner/.test(await team.text()), 'not Owner of the new business');
    const sub = await subscriptionState();
    await page.screenshot({ path: 'live-screenshots/new-business-dashboard.png' });
    return `new business #${biz}, Owner; subscription ${sub.status}`;
  });

  if (biz) await step('Isolation for the new account: Larose (#2), 3-in-1 (#11), other businesses and /admin all refused', async () => {
    const bad = [];
    for (let id = 1; id < biz; id += 1) for (const p of ['', '/orders', '/customers', '/subscription']) { const r = await ctx.request.get(`${SKYFLY}/businesses/${id}${p}`, { maxRedirects: 0 }); if (r.status() !== 404) bad.push(`#${id}${p}: ${r.status()}`); }
    for (const p of ['/admin', '/admin/subscriptions', '/admin/businesses/new']) { const r = await ctx.request.get(`${SKYFLY}${p}`, { maxRedirects: 0 }); if (r.status() !== 404) bad.push(`${p}: ${r.status()}`); }
    ok(!bad.length, bad.join('; '));
    return `businesses #1–#${biz - 1} × 4 sections and 3 Super Admin pages → 404`;
  });

  if (biz) pro = await step('Business Pro ₦199,000 (Paystack TEST mode): paid with the test card → activated after Paystack confirms', async () => {
    const ref = await startCheckout('Business Pro');
    await payOnPaystack(CARD_OK, 'pro');
    await page.waitForURL(/\/subscription\?payment=/, { timeout: 120000 });
    await page.screenshot({ path: 'live-screenshots/pro-activated.png', fullPage: true });
    const outcome = page.url().split('payment=')[1];
    const s = await subscriptionState();
    const row = s.rows.find((r) => r.reference === ref);
    ok(['activated', 'already_applied'].includes(outcome), `return page outcome "${outcome}"`);
    ok(s.plan === 'Business Pro' && s.status === 'active', `plan ${s.plan}, status ${s.status}`);
    ok(row?.status === 'Paid', `payment ${row?.status}`);
    const [start, end] = row.period.split('→').map((x) => x.trim());
    ok(end === addMonthMinusDay(start) && s.paidUntil === end, `period ${row.period}, paid until ${s.paidUntil}`);
    pro = { end };
    return `${ref}: Active, ${row.period}, paid until ${s.paidUntil} (outcome "${outcome}")`;
  }) && pro;

  if (pro) await step('Agency VIP ₦399,000 via the signed webhook ONLY (return page blocked): plan changes; renewal starts the day after the Pro period', async () => {
    const ref = await startCheckout('Agency VIP');
    await page.route('**/billing/paystack/callback**', (r) => r.abort());
    await payOnPaystack(CARD_OK, 'vip');
    let s;
    for (let i = 0; i < 36; i += 1) { s = await subscriptionState(); if (s.rows.find((r) => r.reference === ref)?.status === 'Paid') break; await page.waitForTimeout(5000); }
    await page.unroute('**/billing/paystack/callback**');
    const row = s.rows.find((r) => r.reference === ref);
    ok(row?.status === 'Paid', `not confirmed by webhook within 3 minutes (payment ${row?.status}; check the Paystack webhook URL)`);
    const [start, end] = row.period.split('→').map((x) => x.trim());
    ok(s.plan === 'Agency VIP' && s.status === 'active', `plan ${s.plan}, status ${s.status}`);
    ok(start === nextDay(pro.end) && end === addMonthMinusDay(start) && s.paidUntil === end, `period ${row.period} after Pro ending ${pro.end}`);
    await page.goto(`${SKYFLY}/businesses/${biz}/subscription`);
    await page.screenshot({ path: 'live-screenshots/vip-webhook.png', fullPage: true });
    return `${ref}: Paid by webhook alone; Agency VIP ${row.period}`;
  });

  if (pro) await step('Declined test card: payment refused, plan and dates unchanged', async () => {
    const before = await subscriptionState();
    const ref = await startCheckout('Business Pro');
    await payOnPaystack(CARD_DECLINED, 'declined').catch(() => {});
    await page.waitForTimeout(5000);
    await page.screenshot({ path: 'live-screenshots/declined.png' });
    await page.goto(`${SKYFLY}/billing/paystack/callback?reference=${ref}`);
    const outcome = page.url().split('payment=')[1];
    const s = await subscriptionState();
    ok(s.plan === before.plan && s.paidUntil === before.paidUntil && s.status === 'active', `plan/dates changed: ${s.plan} ${s.paidUntil}`);
    ok(s.rows.find((r) => r.reference === ref)?.status !== 'Paid', 'declined payment shown as Paid');
    return `${ref}: outcome "${outcome}"; still ${s.plan}, paid until ${s.paidUntil}`;
  });
  console.log(`INFO  Browser console errors during the run: ${consoleErrors.length ? consoleErrors.slice(0, 10).join(' | ').slice(0, 900) : 'none'}`);
} finally { await browser.close(); }
console.log(`\n${failed ? `${failed} check(s) FAILED` : 'No failures'}${blocked ? `, ${blocked} BLOCKED` : ''} (test business: ${BUSINESS}${biz ? ` #${biz}` : ''})`);
process.exit(failed ? 1 : blocked ? 2 : 0);
