// Stripe + PayPal online payments (USD) next to Payment on Delivery (NGN), against stand-in gateways that
// behave like the real APIs: each business connects its OWN account; orders become paid only from a
// verified server-side confirmation (signed webhook / Skyfly asking the gateway), with amount, currency
// and receiving account checked; repeated webhooks change nothing; businesses never see or use each
// other's connections.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHmac } from 'node:crypto';
import request from 'supertest';
import { setup, resetDatabase, csrfToken, signUp, openClientSignup, ORIGIN } from './helpers.js';
import { reconcilePayments } from '../src/services/payments.js';

// ---------- stand-in Stripe and PayPal
const gw = { sessions: {}, ppOrders: {}, calls: [], referrals: [], n: 0, declineNext: false };
const mock = createServer(async (req, res) => {
  let raw = ''; for await (const c of req) raw += c;
  const url = new URL(req.url, 'http://x'); const p = url.pathname;
  const form = Object.fromEntries(new URLSearchParams(raw));
  const json = (() => { try { return JSON.parse(raw); } catch { return null; } })();
  gw.calls.push({ method: req.method, path: p, account: req.headers['stripe-account'] ?? null, assertion: req.headers['paypal-auth-assertion'] ?? null, form, json });
  const send = (o, s = 200) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  // Stripe Connect OAuth
  if (p === '/connect/oauth/token') return form.code?.startsWith('code_') ? send({ stripe_user_id: `acct_${form.code.slice(5)}`, livemode: false }) : send({ error: 'invalid_grant' }, 400);
  if (p === '/connect/oauth/deauthorize') return send({ stripe_user_id: form.stripe_user_id });
  if (p.startsWith('/stripe/v1/accounts/')) return send({ id: p.split('/').pop(), charges_enabled: true, country: 'US' });
  if (p === '/stripe/v1/checkout/sessions' && req.method === 'POST') {
    const id = `cs_test_${gw.n += 1}`;
    let amount = 0; for (let i = 0; form[`line_items[${i}][quantity]`]; i += 1) amount += Number(form[`line_items[${i}][quantity]`]) * Number(form[`line_items[${i}][price_data][unit_amount]`]);
    gw.sessions[id] = { id, account: req.headers['stripe-account'], amount_total: amount, currency: form['line_items[0][price_data][currency]'], payment_status: 'unpaid', status: 'open', payment_intent: `pi_${gw.n}`, success_url: form.success_url };
    return send({ id, url: `https://checkout.stripe.com/c/pay/${id}` });
  }
  if (p.startsWith('/stripe/v1/checkout/sessions/')) {
    const s = gw.sessions[p.split('/').pop()];
    return s && s.account === req.headers['stripe-account'] ? send(s) : send({ error: { message: 'No such checkout.session' } }, 404);
  }
  if (p === '/stripe/v1/refunds') return send({ id: `re_${gw.n += 1}`, status: 'succeeded' });
  // PayPal
  if (p === '/paypal/v1/oauth2/token') return send({ access_token: 'pp-token', expires_in: 3600 });
  if (p === '/paypal/v2/customer/partner-referrals') { gw.referrals.push(json); return send({ links: [{ rel: 'action_url', href: 'https://www.sandbox.paypal.com/bizsignup/partner/entry?referralToken=x' }] }); }
  if (p.startsWith('/paypal/v1/customer/partners/PARTNER1/merchant-integrations/')) return send({ merchant_id: p.split('/').pop(), payments_receivable: true, primary_email_confirmed: true });
  if (p === '/paypal/v2/checkout/orders' && req.method === 'POST') {
    const id = `PO${gw.n += 1}`; const u = json.purchase_units[0];
    gw.ppOrders[id] = { id, status: 'CREATED', payee: u.payee.merchant_id, amount: u.amount, decline: gw.declineNext };
    gw.declineNext = false;
    return send({ id, status: 'CREATED', links: [{ rel: 'approve', href: `https://www.sandbox.paypal.com/checkoutnow?token=${id}` }] });
  }
  const cap = /^\/paypal\/v2\/checkout\/orders\/([^/]+)\/capture$/.exec(p);
  if (cap) {
    const o = gw.ppOrders[cap[1]];
    if (!o) return send({ name: 'RESOURCE_NOT_FOUND' }, 404);
    if (o.decline) return send({ name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'INSTRUMENT_DECLINED', description: 'The instrument presented was declined.' }] }, 422);
    o.status = 'COMPLETED'; o.capture = o.capture ?? `CAP${gw.n += 1}`;
    return send({ id: o.id, status: 'COMPLETED', purchase_units: [{ payee: { merchant_id: o.payee }, payments: { captures: [{ id: o.capture, status: 'COMPLETED', amount: o.amount }] } }] });
  }
  if (p.startsWith('/paypal/v2/checkout/orders/')) { const o = gw.ppOrders[p.split('/').pop()]; return o ? send({ id: o.id, status: o.status }) : send({}, 404); }
  if (p === '/paypal/v1/notifications/verify-webhook-signature') return send({ verification_status: json.transmission_sig === 'genuine' ? 'SUCCESS' : 'FAILURE' });
  if (/^\/paypal\/v2\/payments\/captures\/[^/]+\/refund$/.test(p)) return send({ id: `REF${gw.n += 1}`, status: 'COMPLETED' });
  send({ error: 'not mocked', p }, 404);
});
await new Promise((r) => mock.listen(0, r));
const GW = `http://127.0.0.1:${mock.address().port}`;

