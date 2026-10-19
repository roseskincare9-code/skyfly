// Upsell (order bump) at checkout: the owner picks one of the business's products per landing
// page; the customer adds it with one button. Skyfly prices it like any item (browser totals are
// never used), marks it as an add-on everywhere, and keeps one order per submission.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { setup, resetDatabase, csrfToken, signUp, ORIGIN } from './helpers.js';
import { seedLarose } from '../src/scripts/seed-larose.js';
import { domainReadiness } from '../src/hosting/domains.js';

const { pool, app } = setup();
let owner; let businessId; let pageId; let base; let n = 0;
const body = (items, extra = {}) => ({
  landingPage: 'larosenigeria', idempotencyKey: `upsell-test-${String(n += 1).padStart(6, '0')}-key`,
  customer: { name: 'Ada Obi', phone: '08031234567', address: '12 Allen Avenue, Ikeja', state: 'Lagos' }, items, ...extra,
});
const post = (b) => request(app).post('/api/public/orders').set('Origin', ORIGIN).send(b);

before(async () => {
  await resetDatabase(pool);
  owner = await signUp(app, { email: 'owner@larose.test' });
  businessId = await seedLarose(pool, 'owner@larose.test');
  base = `/businesses/${businessId}`;
  ({ rows: [{ id: pageId }] } = await pool.query("SELECT id FROM landing_pages WHERE slug = 'larosenigeria'"));
  await pool.query("INSERT INTO products (business_id, code, name, price_minor, sort_order) VALUES ($1, 'glow-toner', 'Glow Toner', 850000, 9)", [businessId]);
});
after(() => pool.end());

