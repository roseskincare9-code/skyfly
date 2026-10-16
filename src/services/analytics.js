// Real business figures for the dashboard and Analytics pages. Test orders are always
// left out. Days are Lagos calendar days. "Order value" = orders not cancelled/returned.
const LAGOS = "'Africa/Lagos'";
const LIVE = "status NOT IN ('cancelled', 'returned')";

export const PERIODS = [7, 30, 90];
export function periodDays(q) { return PERIODS.includes(Number(q)) ? Number(q) : 30; }

export async function periodSummary(pool, businessId, days) {
  const { rows: [r] } = await pool.query(
    `WITH bounds AS (
       SELECT (date_trunc('day', now() AT TIME ZONE ${LAGOS}) - make_interval(days => $2 - 1)) AT TIME ZONE ${LAGOS} AS cur,
              (date_trunc('day', now() AT TIME ZONE ${LAGOS}) - make_interval(days => 2 * $2 - 1)) AT TIME ZONE ${LAGOS} AS prev),
     o AS (SELECT * FROM orders WHERE business_id = $1 AND NOT is_test),
     firsts AS (SELECT min(created_at) AS first_at FROM o GROUP BY phone),
     newc AS (SELECT count(*) FILTER (WHERE f.first_at >= b.cur)::int AS new_customers,
                     count(*) FILTER (WHERE f.first_at >= b.prev AND f.first_at < b.cur)::int AS new_customers_prev
                FROM bounds b LEFT JOIN firsts f ON true),
     agg AS (
       SELECT
         count(o.id) FILTER (WHERE o.created_at >= b.cur)::int AS orders,
         count(o.id) FILTER (WHERE o.created_at >= b.prev AND o.created_at < b.cur)::int AS orders_prev,
         coalesce(sum(o.total_minor) FILTER (WHERE o.created_at >= b.cur AND o.${LIVE}), 0)::bigint AS value,
         coalesce(sum(o.total_minor) FILTER (WHERE o.created_at >= b.prev AND o.created_at < b.cur AND o.${LIVE}), 0)::bigint AS value_prev,
         coalesce(sum(o.total_minor) FILTER (WHERE o.created_at >= b.cur AND o.payment_status = 'paid'), 0)::bigint AS paid,
         count(o.id) FILTER (WHERE o.created_at >= b.cur AND o.status IN ('cancelled', 'returned'))::int AS cancelled,
         count(o.id) FILTER (WHERE o.status = 'pending')::int AS pending_all
       FROM bounds b LEFT JOIN o ON true)
     SELECT agg.*, newc.* FROM agg, newc`, [businessId, days]);
  const change = (a, b) => (b > 0 ? Math.round(((a - b) / b) * 100) : null);
  return {
    ...r, value: Number(r.value), value_prev: Number(r.value_prev), paid: Number(r.paid),
    ordersChange: change(r.orders, r.orders_prev), valueChange: change(Number(r.value), Number(r.value_prev)),
    customersChange: change(r.new_customers, r.new_customers_prev),
    averageOrder: r.orders - r.cancelled > 0 ? Math.round(Number(r.value) / (r.orders - r.cancelled) / 100) * 100 : 0,
  };
}

// One point per day (including days without orders).
export async function dailySeries(pool, businessId, days) {
  const { rows } = await pool.query(
    `SELECT d::date AS day,
            coalesce(sum(o.total_minor) FILTER (WHERE o.${LIVE}), 0)::bigint AS value,
            count(o.id)::int AS orders
       FROM generate_series(date_trunc('day', now() AT TIME ZONE ${LAGOS}) - make_interval(days => $2 - 1),
                            date_trunc('day', now() AT TIME ZONE ${LAGOS}), interval '1 day') d
       LEFT JOIN orders o ON o.business_id = $1 AND NOT o.is_test
            AND (o.created_at AT TIME ZONE ${LAGOS})::date = d::date
      GROUP BY d ORDER BY d`, [businessId, days]);
  return rows.map((r) => ({ day: r.day, value: Number(r.value), orders: r.orders }));
}

export async function statusBreakdown(pool, businessId, days) {
  const { rows } = await pool.query(
    `SELECT status, count(*)::int AS n FROM orders WHERE business_id = $1 AND NOT is_test
        AND created_at >= (date_trunc('day', now() AT TIME ZONE ${LAGOS}) - make_interval(days => $2 - 1)) AT TIME ZONE ${LAGOS}
      GROUP BY status`, [businessId, days]);
  return Object.fromEntries(rows.map((r) => [r.status, r.n]));
}

export async function topProducts(pool, businessId, days, limit = 5) {
  const { rows } = await pool.query(
    `SELECT i.product_code AS code, max(i.product_name) AS name, sum(i.quantity)::int AS quantity,
            count(DISTINCT o.id)::int AS orders, sum(i.line_total_minor)::bigint AS value
       FROM order_items i JOIN orders o ON o.id = i.order_id
      WHERE o.business_id = $1 AND NOT o.is_test AND o.${LIVE}
        AND o.created_at >= (date_trunc('day', now() AT TIME ZONE ${LAGOS}) - make_interval(days => $2 - 1)) AT TIME ZONE ${LAGOS}
      GROUP BY i.product_code ORDER BY quantity DESC, value DESC LIMIT $3`, [businessId, days, limit]);
  return rows.map((r) => ({ ...r, value: Number(r.value) }));
}

// Breakdown by a column (state, utm_source, landing page) for the Analytics page.
export async function breakdown(pool, businessId, days, column) {
  const expr = { state: "coalesce(nullif(o.state, ''), 'Not given')", source: "coalesce(nullif(o.utm_source, ''), CASE o.source WHEN 'manual' THEN 'Entered manually' ELSE 'Direct / unknown' END)",
    page: "coalesce(lp.name, 'No landing page')" }[column];
  const { rows } = await pool.query(
    `SELECT ${expr} AS label, count(*)::int AS orders, coalesce(sum(o.total_minor) FILTER (WHERE o.${LIVE}), 0)::bigint AS value
       FROM orders o LEFT JOIN landing_pages lp ON lp.id = o.landing_page_id
      WHERE o.business_id = $1 AND NOT o.is_test
        AND o.created_at >= (date_trunc('day', now() AT TIME ZONE ${LAGOS}) - make_interval(days => $2 - 1)) AT TIME ZONE ${LAGOS}
      GROUP BY 1 ORDER BY orders DESC, value DESC LIMIT 8`, [businessId, days]);
  return rows.map((r) => ({ ...r, value: Number(r.value) }));
}