// Owner emails (platform sender) are captured.
const realFetch = globalThis.fetch;
const mailed = [];
globalThis.fetch = async (url, opts) => {
  if (String(url).startsWith('https://api.resend.com/')) { mailed.push(JSON.parse(opts.body)); return new Response('{"id":"m"}', { status: 200 }); }
  return realFetch(url, opts);
};

const WHSEC = 'whsec_test_secret_value';
const payments = {
  stripe: { secretKey: 'sk_test_platform', clientId: 'ca_platform', webhookSecret: WHSEC, mode: 'test', apiBase: `${GW}/stripe`, connectBase: `${GW}/connect` },
  paypal: { clientId: 'pp-client', clientSecret: 'pp-secret', partnerMerchantId: 'PARTNER1', webhookId: 'WH1', bnCode: null, mode: 'test', apiBase: `${GW}/paypal` },
};
const notifyEmail = { provider: 'resend', apiKey: 're_test_not_real_000', fromEmail: 'no-reply@skyfly.test', fromName: 'Skyfly' };
const { pool, app: expressApp } = setup({ payments, notifyEmail });
const app = expressApp.listen(0);
let admin; let ownerA; let ownerB; let A; let B; let n = 0;

const signStripe = (event, secret = WHSEC, t = Math.floor(Date.now() / 1000)) => {
  const body = JSON.stringify(event);
  return { body, sig: `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}` };
};
const stripeHook = (event, opts) => { const { body, sig } = signStripe(event, opts?.secret); return request(app).post('/webhooks/stripe').set('Content-Type', 'application/json').set('Stripe-Signature', opts?.sig ?? sig).send(body); };
const ppHook = (event, sig = 'genuine') => request(app).post('/webhooks/paypal').set('Content-Type', 'application/json')
  .set({ 'paypal-auth-algo': 'SHA256withRSA', 'paypal-cert-url': 'https://api.paypal.com/cert', 'paypal-transmission-id': `t${n}`, 'paypal-transmission-sig': sig, 'paypal-transmission-time': new Date().toISOString() })
  .send(JSON.stringify(event));
const order = (page, extra = {}) => request(app).post('/api/public/orders').set('Origin', ORIGIN).send({
  landingPage: page, idempotencyKey: `pay-test-${String(n += 1).padStart(8, '0')}-key`,
  customer: { name: 'Ada Obi', phone: '08031234567', address: '12 Allen Avenue, Ikeja', state: 'Lagos', email: 'ada@example.test' },
  items: [{ product: 'serum', quantity: 2 }], ...extra,
});
const orderRow = (ref) => pool.query('SELECT * FROM orders WHERE reference = $1', [ref]).then((r) => r.rows[0]);
const post = async (agent, path, form = {}, from = path.replace(/\/[^/]+\/[^/]+$/, '')) => { const _csrf = await csrfToken(agent, from); return agent.post(path).type('form').send({ _csrf, ...form }); };

