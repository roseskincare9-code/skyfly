// Live check of the external integrations, read through the owner's dashboard (no secrets are
// printed). Run after the live order tests (e2e-live, e2e-live-hosting), which place the labelled
// TEST ORDERs this check looks at.
//   SKYFLY_URL=https://<service>.onrender.com SKYFLY_OWNER_EMAIL=… SKYFLY_OWNER_PASSWORD=… [SEND_TEST_EMAIL=yes] node test/e2e/live-integrations.e2e.js
// - Google Sheets: Larose's default spreadsheet is the direct Apps Script link, its existing tabs
//   were reported "not changed", the latest Larose test order was copied, and the real
//   spreadsheet holds exactly one row for it ("Check the spreadsheet", read-only).
// - Meta: server-side test Purchase (Test events code) accepted by Meta for the latest test orders
//   of Larose (pixel 1357015185691765) and the Skyfly demo shop (pixel 1325736489534601).
// - Email: provider, saved key and sender domain; with SEND_TEST_EMAIL=yes, one test email to the
//   owner's own address, which must be accepted by the provider (delivery is confirmed in the inbox).
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright-core';

const SKYFLY = (process.env.SKYFLY_URL || '').replace(/\/+$/, '');
if (!process.env.LIVE_DRY_RUN && !/^https:\/\/[a-z0-9-]+\.onrender\.com$/.test(SKYFLY) || /\/\/skyfly\.onrender\.com/.test(SKYFLY)) throw new Error('Set SKYFLY_URL to the verified Skyfly service address');
const { SKYFLY_OWNER_EMAIL: email, SKYFLY_OWNER_PASSWORD: password } = process.env;
mkdirSync('live-screenshots', { recursive: true });

let failed = 0; let blocked = 0;
class Blocked extends Error {}
async function step(name, fn) {
  try { const info = await fn(); console.log(`PASS  ${name}${info ? ` — ${info}` : ''}`); }
  catch (err) {
    if (err instanceof Blocked) { blocked += 1; console.log(`BLOCKED  ${name} — ${err.message}`); return; }
    failed += 1; console.log(`FAIL  ${name} — ${err.message.split('\n')[0]}`);
  }
}
const assert = (c, m) => { if (!c) throw new Error(m); };
const text = async (loc) => ((await loc.count()) ? (await loc.first().textContent()).replace(/\s+/g, ' ').trim() : '');

if (!email || !password) {
  console.log('BLOCKED  All integration checks — need the SKYFLY_OWNER_EMAIL and SKYFLY_OWNER_PASSWORD repository secrets to read the dashboard');
  process.exit(0);
}

const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
await fetch(`${SKYFLY}/healthz`, { signal: AbortSignal.timeout(90000) }).catch(() => {});
await page.goto(`${SKYFLY}/login`);
await page.fill('#email', email);
await page.fill('#password', password);
await Promise.all([page.waitForLoadState('load'), page.click('button[type=submit]')]);
if (page.url().endsWith('/login')) { console.log('FAIL  Sign-in refused: check the SKYFLY_OWNER_EMAIL / SKYFLY_OWNER_PASSWORD secrets'); process.exit(1); }
await page.goto(`${SKYFLY}/`);
const hrefOf = async (name) => page.getAttribute(`a:text-is("${name}")`, 'href').catch(() => null);
const larose = await hrefOf('Larose Natural Skincare Nigeria');
const demo = await hrefOf('Skyfly Demo Shop (test)');

