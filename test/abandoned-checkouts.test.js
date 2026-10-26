// Abandoned checkouts: progress saved from two businesses' pages, priced by Skyfly, classified as
// abandoned after each business's own idle time, completed or recovered by the order (once), shown
// only to that business, never counted as orders, and erased/deleted by the retention policy.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { setup, resetDatabase, csrfToken, signUp } from './helpers.js';
import { hashPassword } from '../src/lib/passwords.js';
import { clearOriginCache } from '../src/lib/origins.js';
import { classifyCheckouts } from '../src/services/checkouts.js';

const { pool, app } = setup({ allowedOrigins: [] });
const SHOP = { a: 'https://shop-a.test', b: 'https://shop-b.test' };
const ids = {};
const agents = {};
const tok = (s) => `tok-${s}-0123456789abcdef`;

const save = (biz, body, { origin = SHOP[biz], text = false } = {}) => {
  const r = request(app).post('/api/public/checkouts').set('Origin', origin);
  const payload = { landingPage: `page-${biz}`, step: 'details', ...body };
  return text ? r.set('Content-Type', 'text/plain').send(JSON.stringify(payload)) : r.send(payload);
};
const order = (biz, body) => request(app).post('/api/public/orders').set('Origin', SHOP[biz]).send({
  landingPage: `page-${biz}`, idempotencyKey: `order-${biz}-${body.key}-0123456789`,
  customer: { name: 'Ada Obi', phone: '08051234567', address: '12 Allen Avenue, Ikeja', ...(body.customer || {}) },
  items: body.items || [{ product: `serum-${biz}`, quantity: 1 }], ...(body.checkoutId ? { checkoutId: body.checkoutId } : {}),
});
const session = async (token) => (await pool.query('SELECT * FROM checkout_sessions WHERE token = $1', [token])).rows[0];

before(async () => {
  await resetDatabase(pool);
  await signUp(app, { email: 'platform@skyfly.test' });
  for (const biz of ['a', 'b']) {
    const { rows: [u] } = await pool.query("INSERT INTO users (email, password_hash, name) VALUES ($1, $2, 'Owner') RETURNING id", [`owner-${biz}@shop.test`, await hashPassword('owner-password-123')]);
    const { rows: [b] } = await pool.query(
      `INSERT INTO businesses (owner_id, name, slug, currency, order_prefix, subscription_status, abandoned_after_minutes)
       VALUES ($1, $2, $3, 'NGN', $4, 'internal', $5) RETURNING id`, [u.id, `Shop ${biz.toUpperCase()}`, `shop-${biz}`, biz === 'a' ? 'SA' : 'SB', biz === 'a' ? 60 : 600]);
    await pool.query("INSERT INTO business_members (business_id, user_id, role) VALUES ($1, $2, 'owner')", [b.id, u.id]);
    const { rows: [p] } = await pool.query("INSERT INTO products (business_id, code, name, price_minor) VALUES ($1, $2, $3, $4) RETURNING id", [b.id, `serum-${biz}`, `Serum ${biz.toUpperCase()}`, 1500000]);
    const { rows: [lp] } = await pool.query(
      "INSERT INTO landing_pages (business_id, name, slug, url, status) VALUES ($1, $2, $3, $4, 'active') RETURNING id", [b.id, `Page ${biz}`, `page-${biz}`, `${SHOP[biz]}/`]);
    await pool.query('INSERT INTO landing_page_products (landing_page_id, product_id) VALUES ($1, $2)', [lp.id, p.id]);
    if (biz === 'a') {
      const { rows: [up] } = await pool.query("INSERT INTO products (business_id, code, name, price_minor) VALUES ($1, 'mist-a', 'Travel Mist', 300000) RETURNING id", [b.id]);
      await pool.query('UPDATE landing_pages SET upsell_product_id = $2 WHERE id = $1', [lp.id, up.id]);
    }
    ids[biz] = b.id;
    const agent = request.agent(app);
    const _csrf = await csrfToken(agent, '/login');
    await agent.post('/login').type('form').send({ _csrf, email: `owner-${biz}@shop.test`, password: 'owner-password-123' }).expect(302);
    agents[biz] = agent;
  }
  clearOriginCache();
});
after(async () => { await pool.end(); });

