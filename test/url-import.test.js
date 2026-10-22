// Importing a landing page from its public https address: only public websites can be fetched
// (never Skyfly's own network, also not through a redirect), relative assets keep loading from
// the original site, and the page then goes through the same import checks as an uploaded file,
// under the selected business only.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setup, resetDatabase, csrfToken, signUp, openClientSignup } from './helpers.js';
import { checkPageUrl, isPublicAddress, absolutizeAssets, fetchPage, safeLookup } from '../src/hosting/urlImport.js';
import { ImportError } from '../src/hosting/importer.js';

const SAMPLE = readFileSync(new URL('../src/demo/import-sample/index.html', import.meta.url), 'utf8');
const pages = {
  'https://shop.example.com/promo/': { body: SAMPLE.replace('<head>', '<head><link rel="stylesheet" href="style.css"><img src="img/hero.jpg" alt="">') },
  'https://shop.example.com/moved': { redirect: '/promo/' },
  'https://shop.example.com/sneaky': { redirect: 'https://127.0.0.1/admin' },
};
const fakeGet = async (u) => {
  const p = pages[u.href];
  if (!p) throw new ImportError('The page could not be reached. Check the address and try again.');
  return p.redirect ? { redirect: p.redirect } : { body: Buffer.from(p.body) };
};
const { pool, app } = setup({ pagesBaseUrl: '', allowedOrigins: [], urlImportGet: fakeGet });
let owner; let other; let shop;

before(async () => {
  await resetDatabase(pool);
  owner = await signUp(app, { email: 'owner@jewels.test' });
  await openClientSignup(pool);
  other = await signUp(app, { email: 'owner@other.test' });
  const _csrf = await csrfToken(owner, '/?all=1');
  const res = await owner.post('/businesses').type('form').send({ _csrf, name: 'Gold Jewels' }).expect(302);
  shop = Number(res.headers.location.match(/businesses\/(\d+)/)[1]);
  await pool.query("UPDATE businesses SET subscription_status = 'active', subscription_expires_on = NULL WHERE id = $1", [shop]);
});
after(() => pool.end());

describe('which addresses can be imported', () => {
  test('only public https websites', () => {
    for (const bad of ['http://shop.example.com/', 'ftp://shop.example.com/', 'https://localhost/', 'https://127.0.0.1/', 'https://10.0.0.5/',
      'https://169.254.169.254/latest/meta-data/', 'https://[::1]/', 'https://user:pw@shop.example.com/', 'https://shop.example.com:8443/',
      'https://intranet/', 'https://db.internal/', 'not a url']) {
      assert.throws(() => checkPageUrl(bad), ImportError, bad);
    }
    assert.equal(checkPageUrl('https://shop.example.com/promo/#top').href, 'https://shop.example.com/promo/');
  });

  test('private, local and reserved network addresses are never connected to', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1']) {
      assert.equal(isPublicAddress(ip), false, ip);
    }
    for (const ip of ['8.8.8.8', '151.101.1.1', '2606:4700::1111']) assert.equal(isPublicAddress(ip), true, ip);
  });

  test('a name that resolves to a private address is refused when connecting (localhost resolves to 127.0.0.1)', async () => {
    const err = await new Promise((resolve) => safeLookup('localhost', {}, (e) => resolve(e)));
    assert.equal(err?.code, 'SKYFLY_PRIVATE');
  });

  test('redirects are followed only to public https addresses', async () => {
    assert.equal((await fetchPage('https://shop.example.com/moved', { get: fakeGet })).finalUrl, 'https://shop.example.com/promo/');
    await assert.rejects(fetchPage('https://shop.example.com/sneaky', { get: fakeGet }), /not a public website/);
  });

  test('relative assets point at the original site; in-page links, phone and WhatsApp links are unchanged', () => {
    const html = '<link href="css/a.css" rel="stylesheet"><img src="i/a.jpg" srcset="i/a.jpg 1x, i/b.jpg 2x"><div style="background:url(\'bg.png\')"></div>'
      + '<a href="#order">Order</a><a href="tel:0800">Call</a><a href="https://wa.me/234">Chat</a><img src="data:image/png;base64,AA"><script src="//cdn.example.net/x.js"></script>';
    const out = absolutizeAssets(html, 'https://shop.example.com/promo/');
    assert.match(out, /href="https:\/\/shop\.example\.com\/promo\/css\/a\.css"/);
    assert.match(out, /src="https:\/\/shop\.example\.com\/promo\/i\/a\.jpg" srcset="https:\/\/shop\.example\.com\/promo\/i\/a\.jpg 1x, https:\/\/shop\.example\.com\/promo\/i\/b\.jpg 2x"/);
    assert.match(out, /url\('https:\/\/shop\.example\.com\/promo\/bg\.png'\)/);
    assert.match(out, /href="#order"/);
    assert.match(out, /href="tel:0800"/);
    assert.match(out, /href="https:\/\/wa\.me\/234"/);
    assert.match(out, /src="data:image\/png;base64,AA"/);
    assert.match(out, /src="https:\/\/cdn\.example\.net\/x\.js"/);
  });
});

