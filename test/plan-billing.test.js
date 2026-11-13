// Skyfly's own plan billing (Business Pro ₦199,000 / Agency VIP ₦399,000 a month) through Paystack, against
// a stand-in Paystack that behaves like the real API. A plan is switched on only by Paystack's own answer
// (server-side verify, or a webhook whose HMAC-SHA512 signature checks out) with the exact amount and
// currency; reaching the return page alone, a forged webhook, a failed or short payment change nothing;
// each payment applies once; a renewal continues from the paid-until date; expiry alerts go to Super
// Admins once per step; owners see and pay for their own business only.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHmac } from 'node:crypto';
import request from 'supertest';
import { setup, resetDatabase, csrfToken, signUp, openClientSignup, adminSignIn } from './helpers.js';
import { remindSubscriptions, reconcileBilling } from '../src/services/billing.js';
import { hashPassword } from '../src/lib/passwords.js';

// ---------- stand-in Paystack
const ps = { tx: {}, calls: [] };
const mock = createServer(async (req, res) => {
  let raw = ''; for await (const c of req) raw += c;
  const p = new URL(req.url, 'http://x').pathname;
  ps.calls.push({ method: req.method, path: p, auth: req.headers.authorization, body: raw ? JSON.parse(raw) : null });
  const send = (o, s = 200) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (req.headers.authorization !== 'Bearer sk_test_skyfly_platform') return send({ status: false, message: 'Invalid key' }, 401);
  if (p === '/transaction/initialize' && req.method === 'POST') {
    const b = JSON.parse(raw);
    ps.tx[b.reference] = { reference: b.reference, amount: b.amount, currency: b.currency, status: 'ongoing', channel: 'card', email: b.email };
    return send({ status: true, message: 'Authorization URL created', data: { authorization_url: `https://checkout.paystack.com/${b.reference}`, access_code: 'ac', reference: b.reference } });
  }
  const v = /^\/transaction\/verify\/(.+)$/.exec(p);
  if (v) { const t = ps.tx[decodeURIComponent(v[1])]; return t ? send({ status: true, message: 'Verification successful', data: { ...t, paid_at: t.status === 'success' ? new Date().toISOString() : null, gateway_response: t.status === 'failed' ? 'Declined' : 'Approved' } }) : send({ status: false, message: 'Transaction reference not found' }, 400); }
  send({ status: false, message: 'not mocked' }, 404);
});
await new Promise((r) => mock.listen(0, r));
const PS = `http://127.0.0.1:${mock.address().port}`;

const realFetch = globalThis.fetch;
const mailed = [];
globalThis.fetch = async (url, opts) => {
  if (String(url).startsWith('https://api.resend.com/')) { mailed.push(JSON.parse(opts.body)); return new Response('{"id":"m"}', { status: 200 }); }
  return realFetch(url, opts);
};

const SECRET = 'sk_test_skyfly_platform';
const notifyEmail = { provider: 'resend', apiKey: 're_test_not_real_000', fromEmail: 'no-reply@skyfly.test', fromName: 'Skyfly' };
const { pool, config, app: expressApp } = setup({ payments: { paystack: { secretKey: SECRET, mode: 'test', apiBase: PS } }, notifyEmail });
const off = setup({ allowedOrigins: [] });
const app = expressApp.listen(0);
const offApp = off.app.listen(0);
let admin; let ownerA; let ownerB; let staffA; let A; let B;

const biz = (id) => pool.query("SELECT plan, subscription_status, subscription_price_minor::int AS price, subscription_started_on::text AS started, subscription_expires_on::text AS expires, (now() AT TIME ZONE timezone)::date::text AS today FROM businesses WHERE id = $1", [id]).then((r) => r.rows[0]);
const sql1 = async (q, p = []) => Object.values((await pool.query(q, p)).rows[0])[0];
const checkout = async (agent, id, plan) => { const _csrf = await csrfToken(agent, `/businesses/${id}/subscription`); return agent.post(`/businesses/${id}/subscription/checkout`).type('form').send({ _csrf, plan }); };
const lastRef = (id) => sql1('SELECT reference FROM subscription_payments WHERE business_id = $1 ORDER BY id DESC LIMIT 1', [id]);
const hook = (event, secret = SECRET) => { const body = JSON.stringify(event); return request(app).post('/webhooks/paystack').set('Content-Type', 'application/json').set('x-paystack-signature', createHmac('sha512', secret).update(body).digest('hex')).send(body); };
const addMonth = (d) => sql1("SELECT ($1::date + interval '1 month' - interval '1 day')::date::text", [d]);

