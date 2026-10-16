// Read-only: loads the live Larose page and reports what the Meta Pixel does (no form is submitted).
// Pixel event hits are intercepted, so nothing is sent to Meta.
import { chromium } from 'playwright-core';
const PAGE = 'https://roseskincare9-code.github.io/Larosenigeria/';
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' });
const seen = [];
await ctx.route('**/*', (route) => {
  const u = new URL(route.request().url());
  if (/facebook|fbcdn|tiktok/.test(u.host)) {
    seen.push(`${route.request().method()} ${u.host}${u.pathname} ev=${u.searchParams.get('ev') || (route.request().postData() || '').match(/ev=([A-Za-z]+)/)?.[1] || ''}`);
    if (/\/tr\/?$/.test(u.pathname)) return route.fulfill({ status: 200, contentType: 'image/gif', body: '' });
  }
  return route.continue();
});
const page = await ctx.newPage();
page.on('console', (m) => { if (/fb|pixel|meta/i.test(m.text())) console.log('console:', m.text().slice(0, 200)); });
await page.goto(PAGE, { waitUntil: 'networkidle' });
await page.waitForTimeout(5000);
console.log('fbq on page:', await page.evaluate(() => typeof window.fbq === 'function' ? `loaded=${window.fbq.loaded} version=${window.fbq.version} queue=${(window.fbq.queue || []).length}` : 'missing'));
console.log('Pixel code in page HTML:', await page.evaluate(() => [...document.scripts].filter((s) => s.text.includes('fbq(')).map((s) => s.text.replace(/\s+/g, ' ').slice(0, 160)).join(' || ')));
console.log('Meta/TikTok requests:', seen.length ? '\n  ' + seen.join('\n  ') : 'none');
await browser.close();
