// Temporary branch only: signed-in, READ-ONLY look at the AI Media Buyer on the live site, as owner B of
// the labelled test business. Opens every tab; submits nothing; no Meta call that changes anything.
import { chromium, devices } from 'playwright-core';
const SKYFLY = (process.env.SKYFLY_URL || '').replace(/\/+$/, '');
const PASSWORD = process.env.SKYFLY_OWNER_PASSWORD;
if (!PASSWORD) throw new Error('No live-test sign-in');
const browser = await chromium.launch();
const ctx = await browser.newContext({ ...devices['iPhone 13'] });
const p = await ctx.newPage(); p.setDefaultTimeout(20000);
await p.goto(`${SKYFLY}/login`);
await p.fill('#email', 'e2e-owner-b@skyfly.invalid'); await p.fill('#password', PASSWORD);
await Promise.all([p.waitForURL((u) => !u.toString().endsWith('/login'), { waitUntil: 'load' }), p.click('main button[type=submit]')]);
const biz = p.url().match(/\/businesses\/(\d+)/)?.[1];
console.log(`SIGNIN owner B -> ${p.url().replace(SKYFLY, '')} business #${biz}`);
const nav = await p.$$eval('a[href*="/media-buyer"]', (as) => as.map((a) => a.textContent.trim()).filter(Boolean));
console.log(`NAV link to Media Buyer: ${nav.length ? JSON.stringify([...new Set(nav)]) : 'NONE'}`);
for (const tab of ['overview', 'analysis', 'whatsapp', 'approvals', 'campaigns', 'settings']) {
  const r = await p.goto(`${SKYFLY}/businesses/${biz}/media-buyer?tab=${tab}`);
  const info = await p.evaluate(() => {
    const t = (s) => [...document.querySelectorAll(s)];
    return {
      h1: document.querySelector('h1')?.textContent.trim(),
      aiOff: document.querySelector('[data-ai-off]')?.textContent.trim().slice(0, 140) ?? null,
      buttons: t('main button').map((b) => `${b.textContent.trim().slice(0, 40)}${b.disabled ? ' [DISABLED]' : ''}`),
      forms: t('main form').map((f) => (f.getAttribute('action') || '').replace(/\/businesses\/\d+\/media-buyer/, '')),
      error: document.querySelector('.error')?.textContent.trim().slice(0, 140) ?? null,
      text: document.querySelector('main')?.innerText.replace(/\s+/g, ' ').slice(0, 260),
      extra: ['[data-auto-status]', '[data-fb-login]', '[data-last-connect-failure]', '[data-fb-picker]'].map((s) => document.querySelector(s)?.innerText.replace(/\s+/g, ' ').trim().slice(0, 300)).filter(Boolean),
    };
  });
  console.log(`TAB ${tab}: HTTP ${r.status()} h1="${info.h1}" error=${info.error}`);
  console.log(`  buttons: ${info.buttons.join(' | ')}`);
  console.log(`  forms: ${[...new Set(info.forms)].join(' ')}`);
  if (['overview', 'analysis', 'whatsapp', 'approvals'].includes(tab)) console.log(`  text: ${info.text}`);
  for (const x of info.extra) console.log(`  NEW: ${x}`);
  if (info.aiOff && tab === 'overview') console.log(`  AI notice: ${info.aiOff}`);
}

