import { Router } from 'express';
import { hashPassword, verifyPassword } from '../lib/passwords.js';
import { audit } from '../lib/audit.js';
import { ensureLaroseForOwner } from '../services/setup.js';

export function authRoutes({ pool, config }) {
  const router = Router();

  async function signupOpen() {
    if (!config.allowSignup) return false;
    if (!config.signupFirstOnly) return true;
    const { rows } = await pool.query('SELECT EXISTS (SELECT 1 FROM users) AS any');
    return !rows[0].any;
  }

  router.get('/login', async (req, res, next) => {
    if (req.session.userId) return res.redirect('/');
    try {
      res.render('login', { error: null, allowSignup: await signupOpen() });
    } catch (err) {
      next(err);
    }
  });

  router.post('/login', async (req, res, next) => {
    try {
      const email = String(req.body.email || '').trim().toLowerCase();
      const password = String(req.body.password || '');
      const { rows } = await pool.query('SELECT id, password_hash FROM users WHERE email = $1', [email]);
      const user = rows[0];
      if (!user || !(await verifyPassword(password, user.password_hash))) {
        await audit(pool, req, { action: 'login.failed', details: { email } });
        return res.status(401).render('login', { error: 'Invalid email or password.', allowSignup: await signupOpen() });
      }
      req.session.regenerate((err) => {
        if (err) return next(err);
        req.session.userId = user.id;
        audit(pool, req, { action: 'login.succeeded' }).then(() => res.redirect('/'), next);
      });
    } catch (err) {
      next(err);
    }
  });

  router.get('/signup', async (req, res, next) => {
    try {
      if (!(await signupOpen())) return res.status(404).render('error', { message: 'Sign-up is disabled.' });
      res.render('signup', { error: null });
    } catch (err) {
      next(err);
    }
  });

  router.post('/signup', async (req, res, next) => {
    if (!config.allowSignup) return res.status(404).render('error', { message: 'Sign-up is disabled.' });
    try {
      const name = String(req.body.name || '').trim();
      const email = String(req.body.email || '').trim().toLowerCase();
      const password = String(req.body.password || '');
      if (!name || !email.includes('@') || password.length < 10) {
        return res.status(400).render('signup', { error: 'Enter a name, a valid email and a password of at least 10 characters.' });
      }
      const passwordHash = await hashPassword(password);
      let rows;
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        if (config.signupFirstOnly) {
          // Serialise sign-ups so two people can't both become "the first account".
          await client.query('LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE');
          const { rows: existing } = await client.query('SELECT EXISTS (SELECT 1 FROM users) AS any');
          if (existing[0].any) {
            await client.query('ROLLBACK');
            return res.status(404).render('error', { message: 'Sign-up is disabled.' });
          }
        }
        ({ rows } = await client.query(
          `INSERT INTO users (email, password_hash, name) VALUES ($1, $2, $3)
           ON CONFLICT (email) DO NOTHING RETURNING id`,
          [email, passwordHash, name],
        ));
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
      if (!rows[0]) {
        return res.status(409).render('signup', { error: 'An account with that email already exists.' });
      }
      await ensureLaroseForOwner(pool, config).catch((err) => console.error('Automatic Larose setup failed:', err.message));
      req.session.regenerate((err) => {
        if (err) return next(err);
        req.session.userId = rows[0].id;
        res.redirect('/');
      });
    } catch (err) {
      next(err);
    }
  });

  router.post('/logout', (req, res, next) => {
    req.session.destroy((err) => {
      if (err) return next(err);
      res.clearCookie('skyfly.sid');
      res.redirect('/login');
    });
  });

  return router;
}