async function connectStripe(agent, biz, code) {
  const r = await post(agent, `/businesses/${biz}/payments/stripe/connect`, {}, `/businesses/${biz}/payments`);
  assert.equal(r.status, 302);
  const auth = new URL(r.headers.location);
  assert.equal(auth.origin + auth.pathname, `${GW}/connect/oauth/authorize`);
  assert.equal(auth.searchParams.get('client_id'), 'ca_platform');
  return agent.get(`/payments/stripe/callback?code=${code}&state=${encodeURIComponent(auth.searchParams.get('state'))}`);
}

before(async () => {
  await resetDatabase(pool);
  admin = await signUp(app, { name: 'Founder', email: 'founder@skyfly.test' });
  await openClientSignup(pool);
  ownerA = await signUp(app, { name: 'Laros Owner', email: 'owner@laros.test', business: 'Laros Skincare' });
  ownerB = await signUp(app, { name: 'Skill Owner', email: 'owner@skillforge.test', business: 'Skill Forge' });
  [A, B] = await Promise.all(['Laros Skincare', 'Skill Forge'].map(async (name) => (await pool.query('SELECT id FROM businesses WHERE name = $1', [name])).rows[0].id));
  for (const [biz, slug, usd] of [[A, 'laros-page', 1999], [B, 'skill-page', 4900]]) {
    const { rows: [lp] } = await pool.query("INSERT INTO landing_pages (business_id, slug, name, url, status, order_destination) VALUES ($1, $2, $2, $3, 'active', 'checkout') RETURNING id", [biz, slug, `${ORIGIN}/${slug}/`]);
    const { rows: [p] } = await pool.query("INSERT INTO products (business_id, code, name, price_minor, usd_price_minor) VALUES ($1, 'serum', 'Glow Serum', 2500000, $2) RETURNING id", [biz, usd]);
    const { rows: [p2] } = await pool.query("INSERT INTO products (business_id, code, name, price_minor) VALUES ($1, 'local-only', 'Local Only', 1000000) RETURNING id", [biz]);
    await pool.query('INSERT INTO landing_page_products (landing_page_id, product_id) VALUES ($1, $2), ($1, $3)', [lp.id, p.id, p2.id]);
  }
  await pool.query("UPDATE businesses SET currency = 'NGN' WHERE id = ANY($1::bigint[])", [[A, B]]);
  await pool.query('UPDATE businesses SET usd_delivery_fee_minor = 500, delivery_fee_minor = 300000 WHERE id = $1', [A]);
});
after(async () => { app.close(); mock.close(); globalThis.fetch = realFetch; await pool.end(); });