before(async () => {
  await resetDatabase(pool);
  admin = await signUp(app, { name: 'Founder', email: 'founder@skyfly.test' });
  await adminSignIn(admin, { email: 'founder@skyfly.test' });
  await openClientSignup(pool);
  ownerA = await signUp(app, { name: 'Owner A', email: 'owner@shop-a.test', business: 'Shop A' });
  ownerB = await signUp(app, { name: 'Owner B', email: 'owner@shop-b.test', business: 'Shop B' });
  [A, B] = await Promise.all(['Shop A', 'Shop B'].map(async (n) => (await pool.query('SELECT id FROM businesses WHERE name = $1', [n])).rows[0].id));
  const { rows: [s] } = await pool.query("INSERT INTO users (email, password_hash, name, email_verified_at) VALUES ('staff@shop-a.test', $1, 'Staff A', now()) RETURNING id", [await hashPassword('correct-horse-battery')]);
  await pool.query("INSERT INTO business_members (business_id, user_id, role) VALUES ($1, $2, 'staff')", [A, s.id]);
  staffA = request.agent(app);
  const _csrf = await csrfToken(staffA, '/login');
  await staffA.post('/login').type('form').send({ _csrf, email: 'staff@shop-a.test', password: 'correct-horse-battery' }).expect(302);
});
after(async () => { app.close(); offApp.close(); mock.close(); globalThis.fetch = realFetch; await pool.end(); await off.pool.end(); });

describe('pricing and checkout', () => {
  test('public pricing page compares Business Pro ₦199,000 and Agency VIP ₦399,000 a month', async () => {
    const r = await request(app).get('/pricing').expect(200);
    assert.match(r.text, /Business Pro/); assert.match(r.text, /Agency VIP/);
    assert.match(r.text, /₦199,000/); assert.match(r.text, /₦399,000/);
    assert.doesNotMatch(r.text, /data-billing-off/);
  });

  test('the owner starts Paystack checkout for the exact plan price in NGN; nothing is activated yet', async () => {
    const before = await biz(A);
    const r = await checkout(ownerA, A, 'business_pro');
    assert.equal(r.status, 303);
    const ref = await lastRef(A);
    assert.equal(r.headers.location, `https://checkout.paystack.com/${ref}`);
    const init = ps.calls.find((c) => c.path === '/transaction/initialize');
    assert.deepEqual([init.body.amount, init.body.currency, init.body.email, init.body.callback_url], [19900000, 'NGN', 'owner@shop-a.test', 'http://skyfly.test/billing/paystack/callback']);
    assert.equal(await sql1('SELECT status FROM subscription_payments WHERE reference = $1', [ref]), 'pending');
    assert.deepEqual(await biz(A), before);
  });

  test('returning from Paystack before it confirms changes nothing (the success page proves nothing)', async () => {
    const ref = await lastRef(A);
    const r = await ownerA.get(`/billing/paystack/callback?reference=${ref}`);
    assert.equal(r.headers.location, `/businesses/${A}/subscription?payment=pending`);
    assert.equal((await biz(A)).subscription_status, 'trial');
    const page = await ownerA.get(r.headers.location).expect(200);
    assert.match(page.text, /data-payment-outcome="pending"/);
  });

  test('once Paystack confirms, the return page activates Business Pro for one month from today', async () => {
    const ref = await lastRef(A);
    ps.tx[ref].status = 'success';
    const r = await ownerA.get(`/billing/paystack/callback?reference=${ref}`);
    assert.equal(r.headers.location, `/businesses/${A}/subscription?payment=activated`);
    const b = await biz(A);
    assert.deepEqual([b.plan, b.subscription_status, b.price, b.started, b.expires], ['business_pro', 'active', 19900000, b.today, await addMonth(b.today)]);
    const p = (await pool.query('SELECT status, period_start::text, period_end::text, paid_at FROM subscription_payments WHERE reference = $1', [ref])).rows[0];
    assert.deepEqual([p.status, p.period_start, p.period_end, Boolean(p.paid_at)], ['success', b.today, b.expires, true]);
    assert.equal(await sql1("SELECT count(*)::int FROM audit_log WHERE action = 'subscription.paid' AND business_id = $1", [A]), 1);
    const page = await ownerA.get(`/businesses/${A}/subscription`).expect(200);
    assert.match(page.text, /data-sub-status="active"/);
    assert.match(page.text, new RegExp(ref));
  });

  test('the same payment applied again (return page, duplicate webhook, reconciliation) never extends twice', async () => {
    const ref = await lastRef(A);
    const before = await biz(A);
    assert.equal((await ownerA.get(`/billing/paystack/callback?reference=${ref}`)).headers.location, `/businesses/${A}/subscription?payment=already_applied`);
    for (let i = 0; i < 2; i += 1) assert.equal((await hook({ event: 'charge.success', data: { ...ps.tx[ref] } })).body.outcome, 'already_applied');
    await pool.query("UPDATE subscription_payments SET created_at = now() - interval '1 hour' WHERE reference = $1", [ref]);
    await reconcileBilling(pool, config);
    assert.deepEqual(await biz(A), before);
    assert.equal(await sql1("SELECT count(*)::int FROM audit_log WHERE action = 'subscription.paid'"), 1);
  });

  test('renewing while active starts the day after the current paid-until date (no days lost)', async () => {
    const before = await biz(A);
    await checkout(ownerA, A, 'business_pro');
    const ref = await lastRef(A);
    ps.tx[ref].status = 'success';
    await ownerA.get(`/billing/paystack/callback?reference=${ref}`);
    const b = await biz(A);
    const start = await sql1("SELECT ($1::date + 1)::text", [before.expires]);
    assert.deepEqual([b.started, b.expires], [before.started, await addMonth(start)]);
  });
});