// The newest labelled test order of a business (by reference prefix), opened on its order page.
async function latestTestOrder(base, prefix) {
  await page.goto(`${SKYFLY}${base}/orders?q=${encodeURIComponent('TEST ORDER')}`);
  const link = page.locator('a', { hasText: new RegExp(`^${prefix}-[A-Z0-9]+$`) }).first();
  if (!(await link.count())) return null;
  const ref = (await link.textContent()).trim();
  await link.click();
  await page.waitForLoadState('load');
  return { ref, url: page.url().replace(/[?#].*/, '') };
}

// ---------- Google Sheets ----------
let sheetDirect = false;
await step('Sheets 1. Larose\'s default spreadsheet is the direct Google Apps Script link, and the existing tabs were left unchanged', async () => {
  assert(larose, 'Larose business not found in the dashboard');
  await page.goto(`${SKYFLY}${larose}/google-sheets`);
  const card = page.locator('.card', { has: page.locator('.pill.confirmed', { hasText: 'Default' }) });
  if (!(await card.count())) throw new Blocked('no default spreadsheet set for Larose');
  const t = await text(card);
  await page.screenshot({ path: 'live-screenshots/larose-google-sheets.png', fullPage: true });
  if (!t.includes('Google Apps Script')) throw new Blocked(`the default is still SheetDB (monthly quota used up), not the direct Laroseorders link: "${t.slice(0, 120)}"`);
  sheetDirect = true;
  assert(/not changed/.test(t) && /Skyfly writes here/.test(t), `connection check: "${t.slice(0, 300)}"`);
  const tabs = t.match(/Tabs: (.*?\.)/)?.[1] ?? '';
  return `connection check: ${tabs.slice(0, 300)}`;
});

let laroseOrder = null;
await step('Sheets 2. The latest Larose TEST ORDER was copied to Laroseorders, and the real spreadsheet holds exactly one row for it', async () => {
  if (!sheetDirect) throw new Blocked('the direct Laroseorders link is not the default yet (see above)');
  laroseOrder = await latestTestOrder(larose, 'LR');
  assert(laroseOrder, 'no Larose TEST ORDER found; run the Larose live test first');
  // New orders are copied about 3 minutes after they arrive.
  let status = '';
  for (let i = 0; i < 24; i += 1) {
    status = await text(page.locator('#sheet'));
    if (/Copied to the Google Sheet/.test(status) || /Copy failed/.test(status)) break;
    await page.waitForTimeout(15000);
    await page.reload();
  }
  assert(/Copied to the Google Sheet/.test(status), `${laroseOrder.ref}: ${status.slice(0, 250)}`);
  await page.click('button:text-is("Check the spreadsheet")');
  await page.waitForLoadState('load');
  const found = await text(page.locator('[data-sheet-check]'));
  await page.screenshot({ path: 'live-screenshots/larose-order-sheet-check.png', fullPage: true });
  assert(/has 1 row for/.test(found), found || 'no result shown');
  return `${laroseOrder.ref}: ${found}`;
});

// ---------- Meta Conversions API (server-side Purchase, Test events only) ----------
async function serverPurchase(base, prefix, pixel, who, missing) {
  if (!base) throw new Error(`${who} business not found in the dashboard`);
  const o = await latestTestOrder(base, prefix);
  if (!o) throw new Blocked(`no ${who} TEST ORDER found; run the live order test first`);
  const events = await text(page.locator('.card', { hasText: 'Ad platform events' }));
  if (!events.includes(`pixel ${pixel}`)) throw new Blocked(`${o.ref}: no server-side event was sent — ${missing}`);
  const line = events.match(new RegExp(`Purchase \\(test\\) to Meta \\(pixel ${pixel}\\): (\\w+)[^]*?(?=Purchase|$)`))?.[0] ?? events;
  assert(/: sent/.test(line), `${o.ref}: ${line.slice(0, 250)}`);
  return `${o.ref}: ${line.slice(0, 160)} (accepted by Meta with the test event code; check Events Manager → Test events)`;
}
await step('Meta 1. Skyfly pixel 1325736489534601: server-side Purchase for the latest demo TEST ORDER accepted by Meta (Test events)', () =>
  serverPurchase(demo, 'DM', '1325736489534601', 'Skyfly Demo Shop (test)', 'SKYFLY_META_ACCESS_TOKEN or SKYFLY_META_TEST_EVENT_CODE is not set in Render, or the order was placed before they were'));
await step('Meta 2. Larose pixel 1357015185691765: server-side Purchase for the latest Larose TEST ORDER accepted by Meta (Test events)', () =>
  serverPurchase(larose, 'LR', '1357015185691765', 'Larose', 'no access token and test event code saved in Skyfly → Larose → Pixels, or the order was placed before they were'));

// ---------- Email (Resend) ----------
let emailReady = false;
await step('Email 1. Larose sending setup: Resend key saved and a sender on a verified domain', async () => {
  assert(larose, 'Larose business not found');
  await page.goto(`${SKYFLY}${larose}/email?tab=setup`);
  const provider = await page.inputValue('#provider').catch(() => '');
  const keyLabel = await text(page.locator('label[for="api_key"]'));
  const from = await page.inputValue('#from_email').catch(() => '');
  const intro = await text(page.locator('#setup p.muted').first());
  if (!/saved:/.test(keyLabel)) throw new Blocked('no email API key saved for Larose (Skyfly → Larose → Email → Sending setup)');
  const domain = from.split('@')[1] || '';
  if (/resend\.dev$/i.test(domain)) throw new Blocked(`the sender is Resend's test address (@resend.dev), which only reaches your own Resend account; verify your domain in Resend and use a sender on it`);
  emailReady = true;
  return `${provider}, key saved, sender domain ${domain}; ${intro.match(/Last test accepted[^.]*\.|Not tested yet\./)?.[0] ?? ''}`;
});
await step('Email 2. A test email to the owner\'s own address is accepted by the provider', async () => {
  if (!emailReady) throw new Blocked('sending setup is not ready (see above)');
  if (process.env.SEND_TEST_EMAIL !== 'yes') throw new Blocked('not requested (run with send_test_email = yes)');
  await page.fill('#to', email);
  await Promise.all([page.waitForLoadState('load'), page.click('button:text-is("Send test")')]);
  const notice = await text(page.locator('.notice'));
  const error = await text(page.locator('.error'));
  assert(/accepted by the provider/.test(notice), error || notice || 'no result shown');
  return 'accepted by the provider; delivery is confirmed only when it arrives in the owner\'s inbox';
});

await browser.close();
console.log(`\n${failed} failed, ${blocked} blocked`);
process.exit(failed ? 1 : 0);