describe('upsell at checkout', () => {
  test('no upsell is offered until the owner sets one; an add-on is then refused', async () => {
    const cat = await request(app).get('/api/public/pages/larosenigeria/catalog').expect(200);
    assert.equal(cat.body.upsell, null);
    const r = await post(body([{ product: 'package-3', quantity: 1 }, { product: 'glow-toner', quantity: 1, upsell: true }]));
    assert.equal(r.status, 400);
    assert.match(r.body.message, /add-on is no longer available/);
  });

  test('the owner sets the upsell on the page; the catalog offers it with its headline and price', async () => {
    const { rows: [toner] } = await pool.query("SELECT id FROM products WHERE code = 'glow-toner'");
    const { rows: linked } = await pool.query('SELECT product_id FROM landing_page_products WHERE landing_page_id = $1', [pageId]);
    const page = await owner.get(`${base}/landing-pages/${pageId}`).expect(200);
    assert.ok(page.text.includes('Upsell at checkout (optional)'));
    const _csrf = await csrfToken(owner, `${base}/landing-pages/${pageId}`);
    await owner.post(`${base}/landing-pages/${pageId}`).type('form').send({
      _csrf, name: 'Larose', slug: 'larosenigeria', status: 'active', url: 'https://roseskincare9-code.github.io/Larosenigeria/',
      products: linked.map((l) => String(l.product_id)), upsell_product_id: String(toner.id),
      upsell_headline: 'Add a Glow Toner', upsell_text: '100ml toner, used after washing',
    }).expect(302);
    const cat = await request(app).get('/api/public/pages/larosenigeria/catalog').expect(200);
    assert.deepEqual(cat.body.upsell, { code: 'glow-toner', name: 'Glow Toner', price: 8500, headline: 'Add a Glow Toner', text: '100ml toner, used after washing' });
  });

  test('an order with the add-on is priced by Skyfly (browser totals ignored), saved once, and marked as an add-on', async () => {
    const b = body([{ product: 'package-3', quantity: 2 }, { product: 'glow-toner', quantity: 1, upsell: true }], { total: 1 });
    const r = await post(b).expect(201);
    assert.equal(r.body.total, 51500 * 2 + 8500, 'server total');
    assert.deepEqual(r.body.items.map((i) => [i.quantity, i.total, i.upsell]), [[2, 103000, false], [1, 8500, true]]);
    assert.equal(r.body.items[1].name, 'Glow Toner');
    assert.match(r.body.whatsappUrl, /^https:\/\/wa\.me\/2349049206695\?text=.*LR-/);
    const { rows: items } = await pool.query('SELECT i.product_code, i.is_upsell FROM order_items i JOIN orders o ON o.id = i.order_id WHERE o.reference = $1 ORDER BY i.id', [r.body.reference]);
    assert.deepEqual(items.map((i) => [i.product_code, i.is_upsell]), [['package-3', false], ['glow-toner', true]]);
    // Double click / retry: same order, no duplicate.
    const again = await post(b).expect(200);
    assert.equal(again.body.reference, r.body.reference);
    assert.equal(again.body.replayed, true);
    const { rows: [{ c }] } = await pool.query('SELECT count(*)::int AS c FROM orders WHERE idempotency_key = $1', [b.idempotencyKey]);
    assert.equal(c, 1);
    // Same submission ID but now with the add-on removed: refused, never a second order.
    const changed = await post({ ...b, items: [b.items[0]] });
    assert.equal(changed.status, 409);
    // The confirmation page lists the add-on and the thank-you message, with the WhatsApp button.
    const conf = await request(app).get(new URL(r.body.confirmationUrl).pathname + new URL(r.body.confirmationUrl).search).expect(200);
    assert.ok(conf.text.includes('(add-on)'));
    assert.ok(conf.text.includes('Our team will contact you shortly to confirm the details and delivery.'));
    assert.match(conf.text, /href="https:\/\/wa\.me\/2349049206695\?text=/);
    assert.ok(!/24 hours/.test(conf.text));
    // The dashboard order list marks it.
    const list = await owner.get(`${base}/orders`).expect(200);
    assert.ok(list.text.includes('Add-on: Glow Toner'));
  });

  test('a wrong displayed price, two add-ons, or an add-on alone are refused', async () => {
    assert.equal((await post(body([{ product: 'package-3', quantity: 1 }, { product: 'glow-toner', quantity: 1, upsell: true, unitPrice: 1 }]))).status, 409);
    assert.equal((await post(body([{ product: 'glow-toner', quantity: 1, upsell: true }]))).status, 400);
    assert.equal((await post(body([{ product: 'package-3', quantity: 1 }, { product: 'glow-toner', quantity: 1, upsell: true }, { product: 'package-1', quantity: 1, upsell: true }]))).status, 400);
    // A package that is not on the page cannot be sneaked in as a normal item.
    assert.equal((await post(body([{ product: 'glow-toner', quantity: 1 }]))).status, 400);
  });

  test('the upsell cannot also be a package on the same page', async () => {
    const { rows: linked } = await pool.query('SELECT product_id FROM landing_page_products WHERE landing_page_id = $1', [pageId]);
    const _csrf = await csrfToken(owner, `${base}/landing-pages/${pageId}`);
    const r = await owner.post(`${base}/landing-pages/${pageId}`).type('form').send({
      _csrf, name: 'Larose', slug: 'larosenigeria', status: 'active', products: linked.map((l) => String(l.product_id)), upsell_product_id: String(linked[0].product_id),
    });
    assert.equal(r.status, 400);
    assert.match(r.text, /upsell must be a different product/);
  });
});

describe('custom domain readiness (never reported live until proven)', () => {
  const dnsOk = async () => ({ ok: true, message: 'CNAME points to skyfly-gybf.onrender.com' });
  test('DNS pending, HTTPS pending, not serving the page, and live', async () => {
    let r = await domainReadiness('shop.example.com', 'x', { dnsCheck: async () => ({ ok: false, message: 'No DNS record found yet' }) });
    assert.deepEqual([r.dns, r.https, r.live, r.ok], [false, false, false, false]);
    assert.match(r.message, /^Waiting for DNS/);
    const tlsFail = async () => { const e = new Error('fetch failed'); e.cause = { code: 'ERR_TLS_CERT_ALTNAME_INVALID' }; throw e; };
    r = await domainReadiness('shop.example.com', 'x', { dnsCheck: dnsOk, fetchImpl: tlsFail });
    assert.deepEqual([r.dns, r.https, r.live], [true, false, false]);
    assert.match(r.message, /no valid certificate yet.*Custom Domains/);
    r = await domainReadiness('shop.example.com', 'x', { dnsCheck: dnsOk, fetchImpl: async () => new Response('Not found', { status: 404 }) });
    assert.deepEqual([r.dns, r.https, r.live], [true, true, false]);
    r = await domainReadiness('shop.example.com', 'x', { dnsCheck: dnsOk, fetchImpl: async () => new Response('<html><script src="/sdk/skyfly.js"></script></html>') });
    assert.deepEqual([r.dns, r.https, r.live, r.ok], [true, true, true, true]);
  });
});
