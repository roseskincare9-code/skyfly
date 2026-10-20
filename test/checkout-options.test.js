// Product options (size…) with their own price, "was" prices, descriptions and the delivery fee:
// shown at checkout, chosen by the customer, priced and saved by Skyfly (never by the browser).
// Also: a page from the starter template, and the existing Larose page left as it is.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import request from 'supertest';
import { setup, resetDatabase, csrfToken, signUp } from './helpers.js';
import { seedLarose } from '../src/scripts/seed-larose.js';
import { clearOriginCache } from '../src/lib/origins.js';
import { parseOptionsText, resolveOptions, formatOptionsText } from '../src/lib/options.js';
import { detectCheckout, connectCheckout } from '../src/hosting/adapter.js';

const { pool, app } = setup({ pagesBaseUrl: '', allowedOrigins: [] });
let owner; let businessId; let n = 0;
const base = () => `/businesses/${businessId}`;
async function form(path, fields, status = 302) {
  const _csrf = await csrfToken(owner, `${base()}/products`);
  const res = await owner.post(`${base()}${path}`).type('form').send({ _csrf, ...fields });
  assert.equal(res.status, status, `${path}: HTTP ${res.status} ${res.text.match(/class="error">([^<]+)/)?.[1] ?? ''}`);
  return res;
}
const order = (items, key = null) => request(app).post('/api/public/orders').set('Origin', 'null').send({
  landingPage: 'starter-page', idempotencyKey: key ?? `checkout-options-${String(n += 1).padStart(6, '0')}`,
  customer: { name: 'TEST ORDER options', phone: '08031234567', address: '1 Test Road, Ikeja', state: 'Lagos' }, items,
});

before(async () => {
  await resetDatabase(pool);
  owner = await signUp(app, { email: 'owner@larose.test' });
  businessId = await seedLarose(pool, 'owner@larose.test');
});
after(() => pool.end());

describe('options text', () => {
  test('is parsed with price differences and written back the same way', () => {
    const { options, errors } = parseOptionsText('Size: 30ml, 50ml (+5000)\nColour: Gold, Silver (-1,000)');
    assert.deepEqual(errors, []);
    assert.deepEqual(options, [
      { name: 'Size', values: [{ label: '30ml', delta_minor: 0 }, { label: '50ml', delta_minor: 500000 }] },
      { name: 'Colour', values: [{ label: 'Gold', delta_minor: 0 }, { label: 'Silver', delta_minor: -100000 }] },
    ]);
    assert.equal(formatOptionsText(options), 'Size: 30ml, 50ml (+5000)\nColour: Gold, Silver (-1000)');
    assert.ok(parseOptionsText('Size 30ml').errors.length);
    assert.match(resolveOptions(options, { size: '50ML' }).error, /Please choose: Colour/);
    assert.deepEqual(resolveOptions(options, { size: '50ml', colour: 'gold' }).chosen.map((c) => c.value), ['50ml', 'Gold']);
    assert.match(resolveOptions(options, { Size: '75ml', Colour: 'Gold' }).error, /not available for Size/);
  });
});

