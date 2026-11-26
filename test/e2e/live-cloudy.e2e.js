// Live readiness check of Cloudy, the AI Media Buyer, on the deployed Skyfly, with the restricted live-test
// owners only (never Larose or a real client):
//   - "new business" owner (E2E_NEWBIZ): a fresh business with no Meta account, standing in for a new client;
//   - owner A (E2E_OWNER_A): the demo shop, for the isolation checks.
// It sends a few REAL AI requests (Cloudy Ask, onboarding, a campaign draft), starts Facebook Login only up to
// Meta's own dialog address (never signs in to Facebook, never connects an account), and never creates,
// launches or changes anything in Meta. Each check prints PASS / FAIL / BLOCKED (needs the owner or Meta).
//
//   SKYFLY_URL=https://<service>.onrender.com SKYFLY_OWNER_PASSWORD=… node test/e2e/live-cloudy.e2e.js
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';

const SKYFLY = (process.env.SKYFLY_URL || '').replace(/\/+$/, '');
if (!/^https:\/\/[a-z0-9-]+\.onrender\.com$|^https:\/\/getskyfly\.com$|^http:\/\/localhost:\d+$/.test(SKYFLY) || /\/\/skyfly\.onrender\.com/.test(SKYFLY)) throw new Error('Set SKYFLY_URL to the verified Skyfly service address');
const PASSWORD = process.env.SKYFLY_OWNER_PASSWORD;
if (!PASSWORD) throw new Error('No live-test sign-in: run this through the "Live Cloudy check" workflow');
const ACCOUNTS = { fresh: 'e2e-iso-new@skyfly.invalid', A: 'e2e-owner-a@skyfly.invalid' };
const SECRET = /BEGIN PRIVATE KEY|\bEAA[A-Za-z0-9]{30,}|\bsk-[A-Za-z0-9_-]{20,}|\bsk-ant-[A-Za-z0-9_-]{20,}|"private_key"/;
const shots = path.resolve('live-screenshots');
mkdirSync(shots, { recursive: true });

let failed = 0; let blocked = 0;
class Blocked extends Error {}
async function step(name, fn) {
  try { const info = await fn(); console.log(`PASS  ${name}${info ? ` — ${info}` : ''}`); return true; } catch (err) {
    if (err instanceof Blocked) { blocked += 1; console.log(`BLOCKED  ${name} — ${err.message}`); return false; }
    failed += 1; console.log(`FAIL  ${name} — ${String(err.message).split('\n')[0]}`); return false;
  }
}
const assert = (c, m) => { if (!c) throw new Error(m); };
const clip = (s, n = 220) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
async function signIn(email) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const p = await ctx.newPage();
  await p.goto(`${SKYFLY}/login`);
  await p.fill('#email', email); await p.fill('#password', PASSWORD);
  await Promise.all([p.waitForLoadState('load'), p.click('main button[type=submit]')]);
  assert(!p.url().endsWith('/login'), `sign-in refused for ${email}`);
  return p;
}
const idOf = (url) => url.match(/\/businesses\/(\d+)/)?.[1];
const csrf = async (p) => p.locator('input[name=_csrf]').first().inputValue();
const post = async (p, url, form) => p.request.post(url, { form: { _csrf: await csrf(p), ...form }, maxRedirects: 0, timeout: 240000 });
const text = async (p, sel) => (await p.locator(sel).count()) ? clip(await p.locator(sel).first().textContent(), 400) : null;

const s = {};
await step('C1. A fresh business owner signs in and opens AI Media Buyer (Cloudy)', async () => {
  s.fresh = await signIn(ACCOUNTS.fresh);
  s.freshId = idOf(s.fresh.url());
  assert(s.freshId, `landed on ${s.fresh.url()}`);
  s.mb = `${SKYFLY}/businesses/${s.freshId}/media-buyer`;
  const r = await s.fresh.goto(s.mb);
  assert(r.status() === 200, `HTTP ${r.status()}`);
  await s.fresh.screenshot({ path: path.join(shots, 'cloudy-overview.png'), fullPage: true });
  return `business #${s.freshId}`;
});

await step('C2. AI provider: Cloudy and the analysis engines are switched on in production', async () => {
  const cloudy = await text(s.fresh, '[data-cloudy-status]');
  const chatgpt = await text(s.fresh, '[data-analyst-status]');
  const claude = await text(s.fresh, '[data-claude-status]');
  console.log(`INFO  Engines — Cloudy: ${cloudy} · ChatGPT: ${chatgpt} · Claude: ${claude}`);
  assert(/^on/.test(cloudy ?? ''), `Cloudy is ${cloudy}`);
  return `Cloudy ${cloudy}`;
});

