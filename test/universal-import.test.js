// Universal landing-page import: a page made elsewhere (here an AI-generated page whose order
// form and buttons send orders to WhatsApp) is imported, its products and fields matched,
// its checkout connected to Skyfly, checked, published at a stable address, and its orders
// saved under its own business only.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import request from 'supertest';
import { setup, resetDatabase, csrfToken, signUp, openClientSignup } from './helpers.js';
import { seedLarose } from '../src/scripts/seed-larose.js';
import { clearOriginCache } from '../src/lib/origins.js';
import { detectCheckout, connectCheckout, priceIn } from '../src/hosting/adapter.js';
import { checkLive } from '../src/hosting/validate.js';

const { pool, app, config } = setup({ pagesBaseUrl: '', allowedOrigins: [] });
const SAMPLE = readFileSync(new URL('../src/demo/import-sample/index.html', import.meta.url), 'utf8');
const CATALOGUE = [{ id: 1, code: 'radiance-serum', name: 'Radiance Serum', price: 15000 }, { id: 2, code: 'glow-duo', name: 'Glow Duo Set', price: 27500 }];
let owner; let other; let aurora; let pageId; let slug;
let n = 0;

async function post(agent, path, fields, status) {
  const _csrf = await csrfToken(agent, `/businesses/${aurora}/landing-pages/${pageId}`);
  const res = await agent.post(path).type('form').send({ _csrf, ...fields });
  assert.equal(res.status, status, `${path}: HTTP ${res.status}`);
  return res;
}
const base = () => `/businesses/${aurora}/landing-pages/${pageId}`;
const latest = async () => (await pool.query('SELECT id FROM page_versions WHERE landing_page_id = $1 ORDER BY id DESC LIMIT 1', [pageId])).rows[0].id;
const order = (fields = {}, key = null) => request(app).post('/api/public/orders').set('Origin', 'null').send({
  landingPage: slug, idempotencyKey: key ?? `universal-import-${String(n += 1).padStart(6, '0')}`,
  customer: { name: 'TEST ORDER universal import', phone: '08031234567', address: '1 Test Road, Ikeja', state: 'Lagos' },
  items: [{ product: 'radiance-serum', quantity: 1, unitPrice: 15000 }], ...fields,
});

before(async () => {
  await resetDatabase(pool);
  owner = await signUp(app, { email: 'owner@aurora.test' });
  await openClientSignup(pool);
  other = await signUp(app, { email: 'owner@other.test' });
  await seedLarose(pool, 'owner@other.test'); // a second business with its own products and page
  const _csrf = await csrfToken(owner, '/?all=1');
  const res = await owner.post('/businesses').type('form').send({ _csrf, name: 'Aurora Glow' }).expect(302);
  aurora = Number(res.headers.location.match(/businesses\/(\d+)/)[1]);
  await pool.query("UPDATE businesses SET subscription_status = 'active', subscription_expires_on = NULL, whatsapp_number = '+2349049206695' WHERE id = $1", [aurora]);
  for (const [i, p] of CATALOGUE.entries()) {
    await pool.query('INSERT INTO products (business_id, code, name, price_minor, sort_order) VALUES ($1, $2, $3, $4, $5)', [aurora, p.code, p.name, p.price * 100, i]);
  }
});
after(() => pool.end());

