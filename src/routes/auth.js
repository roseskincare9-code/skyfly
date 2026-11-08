import { Router } from 'express';
import { hashPassword, verifyPassword } from '../lib/passwords.js';
import { audit } from '../lib/audit.js';
import { ensureLaroseForOwner, E2E_EMAIL_LIKE } from '../services/setup.js';
import { requestResetEmail, findReset, completeReset, sendPasswordChanged } from '../services/passwordReset.js';
import { platformSettings, findInvite, acceptInvite, inviteProblem, INVITE_PROBLEMS, createBusiness, ONE_BUSINESS_MESSAGE } from '../services/tenancy.js';
import { slugify } from '../lib/auth.js';
import { senderReady, needsVerification, sendVerification, useVerification, markVerified } from '../services/emailVerification.js';
import { tooMany, record, clear } from '../lib/authThrottle.js';
import { verifyTurnstile, allowTurnstile } from '../lib/turnstile.js';
import { launchBlockers } from '../services/launchChecks.js';

// The version of the Terms of Service and Privacy Policy a new account accepts (shown on /terms and /privacy).
export const TERMS_VERSION = '2026-11-01';
// Public registration needs working email verification where the configuration says so (production).
export const signupNeedsSender = (config) => Boolean(config.requireEmailForSignup) && !senderReady(config);
// Registration in production also needs the bot check (Cloudflare Turnstile).
export const signupNeedsCaptcha = (config) => Boolean(config.requireCaptchaForSignup) && !config.turnstile;
// What keeps public registration closed, apart from Platform settings (for messages and logs).
export const signupBlockers = (config) => [
  ...(signupNeedsSender(config) ? ['email sender (SKYFLY_NOTIFY_PROVIDER, SKYFLY_NOTIFY_API_KEY, SKYFLY_NOTIFY_FROM)'] : []),
  ...(signupNeedsCaptcha(config) ? ['bot check (TURNSTILE_SITE_KEY, TURNSTILE_SECRET_KEY)'] : []),
  ...(config.requireLaunchChecks ? launchBlockers(config) : []),
];

