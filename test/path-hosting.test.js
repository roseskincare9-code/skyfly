// Published pages on the Skyfly address itself (/p/<slug>/), used when there is no separate
// pages address: import, publish, open publicly, order, edit and republish, unpublish, test mode.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { setup, resetDatabase, csrfToken, signUp } from './helpers.js';
import { seedLarose } from '../src/scripts/seed-larose.js';
import { clearOriginCache } from '../src/lib/origins.js';

const { pool, app } = setup({ pagesBaseUrl: '', allowedOrigins: [] });
let owner;
let businessId;
let pageId;
let n = 0;

const PAGE_V1 = `<!doctype html><html><head><title>Glow</title><link rel="stylesheet" href="style.css"></head>
<body><h1>Glow serum v1</h1><img src="hero.png"><div data-skyfly-checkout></div></body></html>`;
const PAGE_V2 = PAGE_V1.replace('Glow serum v1', 'Glow serum v2');

async function form(path, fields) {
  const _csrf = await csrfToken(owner, `/businesses/${businessId}/landing-pages`);
  const res = await owner.post(`/businesses/${businessId}/landing-pages${path}`).type('form').send({ _csrf, ...fields });
  assert.equal(res.status, 302, `${path}: HTTP ${res.status}`);
  return res;
}
async function upload(html, path = '/upload') {
  const _csrf = await csrfToken(owner, `/businesses/${businessId}/landing-pages`);
  return owner.post(`/businesses/${businessId}/landing-pages${path}`).field('_csrf', _csrf).field('name', 'Glow Path')
    .attach('file', Buffer.from(html), 'index.html');
}
const latestVersion = async () => (await pool.query('SELECT id FROM page_versions WHERE landing_page_id = $1 ORDER BY id DESC LIMIT 1', [pageId])).rows[0].id;
const order = (origin, name = 'Path Customer') => request(app).post('/api/public/orders').set('Origin', origin).send({
  landingPage: 'glow-path', idempotencyKey: `path-hosting-${String(n += 1).padStart(6, '0')}`,
  customer: { name, phone: '08031234567', address: '1 Path Road, Ikeja' }, items: [{ product: 'package-2', quantity: 1 }],
});

before(async () => {
  await resetDatabase(pool);
  owner = await signUp(app, { email: 'owner@larose.test' });
  businessId = await seedLarose(pool, 'owner@larose.test');
  const res = await upload(PAGE_V1);
  pageId = res.headers.location.match(/landing-pages\/(\d+)/)[1];
  await pool.query("INSERT INTO landing_page_products (landing_page_id, product_id) SELECT $1, id FROM products WHERE business_id = $2 AND code = 'package-2'", [pageId, businessId]);
});
after(() => pool.end());

