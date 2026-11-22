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
    };
  });
  console.log(`TAB ${tab}: HTTP ${r.status()} h1="${info.h1}" error=${info.error}`);
  console.log(`  buttons: ${info.buttons.join(' | ')}`);
  console.log(`  forms: ${[...new Set(info.forms)].join(' ')}`);
  if (['overview', 'analysis', 'whatsapp', 'approvals'].includes(tab)) console.log(`  text: ${info.text}`);
  if (info.aiOff && tab === 'overview') console.log(`  AI notice: ${info.aiOff}`);
}
await browser.close();
