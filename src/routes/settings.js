import { Router } from 'express';
import { asyncHandler } from '../lib/http.js';
import { normalizePhone } from '../lib/phone.js';
import { audit } from '../lib/audit.js';

export const CURRENCIES = ['NGN', 'GBP', 'USD', 'EUR'];

export function settingsRoutes({ pool }) {
  const router = Router({ mergeParams: true });

  // Currency can change only while the business has no orders, so totals never mix currencies.
  async function currencyLocked(businessId) {
    const { rows: [r] } = await pool.query('SELECT EXISTS (SELECT 1 FROM orders WHERE business_id = $1) AS any', [businessId]);
    return r.any;
  }
  const page = async (req, res, { error = null, saved = false, status = 200 } = {}) => res.status(status).render('settings', {
    error, saved, CURRENCIES, currencyLocked: await currencyLocked(req.business.id),
  });

  router.get('/', asyncHandler((req, res) => page(req, res, { saved: req.query.saved === '1' })));

  router.post('/', asyncHandler(async (req, res) => {
    const name = String(req.body.name ?? '').trim().slice(0, 100);
    const rawPhone = String(req.body.whatsapp_number ?? '').trim();
    const whatsapp = rawPhone ? normalizePhone(rawPhone) : null;
    const prefix = String(req.body.order_prefix ?? '').trim().toUpperCase();
    const locked = await currencyLocked(req.business.id);
    const currency = locked ? req.business.currency : String(req.body.currency ?? req.business.currency);
    const errors = [];
    if (!CURRENCIES.includes(currency)) errors.push('Choose a currency from the list.');
    if (!name) errors.push('Business name is required.');
    if (rawPhone && !whatsapp) errors.push('Enter a valid WhatsApp number, e.g. 09049206695.');
    if (!/^[A-Z]{2,5}$/.test(prefix)) errors.push('Order prefix must be 2–5 letters.');
    if (errors.length) return page(req, res, { error: errors.join(' '), status: 400 });

    await pool.query(
      'UPDATE businesses SET name = $1, whatsapp_number = $2, order_prefix = $3, currency = $4 WHERE id = $5',
      [name, whatsapp, prefix, currency, req.business.id],
    );
    await audit(pool, req, { action: 'settings.updated', businessId: req.business.id, details: { name, whatsapp, prefix, currency } });
    res.redirect(`${res.locals.base}/settings?saved=1`);
  }));

  return router;
}