export function authRoutes({ pool, config }) {
  const router = Router();

  // Sign-up: the very first account (the platform owner; the automated live-test account aside); afterwards only when the platform
  // owner has opened client sign-up (Platform settings). Invite links always work.
  async function signupOpen() {
    if (!config.allowSignup) return false;
    const { rows } = await pool.query('SELECT EXISTS (SELECT 1 FROM users WHERE email NOT LIKE $1) AS any', [E2E_EMAIL_LIKE]);
    if (!rows[0].any) return true;
    if (!config.signupFirstOnly) return !signupBlockers(config).length;
    return (await platformSettings(pool)).clientSignup === 'open' && !signupBlockers(config).length;
  }

  // Why registration is closed, said truthfully: by the platform owner's choice (invitation only), or only
  // because email verification / the bot check are not set up yet (then it opens by itself once they are).
  async function closedPage(res) {
    const setting = (await platformSettings(pool)).clientSignup;
    const pending = setting === 'open' && config.allowSignup ? signupBlockers(config) : [];
    return res.status(404).render('signup-closed', { reason: pending.length ? 'setup' : 'invite_only' });
  }

  // Creates an account. The first account ever becomes the platform owner.
  async function createUser({ name, email, password, phone = null, termsVersion = null }) {
    const passwordHash = await hashPassword(password);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Serialise sign-ups so two people can't both become "the first account".
      await client.query('LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE');
      // The automated live-test account (created at start-up, never a person) does not count.
      const { rows: [{ any }] } = await client.query('SELECT EXISTS (SELECT 1 FROM users WHERE email NOT LIKE $1) AS any', [E2E_EMAIL_LIKE]);
      const { rows } = await client.query(
        `INSERT INTO users (email, password_hash, name, is_platform_admin, phone, terms_version, terms_accepted_at)
         VALUES ($1, $2, $3, $4, $5, $6::text, CASE WHEN $6::text IS NULL THEN NULL ELSE now() END)
         ON CONFLICT (email) DO NOTHING RETURNING id`,
        // Production never makes anyone a Super Admin by signing up (see scripts/grant-admin.mjs);
        // local development and tests keep "the first account is the owner".
        [email, passwordHash, name, !any && (config.adminBootstrapFirstAccount ?? !config.isProduction), phone, termsVersion]);
      await client.query('COMMIT');
      return rows[0] ?? null;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }
  // Public registration creates the owner's business in the same step (a trial, per Platform settings).
  // Not for the very first account of a new local/test installation, which becomes the platform owner.
  async function businessWithSignup() {
    const { rows: [{ any }] } = await pool.query('SELECT EXISTS (SELECT 1 FROM users WHERE email NOT LIKE $1) AS any', [E2E_EMAIL_LIKE]);
    return any || !(config.adminBootstrapFirstAccount ?? !config.isProduction);
  }
  const base = (req) => config.publicBaseUrl || `${req.protocol}://${req.get('host')}`;
  // A phone number as people type it: digits with optional +, spaces, dashes, dots, brackets; 7–15 digits.
  const cleanPhone = (v) => {
    const t = String(v || '').trim().slice(0, 40);
    const digits = t.replace(/\D/g, '');
    return /^\+?[0-9 ()./-]+$/.test(t) && digits.length >= 7 && digits.length <= 15 ? t.replace(/\s+/g, ' ') : null;
  };
  const validSignup = ({ name, email, password }) => name && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && password.length >= 10;
  const startSession = (req, res, next, userId, to = '/') => req.session.regenerate((err) => {
    if (err) return next(err);
    req.session.userId = userId;
    res.redirect(to);
  });

  // Someone already signed in who opens /login or /signup: say whose session it is, instead of quietly
  // opening that account's workspace (e.g. an old Larose session in a shared browser).
  async function signedIn(req, res, purpose) {
    const { rows: [u] } = await pool.query('SELECT id, name, email FROM users WHERE id = $1', [req.session.userId]);
    if (!u) return false;
    const { rows: businesses } = await pool.query(
      'SELECT b.name FROM business_members m JOIN businesses b ON b.id = m.business_id WHERE m.user_id = $1 ORDER BY b.created_at', [u.id]);
    res.set('Cache-Control', 'no-store');
    res.render('signed-in', { user: u, businesses, purpose });
    return true;
  }

  router.get('/login', async (req, res, next) => {
    if (req.session.userId && await signedIn(req, res, 'login').catch(next)) return;
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
      // Too many wrong passwords for this email (whether or not it has an account): wait, or reset the password.
      if (config.authThrottle && await tooMany(pool, 'login_failed', email)) {
        await audit(pool, req, { action: 'login.throttled', details: { email } });
        return res.status(429).render('login', { error: 'Too many failed sign-in attempts for this email. Wait 15 minutes, or use "Forgot your password?".', allowSignup: await signupOpen() });
      }
      const { rows } = await pool.query('SELECT id, password_hash, disabled_at FROM users WHERE email = $1', [email]);
      const user = rows[0];
      if (!user || !(await verifyPassword(password, user.password_hash))) {
        if (config.authThrottle) await record(pool, 'login_failed', email);
        await audit(pool, req, { action: 'login.failed', details: { email } });
        return res.status(401).render('login', { error: 'Invalid email or password.', allowSignup: await signupOpen() });
      }
      if (config.authThrottle) await clear(pool, 'login_failed', email);
      // A disabled account (Super Admin → Accounts) cannot sign in; said only after the right password.
      if (user.disabled_at) {
        await audit(pool, { session: { userId: user.id }, ip: req.ip }, { action: 'login.refused_disabled' });
        return res.status(403).render('login', { error: 'This account has been disabled. Contact Skyfly support if you think this is a mistake.', allowSignup: await signupOpen() });
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

  // Forgot password: the same answer whether or not the address has an account.
  router.get('/forgot-password', (req, res) => res.render('forgot-password', { sent: false, error: null, canEmail: senderReady(config) }));
  router.post('/forgot-password', async (req, res, next) => {
    try {
      const email = String(req.body.email || '').trim().toLowerCase();
      if (!senderReady(config)) return res.status(503).render('forgot-password', { sent: false, error: null, canEmail: false });
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).render('forgot-password', { sent: false, error: 'Enter the email address you sign in with.', canEmail: true });
      const base = config.publicBaseUrl || `${req.protocol}://${req.get('host')}`;
      // At most a few reset emails per address per hour; the page answers the same either way.
      const limited = config.authThrottle && await tooMany(pool, 'reset_requested', email);
      if (config.authThrottle) await record(pool, 'reset_requested', email);
      const result = limited ? { sent: false, reason: 'rate limited' } : await requestResetEmail(pool, config, email, base).catch((err) => {
        console.error('Password reset email failed:', err.message);
        return { sent: false, reason: 'send failed' };
      });
      await audit(pool, req, { action: 'password_reset.requested', details: { sent: result.sent, reason: result.reason ?? undefined } });
      res.render('forgot-password', { sent: true, error: null, canEmail: true });
    } catch (err) {
      next(err);
    }
  });

  router.get('/reset-password/:token', async (req, res, next) => {
    try {
      const r = await findReset(pool, req.params.token);
      if (!r) return res.status(404).render('reset-password', { valid: false, error: null, token: null, email: null });
      res.render('reset-password', { valid: true, error: null, token: req.params.token, email: r.email });
    } catch (err) {
      next(err);
    }
  });
  router.post('/reset-password/:token', async (req, res, next) => {
    try {
      const r = await findReset(pool, req.params.token);
      if (!r) return res.status(404).render('reset-password', { valid: false, error: null, token: null, email: null });
      const password = String(req.body.password || '');
      if (password.length < 10) return res.status(400).render('reset-password', { valid: true, error: 'Use at least 10 characters.', token: req.params.token, email: r.email });
      if (password !== String(req.body.confirm || '')) return res.status(400).render('reset-password', { valid: true, error: 'The two passwords are not the same.', token: req.params.token, email: r.email });
      const userId = await completeReset(pool, req.params.token, password);
      if (!userId) return res.status(404).render('reset-password', { valid: false, error: null, token: null, email: null });
      await audit(pool, { session: { userId }, ip: req.ip }, { action: 'password_reset.completed' });
      await sendPasswordChanged(pool, config, userId, base(req)).catch((err) => console.error('Password-changed email failed:', err.message));
      // A reset link works only from the account's mailbox or from the platform owner; emailed ones confirm it.
      if (senderReady(config)) await markVerified(pool, userId);
      req.session.regenerate((err) => {
        if (err) return next(err);
        res.render('login', { error: null, notice: 'Your password has been changed. Log in with the new password.', allowSignup: false });
      });
    } catch (err) {
      next(err);
    }
  });

  // ---- Account: change password; ask for a copy of one's data or for account deletion (handled by a Super Admin).
  const accountPage = async (req, res, { error = null, notice = null, status = 200 } = {}) => {
    const { rows: [me] } = await pool.query('SELECT id, name, email, phone, created_at, terms_version, terms_accepted_at FROM users WHERE id = $1', [req.session.userId]);
    const { rows: requests } = await pool.query('SELECT kind, status, created_at, handled_at, response FROM account_requests WHERE user_id = $1 ORDER BY id DESC LIMIT 10', [req.session.userId]);
    res.set('Cache-Control', 'no-store');
    res.status(status).render('account', { me, requests, error, notice });
  };
  const checkPassword = async (req) => {
    const { rows: [u] } = await pool.query('SELECT password_hash FROM users WHERE id = $1', [req.session.userId]);
    return Boolean(u && (await verifyPassword(String(req.body.current_password || ''), u.password_hash)));
  };
  router.get('/account', async (req, res, next) => {
    if (!req.session.userId) return res.redirect('/login');
    try { await accountPage(req, res, { notice: { password: 'Password changed. Other devices were signed out.', request: 'Request sent to the Skyfly team.' }[req.query.done] ?? null }); } catch (err) { next(err); }
  });
  router.post('/account/password', async (req, res, next) => {
    if (!req.session.userId) return res.redirect('/login');
    try {
      if (!(await checkPassword(req))) return accountPage(req, res, { error: 'Your current password was not correct.', status: 403 });
      const password = String(req.body.password || '');
      if (password.length < 10) return accountPage(req, res, { error: 'Use at least 10 characters for the new password.', status: 400 });
      if (password !== String(req.body.confirm || '')) return accountPage(req, res, { error: 'The two new passwords are not the same.', status: 400 });
      const userId = req.session.userId;
      await pool.query('UPDATE users SET password_hash = $2 WHERE id = $1', [userId, await hashPassword(password)]);
      await pool.query("UPDATE password_resets SET used_at = now() WHERE user_id = $1 AND used_at IS NULL", [userId]);
      // Other devices are signed out; this one gets a fresh session.
      await pool.query("DELETE FROM user_sessions WHERE sess->>'userId' = $1 AND sid <> $2", [String(userId), req.sessionID]);
      await audit(pool, req, { action: 'password.changed' });
      await sendPasswordChanged(pool, config, userId, base(req)).catch((err) => console.error('Password-changed email failed:', err.message));
      req.session.regenerate((err) => {
        if (err) return next(err);
        req.session.userId = userId;
        res.redirect('/account?done=password');
      });
    } catch (err) { next(err); }
  });
  router.post('/account/requests', async (req, res, next) => {
    if (!req.session.userId) return res.redirect('/login');
    try {
      const kind = req.body.kind === 'deletion' ? 'deletion' : req.body.kind === 'export' ? 'export' : null;
      if (!kind) return accountPage(req, res, { error: 'Choose what you are asking for.', status: 400 });
      if (!(await checkPassword(req))) return accountPage(req, res, { error: 'Your current password was not correct.', status: 403 });
      const { rows: [open] } = await pool.query("SELECT 1 FROM account_requests WHERE user_id = $1 AND kind = $2 AND status = 'open'", [req.session.userId, kind]);
      if (open) return accountPage(req, res, { error: 'You already have an open request of this kind. The Skyfly team will reply.', status: 409 });
      const note = String(req.body.note || '').trim().slice(0, 500) || null;
      await pool.query('INSERT INTO account_requests (user_id, kind, note) VALUES ($1, $2, $3)', [req.session.userId, kind, note]);
      await audit(pool, req, { action: `account.${kind}_requested` });
      res.redirect('/account?done=request');
    } catch (err) { next(err); }
  });

  // The Terms of Service and Privacy Policy accepted at registration (public pages).
  router.get('/terms', (req, res) => res.render('terms', { version: TERMS_VERSION }));
  router.get('/privacy', (req, res) => res.render('privacy', { version: TERMS_VERSION }));

  router.get('/signup', async (req, res, next) => {
    try {
      if (req.session.userId && await signedIn(req, res, 'signup')) return;
      if (!(await signupOpen())) return closedPage(res);
      if (config.turnstile) allowTurnstile(res);
      res.render('signup', { error: null, values: {}, askBusiness: await businessWithSignup(), turnstileSiteKey: config.turnstile?.siteKey ?? null });
    } catch (err) {
      next(err);
    }
  });

  router.post('/signup', async (req, res, next) => {
    try {
      if (!(await signupOpen())) return closedPage(res);
      if (req.session.userId) return res.status(409).render('error', { message: 'You are signed in. Sign out first to create a new business account.' });
      const name = String(req.body.name || '').trim().slice(0, 200);
      const email = String(req.body.email || '').trim().toLowerCase();
      const password = String(req.body.password || '');
      const businessName = String(req.body.business_name || '').trim().slice(0, 100);
      const phoneInput = String(req.body.phone || '').trim().slice(0, 40);
      const phone = cleanPhone(phoneInput);
      const askBusiness = await businessWithSignup();
      if (config.turnstile) allowTurnstile(res);
      const again = (status, error) => res.status(status).render('signup', { turnstileSiteKey: config.turnstile?.siteKey ?? null, error, values: { name, email, phone: phoneInput, business_name: businessName, accept_terms: req.body.accept_terms === 'on' }, askBusiness });
      if (!validSignup({ name, email, password })) return again(400, 'Enter your full name, a valid email and a password of at least 10 characters.');
      if (password !== String(req.body.confirm || '')) return again(400, 'The two passwords are not the same.');
      if (askBusiness && !slugify(businessName)) return again(400, 'Enter your business name (letters or numbers).');
      if (askBusiness && !phone) return again(400, 'Enter a valid phone number (7 to 15 digits, for example +234 803 123 4567).');
      // Public registration: the Terms and Privacy Policy must be accepted (recorded with their version).
      const acceptedTerms = req.body.accept_terms === 'on';
      if (askBusiness && !acceptedTerms) return again(400, 'Please read and accept the Terms of Service and Privacy Policy to create your account.');
      // Automated sign-ups: a hidden field people never fill in, and a daily limit of new accounts per IP address.
      if (String(req.body.website ?? '').trim()) {
        await audit(pool, req, { action: 'signup.blocked', details: { reason: 'honeypot' } });
        return again(400, 'Your registration could not be completed. Please try again.');
      }
      // Bot check (Cloudflare Turnstile), verified with Cloudflare before anything is created.
      if (config.turnstile) {
        const human = await verifyTurnstile(config, req.body['cf-turnstile-response'], req.ip);
        if (!human.ok) {
          await audit(pool, req, { action: 'signup.blocked', details: { reason: 'turnstile', codes: human.codes.slice(0, 3) } });
          return again(400, 'Please complete the security check ("Verify you are human") and try again.');
        }
      }
      if (config.authThrottle && await tooMany(pool, 'signup_ip', req.ip)) {
        await audit(pool, req, { action: 'signup.blocked', details: { reason: 'ip limit' } });
        return again(429, 'Too many new accounts were created from this network today. Try again tomorrow, or contact Skyfly support.');
      }
      // Re-checked inside: the first-account rule must hold even with two sign-ups at once.
      const user = await createUser({ name, email, password, phone: askBusiness ? phone : null, termsVersion: askBusiness && acceptedTerms ? TERMS_VERSION : null });
      if (!user) return again(409, 'An account with that email already exists. Log in instead, or use "Forgot your password?".');
      if (config.authThrottle) await record(pool, 'signup_ip', req.ip);
      await audit(pool, { session: { userId: user.id }, ip: req.ip }, { action: 'signup', details: askBusiness ? { termsVersion: TERMS_VERSION } : undefined });
      await ensureLaroseForOwner(pool, config).catch((err) => console.error('Automatic Larose setup failed:', err.message));
      // The owner's own business, linked to this account only (never Super Admin).
      let to = '/';
      if (askBusiness) {
        const settings = await platformSettings(pool);
        const b = await createBusiness(pool, { userId: user.id, name: businessName, slug: slugify(businessName), trialDays: settings.trialDays });
        await audit(pool, { session: { userId: user.id }, ip: req.ip }, { action: 'business.created', businessId: b.id, details: { status: b.status, via: 'signup' } });
        to = `/businesses/${b.id}`;
      }
      // With Skyfly's email sender set up, the address is confirmed before the dashboard opens.
      const { rows: [u] } = await pool.query('SELECT id, name, email, email_verified_at, is_platform_admin FROM users WHERE id = $1', [user.id]);
      if (u.is_platform_admin) await markVerified(pool, u.id);
      else if (needsVerification(config, u)) {
        // Never claim the email was sent when it was not: the page then offers "Send the link again".
        const sent = await sendVerification(pool, config, u, base(req)).then(() => true, (err) => { console.error('Verification email failed:', err.message); return false; });
        to = sent ? '/verify-email' : '/verify-email?failed=1';
      }
      startSession(req, res, next, user.id, to);
    } catch (err) {
      next(err);
    }
  });

  // Invitation to a business: join with the current account (same email), sign in, or create the account.
  router.get('/invite/:token', async (req, res, next) => {
    try {
      const invite = await findInvite(pool, req.params.token);
      if (!invite) return res.status(410).render('error', { message: INVITE_PROBLEMS[await inviteProblem(pool, req.params.token) ?? 'invalid'] });
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
      if (!invite) return res.status(410).render('error', { message: INVITE_PROBLEMS[await inviteProblem(pool, req.params.token) ?? 'invalid'] });
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
      const accepted = await acceptInvite(pool, invite, userId);
      if (accepted === 'other_business') return res.status(409).render('error', { message: ONE_BUSINESS_MESSAGE });
      if (!accepted) return res.status(410).render('error', { message: INVITE_PROBLEMS.used });
      // The link was emailed to this address (sender set up), so using it confirms the address.
      if (senderReady(config)) await markVerified(pool, userId);
      await audit(pool, { session: { userId }, ip: req.ip }, { action: 'team.invite_accepted', businessId: invite.business_id, details: { role: invite.role } });
      delete req.session.returnTo;
      if (req.session.userId) return res.redirect(`/businesses/${invite.business_id}`);
      startSession(req, res, next, userId, `/businesses/${invite.business_id}`);
    } catch (err) {
      next(err);
    }
  });

  // ---- Email verification
  router.get('/verify-email', async (req, res, next) => {
    try {
      if (!req.session.userId) return res.redirect('/login');
      const { rows: [u] } = await pool.query('SELECT email, email_verified_at FROM users WHERE id = $1', [req.session.userId]);
      if (!u || !needsVerification(config, u)) return res.redirect('/');
      res.render('verify-email', { email: u.email, sent: req.query.sent === '1', failed: req.query.failed === '1',
        error: req.query.failed === '1' ? 'The confirmation email could not be sent just now. Wait a minute, then press "Send the link again".' : null });
    } catch (err) { next(err); }
  });
  router.post('/verify-email/resend', async (req, res, next) => {
    try {
      if (!req.session.userId) return res.redirect('/login');
      const { rows: [u] } = await pool.query('SELECT id, name, email, email_verified_at FROM users WHERE id = $1', [req.session.userId]);
      if (!u || !needsVerification(config, u)) return res.redirect('/');
      try { await sendVerification(pool, config, u, base(req)); } catch (err) {
        return res.status(502).render('verify-email', { email: u.email, sent: false, error: `The email could not be sent (${String(err.message).slice(0, 100)}). Try again in a minute.` });
      }
      res.redirect('/verify-email?sent=1');
    } catch (err) { next(err); }
  });
  router.get('/verify-email/:token', async (req, res, next) => {
    try {
      const userId = await useVerification(pool, req.params.token);
      if (!userId) return res.status(410).render('error', { message: 'This confirmation link is not valid any more (it works once, for 48 hours). Sign in to get a new one.' });
      await audit(pool, { session: { userId }, ip: req.ip }, { action: 'email.verified' });
      res.redirect(req.session.userId === userId ? '/' : '/login');
    } catch (err) { next(err); }
  });

  router.post('/logout', (req, res, next) => {
    req.session.destroy((err) => {
      if (err) return next(err);
      res.clearCookie('skyfly.sid');
      res.redirect(req.body?.next === '/signup' ? '/signup' : '/login');
    });
  });

  return router;
}