describe('saving checkout progress', () => {
  test('a started checkout is saved under its page\'s business, priced by Skyfly (never the browser), with the add-on', async () => {
    const res = await save('a', { token: tok('a1'), seq: 1, customer: { name: 'Ada Obi', phone: '0805 123 4567', email: 'ADA@example.com', address: '12 Allen' },
      items: [{ product: 'serum-a', quantity: 2, unitPrice: 1 }, { product: 'mist-a', quantity: 1, upsell: true }] }).expect(200);
    assert.equal(res.body.ok, true);
    const s = await session(tok('a1'));
    assert.equal(String(s.business_id), String(ids.a));
    assert.equal(s.status, 'active');
    assert.equal(s.phone, '+2348051234567');
    assert.equal(s.email, 'ada@example.com');
    assert.equal(Number(s.total_minor), 2 * 1500000 + 300000, 'Skyfly prices, not the browser\'s');
    assert.deepEqual(s.items.map((i) => [i.code, i.quantity, i.upsell]), [['serum-a', 2, false], ['mist-a', 1, true]]);
  });

  test('later changes update the same session; an older update arriving late is ignored; a page-close beacon (text/plain) is accepted', async () => {
    await save('a', { token: tok('a1'), seq: 3, customer: { name: 'Ada Obi', phone: '08051234567', address: '12 Allen Avenue, Ikeja' }, items: [{ product: 'serum-a', quantity: 1 }] }).expect(200);
    await save('a', { token: tok('a1'), seq: 2, customer: { name: 'Old', phone: '08051234567' }, items: [{ product: 'serum-a', quantity: 5 }] }).expect(200);
    let s = await session(tok('a1'));
    assert.equal(s.customer_name, 'Ada Obi');
    assert.equal(s.items[0].quantity, 1);
    await save('a', { token: tok('a1'), seq: 4, step: 'review', customer: { name: 'Ada Obi', phone: '08051234567', address: '12 Allen Avenue, Ikeja' }, items: [{ product: 'serum-a', quantity: 1 }] }, { text: true }).expect(200);
    s = await session(tok('a1'));
    assert.equal(s.step, 'review');
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM checkout_sessions')).rows[0].n, 1);
  });

  test('card-like numbers are never stored; unknown products are left out; nothing about payment is kept', async () => {
    await save('a', { token: tok('a2'), seq: 1, customer: { name: 'Bayo', phone: '08031112222', notes: 'card 4111 1111 1111 1111 please, or call +2348051234567 / ref 1793024123456789' }, items: [{ product: 'not-real', quantity: 1 }] }).expect(200);
    const s = await session(tok('a2'));
    assert.equal(s.notes, 'card [number removed] please, or call +2348051234567 / ref 1793024123456789', 'card number removed; phone and a non-card number kept');
    assert.deepEqual(s.items, []);
    const cols = (await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'checkout_sessions'")).rows.map((r) => r.column_name);
    assert.ok(!cols.some((c) => /card|cvv|payment|iban|account/.test(c)), cols.join(','));
  });

  test('another website, or another business\'s page, cannot write to a business\'s checkout', async () => {
    await save('a', { token: tok('a3'), seq: 1, customer: { name: 'X' } }, { origin: 'https://evil.test' }).expect(403);
    await save('a', { token: tok('a3'), seq: 1, customer: { name: 'X' } }, { origin: SHOP.b }).expect(403);
    const hijack = await save('b', { token: tok('a1'), seq: 99, customer: { name: 'Hijacker', phone: '08099999999' }, items: [{ product: 'serum-b', quantity: 1 }] }).expect(200);
    assert.equal(hijack.body.ended, true);
    const s = await session(tok('a1'));
    assert.equal(String(s.business_id), String(ids.a));
    assert.equal(s.customer_name, 'Ada Obi');
  });

  test('sessions are not orders: no order, no Purchase event, nothing for the Google Sheet', async () => {
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM orders')).rows[0].n, 0);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM conversion_events')).rows[0].n, 0);
  });
});

