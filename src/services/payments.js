// Online payments: Stripe (Connect, Standard accounts via OAuth) and PayPal (partner onboarding).
//
// Each business connects ITS OWN account; Skyfly keeps only that account's public identifier. Payments
// are created on the connected account with the platform's credentials (Stripe: direct charge with the
// Stripe-Account header; PayPal: the merchant as payee, with a PayPal-Auth-Assertion), so the money goes
// to the business and no merchant secret is ever stored.
//
// An order becomes PAID only through markPaid(), and only from a server-side confirmation: a webhook
// whose signature was verified, or Skyfly asking the gateway itself (return page, reconciliation). The
// amount, currency and receiving account must match what Skyfly asked for. Every event is applied once.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { audit } from '../lib/audit.js';

export const PROVIDERS = { stripe: 'Stripe', paypal: 'PayPal' };
export const ONLINE_CURRENCY = 'USD';
const STATE_MINUTES = 30;
const hashState = (s) => createHash('sha256').update(String(s)).digest('hex');

export class PaymentError extends Error {
  constructor(message, { status = 502, code = 'PAYMENT_ERROR' } = {}) { super(message); this.status = status; this.code = code; }
}

// Which gateways the platform has credentials for (Super Admin one-time setup).
export const platformGateways = (config) => ({ stripe: Boolean(config.payments?.stripe), paypal: Boolean(config.payments?.paypal) });

