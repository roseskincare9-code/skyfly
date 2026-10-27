import { Router } from 'express';
import { requireAuth } from '../lib/auth.js';
import { asyncHandler } from '../lib/http.js';
import { ordersRoutes } from './orders.js';
import { productRoutes } from './products.js';
import { landingPageRoutes } from './landingPages.js';
import { settingsRoutes } from './settings.js';
import { apiKeyRoutes } from './apiKeys.js';
import { pixelRoutes } from './pixels.js';
import { PERIODS, periodDays, periodSummary, dailySeries, statusBreakdown, topProducts } from '../services/analytics.js';
import { pageEditorRoutes } from './pageEditor.js';
import { insightRoutes } from './insights.js';
import { googleSheetsRoutes } from './googleSheets.js';
import { SALES_DEFINITIONS, ORDER_STATUSES } from '../lib/statuses.js';
import { audit } from '../lib/audit.js';
import { workspaceAccess, subscriptionState, expireSubscriptions, platformSettings, can } from '../services/tenancy.js';
import { teamRoutes } from './team.js';
import { checkoutRoutes } from './checkouts.js';
import { emailRoutes, emailContactRoutes } from './email.js';

// Everything under /businesses/:businessId is only visible to that business's members
// (and to the platform owner, for setup and support). Checked on every request, together
// with the subscription: an expired or locked client sees the renewal screen instead.
export function workspaceRoutes({ pool, config, onPaid = null, onOrderSaved = () => {} }) {
  const router = Router();
  router.use(requireAuth);

  const scoped = Router({ mergeParams: true });
  scoped.use(asyncHandler(async (req, res, next) => {
    if (!/^\d+$/.test(req.params.businessId)) return res.status(404).render('error', { message: 'Business not found.' });
    const access = await workspaceAccess(pool, req.session.userId, req.params.businessId);
    if (!access) return res.status(404).render('error', { message: 'Business not found.' });
    const b = access.business;
    req.business = b;
    req.role = access.role;
    res.locals.business = b;
    res.locals.role = access.role;
    res.locals.can = (permission) => can(access.role, permission);
    res.locals.viaAdmin = access.viaAdmin;
    res.locals.base = `/businesses/${b.id}`;
    const sub = subscriptionState(b);
    res.locals.subscription = sub;
    if (sub.becameExpired) await expireSubscriptions(pool);
    if (access.viaAdmin) {
      // Support access is logged once per sign-in and business.
      req.session.adminVisits ??= [];
      if (!req.session.adminVisits.includes(b.id)) {
        req.session.adminVisits.push(b.id);
        await audit(pool, req, { action: 'admin.workspace_opened', businessId: b.id });
      }
    }
    if (!sub.open && !access.isPlatformAdmin) {
      const settings = await platformSettings(pool);
      return res.status(402).render('account-locked', { sub, renewalInstructions: settings.renewalInstructions, active: 'subscription' });
    }
    if (req.method === 'GET') {
      const { rows: [p] } = await pool.query("SELECT count(*)::int AS n FROM orders WHERE business_id = $1 AND status = 'pending' AND NOT is_test", [b.id]);
      res.locals.pendingCount = p.n;
    }
    next();
  }));
  const need = (permission) => (req, res, next) => (can(req.role, permission)
    ? next() : res.status(403).render('error', { message: 'Your role in this business does not include this section. Ask the business owner.' }));

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

    const days = periodDays(req.query.days);
    const [summary, series, statusCounts, top] = await Promise.all([
      periodSummary(pool, businessId, days), dailySeries(pool, businessId, days),
      statusBreakdown(pool, businessId, days), topProducts(pool, businessId, days),
    ]);
    const { rows: [sheet] } = await pool.query(
      "SELECT count(*) FILTER (WHERE sheet_sync_status = 'failed')::int AS failed FROM orders WHERE business_id = $1", [businessId]);
    // Onboarding step "Connect your Meta Pixel": shown to those who manage integrations until the
    // business has a tracking ID or the step is skipped.
    const { rows: [tracking] } = await pool.query('SELECT count(*)::int AS n FROM tracking_pixels WHERE business_id = $1', [businessId]);
    const pixelStep = can(req.role, 'integrations') && tracking.n === 0 && !req.business.tracking_setup_skipped_at;
    res.render('overview', {
      pixelStep,
      days, summary, series, statusCounts, top, PERIODS,
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

  scoped.get('/activity', need('settings'), asyncHandler(async (req, res) => {
    const { rows } = await pool.query(
      `SELECT a.*, u.name AS user_name FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
        WHERE a.business_id = $1 ORDER BY a.created_at DESC, a.id DESC LIMIT 200`,
      [req.business.id],
    );
    res.render('activity', { entries: rows, active: 'settings' });
  }));

  scoped.use('/orders', need('orders'), ordersRoutes({ pool, config, onPaid, onOrderSaved }));
  // Abandoned checkouts: separate from orders (never counted as sales).
  scoped.use('/checkouts', need('orders'), checkoutRoutes({ pool, config }));
  scoped.use('/google-sheets', need('integrations'), googleSheetsRoutes({ pool, config, onOrderSaved }));
  // Old address of the Google Sheets screen.
  scoped.get(['/sheet-backup', '/sheet-backup/*'], (req, res) => {
    const q = req.originalUrl.indexOf('?');
    res.redirect(301, `${res.locals.base}/google-sheets${q >= 0 ? req.originalUrl.slice(q) : ''}`);
  });
  scoped.use('/products', need('catalog'), productRoutes({ pool }));
  scoped.use('/customers', need('orders'));
  scoped.use('/analytics', need('catalog'));
  scoped.use(insightRoutes({ pool }));
  scoped.use('/landing-pages', need('catalog'), pageEditorRoutes({ pool, config }));
  scoped.use('/landing-pages', need('catalog'), landingPageRoutes({ pool, config }));
  scoped.use('/settings', need('settings'), settingsRoutes({ pool, config }));
  scoped.use('/api-keys', need('integrations'), apiKeyRoutes({ pool }));
  scoped.use('/pixels', need('integrations'), pixelRoutes({ pool, config }));
  scoped.use('/team', need('team'), teamRoutes({ pool, config }));
  scoped.use('/email', need('marketing'), emailRoutes({ pool, config }));
  scoped.use('/email-contacts', need('marketing'), emailContactRoutes({ pool }));
  scoped.get('/subscription', (req, res) => res.render('subscription', { active: 'subscription' }));
  scoped.get('/integrations', need('integrations'), (req, res) => res.render('integrations', { active: 'integrations' }));

  router.use('/businesses/:businessId', scoped);
  // Readable address by business name, e.g. /b/larose-nigeria/google-sheets → /businesses/<id>/google-sheets.
  // Only for businesses this account can open; anything else is "not found".
  router.get(['/b/:slug', '/b/:slug/*'], asyncHandler(async (req, res) => {
    const { rows: [b] } = await pool.query('SELECT id FROM businesses WHERE slug = $1', [String(req.params.slug)]);
    if (!b || !(await workspaceAccess(pool, req.session.userId, b.id))) return res.status(404).render('error', { message: 'Business not found.' });
    const rest = req.params[0] ? `/${req.params[0]}` : '';
    const q = req.originalUrl.indexOf('?');
    res.redirect(302, `/businesses/${b.id}${rest}${q >= 0 ? req.originalUrl.slice(q) : ''}`);
  }));
  return router;
}