describe('abandoned, resumed, ordered', () => {
  test('idle longer than the business\'s set time → abandoned; another business with a longer time keeps its session active', async () => {
    await save('b', { token: tok('b1'), seq: 1, customer: { name: 'Bola', phone: '08022223333' }, items: [{ product: 'serum-b', quantity: 1 }] }).expect(200);
    await pool.query("UPDATE checkout_sessions SET last_activity_at = now() - interval '2 hours'");
    const r = await classifyCheckouts(pool);
    assert.equal(r.abandoned, 2, 'business A (60 minutes): both of its sessions');
    assert.equal((await session(tok('a1'))).status, 'abandoned');
    assert.equal((await session(tok('b1'))).status, 'active', 'business B waits 600 minutes');
  });

  test('a resume link brings back the chosen products only (no personal details)', async () => {
    const res = await request(app).get(`/api/public/checkouts/${tok('a1')}`).set('Origin', SHOP.a).expect(200);
    assert.deepEqual(res.body, { ok: true, landingPage: 'page-a', step: 'review', items: [{ product: 'serum-a', quantity: 1, upsell: false }] });
    assert.ok(!JSON.stringify(res.body).includes('Ada'));
    await request(app).get('/api/public/checkouts/not-a-real-token-12345').set('Origin', SHOP.a).expect(404);
  });

  test('the customer comes back (active again), orders, and the session becomes recovered; a retry creates no second order', async () => {
    await save('a', { token: tok('a1'), seq: 5, customer: { name: 'Ada Obi', phone: '08051234567', address: '12 Allen Avenue, Ikeja' }, items: [{ product: 'serum-a', quantity: 1 }] }).expect(200);
    assert.equal((await session(tok('a1'))).status, 'active');
    const first = await order('a', { key: 'r1', checkoutId: tok('a1') }).expect(201);
    const again = await order('a', { key: 'r1', checkoutId: tok('a1') }).expect(200);
    assert.equal(again.body.reference, first.body.reference);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM orders')).rows[0].n, 1);
    const s = await session(tok('a1'));
    assert.equal(s.status, 'recovered');
    assert.ok(s.order_id);
    // Later saves with the same session ID are refused: the page starts a new session.
    const late = await save('a', { token: tok('a1'), seq: 6, customer: { name: 'Ada' } }).expect(200);
    assert.equal(late.body.ended, true);
    assert.equal((await session(tok('a1'))).status, 'recovered');
  });

  test('an order from a page that does not send the session ID is matched by phone (same business only) → completed', async () => {
    const res = await order('b', { key: 'p1', customer: { name: 'Bola', phone: '+2348022223333' }, items: [{ product: 'serum-b', quantity: 1 }] }).expect(201);
    const s = await session(tok('b1'));
    assert.equal(s.status, 'completed');
    const { rows: [o] } = await pool.query('SELECT id FROM orders WHERE reference = $1', [res.body.reference]);
    assert.equal(String(s.order_id), String(o.id));
    // Business A's session with a different phone is untouched.
    assert.equal((await session(tok('a2'))).status, 'abandoned');
  });
});

