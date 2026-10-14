import { Router } from 'express';
import { asyncHandler } from '../lib/http.js';
import { normalizePhone } from '../lib/phone.js';
import { audit } from '../lib/audit.js';

export function settingsRoutes({ pool }) {
  const router = Router({ mergeParams: true });

  router.get('/', (req, res) => res.render('settings', { error: null, saved: req.query.saved === '1' }));

  router.post('/', asyncHandler(async (req, res) => {
    const name = String(req.body.name ?? '').trim().slice(0, 100);
    const rawPhone = String(req.body.whatsapp_number ?? '').trim();
    const whatsapp = rawPhone ? normalizePhone(rawPhone) : null;
    const prefix = String(req.body.order_prefix ?? '').trim().toUpperCase();
    const errors = [];
    if (!name) errors.push('Business name is required.');
    if (rawPhone && !whatsapp) errors.push('Enter a valid WhatsApp number, e.g. 09049206695.');
    if (!/^[A-Z]{2,5}$/.test(prefix)) errors.push('Order prefix must be 2–5 letters.');
    if (errors.length) return res.status(400).render('settings', { error: errors.join(' '), saved: false });

    await pool.query(
      'UPDATE businesses SET name = $1, whatsapp_number = $2, order_prefix = $3 WHERE id = $4',
      [name, whatsapp, prefix, req.business.id],
    );
    await audit(pool, req, { action: 'settings.updated', businessId: req.business.id, details: { name, whatsapp, prefix } });
    res.redirect(`${res.locals.base}/settings?saved=1`);
  }));

  return router;
}
