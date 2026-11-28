// Live video playback check on the deployed Skyfly, as the restricted live-test owner of the labelled test
// business only (e2e-iso-new@skyfly.invalid). Uploads two tiny generated test videos (MP4 and WebM, a few
// KB, made by ffmpeg in the workflow) to that business's Creative Library, then:
//   M1. the file answers byte ranges (206 + Content-Range) as Safari on iPhone/iPad requires;
//   M2. the Creative Library shows an inline player that loads the video and can seek, in a real browser;
//   M3. another business's owner cannot fetch the file;
//   M4. both test files are deleted again.
// Prints no secrets.   SKYFLY_URL=… SKYFLY_OWNER_PASSWORD=… MP4=… WEBM=… node test/e2e/live-media.e2e.js
import { readFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';

const SKYFLY = (process.env.SKYFLY_URL || '').replace(/\/+$/, '');
if (!/^https:\/\/[a-z0-9-]+\.onrender\.com$|^https:\/\/getskyfly\.com$|^http:\/\/localhost:\d+$/.test(SKYFLY)) throw new Error('Set SKYFLY_URL');
const PASSWORD = process.env.SKYFLY_OWNER_PASSWORD;
if (!PASSWORD) throw new Error('No live-test sign-in: run this through the "Live onboarding readiness" workflow');
const FILES = { mp4: readFileSync(process.env.MP4), webm: readFileSync(process.env.WEBM) };
const RUN = String(process.env.GITHUB_RUN_ID || Date.now()).slice(-8);
const shots = path.resolve('live-screenshots'); mkdirSync(shots, { recursive: true });
let failed = 0;
const step = async (name, fn) => { try { const i = await fn(); console.log(`PASS  ${name}${i ? ` — ${i}` : ''}`); } catch (e) { failed += 1; console.log(`FAIL  ${name} — ${String(e.message).split('\n')[0].slice(0, 300)}`); } };
const ok = (c, m) => { if (!c) throw new Error(m); };

const browser = await chromium.launch();
async function signIn(email) {
  const p = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  await p.goto(`${SKYFLY}/login`);
  await p.fill('#email', email); await p.fill('#password', PASSWORD);
  await Promise.all([p.waitForLoadState('load'), p.click('main button[type=submit]')]);
  ok(!p.url().endsWith('/login'), `sign-in refused for ${email}`);
  return p;
}
const p = await signIn('e2e-iso-new@skyfly.invalid');
const biz = p.url().match(/\/businesses\/(\d+)/)?.[1];
const mb = `${SKYFLY}/businesses/${biz}/media-buyer`;
const ids = {};
try {
  for (const [ext, mime] of [['mp4', 'video/mp4'], ['webm', 'video/webm']]) {
    await p.goto(`${mb}?tab=creatives`);
    const name = `skyfly-media-check-${RUN}.${ext}`;
    const r = await p.request.post(`${mb}/creatives`, { maxRedirects: 0, multipart: {
      _csrf: await p.locator('input[name=_csrf]').first().inputValue(), kind: 'video', notes: 'Automated playback check (deleted after the test)',
      file: { name, mimeType: mime, buffer: FILES[ext] } } });
    ok(r.status() === 302, `upload ${ext} → HTTP ${r.status()}`);
    await p.goto(`${mb}?tab=creatives`);
    const href = await p.locator(`a:has-text("${name}")`).first().getAttribute('href');
    ids[ext] = href?.match(/creatives\/(\d+)\/file/)?.[1];
    ok(ids[ext], `${name} not listed after upload`);
  }

  await step('M1. Creative Library video answers byte ranges (206 Partial Content), as Safari on iPhone/iPad requires', async () => {
    const url = `${mb}/creatives/${ids.mp4}/file`;
    const whole = await p.request.get(url);
    ok(whole.status() === 200 && whole.headers()['accept-ranges'] === 'bytes', `no Range: HTTP ${whole.status()}, Accept-Ranges ${whole.headers()['accept-ranges']}`);
    const probe = await p.request.get(url, { headers: { Range: 'bytes=0-1' } });
    ok(probe.status() === 206 && probe.headers()['content-range'] === `bytes 0-1/${FILES.mp4.length}` && (await probe.body()).length === 2,
      `bytes=0-1 → HTTP ${probe.status()} ${probe.headers()['content-range']}`);
    const tail = await p.request.get(url, { headers: { Range: `bytes=${FILES.mp4.length - 100}-` } });
    ok(tail.status() === 206 && Buffer.compare(await tail.body(), FILES.mp4.subarray(FILES.mp4.length - 100)) === 0, `tail range → HTTP ${tail.status()} or wrong bytes`);
    return `${FILES.mp4.length}-byte MP4: 200 with Accept-Ranges; bytes=0-1 → 206 ${probe.headers()['content-range']}; tail bytes exact`;
  });

  await step('M2. The Creative Library\'s inline player loads the video and seeks, in a real browser', async () => {
    await p.goto(`${mb}?tab=creatives`);
    const v = p.locator(`video[data-creative-video][src$="/creatives/${ids.webm}/file"]`);
    ok(await v.count() === 1, 'no inline player for the uploaded video');
    const res = await v.evaluate(async (el) => {
      el.muted = true;
      if (el.readyState < 1) await new Promise((r, j) => { el.addEventListener('loadedmetadata', r, { once: true }); el.addEventListener('error', () => j(new Error(`media error ${el.error?.code}`)), { once: true }); el.load(); setTimeout(() => j(new Error('timeout loading metadata')), 20000); });
      const seeked = new Promise((r) => el.addEventListener('seeked', r, { once: true }));
      el.currentTime = Math.min(1.5, el.duration / 2); await seeked;
      return { duration: el.duration, at: el.currentTime, w: el.videoWidth, h: el.videoHeight };
    });
    ok(res.duration > 0 && res.at > 0 && res.w > 0, `duration ${res.duration}, seek ${res.at}, size ${res.w}×${res.h}`);
    await p.screenshot({ path: path.join(shots, 'creative-library-video.png'), fullPage: true });
    return `${res.w}×${res.h}, ${res.duration.toFixed(1)} s, seeked to ${res.at.toFixed(1)} s`;
  });

  await step('M3. Another business\'s owner cannot fetch this business\'s video', async () => {
    const other = await signIn('e2e-owner-a@skyfly.invalid');
    const aId = other.url().match(/\/businesses\/(\d+)/)?.[1];
    const cross = await other.request.get(`${mb}/creatives/${ids.mp4}/file`, { maxRedirects: 0 });
    const viaOwn = await other.request.get(`${SKYFLY}/businesses/${aId}/media-buyer/creatives/${ids.mp4}/file`, { maxRedirects: 0, headers: { Range: 'bytes=0-1' } });
    ok(cross.status() === 404 && viaOwn.status() === 404, `in business #${biz}: HTTP ${cross.status()}; via own business #${aId}: HTTP ${viaOwn.status()}`);
    return `business #${biz} path → 404; own business #${aId} with this file's ID (and a Range header) → 404`;
  });
} finally {
  await step('M4. The test videos are deleted again', async () => {
    for (const id of Object.values(ids).filter(Boolean)) {
      await p.goto(`${mb}?tab=creatives`);
      const r = await p.request.post(`${mb}/creatives/${id}/delete`, { form: { _csrf: await p.locator('input[name=_csrf]').first().inputValue() }, maxRedirects: 0 });
      ok(r.status() === 302, `delete #${id} → HTTP ${r.status()}`);
      ok((await p.request.get(`${mb}/creatives/${id}/file`, { maxRedirects: 0 })).status() === 404, `#${id} still served after delete`);
    }
    return `${Object.values(ids).filter(Boolean).length} file(s) deleted`;
  });
  await browser.close();
}
console.log(failed ? `\n${failed} check(s) FAILED` : '\nAll media checks passed');
process.exit(failed ? 1 : 0);