describe('products, delivery and the checkout', () => {
  test('the owner sets a description, a "was" price, options and a delivery fee in the dashboard', async () => {
    const { rows: [p] } = await pool.query("SELECT id FROM products WHERE business_id = $1 AND code = 'package-3'", [businessId]);
    await form(`/products/${p.id}`, { name: 'Package 3 – Power Glow', price: '51500', sort_order: '3', active: 'on', description: 'Soap, serum and oil', compare_at: '60000', options: 'Size: Regular, Large (+10000)' });
    await form(`/products/${p.id}`, { name: 'Package 3 – Power Glow', price: '51500', active: 'on', compare_at: '40000' }, 400);
    const { rows: [saved] } = await pool.query('SELECT description, compare_at_price_minor, options FROM products WHERE id = $1', [p.id]);
    assert.equal(saved.description, 'Soap, serum and oil');
    assert.equal(Number(saved.compare_at_price_minor), 6000000);
    assert.equal(saved.options[0].values[1].delta_minor, 1000000);
    const _csrf = await csrfToken(owner, `${base()}/settings`);
    const { rows: [b] } = await pool.query('SELECT name, order_prefix, currency FROM businesses WHERE id = $1', [businessId]);
    await owner.post(`${base()}/settings`).type('form').send({ _csrf, name: b.name, order_prefix: b.order_prefix, currency: b.currency, whatsapp_number: '09049206695', delivery_fee: '2500', free_delivery_from: '100000' }).expect(302);
  });

  test('a page from the starter template has the Skyfly checkout and the business\'s products, and publishes', async () => {
    const _csrf = await csrfToken(owner, `${base()}/landing-pages`);
    const res = await owner.post(`${base()}/landing-pages/template`).type('form').send({ _csrf, name: 'Starter page' }).expect(302);
    const pageId = res.headers.location.match(/landing-pages\/(\d+)/)[1];
    const dash = await owner.get(res.headers.location).expect(200);
    assert.match(dash.text, /Page created from the starter template/);
    const { rows: [v] } = await pool.query('SELECT id FROM page_versions WHERE landing_page_id = $1', [pageId]);
    const _c2 = await csrfToken(owner, res.headers.location);
    await owner.post(`${base()}/landing-pages/${pageId}/publish`).type('form').send({ _csrf: _c2, version_id: v.id }).expect(302);
    clearOriginCache();
    const live = await request(app).get('/p/starter-page/').expect(200);
    assert.match(live.text, /<h1>Larose Natural Skincare Nigeria<\/h1>/);
    assert.match(live.text, /data-skyfly-checkout/);
  });

  test('the checkout catalogue shows descriptions, "was" prices, options and delivery', async () => {
    const cat = (await request(app).get('/api/public/pages/starter-page/catalog').expect(200)).body;
    const p3 = cat.products.find((p) => p.code === 'package-3');
    assert.equal(p3.description, 'Soap, serum and oil');
    assert.equal(p3.compareAt, 60000);
    assert.deepEqual(p3.options, [{ name: 'Size', values: [{ label: 'Regular', delta: 0 }, { label: 'Large', delta: 10000 }] }]);
    assert.deepEqual(cat.delivery, { fee: 2500, freeFrom: 100000 });
  });

  test('options are required, checked and priced by Skyfly; delivery is added, and free from the set amount', async () => {
    const missing = await order([{ product: 'package-3', quantity: 1 }]).expect(400);
    assert.match(missing.body.message, /Please choose: Size/);
    await order([{ product: 'package-3', quantity: 1, options: { Size: 'Huge' } }]).expect(400);
    await order([{ product: 'package-3', quantity: 1, options: { Colour: 'Red', Size: 'Large' } }]).expect(400);
    const ok = await order([{ product: 'package-3', quantity: 1, options: { size: 'large' } }]).expect(201);
    assert.equal(ok.body.total, 51500 + 10000 + 2500);
    assert.equal(ok.body.deliveryFee, 2500);
    assert.equal(ok.body.items[0].name, 'Package 3 – Power Glow (Size: Large)');
    const free = await order([{ product: 'package-3', quantity: 2, options: { Size: 'Regular' } }]).expect(201);
    assert.equal(free.body.total, 103000);
    assert.equal(free.body.deliveryFee, 0);
    const { rows: [saved] } = await pool.query('SELECT o.delivery_fee_minor, o.total_minor, i.options, i.unit_price_minor FROM orders o JOIN order_items i ON i.order_id = o.id WHERE o.reference = $1', [ok.body.reference]);
    assert.equal(Number(saved.delivery_fee_minor), 250000);
    assert.equal(Number(saved.unit_price_minor), 6150000);
    assert.deepEqual(saved.options, [{ name: 'Size', value: 'Large', delta_minor: 1000000 }]);
    const conf = await request(app).get(new URL(ok.body.confirmationUrl).pathname + new URL(ok.body.confirmationUrl).search).expect(200);
    assert.match(conf.text, /Package 3 – Power Glow \(Size: Large\)/);
    assert.match(conf.text, /id="delivery">₦2,500/);
    const { rows: [o] } = await pool.query('SELECT id FROM orders WHERE reference = $1', [ok.body.reference]);
    const dash = await owner.get(`${base()}/orders/${o.id}`).expect(200);
    assert.match(dash.text, /Package 3 – Power Glow \(Size: Large\)/);
    assert.match(dash.text, /Delivery<\/td><td>₦2,500/);
  });

  test('the same submission with other options is refused; the same one again returns the same order', async () => {
    const a = await order([{ product: 'package-3', quantity: 1, options: { Size: 'Large' } }], 'checkout-options-same-01').expect(201);
    const b = await order([{ product: 'package-3', quantity: 1, options: { Size: 'Large' } }], 'checkout-options-same-01').expect(200);
    assert.equal(b.body.reference, a.body.reference);
    await order([{ product: 'package-3', quantity: 1, options: { Size: 'Regular' } }], 'checkout-options-same-01').expect(409);
  });
});

describe('the existing Larose page', () => {
  test('already sends orders to Skyfly with its own code: nothing goes to WhatsApp, and connecting changes nothing', () => {
    const html = readFileSync(new URL('../src/import/larose-skincare.html', import.meta.url), 'utf8');
    const d = detectCheckout(html, []);
    assert.equal(d.customApi, true);
    assert.equal(d.buttons.filter((b) => b.goesTo !== 'the order section').length, 0, 'no WhatsApp or external purchase buttons');
    assert.ok(!d.buttons.some((b) => /view your order|another order/i.test(b.text)), 'thank-you links are not purchase buttons');
    assert.equal(connectCheckout(html, { slug: 'larose-skincare', catalogue: [] }).html, html);
  });
});
