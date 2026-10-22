import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import request from 'supertest';
import { setup, resetDatabase, csrfToken, signUp, ORIGIN } from './helpers.js';
import { seedLarose } from '../src/scripts/seed-larose.js';
import { decrypt } from '../src/lib/secrets.js';

// Fake Meta Graph API and TikTok Events API that record what Skyfly sends.
const calls = [];
let failNext = 0;
const mock = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    calls.push({ url: req.url, headers: req.headers, body: JSON.parse(body || '{}') });
    if (failNext > 0) {
      failNext -= 1;
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'Invalid OAuth access token' }, code: 40001, message: 'Invalid token' }));
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(req.url.startsWith('/meta') ? JSON.stringify({ events_received: 1, fbtrace_id: 'x' }) : JSON.stringify({ code: 0, message: 'OK' }));
  });
});
await new Promise((r) => mock.listen(0, r));
const base = `http://127.0.0.1:${mock.address().port}`;

const encryptionKey = randomBytes(32);
const { pool, app } = setup({
  encryptionKey, metaGraphBase: `${base}/meta/v26.0`, tiktokApiBase: `${base}/tiktok/v1.3`,
});
const sha = (v) => createHash('sha256').update(v).digest('hex');
let owner;
let businessId;
let n = 0;

const META_TOKEN = 'EAAB-meta-secret-token-1234567890';
const TIKTOK_TOKEN = 'tiktok-secret-token-abcdefghijklmnop';

function save(fields, page = null) {
  const sent = (async () => {
    const path = `/businesses/${businessId}/pixels${page ? `?page=${page}` : ''}`;
    const _csrf = await csrfToken(owner, path);
    return owner.post(`/businesses/${businessId}/pixels`).type('form').send({ _csrf, ...(page ? { page } : {}), ...fields });
  })();
  return { expect: (status) => sent.then((res) => { assert.equal(res.status, status, res.text.slice(0, 300)); return res; }) };
}

async function placeOrder(overrides = {}) {
  n += 1;
  const res = await request(app).post('/api/public/orders').set('Origin', ORIGIN).set('User-Agent', 'TestBrowser/1.0').send({
    landingPage: 'larosenigeria', idempotencyKey: `pixel-test-key-${Date.now()}-${n}`,
    customer: { name: 'Amaka Nwosu', phone: '0803 555 0101', email: 'Amaka@Example.com', address: '7 Pixel Lane, Lagos', state: 'Lagos' },
    items: [{ product: 'package-3', quantity: 2 }],
    attribution: { pageUrl: 'https://roseskincare9-code.github.io/Larosenigeria/?fbclid=abc', fbp: 'fb.1.1700000000.111', fbc: 'fb.1.1700000000.abc', ttp: 'ttp-cookie', ttclid: 'tt-click' },
    ...overrides,
  }).expect(201);
  const { rows: [o] } = await pool.query('SELECT id FROM orders WHERE reference = $1', [res.body.reference]);
  return { ...res.body, id: o.id };
}

async function setPayment(orderId, status) {
  const path = `/businesses/${businessId}/orders/${orderId}`;
  const _csrf = await csrfToken(owner, path);
  await owner.post(`${path}/status`).type('form').send({ _csrf, kind: 'payment', status }).expect(302);
}

before(async () => {
  await resetDatabase(pool);
  owner = await signUp(app, { email: 'owner@larose.test' });
  businessId = await seedLarose(pool, 'owner@larose.test');
  await pool.query('DELETE FROM additional_pixels'); // these tests cover the main pixels only (see additional-pixels.test.js)
});
after(async () => {
  await pool.end();
  mock.close();
});

