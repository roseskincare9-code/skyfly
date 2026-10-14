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
import { csrf } from './lib/csrf.js';
import { pageServer } from './hosting/server.js';
import { formatMoney } from './lib/money.js';
import { STATUS_LABELS, PAYMENT_LABELS } from './lib/statuses.js';

const viewsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'views');

const dateFormat = new Intl.DateTimeFormat('en-NG', {
  timeZone: 'Africa/Lagos', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit',
});

// Which part of Skyfly a request is for. Hosted pages live on their own host(s)
// so their scripts can never read dashboard pages or cookies.
function isDashboardRequest(req, config) {
  const host = req.hostname;
  if (config.pagesHost && host === config.pagesHost) return false;
  if (config.dashboardHost && host === config.dashboardHost) return true;
  if (!config.isProduction && (host === 'localhost' || host === '127.0.0.1')) return true;
  return !config.dashboardHost;
}

export function createApp({ pool, config, transformHtml = null, onPaid = null }) {
  const app = express();
  const PgStore = connectPgSimple(session);

  app.set('view engine', 'ejs');
  app.set('views', viewsDir);
  // Render terminates TLS at its proxy; trust it so secure cookies and client IPs work.
  if (config.isProduction) app.set('trust proxy', 1);

  Object.assign(app.locals, {
    formatMoney,
    formatDate: (d) => (d ? dateFormat.format(new Date(d)) : ''),
    STATUS_LABELS,
    PAYMENT_LABELS,
  });

  app.get('/healthz', async (req, res) => {
    try {
      await pool.query('SELECT 1');
      res.json({ status: 'ok' });
    } catch {
      res.status(503).json({ status: 'database_unavailable' });
    }
  });

  const pages = pageServer({ pool, config, transformHtml });
  app.use((req, res, next) => (isDashboardRequest(req, config) ? next() : pages(req, res, next)));

  app.use(helmet());

  // Public order API and confirmation page: no admin session involved.
  app.use(publicRoutes({ pool, config }));

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

  // Slow down password guessing.
  app.use(['/login', '/signup'], rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 20,
    skip: (req) => req.method !== 'POST',
    handler: (req, res) => res.status(429).render('error', { message: 'Too many attempts. Try again in 15 minutes.' }),
  }));

  app.use(authRoutes({ pool, config }));
  app.use(businessRoutes({ pool }));
  app.use(workspaceRoutes({ pool, config, onPaid }));

  app.use((req, res) => res.status(404).render('error', { message: 'Page not found.' }));

  // Log the error server-side; never leak details to the browser.
  app.use((err, req, res, next) => {
    console.error(err);
    if (res.headersSent) return next(err);
    res.status(500).render('error', { message: 'Something went wrong.' });
  });

  return app;
}
