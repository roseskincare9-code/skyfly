import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import request from 'supertest';
import yazl from 'yazl';
import { setup, resetDatabase, csrfToken, signUp } from './helpers.js';
import { seedLarose } from '../src/scripts/seed-larose.js';
import { createApp } from '../src/app.js';
import { clearOriginCache } from '../src/lib/origins.js';

const { pool, app, config } = setup({ allowedOrigins: [] });
const PAGES = 'pages.test';
const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
let owner;
let businessId;

function zip(entries) {
  return new Promise((resolve) => {
    const z = new yazl.ZipFile();
    for (const [name, content] of Object.entries(entries)) z.addBuffer(Buffer.from(content), name);
    const chunks = [];
    z.outputStream.on('data', (c) => chunks.push(c)).on('end', () => resolve(Buffer.concat(chunks)));
    z.end();
  });
}

const SAMPLE_HTML = `<!doctype html><html><head><title>Promo</title>
<link rel="stylesheet" href="css/style.css"><script src="js/app.js"></script>
<script>!function(f){}(window);fbq('init', '123456789012345');fbq('track','PageView');</script></head>
<body><img src="img/logo.png"><img src="img/missing.png"><form><input name="name"></form>
<script>fetch("https://sheetdb.io/api/v1/abc",{method:"POST"})</script>
<a href="https://wa.me/2349049206695">WhatsApp</a></body></html>`;

async function uploadNew(agent, buffer, filename, name = 'Promo page', status = 302) {
  const _csrf = await csrfToken(agent, `/businesses/${businessId}/landing-pages`);
  return agent.post(`/businesses/${businessId}/landing-pages/upload`)
    .field('_csrf', _csrf).field('name', name).attach('file', buffer, filename).expect(status);
}

const pageHost = (path) => request(app).get(path).set('Host', PAGES);

before(async () => {
  await resetDatabase(pool);
  owner = await signUp(app, { email: 'owner@larose.test' });
  businessId = await seedLarose(pool, 'owner@larose.test');
});
after(() => pool.end());

