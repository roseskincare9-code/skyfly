import { Router } from 'express';
import { requireAuth } from '../lib/auth.js';
import { asyncHandler } from '../lib/http.js';
import { ordersRoutes } from './orders.js';
import { productRoutes } from './products.js';
import { landingPageRoutes } from './landingPages.js';
import { settingsRoutes } from './settings.js';
import { SALES_DEFINITIONS, ORDER_STATUSES } from '../lib/statuses.js';

// Everything under /businesses/:businessId is only visible to that business's owner.
export function workspaceRoutes({ pool }) {
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
    const byStatus = await pool.query(
      `SELECT status, count(*)::int AS count, coalesce(sum(total_minor), 0)::bigint AS total
         FROM orders WHERE business_id = $1 GROUP BY status`,
      [businessId],
    );
    const counts = Object.fromEntries(ORDER_STATUSES.map((s) => [s.value, { count: 0, total: 0 }]));
    for (const r of byStatus.rows) counts[r.status] = { count: r.count, total: r.total };
    const sum = (statuses, key) => statuses.reduce((acc, s) => acc + counts[s][key], 0);

    const today = await pool.query(
      `SELECT count(*)::int AS count, coalesce(sum(total_minor), 0)::bigint AS total FROM orders
        WHERE business_id = $1 AND created_at >= date_trunc('day', now() AT TIME ZONE 'Africa/Lagos') AT TIME ZONE 'Africa/Lagos'`,
      [businessId],
    );
    const byPage = await pool.query(
      `SELECT lp.id, lp.name, count(o.id)::int AS orders,
              coalesce(sum(o.total_minor) FILTER (WHERE o.status = ANY($2::text[])), 0)::bigint AS confirmed_sales
         FROM landing_pages lp LEFT JOIN orders o ON o.landing_page_id = lp.id
        WHERE lp.business_id = $1 GROUP BY lp.id ORDER BY orders DESC, lp.name LIMIT 10`,
      [businessId, SALES_DEFINITIONS.confirmed],
    );
    const recent = await pool.query(
      `SELECT id, reference, customer_name, status, total_minor, currency, created_at
         FROM orders WHERE business_id = $1 ORDER BY created_at DESC LIMIT 8`,
      [businessId],
    );

    res.render('overview', {
      counts,
      totalOrders: Object.values(counts).reduce((a, c) => a + c.count, 0),
      sales: {
        confirmed: sum(SALES_DEFINITIONS.confirmed, 'total'),
        confirmedCount: sum(SALES_DEFINITIONS.confirmed, 'count'),
        delivered: sum(SALES_DEFINITIONS.delivered, 'total'),
        deliveredCount: sum(SALES_DEFINITIONS.delivered, 'count'),
        pipeline: sum(SALES_DEFINITIONS.pipeline, 'total'),
        lost: sum(SALES_DEFINITIONS.lost, 'total'),
      },
      today: today.rows[0],
      byPage: byPage.rows,
      recent: recent.rows,
    });
  }));

  scoped.use('/orders', ordersRoutes({ pool }));
  scoped.use('/products', productRoutes({ pool }));
  scoped.use('/landing-pages', landingPageRoutes({ pool }));
  scoped.use('/settings', settingsRoutes({ pool }));

  router.use('/businesses/:businessId', scoped);
  return router;
}