describe('pixel settings', () => {
  test('invalid IDs are rejected with a helpful message', async () => {
    const res = await save({ provider: 'meta', enabled: 'on', pixel_id: 'abc123' }).expect(400);
    assert.match(res.text, /should be a number of 10–20 digits/);
    const tt = await save({ provider: 'tiktok', enabled: 'on', pixel_id: 'x' }).expect(400);
    assert.match(tt.text, /10–40 letters and digits/);
  });

  test('server Purchase needs a token; tokens are encrypted and never shown again', async () => {
    assert.match((await save({ provider: 'meta', enabled: 'on', pixel_id: '123456789012345', server_purchase: 'on' }).expect(400)).text, /needs an access token/);
    await save({
      provider: 'meta', enabled: 'on', pixel_id: '123456789012345', events: ['PageView', 'InitiateCheckout', 'Lead'],
      server_purchase: 'on', access_token: META_TOKEN, test_event_code: 'TEST123',
    }).expect(302);
    await save({
      provider: 'tiktok', enabled: 'on', pixel_id: 'c4abcdefgh1234567890', events: ['PageView', 'Lead'],
      server_purchase: 'on', access_token: TIKTOK_TOKEN,
    }).expect(302);
    const { rows } = await pool.query('SELECT * FROM pixel_settings ORDER BY provider');
    assert.equal(rows[1].pixel_id, 'C4ABCDEFGH1234567890', 'TikTok ID upper-cased');
    for (const r of rows) {
      assert.ok(!JSON.stringify(r).includes(META_TOKEN) && !JSON.stringify(r).includes(TIKTOK_TOKEN), 'no plaintext token in DB');
    }
    assert.equal(decrypt(encryptionKey, rows[0].access_token_enc), META_TOKEN);
    const page = await owner.get(`/businesses/${businessId}/pixels`).expect(200);
    assert.ok(!page.text.includes(META_TOKEN) && !page.text.includes(TIKTOK_TOKEN));
    assert.match(page.text, /saved; leave blank to keep it/);

    // Saving again with a blank token keeps the stored one.
    await save({ provider: 'meta', enabled: 'on', pixel_id: '123456789012345', events: ['PageView', 'Lead'], server_purchase: 'on', test_event_code: 'TEST123' }).expect(302);
    const { rows: [meta] } = await pool.query("SELECT access_token_enc, events FROM pixel_settings WHERE provider = 'meta'");
    assert.equal(decrypt(encryptionKey, meta.access_token_enc), META_TOKEN);
    assert.deepEqual(meta.events, ['PageView', 'Lead']);
    const audit = await pool.query("SELECT details FROM audit_log WHERE action = 'pixel.updated'");
    assert.ok(!JSON.stringify(audit.rows).includes(META_TOKEN), 'tokens never in the audit log');
  });

  test('the public tracking config exposes pixel IDs and events only', async () => {
    const res = await request(app).get('/api/public/pages/larosenigeria/tracking').expect(200);
    assert.equal(res.headers['access-control-allow-origin'], '*');
    assert.deepEqual(res.body, {
      page: 'larosenigeria',
      pixels: [
        { provider: 'meta', id: '123456789012345', events: ['PageView', 'Lead'] },
        { provider: 'tiktok', id: 'C4ABCDEFGH1234567890', events: ['PageView', 'Lead'] },
      ],
    });
    assert.ok(!JSON.stringify(res.body).match(/TEST123|token/i));
  });

  test('the SDK is served for use on other sites', async () => {
    const res = await request(app).get('/sdk/skyfly.js').expect(200).expect('Content-Type', /javascript/);
    assert.equal(res.headers['cross-origin-resource-policy'], 'cross-origin');
    assert.match(res.text, /trackSingle/);
    // Purchase is fired from exactly one place: after a saved order (not a test), once per reference.
    assert.equal(res.text.match(/track\('Purchase'/g).length, 1);
    const fn = res.text.match(/function purchase\(data\) \{[\s\S]*?\n  \}/)[0];
    assert.match(fn, /data\.test\) return/);
    assert.match(fn, /localStorage/);
    assert.match(fn, /eventId: 'purchase_' \+ data\.reference/);
    assert.match(res.text, /if \(res\.ok && data && data\.ok\) \{[\s\S]*?purchase\(data\)/);
  });
});

describe('Purchase events', () => {
  test('placing an order sends nothing; marking it Paid sends one Purchase per platform', async () => {
    calls.length = 0;
    const order = await placeOrder();
    assert.equal(calls.length, 0, 'order submission is not a purchase');
    await setPayment(order.id, 'pending');
    assert.equal(calls.length, 0, 'payment pending is not a purchase');

    await setPayment(order.id, 'paid');
    assert.equal(calls.length, 2);
    const meta = calls.find((c) => c.url.startsWith('/meta'));
    const tiktok = calls.find((c) => c.url.startsWith('/tiktok'));

    assert.equal(meta.url, `/meta/v26.0/123456789012345/events?access_token=${encodeURIComponent(META_TOKEN)}`);
    const ev = meta.body.data[0];
    assert.equal(ev.event_name, 'Purchase');
    assert.equal(ev.event_id, `purchase_${order.reference}`);
    assert.equal(ev.action_source, 'website');
    assert.deepEqual(ev.user_data.ph, [sha('2348035550101')]);
    assert.deepEqual(ev.user_data.em, [sha('amaka@example.com')]);
    assert.equal(ev.user_data.fbp, 'fb.1.1700000000.111');
    assert.equal(ev.user_data.client_user_agent, 'TestBrowser/1.0');
    assert.equal(ev.custom_data.value, 103000);
    assert.equal(ev.custom_data.currency, 'NGN');
    assert.equal(meta.body.test_event_code, undefined, 'real orders are not sent as tests');
    assert.ok(!JSON.stringify(meta.body).includes('Amaka'), 'no unhashed personal data');

    assert.equal(tiktok.url, '/tiktok/v1.3/event/track/');
    assert.equal(tiktok.headers['access-token'], TIKTOK_TOKEN);
    assert.equal(tiktok.body.event_source_id, 'C4ABCDEFGH1234567890');
    assert.equal(tiktok.body.data[0].event, 'CompletePayment', 'same event name as the browser pixel, so TikTok deduplicates');
    assert.equal(tiktok.body.data[0].event_id, `purchase_${order.reference}`);
    assert.equal(tiktok.body.data[0].user.phone, sha('+2348035550101'));
    assert.equal(tiktok.body.data[0].user.ttclid, 'tt-click');
    assert.equal(tiktok.body.data[0].properties.value, 103000);

    const detail = await owner.get(`/businesses/${businessId}/orders/${order.id}`).expect(200);
    assert.equal((detail.text.match(/<span class="pill delivered">sent<\/span>/g) || []).length, 2);
  });

  test('marking Paid again never sends a duplicate', async () => {
    calls.length = 0;
    const order = await placeOrder();
    await setPayment(order.id, 'paid');
    await setPayment(order.id, 'unpaid');
    await setPayment(order.id, 'paid');
    assert.equal(calls.length, 2);
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM conversion_events WHERE order_id = $1', [order.id]);
    assert.equal(rows[0].n, 2);
  });

  test('a failed send is shown and can be retried with the same event ID', async () => {
    calls.length = 0;
    failNext = 1;
    const order = await placeOrder();
    await setPayment(order.id, 'paid');
    const { rows: [failed] } = await pool.query("SELECT * FROM conversion_events WHERE order_id = $1 AND status = 'failed'", [order.id]);
    assert.ok(failed);
    const detail = await owner.get(`/businesses/${businessId}/orders/${order.id}`).expect(200);
    assert.match(detail.text, /Retry/);
    const _csrf = await csrfToken(owner, `/businesses/${businessId}/orders/${order.id}`);
    await owner.post(`/businesses/${businessId}/orders/${order.id}/conversions/${failed.id}/retry`).type('form').send({ _csrf }).expect(302);
    const { rows: [after] } = await pool.query('SELECT status, attempts, event_id FROM conversion_events WHERE id = $1', [failed.id]);
    assert.deepEqual(after, { status: 'sent', attempts: 2, event_id: `purchase_${order.reference}` });
  });

  test('a page can use its own pixel instead of the business default', async () => {
    const { rows: [lp] } = await pool.query("SELECT id FROM landing_pages WHERE slug = 'larosenigeria'");
    await save({ provider: 'meta', enabled: 'on', pixel_id: '999999999999999', events: ['PageView'], server_purchase: 'on', access_token: 'EAAB-page-specific-token-999' }, lp.id).expect(302);
    await save({ provider: 'tiktok', pixel_id: 'C4ABCDEFGH1234567890' }, lp.id).expect(302); // TikTok off for this page
    calls.length = 0;
    const order = await placeOrder();
    await setPayment(order.id, 'paid');
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /\/999999999999999\/events\?access_token=EAAB-page-specific-token-999$/);
    const cfg = await request(app).get('/api/public/pages/larosenigeria/tracking').expect(200);
    assert.deepEqual(cfg.body.pixels, [{ provider: 'meta', id: '999999999999999', events: ['PageView'] }]);

    const _csrf = await csrfToken(owner, `/businesses/${businessId}/pixels?page=${lp.id}`);
    await owner.post(`/businesses/${businessId}/pixels/remove-override`).type('form').send({ _csrf, page: lp.id }).expect(302);
    const back = await request(app).get('/api/public/pages/larosenigeria/tracking').expect(200);
    assert.equal(back.body.pixels.length, 2);
  });

  test('the test button sends a Purchase marked with the test event code', async () => {
    calls.length = 0;
    const _csrf = await csrfToken(owner, `/businesses/${businessId}/pixels`);
    const res = await owner.post(`/businesses/${businessId}/pixels/test`).type('form').send({ _csrf, provider: 'meta' }).expect(200);
    assert.match(res.text, /Test Purchase accepted/);
    assert.equal(calls[0].body.test_event_code, 'TEST123');
    const csrf2 = await csrfToken(owner, `/businesses/${businessId}/pixels`);
    const tt = await owner.post(`/businesses/${businessId}/pixels/test`).type('form').send({ _csrf: csrf2, provider: 'tiktok' }).expect(502);
    assert.match(tt.text, /Add a test event code first/);
  });
});

