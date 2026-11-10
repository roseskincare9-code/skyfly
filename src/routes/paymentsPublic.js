// Public payment routes: the customer's return from Stripe / PayPal, "pay again" for an unpaid online
// order, and the gateways' webhooks. The return pages never mark an order paid on their own: they ask
// the gateway server-to-server (Stripe session / PayPal capture) and only that answer counts.
import express, { Router } from 'express';
import { asyncHandler } from '../lib/http.js';
import {
  stripe, paypal, markPaid, markFailed, markRefunded, checkTransaction, capturePaypal, startPayment, firstDelivery, noteOutcome, PaymentError,
} from '../services/payments.js';

const baseUrl = (req, config) => config.publicBaseUrl || `${req.protocol}://${req.get('host')}`;

// Webhooks: mounted before any body parser so the exact raw body is verified.
export function paymentWebhookRoutes({ pool, config, onPaid = null }) {
  const router = Router();
  const raw = express.raw({ type: '*/*', limit: '512kb' });

  router.post('/webhooks/stripe', raw, asyncHandler(async (req, res) => {
    const body = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
    const event = stripe.verify(config, body, req.get('stripe-signature'));
    if (!event) return res.status(400).json({ ok: false, error: 'BAD_SIGNATURE' });
    if (!(await firstDelivery(pool, 'stripe', event.id, event.type))) return res.json({ ok: true, duplicate: true });
    const obj = event.data?.object ?? {};
    let r = { outcome: 'ignored' };
    // Connect events carry the connected account the money went to; it must be the order's business's account.
    if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
      if (obj.payment_status === 'paid') {
        r = await markPaid(pool, config, { provider: 'stripe', ref: obj.id, paymentId: typeof obj.payment_intent === 'string' ? obj.payment_intent : obj.payment_intent?.id, amountMinor: obj.amount_total, currency: obj.currency, accountId: event.account, source: 'Stripe webhook (signature verified)' }, { onPaid });
      } else r = { outcome: 'awaiting_async_payment' };
    } else if (event.type === 'checkout.session.expired' || event.type === 'checkout.session.async_payment_failed') {
      r = await markFailed(pool, { provider: 'stripe', ref: obj.id, status: event.type.endsWith('expired') ? 'canceled' : 'failed', reason: event.type.endsWith('expired') ? 'Checkout expired without payment' : 'Payment failed at Stripe' });
    } else if (event.type === 'charge.refunded' && obj.payment_intent) {
      const refund = obj.refunds?.data?.[0];
      r = await markRefunded(pool, { provider: 'stripe', paymentId: obj.payment_intent, amountMinor: obj.amount_refunded, refundRef: refund?.id ?? `${obj.id}-refund`, source: 'Stripe webhook' });
    }
    await noteOutcome(pool, 'stripe', event.id, r.outcome, r.orderId);
    res.json({ ok: true, outcome: r.outcome });
  }));

  router.post('/webhooks/paypal', raw, asyncHandler(async (req, res) => {
    const body = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
    const event = await paypal.verify(config, req.headers, body);
    if (!event) return res.status(400).json({ ok: false, error: 'BAD_SIGNATURE' });
    if (!(await firstDelivery(pool, 'paypal', event.id, event.event_type))) return res.json({ ok: true, duplicate: true });
    const r0 = event.resource ?? {};
    const orderRef = r0.supplementary_data?.related_ids?.order_id;
    let r = { outcome: 'ignored' };
    if (event.event_type === 'PAYMENT.CAPTURE.COMPLETED' && orderRef) {
      r = await markPaid(pool, config, { provider: 'paypal', ref: orderRef, paymentId: r0.id, amountMinor: Math.round(Number(r0.amount?.value) * 100), currency: r0.amount?.currency_code, accountId: r0.payee?.merchant_id, source: 'PayPal webhook (verified by PayPal)' }, { onPaid });
    } else if ((event.event_type === 'PAYMENT.CAPTURE.DENIED' || event.event_type === 'PAYMENT.CAPTURE.DECLINED') && orderRef) {
      r = await markFailed(pool, { provider: 'paypal', ref: orderRef, reason: `PayPal: ${event.event_type.split('.').pop().toLowerCase()}` });
    } else if (event.event_type === 'CHECKOUT.ORDER.APPROVED' && r0.id) {
      // Approved but not captured (e.g. the customer closed the tab before returning): capture now.
      const { rows: [t] } = await pool.query("SELECT * FROM payment_transactions WHERE provider = 'paypal' AND provider_ref = $1", [r0.id]);
      if (t && t.status === 'pending') r = await capturePaypal(pool, config, t, { onPaid });
    } else if (event.event_type === 'PAYMENT.CAPTURE.REFUNDED') {
      const captureId = (r0.links || []).find((l) => l.rel === 'up')?.href?.split('/').pop();
      if (captureId) r = await markRefunded(pool, { provider: 'paypal', paymentId: captureId, amountMinor: Math.round(Number(r0.amount?.value) * 100), refundRef: r0.id, source: 'PayPal webhook' });
    }
    await noteOutcome(pool, 'paypal', event.id, r.outcome, r.orderId);
    res.json({ ok: true, outcome: r.outcome });
  }));
  return router;
}