describe('webhooks', () => {
  test('a webhook with a forged or missing signature is refused and changes nothing', async () => {
    await checkout(ownerB, B, 'agency_vip');
    const ref = await lastRef(B);
    const event = { event: 'charge.success', data: { reference: ref, amount: 39900000, currency: 'NGN', status: 'success' } };
    assert.equal((await hook(event, 'sk_test_wrong')).status, 401);
    assert.equal((await request(app).post('/webhooks/paystack').set('Content-Type', 'application/json').send(JSON.stringify(event))).status, 401);
    assert.equal((await biz(B)).subscription_status, 'trial');
    assert.equal(await sql1('SELECT status FROM subscription_payments WHERE reference = $1', [ref]), 'pending');
  });

  test('a signed charge.success for the exact amount activates Agency VIP (₦399,000)', async () => {
    const ref = await lastRef(B);
    const r = await hook({ event: 'charge.success', data: { reference: ref, amount: 39900000, currency: 'NGN', status: 'success', channel: 'bank_transfer', paid_at: new Date().toISOString() } });
    assert.deepEqual([r.status, r.body.outcome], [200, 'activated']);
    const b = await biz(B);
    assert.deepEqual([b.plan, b.subscription_status, b.price], ['agency_vip', 'active', 39900000]);
  });

  test('a short payment (amount differs) is recorded but does not activate', async () => {
    await pool.query("UPDATE businesses SET subscription_status = 'trial', plan = NULL WHERE id = $1", [B]);
    await checkout(ownerB, B, 'agency_vip');
    const ref = await lastRef(B);
    const r = await hook({ event: 'charge.success', data: { reference: ref, amount: 100, currency: 'NGN', status: 'success' } });
    assert.equal(r.body.outcome, 'mismatch');
    assert.equal((await biz(B)).subscription_status, 'trial');
    assert.match(await sql1('SELECT failure_reason FROM subscription_payments WHERE reference = $1', [ref]), /does not match/);
  });

  test('a failed payment is marked failed and the business is untouched', async () => {
    await checkout(ownerB, B, 'business_pro');
    const ref = await lastRef(B);
    const before = await biz(B);
    const r = await hook({ event: 'charge.failed', data: { reference: ref, amount: 19900000, currency: 'NGN', status: 'failed', gateway_response: 'Declined' } });
    assert.equal(r.body.outcome, 'failed');
    assert.equal(await sql1('SELECT status FROM subscription_payments WHERE reference = $1', [ref]), 'failed');
    assert.deepEqual(await biz(B), before);
  });
});

