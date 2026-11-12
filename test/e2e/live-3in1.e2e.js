// Live check of the owner's 3-in-1 page on production (/p/exfoliating-3-in-1-combo/), phone and desktop:
// the page loads as supplied (headline, ₦ prices, images); its own order form saves ONE clearly labelled
// TEST ORDER each (marked test: not counted as sales) and Skyfly's confirmation page names the business
// the order was saved in. Screenshots in live-screenshots/.
//   SKYFLY_URL=https://getskyfly.com node test/e2e/live-3in1.e2e.js
import { mkdirSync } from 'node:fs';
import { chromium, devices } from 'playwright-core';

const SKYFLY = (process.env.SKYFLY_URL || 'https://getskyfly.com').replace(/\/+$/, '');
const PAGE = `${SKYFLY}/p/exfoliating-3-in-1-combo/`;
const BUSINESS = '3 in 1 Exfoliating package';
mkdirSync('live-screenshots', { recursive: true });
let failed = 0;
const step = async (name, fn) => {
  try { const info = await fn(); console.log(`PASS  ${name}${info ? ` — ${info}` : ''}`); }
  catch (err) { failed += 1; console.log(`FAIL  ${name} — ${String(err.message).split('\n')[0].slice(0, 400)}`); }
};
const ok = (c, m) => { if (!c) throw new Error(m); };

const browser = await chromium.launch();
try {
  for (const [label, opts, pkg, addon, total] of [
    ['phone (iPhone 13)', devices['iPhone 13'], 'combo2', true, '₦131,000'],
    ['desktop (1366×900)', { viewport: { width: 1366, height: 900 } }, 'combo1', false, '₦59,500'],
  ]) {
    const ctx = await browser.newContext(opts);
    const page = await ctx.newPage();
    const errors = []; page.on('pageerror', (e) => errors.push(e.message));
    const tag = label.split(' ')[0];
    await step(`${label}: ${PAGE} loads as supplied`, async () => {
      const res = await page.goto(PAGE, { waitUntil: 'load', timeout: 90000 });
      ok(res.status() === 200, `HTTP ${res.status()}`);
      await page.waitForSelector('#priceGrid .pkg', { timeout: 20000 });
      const t = await page.textContent('body');
      ok(/Tried Everything and Nothing Works\?/.test(t), 'headline missing');
      for (const p of ['₦59,500', '₦109,000', '₦168,500']) ok(t.includes(p), `${p} missing`);
      ok((await page.$eval('#heroFrame img', (i) => i.naturalWidth)) > 0, 'hero image did not load');
      await page.screenshot({ path: `live-screenshots/3in1-${tag}-top.png` });
      return `HTTP 200, headline and ₦ prices shown, hero image loaded`;
    });
    await step(`${label}: TEST ORDER through the page's own form (${pkg}${addon ? ' + Complete Facial Set' : ''})`, async () => {
      await page.click(`#pickList label[data-id="${pkg}"]`);
      if (addon) await page.check('#bumpChk');
      await page.fill('#fullName', `TEST ORDER Skyfly live check ${tag}`);
      await page.fill('#address', 'Test only, do not deliver, 1 Test Street, Ikeja, Lagos');
      await page.fill('#phone', '08000000000');
      await Promise.all([page.waitForURL(/\/o\/[A-Z0-9-]+\?t=/, { timeout: 60000 }), page.click('#submitBtn')]);
      await page.waitForSelector('#ref');
      const ref = (await page.textContent('#ref')).trim();
      const body = await page.textContent('body');
      ok(body.includes(BUSINESS), `confirmation does not name "${BUSINESS}"`);
      ok(body.includes(total), `total ${total} not shown`);
      await page.screenshot({ path: `live-screenshots/3in1-${tag}-confirmation.png`, fullPage: true });
      return `order ${ref} saved in "${BUSINESS}", total ${total} (marked test)`;
    });
    if (errors.length) { failed += 1; console.log(`FAIL  ${label}: page script errors: ${errors.join(' | ').slice(0, 300)}`); }
    await ctx.close();
  }
} finally { await browser.close(); }
console.log(failed ? `\n${failed} check(s) FAILED` : '\nAll 3-in-1 live checks passed');
process.exit(failed ? 1 : 0);