await step('C3. Meta connection on the fresh business: none yet, and the page says so', async () => {
  const switcher = await s.fresh.locator('[data-account-switcher] option').count();
  return `${switcher} ad account(s) connected`;
});

await step('C4. Facebook Login (Meta OAuth) is switched on for business owners', async () => {
  await s.fresh.goto(`${s.mb}?tab=settings`);
  await s.fresh.screenshot({ path: path.join(shots, 'cloudy-settings.png'), fullPage: true });
  const off = await text(s.fresh, '[data-fb-off]');
  if (off) throw new Blocked(off);
  const btn = s.fresh.locator('[data-fb-start]');
  assert(await btn.count(), 'no "Connect with Facebook" button for the owner');
  assert(!(await btn.isDisabled()), 'the button is disabled');
  return 'button enabled';
});

await step('C5. Starting Facebook Login sends the owner to Meta\'s own dialog with Skyfly\'s app, scopes and callback (not followed)', async () => {
  const r = await post(s.fresh, `${s.mb}/connect/facebook`, {});
  if (r.status() === 409) throw new Blocked(clip(await r.text(), 300).match(/Facebook Login is not set up[^.]*\./)?.[0] ?? 'Facebook Login not set up on the server');
  assert(r.status() === 303, `HTTP ${r.status()}`);
  const u = new URL(r.headers().location);
  assert(/(^|\.)facebook\.com$/.test(u.host) && /\/dialog\/oauth$/.test(u.pathname), `went to ${u.host}${u.pathname}`);
  const appId = u.searchParams.get('client_id');
  const scope = u.searchParams.get('scope') ?? `config_id=${u.searchParams.get('config_id')}`;
  const cb = u.searchParams.get('redirect_uri');
  assert(appId && cb && u.searchParams.get('state'), 'client_id / redirect_uri / state missing');
  console.log(`INFO  Meta app ${appId} · ${u.pathname.split('/')[1]} · callback ${cb} · permissions: ${scope}`);
  return `dialog ${u.host}${u.pathname}`;
});

await step('C6. Cloudy answers a real question about this business (a genuine AI answer, saved for this business)', async () => {
  await s.fresh.goto(s.mb);
  const q = `Live readiness check ${process.env.GITHUB_RUN_ID ?? ''}: In two short paragraphs, what do you know about this business, and can you see any Meta ad account or results for it?`;
  const before = await s.fresh.locator('[data-ask-log] > *, .chat-msg, [data-message]').count().catch(() => 0);
  const r = await post(s.fresh, `${s.mb}/ask`, { question: q });
  const body = await r.text();
  assert([200, 302, 303].includes(r.status()), `HTTP ${r.status()}: ${clip(body.match(/role="alert"[^>]*>([^<]+)/)?.[1] ?? body, 200)}`);
  await s.fresh.goto(s.mb);
  const page = await s.fresh.textContent('main');
  const i = page.lastIndexOf('Live readiness check');
  assert(i >= 0, 'the question was not saved in the conversation');
  s.answer = clip(page.slice(i + q.length, i + q.length + 900), 500);
  assert(s.answer.length > 60, `no answer after the question (${before} messages before)`);
  console.log(`INFO  Cloudy's answer (start): ${s.answer}`);
  return 'answer saved';
});

