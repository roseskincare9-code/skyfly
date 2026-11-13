// Skyfly's own plan billing: Business Pro and Agency VIP, paid in ₦ through Skyfly's Paystack account.
//
// A plan is activated or extended ONLY by applyPayment(), and only from Paystack itself: the server-side
// transaction lookup (GET /transaction/verify/:reference) or a webhook whose HMAC-SHA512 signature (secret
// key) was verified. The amount and currency must match what Skyfly asked for; a payment applies once.
// Reaching Paystack's success page proves nothing by itself. Failed or abandoned payments change nothing.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { PLANS } from '../lib/plans.js';
import { emailSuperAdmins } from './infra.js';

export class BillingError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
export const billingReady = (config) => Boolean(config.payments?.paystack?.secretKey);
const ps = (config) => {
  const c = config.payments?.paystack;
  if (!c) throw new BillingError('Online plan payment is not switched on yet. Contact the Skyfly team.', 503);
  return c;
};
async function paystack(config, path, { method = 'GET', body } = {}) {
  const c = ps(config);
  const res = await fetch(`${c.apiBase}${path}`, {
    method, headers: { Authorization: `Bearer ${c.secretKey}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || j.status === false) throw new BillingError(`Paystack: ${j.message || `HTTP ${res.status}`}`.slice(0, 200), 502);
  return j.data;
}

// The business's owner pays: creates a pending payment and Paystack's hosted checkout for the exact amount.
export async function startCheckout(pool, config, { businessId, plan, userId, email, baseUrl }) {
  const p = PLANS[plan];
  if (!p) throw new BillingError('Choose Business Pro or Agency VIP.');
  const c = ps(config);
  const { rows: [b] } = await pool.query('SELECT id, subscription_status FROM businesses WHERE id = $1', [businessId]);
  if (!b) throw new BillingError('Business not found.', 404);
  if (b.subscription_status === 'locked') throw new BillingError('This account is paused by the Skyfly team. Contact them to continue.', 403);
  const reference = `SKY-SUB-${businessId}-${randomBytes(6).toString('hex').toUpperCase()}`;
  await pool.query(
    `INSERT INTO subscription_payments (business_id, plan, amount_minor, currency, mode, reference, status, created_by)
     VALUES ($1, $2, $3, 'NGN', $4, $5, 'pending', $6)`, [businessId, plan, p.priceMinor, c.mode, reference, userId]);
  const data = await paystack(config, '/transaction/initialize', {
    method: 'POST',
    body: {
      email, amount: p.priceMinor, currency: 'NGN', reference, callback_url: `${baseUrl}/billing/paystack/callback`,
      metadata: { skyfly_business_id: businessId, plan, custom_fields: [{ display_name: 'Skyfly plan', variable_name: 'plan', value: p.label }] },
    },
  }).catch(async (err) => {
    await pool.query("UPDATE subscription_payments SET status = 'failed', failure_reason = $2, updated_at = now() WHERE reference = $1", [reference, err.message]);
    throw err;
  });
  return { reference, url: data.authorization_url };
}

// The single place a plan is activated. `tx` is Paystack's transaction (from its verify API or a signed webhook).
export async function applyPayment(pool, tx, { source }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [pay] } = await client.query('SELECT * FROM subscription_payments WHERE reference = $1 FOR UPDATE', [tx.reference]);
    if (!pay) { await client.query('ROLLBACK'); return { outcome: 'unknown_reference' }; }
    if (pay.status === 'success') { await client.query('COMMIT'); return { outcome: 'already_applied', businessId: pay.business_id }; }
    const gw = String(tx.status ?? '').toLowerCase();
    if (gw !== 'success') {
      const status = gw === 'abandoned' ? 'abandoned' : gw === 'failed' || gw === 'reversed' ? 'failed' : null;
      if (status) {
        await client.query('UPDATE subscription_payments SET status = $2, gateway_status = $3, failure_reason = $4, updated_at = now() WHERE id = $1',
          [pay.id, status, gw, String(tx.gateway_response ?? gw).slice(0, 200)]);
      }
      await client.query('COMMIT');
      return { outcome: status ?? 'pending', businessId: pay.business_id };
    }
    // Paid: the amount and currency must be exactly what Skyfly asked for.
    if (Number(tx.amount) !== Number(pay.amount_minor) || String(tx.currency).toUpperCase() !== pay.currency) {
      await client.query("UPDATE subscription_payments SET gateway_status = 'success', failure_reason = $2, updated_at = now() WHERE id = $1",
        [pay.id, `Paid amount ${tx.amount} ${tx.currency} does not match ${pay.amount_minor} ${pay.currency}: not activated; check in Paystack.`]);
      await client.query('COMMIT');
      return { outcome: 'mismatch', businessId: pay.business_id };
    }
    // Period: a renewal continues from the current paid-until date; otherwise it starts today (business's time zone).
    const { rows: [period] } = await client.query(
      `SELECT CASE WHEN b.subscription_status = 'active' AND b.subscription_expires_on >= (now() AT TIME ZONE b.timezone)::date
                   THEN b.subscription_expires_on + 1 ELSE (now() AT TIME ZONE b.timezone)::date END AS start
         FROM businesses b WHERE b.id = $1 FOR UPDATE`, [pay.business_id]);
    const { rows: [{ end }] } = await client.query("SELECT ($1::date + interval '1 month' - interval '1 day')::date AS end", [period.start]);
    const { rows: [before] } = await client.query('SELECT plan, subscription_status, subscription_expires_on FROM businesses WHERE id = $1', [pay.business_id]);
    await client.query(
      `UPDATE businesses SET plan = $2, subscription_status = 'active', subscription_price_minor = $3, subscription_currency = 'NGN',
              subscription_started_on = CASE WHEN subscription_status = 'active' AND subscription_started_on IS NOT NULL THEN subscription_started_on ELSE $4 END,
              subscription_expires_on = $5, subscription_updated_at = now() WHERE id = $1`,
      [pay.business_id, pay.plan, pay.amount_minor, period.start, end]);
    await client.query(
      `UPDATE subscription_payments SET status = 'success', gateway_status = 'success', channel = $2, paid_at = coalesce($3::timestamptz, now()),
              period_start = $4, period_end = $5, failure_reason = NULL, updated_at = now() WHERE id = $1`,
      [pay.id, tx.channel ?? null, tx.paid_at ?? tx.paidAt ?? null, period.start, end]);
    await client.query("INSERT INTO audit_log (business_id, action, entity_type, entity_id, details) VALUES ($1, 'subscription.paid', 'business', $2, $3)",
      [pay.business_id, String(pay.business_id), JSON.stringify({ reference: pay.reference, plan: pay.plan, amount: Number(pay.amount_minor), currency: 'NGN', from: before, until: end, source, mode: pay.mode })]);
    await client.query('COMMIT');
    return { outcome: 'activated', businessId: pay.business_id, plan: pay.plan, start: period.start, end };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally { client.release(); }
}

// Paystack's authoritative answer for one reference (callback page, reconciliation, Super Admin "check").
export async function verifyReference(pool, config, reference, source = 'Paystack verification') {
  if (!/^SKY-SUB-\d+-[0-9A-F]{12}$/.test(String(reference))) return { outcome: 'unknown_reference' };
  const tx = await paystack(config, `/transaction/verify/${encodeURIComponent(reference)}`);
  return applyPayment(pool, { ...tx, reference }, { source });
}

// x-paystack-signature = HMAC-SHA512 of the raw body with the secret key.
export function verifyWebhook(config, rawBody, signature) {
  const key = config.payments?.paystack?.secretKey;
  if (!key || !signature) return null;
  const expected = createHmac('sha512', key).update(rawBody).digest();
  const got = Buffer.from(String(signature), 'hex');
  if (got.length !== expected.length || !timingSafeEqual(got, expected)) return null;
  try { return JSON.parse(rawBody); } catch { return null; }
}

// Pending payments older than 15 minutes are asked again at Paystack (a missed webhook or closed tab);
// after a day without payment they are marked abandoned.
export async function reconcileBilling(pool, config) {
  if (!billingReady(config)) return [];
  const { rows } = await pool.query("SELECT reference, created_at FROM subscription_payments WHERE status = 'pending' AND created_at < now() - interval '15 minutes' ORDER BY id LIMIT 25");
  const out = [];
  for (const r of rows) {
    const res = await verifyReference(pool, config, r.reference, 'Paystack verification (reconciliation)').catch((err) => ({ outcome: 'error', error: err.message }));
    if (res.outcome === 'pending' && Date.now() - new Date(r.created_at) > 864e5) {
      await pool.query("UPDATE subscription_payments SET status = 'abandoned', failure_reason = 'Not paid within 24 hours', updated_at = now() WHERE reference = $1 AND status = 'pending'", [r.reference]);
    }
    out.push({ reference: r.reference, ...res });
  }
  return out;
}

// ---- Expiry alerts for the Super Admin: 14, 7 and 3 days before, and on the expiry date (once each).
export const SUB_THRESHOLDS = [14, 7, 3, 0];
export async function subscriptionAlerts(pool) {
  const { rows } = await pool.query(
    `SELECT b.id, b.name, b.plan, b.subscription_status, b.subscription_price_minor, b.subscription_currency, b.subscription_expires_on::text AS expires_on,
            (b.subscription_expires_on - (now() AT TIME ZONE b.timezone)::date) AS days_left,
            (SELECT p.status FROM subscription_payments p WHERE p.business_id = b.id ORDER BY p.id DESC LIMIT 1) AS last_payment,
            (SELECT p.period_end::text FROM subscription_payments p WHERE p.business_id = b.id AND p.status = 'success' ORDER BY p.id DESC LIMIT 1) AS paid_until
       FROM businesses b
      WHERE b.subscription_status IN ('trial', 'active', 'expired') AND b.subscription_expires_on IS NOT NULL AND b.name NOT LIKE '%(test)'
        AND b.subscription_expires_on - (now() AT TIME ZONE b.timezone)::date <= 14
      ORDER BY b.subscription_expires_on`);
  return rows.map((r) => ({
    ...r, days_left: Number(r.days_left),
    level: Number(r.days_left) <= 3 ? 'act' : 'watch',
    renewal: r.last_payment === 'pending' ? 'payment started, not confirmed yet' : r.last_payment === 'failed' ? 'last payment failed' : r.subscription_status === 'expired' || Number(r.days_left) < 0 ? 'not renewed' : 'not renewed yet',
  }));
}
export async function remindSubscriptions(pool, config) {
  const out = [];
  for (const a of await subscriptionAlerts(pool)) {
    if (a.days_left < 0) continue;
    const step = [...SUB_THRESHOLDS].sort((x, y) => x - y).find((d) => a.days_left <= d);
    if (step === undefined) continue;
    const { rows: [r] } = await pool.query(
      `INSERT INTO subscription_reminders (business_id, threshold, expires_on, status, detail) VALUES ($1, $2, $3, 'not_sent', 'Sending')
       ON CONFLICT (business_id, threshold, expires_on) DO NOTHING RETURNING id`, [a.id, `${step}d`, a.expires_on]);
    if (!r) continue;
    const plan = PLANS[a.plan]?.label ?? 'No plan';
    const amount = a.subscription_price_minor == null ? '' : ` (₦${(Number(a.subscription_price_minor) / 100).toLocaleString('en-NG')}/month)`;
    const what = a.days_left === 0 ? 'expires today' : `expires in ${a.days_left} days`;
    const sent = await emailSuperAdmins(pool, config, {
      subject: `Subscription ${what}: ${a.name}`,
      text: `${a.name} — ${plan}${amount}: subscription ${what} (${a.expires_on}). Renewal: ${a.renewal}.\n${config.publicBaseUrl ? `${config.publicBaseUrl}/admin/subscriptions\n` : ''}`,
      html: `<p><strong>${a.name.replace(/[<>&]/g, '')}</strong> — ${plan}${amount}: subscription ${what} (${a.expires_on}). Renewal: ${a.renewal}.</p>`,
      key: `sub-reminder:${r.id}`,
    });
    await pool.query('UPDATE subscription_reminders SET status = $2, detail = $3 WHERE id = $1', [r.id, sent.status, sent.detail]);
    out.push({ business: a.id, threshold: `${step}d`, status: sent.status });
  }
  return out;
}