describe('pages on the Skyfly address', () => {
  test('an unpublished page is not public', async () => {
    await request(app).get('/p/glow-path/').expect(404);
  });

  test('publishing gives a stable public address, shown in the dashboard', async () => {
    await form(`/${pageId}/publish`, { version_id: String(await latestVersion()) });
    clearOriginCache();
    const dash = await owner.get(`/businesses/${businessId}/landing-pages/${pageId}`).expect(200);
    assert.match(dash.text, /id="live-url">http:\/\/skyfly\.test\/p\/glow-path\/</);
    await request(app).get('/p/glow-path').expect(301).expect('Location', '/p/glow-path/');
    const page = await request(app).get('/p/glow-path/').expect(200);
    assert.match(page.text, /Glow serum v1/);
    assert.match(page.text, /\/sdk\/skyfly\.js/, 'Skyfly SDK added');
    // The page runs in a browser sandbox: its scripts cannot read the dashboard or its cookies.
    assert.match(page.headers['content-security-policy'], /^sandbox allow-scripts allow-forms/);
    assert.doesNotMatch(page.headers['content-security-policy'], /allow-same-origin/);
    assert.equal(page.headers['set-cookie'], undefined, 'no dashboard session cookie on public pages');
  });

  test('an order from the sandboxed page (Origin: null) is saved to the page\'s business', async () => {
    const pre = await request(app).options('/api/public/orders').set('Origin', 'null').set('Access-Control-Request-Method', 'POST').expect(204);
    assert.equal(pre.headers['access-control-allow-origin'], 'null');
    const res = await order('null').expect(201);
    const { rows: [o] } = await pool.query('SELECT business_id, landing_page_id, total_minor, is_test FROM orders WHERE reference = $1', [res.body.reference]);
    assert.deepEqual([o.business_id, String(o.landing_page_id), o.is_test], [businessId, String(pageId), false]);
    assert.equal(res.body.total, Number(o.total_minor) / 100, 'price from Skyfly, not the browser');
  });

  test('"Origin: null" is not accepted for pages that are not hosted by Skyfly', async () => {
    const res = await request(app).post('/api/public/orders').set('Origin', 'null').send({
      landingPage: 'larosenigeria', idempotencyKey: 'path-hosting-external-1',
      customer: { name: 'Null Origin', phone: '08031234567', address: '1 Path Road, Ikeja' }, items: [{ product: 'package-2', quantity: 1 }],
    });
    assert.equal(res.status, 403);
  });

  test('editing and republishing changes the page at the same address', async () => {
    await upload(PAGE_V2, `/${pageId}/upload`);
    assert.match((await request(app).get('/p/glow-path/').expect(200)).text, /Glow serum v1/, 'still v1 until published');
    await form(`/${pageId}/publish`, { version_id: String(await latestVersion()) });
    assert.match((await request(app).get('/p/glow-path/').expect(200)).text, /Glow serum v2/);
  });

  test('test mode: every order from the page is a test order', async () => {
    const { rows: [p] } = await pool.query('SELECT name, slug, status FROM landing_pages WHERE id = $1', [pageId]);
    await form(`/${pageId}`, { name: p.name, slug: p.slug, status: p.status, products: [], test_mode: 'on' });
    await pool.query("INSERT INTO landing_page_products (landing_page_id, product_id) SELECT $1, id FROM products WHERE business_id = $2 AND code = 'package-2' ON CONFLICT DO NOTHING", [pageId, businessId]);
    const res = await order('null', 'Real Looking Name').expect(201);
    assert.equal(res.body.test, true);
    assert.equal((await pool.query('SELECT is_test FROM orders WHERE reference = $1', [res.body.reference])).rows[0].is_test, true);
  });

  test('unpublishing takes the page offline at once', async () => {
    await form(`/${pageId}/unpublish`, {});
    await request(app).get('/p/glow-path/').expect(404);
  });
});

describe('demo site', () => {
  test('is created once for the platform owner, published at /p/skyfly-demo/ in test mode, with no pixel or sheet', async () => {
    const { ensureDemoSite } = await import('../src/services/setup.js');
    const quiet = { log() {} };
    const before = (await pool.query('SELECT count(*)::int AS n FROM orders')).rows[0].n;
    const id = await ensureDemoSite(pool, { demoSite: true }, quiet);
    assert.ok(id);
    assert.equal(await ensureDemoSite(pool, { demoSite: true }, quiet), null, 'second run changes nothing');
    assert.equal(await ensureDemoSite(pool, { demoSite: false }, quiet), null);
    const { rows: [b] } = await pool.query("SELECT name, subscription_status, default_sheet_connection_id FROM businesses WHERE id = $1", [id]);
    assert.deepEqual([b.name, b.subscription_status, b.default_sheet_connection_id], ['Skyfly Demo Shop (test)', 'internal', null]);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM pixel_settings WHERE business_id = $1', [id])).rows[0].n, 0);
    const page = await request(app).get('/p/skyfly-demo/').expect(200);
    assert.match(page.text, /data-skyfly-checkout/);
    await request(app).get('/p/skyfly-demo/hero.jpg').expect(200).expect('Content-Type', /image\/jpeg/);
    const cat = (await request(app).get('/api/public/pages/skyfly-demo/catalog').expect(200)).body;
    assert.deepEqual(cat.products.map((p) => [p.code, p.price]), [['demo-serum', 12500], ['demo-duo', 22000]]);
    assert.equal(cat.whatsapp, null, 'no other business\'s WhatsApp number');
    const res = await request(app).post('/api/public/orders').set('Origin', 'null').send({
      landingPage: 'skyfly-demo', idempotencyKey: 'demo-site-order-0001',
      customer: { name: 'Demo Visitor', phone: '08031234567', address: '1 Demo Road, Ikeja' }, items: [{ product: 'demo-serum', quantity: 1 }],
    }).expect(201);
    assert.equal(res.body.test, true, 'demo orders are test orders');
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM orders')).rows[0].n, before + 1);
  });
});
