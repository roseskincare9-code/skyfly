import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import helmet from 'helmet';
import { authRoutes } from './routes/auth.js';
import { businessRoutes } from './routes/businesses.js';

const viewsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'views');

export function createApp({ pool, config }) {
  const app = express();
  const PgStore = connectPgSimple(session);

  app.set('view engine', 'ejs');
  app.set('views', viewsDir);
  // Render terminates TLS at its proxy; trust it so secure cookies work.
  if (config.isProduction) app.set('trust proxy', 1);

  app.use(helmet());
  app.use(express.urlencoded({ extended: false, limit: '100kb' }));

  app.get('/healthz', async (req, res) => {
    try {
      await pool.query('SELECT 1');
      res.json({ status: 'ok' });
    } catch {
      res.status(503).json({ status: 'database_unavailable' });
    }
  });

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

  app.use(authRoutes({ pool, config }));
  app.use(businessRoutes({ pool }));

  app.use((req, res) => res.status(404).render('error', { message: 'Page not found.' }));

  // Log the error server-side; never leak details to the browser.
  app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).render('error', { message: 'Something went wrong.' });
  });

  return app;
}
