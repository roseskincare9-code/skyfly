// Temporary branch only: live pixel check on Skyfly-hosted landing pages. Records which Meta / TikTok pixel
// IDs initialise and which events are sent; EVERY request to Meta / TikTok is blocked after being recorded,
// so nothing reaches any ad account. No order is placed.
import { chromium, devices } from 'playwright-core';
const BASE = 'https://getskyfly.com';
const SLUGS = ['larose-skincare', 'larosenigeria', 'exfoliating-3-in-1-combo'];
const browser = await chromium.launch();
for (const slug of SLUGS) {
  const cfg = await fetch(`${BASE}/api/public/pages/${slug}/tracking`).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
  const ids = (cfg.body?.pixels ?? []).map((p) => `${p.platform ?? p.type}:${p.pixelId ?? p.id ?? p.pixel_id}${p.events ? `[${p.events.join('/')}]` : ''}`);
  console.log(`CONFIG ${slug}: HTTP ${cfg.status}; configured pixels: ${ids.join(', ') || 'none'}; keys: ${cfg.body ? Object.keys(cfg.body).join(',') : '-'}`);
  console.log(`CONFIGRAW ${slug}: ${JSON.stringify(cfg.body).replace(/"(access_?token|token)[^,}]*/gi, '"<redacted>"').slice(0, 900)}`);
  const ctx = await browser.newContext(devices['Pixel 7']);
  const hits = [];
  await ctx.route(/facebook\.com\/tr|facebook\.net|analytics\.tiktok\.com|tiktok\.com\/i18n|business-api\.tiktok\.com/, (route) => {
    const u = new URL(route.request().url());
    if (/facebook\.com\/tr/.test(u.href)) hits.push(`META event=${u.searchParams.get('ev')} id=${u.searchParams.get('id')}`);
    else if (/fbevents\.js|signals\/config/.test(u.href)) hits.push(`META script ${u.pathname.split('/').slice(-1)[0]}${u.pathname.includes('config') ? ' id=' + u.pathname.split('/').pop() : ''}`);
    else hits.push(`TIKTOK ${u.pathname}${u.search.slice(0, 80)}`);
    // Let the Meta base script load (so init calls happen), block everything that would send data.
    if (/connect\.facebook\.net\/en_US\/fbevents\.js/.test(u.href)) return route.continue();
    return route.abort();
  });
  const page = await ctx.newPage();
  const errs = []; page.on('pageerror', (e) => errs.push(e.message));
  try {
    const r = await page.goto(`${BASE}/p/${slug}/`, { waitUntil: 'load', timeout: 60000 });
    await page.waitForTimeout(6000);
    const inits = await page.evaluate(() => {
      const q = window.fbq; const out = { fbqDefined: typeof q === 'function', ttqDefined: typeof window.ttq === 'object' };
      try { out.metaPixels = q && q.getState ? q.getState().pixels.map((p) => p.id) : null; } catch { out.metaPixels = 'n/a'; }
      try { out.ttqPixels = window.ttq && window.ttq._i ? Object.keys(window.ttq._i) : null; } catch { out.ttqPixels = 'n/a'; }
      return out;
    });
    console.log(`PAGE ${slug}: HTTP ${r.status()} title "${(await page.title()).slice(0, 60)}" fbq=${inits.fbqDefined} metaPixels=${JSON.stringify(inits.metaPixels)} ttq=${inits.ttqDefined} ttqPixels=${JSON.stringify(inits.ttqPixels)}`);
  } catch (e) { console.log(`PAGE ${slug}: ERROR ${String(e.message).split('\n')[0]}`); }
  const count = {}; for (const h of hits) count[h] = (count[h] || 0) + 1;
  console.log(`HITS ${slug}: ${Object.entries(count).map(([k, n]) => `${k}×${n}`).join(' | ') || 'none'}`);
  console.log(`ERRORS ${slug}: ${errs.join(' | ').slice(0, 300) || 'none'}`);
  await ctx.close();
}
await browser.close();