describe('hosted page injection', () => {
  test('published pages get the SDK with pixel config; previews do not', async () => {
    const { rows: [lp] } = await pool.query("SELECT id FROM landing_pages WHERE slug = 'larosenigeria'");
    const _csrf = await csrfToken(owner, `/businesses/${businessId}/landing-pages/${lp.id}`);
    await owner.post(`/businesses/${businessId}/landing-pages/${lp.id}/upload`).field('_csrf', _csrf)
      .attach('file', Buffer.from('<!doctype html><html><head><title>L</title></head><body><h1>Larose glow packages, delivered</h1><div data-skyfly-checkout></div></body></html>'), 'index.html')
      .expect(302);
    const { rows: [v] } = await pool.query('SELECT id FROM page_versions WHERE landing_page_id = $1 ORDER BY id DESC LIMIT 1', [lp.id]);
    const page = await owner.get(`/businesses/${businessId}/landing-pages/${lp.id}`).expect(200);
    const preview = new URL(page.text.match(/href="(http:\/\/pages\.test\/_preview\/[^"]+)"/)[1]);
    const prev = await request(app).get(preview.pathname).set('Host', 'pages.test').expect(200);
    assert.doesNotMatch(prev.text, /__SKYFLY__|skyfly\.js/);

    const csrf2 = await csrfToken(owner, `/businesses/${businessId}/landing-pages/${lp.id}`);
    await owner.post(`/businesses/${businessId}/landing-pages/${lp.id}/publish`).type('form').send({ _csrf: csrf2, version_id: v.id }).expect(302);
    const live = await request(app).get('/larosenigeria/').set('Host', 'pages.test').expect(200);
    assert.match(live.text, /<script data-skyfly-config>window\.__SKYFLY__=/);
    const cfg = JSON.parse(live.text.match(/window\.__SKYFLY__=(\{.*?\});<\/script>/)[1]);
    assert.equal(cfg.page, 'larosenigeria');
    assert.equal(cfg.api, 'http://skyfly.test');
    assert.deepEqual(cfg.pixels.map((p) => p.id), ['123456789012345', 'C4ABCDEFGH1234567890']);
    assert.match(live.text, /<script src="http:\/\/skyfly\.test\/sdk\/skyfly\.js" defer><\/script><\/head>/);
    assert.ok(!live.text.includes(META_TOKEN));
  });
});

