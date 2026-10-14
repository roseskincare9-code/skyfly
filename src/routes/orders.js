import { Router } from 'express';
import { asyncHandler } from '../lib/http.js';
import { toCsv } from '../lib/csv.js';
import { ORDER_STATUSES, PAYMENT_STATUSES, STATUS_LABELS, STATUS_VALUES, PAYMENT_LABELS, PAYMENT_VALUES } from '../lib/statuses.js';
import { audit } from '../lib/audit.js';
import { createManualOrder, OrderError } from '../services/orders.js';
import { whatsappDigits } from '../lib/phone.js';

const PAGE_SIZE = 50;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Builds the WHERE clause shared by the order list and the CSV export.
function orderFilters(businessId, query) {
  const where = ['o.business_id = $1'];
  const params = [businessId];
  const filters = {
    q: String(query.q ?? '').trim().slice(0, 100),
    status: STATUS_VALUES.includes(query.status) ? query.status : '',
    payment: PAYMENT_VALUES.includes(query.payment) ? query.payment : '',
    source: ['web', 'api', 'manual'].includes(query.source) ? query.source : '',
    page: /^\d+$/.test(String(query.page ?? '')) ? String(query.page) : '',
    from: DATE_RE.test(String(query.from ?? '')) ? query.from : '',
    to: DATE_RE.test(String(query.to ?? '')) ? query.to : '',
  };
  if (filters.q) {
    params.push(`%${filters.q.replace(/[\\%_]/g, '\\$&')}%`);
    const digits = filters.q.replace(/\D/g, '');
    let phoneClause = '';
    if (digits.length >= 4) {
      params.push(`%${digits.replace(/^0/, '')}%`);
      phoneClause = ` OR o.phone LIKE $${params.length}`;
    }
    const i = phoneClause ? params.length - 1 : params.length;
    where.push(`(o.reference ILIKE $${i} OR o.customer_name ILIKE $${i} OR o.email ILIKE $${i}${phoneClause})`);
  }
  if (filters.status) { params.push(filters.status); where.push(`o.status = $${params.length}`); }
  if (filters.payment) { params.push(filters.payment); where.push(`o.payment_status = $${params.length}`); }
  if (filters.source) { params.push(filters.source); where.push(`o.source = $${params.length}`); }
  if (filters.page) { params.push(filters.page); where.push(`o.landing_page_id = $${params.length}`); }
  if (filters.from) { params.push(filters.from); where.push(`o.created_at >= ($${params.length}::date)::timestamp AT TIME ZONE 'Africa/Lagos'`); }
  if (filters.to) { params.push(filters.to); where.push(`o.created_at < ($${params.length}::date + 1)::timestamp AT TIME ZONE 'Africa/Lagos'`); }
  return { sql: where.join(' AND '), params, filters };
}

