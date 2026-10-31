import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { authRoutes } from './routes/auth.js';
import { businessRoutes } from './routes/businesses.js';
import { publicRoutes } from './routes/public.js';
import { workspaceRoutes } from './routes/workspace.js';
import { senderReady } from './services/emailVerification.js';
import { adminRoutes, adminLoginRoutes, backupKeyRoutes } from './routes/admin.js';
import { csrf } from './lib/csrf.js';
import { readFileSync } from 'node:fs';
import { pageServer, sandboxPreview, pathPages } from './hosting/server.js';
import compression from 'compression';
import { injectSkyfly } from './hosting/inject.js';
import { optimizeHtml } from './hosting/speed.js';
import { imageMeta } from './hosting/images.js';
import { recordPurchase } from './services/pixels.js';
import { createLoadControl } from './services/load.js';
import { setGoogleAccess } from './services/googleSheetsApi.js';
import { formatMoney } from './lib/money.js';
import { lineChart, donut, shortMoney } from './lib/charts.js';
import { STATUS_LABELS, PAYMENT_LABELS } from './lib/statuses.js';

const srcDir = path.dirname(fileURLToPath(import.meta.url));
const viewsDir = path.join(srcDir, 'views');
const sdkSource = readFileSync(path.join(srcDir, 'sdk', 'skyfly.js'));

const dateFormat = new Intl.DateTimeFormat('en-NG', {
  timeZone: 'Africa/Lagos', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit',
});

// Which part of Skyfly a request is for. Hosted pages live on their own host(s)
// so their scripts can never read dashboard pages or cookies.
function isDashboardRequest(req, config) {
  const host = req.hostname;
  if (config.pagesHost && host === config.pagesHost) return false;
  if (config.dashboardHost && host === config.dashboardHost) return true;
  if (config.dashboardAliases?.includes(host)) return true;
  if (!config.isProduction && (host === 'localhost' || host === '127.0.0.1')) return true;
  return !config.dashboardHost;
}

