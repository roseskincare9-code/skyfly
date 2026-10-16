// Customers (built from orders, grouped by phone number) and Analytics pages.
import { Router } from 'express';
import { asyncHandler } from '../lib/http.js';
import { PERIODS, periodDays, periodSummary, dailySeries, statusBreakdown, topProducts, breakdown } from '../services/analytics.js';

const PAGE_SIZE = 50;

export function insightRoutes({ pool }) {
  const router = Router({ mergeParams: true });

  router.get('/customers', asyncHandler(async (req, res) => {
    const q = String(req.query.q ?? '').trim().slice(0, 100);
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const params = [req.business.id];
    let where = 'o.business_id = $1 AND NOT o.is_test';
    if (q) {
      params.push(`%${q.replace(/[\\%_]/g, '\\$&')}%`);
      const digits = q.replace(/\D/g, '');
      where += ` AND (o.customer_name ILIKE $2 OR o.email ILIKE $2${digits.length >= 4 ? ` OR o.phone LIKE '%' || $${params.push(digits.replace(/^0/, ''))} || '%'` : ''})`;
    }
    const [{ rows: customers }, { rows: [count] }] = await Promise.all([
      pool.query(
        `SELECT o.phone,
                (array_agg(o.customer_name ORDER BY o.created_at DESC))[1] AS name,
                (array_agg(o.email ORDER BY o.created_at DESC) FILTER (WHERE o.email IS NOT NULL))[1] AS email,
                (array_agg(o.state ORDER BY o.created_at DESC) FILTER (WHERE o.state IS NOT NULL AND o.state <> ''))[1] AS state,
                count(*)::int AS orders,
                coalesce(sum(o.total_minor) FILTER (WHERE o.status NOT IN ('cancelled', 'returned')), 0)::bigint AS spent,
                coalesce(sum(o.total_minor) FILTER (WHERE o.payment_status = 'paid'), 0)::bigint AS paid,
                min(o.created_at) AS first_order, max(o.created_at) AS last_order
           FROM orders o WHERE ${where}
          GROUP BY o.phone ORDER BY max(o.created_at) DESC
          LIMIT ${PAGE_SIZE} OFFSET ${(page - 1) * PAGE_SIZE}`, params),
      pool.query(`SELECT count(DISTINCT o.phone)::int AS n, count(DISTINCT o.phone) FILTER (WHERE o.phone IN (SELECT phone FROM orders WHERE business_id = $1 AND NOT is_test GROUP BY phone HAVING count(*) > 1))::int AS repeat FROM orders o WHERE ${where}`, params),
    ]);
    res.render('customers', { active: 'customers', customers, total: count.n, repeat: count.repeat, q, page, pages: Math.max(1, Math.ceil(count.n / PAGE_SIZE)) });
  }));

  router.get('/analytics', asyncHandler(async (req, res) => {
    const days = periodDays(req.query.days);
    const id = req.business.id;
    const [summary, series, statusCounts, top, byPage, bySource, byState] = await Promise.all([
      periodSummary(pool, id, days), dailySeries(pool, id, days), statusBreakdown(pool, id, days), topProducts(pool, id, days, 10),
      breakdown(pool, id, days, 'page'), breakdown(pool, id, days, 'source'), breakdown(pool, id, days, 'state'),
    ]);
    res.render('analytics', { active: 'analytics', days, PERIODS, summary, series, statusCounts, top, byPage, bySource, byState });
  }));

  return router;
}
