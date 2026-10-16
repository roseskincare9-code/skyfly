import { Router } from 'express';
import { requireAuth } from '../lib/auth.js';
import { asyncHandler } from '../lib/http.js';
import { ordersRoutes } from './orders.js';
import { productRoutes } from './products.js';
import { landingPageRoutes } from './landingPages.js';
import { settingsRoutes } from './settings.js';
import { apiKeyRoutes } from './apiKeys.js';
import { pixelRoutes } from './pixels.js';
import { pageEditorRoutes } from './pageEditor.js';
import { sheetBackupRoutes } from './sheetBackup.js';
import { SALES_DEFINITIONS, ORDER_STATUSES } from '../lib/statuses.js';

// Everything under /businesses/:businessId is only visible to that business's owner.
export function workspaceRoutes({ pool, config, onPaid = null, onOrderSaved = () => {} }) {
  const router = Router();
  router.use(requireAuth);

  const scoped = Router({ mergeParams: true });
  scoped.use(asyncHandler(async (req, res, next) => {
    if (!/^\d+$/.test(req.params.businessId)) return res.status(404).render('error', { message: 'Business not found.' });
    const { rows } = await pool.query(
      'SELECT * FROM businesses WHERE id = $1 AND owner_id = $2',
      [req.params.businessId, req.session.userId],
    );
    if (!rows[0]) return res.status(404).render('error', { message: 'Business not found.' });
    req.business = rows[0];
    res.locals.business = rows[0];
    res.locals.base = `/businesses/${rows[0].id}`;
    next();
  }));

  scoped.get('/', asyncHandler(async (req, res) => {
    const businessId = req.business.id;
    const [byStatus, money, today, byPage, recent] = await Promise.all([
      pool.query(
        'SELECT status, count(*)::int AS count, coalesce(sum(total_minor), 0)::bigint AS total FROM orders WHERE business_id = $1 AND NOT is_test GROUP BY status',
        [businessId],
      ),
      pool.query(
        `SELECT
           coalesce(sum(total_minor) FILTER (WHERE payment_status = 'paid'), 0)::bigint AS paid,
           count(*) FILTER (WHERE payment_status = 'paid')::int AS paid_count,
           coalesce(sum(total_minor) FILTER (WHERE payment_status IN ('unpaid', 'pending', 'failed') AND status = ANY($2::text[])), 0)::bigint AS to_collect,
           coalesce(sum(total_minor) FILTER (WHERE payment_status = 'refunded'), 0)::bigint AS refunded
         FROM orders WHERE business_id = $1 AND NOT is_test`,
        [businessId, SALES_DEFINITIONS.confirmed],
      ),
      pool.query(
        `SELECT count(*)::int AS count, coalesce(sum(total_minor), 0)::bigint AS total FROM orders
          WHERE business_id = $1 AND NOT is_test AND created_at >= date_trunc('day', now() AT TIME ZONE 'Africa/Lagos') AT TIME ZONE 'Africa/Lagos'`,
        [businessId],
      ),
      pool.query(
        `SELECT lp.id, lp.name, count(o.id)::int AS orders,
                coalesce(sum(o.total_minor) FILTER (WHERE o.payment_status = 'paid'), 0)::bigint AS paid
           FROM landing_pages lp LEFT JOIN orders o ON o.landing_page_id = lp.id AND NOT o.is_test
          WHERE lp.business_id = $1 GROUP BY lp.id ORDER BY orders DESC, lp.name LIMIT 10`,
        [businessId],
      ),
      pool.query(
        `SELECT id, reference, customer_name, phone, status, payment_status, total_minor, currency, created_at, is_test
           FROM orders WHERE business_id = $1 ORDER BY created_at DESC LIMIT 8`,
        [businessId],
      ),
    ]);
    const counts = Object.fromEntries(ORDER_STATUSES.map((s) => [s.value, { count: 0, total: 0 }]));
    for (const r of byStatus.rows) counts[r.status] = { count: r.count, total: r.total };
    const sum = (statuses, key) => statuses.reduce((acc, s) => acc + counts[s][key], 0);

    const { rows: [sheet] } = await pool.query(
      "SELECT count(*) FILTER (WHERE sheet_sync_status = 'failed')::int AS failed FROM orders WHERE business_id = $1", [businessId]);
    res.render('overview', {
      sheetFailed: sheet.failed,
      counts,
      totalOrders: Object.values(counts).reduce((a, c) => a + c.count, 0),
      sales: {
        confirmed: sum(SALES_DEFINITIONS.confirmed, 'total'),
        confirmedCount: sum(SALES_DEFINITIONS.confirmed, 'count'),
        pipeline: sum(SALES_DEFINITIONS.pipeline, 'total'),
        ...money.rows[0],
      },
      today: today.rows[0],
      byPage: byPage.rows,
      recent: recent.rows,
    });
  }));

  scoped.get('/activity', asyncHandler(async (req, res) => {
    const { rows } = await pool.query(
      `SELECT a.*, u.name AS user_name FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
        WHERE a.business_id = $1 ORDER BY a.created_at DESC, a.id DESC LIMIT 200`,
      [req.business.id],
    );
    res.render('activity', { entries: rows, active: 'activity' });
  }));

  scoped.use('/orders', ordersRoutes({ pool, config, onPaid, onOrderSaved }));
  scoped.use('/sheet-backup', sheetBackupRoutes({ pool, config, onOrderSaved }));
  scoped.use('/products', productRoutes({ pool }));
  scoped.use('/landing-pages', pageEditorRoutes({ pool, config }));
  scoped.use('/landing-pages', landingPageRoutes({ pool, config }));
  scoped.use('/settings', settingsRoutes({ pool }));
  scoped.use('/api-keys', apiKeyRoutes({ pool }));
  scoped.use('/pixels', pixelRoutes({ pool, config }));

  router.use('/businesses/:businessId', scoped);
  return router;
}