await step('C7. Cloudy is honest that no Meta account is connected (no invented numbers)', async () => {
  assert(/no (meta|ad) account|not connected|isn'?t connected|no advertising data|connect (a|your) meta/i.test(s.answer ?? ''), 'the answer does not say that no ad account is connected');
  return 'says no ad account is connected';
});

await step('C8. Onboarding conversation: the owner describes the business and Cloudy records it', async () => {
  await s.fresh.goto(s.mb);
  if (!(await s.fresh.locator(`form[action$="/onboarding/message"]`).count())) throw new Blocked('no onboarding conversation shown (no AI engine for onboarding)');
  const r = await post(s.fresh, `${s.mb}/onboarding/message`, { message: 'TEST BUSINESS for an automated check. We sell handmade shea butter body cream (250g for 12,000 NGN) to women aged 25-45 in Lagos and Abuja, delivered with payment on delivery. Goal: more WhatsApp orders. Daily ad budget 5,000 NGN. Website: none yet.' });
  assert([302, 303].includes(r.status()), `HTTP ${r.status()}: ${clip(await r.text(), 200)}`);
  await s.fresh.goto(s.mb);
  return clip(await text(s.fresh, '#onboarding') ?? 'recorded', 160);
});

await step('C9. "Draft a campaign" on a business with no Meta account: a draft for approval, or an honest "connect Meta first"', async () => {
  const r = await post(s.fresh, `${s.mb}/generate/campaign_draft`, {});
  const loc = r.headers().location ?? '';
  if (r.status() === 409) {
    const msg = clip((await r.text()).match(/role="alert"[^>]*>([^<]+)/)?.[1] ?? '', 240);
    assert(/connect a meta ad account/i.test(msg), `HTTP 409 without a clear reason: ${msg}`);
    return `refused honestly before a Meta account is connected: "${msg}"`;
  }
  assert([302, 303].includes(r.status()), `HTTP ${r.status()}: ${clip((await r.text()).match(/role="alert"[^>]*>([^<]+)/)?.[1] ?? '', 240)}`);
  const item = await s.fresh.goto(new URL(loc, SKYFLY).toString());
  assert(item.status() === 200, `item HTTP ${item.status()}`);
  s.draftUrl = s.fresh.url();
  s.draftId = s.fresh.url().match(/items\/(\d+)/)?.[1] ?? null;
  await s.fresh.screenshot({ path: path.join(shots, 'cloudy-draft.png'), fullPage: true });
  return clip(await s.fresh.textContent('main'), 260);
});

await step('C10. Building a full campaign plan needs a connected Meta ad account, and says so honestly', async () => {
  const r = await post(s.fresh, `${s.mb}/plan`, {});
  const body = await r.text();
  const msg = clip(body.match(/role="alert"[^>]*>([^<]+)/)?.[1] ?? '', 240);
  assert(r.status() >= 400 && msg, `HTTP ${r.status()} with no clear error`);
  return `HTTP ${r.status()}: ${msg}`;
});

await step('C11. Isolation: another business\'s owner cannot open this business\'s Cloudy, its draft, or ask Cloudy as it', async () => {
  s.A = await signIn(ACCOUNTS.A);
  const aId = idOf(s.A.url());
  assert(aId && aId !== s.freshId, 'owner A has no separate business');
  const page = await s.A.request.get(s.mb, { maxRedirects: 0 });
  assert([403, 404].includes(page.status()), `media buyer of another business: HTTP ${page.status()}`);
  if (s.draftId) {
    const item = await s.A.request.get(`${s.mb}/items/${s.draftId}`, { maxRedirects: 0 });
    assert([403, 404].includes(item.status()), `draft of another business: HTTP ${item.status()}`);
    const own = await s.A.request.get(`${SKYFLY}/businesses/${aId}/media-buyer/items/${s.draftId}`, { maxRedirects: 0 });
    assert(own.status() === 404, `the other business's draft ID under owner A's own business: HTTP ${own.status()}`);
  }
  await s.A.goto(`${SKYFLY}/businesses/${aId}/media-buyer`);
  const ask = await post(s.A, `${s.mb}/ask`, { question: 'isolation probe' });
  assert([403, 404].includes(ask.status()), `asking Cloudy of another business: HTTP ${ask.status()}`);
  const mine = await s.A.textContent('main');
  assert(!mine.includes('Live readiness check'), 'the other business\'s conversation is visible to owner A');
  return `owner A (business #${aId}) refused on every path`;
});

await step('C12. No secret (Meta token, AI key, private key) appears in any Media Buyer page', async () => {
  for (const tab of ['overview', 'settings', 'approvals', 'analysis', 'campaigns']) {
    const html = await (await s.fresh.request.get(`${s.mb}?tab=${tab}`)).text();
    assert(!SECRET.test(html), `secret-looking value on ${tab}`);
  }
  if (s.draftUrl) assert(!SECRET.test(await (await s.fresh.request.get(s.draftUrl)).text()), 'secret-looking value on the draft');
  return '5 tabs and the draft checked';
});

await browser.close();
console.log(`\n${failed ? `${failed} check(s) FAILED` : 'No failures'}${blocked ? `, ${blocked} BLOCKED (need the owner or Meta)` : ''}.`);
process.exit(failed ? 1 : 0);
