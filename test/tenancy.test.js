// Multi-tenant client workspaces: platform owner, client invitations, roles, isolation
// between two client businesses, order routing, subscriptions (expiry, locking, renewal).
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { setup, resetDatabase, csrfToken, signUp, ORIGIN } from './helpers.js';
import { seedLarose } from '../src/scripts/seed-larose.js';
import { expireSubscriptions } from '../src/services/tenancy.js';
import { clearOriginCache } from '../src/lib/origins.js';
import { newApiKey } from '../src/lib/apiKeys.js';

// Real production rule: sign-up only for the first account (then by invitation or when opened).
const { pool, app } = setup({ signupFirstOnly: true });
let admin;
const biz = {};      // name -> { id, owner agent }
let n = 0;

async function form(agent, path, body, from = '/admin') {
  const _csrf = await csrfToken(agent, from);
  return agent.post(path).type('form').send({ _csrf, ...body });
}
const localToday = async (id) => (await pool.query('SELECT (now() AT TIME ZONE timezone)::date::text AS d FROM businesses WHERE id = $1', [id])).rows[0].d;
const shift = (date, days) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 864e5).toISOString().slice(0, 10);
const order = (page, product, name, key = `tenancy-test-key-${String(n += 1).padStart(6, '0')}`) => request(app).post('/api/public/orders').set('Origin', ORIGIN).send({
  landingPage: page, idempotencyKey: key,
  customer: { name, phone: '08051234567', address: '3 Test Close, Ikeja', state: 'Lagos', email: `${name.split(' ')[0].toLowerCase()}@example.test` },
  items: [{ product, quantity: 1 }], attribution: { utm_source: 'tiktok', utm_campaign: 'oct' },
});

// The platform owner creates a client business; the client accepts the invitation by creating an account.
async function createClient(name, email, extra = {}) {
  const res = await form(admin, '/admin/businesses', {
    name, owner_email: email, currency: 'NGN', timezone: 'Africa/Lagos', subscription_status: 'active',
    subscription_currency: 'NGN', price: '15,000', started_on: await localTodayLagos(), expires_on: shift(await localTodayLagos(), 30), ...extra,
  }, '/admin/businesses/new');
  assert.equal(res.status, 200, res.text.slice(0, 300));
  const link = res.text.match(/\/invite\/([A-Za-z0-9_-]+)/)[1];
  const client = request.agent(app);
  const page = await client.get(`/invite/${link}`).expect(200);
  assert.match(page.text, new RegExp(`Join ${name}`));
  const _csrf = page.text.match(/name="_csrf" value="([^"]+)"/)[1];
  const joined = await client.post(`/invite/${link}`).type('form').send({ _csrf, name: `${name} Owner`, password: 'client-password-123' });
  assert.equal(joined.status, 302);
  const id = Number(joined.headers.location.match(/businesses\/(\d+)/)[1]);
  return { id, client, link };
}
async function localTodayLagos() { return (await pool.query("SELECT (now() AT TIME ZONE 'Africa/Lagos')::date::text AS d")).rows[0].d; }

before(async () => {
  await resetDatabase(pool);
  admin = await signUp(app, { name: 'Platform Owner', email: 'owner@larose.test' });
  await seedLarose(pool, 'owner@larose.test');
  for (const [key, name, email, slug, code, price] of [['A', 'Glow Shop A', 'a@client.test', 'glow-a', 'serum-a', 1200000], ['B', 'Beauty Shop B', 'b@client.test', 'beauty-b', 'cream-b', 800000]]) {
    const { id, client } = await createClient(name, email);
    const p = (await pool.query('INSERT INTO products (business_id, code, name, price_minor) VALUES ($1, $2, $3, $4) RETURNING id', [id, code, `${name} product`, price])).rows[0].id;
    const lp = (await pool.query("INSERT INTO landing_pages (business_id, slug, name, url, status) VALUES ($1, $2, $3, $4, 'active') RETURNING id", [id, slug, `${name} page`, `${ORIGIN}/${slug}/`])).rows[0].id;
    await pool.query('INSERT INTO landing_page_products (landing_page_id, product_id) VALUES ($1, $2)', [lp, p]);
    biz[key] = { id, client, slug, code, page: lp };
  }
  clearOriginCache();
});
after(() => pool.end());

