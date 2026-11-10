// Payment Gateways (business owner only): connect the business's OWN Stripe and PayPal accounts through
// the gateways' official authorisation pages, see their status, enable/disable, disconnect and reconnect;
// set the USD delivery fee for online orders. Every action is limited to the signed-in owner's business.
import { Router } from 'express';
import { asyncHandler } from '../lib/http.js';
import { audit } from '../lib/audit.js';
import { parseMajorToMinor } from '../lib/money.js';
import { workspaceAccess } from '../services/tenancy.js';
import {
  PROVIDERS, platformGateways, connectionsFor, usableGateways, createState, useState, saveConnection, stripe, paypal, PaymentError,
} from '../services/payments.js';

const base = (req, config) => config.publicBaseUrl || `${req.protocol}://${req.get('host')}`;

// /businesses/:businessId/payments (mounted behind the workspace's membership check, owner only).
export function paymentSettingsRoutes({ pool, config }) {
  const router = Router({ mergeParams: true });
  const NOTICES = {
    stripe_connected: 'Stripe connected. Customers can now pay this business online in USD with Stripe.',
    paypal_connected: 'PayPal connected. Customers can now pay this business online in USD with PayPal.',
    paypal_pending: 'PayPal received your sign-up, but your PayPal account cannot receive payments yet (PayPal says: check your email confirmation and account limits). It is marked "pending" here until PayPal confirms.',
    disconnected: 'Disconnected. Customers no longer see this payment option.',
    saved: 'Saved.',
  };
  async function render(req, res, { error = null, status = 200 } = {}) {
    const [conns, usable] = await Promise.all([connectionsFor(pool, req.business.id), usableGateways(pool, config, req.business.id)]);
    const { rows: [b] } = await pool.query('SELECT usd_delivery_fee_minor FROM businesses WHERE id = $1', [req.business.id]);
    const { rows: [missing] } = await pool.query('SELECT count(*)::int AS n FROM products WHERE business_id = $1 AND active AND usd_price_minor IS NULL', [req.business.id]);
    res.status(status).render('payments', {
      conns, usable, platform: platformGateways(config), PROVIDERS, usdDeliveryFee: Number(b.usd_delivery_fee_minor),
      productsWithoutUsd: missing.n, error, notice: NOTICES[req.query.done] ?? null,
      modes: { stripe: config.payments?.stripe?.mode ?? null, paypal: config.payments?.paypal?.mode ?? null },
    });
  }
  router.get('/', asyncHandler((req, res) => render(req, res)));

  router.post('/stripe/connect', asyncHandler(async (req, res) => {
    if (!config.payments?.stripe) return render(req, res, { error: 'Stripe is not set up on Skyfly yet. The Skyfly team must finish the one-time Stripe Connect setup first.', status: 503 });
    const state = await createState(pool, { businessId: req.business.id, userId: req.session.userId, provider: 'stripe' });
    await audit(pool, req, { action: 'payments.stripe_connect_started', businessId: req.business.id });
    res.redirect(stripe.authorizeUrl(config, state, `${base(req, config)}/payments/stripe/callback`));
  }));

  router.post('/paypal/connect', asyncHandler(async (req, res) => {
    if (!config.payments?.paypal) return render(req, res, { error: 'PayPal is not set up on Skyfly yet. The Skyfly team must finish the one-time PayPal partner setup first.', status: 503 });
    const state = await createState(pool, { businessId: req.business.id, userId: req.session.userId, provider: 'paypal' });
    try {
      const url = await paypal.referral(config, { trackingId: `skyfly-${req.business.id}-${state.slice(0, 12)}`, returnUrl: `${base(req, config)}/payments/paypal/return?state=${encodeURIComponent(state)}` });
      await audit(pool, req, { action: 'payments.paypal_connect_started', businessId: req.business.id });
      res.redirect(url);
    } catch (err) {
      if (err instanceof PaymentError) return render(req, res, { error: err.message, status: 502 });
      throw err;
    }
  }));

  router.post('/:provider(stripe|paypal)/disconnect', asyncHandler(async (req, res) => {
    const { provider } = req.params;
    const { rows: [c] } = await pool.query("SELECT account_id FROM payment_connections WHERE business_id = $1 AND provider = $2 AND status <> 'disconnected'", [req.business.id, provider]);
    if (c) {
      // Stripe: the platform's access to this account is revoked at Stripe too. PayPal: the merchant can
      // also revoke Skyfly's permission in their PayPal settings; Skyfly stops using it at once either way.
      if (provider === 'stripe' && config.payments?.stripe && c.account_id) await stripe.deauthorize(config, c.account_id).catch((err) => console.error('Stripe deauthorize:', err.message));
      await pool.query("UPDATE payment_connections SET status = 'disconnected', enabled = false, updated_at = now() WHERE business_id = $1 AND provider = $2", [req.business.id, provider]);
      await audit(pool, req, { action: `payments.${provider}_disconnected`, businessId: req.business.id, details: { account: c.account_id } });
    }
    res.redirect(`${res.locals.base}/payments?done=disconnected`);
  }));

  router.post('/:provider(stripe|paypal)/enabled', asyncHandler(async (req, res) => {
    const enabled = req.body.enabled === 'true';
    await pool.query("UPDATE payment_connections SET enabled = $3, updated_at = now() WHERE business_id = $1 AND provider = $2 AND status = 'connected'", [req.business.id, req.params.provider, enabled]);
    await audit(pool, req, { action: `payments.${req.params.provider}_${enabled ? 'enabled' : 'disabled'}`, businessId: req.business.id });
    res.redirect(`${res.locals.base}/payments?done=saved`);
  }));

  router.post('/usd-delivery', asyncHandler(async (req, res) => {
    const raw = String(req.body.usd_delivery_fee ?? '').trim();
    const fee = raw === '' ? 0 : parseMajorToMinor(raw);
    if (fee === null) return render(req, res, { error: 'Enter the USD delivery fee as a number, e.g. 5 or 4.99 (0 = free).', status: 400 });
    await pool.query('UPDATE businesses SET usd_delivery_fee_minor = $2 WHERE id = $1', [req.business.id, fee]);
    await audit(pool, req, { action: 'payments.usd_delivery_fee_set', businessId: req.business.id, details: { fee } });
    res.redirect(`${res.locals.base}/payments?done=saved`);
  }));
  return router;
}