export function ordersRoutes({ pool, onPaid = null }) {
  const router = Router({ mergeParams: true });

  router.get('/', asyncHandler(async (req, res) => {
    const { sql, params, filters } = orderFilters(req.business.id, req.query);
    const pageNumber = Math.max(1, Number.parseInt(req.query.p, 10) || 1);
    const [list, count, pages] = await Promise.all([
      pool.query(
        `SELECT o.id, o.reference, o.customer_name, o.phone, o.email, o.state, o.status, o.payment_status, o.source,
                o.total_minor, o.currency, o.created_at, o.utm_campaign,
                lp.name AS landing_page_name,
                (SELECT string_agg(i.product_name || ' × ' || i.quantity, ', ' ORDER BY i.id) FROM order_items i WHERE i.order_id = o.id) AS items
           FROM orders o LEFT JOIN landing_pages lp ON lp.id = o.landing_page_id
          WHERE ${sql} ORDER BY o.created_at DESC LIMIT ${PAGE_SIZE} OFFSET ${(pageNumber - 1) * PAGE_SIZE}`,
        params,
      ),
      pool.query(`SELECT count(*)::int AS n FROM orders o WHERE ${sql}`, params),
      pool.query('SELECT id, name FROM landing_pages WHERE business_id = $1 ORDER BY name', [req.business.id]),
    ]);
    const qs = new URLSearchParams(Object.entries(filters).filter(([, v]) => v)).toString();
    res.render('orders', {
      orders: list.rows,
      total: count.rows[0].n,
      pageNumber,
      pageCount: Math.max(1, Math.ceil(count.rows[0].n / PAGE_SIZE)),
      filters,
      qs,
      landingPages: pages.rows,
      statuses: ORDER_STATUSES,
      paymentStatuses: PAYMENT_STATUSES,
    });
  }));

  async function renderNew(req, res, { error = null, fields = {}, values = {} } = {}, status = 200) {
    const [products, pages] = await Promise.all([
      pool.query('SELECT id, name, price_minor FROM products WHERE business_id = $1 AND active ORDER BY sort_order, id', [req.business.id]),
      pool.query("SELECT id, name FROM landing_pages WHERE business_id = $1 AND status <> 'archived' ORDER BY name", [req.business.id]),
    ]);
    res.status(status).render('order-new', {
      products: products.rows, landingPages: pages.rows, statuses: ORDER_STATUSES, paymentStatuses: PAYMENT_STATUSES,
      error, fields, values,
    });
  }

  router.get('/new', asyncHandler((req, res) => renderNew(req, res)));

  router.post('/new', asyncHandler(async (req, res) => {
    try {
      const order = await createManualOrder(pool, req.business, req.session.userId, req.body);
      await audit(pool, req, { action: 'order.created_manually', businessId: req.business.id, entityType: 'order', entityId: order.reference });
      res.redirect(`${res.locals.base}/orders/${order.id}?saved=1`);
    } catch (err) {
      if (!(err instanceof OrderError)) throw err;
      return renderNew(req, res, { error: err.message, fields: err.details?.fields ?? {}, values: req.body }, 400);
    }
  }));

  router.get('/export.csv', asyncHandler(async (req, res) => {
    const { sql, params } = orderFilters(req.business.id, req.query);
    const { rows } = await pool.query(
      `SELECT o.*, lp.name AS landing_page_name,
              (SELECT string_agg(i.product_name || ' x' || i.quantity || ' @ ' || (i.unit_price_minor / 100.0), '; ' ORDER BY i.id)
                 FROM order_items i WHERE i.order_id = o.id) AS items,
              (SELECT sum(i.quantity)::int FROM order_items i WHERE i.order_id = o.id) AS quantity
         FROM orders o LEFT JOIN landing_pages lp ON lp.id = o.landing_page_id
        WHERE ${sql} ORDER BY o.created_at DESC`,
      params,
    );
    await audit(pool, req, { action: 'orders.exported', businessId: req.business.id, details: { rows: rows.length } });
    const csv = toCsv(
      ['Reference', 'Date (UTC)', 'Status', 'Payment', 'Source', 'Customer', 'Phone', 'Email', 'Address', 'State', 'Items', 'Quantity',
        'Total', 'Currency', 'Customer notes', 'Landing page', 'Source URL', 'UTM source', 'UTM medium', 'UTM campaign', 'UTM content', 'UTM term'],
      rows.map((o) => [
        o.reference, o.created_at.toISOString(), STATUS_LABELS[o.status], PAYMENT_LABELS[o.payment_status], o.source, o.customer_name, o.phone, o.email, o.address, o.state,
        o.items, o.quantity, o.total_minor / 100, o.currency, o.customer_notes, o.landing_page_name, o.source_url,
        o.utm_source, o.utm_medium, o.utm_campaign, o.utm_content, o.utm_term,
      ]),
    );
    const date = new Date().toISOString().slice(0, 10);
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="orders-${date}.csv"`);
    res.set('Cache-Control', 'no-store');
    res.send(`﻿${csv}`);
  }));

  async function loadOrder(req) {
    if (!/^\d+$/.test(req.params.orderId)) return null;
    const { rows } = await pool.query(
      `SELECT o.*, lp.name AS landing_page_name FROM orders o LEFT JOIN landing_pages lp ON lp.id = o.landing_page_id
        WHERE o.id = $1 AND o.business_id = $2`,
      [req.params.orderId, req.business.id],
    );
    return rows[0] ?? null;
  }

  router.get('/:orderId', asyncHandler(async (req, res) => {
    const order = await loadOrder(req);
    if (!order) return res.status(404).render('error', { message: 'Order not found.' });
    const [items, history] = await Promise.all([
      pool.query('SELECT * FROM order_items WHERE order_id = $1 ORDER BY id', [order.id]),
      pool.query(
        `SELECT h.*, u.name AS user_name FROM order_status_history h LEFT JOIN users u ON u.id = h.changed_by
          WHERE h.order_id = $1 ORDER BY h.created_at DESC, h.id DESC`,
        [order.id],
      ),
    ]);
    const waText = `Hello ${order.customer_name.split(' ')[0]}, this is ${req.business.name} about your order ${order.reference}.`;
    res.render('order', {
      order,
      items: items.rows,
      history: history.rows,
      statuses: ORDER_STATUSES,
      paymentStatuses: PAYMENT_STATUSES,
      waUrl: `https://wa.me/${whatsappDigits(order.phone)}?text=${encodeURIComponent(waText)}`,
      saved: req.query.saved === '1',
    });
  }));

  // Fulfilment and payment status are updated independently, each with its own history.
  router.post('/:orderId/status', asyncHandler(async (req, res) => {
    const order = await loadOrder(req);
    if (!order) return res.status(404).render('error', { message: 'Order not found.' });
    const kind = req.body.kind === 'payment' ? 'payment' : 'fulfillment';
    const column = kind === 'payment' ? 'payment_status' : 'status';
    const allowed = kind === 'payment' ? PAYMENT_VALUES : STATUS_VALUES;
    const value = String(req.body.status ?? '');
    const note = String(req.body.note ?? '').trim().slice(0, 1000) || null;
    if (!allowed.includes(value)) return res.status(400).render('error', { message: 'Unknown status.' });

    const previous = order[column];
    if (value !== previous || note) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`UPDATE orders SET ${column} = $1, updated_at = now() WHERE id = $2`, [value, order.id]);
        await client.query(
          'INSERT INTO order_status_history (order_id, from_status, to_status, note, changed_by, kind) VALUES ($1, $2, $3, $4, $5, $6)',
          [order.id, previous, value, note, req.session.userId, kind],
        );
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
      await audit(pool, req, {
        action: `order.${kind}_status_changed`, businessId: req.business.id, entityType: 'order', entityId: order.reference,
        details: { from: previous, to: value },
      });
      if (kind === 'payment' && value === 'paid' && previous !== 'paid' && onPaid) await onPaid(order.id, req);
    }
    res.redirect(`${res.locals.base}/orders/${order.id}?saved=1`);
  }));

  return router;
}