describe('platform owner and client workspaces', () => {
  test('the first account is the platform owner; clients join only by invitation (sign-up is closed)', async () => {
    const { rows } = await pool.query('SELECT email, is_platform_admin FROM users ORDER BY id');
    assert.deepEqual(rows.map((r) => [r.email, r.is_platform_admin]), [['owner@larose.test', true], ['a@client.test', false], ['b@client.test', false]]);
    await request(app).get('/signup').expect(404);
    await biz.A.client.get('/admin').expect(404);
  });

  test('the platform owner dashboard lists every client with subscription, expiry and setup status', async () => {
    const res = await admin.get('/admin').expect(200);
    for (const name of ['Larose Natural Skincare Nigeria', 'Glow Shop A', 'Beauty Shop B']) assert.match(res.text, new RegExp(name));
    assert.match(res.text, /a@client\.test/);
    assert.match(res.text, /₦15,000\/month/);
    assert.match(res.text, /Internal \(never expires\)/);
    assert.match(res.text, /To do: First order, Email sending/);
  });

  test('a client with one business lands straight in its own dashboard, with only the essential sections', async () => {
    const home = await biz.A.client.get('/').expect(302);
    assert.equal(home.headers.location, `/businesses/${biz.A.id}`);
    const dash = await biz.A.client.get(`/businesses/${biz.A.id}`).expect(200);
    const nav = dash.text.match(/<nav class="side-nav">([\s\S]*?)<\/nav>/)[1];
    for (const label of ['Overview', 'Orders', 'Products', 'Customers', 'Landing Pages', 'Email Contacts', 'Email Automations', 'Tracking &amp; Pixels', 'Integrations', 'Subscription', 'Settings']) assert.ok(nav.includes(label), label);
    assert.ok(!nav.includes('Platform admin'));
    assert.doesNotMatch(nav, /Ads|Campaign/i);
  });
});

