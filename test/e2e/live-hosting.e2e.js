// Temporary branch only: real Android Chrome (Pixel 7 emulation, HTTP/2) page loads of the live site, plus
// an existing-account sign-in path check. No account is signed in; nothing is created.
import { chromium, devices } from 'playwright-core';
const urls = ['https://getskyfly.com/', 'https://getskyfly.com/login', 'https://getskyfly.com/signup', 'https://getskyfly.com/admin/login', 'https://getskyfly.com/pricing', 'https://skyfly-gybf.onrender.com/login'];
const browser = await chromium.launch();
for (const [label, dev] of [['Android Chrome (Pixel 7)', devices['Pixel 7']], ['Desktop Chrome', devices['Desktop Chrome']]]) {
  const ctx = await browser.newContext(dev);
  const page = await ctx.newPage();
  const errs = []; page.on('pageerror', (e) => errs.push(e.message)); page.on('requestfailed', (r) => errs.push(`${r.url().slice(0, 80)} ${r.failure()?.errorText}`));
  for (const u of urls) {
    const t0 = Date.now();
    try {
      const r = await page.goto(u, { waitUntil: 'load', timeout: 45000 });
      const proto = await r.request().headerValue(':scheme').catch(() => null);
      console.log(`LOAD ${label} ${u} → HTTP ${r.status()} final ${page.url()} (${Date.now() - t0} ms) title "${(await page.title()).slice(0, 60)}"; form fields: ${await page.locator('input:visible').count()}`);
    } catch (e) { console.log(`LOAD ${label} ${u} → ERROR ${String(e.message).split('\n')[0]}`); }
  }
  // Existing login: a wrong password is refused normally (the login route and session/CSRF work).
  try {
    await page.goto('https://getskyfly.com/login');
    await page.fill('input[name="email"]', 'nobody@skyfly.invalid'); await page.fill('input[name="password"]', 'not-the-password');
    const [resp] = await Promise.all([page.waitForResponse((r) => r.url().endsWith('/login') && r.request().method() === 'POST'), page.click('button[type="submit"]')]);
    console.log(`LOGIN ${label}: POST /login with a wrong password → HTTP ${resp.status()} (expected 401: the sign-in route works)`);
  } catch (e) { console.log(`LOGIN ${label}: ERROR ${String(e.message).split('\n')[0]}`); }
  console.log(`ERRORS ${label}: ${errs.length ? errs.slice(0, 6).join(' | ') : 'none'}`);
  await ctx.close();
}
await browser.close();
