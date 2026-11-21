// Temporary branch only: read-only live check of Larose's "skincare" pixel (1395209215400304).
// Loads each page once; every Meta / TikTok DATA beacon is recorded and then BLOCKED, so no event reaches
// Meta from this robot. No click, no form, no order.
import { chromium, devices } from 'playwright-core';
const BASE = 'https://getskyfly.com';
const SKIN = '1395209215400304';
const PAGES = [
  ['larose-skincare (Skyfly-hosted)', `${BASE}/p/larose-skincare/`, 'larose-skincare'],
  ['larosenigeria (GitHub Pages)', 'https://roseskincare9-code.github.io/Larosenigeria/', 'larosenigeria'],
];
const browser = await chromium.launch();
for (const [label, url, slug] of PAGES) {
  const cfg = await fetch(`${BASE}/api/public/pages/${slug}/tracking`).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
  const px = cfg.body?.pixels ?? [];
  console.log(`CONFIG ${label}: HTTP ${cfg.status}; ${px.length} pixels: ${px.map((p) => `${p.platform ?? p.type}:${p.pixelId ?? p.id}`).join(', ')}`);
  const s = px.find((p) => String(p.pixelId ?? p.id) === SKIN);
  console.log(`SKINCARE-CONFIG ${label}: ${s ? `assigned; events=${JSON.stringify(s.events)}` : 'NOT assigned'}`);
  const ctx = await browser.newContext(devices['Pixel 7']);
  const hits = [];
  await ctx.route(/facebook\.com\/tr|facebook\.net|analytics\.tiktok\.com|business-api\.tiktok\.com/, (route) => {
    const u = new URL(route.request().url());
    if (/connect\.facebook\.net/.test(u.href)) return route.continue(); // scripts only
    if (/facebook\.com\/tr/.test(u.href)) hits.push(`${u.searchParams.get('id')}:${u.searchParams.get('ev')}`);
    return route.abort(); // block every data beacon
  });
  const page = await ctx.newPage();
  const errs = []; page.on('pageerror', (e) => errs.push(e.message));
  try {
    const r = await page.goto(url, { waitUntil: 'load', timeout: 60000 });
    await page.waitForTimeout(7000);
    const ids = await page.evaluate(() => { try { return window.fbq?.getState?.().pixels.map((p) => p.id); } catch { return null; } });
    console.log(`PAGE ${label}: HTTP ${r.status()} metaPixelsInitialised=${JSON.stringify(ids)} skincareInitialised=${Array.isArray(ids) && ids.includes(SKIN)} duplicates=${Array.isArray(ids) && new Set(ids).size !== ids.length}`);
  } catch (e) { console.log(`PAGE ${label}: ERROR ${String(e.message).split('\n')[0]}`); }
  const count = {}; for (const h of hits) count[h] = (count[h] || 0) + 1;
  console.log(`BEACONS (blocked) ${label}: ${Object.entries(count).map(([k, n]) => `${k}x${n}`).join(' | ') || 'none'}`);
  console.log(`ERRORS ${label}: ${errs.join(' | ').slice(0, 300) || 'none'}`);
  await ctx.close();
}
await browser.close();
