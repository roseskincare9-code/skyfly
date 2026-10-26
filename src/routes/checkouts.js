// Abandoned checkouts of one business: customers who started an order form but did not finish it.
// Separate from Orders: these are not orders and are never counted as sales. Follow-up is always a
// person contacting one customer about their own unfinished order; Skyfly sends nothing by itself.
import { Router } from 'express';
import { asyncHandler } from '../lib/http.js';
import { audit } from '../lib/audit.js';
import { whatsappDigits, normalizePhone } from '../lib/phone.js';
import { can } from '../services/tenancy.js';
import { STATUS_LABELS, EXPIRE_DAYS, DELETE_DAYS, classifyCheckouts } from '../services/checkouts.js';

const PAGE_SIZE = 50;
const FILTERS = ['abandoned', 'active', 'recovered', 'completed', 'expired', 'all'];

// Where the customer continues: the page's Skyfly address (or its own website), with the session ID.
function resumeUrl(s, config) {
  const base = s.hosted && config.publicBaseUrl ? `${config.publicBaseUrl}/p/${s.slug}/` : s.page_url;
  if (!base || !s.token) return null;
  try { const u = new URL(base); u.searchParams.set('skyfly_checkout', s.token); return u.toString(); } catch { return null; }
}
const itemsText = (items) => (items || []).map((i) => `${i.name} × ${i.quantity}${i.upsell ? ' (add-on)' : ''}`).join(', ');