// ---- Live probes of the Meta connection endpoints (signed in as owner B). Nothing here can connect an account,
// call Meta, or change data: every request is one that must be refused or that fails before anything is stored.
{
  const R = (label, r, extra = '') => console.log(`LIVE ${label}: HTTP ${r.status()}${r.headers().location ? ` -> ${r.headers().location.replace(SKYFLY, '')}` : ''}${extra ? ` | ${extra}` : ''}`);
  const msg = async (r) => ((await r.text()).match(/class="(?:error|warn-box)"[^>]*>([^<]{0,220})/)?.[1] ?? (await r.text()).match(/<p[^>]*>([^<]{10,200})<\/p>/)?.[1] ?? '').trim();
  const mb = `${SKYFLY}/businesses/${biz}/media-buyer`;
  const settings = await p.request.get(`${mb}?tab=settings`);
  const html = await settings.text();
  const csrf = html.match(/name="_csrf" value="([^"]+)"/)?.[1];
  const btn = html.match(/<button[^>]*data-fb-start[^>]*>/)?.[0] ?? 'NOT FOUND';
  console.log(`LIVE settings: HTTP ${settings.status()} | Connect-with-Facebook button: ${btn.includes('disabled') ? 'present, DISABLED' : btn === 'NOT FOUND' ? 'NOT FOUND' : 'present, enabled'} | notice: ${(html.match(/data-fb-off>([^<]+)/)?.[1] ?? '').trim()}`);
  for (const m of html.matchAll(/\bEAA[A-Za-z0-9]{20,}|access_token=|app_secret|client_secret/gi)) {
    const at = m.index; const ctxt = html.slice(Math.max(0, at - 60), at).replace(/\s+/g, ' ');
    console.log(`LIVE secret-pattern match: "${m[0].slice(0, 6)}…(${m[0].length} chars)" preceded by "${ctxt.slice(-60)}"`);
  }
  console.log(`LIVE secret-pattern matches: ${[...html.matchAll(/\bEAA[A-Za-z0-9]{20,}|access_token=|app_secret|client_secret/gi)].length}`);
  const post = (path, form = {}) => p.request.post(path, { form: { _csrf: csrf, ...form }, maxRedirects: 0 });
  let r = await post(`${mb}/connect/facebook`); R('start Facebook Login', r, `${(r.headers().location || '').includes('facebook.com') ? 'REDIRECTED TO META' : 'not redirected'}; ${await msg(r)}`);
  r = await p.request.get(`${SKYFLY}/meta/oauth/callback?state=${'f'.repeat(32)}&code=made-up`, { maxRedirects: 0 }); R('callback, made-up state', r, await msg(r));
  const anon = await browser.newContext(); r = await anon.request.get(`${SKYFLY}/meta/oauth/callback?state=${'f'.repeat(32)}&code=made-up`, { maxRedirects: 0 }); R('callback, signed out', r); await anon.close();
  r = await post(`${mb}/connect/facebook/refresh`); R('refresh account list', r, await msg(r));
  r = await post(`${mb}/connect/facebook/accounts`, { grant: '1', accounts: '1748876806431046' }); R('connect from a grant that is not mine', r, await msg(r));
  r = await post(`${mb}/accounts/1748876806431046/select`); R('select an account not connected here', r);
  r = await post(`${mb}/accounts/1748876806431046/disconnect`); R('remove an account not connected here', r);
  r = await post(`${mb}/connect`, { ad_account_id: 'act_1748876806431046', token: 'not-a-real-token' }); R('token form, invalid token', r, await msg(r));
  r = await post(`${mb}/ask`, { question: 'What should I advertise first?' }); R('Ask Cloudy (real question)', r, await msg(r));
  console.log(`LIVE Ask form: ${/<input name="question"[^>]*disabled/.test(html) ? 'input DISABLED' : 'input enabled'} | Cloudy status: ${(html.match(/data-cloudy-status>([^<]+)/)?.[1] ?? 'not shown').trim()}`);
  console.log(`LIVE AI notice: ${(html.match(/data-ai-off>([^<]+)/)?.[1] ?? 'none').trim().slice(0, 260)}`);
  const other = biz === '4' ? '3' : '4';
  r = await p.request.get(`${SKYFLY}/businesses/${other}/media-buyer?tab=settings`, { maxRedirects: 0 }); R(`other business #${other} Media Buyer settings`, r);
  r = await post(`${SKYFLY}/businesses/${other}/media-buyer/connect/facebook`); R(`start Facebook Login for other business #${other}`, r);
  r = await post(`${SKYFLY}/businesses/${other}/media-buyer/connect/facebook/refresh`); R(`refresh for other business #${other}`, r);
  r = await p.request.get(`${SKYFLY}/admin`, { maxRedirects: 0 }); R('Super Admin area as owner', r);
  const after = await (await p.request.get(`${mb}?tab=settings`)).text();
  console.log(`LIVE connected accounts in this business after probes: ${(after.match(/data-account="\d+"/g) || []).length}`);
}
await browser.close();
