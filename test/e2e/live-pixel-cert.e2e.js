// Live certification of dashboard pixel installation with two separate test businesses on the deployed
// Skyfly: owner A (Skyfly Demo Shop) and owner B (Skyfly Import Test) each add their own Meta pixel ID in
// Tracking & Pixels (no code, no redeploy). Then, in a real browser with Meta's real pixel script:
// each published page loads only its own business's ID, once; PageView and ViewContent on load;
// InitiateCheckout when the order form starts; no Lead/Purchase for a failed save; Lead and Purchase
// once after a saved order (the order reply is simulated: NO order is created); never again on repeat.
// Every pixel hit is intercepted and counted, never sent to Meta. Dashboard statuses are checked at each
// stage (Saved → Installed; never "Receiving events" without the platform accepting an event).
// Both IDs are removed at the end.
//
//   SKYFLY_URL=https://<service>.onrender.com SKYFLY_OWNER_PASSWORD=… node test/e2e/live-pixel-cert.e2e.js
import { mkdirSync } from 'node:fs';
import { chromium, devices } from 'playwright-core';

const SKYFLY = (process.env.SKYFLY_URL || '').replace(/\/+$/, '');
if (!/^https:\/\/[a-z0-9-]+\.onrender\.com$|^https:\/\/getskyfly\.com$|^http:\/\/localhost:\d+$/.test(SKYFLY) || /\/\/skyfly\.onrender\.com/.test(SKYFLY)) throw new Error('Set SKYFLY_URL to the verified Skyfly service address');
const PASSWORD = process.env.SKYFLY_OWNER_PASSWORD;
if (!PASSWORD) throw new Error('No live-test sign-in: run this through the "Live import test" workflow');
const n = String(process.env.GITHUB_RUN_ID || Date.now()).slice(-6).padStart(6, '0');
const BIZ = {
  A: { owner: 'e2e-owner-a@skyfly.invalid', slug: 'skyfly-demo', id: `97${n}00000001` },
  B: { owner: 'e2e-owner-b@skyfly.invalid', slug: 'skyfly-import-test', id: `97${n}00000002` },
};
mkdirSync('live-screenshots', { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
async function step(name, fn) {
  try { const info = await fn(); console.log(`PASS  ${name}${info ? ` — ${info}` : ''}`); return true; }
  catch (err) { failed += 1; console.log(`FAIL  ${name} — ${String(err.message).split('\n')[0]}`); return false; }
}
const assert = (c, m) => { if (!c) throw new Error(m); };
async function submit(p, target) {
  const from = p.url();
  await Promise.all([p.waitForURL((u) => u.toString() !== from, { waitUntil: 'load' }), p.click(target)]);
}

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
async function signIn(email) {
  const p = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  p.setDefaultTimeout(20000);
  await p.goto(`${SKYFLY}/login`);
  await p.fill('#email', email); await p.fill('#password', PASSWORD);
  await submit(p, 'main button[type=submit]');
  assert(/\/businesses\/\d+/.test(p.url()), `sign-in for ${email} landed on ${p.url()}`);
  return p;
}
const config = async (slug) => (await (await fetch(`${SKYFLY}/api/public/pages/${slug}/tracking`)).json()).pixels;
async function status(b) {
  await b.dash.goto(`${SKYFLY}/businesses/${b.biz}/pixels?platform=meta`);
  const row = b.dash.locator(`tr[data-pixel="${b.id}"] [data-status]`);
  return { key: await row.getAttribute('data-status'), text: (await row.textContent()).replace(/\s+/g, ' ').trim() };
}

// A phone visitor whose Meta pixel hits are counted, never sent.
async function visitor() {
  const ctx = await browser.newContext({ ...devices['iPhone 13'] });
  const hits = []; const seen = [];
  await ctx.route(/https:\/\/([a-z0-9-]+\.)*facebook\.com\//, (route) => {
    const r = route.request(); const u = new URL(r.url());
    if (!/\/tr\/?$/.test(u.pathname)) return route.continue();
    let text = `${u.search} ${r.postData() || ''}`;
    try { text = decodeURIComponent(text.replace(/\+/g, ' ')); } catch { /* keep */ }
    const field = (k) => { const e = k.replace(/[[\]]/g, '\\$&'); return text.match(new RegExp(`[?&\\s]${e}=([^&\\s]+)`))?.[1] ?? text.match(new RegExp(`name="${e}"\\r?\\n\\r?\\n([^\\r\\n]+)`))?.[1] ?? null; };
    hits.push({ id: field('id'), ev: field('ev'), eid: field('eid'), value: field('cd[value]'), currency: field('cd[currency]') });
    return route.fulfill({ status: 200, contentType: 'image/gif', body: '' });
  });
  await ctx.route(`${SKYFLY}/api/public/pixels-seen`, async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    const s = { body: route.request().postData() || '', status: null }; seen.push(s);
    const res = await route.fetch(); s.status = res.status(); return route.fulfill({ response: res });
  });
  const page = await ctx.newPage();
  const count = (id, ev, from = 0) => hits.slice(from).filter((h) => h.id === id && h.ev === ev).length;
  const summary = (from = 0) => [...new Set(hits.slice(from).map((h) => `${h.id}:${h.ev}`))].map((k) => { const [id, ev] = k.split(':'); return `${id} ${ev}×${count(id, ev, from)}`; }).join(', ') || 'none';
  return { ctx, page, hits, seen, count, summary };
}
const waitFor = async (fn, ms = 20000) => { for (let i = 0; i < ms / 250 && !fn(); i += 1) await sleep(250); };