// The gateways send the owner back here (fixed addresses registered with Stripe / PayPal). The state ties
// the return to the same signed-in owner and business that started it, once, within 30 minutes.
export function paymentCallbackRoutes({ pool, config }) {
  const router = Router();
  const finish = async (req, provider, state) => {
    if (!req.session.userId || typeof state !== 'string') return null;
    const businessId = await useState(pool, { state, userId: req.session.userId, provider });
    if (!businessId) return null;
    const access = await workspaceAccess(pool, req.session.userId, businessId);
    // Only the business's own owner (not a Super Admin visiting) connects its accounts.
    return access && !access.viaAdmin && access.role === 'owner' ? businessId : null;
  };
  const refused = (res) => res.status(400).render('error', { message: 'This connection link has expired or was not started from your account. Go to Payment Gateways and click Connect again.' });

  router.get('/payments/stripe/callback', asyncHandler(async (req, res) => {
    const businessId = await finish(req, 'stripe', req.query.state);
    if (!businessId) return refused(res);
    if (req.query.error || !req.query.code) return res.redirect(`/businesses/${businessId}/payments`);
    const { accountId, livemode } = await stripe.exchange(config, String(req.query.code));
    const facts = await stripe.account(config, accountId).catch(() => ({}));
    await saveConnection(pool, req, { businessId, provider: 'stripe', accountId, mode: livemode ? 'live' : 'test', details: facts });
    res.redirect(`/businesses/${businessId}/payments?done=stripe_connected`);
  }));

  router.get('/payments/paypal/return', asyncHandler(async (req, res) => {
    const businessId = await finish(req, 'paypal', req.query.state);
    if (!businessId) return refused(res);
    const merchantId = String(req.query.merchantIdInPayPal ?? '');
    if (!/^[A-Z0-9]{8,20}$/.test(merchantId)) return res.redirect(`/businesses/${businessId}/payments`);
    // Never trust the return link: ask PayPal whether this merchant can receive payments.
    const m = await paypal.merchant(config, merchantId);
    const ready = m.paymentsReceivable && m.emailConfirmed;
    await saveConnection(pool, req, { businessId, provider: 'paypal', accountId: merchantId, mode: config.payments.paypal.mode, details: m, status: ready ? 'connected' : 'pending' });
    res.redirect(`/businesses/${businessId}/payments?done=${ready ? 'paypal_connected' : 'paypal_pending'}`);
  }));
  return router;
}
