// Public pricing page, and the owner's return from Paystack's checkout. The return page never activates a
// plan from the browser's word: it asks Paystack server-to-server (verifyReference) and only that counts.
import { Router } from 'express';
import { asyncHandler } from '../lib/http.js';
import { PLANS } from '../lib/plans.js';
import { platformSettings, workspaceAccess } from '../services/tenancy.js';
import { billingReady, verifyReference } from '../services/billing.js';

export function billingRoutes({ pool, config }) {
  const router = Router();

  router.get('/pricing', asyncHandler(async (req, res) => {
    const settings = await platformSettings(pool);
    res.set('Cache-Control', 'no-store');
    res.render('pricing', { PLANS, limits: settings.planLimits, billingOn: billingReady(config), signedIn: Boolean(req.session.userId) });
  }));

  router.get('/billing/paystack/callback', asyncHandler(async (req, res) => {
    const reference = String(req.query.reference ?? req.query.trxref ?? '');
    const { rows: [pay] } = await pool.query('SELECT business_id FROM subscription_payments WHERE reference = $1', [reference]);
    if (!pay) return res.status(404).render('error', { message: 'Payment not found.' });
    let outcome;
    try { ({ outcome } = await verifyReference(pool, config, reference, 'Paystack verification (return page)')); }
    catch (err) { console.error('Paystack verify:', err.message); outcome = 'check_failed'; }
    // Only someone who belongs to that business is sent to its subscription page.
    if (req.session.userId && (await workspaceAccess(pool, req.session.userId, pay.business_id))) {
      return res.redirect(`/businesses/${pay.business_id}/subscription?payment=${encodeURIComponent(outcome)}`);
    }
    const msg = { activated: 'Payment confirmed by Paystack: the plan is active. Sign in to see it.', already_applied: 'This payment was already confirmed. Sign in to see your plan.' }[outcome]
      ?? 'Payment not confirmed yet. Sign in to see the latest status; nothing is charged twice.';
    return res.render('error', { message: msg });
  }));
  return router;
}
