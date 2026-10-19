// Page speed: image priority/lazy loading, reserved image space, WebP sizes, versioned
// long-cached assets, gzip, deferred ad scripts.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { setup, resetDatabase, signUp } from './helpers.js';
import { optimizeHtml, optimizeCss } from '../src/hosting/speed.js';
import { optimizeVersion, optimizePublished } from '../src/hosting/images.js';
import { ensureDemoSite } from '../src/services/setup.js';

const { pool, app } = setup({ pagesBaseUrl: '' });
let demoVersion;

before(async () => {
  await resetDatabase(pool);
  await signUp(app, { email: 'owner@larose.test' });
  await ensureDemoSite(pool, { demoSite: true }, { log() {} });
  demoVersion = (await pool.query("SELECT published_version_id AS v FROM landing_pages WHERE slug = 'skyfly-demo'")).rows[0].v;
});
after(() => pool.end());

describe('HTML changes', () => {
  const meta = { 'img/hero.jpg': { w: 1600, h: 1000, variants: [{ w: 480, path: '_skyfly/img/a-480.webp' }, { w: 1600, path: '_skyfly/img/a-1600.webp' }] }, 'img/b.png': { w: 300, h: 300, variants: [] } };
  const html = `<link rel="stylesheet" href="css/s.css"><link rel="canonical" href="page.html"><script src="js/a.js"></script>
<img src="img/hero.jpg" alt="x"><img src="img/b.png" style="border:0"><img src="https://cdn.example/x.jpg"><img src="img/c.jpg" loading="eager" width="10" height="10">
<a href="other.html">link</a>`;
  const out = optimizeHtml(html, { meta, filePath: 'index.html', versionId: 7 });

  test('the first image is high priority; later ones load lazily (unless the page says otherwise)', () => {
    assert.match(out, /<img src="img\/hero\.jpg\?v=7" alt="x" fetchpriority="high"/);
    assert.match(out, /<img src="img\/b\.png\?v=7" style="border:0;aspect-ratio:300\/300" loading="lazy" decoding="async">/);
    assert.match(out, /<img src="img\/c\.jpg\?v=7" loading="eager" width="10" height="10" decoding="async">/);
  });
  test('space is reserved from the real image size, and WebP sizes are offered with the original as fallback', () => {
    assert.match(out, /aspect-ratio:1600\/1000/);
    assert.match(out, /srcset="_skyfly\/img\/a-480\.webp\?v=7 480w, _skyfly\/img\/a-1600\.webp\?v=7 1600w" sizes="100vw"/);
  });
  test('the page\'s own CSS, JS and images get versioned URLs; links and other sites are untouched', () => {
    assert.match(out, /href="css\/s\.css\?v=7"/);
    assert.match(out, /src="js\/a\.js\?v=7"/);
    assert.match(out, /rel="canonical" href="page\.html"/);
    assert.match(out, /src="https:\/\/cdn\.example\/x\.jpg"/);
    assert.match(out, /<a href="other\.html">/);
    assert.equal(optimizeCss('a{background:url("../img/bg.jpg")} b{background:url(data:image/png;base64,AA)}', 7),
      'a{background:url("../img/bg.jpg?v=7")} b{background:url(data:image/png;base64,AA)}');
  });
});