// The customer's return / cancel links and "Pay now" for an unpaid online order (order link + token).
export function paymentReturnRoutes({ pool, config, onPaid = null }) {
  const router = Router();
  const orderFor = async (req) => {
    const ref = String(req.query.o ?? req.params.reference ?? ''); const token = String(req.query.t ?? req.body?.t ?? '');
    if (!ref || !/^[A-Za-z0-9_-]{16,}$/.test(token)) return null;
    const { rows: [o] } = await pool.query('SELECT id, reference, access_token, payment_method, payment_status FROM orders WHERE reference = $1 AND access_token = $2', [ref, token]);
    return o ?? null;
  };
  const toConfirmation = (res, o) => res.redirect(`/o/${o.reference}?t=${o.access_token}`);

  router.get('/pay/:provider(stripe|paypal)/return', asyncHandler(async (req, res) => {
    const o = await orderFor(req);
    if (!o) return res.status(404).render('error', { message: 'Order not found.' });
    const { provider } = req.params;
    // The attempt is looked up by Skyfly's own record for this order (never by an ID chosen by the browser alone).
    const ref = provider === 'stripe' ? String(req.query.session ?? '') : String(req.query.token ?? '');
    const { rows: [t] } = await pool.query("SELECT * FROM payment_transactions WHERE order_id = $1 AND provider = $2 AND provider_ref = $3 AND kind = 'payment'", [o.id, provider, ref]);
    if (t && ['created', 'pending'].includes(t.status)) {
      await (provider === 'paypal' ? capturePaypal(pool, config, t, { onPaid }) : checkTransaction(pool, config, t, { onPaid }))
        .catch((err) => console.error('Payment return check failed:', err.message));
    }
    toConfirmation(res, o);
  }));

  router.get('/pay/:provider(stripe|paypal)/cancel', asyncHandler(async (req, res) => {
    const o = await orderFor(req);
    if (!o) return res.status(404).render('error', { message: 'Order not found.' });
    const { rows } = await pool.query("SELECT * FROM payment_transactions WHERE order_id = $1 AND provider = $2 AND kind = 'payment' AND status IN ('created', 'pending')", [o.id, req.params.provider]);
    for (const t of rows) {
      // Cancelled on the gateway's page: confirm with the gateway that nothing was paid, then close the attempt.
      const r = await checkTransaction(pool, config, t, { onPaid }).catch(() => ({ outcome: 'pending' }));
      if (r.outcome === 'pending') await markFailed(pool, { provider: t.provider, ref: t.provider_ref, status: 'canceled', reason: 'Cancelled by the customer on the payment page' });
    }
    toConfirmation(res, o);
  }));

  // "Pay now" on the confirmation page of an unpaid / failed online order: a new attempt.
  router.post('/o/:reference/pay', express.urlencoded({ extended: false, limit: '2kb' }), asyncHandler(async (req, res) => {
    const o = await orderFor(req);
    if (!o) return res.status(404).render('error', { message: 'Order not found.' });
    if (o.payment_status === 'paid') return toConfirmation(res, o);
    try {
      const { redirectUrl } = await startPayment(pool, config, o.id, { baseUrl: baseUrl(req, config) });
      res.redirect(303, redirectUrl);
    } catch (err) {
      if (err instanceof PaymentError) return res.status(err.status).render('error', { message: err.message });
      throw err;
    }
  }));
  return router;
}