describe('connecting each business\'s own accounts', () => {
  test('Laros connects its own Stripe and PayPal through the official pages; Skill Forge connects its own Stripe', async () => {
    assert.equal((await connectStripe(ownerA, A, 'code_LAROS')).headers.location, `/businesses/${A}/payments?done=stripe_connected`);
    assert.equal((await connectStripe(ownerB, B, 'code_SKILL')).headers.location, `/businesses/${B}/payments?done=stripe_connected`);
    // PayPal partner referral, then PayPal's return; the merchant's status is asked from PayPal itself.
    const r = await post(ownerA, `/businesses/${A}/payments/paypal/connect`, {}, `/businesses/${A}/payments`);
    assert.match(r.headers.location, /^https:\/\/www\.sandbox\.paypal\.com\/bizsignup/);
    const back = new URL(gw.referrals.at(-1).partner_config_override.return_url);
    const ret = await ownerA.get(`${back.pathname}${back.search}&merchantIdInPayPal=LAROSPAYPAL1&permissionsGranted=true`);
    assert.equal(ret.headers.location, `/businesses/${A}/payments?done=paypal_connected`);
    const { rows } = await pool.query('SELECT business_id, provider, account_id, status FROM payment_connections ORDER BY business_id, provider');
    assert.deepEqual(rows.map((x) => `${x.business_id}:${x.provider}:${x.account_id}:${x.status}`), [`${A}:paypal:LAROSPAYPAL1:connected`, `${A}:stripe:acct_LAROS:connected`, `${B}:stripe:acct_SKILL:connected`]);
    const page = await ownerA.get(`/businesses/${A}/payments`).expect(200);
    assert.match(page.text, /acct_LAROS/);
    assert.doesNotMatch(page.text, /acct_SKILL|sk_test|whsec/, 'no other business, no platform secrets');
  });

  test('another business cannot open, use, disconnect or hijack a connection; staff and Super Admin visits cannot connect', async () => {
    assert.equal((await ownerB.get(`/businesses/${A}/payments`)).status, 404);
    for (const path of ['stripe/disconnect', 'paypal/disconnect', 'stripe/connect', 'stripe/enabled']) {
      assert.equal((await post(ownerB, `/businesses/${A}/payments/${path}`, { enabled: 'false' }, `/businesses/${B}/payments`)).status, 404, path);
    }
    // A state started by A's owner cannot be completed by B's owner (it would attach an account to A).
    const r = await post(ownerA, `/businesses/${A}/payments/stripe/connect`, {}, `/businesses/${A}/payments`);
    const state = new URL(r.headers.location).searchParams.get('state');
    assert.equal((await ownerB.get(`/payments/stripe/callback?code=code_EVIL&state=${encodeURIComponent(state)}`)).status, 400);
    // ...and a state is single-use.
    assert.equal((await ownerA.get(`/payments/stripe/callback?code=code_LAROS&state=${encodeURIComponent(state)}`)).status, 302);
    assert.equal((await ownerA.get(`/payments/stripe/callback?code=code_LAROS&state=${encodeURIComponent(state)}`)).status, 400);
    assert.equal((await pool.query("SELECT account_id FROM payment_connections WHERE business_id = $1 AND provider = 'stripe'", [A])).rows[0].account_id, 'acct_LAROS');
  });

  test('the checkout offers only the business\'s own connected gateways, with USD prices it set', async () => {
    const a = (await request(app).get('/api/public/pages/laros-page/catalog').expect(200)).body;
    assert.deepEqual(a.online, { currency: 'USD', gateways: ['stripe', 'paypal'], delivery: 5, prices: { serum: 19.99 } });
    assert.equal(a.currency, 'NGN');
    const b = (await request(app).get('/api/public/pages/skill-page/catalog').expect(200)).body;
    assert.deepEqual(b.online.gateways, ['stripe']);
    assert.equal(JSON.stringify(b).includes('acct_'), false, 'no account identifiers in the public catalog');
  });
});

describe('Payment on Delivery (NGN)', () => {
  test('a COD order stays NGN and unpaid; no payment page; shows in the business\'s dashboard', async () => {
    const r = await order('laros-page', { paymentMethod: 'cod' });
    assert.equal(r.status, 201);
    assert.equal(r.body.currency, 'NGN');
    assert.equal(r.body.total, 53000);
    assert.equal(r.body.payment, null);
    const o = await orderRow(r.body.reference);
    assert.deepEqual([o.payment_method, o.payment_status, o.currency], ['cod', 'unpaid', 'NGN']);
    assert.match((await ownerA.get(`/businesses/${A}/orders`).expect(200)).text, new RegExp(r.body.reference));
    assert.doesNotMatch((await ownerB.get(`/businesses/${B}/orders`).expect(200)).text, new RegExp(r.body.reference));
  });
});