describe('Purchase when the order is saved (pixels set to count Purchase at save)', () => {
  const waitCalls = async (want) => { for (let i = 0; i < 50 && calls.length < want; i += 1) await new Promise((r) => setTimeout(r, 20)); };
  before(async () => {
    await pool.query("UPDATE pixel_settings SET events = ARRAY['PageView', 'Lead', 'Purchase'] WHERE business_id = $1 AND provider = 'meta'", [businessId]);
  });
  after(async () => {
    await pool.query("UPDATE pixel_settings SET events = ARRAY['PageView', 'Lead'] WHERE business_id = $1 AND provider = 'meta'", [businessId]);
  });

  test('one server Purchase per saved order, with the browser\'s event ID; replays, Paid and test orders add none', async () => {
    calls.length = 0;
    const key = `purchase-on-save-${Date.now()}`;
    const order = await placeOrder({ idempotencyKey: key });
    assert.equal(order.test, false);
    await waitCalls(1);
    assert.equal(calls.length, 1, 'only Meta (TikTok still counts at Paid)');
    const ev = calls[0].body.data[0];
    assert.equal(calls[0].url.startsWith('/meta'), true);
    assert.equal(ev.event_name, 'Purchase');
    assert.equal(ev.event_id, `purchase_${order.reference}`, 'same ID as the browser event, so Meta counts one');
    assert.equal(ev.custom_data.value, 103000);
    assert.equal(ev.custom_data.currency, 'NGN');

    // The same submission again (retry, double tap): same order, no new event.
    const again = await request(app).post('/api/public/orders').set('Origin', ORIGIN).send({
      landingPage: 'larosenigeria', idempotencyKey: key,
      customer: { name: 'Amaka Nwosu', phone: '0803 555 0101', email: 'Amaka@Example.com', address: '7 Pixel Lane, Lagos', state: 'Lagos' },
      items: [{ product: 'package-3', quantity: 2 }],
      attribution: { pageUrl: 'https://roseskincare9-code.github.io/Larosenigeria/?fbclid=abc', fbp: 'fb.1.1700000000.111', fbc: 'fb.1.1700000000.abc', ttp: 'ttp-cookie', ttclid: 'tt-click' },
    }).expect(200);
    assert.equal(again.body.replayed, true);
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(calls.length, 1);

    // Marking it Paid later: Meta already counted it; only TikTok (Purchase at Paid) sends.
    await setPayment(order.id, 'paid');
    assert.equal(calls.filter((c) => c.url.startsWith('/meta')).length, 1);
    assert.equal(calls.filter((c) => c.url.startsWith('/tiktok')).length, 1);
  });

  test('a test order is never sent as a real Purchase (only to Test events, when a test event code is saved)', async () => {
    calls.length = 0;
    const order = await placeOrder({ customer: { name: 'TEST ORDER pixel check', phone: '0803 555 0101', address: '7 Pixel Lane, Lagos' } });
    assert.equal(order.test, true, 'the page is told it is a test order');
    await new Promise((r) => setTimeout(r, 200));
    const { rows: [meta] } = await pool.query("SELECT test_event_code FROM pixel_settings WHERE business_id = $1 AND provider = 'meta'", [businessId]);
    const sent = calls.length;
    assert.ok(calls.every((c) => c.body.test_event_code), 'anything sent carries the test event code');
    assert.equal(sent, meta.test_event_code ? 1 : 0);
    await setPayment(order.id, 'paid');
    assert.equal(calls.length, sent, 'marking it Paid sends nothing');
  });

  test('a refused submission creates no order and no Purchase', async () => {
    calls.length = 0;
    const before = (await pool.query('SELECT count(*)::int AS n FROM orders')).rows[0].n;
    const res = await request(app).post('/api/public/orders').set('Origin', ORIGIN).send({
      landingPage: 'larosenigeria', idempotencyKey: `refused-${Date.now()}`, customer: { name: 'A', phone: '1', address: 'x' }, items: [{ product: 'package-3', quantity: 1 }],
    });
    assert.equal(res.status, 400);
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(calls.length, 0);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM orders')).rows[0].n, before);
  });
});