describe('who can pay and see what', () => {
  test('staff cannot start a payment; another business\'s owner cannot see or pay for this business', async () => {
    const page = await staffA.get(`/businesses/${A}/subscription`).expect(200);
    assert.match(page.text, /data-owner-only/);
    assert.equal((await checkout(staffA, A, 'agency_vip')).status, 403);
    assert.equal((await ownerB.get(`/businesses/${A}/subscription`)).status, 404);
    const _csrf = await csrfToken(ownerB, `/businesses/${B}/subscription`);
    assert.equal((await ownerB.post(`/businesses/${A}/subscription/checkout`).type('form').send({ _csrf, plan: 'business_pro' })).status, 404);
    const own = await ownerB.get(`/businesses/${B}/subscription`);
    for (const ref of (await pool.query('SELECT reference FROM subscription_payments WHERE business_id = $1', [A])).rows.map((r) => r.reference)) assert.doesNotMatch(own.text, new RegExp(ref));
    assert.equal((await ownerA.get('/admin/subscriptions')).status, 404);
  });

  test('an expired business can still open its subscription page and pay; other sections stay closed; a locked one cannot pay', async () => {
    await pool.query("UPDATE businesses SET subscription_status = 'expired', subscription_expires_on = current_date - 3 WHERE id = $1", [B]);
    assert.equal((await ownerB.get(`/businesses/${B}/orders`)).status, 402);
    const locked = await ownerB.get(`/businesses/${B}`);
    assert.equal(locked.status, 402);
    assert.match(locked.text, /data-renew/);
    assert.equal((await ownerB.get(`/businesses/${B}/subscription`)).status, 200);
    const r = await checkout(ownerB, B, 'business_pro');
    assert.equal(r.status, 303);
    const ref = await lastRef(B);
    ps.tx[ref].status = 'success';
    await ownerB.get(`/billing/paystack/callback?reference=${ref}`);
    const b = await biz(B);
    assert.deepEqual([b.subscription_status, b.started, b.expires], ['active', b.today, await addMonth(b.today)]);
    assert.equal((await ownerB.get(`/businesses/${B}/orders`)).status, 200);
    await pool.query("UPDATE businesses SET subscription_status = 'locked' WHERE id = $1", [B]);
    assert.equal((await ownerB.get(`/businesses/${B}/subscription`)).status, 402);
    await pool.query("UPDATE businesses SET subscription_status = 'active' WHERE id = $1", [B]);
  });

  test('without a Paystack key, the pricing page says online payment is not on (nothing pretends to be connected)', async () => {
    const pricing = await request(offApp).get('/pricing').expect(200);
    assert.match(pricing.text, /data-billing-off/);
  });
});

describe('expiry alerts for the Super Admin', () => {
  test('14, 7, 3 days before and on the day: one email each, never repeated; shown with plan, amount, expiry and renewal', async () => {
    const days = { [A]: 14, [B]: 0 };
    for (const [id, d] of Object.entries(days)) await pool.query("UPDATE businesses SET subscription_status = 'active', subscription_expires_on = (now() AT TIME ZONE timezone)::date + $2::int WHERE id = $1", [id, d]);
    mailed.length = 0;
    const first = await remindSubscriptions(pool, config);
    assert.deepEqual(first.map((r) => `${r.business}:${r.threshold}:${r.status}`).sort(), [`${A}:14d:sent`, `${B}:0d:sent`].sort());
    assert.deepEqual(mailed.map((m) => m.to[0] ?? m.to).every((t) => String(t).includes('founder@skyfly.test')), true);
    assert.ok(mailed.some((m) => /Shop B/.test(m.subject) && /expires today/.test(m.subject)));
    assert.ok(mailed.some((m) => /Shop A — Business Pro \(₦199,000\/month\)/.test(m.text)));
    assert.deepEqual(await remindSubscriptions(pool, config), []);
    const page = await admin.get('/admin/subscriptions').expect(200);
    assert.match(page.text, /data-sub-alerts/);
    assert.match(page.text, /Shop B/);
    assert.match(page.text, /₦399,000|₦199,000/);
    const dash = await admin.get('/admin').expect(200);
    assert.match(dash.text, /Subscription expiry:/);
  });

  test('each step fires once per expiry date as the date approaches', async () => {
    await pool.query('DELETE FROM subscription_reminders');
    await pool.query("UPDATE businesses SET subscription_expires_on = (now() AT TIME ZONE timezone)::date + 20 WHERE id = $1", [B]);
    const seen = [];
    for (const d of [14, 10, 7, 5, 3, 1, 0]) {
      await pool.query("UPDATE businesses SET subscription_expires_on = (now() AT TIME ZONE timezone)::date + $2::int WHERE id = $1", [A, d]);
      // Same expiry date each time (the clock moves, the paid-until date does not): rewrite earlier rows to it.
      await pool.query("UPDATE subscription_reminders SET expires_on = (SELECT subscription_expires_on FROM businesses WHERE id = $1) WHERE business_id = $1", [A]);
      seen.push(...(await remindSubscriptions(pool, config)).filter((r) => r.business === A).map((r) => r.threshold));
    }
    assert.deepEqual(seen, ['14d', '7d', '3d', '0d']);
  });
});