describe('Stripe (USD)', () => {
  let ref; let session;
  test('pay online: the order is saved in USD with Skyfly\'s USD prices, and a Stripe Checkout opens on Laros\'s own account', async () => {
    const r = await order('laros-page', { paymentMethod: 'stripe' });
    assert.equal(r.status, 201);
    assert.equal(r.body.currency, 'USD');
    assert.equal(r.body.total, 44.98); // 2 × 19.99 + 5.00 delivery, never a conversion of ₦
    assert.match(r.body.payment.redirectUrl, /^https:\/\/checkout\.stripe\.com\//);
    ref = r.body.reference;
    const created = gw.calls.filter((c) => c.path === '/stripe/v1/checkout/sessions').at(-1);
    assert.equal(created.account, 'acct_LAROS', 'charged on the business\'s own Stripe account');
    session = Object.values(gw.sessions).at(-1);
    assert.equal(session.amount_total, 4498);
    assert.equal(session.currency, 'usd');
    assert.deepEqual([(await orderRow(ref)).payment_status, (await orderRow(ref)).payment_method], ['pending', 'stripe']);
  });

  test('the browser coming back is not proof: unpaid at Stripe stays pending; bad or wrong-account webhooks change nothing', async () => {
    const o = await orderRow(ref);
    await request(app).get(`/pay/stripe/return?o=${ref}&t=${o.access_token}&session=${session.id}`).expect(302);
    assert.equal((await orderRow(ref)).payment_status, 'pending');
    const paid = { id: 'evt_bad', type: 'checkout.session.completed', account: 'acct_LAROS', data: { object: { ...session, payment_status: 'paid' } } };
    assert.equal((await stripeHook(paid, { secret: 'whsec_wrong' })).status, 400, 'forged signature refused');
    assert.equal((await stripeHook(paid, { sig: 't=1,v1=00' })).status, 400, 'stale / malformed signature refused');
    const wrongAccount = await stripeHook({ ...paid, id: 'evt_wrong_account', account: 'acct_SKILL' });
    assert.equal(wrongAccount.body.outcome, 'mismatch_account');
    const wrongAmount = await stripeHook({ ...paid, id: 'evt_wrong_amount', data: { object: { ...session, payment_status: 'paid', amount_total: 100 } } });
    assert.equal(wrongAmount.body.outcome, 'mismatch_amount');
    assert.equal((await orderRow(ref)).payment_status, 'pending');
    // The owner cannot mark an online order paid by hand either.
    const manual = await post(ownerA, `/businesses/${A}/orders/${o.id}/status`, { kind: 'payment', status: 'paid' }, `/businesses/${A}/orders/${o.id}`);
    assert.equal(manual.status, 409);
  });

  test('a verified Stripe webhook marks it paid once; retries and duplicates change nothing; the owner is emailed', async () => {
    mailed.length = 0;
    session.payment_status = 'paid'; session.status = 'complete';
    const ev = { id: 'evt_paid_1', type: 'checkout.session.completed', account: 'acct_LAROS', data: { object: { ...session } } };
    assert.equal((await stripeHook(ev)).body.outcome, 'paid');
    assert.equal((await stripeHook(ev)).body.duplicate, true, 'same event again (Stripe retry)');
    assert.equal((await stripeHook({ ...ev, id: 'evt_paid_2' })).body.outcome, 'already_paid', 'another event for the same payment');
    const o = await orderRow(ref);
    assert.equal(o.payment_status, 'paid');
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM payment_transactions WHERE order_id = $1 AND status = 'succeeded'", [o.id])).rows[0].n, 1);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM order_status_history WHERE order_id = $1 AND kind = 'payment' AND to_status = 'paid'", [o.id])).rows[0].n, 1);
    assert.equal(mailed.length, 1);
    assert.deepEqual([mailed[0].to].flat(), ['owner@laros.test']);
    assert.match(mailed[0].subject, /Payment received: .* \(\$44\.98 USD\)/);
    const page = await ownerA.get(`/businesses/${A}/orders/${o.id}`).expect(200);
    assert.match(page.text, /data-payment-status>Paid/);
    assert.match(page.text, /pi_\d+/);
    assert.equal((await ownerB.get(`/businesses/${B}/orders/${o.id}`)).status, 404, 'Skill Forge cannot open Laros\'s order');
    const conf = await request(app).get(`/o/${ref}?t=${o.access_token}`).expect(200);
    assert.match(conf.text, /data-payment="paid"/);
  });

  test('a failed / expired Stripe checkout: the order stays, "Payment failed", and the customer can pay again', async () => {
    const r = await order('laros-page', { paymentMethod: 'stripe' });
    const s = Object.values(gw.sessions).at(-1);
    assert.equal((await stripeHook({ id: 'evt_expired', type: 'checkout.session.expired', account: 'acct_LAROS', data: { object: { ...s, status: 'expired' } } })).body.outcome, 'failed');
    const o = await orderRow(r.body.reference);
    assert.equal(o.payment_status, 'failed');
    const conf = await request(app).get(`/o/${o.reference}?t=${o.access_token}`).expect(200);
    assert.match(conf.text, /Payment not completed[\s\S]*Pay now/);
    const again = await request(app).post(`/o/${o.reference}/pay`).type('form').send({ t: o.access_token });
    assert.equal(again.status, 303);
    assert.match(again.headers.location, /^https:\/\/checkout\.stripe\.com\//);
    assert.equal((await orderRow(o.reference)).payment_status, 'pending');
  });

  test('refund: only the owner, through Stripe on the business\'s account; the order becomes Refunded', async () => {
    const o = await orderRow(ref);
    const r = await post(ownerA, `/businesses/${A}/orders/${o.id}/payment/refund`, {}, `/businesses/${A}/orders/${o.id}`);
    assert.equal(r.status, 302);
    assert.equal(gw.calls.filter((c) => c.path === '/stripe/v1/refunds').at(-1).account, 'acct_LAROS');
    assert.equal((await orderRow(ref)).payment_status, 'refunded');
  });
});