export function createApp({ pool, config, transformHtml, onPaid, onOrderSaved = () => {}, workers = null, load = null }) {
  setGoogleAccess(config.google);
  // Fair sharing of the database between businesses, caches and measurements for public traffic.
  load ??= createLoadControl({ pool, config });
  // Published hosted pages get the Skyfly SDK + pixel config; previews are served untouched.
  // The rendered HTML of a published page is the same for every visitor: built once per cache period.
  transformHtml ??= async (html, ctx) => {
    const build = async () => optimizeHtml(await injectSkyfly(pool, config, html, { ...ctx, load }), {
      meta: await imageMeta(pool, ctx.versionId), filePath: ctx.filePath, versionId: ctx.versionId,
    });
    return ctx.preview ? build() : load.caches.html.get(`${ctx.page.id}:${ctx.versionId}:${ctx.filePath}`, build);
  };
  // Marking an order Paid sends the server-side Purchase event (if configured). Never blocks the owner.
  onPaid ??= (orderId) => recordPurchase(pool, config, orderId).catch((err) => console.error('Purchase event error:', err.message));
  const app = express();
  const PgStore = connectPgSimple(session);
  // gzip for HTML, CSS, JS and JSON (pages, dashboard, SDK, API); images are already compressed.
  app.use(compression());

  app.set('view engine', 'ejs');
  app.set('views', viewsDir);
  // Render terminates TLS at its proxy; trust it so secure cookies and client IPs work.
  if (config.isProduction) app.set('trust proxy', 1);

  Object.assign(app.locals, {
    lineChart, donut, shortMoney,
    STATUS_COLORS: { pending: '#E9A23B', confirmed: '#8B7CF0', processing: '#5B8DEF', dispatched: '#3FB6C9', delivered: '#2FA77A', cancelled: '#E2667A', returned: '#B7A3AC' },
    greeting: () => { const h = Number(new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hour12: false, timeZone: 'Africa/Lagos' }).format(new Date())); return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'; },
    formatMoney,
    formatDate: (d) => (d ? dateFormat.format(new Date(d)) : ''),
    STATUS_LABELS,
    PAYMENT_LABELS,
  });

  app.get('/healthz', async (req, res) => {
    try {
      await pool.query('SELECT 1');
      // Background jobs' last runs (times and counts only, no business data).
      res.json(workers ? { status: 'ok', workers } : { status: 'ok' });
    } catch {
      res.status(503).json({ status: 'database_unavailable' });
    }
  });

  // www.<dashboard domain> (e.g. www.getskyfly.com) goes to the main address.
  if (config.dashboardHost) {
    app.use((req, res, next) => (req.hostname === `www.${config.dashboardHost}` ? res.redirect(301, `${config.publicBaseUrl}${req.originalUrl}`) : next()));
  }
  const pages = pageServer({ pool, config, transformHtml, load });
  app.use((req, res, next) => (isDashboardRequest(req, config) ? next() : pages(req, res, next)));

  // Sandboxed previews and published pages on the dashboard address (before Helmet: they carry their own CSP).
  app.use(sandboxPreview({ pool, config, transformHtml }));
  app.use(pathPages({ pool, transformHtml, load }));

  app.use(helmet());

  // Dashboard fonts (versioned file names, so they can be cached for a year).
  app.use('/static', express.static(new URL('./static', import.meta.url).pathname, { immutable: true, maxAge: '365d', index: false }));

  // The page SDK, loaded by landing pages on other sites.
  app.get('/sdk/skyfly.js', (req, res) => {
    res.set('Cross-Origin-Resource-Policy', 'cross-origin');
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Cache-Control', 'public, max-age=300');
    res.type('text/javascript').send(sdkSource);
  });

  // Public order API and confirmation page: no admin session involved.
  app.use(publicRoutes({ pool, config, onOrderSaved, load }));

  app.use(express.urlencoded({ extended: false, limit: '100kb' }));
  app.use(
    session({
      name: 'skyfly.sid',
      store: new PgStore({ pool, tableName: 'user_sessions' }),
      secret: config.sessionSecret,
      resave: false,
      saveUninitialized: false,
      cookie: {
        httpOnly: true,
        sameSite: 'lax',
        secure: config.isProduction,
        maxAge: 1000 * 60 * 60 * 24 * 14,
      },
    }),
  );
  app.use(csrf);

  // Who is signed in, and their businesses, for the sidebar and top bar (dashboard pages only).
  app.use(async (req, res, next) => {
    res.locals.currentUser = null;
    res.locals.userBusinesses = [];
    if (!req.session.userId || req.method !== 'GET') return next();
    try {
      const [{ rows: [user] }, { rows: businesses }] = await Promise.all([
        pool.query('SELECT id, name, email, is_platform_admin FROM users WHERE id = $1', [req.session.userId]),
        pool.query(
          `SELECT b.id, b.name FROM business_members m JOIN businesses b ON b.id = m.business_id
            WHERE m.user_id = $1 ORDER BY b.created_at`, [req.session.userId]),
      ]);
      res.locals.currentUser = user ?? null;
      res.locals.userBusinesses = businesses;
      next();
    } catch (err) {
      next(err);
    }
  });

  // With Skyfly's email sender set up, a self-registered account confirms its email before any dashboard
  // page opens (sign-out, the confirmation pages, invitations and password reset stay reachable).
  if (senderReady(config)) {
    const open = /^\/(verify-email(\/.*)?|logout|login|signup|forgot-password|reset-password\/.*|invite\/.*|admin\/login|static\/.*|sdk\/.*)$/;
    app.use(async (req, res, next) => {
      if (!req.session.userId || open.test(req.path)) return next();
      try {
        const { rows: [u] } = await pool.query('SELECT email_verified_at, is_platform_admin FROM users WHERE id = $1', [req.session.userId]);
        if (!u || u.email_verified_at || u.is_platform_admin) return next();
        if (req.method === 'GET') return res.redirect('/verify-email');
        return res.status(403).render('error', { message: 'Confirm your email address first (see the link we sent you).' });
      } catch (err) { next(err); }
    });
  }

  // Slow down password guessing.
  app.use(['/login', '/admin/login', '/signup', '/forgot-password', '/reset-password', '/verify-email'], rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 20,
    skip: (req) => req.method !== 'POST',
    handler: (req, res) => res.status(429).render('error', { message: 'Too many attempts. Try again in 15 minutes.' }),
  }));

  app.use(authRoutes({ pool, config }));
  app.use(backupKeyRoutes({ pool, config }));
  app.use(adminLoginRoutes({ pool }));
  app.use(businessRoutes({ pool }));
  // Anything saved in the dashboard (pixels, products, pages, publishing) is visible to visitors at
  // once: the public caches are cleared after every successful change.
  app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') res.once('finish', () => { if (res.statusCode < 400) load.clearCaches(); });
    next();
  });
  app.use(adminRoutes({ pool, config, load }));
  app.use(workspaceRoutes({ pool, config, onPaid, onOrderSaved }));

  app.use((req, res) => res.status(404).render('error', { message: 'Page not found.' }));

  // Log the error server-side; never leak details to the browser.
  app.use((err, req, res, next) => {
    console.error(err);
    if (res.headersSent) return next(err);
    res.status(500).render('error', { message: 'Something went wrong.' });
  });

  return app;
}