describe('served pages', () => {
  test('published images get WebP sizes once, smaller than the original', async () => {
    assert.equal(await optimizePublished(pool, { error() {} }), 1);
    assert.equal(await optimizePublished(pool, { error() {} }), 0, 'done once');
    const meta = await optimizeVersion(pool, demoVersion);
    assert.deepEqual([meta['hero.jpg'].w, meta['hero.jpg'].h], [1600, 1067]);
    const widths = meta['hero.jpg'].variants.map((v) => v.w);
    assert.deepEqual(widths, [480, 828, 1200, 1600]);
    const { rows } = await pool.query("SELECT path, size FROM page_files WHERE version_id = $1 AND (path = 'hero.jpg' OR path LIKE '_skyfly/%') ORDER BY size", [demoVersion]);
    const original = rows.find((r) => r.path === 'hero.jpg').size;
    const small = rows.find((r) => r.path.endsWith('-480.webp')).size;
    assert.ok(small < original / 10, `480px WebP ${small} B vs original ${original} B`);
  });

  test('the page is served gzipped, with the image changes, and pinned files are cached for a year', async () => {
    const page = await request(app).get('/p/skyfly-demo/').set('Accept-Encoding', 'gzip').expect(200);
    assert.equal(page.headers['content-encoding'], 'gzip');
    assert.equal(page.headers['cache-control'], 'no-cache', 'HTML is always checked, so a new version shows at once');
    assert.match(page.text, new RegExp(`<img src="hero\\.jpg\\?v=${demoVersion}" alt="Glow Demo Serum bottle" fetchpriority="high" style="aspect-ratio:1600/1067" srcset="_skyfly/img/[0-9a-f]{10}-480\\.webp\\?v=${demoVersion} 480w`));
    assert.match(page.text, /product-1\.jpg\?v=\d+" alt="Glow Demo Serum" loading="lazy" decoding="async"/);
    const variant = page.text.match(/srcset="([^ ]+) 480w/)[1];
    const img = await request(app).get(`/p/skyfly-demo/${variant}`).expect(200);
    assert.equal(img.headers['content-type'], 'image/webp');
    assert.equal(img.headers['cache-control'], 'public, max-age=31536000, immutable');
    const unpinned = await request(app).get('/p/skyfly-demo/hero.jpg').expect(200);
    assert.equal(unpinned.headers['cache-control'], 'public, max-age=300');
    const sdk = await request(app).get('/sdk/skyfly.js').set('Accept-Encoding', 'gzip').expect(200);
    assert.equal(sdk.headers['content-encoding'], 'gzip', 'the SDK too (files under 1 KB are sent as they are)');
  });

  test('ad platform scripts load after the page, with events queued (none lost)', async () => {
    const sdk = await request(app).get('/sdk/skyfly.js').expect(200);
    assert.match(sdk.text, /later\(function \(\) \{ addScript\('https:\/\/connect\.facebook\.net\/en_US\/fbevents\.js'\); \}\)/);
    assert.match(sdk.text, /window\.addEventListener\('load', go\)/);
  });

  test('dashboard fonts are served by Skyfly and cached for a year', async () => {
    const login = await request(app).get('/login').expect(200);
    assert.doesNotMatch(login.text, /fonts\.googleapis\.com/);
    const font = await request(app).get('/static/fonts/dm-sans-v17-latin.woff2').expect(200);
    assert.match(font.headers['cache-control'], /max-age=31536000, immutable/);
  });
});

describe('image safety', () => {
  test('files named .png/.jpg that are not real JPEG or PNG images are never given to the image library', async () => {
    const { rows: [{ landing_page_id: pageId }] } = await pool.query('SELECT landing_page_id FROM page_versions WHERE id = $1', [demoVersion]);
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="4000" height="4000"><rect width="100%" height="100%"/></svg>'.padEnd(30000, ' '));
    const { createHash } = await import('node:crypto');
    const sha = createHash('sha256').update(svg).digest('hex');
    const { rows: [v] } = await pool.query("INSERT INTO page_versions (landing_page_id, source_name, entry_path, file_count, total_bytes) VALUES ($1, 'fake', 'index.html', 1, $2) RETURNING id", [pageId, svg.length]);
    await pool.query('INSERT INTO page_blobs (sha256, size, data) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [sha, svg.length, svg]);
    await pool.query("INSERT INTO page_files (version_id, path, content_type, size, sha256) VALUES ($1, 'fake.png', 'image/png', $2, $3)", [v.id, svg.length, sha]);
    const meta = await optimizeVersion(pool, v.id, { error() {} });
    assert.deepEqual(meta, {}, 'skipped');
  });
});

test('images embedded in the page (data: URIs) are not lazy-loaded (they are already downloaded)', () => {
  const html = '<img src="hero.jpg"><img src="data:image/jpeg;base64,AAAA"><img src="b.jpg">';
  const out = optimizeHtml(html, { versionId: 1 });
  assert.match(out, /<img src="data:image\/jpeg;base64,AAAA"(?![^>]*loading=)[^>]*>/);
  assert.match(out, /<img src="b\.jpg\?v=1"[^>]*loading="lazy"/);
});