describe('adapter (pure)', () => {
  test('reads prices as pages write them', () => {
    assert.equal(priceIn('₦23,500'), 23500);
    assert.equal(priceIn('Price: NGN 15000'), 15000);
    assert.equal(priceIn('$49.99'), 49.99);
    assert.equal(priceIn('27,500 naira'), 27500);
    assert.equal(priceIn('Call 0904 920 6695'), null);
  });

  test('finds the order form, its fields, the WhatsApp purchase buttons and the products; leaves "chat" links alone', () => {
    const d = detectCheckout(SAMPLE, CATALOGUE);
    assert.equal(d.forms.length, 1);
    assert.deepEqual(d.forms[0].fields.map((f) => f.field), ['product', 'name', 'phone', 'address', 'state']);
    assert.equal(d.forms[0].sendsTo, 'its own script');
    assert.deepEqual(d.buttons.map((b) => [b.text, b.goesTo]), [['Order on WhatsApp', 'WhatsApp'], ['Buy now', 'WhatsApp'], ['Order now', 'WhatsApp']]);
    assert.ok(d.candidates.every((c) => c.match?.confidence === 'high'), JSON.stringify(d.candidates));
    assert.equal(d.whatsappOrderButtons, 3);
  });

  test('connecting adds attributes only: design, text and other links stay byte-for-byte', () => {
    const { html } = connectCheckout(SAMPLE, { slug: 'aurora', catalogue: CATALOGUE });
    const strip = (h) => h.replace(/\s(data-skyfly-[a-z-]+(="[^"]*")?|data-product="[^"]*"|data-price="[^"]*"|required)(?=[\s>])/g, '')
      .replace(/href="#orderForm"/g, 'HREF').replace(/href="https:\/\/wa\.me\/[^"]*(order|Order)[^"]*"/g, 'HREF').replace(/\stype="submit"/g, ' type="button"').replace(/\s(onclick|onsubmit)="[^"]*"/g, '');
    assert.equal(strip(html), strip(SAMPLE));
    assert.match(html, /<a href="https:\/\/wa\.me\/2349049206695">Chat with us on WhatsApp<\/a>/, 'support link unchanged');
    assert.doesNotMatch(html, /\sonclick="sendOrder\(\)"/, 'the page script that sent orders to WhatsApp is detached');
    assert.equal(connectCheckout(html, { slug: 'aurora', catalogue: CATALOGUE }).html, html, 'connecting twice changes nothing');
  });
});

describe('import → products → checkout → checks → publish', () => {
  test('import: the page is stored under the selected business and the workflow shows what was found', async () => {
    const _csrf = await csrfToken(owner, `/businesses/${aurora}/landing-pages`);
    const res = await owner.post(`/businesses/${aurora}/landing-pages/upload`).field('_csrf', _csrf).field('name', 'Aurora Radiance')
      .attach('file', Buffer.from(SAMPLE), 'index.html').expect(302);
    pageId = Number(res.headers.location.match(/landing-pages\/(\d+)/)[1]);
    const { rows: [lp] } = await pool.query('SELECT business_id, slug, status FROM landing_pages WHERE id = $1', [pageId]);
    assert.equal(lp.business_id, aurora);
    assert.equal(lp.status, 'draft');
    slug = lp.slug;
    const page = await owner.get(base()).expect(200);
    assert.match(page.text, /id="workflow"/);
    assert.match(page.text, /Order form 1: not connected \(sends orders to its own script\)/);
    assert.match(page.text, /Button "Order on WhatsApp" goes to WhatsApp/);
    assert.match(page.text, /<option value="radiance-serum" selected>Radiance Serum/);
    assert.match(page.text, /data-check="checkout"[\s\S]*?BLOCKED/);
  });

  test('publishing is refused while the page would not save orders', async () => {
    const res = await post(owner, `${base()}/publish`, { version_id: String(await latest()) }, 400);
    assert.match(res.text, /Not published\./);
    assert.equal((await pool.query('SELECT status FROM landing_pages WHERE id = $1', [pageId])).rows[0].status, 'draft');
  });

  test('an unmatched product blocks publishing with a clear reason', async () => {
    const first = await latest();
    await post(owner, `${base()}/versions/${first}/connect`, { 'product__option:0.2': '' }, 302);
    const res = await post(owner, `${base()}/publish`, { version_id: String(await latest()) }, 400);
    assert.match(res.text, /Product mapping: Orders would be refused: &#34;Glow Duo Set – ₦27,500&#34; is not matched to a product/);
    await pool.query('DELETE FROM page_versions WHERE id = $1', [await latest()]); // back to the original upload
    assert.equal(await latest(), first);
  });

  test('connect checkout automatically: one new version, products connected, every check passes', async () => {
    const v = await latest();
    await post(owner, `${base()}/versions/${v}/connect`, {}, 302);
    const v2 = await latest();
    assert.notEqual(v2, v);
    const { rows: linked } = await pool.query('SELECT p.code FROM landing_page_products l JOIN products p ON p.id = l.product_id WHERE l.landing_page_id = $1 ORDER BY 1', [pageId]);
    assert.deepEqual(linked.map((r) => r.code), ['glow-duo', 'radiance-serum']);
    const page = await owner.get(base()).expect(200);
    assert.match(page.text, /The checkout is connected to Skyfly/);
    assert.doesNotMatch(page.text, /data-check="[a-z]+"><td>[^<]+<\/td>\s*<td><span class="pill cancelled">BLOCKED/);
    assert.match(page.text, /data-check="buttons"[\s\S]*?PASS[\s\S]*?Purchase buttons open the Skyfly order form/);
  });

  test('publish: a stable public address that works without signing in', async () => {
    await post(owner, `${base()}/publish`, { version_id: String(await latest()) }, 302);
    clearOriginCache();
    const live = await request(app).get(`/p/${slug}/`).expect(200);
    assert.match(live.text, /data-skyfly-form="[^"]+" data-skyfly-exclusive id="orderForm"/);
    assert.match(live.text, /\/sdk\/skyfly\.js/);
    assert.match(live.text, /Aurora Glow Radiance Serum/);
    const dash = await owner.get(base()).expect(200);
    assert.match(dash.text, new RegExp(`id="live-url-text" readonly value="http://skyfly\\.test/p/${slug}/"`));
    // Publishing opens the address like a visitor; the test address doesn't resolve, so it is not called live.
    const check = dash.text.match(/data-live-check>([\s\S]{0,400})/)?.[1] ?? '';
    assert.match(check, /Not reachable|Not checked yet/);
    assert.doesNotMatch(check, /Live ✓/);
  });

  test('the live check records whether the address answers like a visitor sees it', async () => {
    const { rows: [lp] } = await pool.query('SELECT * FROM landing_pages WHERE id = $1', [pageId]);
    const fetchImpl = async (url) => { const r = await request(app).get(new URL(url).pathname); return { status: r.status, text: async () => r.text }; };
    assert.match(await checkLive(pool, config, lp, { fetchImpl }), /^ok: HTTP 200/);
    const dash = await owner.get(base()).expect(200);
    assert.match(dash.text, /Live ✓/);
    assert.match(await checkLive(pool, config, lp, { fetchImpl: async () => { throw Object.assign(new Error('x'), { cause: { code: 'ENOTFOUND' } }); } }), /^failed: ENOTFOUND/);
    assert.match((await owner.get(base()).expect(200)).text, /Not reachable/);
  });

  test('orders: saved under this business, priced by Skyfly, once per submission; bad details are refused', async () => {
    const ok = await order({}, 'universal-import-same-0001').expect(201);
    assert.equal(ok.body.business, (await pool.query('SELECT slug FROM businesses WHERE id = $1', [aurora])).rows[0].slug);
    assert.equal(ok.body.total, 15000);
    assert.match(ok.body.whatsappUrl, /^https:\/\/wa\.me\/2349049206695\?text=.*/);
    const again = await order({}, 'universal-import-same-0001').expect(200);
    assert.equal(again.body.reference, ok.body.reference);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM orders WHERE reference = $1', [ok.body.reference])).rows[0].n, 1);
    const bad = await order({ customer: { name: 'TEST ORDER', phone: '', address: '' } }).expect(400);
    assert.ok(bad.body.fields.phone && bad.body.fields.address);
    await order({ items: [{ product: 'radiance-serum', quantity: 1, unitPrice: 1 }] }).expect(409); // a tampered price
  });

  test('isolation: no business can order another business\'s products, see its page or its orders', async () => {
    await order({ items: [{ product: 'package-1', quantity: 1 }] }).expect(400); // Larose's product on Aurora's page
    await request(app).post('/api/public/orders').set('Origin', 'null').send({
      landingPage: 'larosenigeria', idempotencyKey: 'universal-import-cross-0001',
      customer: { name: 'TEST ORDER cross', phone: '08031234567', address: '1 Test Road, Ikeja' }, items: [{ product: 'radiance-serum', quantity: 1 }],
    }).expect((r) => assert.ok([400, 403].includes(r.status), `HTTP ${r.status}`));
    await other.get(base()).expect(404);
    await other.get(`/businesses/${aurora}/orders`).expect(404);
    const { rows } = await pool.query('SELECT DISTINCT business_id FROM orders WHERE landing_page_id = $1', [pageId]);
    assert.deepEqual(rows.map((r) => r.business_id), [aurora]);
  });

  test('edit and republish: same address, same business, checkout still works', async () => {
    const v = await latest();
    const edit = await owner.get(`${base()}/versions/${v}/edit`).expect(200);
    const id = edit.text.match(/name="text_(\d+)" [^>]*>Brighter, even-toned skin in 14 days\./)?.[1] ?? edit.text.match(/name="text_(\d+)"[^>]*value="Brighter, even-toned skin in 14 days\./)?.[1];
    assert.ok(id, 'editable text found');
    const _csrf = await csrfToken(owner, `${base()}/versions/${v}/edit`);
    await owner.post(`${base()}/versions/${v}/edit`).field('_csrf', _csrf).field(`text_${id}`, 'Brighter skin in 14 days. Edited.').expect(302);
    await post(owner, `${base()}/publish`, { version_id: String(await latest()) }, 302);
    const live = await request(app).get(`/p/${slug}/`).expect(200);
    assert.match(live.text, /Brighter skin in 14 days\. Edited\./);
    assert.match(live.text, /data-skyfly-form=/);
    assert.equal((await pool.query('SELECT business_id FROM landing_pages WHERE id = $1', [pageId])).rows[0].business_id, aurora);
    await order().expect(201);
    await post(owner, `${base()}/unpublish`, {}, 302);
    await request(app).get(`/p/${slug}/`).expect(404);
    await post(owner, `${base()}/publish`, { version_id: String(await latest()) }, 302);
    await request(app).get(`/p/${slug}/`).expect(200);
  });
});

describe('import test site on the live service', () => {
  test('is built once through the same import → connect → checks → publish steps, in test mode', async () => {
    const { ensureImportTestSite } = await import('../src/services/setup.js');
    const lines = [];
    const log = { log: (m) => lines.push(m) };
    const id = await ensureImportTestSite(pool, { ...config, demoSite: true }, log);
    assert.ok(id, lines.join('\n'));
    assert.equal(await ensureImportTestSite(pool, { ...config, demoSite: true }, log), null, 'created once');
    assert.match(lines[0], /found 1 order form\(s\), 3 purchase button\(s\) \(3 to WhatsApp\), 5\/5 products matched/);
    assert.doesNotMatch(lines[1], /BLOCKED/);
    const { rows: [lp] } = await pool.query("SELECT lp.status, lp.test_mode, b.slug FROM landing_pages lp JOIN businesses b ON b.id = lp.business_id WHERE lp.slug = 'skyfly-import-test'");
    assert.deepEqual(lp, { status: 'active', test_mode: true, slug: 'skyfly-import-test' });
    clearOriginCache();
    const page = await request(app).get('/p/skyfly-import-test/').expect(200);
    assert.match(page.text, /data-skyfly-form="skyfly-import-test" data-skyfly-exclusive id="orderForm"/);
    const res = await request(app).post('/api/public/orders').set('Origin', 'null').send({
      landingPage: 'skyfly-import-test', idempotencyKey: 'import-test-site-0001',
      customer: { name: 'Ada Test', phone: '08031234567', address: '1 Test Road, Ikeja' }, items: [{ product: 'glow-duo', quantity: 1, unitPrice: 27500 }],
    }).expect(201);
    assert.equal(res.body.business, 'skyfly-import-test');
    assert.equal(res.body.test, true, 'every order from a test-mode page is a test order');
  });
});