try {
  await step('C1. Each owner opens their own Tracking & Pixels and adds their own Meta pixel ID (all pages) — no code, no redeploy', async () => {
    for (const [k, b] of Object.entries(BIZ)) {
      b.dash = await signIn(b.owner);
      b.biz = b.dash.url().match(/\/businesses\/(\d+)/)[1];
      await b.dash.goto(`${SKYFLY}/businesses/${b.biz}/pixels/new?platform=meta`);
      await b.dash.fill('#name', `Certification ${k}`);
      await b.dash.fill('#pixel_id', b.id);
      await b.dash.check('input[name=all_pages]');
      await submit(b.dash, '[data-tracking-form] button[type=submit]');
      assert(/done=added/.test(b.dash.url()), `${k}: not added (${b.dash.url()})`);
      b.added = true;
    }
    return `A (business #${BIZ.A.biz}) → ${BIZ.A.id}; B (business #${BIZ.B.biz}) → ${BIZ.B.id}`;
  });

  await step('C2. Right after saving: status "Saved" (waiting for the first visit) — not Installed, not Receiving events', async () => {
    const out = [];
    for (const [k, b] of Object.entries(BIZ)) {
      const s = await status(b);
      assert(s.key === 'saved', `${k}: ${s.key} (${s.text})`);
      assert(!/Receiving events|Verified/.test(s.text), `${k}: ${s.text}`);
      out.push(`${k}: ${s.text}`);
    }
    return out.join(' | ');
  });

  await step("C3. Each published page's tracking config lists only its own business's new ID, once", async () => {
    const out = [];
    for (const [k, b] of Object.entries(BIZ)) {
      const other = k === 'A' ? BIZ.B : BIZ.A;
      const ids = (await config(b.slug)).map((p) => p.id);
      assert(ids.filter((x) => x === b.id).length === 1, `${k} page: own ID ×${ids.filter((x) => x === b.id).length}`);
      assert(!ids.includes(other.id), `${k} page lists the other business's ID`);
      out.push(`/p/${b.slug}/: ${ids.join(', ')}`);
    }
    return out.join(' | ');
  });

  for (const [k, b] of Object.entries(BIZ)) {
    const other = k === 'A' ? BIZ.B : BIZ.A;
    await step(`C4-${k}. Browser on ${k}'s published page: its ID loads once (one pixel script), PageView ×1 and ViewContent ×1; the other business's ID never appears; the page reports "Tag loaded"`, async () => {
      const v = await visitor();
      b.visit = v;
      await v.page.goto(`${SKYFLY}/p/${b.slug}/?cert=${n}`, { waitUntil: 'load' });
      await waitFor(() => v.count(b.id, 'PageView') >= 1 && v.count(b.id, 'ViewContent') >= 1);
      await sleep(3000);
      assert(v.count(b.id, 'PageView') === 1, `PageView ×${v.count(b.id, 'PageView')} (${v.summary()})`);
      assert(v.count(b.id, 'ViewContent') === 1, `ViewContent ×${v.count(b.id, 'ViewContent')} (${v.summary()})`);
      assert(!v.hits.some((h) => h.id === other.id), `the other business's ID fired: ${v.summary()}`);
      for (const ev of ['InitiateCheckout', 'Lead', 'Purchase']) assert(v.count(b.id, ev) === 0, `${ev} on load`);
      const scripts = await v.page.evaluate(() => [...document.scripts].filter((s) => /fbevents\.js/.test(s.src)).length);
      assert(scripts === 1, `fbevents.js script tags: ${scripts}`);
      const inits = await v.page.evaluate(() => (window.__SKYFLY__?.pixels || []).map((p) => p.id));
      await waitFor(() => v.seen.some((s) => s.body.includes(`"${b.id}"`) && s.status !== null), 15000);
      assert(v.seen.some((s) => s.body.includes(`"${b.id}"`) && s.status === 200), `"Tag loaded" not accepted: ${JSON.stringify(v.seen.map((s) => s.status))}`);
      return `${v.summary()}; page config: ${inits.join(', ')}; 1 pixel script; "Tag loaded" accepted (HTTP 200)`;
    });
  }

  await step('C5. After the visits: both IDs show "Installed" in their own dashboards (still not "Receiving events")', async () => {
    const out = [];
    for (const [k, b] of Object.entries(BIZ)) {
      let s;
      for (let i = 0; i < 10; i += 1) { s = await status(b); if (s.key === 'installed') break; await sleep(2000); }
      assert(s.key === 'installed', `${k}: ${s.key} (${s.text})`);
      out.push(`${k}: ${s.text}`);
    }
    return out.join(' | ');
  });

  const A = BIZ.A; const v = A.visit;
  let mode = 'fail'; let ref = `DM-CERT${n.slice(-4)}`;
  await v.page.route(`${SKYFLY}/api/public/orders`, (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    const headers = { 'Access-Control-Allow-Origin': 'null' };
    if (mode === 'fail') return route.fulfill({ status: 500, contentType: 'application/json', headers, body: '{"ok":false,"message":"We could not save your order. Please try again in a moment."}' });
    return route.fulfill({ status: mode === 'replayed' ? 200 : 201, contentType: 'application/json', headers,
      body: JSON.stringify({ ok: true, saved: true, reference: ref, business: 'skyfly-demo', purchaseEventId: `purchase_${ref}`, total: 22000, currency: 'NGN', items: [], confirmationUrl: `${SKYFLY}/o/${ref}?t=simulated`, replayed: mode === 'replayed', test: false }) });
  });
  const fill = async () => {
    await v.page.waitForSelector('.sky-opt');
    await v.page.locator('.sky-opt').nth(1).click();
    await v.page.fill('#sky-name', 'Pixel Certification (simulated, no order)'); await v.page.fill('#sky-phone', '08012345678');
    await v.page.fill('#sky-address', 'TEST - simulated reply, no order is created'); await v.page.fill('#sky-state', 'Lagos');
    await v.page.click('text=Review my order');
  };

  await step("C6. A's order form: InitiateCheckout ×1; a failed save sends no Lead and no Purchase", async () => {
    await fill();
    await waitFor(() => v.count(A.id, 'InitiateCheckout') >= 1);
    await v.page.click('text=Place my order');
    await v.page.waitForSelector('[data-err]:not([hidden])', { timeout: 30000 });
    await sleep(2000);
    assert(v.count(A.id, 'InitiateCheckout') === 1, `InitiateCheckout ×${v.count(A.id, 'InitiateCheckout')}`);
    assert(v.count(A.id, 'Lead') === 0 && v.count(A.id, 'Purchase') === 0, `after a failed save: ${v.summary()}`);
    return v.summary();
  });

  let afterSave;
  await step('C7. Saved-order reply (simulated, nothing created): Lead ×1 and Purchase ×1 with the saved total and event ID purchase_<reference>; B\'s ID gets nothing', async () => {
    mode = 'saved';
    await v.page.click('text=Place my order');
    await v.page.waitForSelector('.sky-ok', { timeout: 60000 });
    await waitFor(() => v.count(A.id, 'Purchase') >= 1);
    await sleep(2500);
    const p = v.hits.filter((h) => h.id === A.id && h.ev === 'Purchase');
    assert(v.count(A.id, 'Lead') === 1, `Lead ×${v.count(A.id, 'Lead')}`);
    assert(p.length === 1, `Purchase ×${p.length}`);
    assert(p[0].eid === `purchase_${ref}` && Number(p[0].value) === 22000 && p[0].currency === 'NGN', JSON.stringify(p[0]));
    assert(!v.hits.some((h) => h.id === BIZ.B.id), "B's ID fired on A's page");
    afterSave = v.hits.length;
    await v.page.screenshot({ path: 'live-screenshots/pixel-cert-saved.png' });
    return v.summary();
  });

  await step('C8. Refresh and the same order again (replayed): no second Lead or Purchase', async () => {
    await v.page.reload({ waitUntil: 'load' });
    mode = 'replayed';
    await fill();
    await v.page.click('text=Place my order');
    await v.page.waitForSelector('.sky-ok', { timeout: 60000 });
    await sleep(2500);
    assert(v.count(A.id, 'Purchase', afterSave) === 0 && v.count(A.id, 'Lead', afterSave) === 0, `after repeat: ${v.summary(afterSave)}`);
    return `after repeat: ${v.summary(afterSave)}`;
  });
} catch (err) {
  failed += 1; console.log(`FAIL  ${err.message}`);
} finally {
  await step('C9. Both certification IDs removed; each page is back to its previous pixels', async () => {
    const out = [];
    for (const [k, b] of Object.entries(BIZ)) {
      if (!b.added || !b.dash) continue;
      await b.dash.goto(`${SKYFLY}/businesses/${b.biz}/pixels?platform=meta`);
      const href = await b.dash.locator(`tr[data-pixel="${b.id}"] a:has-text("Remove")`).getAttribute('href');
      await b.dash.goto(SKYFLY + href);
      await b.dash.fill('#confirm', b.id);
      await submit(b.dash, 'button:has-text("Remove tracking ID")');
      const ids = (await config(b.slug)).map((p) => p.id);
      assert(!ids.includes(b.id), `${k}: still on the page`);
      out.push(`${k}: ${ids.join(', ') || 'no pixels'}`);
    }
    return out.join(' | ');
  });
  await browser.close();
}
console.log(failed ? `\n${failed} check(s) failed` : '\nPixel certification checks passed (no order created; pixel hits intercepted, not sent to Meta)');
process.exit(failed ? 1 : 0);