describe('PayPal (USD)', () => {
  test('approve on PayPal, then Skyfly captures it server-side; paid only from PayPal\'s capture answer', async () => {
    const r = await order('laros-page', { paymentMethod: 'paypal' });
    assert.equal(r.status, 201);
    assert.match(r.body.payment.redirectUrl, /^https:\/\/www\.sandbox\.paypal\.com\/checkoutnow\?token=PO\d+/);
    const po = Object.values(gw.ppOrders).at(-1);
    assert.equal(po.payee, 'LAROSPAYPAL1', 'the money goes to Laros\'s own PayPal');
    assert.deepEqual(po.amount.value, '44.98');
    const created = gw.calls.filter((c) => c.path === '/paypal/v2/checkout/orders').at(-1);
    assert.match(Buffer.from(created.assertion.split('.')[1], 'base64url').toString(), /"payer_id":"LAROSPAYPAL1"/);
    const o = await orderRow(r.body.reference);
    await request(app).get(`/pay/paypal/return?o=${o.reference}&t=${o.access_token}&token=${po.id}&PayerID=X`).expect(302);
    assert.equal((await orderRow(o.reference)).payment_status, 'paid');
    // PayPal's webhook for the same capture afterwards: already paid, nothing doubled.
    const hook = await ppHook({ id: 'WH-EVT-1', event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: { id: po.capture, amount: po.amount, payee: { merchant_id: 'LAROSPAYPAL1' }, supplementary_data: { related_ids: { order_id: po.id } } } });
    assert.equal(hook.body.outcome, 'already_paid');
    assert.equal((await ppHook({ id: 'WH-EVT-1', event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: {} })).body.duplicate, true);
    assert.equal((await ppHook({ id: 'WH-EVT-forged', event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: {} }, 'forged')).status, 400);
  });

  test('a declined PayPal payment: the order stays, "Payment failed"', async () => {
    gw.declineNext = true;
    const r = await order('laros-page', { paymentMethod: 'paypal' });
    const po = Object.values(gw.ppOrders).at(-1);
    const o = await orderRow(r.body.reference);
    await request(app).get(`/pay/paypal/return?o=${o.reference}&t=${o.access_token}&token=${po.id}`).expect(302);
    const after = await orderRow(o.reference);
    assert.equal(after.payment_status, 'failed');
    const { rows: [t] } = await pool.query('SELECT status, failure_reason FROM payment_transactions WHERE provider_ref = $1', [po.id]);
    assert.equal(t.status, 'failed');
    assert.match(t.failure_reason, /INSTRUMENT_DECLINED/);
  });

  test('approved but the customer never came back: the PayPal webhook (verified by PayPal) captures and pays it', async () => {
    const r = await order('laros-page', { paymentMethod: 'paypal' });
    const po = Object.values(gw.ppOrders).at(-1);
    assert.equal((await ppHook({ id: 'WH-EVT-approved', event_type: 'CHECKOUT.ORDER.APPROVED', resource: { id: po.id } })).body.outcome, 'paid');
    assert.equal((await orderRow(r.body.reference)).payment_status, 'paid');
  });
});