export function checkoutRoutes({ pool, config }) {
  const router = Router({ mergeParams: true });

  router.get('/', asyncHandler(async (req, res) => {
    const b = req.business;
    await classifyCheckouts(pool, { businessId: b.id });
    const status = FILTERS.includes(req.query.status) ? req.query.status : 'abandoned';
    const test = req.query.test === 'include';
    const pageNumber = Math.max(1, Number.parseInt(req.query.p, 10) || 1);
    const where = ['s.business_id = $1'];
    const params = [b.id];
    if (status !== 'all') { params.push(status); where.push(`s.status = $${params.length}`); }
    if (!test) where.push('NOT s.is_test');
    const [list, count, summary] = await Promise.all([
      pool.query(
        `SELECT s.*, lp.name AS page_name FROM checkout_sessions s LEFT JOIN landing_pages lp ON lp.id = s.landing_page_id
          WHERE ${where.join(' AND ')} ORDER BY s.last_activity_at DESC LIMIT ${PAGE_SIZE} OFFSET ${(pageNumber - 1) * PAGE_SIZE}`, params),
      pool.query(`SELECT count(*)::int AS n FROM checkout_sessions s WHERE ${where.join(' AND ')}`, params),
      // Last 30 days, real checkouts only (test sessions are left out).
      pool.query(
        `SELECT status, count(*)::int AS n, coalesce(sum(total_minor), 0)::bigint AS value FROM checkout_sessions
          WHERE business_id = $1 AND NOT is_test AND started_at > now() - interval '30 days' GROUP BY status`, [b.id]),
    ]);
    const by = Object.fromEntries(summary.rows.map((r) => [r.status, r]));
    const n = (k) => by[k]?.n ?? 0;
    const value = (k) => Number(by[k]?.value ?? 0);
    const lost = n('abandoned') + n('expired');
    res.set('Cache-Control', 'no-store');
    res.render('checkouts', {
      active: 'checkouts', sessions: list.rows, total: count.rows[0].n, status, test, FILTERS, STATUS_LABELS,
      pageNumber, pageCount: Math.max(1, Math.ceil(count.rows[0].n / PAGE_SIZE)), itemsText,
      summary: {
        abandoned: n('abandoned'), abandonedValue: value('abandoned'), recovered: n('recovered'), recoveredValue: value('recovered'),
        rate: lost + n('recovered') ? Math.round((100 * n('recovered')) / (lost + n('recovered'))) : null,
      },
      minutes: b.abandoned_after_minutes, canSettings: can(req.role, 'settings'), EXPIRE_DAYS, DELETE_DAYS,
      notice: req.query.saved ? 'Saved.' : null,
    });
  }));

  // How long a checkout may be idle before it counts as abandoned (owners and managers).
  router.post('/settings', asyncHandler(async (req, res) => {
    if (!can(req.role, 'settings')) return res.status(403).render('error', { message: 'Your role in this business does not include this section. Ask the business owner.' });
    const minutes = Number.parseInt(req.body.abandoned_after_minutes, 10);
    if (!Number.isInteger(minutes) || minutes < 10 || minutes > 10080) return res.status(400).render('error', { message: 'Choose between 10 minutes and 7 days (10080 minutes).' });
    await pool.query('UPDATE businesses SET abandoned_after_minutes = $2 WHERE id = $1', [req.business.id, minutes]);
    await audit(pool, req, { action: 'checkouts.settings_updated', businessId: req.business.id, details: { abandonedAfterMinutes: minutes } });
    res.redirect(`${res.locals.base}/checkouts?saved=1`);
  }));

  async function load(req) {
    if (!/^\d+$/.test(req.params.id)) return null;
    const { rows: [s] } = await pool.query(
      `SELECT s.*, lp.name AS page_name, lp.slug, lp.url AS page_url, (lp.published_version_id IS NOT NULL) AS hosted, o.reference AS order_reference
         FROM checkout_sessions s LEFT JOIN landing_pages lp ON lp.id = s.landing_page_id LEFT JOIN orders o ON o.id = s.order_id
        WHERE s.id = $1 AND s.business_id = $2`, [req.params.id, req.business.id]);
    return s ?? null;
  }

  router.get('/:id', asyncHandler(async (req, res) => {
    await classifyCheckouts(pool, { businessId: req.business.id });
    const s = await load(req);
    if (!s) return res.status(404).render('error', { message: 'Checkout not found.' });
    const open = ['active', 'abandoned'].includes(s.status);
    const link = open ? resumeUrl(s, config) : null;
    const first = String(s.customer_name || '').split(/\s+/)[0];
    const message = `Hi${first ? ` ${first}` : ''}, this is ${req.business.name}. We noticed you started an order${s.items?.length ? ` for ${itemsText(s.items)}` : ''} on our website but it was not completed. Can we help you finish it?${link ? ` You can continue here: ${link}` : ''}`;
    const phone = normalizePhone(s.phone);
    res.set('Cache-Control', 'no-store');
    res.render('checkout', {
      active: 'checkouts', s, STATUS_LABELS, itemsText, link,
      contact: s.status === 'abandoned' ? {
        whatsapp: phone ? `https://wa.me/${whatsappDigits(phone)}?text=${encodeURIComponent(message)}` : null,
        call: phone ? `tel:${phone}` : null,
        email: s.email ? `mailto:${s.email}?subject=${encodeURIComponent(`Your order with ${req.business.name}`)}&body=${encodeURIComponent(message)}` : null,
      } : null,
      notice: req.query.contacted ? 'Marked as contacted.' : null,
    });
  }));

  // Records that someone contacted this customer (one at a time, by hand).
  router.post('/:id/contacted', asyncHandler(async (req, res) => {
    const s = await load(req);
    if (!s) return res.status(404).render('error', { message: 'Checkout not found.' });
    const channel = ['whatsapp', 'call', 'email'].includes(req.body.channel) ? req.body.channel : 'other';
    await pool.query('UPDATE checkout_sessions SET followed_up_at = now(), follow_up_count = follow_up_count + 1 WHERE id = $1 AND business_id = $2', [s.id, req.business.id]);
    await audit(pool, req, { action: 'checkouts.contacted', businessId: req.business.id, entityType: 'checkout', entityId: s.id, details: { channel } });
    res.redirect(`${res.locals.base}/checkouts/${s.id}?contacted=1`);
  }));

  return router;
}