describe('business isolation (two client businesses)', () => {
  test('each landing page\'s order lands only in its own business, with prices and tracking kept', async () => {
    const a = await order(biz.A.slug, biz.A.code, 'Adaeze Alpha');
    const b = await order(biz.B.slug, biz.B.code, 'Bola Beta');
    assert.equal(a.status, 201, JSON.stringify(a.body));
    assert.equal(b.status, 201);
    const { rows } = await pool.query('SELECT business_id, total_minor, utm_source, utm_campaign FROM orders WHERE reference = ANY($1) ORDER BY business_id', [[a.body.reference, b.body.reference]]);
    assert.deepEqual(rows.map((r) => [r.business_id, r.total_minor, r.utm_source, r.utm_campaign]), [[biz.A.id, 1200000, 'tiktok', 'oct'], [biz.B.id, 800000, 'tiktok', 'oct']]);
    const listA = await biz.A.client.get(`/businesses/${biz.A.id}/orders`).expect(200);
    assert.match(listA.text, /Adaeze Alpha/);
    assert.doesNotMatch(listA.text, /Bola Beta/);
    const listB = await biz.B.client.get(`/businesses/${biz.B.id}/orders`).expect(200);
    assert.match(listB.text, /Bola Beta/);
    assert.doesNotMatch(listB.text, /Adaeze Alpha/);
    // A page can only order its own business's products.
    const cross = await order(biz.A.slug, biz.B.code, 'Cross Shop');
    assert.equal(cross.status, 400);
  });

  test('a duplicate submission returns the same order and creates nothing new', async () => {
    const first = await order(biz.A.slug, biz.A.code, 'Double Tap', 'tenancy-duplicate-key-0001');
    const again = await order(biz.A.slug, biz.A.code, 'Double Tap', 'tenancy-duplicate-key-0001');
    assert.equal(again.status, 200);
    assert.equal(again.body.reference, first.body.reference);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM orders WHERE customer_name = 'Double Tap'")).rows[0].n, 1);
  });

  test('a client cannot open any section, record or export of another business by changing the ID', async () => {
    const { rows: [bOrder] } = await pool.query('SELECT id FROM orders WHERE business_id = $1 LIMIT 1', [biz.B.id]);
    const paths = ['', '/orders', `/orders/${bOrder.id}`, '/orders/export.csv', '/products', '/customers', '/landing-pages', `/landing-pages/${biz.B.page}`,
      '/pixels', '/integrations', '/google-sheets', '/email', '/email-contacts', '/email-contacts/export.csv', '/team', '/settings', '/subscription', '/analytics'];
    for (const p of paths) await biz.A.client.get(`/businesses/${biz.B.id}${p}`).expect(404);
    // B's order is not reachable through A's own workspace either.
    await biz.A.client.get(`/businesses/${biz.A.id}/orders/${bOrder.id}`).expect(404);
    const _csrf = await csrfToken(biz.A.client, `/businesses/${biz.A.id}/orders`);
    await biz.A.client.post(`/businesses/${biz.B.id}/orders/${bOrder.id}/status`).type('form').send({ _csrf, kind: 'fulfillment', status: 'cancelled' }).expect(404);
    await biz.A.client.post(`/businesses/${biz.A.id}/orders/${bOrder.id}/status`).type('form').send({ _csrf, kind: 'fulfillment', status: 'cancelled' }).expect(404);
    assert.notEqual((await pool.query('SELECT status FROM orders WHERE id = $1', [bOrder.id])).rows[0].status, 'cancelled');
    const csv = await biz.A.client.get(`/businesses/${biz.A.id}/orders/export.csv`).expect(200);
    assert.doesNotMatch(csv.text, /Bola Beta|bola@example/);
    const contacts = await biz.A.client.get(`/businesses/${biz.A.id}/email-contacts`).expect(200);
    assert.match(contacts.text, /adaeze@example\.test|No contacts yet/);
    assert.doesNotMatch(contacts.text, /bola@example\.test/);
  });

  test('the platform owner can open a client workspace for support, and it is logged', async () => {
    await admin.get(`/businesses/${biz.B.id}/orders`).expect(200);
    const { rows } = await pool.query("SELECT 1 FROM audit_log WHERE business_id = $1 AND action = 'admin.workspace_opened'", [biz.B.id]);
    assert.equal(rows.length, 1);
  });
});