describe('isolation and safety', () => {
  test('a business without the gateway, or a product without a USD price, cannot be paid online', async () => {
    const r1 = await order('skill-page', { paymentMethod: 'paypal' });
    assert.equal(r1.status, 409);
    assert.equal(r1.body.error, 'GATEWAY_UNAVAILABLE');
    const r2 = await order('laros-page', { paymentMethod: 'stripe', items: [{ product: 'local-only', quantity: 1 }] });
    assert.equal(r2.status, 409);
    assert.equal(r2.body.error, 'ONLINE_UNAVAILABLE');
    const r3 = await order('laros-page', { paymentMethod: 'stripe', customer: { name: 'Ada Obi', phone: '08031234567', address: '12 Allen Avenue, Ikeja' } });
    assert.equal(r3.status, 400, 'an email is needed for the receipt');
  });

  test('Skill Forge\'s payment goes to Skill Forge\'s account and updates only Skill Forge\'s dashboard', async () => {
    const r = await order('skill-page', { paymentMethod: 'stripe', items: [{ product: 'serum', quantity: 1 }] });
    const s = Object.values(gw.sessions).at(-1);
    assert.equal(s.account, 'acct_SKILL');
    assert.equal(s.amount_total, 4900);
    s.payment_status = 'paid';
    // Delivered as if from Laros's account: refused (the receiving account must be the order's business's).
    assert.equal((await stripeHook({ id: 'evt_cross', type: 'checkout.session.completed', account: 'acct_LAROS', data: { object: { ...s } } })).body.outcome, 'mismatch_account');
    assert.equal((await stripeHook({ id: 'evt_skill', type: 'checkout.session.completed', account: 'acct_SKILL', data: { object: { ...s } } })).body.outcome, 'paid');
    const o = await orderRow(r.body.reference);
    assert.equal(o.business_id, B);
    assert.match((await ownerB.get(`/businesses/${B}/orders/${o.id}`).expect(200)).text, /data-payment-status>Paid/);
    assert.equal((await ownerA.get(`/businesses/${A}/orders/${o.id}`)).status, 404);
    // The database refuses a transaction pointing at another business's order.
    const { rows: [t] } = await pool.query('SELECT id FROM payment_transactions WHERE order_id = $1', [o.id]);
    await assert.rejects(pool.query('UPDATE payment_transactions SET business_id = $2 WHERE id = $1', [t.id, A]), /does not belong/);
  });

  test('reconciliation asks Stripe for attempts still pending (missed webhook) and pays them', async () => {
    const r = await order('laros-page', { paymentMethod: 'stripe' });
    const s = Object.values(gw.sessions).at(-1);
    s.payment_status = 'paid';
    await pool.query("UPDATE payment_transactions SET created_at = now() - interval '20 minutes' WHERE provider_ref = $1", [s.id]);
    const out = await reconcilePayments(pool, { payments });
    assert.ok(out.some((x) => x.ref === s.id && x.outcome === 'paid'));
    assert.equal((await orderRow(r.body.reference)).payment_status, 'paid');
  });

  test('disconnecting removes the option at checkout at once (and revokes Skyfly\'s access at Stripe)', async () => {
    await post(ownerB, `/businesses/${B}/payments/stripe/disconnect`, {}, `/businesses/${B}/payments`);
    assert.ok(gw.calls.some((c) => c.path === '/connect/oauth/deauthorize' && c.form.stripe_user_id === 'acct_SKILL'));
    assert.equal((await request(app).get('/api/public/pages/skill-page/catalog').expect(200)).body.online, null);
    assert.equal((await order('skill-page', { paymentMethod: 'stripe' })).body.error, 'GATEWAY_UNAVAILABLE');
    // Laros is unaffected.
    assert.deepEqual((await request(app).get('/api/public/pages/laros-page/catalog').expect(200)).body.online.gateways, ['stripe', 'paypal']);
  });

  test('Super Admin sees connections, outcomes and USD volume; owners cannot; no secrets anywhere', async () => {
    const page = await admin.get('/admin/payments').expect(200);
    assert.match(page.text, /Laros Skincare[\s\S]*acct_LAROS/);
    assert.match(page.text, /data-payment-totals[\s\S]*succeeded/);
    assert.match(page.text, /\$/);
    assert.doesNotMatch(page.text, /sk_test_platform|whsec_|pp-secret/);
    assert.equal((await ownerA.get('/admin/payments')).status, 404);
  });
});