describe('import', () => {
  let pageId;

  test('a ZIP (inside a folder, with Mac junk) is imported with its assets', async () => {
    const buf = await zip({
      'promo/index.html': SAMPLE_HTML,
      'promo/css/style.css': 'body{background:url("../img/bg.jpg")}',
      'promo/js/app.js': 'window.loaded = true;',
      'promo/img/logo.png': 'PNGDATA',
      'promo/img/bg.jpg': 'JPGDATA',
      '__MACOSX/promo/._index.html': 'junk',
      'promo/.DS_Store': 'junk',
    });
    const res = await uploadNew(owner, buf, 'promo.zip');
    pageId = res.headers.location.match(/landing-pages\/(\d+)/)[1];
    const { rows: files } = await pool.query(
      'SELECT path FROM page_files f JOIN page_versions v ON v.id = f.version_id WHERE v.landing_page_id = $1 ORDER BY path', [pageId]);
    assert.deepEqual(files.map((f) => f.path), ['css/style.css', 'img/bg.jpg', 'img/logo.png', 'index.html', 'js/app.js']);

    const page = await owner.get(res.headers.location).expect(200);
    assert.match(page.text, /New version uploaded/);
    assert.match(page.text, /Not published/);
    // Report: missing file, SheetDB, existing Meta pixel, unconnected form, WhatsApp links.
    assert.match(page.text, /img\/missing\.png/);
    assert.match(page.text, /SheetDB/);
    assert.match(page.text, /Meta Pixel \(123456789012345\)/);
    assert.match(page.text, /NOT connected/);
    assert.match(page.text, /WhatsApp links/);
  });

  test('unpublished pages are not public, but a signed preview works', async () => {
    const { rows: [lp] } = await pool.query('SELECT slug FROM landing_pages WHERE id = $1', [pageId]);
    await pageHost(`/${lp.slug}/`).expect(404);
    const page = await owner.get(`/businesses/${businessId}/landing-pages/${pageId}`).expect(200);
    const preview = new URL(page.text.match(/href="(http:\/\/pages\.test\/_preview\/[^"]+)"/)[1]);
    const res = await pageHost(preview.pathname).expect(200);
    assert.match(res.text, /<title>Promo<\/title>/);
    assert.equal(res.headers['x-robots-tag'], 'noindex');
    await pageHost(`${preview.pathname}css/style.css`).expect(200).expect('Content-Type', /text\/css/);
    const forged = preview.pathname.replace(/\/_preview\/(\d+)\/[^/]+\//, '/_preview/$1/9999999999.forgedsignatureforgedsignature12/');
    await pageHost(forged).expect(404);
  });

  test('publish serves the page and assets on the pages host only', async () => {
    const { rows: [v] } = await pool.query('SELECT id FROM page_versions WHERE landing_page_id = $1', [pageId]);
    const _csrf = await csrfToken(owner, `/businesses/${businessId}/landing-pages/${pageId}`);
    await owner.post(`/businesses/${businessId}/landing-pages/${pageId}/publish`).type('form').send({ _csrf, version_id: v.id }).expect(302);
    const { rows: [lp] } = await pool.query('SELECT slug, status FROM landing_pages WHERE id = $1', [pageId]);
    assert.equal(lp.status, 'active');

    await pageHost(`/${lp.slug}`).expect(301).expect('Location', `/${lp.slug}/`);
    const html = await pageHost(`/${lp.slug}/`).expect(200).expect('Content-Type', /text\/html/);
    assert.match(html.text, /<title>Promo<\/title>/);
    assert.equal(html.headers['cache-control'], 'no-cache');
    assert.equal(html.headers['content-security-policy'], undefined, 'dashboard CSP must not break the page');
    assert.equal(html.headers['set-cookie'], undefined);
    const css = await pageHost(`/${lp.slug}/css/style.css`).expect(200).expect('Content-Type', /text\/css/);
    assert.equal(css.text, 'body{background:url("../img/bg.jpg")}');
    assert.equal(css.headers['x-content-type-options'], 'nosniff');
    await pageHost(`/${lp.slug}/css/style.css`).set('If-None-Match', css.headers.etag).expect(304);
    await pageHost(`/${lp.slug}/img/missing.png`).expect(404);
    await pageHost(`/${lp.slug}/..%2f..%2fetc%2fpasswd`).expect(404);
  });

  test('the pages host never serves the dashboard, and the dashboard never serves pages', async () => {
    const cookie = (await owner.get('/')).request.cookies;
    const res = await request(app).get(`/businesses/${businessId}/orders`).set('Host', PAGES).set('Cookie', cookie || '');
    assert.equal(res.status, 404);
    assert.doesNotMatch(res.text, /Orders/);
    await request(app).post('/login').set('Host', PAGES).send('x=1').expect(405);
    await request(app).get('/api/public/orders').set('Host', PAGES).expect(404);
    const { rows: [lp] } = await pool.query('SELECT slug FROM landing_pages WHERE id = $1', [pageId]);
    await owner.get(`/${lp.slug}/`).expect(404);
  });

  test('files survive a restart (stored in the database, not on disk)', async () => {
    const fresh = createApp({ pool, config });
    const { rows: [lp] } = await pool.query('SELECT slug FROM landing_pages WHERE id = $1', [pageId]);
    const res = await request(fresh).get(`/${lp.slug}/js/app.js`).set('Host', PAGES).expect(200);
    assert.equal(res.text, 'window.loaded = true;');
  });

  test('custom domains serve the page at the root, unknown hosts get nothing', async () => {
    const _csrf = await csrfToken(owner, `/businesses/${businessId}/landing-pages/${pageId}`);
    await owner.post(`/businesses/${businessId}/landing-pages/${pageId}/domain`).type('form')
      .send({ _csrf, domain: 'https://Shop.Example.com/anything' }).expect(302);
    const { rows: [lp] } = await pool.query('SELECT custom_domain FROM landing_pages WHERE id = $1', [pageId]);
    assert.equal(lp.custom_domain, 'shop.example.com');
    const res = await request(app).get('/').set('Host', 'shop.example.com').expect(200);
    assert.match(res.text, /<title>Promo<\/title>/);
    await request(app).get('/img/logo.png').set('Host', 'shop.example.com').expect(200);
    await request(app).get('/').set('Host', 'unknown.example').expect(404);

    const bad = await csrfToken(owner, `/businesses/${businessId}/landing-pages/${pageId}`);
    await owner.post(`/businesses/${businessId}/landing-pages/${pageId}/domain`).type('form')
      .send({ _csrf: bad, domain: 'pages.test' }).expect(400);
  });

  test('orders are accepted from the hosted page and its custom domain', async () => {
    const { rows: [lp] } = await pool.query('SELECT slug, id FROM landing_pages WHERE id = $1', [pageId]);
    await pool.query("INSERT INTO landing_page_products (landing_page_id, product_id) SELECT $1, id FROM products WHERE code = 'package-1'", [lp.id]);
    clearOriginCache();
    const order = (key) => ({
      landingPage: lp.slug, idempotencyKey: `hosted-order-key-${key}`,
      customer: { name: 'Uche Okafor', phone: '08061234567', address: '1 Hosted Road, Enugu', state: 'Enugu' },
      items: [{ product: 'package-1', quantity: 1 }],
    });
    await request(app).post('/api/public/orders').set('Origin', 'http://pages.test').send(order('a')).expect(201);
    await request(app).post('/api/public/orders').set('Origin', 'https://shop.example.com').send(order('b')).expect(201);
    await request(app).post('/api/public/orders').set('Origin', 'https://evil.example').send(order('c')).expect(403);
  });

  test('unpublishing takes the page offline everywhere', async () => {
    const _csrf = await csrfToken(owner, `/businesses/${businessId}/landing-pages/${pageId}`);
    await owner.post(`/businesses/${businessId}/landing-pages/${pageId}/unpublish`).type('form').send({ _csrf }).expect(302);
    const { rows: [lp] } = await pool.query('SELECT slug FROM landing_pages WHERE id = $1', [pageId]);
    await pageHost(`/${lp.slug}/`).expect(404);
    await request(app).get('/').set('Host', 'shop.example.com').expect(404);
  });

  test('a standalone HTML file is imported and missing local files are reported', async () => {
    const res = await uploadNew(owner, Buffer.from('<html><head><link href="style.css" rel="stylesheet"></head><body>Hi</body></html>'), 'single.html', 'Single');
    const id = res.headers.location.match(/landing-pages\/(\d+)/)[1];
    const page = await owner.get(`/businesses/${businessId}/landing-pages/${id}`).expect(200);
    assert.match(page.text, /refers to 1 local file\(s\) that were not uploaded/);
  });

  test('identical files are stored once', async () => {
    const { rows: [before] } = await pool.query('SELECT count(*)::int AS n FROM page_blobs');
    await uploadNew(owner, Buffer.from('<html><head><link href="style.css" rel="stylesheet"></head><body>Hi</body></html>'), 'single.html', 'Again');
    const { rows: [after] } = await pool.query('SELECT count(*)::int AS n FROM page_blobs');
    assert.equal(after.n, before.n);
  });
});

describe('unsafe uploads are rejected', () => {
  const cases = [
    ['traversal.zip', /damaged or unsafe|unsafe/],
    ['absolute.zip', /damaged or unsafe|unsafe/],
    ['symlink.zip', /symbolic links/],
    ['badtype.zip', /shell\.php: file type not allowed/],
    ['hidden.zip', /\.htaccess: unsafe or hidden/],
    ['bomb.zip', /larger than 15 MB/],
    ['nohtml.zip', /No HTML page found/],
  ];
  for (const [file, message] of cases) {
    test(file, async () => {
      const before = (await pool.query('SELECT count(*)::int AS n FROM page_versions')).rows[0].n;
      const res = await uploadNew(owner, fixture(file), file);
      const error = decodeURIComponent(res.headers.location.split('error=')[1] || '');
      assert.match(error, message);
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM page_versions')).rows[0].n, before);
    });
  }

  test('non-HTML single files and oversized uploads are rejected', async () => {
    const res = await uploadNew(owner, Buffer.from('MZ binary'), 'tool.exe');
    assert.match(decodeURIComponent(res.headers.location), /Upload a \.zip archive/);
    const big = await uploadNew(owner, Buffer.alloc(26 * 1024 * 1024, 65), 'huge.html');
    assert.match(decodeURIComponent(big.headers.location), /larger than 25 MB/);
  });

  test('uploads need a CSRF token and an owner', async () => {
    await owner.post(`/businesses/${businessId}/landing-pages/upload`).attach('file', Buffer.from('<html></html>'), 'a.html').expect(403);
    const other = await signUp(app, { name: 'Other', email: 'other@x.test' });
    const _csrf = await csrfToken(other, '/');
    await other.post(`/businesses/${businessId}/landing-pages/upload`).field('_csrf', _csrf)
      .attach('file', Buffer.from('<html></html>'), 'a.html').expect(404);
    await request(app).post(`/businesses/${businessId}/landing-pages/upload`).attach('file', Buffer.from('<html></html>'), 'a.html').expect(302).expect('Location', '/login');
  });

  test('other multipart posts are refused by CSRF protection', async () => {
    const _csrf = await csrfToken(owner, '/');
    await owner.post(`/businesses/${businessId}/settings`).field('_csrf', _csrf).field('name', 'X').expect(403);
  });
});
