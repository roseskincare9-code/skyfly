import { Router } from 'express';
import { hashPassword, verifyPassword } from '../lib/passwords.js';
import { audit } from '../lib/audit.js';
import { ensureLaroseForOwner } from '../services/setup.js';
import { platformSettings, findInvite, acceptInvite } from '../services/tenancy.js';

export function authRoutes({ pool, config }) {
  const router = Router();

  // Sign-up: the very first account (the platform owner); afterwards only when the platform
  // owner has opened client sign-up (Platform settings). Invite links always work.
  async function signupOpen() {
    if (!config.allowSignup) return false;
    const { rows } = await pool.query('SELECT EXISTS (SELECT 1 FROM users) AS any');
    if (!rows[0].any) return true;
    if (!config.signupFirstOnly) return true;
    return (await platformSettings(pool)).clientSignup === 'open';
  }

  // Creates an account. The first account ever becomes the platform owner.
  async function createUser({ name, email, password }) {
    const passwordHash = await hashPassword(password);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Serialise sign-ups so two people can't both become "the first account".
      await client.query('LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE');
      const { rows: [{ any }] } = await client.query('SELECT EXISTS (SELECT 1 FROM users) AS any');
      const { rows } = await client.query(
        `INSERT INTO users (email, password_hash, name, is_platform_admin) VALUES ($1, $2, $3, $4)
         ON CONFLICT (email) DO NOTHING RETURNING id`,
        [email, passwordHash, name, !any]);
      await client.query('COMMIT');
      return rows[0] ?? null;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }
  const validSignup = ({ name, email, password }) => name && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && password.length >= 10;
  const startSession = (req, res, next, userId, to = '/') => req.session.regenerate((err) => {
    if (err) return next(err);
    req.session.userId = userId;
    res.redirect(to);
  });

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
      const returnTo = /^\/invite\/[A-Za-z0-9_-]+$/.test(req.session.returnTo ?? '') ? req.session.returnTo : '/';
      req.session.regenerate((err) => {
        if (err) return next(err);
        req.session.userId = user.id;
        audit(pool, req, { action: 'login.succeeded' }).then(() => res.redirect(returnTo), next);
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
    try {
      if (!(await signupOpen())) return res.status(404).render('error', { message: 'Sign-up is disabled.' });
      const name = String(req.body.name || '').trim().slice(0, 200);
      const email = String(req.body.email || '').trim().toLowerCase();
      const password = String(req.body.password || '');
      if (!validSignup({ name, email, password })) {
        return res.status(400).render('signup', { error: 'Enter a name, a valid email and a password of at least 10 characters.' });
      }
      // Re-checked inside: the first-account rule must hold even with two sign-ups at once.
      const user = await createUser({ name, email, password });
      if (!user) return res.status(409).render('signup', { error: 'An account with that email already exists.' });
      await audit(pool, { session: { userId: user.id }, ip: req.ip }, { action: 'signup' });
      await ensureLaroseForOwner(pool, config).catch((err) => console.error('Automatic Larose setup failed:', err.message));
      startSession(req, res, next, user.id);
    } catch (err) {
      next(err);
    }
  });

  // Invitation to a business: join with the current account (same email), sign in, or create the account.
  router.get('/invite/:token', async (req, res, next) => {
    try {
      const invite = await findInvite(pool, req.params.token);
      if (!invite) return res.status(404).render('error', { message: 'This invitation link is not valid any more. Ask for a new one.' });
      let user = null;
      if (req.session.userId) ({ rows: [user] } = await pool.query('SELECT id, email FROM users WHERE id = $1', [req.session.userId]));
      const { rows: [existing] } = await pool.query('SELECT 1 FROM users WHERE email = $1', [invite.email]);
      if (!user) req.session.returnTo = `/invite/${req.params.token}`;
      res.render('invite', { invite, user, hasAccount: Boolean(existing), token: req.params.token, error: null });
    } catch (err) {
      next(err);
    }
  });

  router.post('/invite/:token', async (req, res, next) => {
    try {
      const invite = await findInvite(pool, req.params.token);
      if (!invite) return res.status(404).render('error', { message: 'This invitation link is not valid any more. Ask for a new one.' });
      let userId = req.session.userId;
      if (userId) {
        const { rows: [u] } = await pool.query('SELECT email FROM users WHERE id = $1', [userId]);
        if (u?.email !== invite.email) {
          return res.status(403).render('invite', { invite, user: u, hasAccount: true, token: req.params.token, error: `This invitation is for ${invite.email}. Sign out and sign in with that email.` });
        }
      } else {
        const name = String(req.body.name || '').trim().slice(0, 200);
        const password = String(req.body.password || '');
        if (!validSignup({ name, email: invite.email, password })) {
          return res.status(400).render('invite', { invite, user: null, hasAccount: false, token: req.params.token, error: 'Enter your name and a password of at least 10 characters.' });
        }
        const user = await createUser({ name, email: invite.email, password });
        if (!user) return res.status(409).render('invite', { invite, user: null, hasAccount: true, token: req.params.token, error: 'An account with this email already exists. Sign in first.' });
        userId = user.id;
      }
      await acceptInvite(pool, invite, userId);
      await audit(pool, { session: { userId }, ip: req.ip }, { action: 'team.invite_accepted', businessId: invite.business_id, details: { role: invite.role } });
      delete req.session.returnTo;
      if (req.session.userId) return res.redirect(`/businesses/${invite.business_id}`);
      startSession(req, res, next, userId, `/businesses/${invite.business_id}`);
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