describe('roles', () => {
  test('a staff member sees orders and customers only, and can update an order status', async () => {
    const res = await form(biz.A.client, `/businesses/${biz.A.id}/team/invite`, { email: 'staff@client.test', role: 'staff' }, `/businesses/${biz.A.id}/team`);
    const token = res.text.match(/\/invite\/([A-Za-z0-9_-]+)/)[1];
    const staff = request.agent(app);
    const page = await staff.get(`/invite/${token}`).expect(200);
    await staff.post(`/invite/${token}`).type('form').send({ _csrf: page.text.match(/name="_csrf" value="([^"]+)"/)[1], name: 'Sam Staff', password: 'staff-password-123' }).expect(302);
    await staff.get(`/businesses/${biz.A.id}/orders`).expect(200);
    await staff.get(`/businesses/${biz.A.id}/customers`).expect(200);
    for (const p of ['/products', '/landing-pages', '/settings', '/pixels', '/email', '/email-contacts', '/team', '/google-sheets']) await staff.get(`/businesses/${biz.A.id}${p}`).expect(403);
    const { rows: [o] } = await pool.query('SELECT id FROM orders WHERE business_id = $1 ORDER BY id LIMIT 1', [biz.A.id]);
    const _csrf = await csrfToken(staff, `/businesses/${biz.A.id}/orders/${o.id}`);
    await staff.post(`/businesses/${biz.A.id}/orders/${o.id}/status`).type('form').send({ _csrf, kind: 'fulfillment', status: 'processing' }).expect(302);
    const { rows: [h] } = await pool.query("SELECT h.to_status, u.email FROM order_status_history h JOIN users u ON u.id = h.changed_by WHERE h.order_id = $1 ORDER BY h.id DESC LIMIT 1", [o.id]);
    assert.deepEqual([h.to_status, h.email], ['processing', 'staff@client.test'], 'the change is recorded with who made it');
    // Staff are not in B at all.
    await staff.get(`/businesses/${biz.B.id}/orders`).expect(404);
  });

  test('a business always keeps an owner', async () => {
    const { rows: [u] } = await pool.query("SELECT id FROM users WHERE email = 'a@client.test'");
    const res = await form(biz.A.client, `/businesses/${biz.A.id}/team/members/${u.id}/role`, { role: 'staff' }, `/businesses/${biz.A.id}/team`);
    assert.equal(res.status, 400);
    assert.match(res.text, /at least one owner/);
  });
});

describe('subscriptions', () => {
  test('access continues through the whole expiry day in the business\'s own time zone, in any time zone', async () => {
    for (const tz of ['Pacific/Kiritimati', 'Pacific/Pago_Pago', 'Africa/Lagos']) {
      await pool.query('UPDATE businesses SET timezone = $2 WHERE id = $1', [biz.B.id, tz]);
      const today = await localToday(biz.B.id);
      await pool.query("UPDATE businesses SET subscription_status = 'active', subscription_expires_on = $2 WHERE id = $1", [biz.B.id, today]);
      assert.equal(await expireSubscriptions(pool), 0, `${tz}: not expired on its last day`);
      await biz.B.client.get(`/businesses/${biz.B.id}/orders`).expect(200);
    }
  });

  test('after the expiry date the client is locked out of the workspace and the business API; all data is kept', async () => {
    const { rows: [before] } = await pool.query('SELECT count(*)::int AS orders FROM orders WHERE business_id = $1', [biz.B.id]);
    const yesterday = shift(await localToday(biz.B.id), -1);
    await pool.query("UPDATE businesses SET subscription_status = 'active', subscription_expires_on = $2 WHERE id = $1", [biz.B.id, yesterday]);
    // Even before the background job runs, every request checks the date.
    const res = await biz.B.client.get(`/businesses/${biz.B.id}/orders`).expect(402);
    assert.match(res.text, /Subscription expired/);
    assert.match(res.text, /Nothing has been deleted/);
    await biz.B.client.get(`/businesses/${biz.B.id}`).expect(402);
    const _csrf = await csrfToken(biz.B.client, '/?all=1');
    await biz.B.client.post(`/businesses/${biz.B.id}/products`).type('form').send({ _csrf, name: 'X', code: 'x', price: '1' }).expect(402);
    const { rows: [b] } = await pool.query('SELECT subscription_status FROM businesses WHERE id = $1', [biz.B.id]);
    assert.equal(b.subscription_status, 'expired', 'marked expired');
    const { rows: [logged] } = await pool.query("SELECT details FROM audit_log WHERE business_id = $1 AND action = 'subscription.expired'", [biz.B.id]);
    assert.equal(logged.details.expiredOn, yesterday);
    // Business API key is refused.
    const { key, prefix, hash } = newApiKey();
    await pool.query("INSERT INTO api_keys (business_id, name, key_prefix, key_hash) VALUES ($1, 'test', $2, $3)", [biz.B.id, prefix, hash]);
    const api = await request(app).post('/api/public/orders').set('Authorization', `Bearer ${key}`)
      .send({ landingPage: biz.B.slug, idempotencyKey: 'tenancy-api-key-000001', customer: { name: 'Api Customer', phone: '08051234567', address: '1 Api Street' }, items: [{ product: biz.B.code, quantity: 1 }] });
    assert.equal(api.status, 402);
    assert.equal(api.body.error, 'SUBSCRIPTION_INACTIVE');
    const { rows: [afterCount] } = await pool.query('SELECT count(*)::int AS orders FROM orders WHERE business_id = $1', [biz.B.id]);
    assert.equal(afterCount.orders, before.orders, 'no data deleted');
    // The platform owner is never locked out.
    await admin.get(`/businesses/${biz.B.id}/orders`).expect(200);
    // Business A is unaffected.
    await biz.A.client.get(`/businesses/${biz.A.id}/orders`).expect(200);
  });

  test('a past expiry date cannot be saved as active by mistake', async () => {
    const res = await form(admin, `/admin/businesses/${biz.B.id}/subscription`, {
      subscription_status: 'active', subscription_currency: 'NGN', price: '15000', expires_on: shift(await localToday(biz.B.id), -3),
    }, `/admin/businesses/${biz.B.id}`);
    assert.equal(res.status, 400);
    assert.match(res.text, /has already passed/);
  });

  test('the platform owner renews with a new date: access returns and the change is in the audit log', async () => {
    const newDate = shift(await localToday(biz.B.id), 31);
    const res = await form(admin, `/admin/businesses/${biz.B.id}/renew`, { expires_on: newDate, reference: 'bank transfer TEST' }, `/admin/businesses/${biz.B.id}`);
    assert.equal(res.status, 302);
    const { rows: [b] } = await pool.query('SELECT subscription_status, subscription_expires_on, subscription_notes FROM businesses WHERE id = $1', [biz.B.id]);
    assert.deepEqual([b.subscription_status, b.subscription_expires_on], ['active', newDate]);
    assert.match(b.subscription_notes, /bank transfer TEST/);
    await biz.B.client.get(`/businesses/${biz.B.id}/orders`).expect(200);
    const { rows: [log] } = await pool.query("SELECT details, user_id FROM audit_log WHERE business_id = $1 AND action = 'subscription.renewed' ORDER BY id DESC LIMIT 1", [biz.B.id]);
    assert.equal(log.details.after.expires, newDate);
    assert.equal(log.details.before.status, 'expired');
    assert.ok(log.user_id);
    const page = await admin.get(`/admin/businesses/${biz.B.id}`).expect(200);
    assert.match(page.text, /subscription\.renewed/);
  });

  test('lock and unlock by the platform owner', async () => {
    await form(admin, `/admin/businesses/${biz.B.id}/lock`, {}, `/admin/businesses/${biz.B.id}`);
    const locked = await biz.B.client.get(`/businesses/${biz.B.id}`).expect(402);
    assert.match(locked.text, /Account locked/);
    await form(admin, `/admin/businesses/${biz.B.id}/unlock`, {}, `/admin/businesses/${biz.B.id}`);
    await biz.B.client.get(`/businesses/${biz.B.id}`).expect(200);
  });

  test('the client sees their own subscription status and date', async () => {
    const res = await biz.B.client.get(`/businesses/${biz.B.id}/subscription`).expect(200);
    assert.match(res.text, /Active/);
    assert.match(res.text, /₦15,000/);
  });

  test('with open sign-up, a new client creates a business that starts as a trial', async () => {
    await form(admin, '/admin/settings', { client_signup: 'open', trial_days: '5', renewal_instructions: 'Pay to account 0123456789 and send the receipt on WhatsApp.' }, '/admin/settings');
    const newbie = await signUp(app, { name: 'New Client', email: 'new@client.test' });
    const _csrf = await csrfToken(newbie, '/');
    const res = await newbie.post('/businesses').type('form').send({ _csrf, name: 'Newbie Naturals' }).expect(302);
    const id = res.headers.location.match(/businesses\/(\d+)/)[1];
    const { rows: [b] } = await pool.query('SELECT subscription_status, subscription_expires_on, (now() AT TIME ZONE timezone)::date::text AS today FROM businesses WHERE id = $1', [id]);
    assert.deepEqual([b.subscription_status, b.subscription_expires_on], ['trial', shift(b.today, 5)]);
    // When the trial ends, the renewal instructions from Platform settings are shown.
    await pool.query("UPDATE businesses SET subscription_expires_on = (now() AT TIME ZONE timezone)::date - 1 WHERE id = $1", [id]);
    const locked = await newbie.get(`/businesses/${id}`).expect(402);
    assert.match(locked.text, /Pay to account 0123456789/);
  });
});