describe('import from an address in the dashboard', () => {
  test('creates a draft page under the selected business, with the same checks as an upload', async () => {
    const _csrf = await csrfToken(owner, `/businesses/${shop}/landing-pages`);
    const res = await owner.post(`/businesses/${shop}/landing-pages/import-url`).type('form')
      .send({ _csrf, name: 'Gold promo', page_url: 'https://shop.example.com/moved' }).expect(302);
    assert.match(res.headers.location, new RegExp(`/businesses/${shop}/landing-pages/\\d+\\?done=uploaded`));
    const { rows: [p] } = await pool.query("SELECT lp.id, lp.business_id, lp.status, v.source_name, v.entry_path FROM landing_pages lp JOIN page_versions v ON v.landing_page_id = lp.id WHERE lp.name = 'Gold promo'");
    assert.deepEqual([p.business_id, p.status, p.source_name, p.entry_path], [shop, 'draft', 'https://shop.example.com/promo/', 'index.html']);
    const page = await owner.get(`/businesses/${shop}/landing-pages/${p.id}`).expect(200);
    assert.match(page.text, /Order on WhatsApp/, 'the WhatsApp order buttons are found, to be connected to Skyfly checkout');
    assert.match(page.text, /Products on the page/, 'products to match before publishing');
  });

  test('refused addresses create nothing and say why', async () => {
    const before = (await pool.query('SELECT count(*)::int AS n FROM landing_pages')).rows[0].n;
    for (const [url, why] of [['http://shop.example.com/promo/', /https/], ['https://127.0.0.1/', /not a public website/], ['https://shop.example.com/sneaky', /not a public website/]]) {
      const _csrf = await csrfToken(owner, `/businesses/${shop}/landing-pages`);
      const res = await owner.post(`/businesses/${shop}/landing-pages/import-url`).type('form').send({ _csrf, page_url: url }).expect(302);
      assert.match(decodeURIComponent(res.headers.location), why, url);
    }
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM landing_pages')).rows[0].n, before);
  });

  test('another account cannot import into this business, and a missing CSRF token is refused', async () => {
    const _csrf = await csrfToken(other, '/');
    await other.post(`/businesses/${shop}/landing-pages/import-url`).type('form').send({ _csrf, page_url: 'https://shop.example.com/promo/' }).expect(404);
    await owner.post(`/businesses/${shop}/landing-pages/import-url`).type('form').send({ page_url: 'https://shop.example.com/promo/' }).expect(403);
  });

  test('the progress upload gets the next address as JSON (the page, or the list with the reason it was refused)', async () => {
    const _csrf = await csrfToken(owner, `/businesses/${shop}/landing-pages`);
    const ok = await owner.post(`/businesses/${shop}/landing-pages/upload`).set('X-Skyfly-Upload', '1')
      .field('_csrf', _csrf).field('name', 'Dropped page').attach('file', Buffer.from(SAMPLE), 'promo.html').expect(200);
    assert.match(ok.body.location, new RegExp(`^/businesses/${shop}/landing-pages/\\d+\\?done=uploaded$`));
    const _csrf2 = await csrfToken(owner, `/businesses/${shop}/landing-pages`);
    const bad = await owner.post(`/businesses/${shop}/landing-pages/upload`).set('X-Skyfly-Upload', '1')
      .field('_csrf', _csrf2).attach('file', Buffer.from('MZ not a page'), 'tool.exe').expect(200);
    assert.match(decodeURIComponent(bad.body.location), /landing-pages\?error=.*\.zip/);
    // A normal form post (no script) still gets a redirect.
    const _csrf3 = await csrfToken(owner, `/businesses/${shop}/landing-pages`);
    await owner.post(`/businesses/${shop}/landing-pages/upload`).field('_csrf', _csrf3).attach('file', Buffer.from(SAMPLE), 'promo.html').expect(302);
  });

  test('the import page offers drag and drop with upload progress, and import from an address', async () => {
    const list = await owner.get(`/businesses/${shop}/landing-pages`).expect(200);
    assert.match(list.text, /data-dropzone/);
    assert.match(list.text, /data-upload-progress/);
    assert.match(list.text, /\/static\/upload\.js/);
    assert.match(list.text, /name="page_url"/);
    await owner.get('/static/upload.js').expect(200).expect('Content-Type', /javascript/);
  });
});
