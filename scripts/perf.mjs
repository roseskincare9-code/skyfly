// Repeatable page-speed measurement in Chromium (Playwright), for comparing before/after.
//   node scripts/perf.mjs "<label>|<url>|<css selector to tap for INP>" ...  [RUNS=3]
// Profiles:
//   mobile  — Pixel 5 viewport, CPU 4x slower, network 150 ms RTT / 1.6 Mbps down / 0.75 Mbps up ("Slow 4G")
//   desktop — 1366x768, no CPU or network throttling (the test machine's own connection)
// Each profile is measured with an empty cache ("cold") and again on a return visit ("warm"); the
// median of RUNS runs is reported. Meta/TikTok requests are blocked so no test visits reach
// the ad platforms. INP is the slowest interaction from one tap on the given element.
import { writeFileSync } from 'node:fs';
import { chromium, devices } from 'playwright-core';

const RUNS = Number(process.env.RUNS || 3);
const targets = process.argv.slice(2).map((a) => { const [label, url, tap] = a.split('|'); return { label, url, tap }; });
if (!targets.length) { console.error('Usage: node scripts/perf.mjs "label|url|selector" ...'); process.exit(1); }

const PROFILES = {
  mobile: { context: { ...devices['Pixel 5'] }, cpu: 4, net: { latency: 150, downloadThroughput: (1.6 * 1024 * 1024) / 8, uploadThroughput: (750 * 1024) / 8 } },
  desktop: { context: { viewport: { width: 1366, height: 768 } }, cpu: 1, net: null },
};

const OBSERVE = () => {
  window.__perf = { lcp: 0, cls: 0, inp: 0 };
  new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__perf.lcp = e.startTime; }).observe({ type: 'largest-contentful-paint', buffered: true });
  new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) window.__perf.cls += e.value; }).observe({ type: 'layout-shift', buffered: true });
  new PerformanceObserver((l) => { for (const e of l.getEntries()) if (e.interactionId) window.__perf.inp = Math.max(window.__perf.inp, e.duration); })
    .observe({ type: 'event', buffered: true, durationThreshold: 16 });
};

async function measureOnce(browser, profile, target) {
  const p = PROFILES[profile];
  const ctx = await browser.newContext(p.context);
  await ctx.route(/^https:\/\/([a-z0-9-]+\.)*(facebook\.(com|net)|tiktok\.com|tiktokw\.us)\//, (r) => r.abort());
  await ctx.addInitScript(OBSERVE);
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Network.enable');
  if (p.cpu > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: p.cpu });
  if (p.net) await cdp.send('Network.emulateNetworkConditions', { offline: false, ...p.net });
  let bytes = 0; let requests = 0;
  cdp.on('Network.loadingFinished', (e) => { bytes += e.encodedDataLength; requests += 1; });

  const results = {};
  for (const cache of ['cold', 'warm']) {
    bytes = 0; requests = 0;
    const started = Date.now();
    if (cache === 'cold') await page.goto(target.url, { waitUntil: 'load', timeout: 120000 });
    else await page.goto(target.url, { waitUntil: 'load', timeout: 120000 }); // a return visit
    const loadWall = Date.now() - started;
    await page.waitForTimeout(2500); // late layout shifts, lazy content
    const nav = await page.evaluate(() => {
      const n = performance.getEntriesByType('navigation')[0];
      const fcp = performance.getEntriesByName('first-contentful-paint')[0];
      return { ttfb: n.responseStart, fcp: fcp ? fcp.startTime : null, dcl: n.domContentLoadedEventEnd, load: n.loadEventEnd };
    });
    let inp = null;
    if (target.tap) {
      const el = page.locator(target.tap).first();
      try {
        await el.scrollIntoViewIfNeeded({ timeout: 15000 });
        await page.waitForTimeout(500);
        await el.click({ timeout: 15000 });
        await page.waitForTimeout(800);
        inp = await page.evaluate(() => window.__perf.inp);
      } catch { inp = null; }
    }
    // Scroll through the page so shifts from lazy content count in CLS.
    await page.evaluate(async () => { for (let y = 0; y < document.body.scrollHeight; y += 600) { window.scrollTo(0, y); await new Promise((r) => setTimeout(r, 120)); } });
    await page.waitForTimeout(800);
    const perf = await page.evaluate(() => window.__perf);
    results[cache] = { ...nav, lcp: perf.lcp, cls: perf.cls, inp, loadWall, bytes, requests };
  }
  await ctx.close();
  return results;
}

const median = (xs) => { const v = xs.filter((x) => x !== null && x !== undefined).sort((a, b) => a - b); return v.length ? v[Math.floor(v.length / 2)] : null; };
const browser = await chromium.launch();
const report = [];
for (const target of targets) {
  for (const profile of Object.keys(PROFILES)) {
    const runs = [];
    for (let i = 0; i < RUNS; i += 1) runs.push(await measureOnce(browser, profile, target));
    for (const cache of ['cold', 'warm']) {
      const pick = (k) => median(runs.map((r) => r[cache][k]));
      report.push({ page: target.label, url: target.url, profile, cache, lcp: pick('lcp'), cls: pick('cls'), inp: pick('inp'), ttfb: pick('ttfb'), fcp: pick('fcp'), load: pick('load'), kb: pick('bytes') / 1024, requests: pick('requests') });
    }
  }
}
await browser.close();

const ms = (v) => (v === null ? 'n/a' : `${Math.round(v)} ms`);
console.log(`\nMedian of ${RUNS} runs. mobile = Pixel 5, CPU 4x slower, 150 ms RTT, 1.6 Mbps down; desktop = no throttling. Meta/TikTok blocked.\n`);
console.log('| Page | Profile | Cache | LCP | CLS | INP (1 tap) | TTFB | FCP | Load | Transferred | Requests |');
console.log('|---|---|---|---|---|---|---|---|---|---|---|');
for (const r of report) {
  console.log(`| ${r.page} | ${r.profile} | ${r.cache} | ${ms(r.lcp)} | ${r.cls === null ? 'n/a' : r.cls.toFixed(3)} | ${ms(r.inp)} | ${ms(r.ttfb)} | ${ms(r.fcp)} | ${ms(r.load)} | ${Math.round(r.kb)} KB | ${r.requests} |`);
}
writeFileSync('perf-results.json', JSON.stringify({ at: new Date().toISOString(), runs: RUNS, report }, null, 1));