describe('dashboard', () => {
  test('each owner sees only its own business\'s checkouts, with status, contact details, products and value', async () => {
    const a = await agents.a.get(`/businesses/${ids.a}/checkouts?status=all`).expect(200);
    assert.match(a.text, /Ada Obi/);
    assert.match(a.text, /Recovered/);
    assert.doesNotMatch(a.text, /Bola/);
    const b = await agents.b.get(`/businesses/${ids.b}/checkouts?status=all`).expect(200);
    assert.match(b.text, /Bola/);
    assert.doesNotMatch(b.text, /Ada Obi/);
    await agents.a.get(`/businesses/${ids.b}/checkouts`).expect(404);
    const { rows: [sb] } = await pool.query('SELECT id FROM checkout_sessions WHERE token = $1', [tok('b1')]);
    await agents.a.get(`/businesses/${ids.a}/checkouts/${sb.id}`).expect(404);
    const _csrf = await csrfToken(agents.a, `/businesses/${ids.a}/checkouts`);
    await agents.a.post(`/businesses/${ids.a}/checkouts/${sb.id}/contacted`).type('form').send({ _csrf, channel: 'call' }).expect(404);
  });

  test('the abandoned filter lists abandoned checkouts; follow-up offers WhatsApp/call/email with a resume link, and logs contact', async () => {
    const list = await agents.a.get(`/businesses/${ids.a}/checkouts`).expect(200);
    assert.match(list.text, /Bayo/);
    assert.doesNotMatch(list.text, /Ada Obi/, 'recovered is not in the abandoned list');
    const { rows: [s] } = await pool.query('SELECT id FROM checkout_sessions WHERE token = $1', [tok('a2')]);
    const detail = await agents.a.get(`/businesses/${ids.a}/checkouts/${s.id}`).expect(200);
    assert.match(detail.text, /https:\/\/wa\.me\/2348031112222\?text=/);
    assert.match(detail.text, /tel:\+2348031112222/);
    assert.ok(detail.text.includes(`skyfly_checkout=${tok('a2')}`));
    const _csrf = await csrfToken(agents.a, `/businesses/${ids.a}/checkouts/${s.id}`);
    await agents.a.post(`/businesses/${ids.a}/checkouts/${s.id}/contacted`).type('form').send({ _csrf, channel: 'whatsapp' }).expect(302);
    const { rows: [after] } = await pool.query('SELECT follow_up_count FROM checkout_sessions WHERE id = $1', [s.id]);
    assert.equal(after.follow_up_count, 1);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM audit_log WHERE action = 'checkouts.contacted'")).rows[0].n, 1);
  });

  test('orders and revenue are unchanged by checkouts: the Orders list shows orders only', async () => {
    const orders = await agents.a.get(`/businesses/${ids.a}/orders`).expect(200);
    assert.doesNotMatch(orders.text, /Bayo/);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM orders WHERE business_id = $1', [ids.a])).rows[0].n, 1);
  });

  test('the idle time is set per business (10 minutes to 7 days)', async () => {
    const _csrf = await csrfToken(agents.a, `/businesses/${ids.a}/checkouts`);
    await agents.a.post(`/businesses/${ids.a}/checkouts/settings`).type('form').send({ _csrf, abandoned_after_minutes: '5' }).expect(400);
    await agents.a.post(`/businesses/${ids.a}/checkouts/settings`).type('form').send({ _csrf, abandoned_after_minutes: '120' }).expect(302);
    assert.equal((await pool.query('SELECT abandoned_after_minutes FROM businesses WHERE id = $1', [ids.a])).rows[0].abandoned_after_minutes, 120);
    assert.equal((await pool.query('SELECT abandoned_after_minutes FROM businesses WHERE id = $1', [ids.b])).rows[0].abandoned_after_minutes, 600);
  });
});

describe('retention', () => {
  test('30 days: abandoned → expired with personal details erased; ordered sessions keep only the order link; 180 days: deleted', async () => {
    await pool.query("UPDATE checkout_sessions SET last_activity_at = now() - interval '31 days' WHERE token = $1", [tok('a2')]);
    await pool.query("UPDATE checkout_sessions SET completed_at = now() - interval '31 days' WHERE token = $1", [tok('a1')]);
    await save('b', { token: tok('b9'), seq: 1, customer: { name: 'Old' }, items: [] }).expect(200);
    await pool.query("UPDATE checkout_sessions SET last_activity_at = now() - interval '181 days' WHERE token = $1", [tok('b9')]);
    await classifyCheckouts(pool);
    const expired = await session(tok('a2'));
    assert.equal(expired.status, 'expired');
    assert.deepEqual([expired.customer_name, expired.phone, expired.email, expired.address, expired.notes], [null, null, null, null, null]);
    const ordered = await session(tok('a1'));
    assert.equal(ordered.customer_name, null);
    assert.ok(ordered.order_id, 'still linked to its order');
    assert.equal(await session(tok('b9')), undefined);
    const page = await agents.a.get(`/businesses/${ids.a}/checkouts?status=expired`).expect(200);
    assert.match(page.text, /Details erased/);
  });
});