// ---------------------------------------------------------------- Stripe
function stripeConf(config) {
  const c = config.payments?.stripe;
  if (!c) throw new PaymentError('Stripe is not set up on this Skyfly platform yet.', { status: 503, code: 'NOT_CONFIGURED' });
  return c;
}
async function stripeCall(config, path, { method = 'GET', form = null, account = null, idempotencyKey = null, base = null } = {}) {
  const c = stripeConf(config);
  const headers = { Authorization: `Bearer ${c.secretKey}` };
  if (account) headers['Stripe-Account'] = account;
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  let body;
  if (form) { headers['Content-Type'] = 'application/x-www-form-urlencoded'; body = new URLSearchParams(form).toString(); }
  const res = await fetch(`${base ?? c.apiBase}${path}`, { method, headers, body, signal: AbortSignal.timeout(20000) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new PaymentError(`Stripe: ${json.error?.message || json.error_description || `HTTP ${res.status}`}`.slice(0, 300), { status: 502 });
  return json;
}
export const stripe = {
  authorizeUrl(config, state, redirectUri) {
    const c = stripeConf(config);
    const q = new URLSearchParams({ response_type: 'code', client_id: c.clientId, scope: 'read_write', state, redirect_uri: redirectUri });
    return `${c.connectBase}/oauth/authorize?${q}`;
  },
  // The authorisation code from Stripe's redirect, exchanged with the platform's secret key.
  async exchange(config, code) {
    const c = stripeConf(config);
    const r = await stripeCall(config, '/oauth/token', { method: 'POST', form: { grant_type: 'authorization_code', code }, base: c.connectBase });
    if (!/^acct_[A-Za-z0-9]+$/.test(String(r.stripe_user_id))) throw new PaymentError('Stripe did not return a connected account.');
    return { accountId: r.stripe_user_id, livemode: r.livemode === true };
  },
  async account(config, accountId) {
    const a = await stripeCall(config, `/v1/accounts/${encodeURIComponent(accountId)}`);
    return { chargesEnabled: a.charges_enabled === true, country: a.country ?? null, name: a.business_profile?.name ?? a.settings?.dashboard?.display_name ?? null };
  },
  async deauthorize(config, accountId) {
    const c = stripeConf(config);
    await stripeCall(config, '/oauth/deauthorize', { method: 'POST', form: { client_id: c.clientId, stripe_user_id: accountId }, base: c.connectBase });
  },
  async createCheckout(config, { accountId, order, lines, successUrl, cancelUrl }) {
    const form = {
      mode: 'payment', success_url: successUrl, cancel_url: cancelUrl, client_reference_id: order.reference,
      'metadata[skyfly_order]': order.reference, 'metadata[skyfly_business]': String(order.business_id),
      'payment_intent_data[metadata][skyfly_order]': order.reference, 'payment_intent_data[metadata][skyfly_business]': String(order.business_id),
      ...(order.email ? { customer_email: order.email } : {}),
    };
    lines.forEach((l, i) => {
      form[`line_items[${i}][quantity]`] = String(l.quantity);
      form[`line_items[${i}][price_data][currency]`] = 'usd';
      form[`line_items[${i}][price_data][unit_amount]`] = String(l.unitMinor);
      form[`line_items[${i}][price_data][product_data][name]`] = l.name.slice(0, 200);
    });
    const s = await stripeCall(config, '/v1/checkout/sessions', { method: 'POST', form, account: accountId, idempotencyKey: `skyfly-${order.reference}-${order.attempt}` });
    return { ref: s.id, url: s.url };
  },
  async session(config, accountId, sessionId) {
    return stripeCall(config, `/v1/checkout/sessions/${encodeURIComponent(sessionId)}`, { account: accountId });
  },
  async refund(config, accountId, paymentIntent, amountMinor, key) {
    const r = await stripeCall(config, '/v1/refunds', { method: 'POST', form: { payment_intent: paymentIntent, amount: String(amountMinor) }, account: accountId, idempotencyKey: key });
    return { ref: r.id, status: r.status };
  },
  // Stripe-Signature: t=…,v1=… — HMAC-SHA256 of "t.rawBody" with the endpoint secret, within 5 minutes.
  verify(config, rawBody, header, now = Date.now()) {
    const secret = config.payments?.stripe?.webhookSecret;
    if (!secret || !header) return null;
    const parts = Object.fromEntries(String(header).split(',').map((kv) => kv.split('=')).filter((p) => p.length === 2).map(([k, v]) => [k.trim(), v]));
    const sigs = String(header).split(',').filter((kv) => kv.trim().startsWith('v1=')).map((kv) => kv.trim().slice(3));
    const t = Number(parts.t);
    if (!t || !sigs.length || Math.abs(now / 1000 - t) > 300) return null;
    const expected = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest();
    const ok = sigs.some((s) => { const b = Buffer.from(s, 'hex'); return b.length === expected.length && timingSafeEqual(b, expected); });
    if (!ok) return null;
    try { return JSON.parse(rawBody); } catch { return null; }
  },
};

// ---------------------------------------------------------------- PayPal
function paypalConf(config) {
  const c = config.payments?.paypal;
  if (!c) throw new PaymentError('PayPal is not set up on this Skyfly platform yet.', { status: 503, code: 'NOT_CONFIGURED' });
  return c;
}
let ppToken = null;
async function paypalToken(config) {
  const c = paypalConf(config);
  if (ppToken && ppToken.base === c.apiBase && ppToken.until > Date.now() + 60000) return ppToken.value;
  const res = await fetch(`${c.apiBase}/v1/oauth2/token`, {
    method: 'POST', body: 'grant_type=client_credentials', signal: AbortSignal.timeout(20000),
    headers: { Authorization: `Basic ${Buffer.from(`${c.clientId}:${c.clientSecret}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.access_token) throw new PaymentError(`PayPal sign-in failed (HTTP ${res.status}).`);
  ppToken = { value: j.access_token, until: Date.now() + Number(j.expires_in || 300) * 1000, base: c.apiBase };
  return ppToken.value;
}
const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
// Acting for a connected merchant (PayPal's documented assertion: unsigned, issuer = platform client).
const authAssertion = (config, merchantId) => `${b64url({ alg: 'none' })}.${b64url({ iss: paypalConf(config).clientId, payer_id: merchantId })}.`;
async function paypalCall(config, path, { method = 'GET', body = null, merchantId = null, requestId = null } = {}) {
  const c = paypalConf(config);
  const headers = { Authorization: `Bearer ${await paypalToken(config)}`, 'Content-Type': 'application/json' };
  if (merchantId) headers['PayPal-Auth-Assertion'] = authAssertion(config, merchantId);
  if (c.bnCode) headers['PayPal-Partner-Attribution-Id'] = c.bnCode;
  if (requestId) headers['PayPal-Request-Id'] = requestId;
  const res = await fetch(`${c.apiBase}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000) });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new PaymentError(`PayPal: ${j.details?.[0]?.description || j.message || `HTTP ${res.status}`}`.slice(0, 300)), { paypal: j, httpStatus: res.status });
  return j;
}
const usd = (minor) => (Number(minor) / 100).toFixed(2);
export const paypal = {
  // PayPal's partner referral: the merchant signs in to PayPal and grants Skyfly permission to take
  // payments for them. Returns the PayPal page to send the owner to.
  async referral(config, { trackingId, returnUrl }) {
    const r = await paypalCall(config, '/v2/customer/partner-referrals', {
      method: 'POST',
      body: {
        tracking_id: trackingId,
        partner_config_override: { return_url: returnUrl },
        operations: [{ operation: 'API_INTEGRATION', api_integration_preference: { rest_api_integration: { integration_method: 'PAYPAL', integration_type: 'THIRD_PARTY', third_party_details: { features: ['PAYMENT', 'REFUND'] } } } }],
        products: ['EXPRESS_CHECKOUT'],
        legal_consents: [{ type: 'SHARE_DATA_CONSENT', granted: true }],
      },
    });
    const link = (r.links || []).find((l) => l.rel === 'action_url')?.href;
    if (!link) throw new PaymentError('PayPal did not return a sign-up link.');
    return link;
  },
  // The merchant's status as PayPal reports it (never what the browser's return link says).
  async merchant(config, merchantId) {
    const c = paypalConf(config);
    const m = await paypalCall(config, `/v1/customer/partners/${encodeURIComponent(c.partnerMerchantId)}/merchant-integrations/${encodeURIComponent(merchantId)}`);
    return { paymentsReceivable: m.payments_receivable === true, emailConfirmed: m.primary_email_confirmed === true, merchantId: m.merchant_id };
  },
  async createOrder(config, { merchantId, order, lines, returnUrl, cancelUrl }) {
    const itemTotal = lines.filter((l) => !l.delivery).reduce((n, l) => n + l.unitMinor * l.quantity, 0);
    const shipping = lines.filter((l) => l.delivery).reduce((n, l) => n + l.unitMinor, 0);
    const r = await paypalCall(config, '/v2/checkout/orders', {
      method: 'POST', merchantId, requestId: `skyfly-${order.reference}-${order.attempt}`,
      body: {
        intent: 'CAPTURE',
        purchase_units: [{
          reference_id: order.reference, custom_id: order.reference, invoice_id: `${order.reference}-${order.attempt}`,
          payee: { merchant_id: merchantId },
          amount: { currency_code: 'USD', value: usd(order.total_minor), breakdown: { item_total: { currency_code: 'USD', value: usd(itemTotal) }, shipping: { currency_code: 'USD', value: usd(shipping) } } },
          items: lines.filter((l) => !l.delivery).map((l) => ({ name: l.name.slice(0, 127), quantity: String(l.quantity), unit_amount: { currency_code: 'USD', value: usd(l.unitMinor) } })),
        }],
        application_context: { return_url: returnUrl, cancel_url: cancelUrl, user_action: 'PAY_NOW', shipping_preference: 'NO_SHIPPING' },
      },
    });
    const approve = (r.links || []).find((l) => l.rel === 'approve' || l.rel === 'payer-action')?.href;
    if (!approve) throw new PaymentError('PayPal did not return an approval link.');
    return { ref: r.id, url: approve };
  },
  async capture(config, merchantId, paypalOrderId) {
    return paypalCall(config, `/v2/checkout/orders/${encodeURIComponent(paypalOrderId)}/capture`, { method: 'POST', merchantId, requestId: `skyfly-capture-${paypalOrderId}` });
  },
  async order(config, merchantId, paypalOrderId) {
    return paypalCall(config, `/v2/checkout/orders/${encodeURIComponent(paypalOrderId)}`, { merchantId });
  },
  async refund(config, merchantId, captureId, amountMinor, key) {
    const r = await paypalCall(config, `/v2/payments/captures/${encodeURIComponent(captureId)}/refund`, { method: 'POST', merchantId, requestId: key, body: { amount: { currency_code: 'USD', value: usd(amountMinor) } } });
    return { ref: r.id, status: r.status };
  },
  // PayPal's own verification of a webhook delivery (signature checked by PayPal against our webhook ID).
  async verify(config, headers, rawBody) {
    const c = config.payments?.paypal;
    if (!c?.webhookId) return null;
    const h = (k) => headers[k] ?? headers[k.toLowerCase()];
    let event; try { event = JSON.parse(rawBody); } catch { return null; }
    const r = await paypalCall(config, '/v1/notifications/verify-webhook-signature', {
      method: 'POST',
      body: { auth_algo: h('paypal-auth-algo'), cert_url: h('paypal-cert-url'), transmission_id: h('paypal-transmission-id'), transmission_sig: h('paypal-transmission-sig'), transmission_time: h('paypal-transmission-time'), webhook_id: c.webhookId, webhook_event: event },
    }).catch(() => null);
    return r?.verification_status === 'SUCCESS' ? event : null;
  },
};

// ---------------------------------------------------------------- connections
export async function connectionsFor(pool, businessId) {
  const { rows } = await pool.query('SELECT provider, status, account_id, mode, enabled, details, connected_at, updated_at FROM payment_connections WHERE business_id = $1', [businessId]);
  return Object.fromEntries(rows.map((r) => [r.provider, r]));
}
// The gateways a customer can pay this business with right now: connected, enabled, and the platform
// has credentials for that gateway in the same mode (test/live).
export async function usableGateways(pool, config, businessId) {
  const conns = await connectionsFor(pool, businessId);
  return Object.keys(PROVIDERS).filter((p) => {
    const c = conns[p]; const plat = config.payments?.[p];
    return plat && c && c.status === 'connected' && c.enabled && c.account_id && c.mode === plat.mode;
  });
}
export async function createState(pool, { businessId, userId, provider }) {
  const state = randomBytes(24).toString('base64url');
  await pool.query(
    `INSERT INTO payment_oauth_states (state_hash, business_id, user_id, provider, expires_at) VALUES ($1, $2, $3, $4, now() + make_interval(mins => $5))`,
    [hashState(state), businessId, userId, provider, STATE_MINUTES]);
  return state;
}
// The authorisation request this state belongs to, used once, only by the same signed-in user.
export async function useState(pool, { state, userId, provider }) {
  const { rows: [s] } = await pool.query(
    `UPDATE payment_oauth_states SET used_at = now()
      WHERE state_hash = $1 AND user_id = $2 AND provider = $3 AND used_at IS NULL AND expires_at > now()
      RETURNING business_id`, [hashState(state), userId, provider]);
  return s?.business_id ?? null;
}
export async function saveConnection(pool, req, { businessId, provider, accountId, mode, details, status = 'connected' }) {
  await pool.query(
    `INSERT INTO payment_connections (business_id, provider, status, account_id, mode, enabled, details, connected_by, connected_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, true, $6, $7, now(), now())
     ON CONFLICT (business_id, provider) DO UPDATE SET status = EXCLUDED.status, account_id = EXCLUDED.account_id, mode = EXCLUDED.mode,
       enabled = true, details = EXCLUDED.details, connected_by = EXCLUDED.connected_by, connected_at = now(), updated_at = now()`,
    [businessId, provider, status, accountId, mode, JSON.stringify(details ?? {}), req.session.userId]);
  await audit(pool, req, { action: `payments.${provider}_connected`, businessId, details: { account: accountId, mode, status } });
}

// ---------------------------------------------------------------- orders
// USD lines of an online order, from what Skyfly saved (never from the browser).
async function orderLines(pool, orderId) {
  const { rows: items } = await pool.query('SELECT product_name, quantity, unit_price_minor FROM order_items WHERE order_id = $1 ORDER BY id', [orderId]);
  const { rows: [o] } = await pool.query('SELECT delivery_fee_minor FROM orders WHERE id = $1', [orderId]);
  const lines = items.map((i) => ({ name: i.product_name, quantity: i.quantity, unitMinor: Number(i.unit_price_minor) }));
  if (Number(o.delivery_fee_minor) > 0) lines.push({ name: 'Delivery', quantity: 1, unitMinor: Number(o.delivery_fee_minor), delivery: true });
  return lines;
}

// Starts (or restarts) online payment for an order in USD: creates the gateway's checkout on the
// business's own account and records a pending transaction. Returns the page to send the customer to.
export async function startPayment(pool, config, orderId, { baseUrl }) {
  const { rows: [o] } = await pool.query(
    `SELECT id, business_id, reference, access_token, total_minor, currency, payment_method, payment_status, email,
            (SELECT count(*)::int FROM payment_transactions t WHERE t.order_id = orders.id AND t.kind = 'payment') + 1 AS attempt
       FROM orders WHERE id = $1`, [orderId]);
  if (!o || !PROVIDERS[o.payment_method]) throw new PaymentError('This order is not paid online.', { status: 400, code: 'NOT_ONLINE' });
  if (o.payment_status === 'paid') throw new PaymentError('This order is already paid.', { status: 409, code: 'ALREADY_PAID' });
  if (o.currency !== ONLINE_CURRENCY) throw new PaymentError('Online payment is in USD only.', { status: 400, code: 'CURRENCY' });
  const provider = o.payment_method;
  if (!(await usableGateways(pool, config, o.business_id)).includes(provider)) throw new PaymentError(`${PROVIDERS[provider]} is not available for this shop right now.`, { status: 409, code: 'GATEWAY_UNAVAILABLE' });
  const { rows: [conn] } = await pool.query('SELECT account_id FROM payment_connections WHERE business_id = $1 AND provider = $2', [o.business_id, provider]);
  const lines = await orderLines(pool, o.id);
  const confirm = `${baseUrl}/o/${o.reference}?t=${o.access_token}`;
  const back = `${baseUrl}/pay/${provider}/return?o=${encodeURIComponent(o.reference)}&t=${o.access_token}`;
  const cancel = `${baseUrl}/pay/${provider}/cancel?o=${encodeURIComponent(o.reference)}&t=${o.access_token}`;
  const created = provider === 'stripe'
    ? await stripe.createCheckout(config, { accountId: conn.account_id, order: o, lines, successUrl: `${back}&session={CHECKOUT_SESSION_ID}`, cancelUrl: cancel })
    : await paypal.createOrder(config, { merchantId: conn.account_id, order: o, lines, returnUrl: back, cancelUrl: cancel });
  await pool.query(
    `INSERT INTO payment_transactions (business_id, order_id, provider, kind, status, amount_minor, currency, account_id, provider_ref)
     VALUES ($1, $2, $3, 'payment', 'pending', $4, 'USD', $5, $6) ON CONFLICT (provider, provider_ref) DO NOTHING`,
    [o.business_id, o.id, provider, o.total_minor, conn.account_id, created.ref]);
  await pool.query("UPDATE orders SET payment_status = 'pending', updated_at = now() WHERE id = $1 AND payment_status IN ('unpaid', 'failed', 'pending')", [o.id]);
  return { redirectUrl: created.url, provider, confirmationUrl: confirm };
}

// The one place an order becomes paid. Checks the confirmed amount, currency and receiving account
// against Skyfly's own record; applies once (a repeated confirmation changes nothing).
export async function markPaid(pool, config, { provider, ref, paymentId, amountMinor, currency, accountId, source }, { onPaid = null } = {}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [t] } = await client.query('SELECT * FROM payment_transactions WHERE provider = $1 AND provider_ref = $2 FOR UPDATE', [provider, ref]);
    if (!t) { await client.query('ROLLBACK'); return { outcome: 'unknown_payment' }; }
    const mismatch = Number(amountMinor) !== Number(t.amount_minor) ? 'amount' : String(currency).toUpperCase() !== t.currency ? 'currency' : accountId !== t.account_id ? 'account' : null;
    if (mismatch) {
      await client.query("UPDATE payment_transactions SET failure_reason = $2, updated_at = now() WHERE id = $1", [t.id, `Confirmation did not match (${mismatch}); not marked paid.`]);
      await client.query('COMMIT');
      return { outcome: `mismatch_${mismatch}`, orderId: t.order_id };
    }
    if (t.status === 'succeeded') { await client.query('COMMIT'); return { outcome: 'already_paid', orderId: t.order_id }; }
    await client.query("UPDATE payment_transactions SET status = 'succeeded', provider_payment_id = $2, failure_reason = NULL, updated_at = now() WHERE id = $1", [t.id, paymentId]);
    const { rows: [o] } = await client.query(
      "UPDATE orders SET payment_status = 'paid', updated_at = now() WHERE id = $1 AND business_id = $2 AND payment_status <> 'paid' RETURNING id, payment_status", [t.order_id, t.business_id]);
    if (o) {
      await client.query(
        `INSERT INTO order_status_history (order_id, from_status, to_status, note, changed_by, kind) VALUES ($1, 'pending', 'paid', $2, NULL, 'payment')`,
        [t.order_id, `${PROVIDERS[provider]} ${paymentId ?? ref}: $${usd(amountMinor)} USD confirmed by ${source}`]);
      await client.query("INSERT INTO audit_log (business_id, action, entity_type, entity_id, details) VALUES ($1, 'payment.succeeded', 'order', $2, $3)",
        [t.business_id, String(t.order_id), JSON.stringify({ provider, ref, paymentId, amount: Number(amountMinor), currency: 'USD', source })]);
    }
    await client.query('COMMIT');
    if (o && onPaid) await Promise.resolve(onPaid(t.order_id)).catch((err) => console.error('After-payment step failed:', err.message));
    return { outcome: o ? 'paid' : 'already_paid', orderId: t.order_id };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally { client.release(); }
}

// A payment attempt that failed or was abandoned: the order stays, marked "Payment failed" (unless it
// was paid by another attempt).
export async function markFailed(pool, { provider, ref, status = 'failed', reason }) {
  const { rows: [t] } = await pool.query(
    `UPDATE payment_transactions SET status = $3, failure_reason = $4, updated_at = now()
      WHERE provider = $1 AND provider_ref = $2 AND status IN ('created', 'pending') RETURNING order_id, business_id`, [provider, ref, status, String(reason ?? '').slice(0, 300) || null]);
  if (!t) return { outcome: 'no_change' };
  const { rowCount } = await pool.query(
    "UPDATE orders SET payment_status = 'failed', updated_at = now() WHERE id = $1 AND payment_status = 'pending' AND NOT EXISTS (SELECT 1 FROM payment_transactions WHERE order_id = $1 AND status IN ('pending', 'created'))", [t.order_id]);
  if (rowCount) {
    await pool.query("INSERT INTO order_status_history (order_id, from_status, to_status, note, changed_by, kind) VALUES ($1, 'pending', 'failed', $2, NULL, 'payment')", [t.order_id, `${PROVIDERS[provider]}: ${reason ?? status}`]);
  }
  return { outcome: 'failed', orderId: t.order_id };
}

export async function markRefunded(pool, { provider, paymentId, amountMinor, refundRef, source }) {
  const { rows: [t] } = await pool.query("SELECT * FROM payment_transactions WHERE provider = $1 AND provider_payment_id = $2 AND kind = 'payment' AND status = 'succeeded'", [provider, paymentId]);
  if (!t) return { outcome: 'unknown_payment' };
  const { rowCount } = await pool.query(
    `INSERT INTO payment_transactions (business_id, order_id, provider, kind, status, amount_minor, currency, account_id, provider_ref, provider_payment_id)
     VALUES ($1, $2, $3, 'refund', 'refunded', $4, 'USD', $5, $6, $7) ON CONFLICT (provider, provider_ref) DO UPDATE SET status = 'refunded', updated_at = now() WHERE payment_transactions.status <> 'refunded'`,
    [t.business_id, t.order_id, provider, amountMinor, t.account_id, refundRef, paymentId]);
  const { rows: [sum] } = await pool.query("SELECT coalesce(sum(amount_minor), 0)::bigint AS n FROM payment_transactions WHERE order_id = $1 AND kind = 'refund' AND status = 'refunded'", [t.order_id]);
  if (Number(sum.n) >= Number(t.amount_minor)) {
    const { rowCount: changed } = await pool.query("UPDATE orders SET payment_status = 'refunded', updated_at = now() WHERE id = $1 AND payment_status = 'paid'", [t.order_id]);
    if (changed) await pool.query("INSERT INTO order_status_history (order_id, from_status, to_status, note, changed_by, kind) VALUES ($1, 'paid', 'refunded', $2, NULL, 'payment')", [t.order_id, `${PROVIDERS[provider]} refund ${refundRef} (${source})`]);
  }
  return { outcome: rowCount ? 'refunded' : 'already_refunded', orderId: t.order_id };
}

// Asks the gateway for the current state of one pending attempt and applies it (server-to-server).
export async function checkTransaction(pool, config, t, opts = {}) {
  if (t.provider === 'stripe') {
    const s = await stripe.session(config, t.account_id, t.provider_ref);
    if (s.payment_status === 'paid' || s.payment_status === 'no_payment_required') {
      return markPaid(pool, config, { provider: 'stripe', ref: s.id, paymentId: typeof s.payment_intent === 'string' ? s.payment_intent : s.payment_intent?.id, amountMinor: s.amount_total, currency: s.currency, accountId: t.account_id, source: 'Stripe (checked by Skyfly)' }, opts);
    }
    if (s.status === 'expired') return markFailed(pool, { provider: 'stripe', ref: s.id, status: 'canceled', reason: 'Checkout expired without payment' });
    return { outcome: 'pending' };
  }
  const o = await paypal.order(config, t.account_id, t.provider_ref);
  if (o.status === 'APPROVED') return capturePaypal(pool, config, t, opts);
  if (o.status === 'COMPLETED') return applyPaypalCapture(pool, config, t, o, 'PayPal (checked by Skyfly)', opts);
  if (o.status === 'VOIDED') return markFailed(pool, { provider: 'paypal', ref: t.provider_ref, status: 'canceled', reason: 'PayPal order voided' });
  return { outcome: 'pending' };
}

function applyPaypalCapture(pool, config, t, o, source, opts) {
  const unit = o.purchase_units?.[0];
  const cap = unit?.payments?.captures?.[0];
  if (!cap) return { outcome: 'pending' };
  if (cap.status === 'COMPLETED') {
    return markPaid(pool, config, { provider: 'paypal', ref: o.id, paymentId: cap.id, amountMinor: Math.round(Number(cap.amount?.value) * 100), currency: cap.amount?.currency_code, accountId: unit.payee?.merchant_id ?? t.account_id, source }, opts);
  }
  if (cap.status === 'DECLINED' || cap.status === 'FAILED') return markFailed(pool, { provider: 'paypal', ref: o.id, reason: `PayPal capture ${cap.status.toLowerCase()}` });
  return { outcome: 'pending' };
}
// The customer approved on PayPal: Skyfly captures it server-side; only PayPal's capture result counts.
export async function capturePaypal(pool, config, t, opts = {}) {
  try {
    const o = await paypal.capture(config, t.account_id, t.provider_ref);
    return applyPaypalCapture(pool, config, t, o, 'PayPal capture', opts);
  } catch (err) {
    const issue = err.paypal?.details?.[0]?.issue;
    if (issue === 'ORDER_ALREADY_CAPTURED') return checkTransaction(pool, config, { ...t, provider: 'paypal' }, opts);
    if (issue === 'INSTRUMENT_DECLINED' || issue === 'PAYER_ACTION_REQUIRED' || err.httpStatus === 422) return markFailed(pool, { provider: 'paypal', ref: t.provider_ref, reason: `PayPal: ${issue ?? err.message}` });
    throw err;
  }
}

// Background reconciliation: attempts still pending after 10 minutes are checked with the gateway.
export async function reconcilePayments(pool, config, { onPaid = null, limit = 25 } = {}) {
  const { rows } = await pool.query(
    `SELECT * FROM payment_transactions WHERE kind = 'payment' AND status IN ('created', 'pending') AND created_at < now() - interval '10 minutes'
      ORDER BY created_at LIMIT $1`, [limit]);
  const out = [];
  for (const t of rows) {
    if (!config.payments?.[t.provider]) continue;
    try { out.push({ ref: t.provider_ref, ...(await checkTransaction(pool, config, t, { onPaid })) }); } catch (err) { out.push({ ref: t.provider_ref, outcome: 'error', error: String(err.message).slice(0, 120) }); }
    // Abandoned for more than a day: the attempt is closed (the order stays, "Payment failed").
    if (out.at(-1).outcome === 'pending' && Date.now() - new Date(t.created_at) > 864e5) await markFailed(pool, { provider: t.provider, ref: t.provider_ref, status: 'canceled', reason: 'Abandoned: not paid within 24 hours' });
  }
  return out;
}

// Records a verified webhook event once; returns false if it was already handled.
export async function firstDelivery(pool, provider, eventId, type) {
  const { rowCount } = await pool.query('INSERT INTO payment_webhook_events (provider, event_id, type) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [provider, eventId, type]);
  return rowCount === 1;
}
export const noteOutcome = (pool, provider, eventId, outcome, orderId) => pool.query('UPDATE payment_webhook_events SET outcome = $3, order_id = $4 WHERE provider = $1 AND event_id = $2', [provider, eventId, outcome, orderId ?? null]);

// Refund (owner, from the order page) through the gateway; the refund is recorded when the gateway confirms.
export async function refundOrder(pool, config, { businessId, orderId }) {
  const { rows: [t] } = await pool.query(
    "SELECT * FROM payment_transactions WHERE order_id = $1 AND business_id = $2 AND kind = 'payment' AND status = 'succeeded' ORDER BY id DESC LIMIT 1", [orderId, businessId]);
  if (!t) throw new PaymentError('There is no completed online payment on this order to refund.', { status: 400, code: 'NOT_REFUNDABLE' });
  const key = `skyfly-refund-${t.id}`;
  const r = t.provider === 'stripe'
    ? await stripe.refund(config, t.account_id, t.provider_payment_id, t.amount_minor, key)
    : await paypal.refund(config, t.account_id, t.provider_payment_id, t.amount_minor, key);
  if (['succeeded', 'COMPLETED', 'pending', 'PENDING'].includes(r.status)) {
    return markRefunded(pool, { provider: t.provider, paymentId: t.provider_payment_id, amountMinor: t.amount_minor, refundRef: r.ref, source: 'refund requested in Skyfly' });
  }
  throw new PaymentError(`The refund was not accepted (${r.status}).`);
}

// Super Admin overview: connections and volumes, no credentials (there are none to show).
export async function paymentsOverview(pool) {
  const { rows: connections } = await pool.query(
    `SELECT c.provider, c.status, c.mode, c.enabled, c.account_id, c.connected_at, b.id AS business_id, b.name
       FROM payment_connections c JOIN businesses b ON b.id = c.business_id ORDER BY b.name, c.provider`);
  const { rows: [cod] } = await pool.query("SELECT count(DISTINCT business_id)::int AS businesses, count(*)::int AS orders FROM orders WHERE payment_method = 'cod' AND NOT is_test AND created_at > now() - interval '30 days'");
  const { rows: totals } = await pool.query(
    `SELECT provider, kind, status, currency, count(*)::int AS n, coalesce(sum(amount_minor), 0)::bigint AS amount
       FROM payment_transactions GROUP BY provider, kind, status, currency ORDER BY provider, kind, status`);
  const { rows: codVolume } = await pool.query(
    "SELECT currency, count(*)::int AS n, coalesce(sum(total_minor), 0)::bigint AS amount FROM orders WHERE payment_method = 'cod' AND payment_status = 'paid' AND NOT is_test GROUP BY currency");
  return { connections, cod, totals, codVolume };
}

// "Payment received" email to the business's own owners (platform sender), once, when the gateway confirms.
export async function notifyOwnersPaid(pool, config, orderId) {
  const p = config.notifyEmail;
  if (!p?.apiKey || !p.fromEmail) return { sent: 0 };
  const { rows: [o] } = await pool.query(
    'SELECT o.reference, o.total_minor, o.currency, o.payment_method, o.business_id, b.name FROM orders o JOIN businesses b ON b.id = o.business_id WHERE o.id = $1', [orderId]);
  if (!o || !PROVIDERS[o.payment_method]) return { sent: 0 };
  const { rows: owners } = await pool.query(
    "SELECT u.email FROM business_members m JOIN users u ON u.id = m.user_id WHERE m.business_id = $1 AND m.role = 'owner' AND u.disabled_at IS NULL", [o.business_id]);
  const { sendEmail } = await import('./emailProviders.js');
  const amount = `$${usd(o.total_minor)} USD`;
  const gateway = PROVIDERS[o.payment_method];
  const link = config.publicBaseUrl ? `${config.publicBaseUrl}/businesses/${o.business_id}/orders?q=${encodeURIComponent(o.reference)}` : null;
  const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let sent = 0;
  for (const u of owners) {
    await sendEmail({ provider: p.provider, apiKey: p.apiKey, baseOverride: config.emailApiBase || null }, {
      to: u.email, fromEmail: p.fromEmail, fromName: p.fromName || 'Skyfly', replyTo: null, headers: {},
      idempotencyKey: `paid:${o.reference}:${u.email}`,
      subject: `Payment received: ${o.reference} (${amount})`,
      text: `${o.name}: order ${o.reference} was paid online with ${gateway} (${amount}), confirmed by ${gateway}.\n${link ? `\nOpen the order: ${link}\n` : ''}`,
      html: `<p>${esc(o.name)}: order <strong>${esc(o.reference)}</strong> was paid online with ${gateway} (<strong>${amount}</strong>), confirmed by ${gateway}.</p>${link ? `<p><a href="${esc(link)}">Open the order</a></p>` : ''}`,
    }).then(() => { sent += 1; }, (err) => console.error('Payment email failed:', err.message));
  }
  return { sent };
}
