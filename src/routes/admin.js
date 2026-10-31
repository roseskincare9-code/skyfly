// Platform owner area: all client businesses, their subscriptions (set by hand after the
// owner confirms payment; there is no payment gateway), setup progress, team invites and
// platform settings. Only users with is_platform_admin may open it.
import { Router } from 'express';
import { createHash, timingSafeEqual } from 'node:crypto';
import { createResetLink, ADMIN_LINK_HOURS } from '../services/passwordReset.js';
import { E2E_EMAIL_LIKE } from '../services/setup.js';
import { setupChecklist } from '../services/onboarding.js';
import { requireAuth, slugify } from '../lib/auth.js';
import { verifyPassword } from '../lib/passwords.js';
import { adminVerified, safeAdminNext, ADMIN_SESSION_HOURS } from '../lib/adminSession.js';
import { asyncHandler } from '../lib/http.js';
import { audit } from '../lib/audit.js';
import {
  ROLES, ROLE_LABELS, SUBSCRIPTION_STATUSES, SUBSCRIPTION_LABELS, platformSettings, savePlatformSetting,
  setupStatus, subscriptionState, expireSubscriptions,
} from '../services/tenancy.js';
import { inviteOrAdd, readInvite } from './team.js';
import { normalizeSubdomain, subdomainHost, subdomainState } from '../services/subdomains.js';
import { clearOriginCache } from '../lib/origins.js';
import { TABLE_ORDER, exportBackup, uncoveredTables } from '../services/backup.js';
import { normalizeDomain, checkDomain } from '../hosting/domains.js';
import { listDomains, domainSummary, refreshDomain, normalizeRegistrarUrl, DOMAIN_COLUMNS, REMINDER_DAYS } from '../services/platformDomains.js';
import multer from 'multer';
import { requireCsrf } from '../lib/csrf.js';
import { googleStatus, googleAccountEmail, readServiceAccount, useServiceAccount, googleSelfCheck } from '../services/googleSheetsApi.js';
import { storedGoogleKey, saveGoogleKey } from '../services/googleKey.js';
import { recheckGoogleConnections, compareHeldGoogleConnections, addConnection, loadConnection, checkConnection, reconcileWaiting, urlHash, SKYFLY_TAB } from '../services/sheets.js';
import { SPREADSHEET_ID_RE } from '../services/googleSheetsApi.js';

// The Google key file is small (about 2.3 KB); anything much larger is not one.
const keyUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20000, files: 1, fields: 5 } });

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIMEZONES = new Set(Intl.supportedValuesOf('timeZone'));
const CURRENCIES = ['NGN', 'GBP', 'USD', 'EUR'];
const validDate = (s) => DATE_RE.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s);

function addMonths(dateText, months) {
  const [y, m, d] = dateText.split('-').map(Number);
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, last));
  return target.toISOString().slice(0, 10);
}

// One read-only snapshot of every table, streamed as the backup file, and logged.
async function sendBackup(pool, req, res, { via }) {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  res.set('Content-Type', 'application/json; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="skyfly-backup-${stamp}.json"`);
  res.set('Cache-Control', 'no-store');
  // One read-only snapshot, so every table is from the same moment.
  const client = await pool.connect();
  try {
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const counts = await exportBackup(client, (chunk) => res.write(chunk));
    await client.query('COMMIT');
    await audit(pool, req, { action: 'admin.backup_downloaded', details: { rows: Object.values(counts).reduce((a, b) => a + b, 0), via } });
  } finally {
    client.release();
  }
  res.end();
}

// Mounted before the sign-in check: the backup download with the server's backup key, for the backup
// workflow. Only this one read-only download; a missing key goes on to the normal sign-in check.
export function backupKeyRoutes({ pool, config }) {
  const router = Router();
  router.get('/admin/backup.json', asyncHandler(async (req, res, next) => {
    const sent = /^Bearer (.+)$/.exec(req.get('authorization') || '')?.[1];
    if (!sent || !config.backupKey) return next();
    const digest = (v) => createHash('sha256').update(v).digest();
    if (!timingSafeEqual(digest(sent), digest(config.backupKey))) {
      await audit(pool, req, { action: 'admin.backup_key_refused' });
      return res.status(401).json({ error: 'Wrong backup key.' });
    }
    await sendBackup(pool, req, res, { via: 'backup key' });
  }));
  return router;
}

// Super Admin sign-in and sign-out, mounted before the normal sign-in check so /admin/login opens
// without a session.
export function adminLoginRoutes({ pool }) {
  const router = Router();
  // Super Admin sign-in: email and password again, every ADMIN_SESSION_HOURS, even when already signed
  // in. Only accounts marked as platform admin in the database can pass; anyone else gets the same
  // "invalid" answer, and a signed-in business owner gets "not found".
  const isAdmin = async (userId) => Boolean(userId && (await pool.query('SELECT is_platform_admin FROM users WHERE id = $1', [userId])).rows[0]?.is_platform_admin);
  const loginPage = (res, { status = 200, error = null, next = '/admin', email = '' } = {}) => {
    res.set('Cache-Control', 'no-store');
    res.status(status).render('admin/login', { error, next: safeAdminNext(next), email, hours: ADMIN_SESSION_HOURS });
  };
  router.get('/admin/login', asyncHandler(async (req, res) => {
    if (req.session.userId && !(await isAdmin(req.session.userId))) return res.status(404).render('error', { message: 'Page not found.' });
    loginPage(res, { next: req.query.next });
  }));
  router.post('/admin/login', asyncHandler(async (req, res, next) => {
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    if (req.session.userId && !(await isAdmin(req.session.userId))) return res.status(404).render('error', { message: 'Page not found.' });
    const { rows: [u] } = await pool.query('SELECT id, password_hash, is_platform_admin FROM users WHERE email = $1', [email]);
    const ok = u && (await verifyPassword(password, u.password_hash)) && u.is_platform_admin
      && (!req.session.userId || req.session.userId === u.id);
    if (!ok) {
      await audit(pool, req, { action: 'admin.sign_in_failed', details: { email } });
      return loginPage(res, { status: 401, error: 'Invalid email or password, or this account is not a Skyfly administrator.', next: req.body.next, email });
    }
    const to = safeAdminNext(req.body.next);
    req.session.regenerate((err) => {
      if (err) return next(err);
      Object.assign(req.session, { userId: u.id, adminUserId: u.id, adminVerifiedAt: Date.now() });
      audit(pool, req, { action: 'admin.signed_in' }).then(() => res.redirect(to), next);
    });
  }));
  // Leaves the Super Admin area on this device (the normal sign-in stays).
  router.post('/admin/logout', (req, res) => {
    delete req.session.adminUserId;
    delete req.session.adminVerifiedAt;
    delete req.session.adminVisits;
    res.redirect('/');
  });

  return router;
}

export function adminRoutes({ pool, config, load = null }) {
  const router = Router();
  const isAdmin = async (userId) => Boolean(userId && (await pool.query('SELECT is_platform_admin FROM users WHERE id = $1', [userId])).rows[0]?.is_platform_admin);
  router.use('/admin', asyncHandler(async (req, res, next) => {
    if (!req.session.userId) return res.redirect(`/admin/login?next=${encodeURIComponent(req.originalUrl)}`);
    if (!(await isAdmin(req.session.userId))) return res.status(404).render('error', { message: 'Page not found.' });
    if (!adminVerified(req)) {
      if (req.method !== 'GET') return res.status(403).render('error', { message: 'Your Super Admin sign-in has ended. Sign in to Super Admin again.' });
      return res.redirect(`/admin/login?next=${encodeURIComponent(req.originalUrl)}`);
    }
    res.locals.adminArea = true;
    next();
  }));

  const loadBusiness = async (id) => {
    if (!/^\d+$/.test(String(id))) return null;
    const { rows: [b] } = await pool.query(
      `SELECT b.*, (now() AT TIME ZONE b.timezone)::date::text AS local_today FROM businesses b WHERE b.id = $1`, [id]);
    return b ?? null;
  };

  router.get('/admin', asyncHandler(async (req, res) => {
    await expireSubscriptions(pool);
    const { rows } = await pool.query(
      `SELECT b.id, b.name, b.slug, b.currency, b.timezone, b.created_at, b.subscription_status, b.subscription_price_minor,
              b.subscription_currency, b.subscription_started_on, b.subscription_expires_on,
              (now() AT TIME ZONE b.timezone)::date::text AS local_today,
              (SELECT string_agg(u.email, ', ' ORDER BY u.email) FROM business_members m JOIN users u ON u.id = m.user_id
                WHERE m.business_id = b.id AND m.role = 'owner') AS owners,
              (SELECT count(*)::int FROM business_members m WHERE m.business_id = b.id) AS member_count,
              (SELECT count(*)::int FROM business_invites i WHERE i.business_id = b.id AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now()) AS open_invites,
              (SELECT count(*)::int FROM products p WHERE p.business_id = b.id) AS product_count,
              (SELECT count(*)::int FROM landing_pages lp WHERE lp.business_id = b.id) AS page_count,
              (SELECT count(*)::int FROM orders o WHERE o.business_id = b.id AND NOT o.is_test) AS order_count,
              (SELECT max(o.created_at) FROM orders o WHERE o.business_id = b.id AND NOT o.is_test) AS last_order_at,
              EXISTS (SELECT 1 FROM email_settings e WHERE e.business_id = b.id AND e.api_key_enc IS NOT NULL AND e.from_email IS NOT NULL) AS email_ready
         FROM businesses b ORDER BY b.created_at`);
    const businesses = rows.map((b) => ({ ...b, sub: subscriptionState(b), setup: setupStatus(b) }));
    const counts = businesses.reduce((acc, b) => { acc[b.sub.status] = (acc[b.sub.status] || 0) + 1; return acc; }, {});
    const inAWeek = (b) => new Date(Date.parse(`${b.local_today}T00:00:00Z`) + 7 * 864e5).toISOString().slice(0, 10);
    const soon = businesses.filter((b) => b.sub.open && b.subscription_expires_on && b.subscription_expires_on <= inAWeek(b));
    const domainAlerts = (await listDomains(pool)).map((d) => ({ domain: d.domain, ...domainSummary(d) })).filter((d) => d.level !== 'ok');
    res.render('admin/index', { businesses, counts, soon, domainAlerts, SUBSCRIPTION_LABELS, notice: req.query.done === 'created' ? 'Client business created.' : null });
  }));

  router.get('/admin/businesses/new', (req, res) => {
    res.render('admin/new-business', { error: null, values: { currency: 'NGN', timezone: 'Africa/Lagos', subscription_status: 'active', role: 'owner' }, CURRENCIES, SUBSCRIPTION_LABELS, link: null });
  });

  function readSubscription(body, { requireAll = false } = {}) {
    const errors = [];
    const status = SUBSCRIPTION_STATUSES.includes(body.subscription_status) ? body.subscription_status : null;
    if (!status) errors.push('Choose a subscription status.');
    const priceText = String(body.price ?? '').replace(/[,\s₦£$€]/g, '');
    const price = priceText === '' ? null : Number(priceText);
    if (price !== null && (!Number.isFinite(price) || price < 0 || price > 1e9)) errors.push('Enter the monthly price as a number.');
    const currency = CURRENCIES.includes(body.subscription_currency) ? body.subscription_currency : 'NGN';
    const started = String(body.started_on ?? '').trim();
    const expires = String(body.expires_on ?? '').trim();
    if (started && !validDate(started)) errors.push('Start date must be a valid date.');
    if (expires && !validDate(expires)) errors.push('Expiry date must be a valid date.');
    if (started && expires && expires < started) errors.push('The expiry date is before the start date.');
    if (requireAll && ['trial', 'active'].includes(status) && !expires) errors.push('Set an expiry date for a client subscription.');
    const notes = String(body.notes ?? '').trim().slice(0, 1000) || null;
    return { status, priceMinor: price === null ? null : Math.round(price * 100), currency, started: started || null, expires: expires || null, notes, errors };
  }

  router.post('/admin/businesses', asyncHandler(async (req, res) => {
    const values = req.body;
    const name = String(values.name ?? '').trim().slice(0, 100);
    const currency = CURRENCIES.includes(values.currency) ? values.currency : null;
    const timezone = TIMEZONES.has(values.timezone) ? values.timezone : null;
    const sub = readSubscription(values, { requireAll: true });
    const invite = readInvite({ email: values.owner_email, role: 'owner' });
    const errors = [...(name ? [] : ['Enter the business name.']), ...(currency ? [] : ['Choose a currency.']), ...(timezone ? [] : ['Choose a valid time zone.']), ...sub.errors, ...invite.errors];
    const again = (error, status = 400) => res.status(status).render('admin/new-business', { error, values, CURRENCIES, SUBSCRIPTION_LABELS, link: null });
    if (errors.length) return again(errors.join(' '));
    const slug = slugify(name);
    const { rows: [b] } = await pool.query(
      `INSERT INTO businesses (owner_id, name, slug, currency, timezone, subscription_status, subscription_price_minor, subscription_currency,
                               subscription_started_on, subscription_expires_on, subscription_notes, subscription_updated_at)
       VALUES ($1, $2, $3 || CASE WHEN EXISTS (SELECT 1 FROM businesses WHERE slug = $3) THEN '-' || substr(md5(random()::text), 1, 6) ELSE '' END,
               $4, $5, $6, $7, $8, $9, $10, $11, now()) RETURNING id`,
      [req.session.userId, name, slug || 'business', currency, timezone, sub.status, sub.priceMinor, sub.currency, sub.started, sub.expires, sub.notes]);
    await audit(pool, req, { action: 'admin.business_created', businessId: b.id, details: { name, status: sub.status, expires: sub.expires, price: sub.priceMinor } });
    const result = await inviteOrAdd(pool, req, config, { businessId: b.id, email: invite.email, role: 'owner' });
    if (result.link || result.emailed || result.error) {
      return res.render('admin/new-business', { error: result.error ?? null, values: {}, CURRENCIES, SUBSCRIPTION_LABELS, link: result.link ?? null, emailed: Boolean(result.emailed), created: { id: b.id, name, email: invite.email } });
    }
    res.redirect('/admin?done=created');
  }));

  async function renderBusiness(req, res, b, { error = null, notice = null, link = null, status = 200 } = {}) {
    const [{ rows: members }, { rows: invites }, { rows: history }] = await Promise.all([
      pool.query(`SELECT u.id, u.name, u.email, m.role FROM business_members m JOIN users u ON u.id = m.user_id WHERE m.business_id = $1 ORDER BY m.role = 'owner' DESC, u.email`, [b.id]),
      pool.query(`SELECT id, email, role, expires_at FROM business_invites WHERE business_id = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now() ORDER BY id DESC`, [b.id]),
      pool.query(`SELECT a.action, a.details, a.created_at, u.email AS by_email FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
                   WHERE a.business_id = $1 AND (a.action LIKE 'subscription.%' OR a.action LIKE 'admin.%') ORDER BY a.id DESC LIMIT 30`, [b.id]),
    ]);
    const checklist = await setupChecklist(pool, b);
    const { rows: [pagesUsed] } = await pool.query("SELECT count(*)::int AS n FROM landing_pages WHERE business_id = $1 AND status <> 'archived'", [b.id]);
    res.set('Cache-Control', 'no-store');
    res.status(status).render('admin/business', {
      checklist, b, pagesUsed: pagesUsed.n, sub: subscriptionState(b), members, invites, history, error, notice, link, ROLES, ROLE_LABELS, CURRENCIES, SUBSCRIPTION_LABELS,
      subdomain: { platformDomain: config.platformDomain, host: subdomainHost(b, config), status: b.subdomain_status, checkedAt: b.subdomain_checked_at,
        state: (await subdomainState(b, config)).message },
      renewDefault: addMonths(b.subscription_expires_on && b.subscription_expires_on > b.local_today ? b.subscription_expires_on : b.local_today, 1),
    });
  }

  router.get('/admin/businesses/:id', asyncHandler(async (req, res) => {
    const b = await loadBusiness(req.params.id);
    if (!b) return res.status(404).render('error', { message: 'Business not found.' });
    const notice = { subdomain: 'Subdomain saved.', checked: 'DNS checked.', saved: 'Subscription saved.', renewed: 'Renewed. Client access is restored.', locked: 'Locked. The client sees the renewal screen; all data is kept.', unlocked: 'Unlocked.' }[req.query.done] ?? null;
    await renderBusiness(req, res, b, { notice });
  }));

  async function saveSubscription(req, b, sub, action) {
    await pool.query(
      `UPDATE businesses SET subscription_status = $2, subscription_price_minor = $3, subscription_currency = $4, subscription_started_on = $5,
              subscription_expires_on = $6, subscription_notes = $7, subscription_updated_at = now() WHERE id = $1`,
      [b.id, sub.status, sub.priceMinor, sub.currency, sub.started, sub.expires, sub.notes]);
    await audit(pool, req, {
      action, businessId: b.id, entityType: 'business', entityId: b.id,
      details: {
        before: { status: b.subscription_status, expires: b.subscription_expires_on, price: b.subscription_price_minor },
        after: { status: sub.status, expires: sub.expires, price: sub.priceMinor }, reference: sub.notes ?? undefined,
      },
    });
  }

  router.post('/admin/businesses/:id/subscription', asyncHandler(async (req, res) => {
    const b = await loadBusiness(req.params.id);
    if (!b) return res.status(404).render('error', { message: 'Business not found.' });
    const sub = readSubscription(req.body, { requireAll: true });
    if (!sub.errors.length && ['trial', 'active'].includes(sub.status) && sub.expires < b.local_today) {
      sub.errors.push(`The expiry date ${sub.expires} has already passed in ${b.timezone} (today is ${b.local_today}). Choose a later date, or set the status to Expired.`);
    }
    if (sub.errors.length) return renderBusiness(req, res, b, { error: sub.errors.join(' '), status: 400 });
    await saveSubscription(req, b, sub, 'subscription.updated');
    res.redirect(`/admin/businesses/${b.id}?done=saved`);
  }));

  // Renewal after the owner has confirmed payment: new expiry (default: one month after
  // the current expiry, or after today if it has passed), status Active.
  router.post('/admin/businesses/:id/renew', asyncHandler(async (req, res) => {
    const b = await loadBusiness(req.params.id);
    if (!b) return res.status(404).render('error', { message: 'Business not found.' });
    const expires = String(req.body.expires_on ?? '').trim();
    if (!validDate(expires) || expires < b.local_today) return renderBusiness(req, res, b, { error: 'Choose a new expiry date that is today or later.', status: 400 });
    const reference = String(req.body.reference ?? '').trim().slice(0, 300);
    await saveSubscription(req, b, {
      status: 'active', priceMinor: b.subscription_price_minor, currency: b.subscription_currency,
      started: b.subscription_started_on ?? b.local_today, expires,
      notes: reference ? [b.subscription_notes, `${b.local_today}: renewed to ${expires} (${reference})`].filter(Boolean).join('\n').slice(-1000) : b.subscription_notes,
    }, 'subscription.renewed');
    res.redirect(`/admin/businesses/${b.id}?done=renewed`);
  }));

  router.post('/admin/businesses/:id/lock', asyncHandler(async (req, res) => {
    const b = await loadBusiness(req.params.id);
    if (!b) return res.status(404).render('error', { message: 'Business not found.' });
    await saveSubscription(req, b, { status: 'locked', priceMinor: b.subscription_price_minor, currency: b.subscription_currency, started: b.subscription_started_on, expires: b.subscription_expires_on, notes: b.subscription_notes }, 'subscription.locked');
    res.redirect(`/admin/businesses/${b.id}?done=locked`);
  }));

  router.post('/admin/businesses/:id/unlock', asyncHandler(async (req, res) => {
    const b = await loadBusiness(req.params.id);
    if (!b) return res.status(404).render('error', { message: 'Business not found.' });
    if (b.subscription_expires_on && b.subscription_expires_on < b.local_today) {
      return renderBusiness(req, res, b, { error: 'The expiry date has passed. Use "Renew" with a new expiry date instead.', status: 400 });
    }
    await saveSubscription(req, b, { status: 'active', priceMinor: b.subscription_price_minor, currency: b.subscription_currency, started: b.subscription_started_on, expires: b.subscription_expires_on, notes: b.subscription_notes }, 'subscription.unlocked');
    res.redirect(`/admin/businesses/${b.id}?done=unlocked`);
  }));

  router.post('/admin/businesses/:id/invite', asyncHandler(async (req, res) => {
    const b = await loadBusiness(req.params.id);
    if (!b) return res.status(404).render('error', { message: 'Business not found.' });
    const f = readInvite(req.body);
    if (f.errors.length) return renderBusiness(req, res, b, { error: f.errors.join(' '), status: 400 });
    const result = await inviteOrAdd(pool, req, config, { businessId: b.id, email: f.email, role: f.role });
    if (result.alreadyMember) return renderBusiness(req, res, b, { error: `${f.email} is already in this business as ${ROLE_LABELS[result.alreadyMember]}. Change their role under Team.`, status: 409 });
    if (result.error) return renderBusiness(req, res, b, { error: result.error, status: 502 });
    if (result.emailed) return renderBusiness(req, res, b, { notice: `Invitation emailed to ${f.email} (valid 14 days). Only the person with that mailbox can accept it.` });
    return renderBusiness(req, res, b, { notice: `Invite created for ${f.email}. Send them this link (valid 14 days, shown once):`, link: result.link });
  }));

  // Resend (a fresh link; the old one stops working) or revoke an open invitation of this business.
  router.post('/admin/businesses/:id/invites/:inviteId/:action(resend|revoke)', asyncHandler(async (req, res) => {
    const b = await loadBusiness(req.params.id);
    if (!b) return res.status(404).render('error', { message: 'Business not found.' });
    const { rows: [i] } = await pool.query(
      'SELECT id, email, role FROM business_invites WHERE id = $1 AND business_id = $2 AND accepted_at IS NULL AND revoked_at IS NULL', [req.params.inviteId, b.id]);
    if (!i) return renderBusiness(req, res, b, { error: 'That invitation is no longer open.', status: 404 });
    if (req.params.action === 'revoke') {
      await pool.query('UPDATE business_invites SET revoked_at = now() WHERE id = $1', [i.id]);
      await audit(pool, req, { action: 'team.invite_revoked', businessId: b.id, details: { email: i.email } });
      return renderBusiness(req, res, b, { notice: `The invitation for ${i.email} was revoked; its link no longer works.` });
    }
    const result = await inviteOrAdd(pool, req, config, { businessId: b.id, email: i.email, role: i.role });
    if (result.error) return renderBusiness(req, res, b, { error: result.error, status: 502 });
    if (result.alreadyMember) return renderBusiness(req, res, b, { error: `${i.email} has already joined.`, status: 409 });
    if (result.emailed) return renderBusiness(req, res, b, { notice: `A new invitation was emailed to ${i.email}; the previous link no longer works.` });
    return renderBusiness(req, res, b, { notice: `New invitation link for ${i.email} (valid 14 days, shown once; the previous link no longer works):`, link: result.link });
  }));

  // A one-time password reset link for a member of this business, to pass on personally (e.g. when
  // Skyfly has no email sender). Shown once; works for 24 hours; logged.
  router.post('/admin/businesses/:id/members/:userId/reset-link', asyncHandler(async (req, res) => {
    const b = await loadBusiness(req.params.id);
    if (!b) return res.status(404).render('error', { message: 'Business not found.' });
    const { rows: [m] } = await pool.query(
      'SELECT u.id, u.email FROM business_members bm JOIN users u ON u.id = bm.user_id WHERE bm.business_id = $1 AND u.id = $2 AND u.email NOT LIKE $3',
      [b.id, /^\d+$/.test(req.params.userId) ? req.params.userId : 0, E2E_EMAIL_LIKE]);
    if (!m) return renderBusiness(req, res, b, { error: 'That person is not a member of this business.', status: 404 });
    const token = await createResetLink(pool, m.id, { createdBy: req.session.userId, minutes: ADMIN_LINK_HOURS * 60 });
    await audit(pool, req, { action: 'admin.password_reset_link', businessId: b.id, entityType: 'user', entityId: m.id });
    const base = config.publicBaseUrl || `${req.protocol}://${req.get('host')}`;
    return renderBusiness(req, res, b, { notice: `Password reset link for ${m.email}. Send it to them personally (works once, for ${ADMIN_LINK_HOURS} hours, shown once):`, link: `${base}/reset-password/${token}` });
  }));

  // Client contact details (onboarding). Optional; checked for length and format only.
  router.post('/admin/businesses/:id/details', asyncHandler(async (req, res) => {
    const b = await loadBusiness(req.params.id);
    if (!b) return res.status(404).render('error', { message: 'Business not found.' });
    const val = (k, max) => String(req.body[k] ?? '').trim().slice(0, max) || null;
    const d = { name: val('name', 120), contact_name: val('contact_name', 120), contact_phone: val('contact_phone', 40), contact_email: val('contact_email', 200)?.toLowerCase() ?? null, website: val('website', 300) };
    const errors = [];
    if (!d.name) errors.push('Enter the business name.');
    if (d.contact_email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(d.contact_email)) errors.push('Enter a valid contact email.');
    if (d.contact_phone && d.contact_phone.replace(/\D/g, '').length < 7) errors.push('Enter a valid contact phone number.');
    if (d.website && !/^https?:\/\/[^\s]+\.[^\s]+$/i.test(d.website)) errors.push('Enter the website as a full address, e.g. https://example.com.');
    if (errors.length) return renderBusiness(req, res, { ...b, ...d }, { error: errors.join(' '), status: 400 });
    await pool.query('UPDATE businesses SET name = $2, contact_name = $3, contact_phone = $4, contact_email = $5, website = $6 WHERE id = $1',
      [b.id, d.name, d.contact_name, d.contact_phone, d.contact_email, d.website]);
    await audit(pool, req, { action: 'admin.business_details', businessId: b.id, entityType: 'business', entityId: b.id });
    return renderBusiness(req, res, { ...b, ...d }, { notice: 'Business details saved.' });
  }));

  // Landing page limit (default 4). Lowering it below what the business already has is refused, so no
  // page is ever removed or hidden by changing it.
  router.post('/admin/businesses/:id/page-limit', asyncHandler(async (req, res) => {
    const b = await loadBusiness(req.params.id);
    if (!b) return res.status(404).render('error', { message: 'Business not found.' });
    const limit = Number(req.body.max_landing_pages);
    const { rows: [{ used }] } = await pool.query("SELECT count(*)::int AS used FROM landing_pages WHERE business_id = $1 AND status <> 'archived'", [b.id]);
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) return renderBusiness(req, res, b, { error: 'Enter a landing page limit from 1 to 1000.', status: 400 });
    if (limit < used) return renderBusiness(req, res, b, { error: `${b.name} already has ${used} landing pages (not archived). Choose ${used} or more, or archive pages first.`, status: 400 });
    await pool.query('UPDATE businesses SET max_landing_pages = $2 WHERE id = $1', [b.id, limit]);
    await audit(pool, req, { action: 'admin.page_limit_changed', businessId: b.id, entityType: 'business', entityId: b.id, details: { from: b.max_landing_pages, to: limit } });
    return renderBusiness(req, res, { ...b, max_landing_pages: limit }, { notice: `Landing page limit set to ${limit}.` });
  }));

  // Business subdomain on the platform domain (reserved now, live only once the domain is set up).
  router.post('/admin/businesses/:id/subdomain', asyncHandler(async (req, res) => {
    const b = await loadBusiness(req.params.id);
    if (!b) return res.status(404).render('error', { message: 'Business not found.' });
    const { value, error } = normalizeSubdomain(req.body.subdomain, config);
    if (error) return renderBusiness(req, res, b, { error, status: 400 });
    try {
      await pool.query('UPDATE businesses SET subdomain = $2, subdomain_status = NULL, subdomain_checked_at = NULL WHERE id = $1', [b.id, value]);
    } catch (err) {
      if (err.code === '23505') return renderBusiness(req, res, b, { error: 'Another business already uses that subdomain.', status: 409 });
      throw err;
    }
    clearOriginCache();
    await audit(pool, req, { action: 'admin.subdomain_changed', businessId: b.id, details: { from: b.subdomain, to: value } });
    res.redirect(`/admin/businesses/${b.id}?done=subdomain`);
  }));

  router.post('/admin/businesses/:id/subdomain/check', asyncHandler(async (req, res) => {
    const b = await loadBusiness(req.params.id);
    if (!b) return res.status(404).render('error', { message: 'Business not found.' });
    const result = await subdomainState(b, config, { check: true });
    await pool.query('UPDATE businesses SET subdomain_status = $2, subdomain_checked_at = now() WHERE id = $1', [b.id, `${result.state}: ${result.message}`]);
    res.redirect(`/admin/businesses/${b.id}?done=checked`);
  }));

  // System status: what the database holds, and a full backup download (the free Render
  // database has no automatic backups).
  router.get('/admin/system', asyncHandler(async (req, res) => {
    const counts = [];
    for (const t of TABLE_ORDER) counts.push([t, (await pool.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n]);
    const [{ rows: [db] }, { rows: migrations }, { rows: last }] = await Promise.all([
      pool.query("SELECT pg_size_pretty(pg_database_size(current_database())) AS size, version() AS version"),
      pool.query('SELECT name, applied_at FROM schema_migrations ORDER BY name'),
      pool.query("SELECT a.created_at, u.email FROM audit_log a LEFT JOIN users u ON u.id = a.user_id WHERE a.action = 'admin.backup_downloaded' ORDER BY a.id DESC LIMIT 1"),
    ]);
    res.set('Cache-Control', 'no-store');
    res.render('admin/system', { counts, db, migrations, lastBackup: last[0] ?? null, uncovered: await uncoveredTables(pool), dbExpiresAt: config.databaseExpiresAt });
  }));

  router.get('/admin/backup.json', asyncHandler(async (req, res) => sendBackup(pool, req, res, { via: 'signed in' })));

  // Capacity: how close the shared platform is to its limits, and which businesses use it most.
  router.get('/admin/capacity.json', asyncHandler(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(await capacity(Number(req.query.minutes) || 15));
  }));
  router.get('/admin/capacity', asyncHandler(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.render('admin/capacity', { c: await capacity(Number(req.query.minutes) || 15) });
  }));
  async function capacity(minutes) {
    const window = [5, 15, 60].includes(minutes) ? minutes : 15;
    const report = load ? load.metrics.report(window) : null;
    const status = load ? load.status() : null;
    const [{ rows: [db] }, { rows: queues }, { rows: names }, { rows: usage }] = await Promise.all([
      pool.query(`SELECT current_setting('max_connections')::int AS max_connections,
                         (SELECT count(*)::int FROM pg_stat_activity WHERE datname = current_database()) AS connections,
                         pg_database_size(current_database()) AS bytes`),
      pool.query(`SELECT 'Google Sheet copies waiting' AS label, count(*)::int AS n, min(created_at) AS oldest FROM orders WHERE sheet_sync_status IN ('pending', 'failed') AND NOT is_test
                  UNION ALL SELECT 'Emails queued', count(*)::int, min(scheduled_for) FROM email_messages WHERE status = 'queued' AND scheduled_for <= now()`),
      pool.query('SELECT id::text, name FROM businesses'),
      pool.query(`SELECT b.id::text, b.name, b.max_landing_pages,
                         (SELECT count(*)::int FROM landing_pages lp WHERE lp.business_id = b.id AND lp.status <> 'archived') AS pages,
                         (SELECT count(*)::int FROM orders o WHERE o.business_id = b.id AND o.created_at > now() - interval '24 hours' AND NOT o.is_test) AS orders_24h,
                         (SELECT count(*)::int FROM products p WHERE p.business_id = b.id) AS products
                    FROM businesses b ORDER BY orders_24h DESC, b.name`),
    ]);
    const nameOf = new Map(names.map((n) => [n.id, n.name]));
    const rows = (report?.rows ?? []).map((r) => ({ ...r, name: nameOf.get(r.business) ?? (r.business === 'unknown' ? 'Unknown page' : r.business) }));
    // Plain verdicts with the measured reason.
    const advice = [];
    const poolMax = config.dbPoolMax ?? 10;
    if (report) {
      if (report.pool.waitingAvg > 0.5 || report.pool.timeouts > 0) advice.push({ level: 'act', text: `Requests waited for a database connection (average ${report.pool.waitingAvg} waiting, ${report.pool.timeouts} timed out). Upgrade the database plan and raise DB_POOL_MAX, or add caching.` });
      else if (report.pool.busyMax >= poolMax) advice.push({ level: 'watch', text: `All ${poolMax} database connections were in use at least once in the last ${window} minutes. Watch this; act if requests start waiting.` });
      if (report.cpuPercent > 70) advice.push({ level: 'act', text: `The server used ${report.cpuPercent}% of its CPU. Upgrade the web instance (more CPU) or add a second instance.` });
      if (report.eventLoopP99Ms > 250) advice.push({ level: 'act', text: `Requests waited up to ${report.eventLoopP99Ms} ms for the server's CPU. Upgrade the web instance or add a second instance.` });
      if (report.memoryMb > 400) advice.push({ level: 'watch', text: `The server uses ${report.memoryMb} MB of memory (Render's smallest instances have 512 MB).` });
      const busy = rows.filter((r) => r.busy > 0);
      if (busy.length) advice.push({ level: 'watch', text: `"Busy, try again" answers were given to: ${[...new Set(busy.map((r) => r.name))].join(', ')}. That business reached its fair share; other businesses were protected. If this happens often for real visitors, the platform needs more capacity.` });
      const slow = rows.filter((r) => r.requests >= 20 && typeof r.p95 === 'number' && r.p95 >= (r.kind === 'order' ? 2500 : 1000));
      if (slow.length) advice.push({ level: 'act', text: `Slow answers (95th percentile): ${slow.map((r) => `${r.name} ${r.kind} ${r.p95} ms`).join('; ')}.` });
    }
    if (db.connections > db.max_connections * 0.8) advice.push({ level: 'act', text: `The database has ${db.connections} of ${db.max_connections} connections open. Upgrade the database plan before adding web instances.` });
    for (const q of queues) {
      if (q.n > 0 && q.oldest && Date.now() - new Date(q.oldest).getTime() > 60 * 60 * 1000) advice.push({ level: 'watch', text: `${q.label}: ${q.n}, the oldest since ${new Date(q.oldest).toISOString().slice(0, 16).replace('T', ' ')} UTC.` });
    }
    if (!advice.length) advice.push({ level: 'ok', text: `No limit was reached in the last ${window} minutes.` });
    return { window, report: report && { ...report, rows }, status, db: { ...db, sizeMb: Math.round(db.bytes / 1048576) }, queues, usage, advice };
  }


  // ---- Skyfly's own domains (e.g. getskyfly.com): expiry, renewal, reminders and the connection to this server.
  // "Verified" facts come from the domain registry; the rest is what the owner typed in. No payment
  // details or registrar passwords are stored.
  const DOMAIN_NOTICES = { added: 'Domain added and the registry checked. The results are below.', saved: 'Saved.', checked: 'Registry checked again.' };
  const domainsPage = async (req, res, { error = null, status = 200, connection = null } = {}) => {
    const domains = (await listDomains(pool)).map((d) => ({ ...d, summary: domainSummary(d) }));
    const { rows: reminders } = await pool.query(
      `SELECT r.days_before, r.expires_on, r.status, r.detail, r.created_at, d.domain FROM platform_domain_reminders r
         JOIN platform_domains d ON d.id = r.domain_id ORDER BY r.id DESC LIMIT 20`);
    res.set('Cache-Control', 'no-store');
    res.status(status).render('admin/domains', {
      domains, reminders, error, connection, notice: DOMAIN_NOTICES[req.query.done] ?? null, reminderDays: REMINDER_DAYS,
      dashboardUrl: config.publicBaseUrl, aliases: config.dashboardAliases ?? [], emailReady: Boolean(config.notifyEmail?.apiKey && config.notifyEmail?.fromEmail),
    });
  };
  const loadDomain = async (id) => (await pool.query(`SELECT ${DOMAIN_COLUMNS} FROM platform_domains WHERE id = $1`, [id])).rows[0] ?? null;

  router.get('/admin/domains', asyncHandler((req, res) => domainsPage(req, res)));

  router.post('/admin/domains', asyncHandler(async (req, res) => {
    const domain = normalizeDomain(req.body.domain);
    if (!domain) return domainsPage(req, res, { error: 'Enter a domain name like getskyfly.com.', status: 400 });
    const { rows: [row] } = await pool.query('INSERT INTO platform_domains (domain) VALUES ($1) ON CONFLICT (domain) DO NOTHING RETURNING id', [domain]);
    if (!row) return domainsPage(req, res, { error: `${domain} is already listed.`, status: 409 });
    await refreshDomain(pool, row.id);
    await audit(pool, req, { action: 'admin.domain_added', entityType: 'platform_domain', entityId: row.id, details: { domain } });
    res.redirect('/admin/domains?done=added');
  }));

  router.post('/admin/domains/:id', asyncHandler(async (req, res) => {
    const d = await loadDomain(req.params.id);
    if (!d) return res.status(404).render('error', { message: 'Domain not found.' });
    const url = normalizeRegistrarUrl(req.body.registrar_url);
    if (url.error) return domainsPage(req, res, { error: url.error, status: 400 });
    const expires = String(req.body.manual_expires_on ?? '').trim();
    if (expires && !validDate(expires)) return domainsPage(req, res, { error: 'The expiry date must be a valid date.', status: 400 });
    const confirmed = String(req.body.manual_auto_renew_confirmed_on ?? '').trim();
    if (confirmed && !validDate(confirmed)) return domainsPage(req, res, { error: 'The "last checked" date must be a valid date.', status: 400 });
    const autoRenew = { on: true, off: false }[req.body.manual_auto_renew] ?? null;
    await pool.query(
      `UPDATE platform_domains SET registrar_name = $2, registrar_url = $3, manual_expires_on = $4, manual_auto_renew = $5,
              manual_auto_renew_confirmed_on = $6, notes = $7, updated_at = now() WHERE id = $1`,
      [d.id, String(req.body.registrar_name ?? '').trim().slice(0, 100) || null, url.value, expires || null, autoRenew,
        confirmed || null, String(req.body.notes ?? '').trim().slice(0, 1000) || null]);
    await audit(pool, req, { action: 'admin.domain_updated', entityType: 'platform_domain', entityId: d.id, details: { domain: d.domain, autoRenew } });
    res.redirect('/admin/domains?done=saved');
  }));

  router.post('/admin/domains/:id/check', asyncHandler(async (req, res) => {
    const d = await loadDomain(req.params.id);
    if (!d) return res.status(404).render('error', { message: 'Domain not found.' });
    await refreshDomain(pool, d.id);
    res.redirect('/admin/domains?done=checked');
  }));

  // Is the domain connected to this server? DNS → HTTPS → this Skyfly answers. Checked, never assumed.
  router.post('/admin/domains/:id/connection', asyncHandler(async (req, res) => {
    const d = await loadDomain(req.params.id);
    if (!d) return res.status(404).render('error', { message: 'Domain not found.' });
    const target = config.renderHost || config.dashboardHost;
    const steps = [];
    const dnsResult = await checkDomain(d.domain, target);
    steps.push({ ok: dnsResult.ok, text: `DNS: ${dnsResult.message}` });
    let https = false;
    try {
      const r = await fetch(`https://${d.domain}/healthz`, { redirect: 'manual', signal: AbortSignal.timeout(15000) });
      const body = await r.json().catch(() => null);
      https = r.status === 200 && body?.status === 'ok';
      steps.push({ ok: https, text: https ? `HTTPS: https://${d.domain}/healthz answered securely from Skyfly.` : `HTTPS: https://${d.domain}/healthz answered HTTP ${r.status}, not Skyfly's health check.` });
    } catch (err) {
      const cause = String(err?.cause?.code || err?.cause?.message || err?.message || '');
      steps.push({ ok: false, text: `HTTPS: no secure answer (${/CERT|SSL|TLS|certificate/i.test(cause) ? 'no valid certificate yet' : cause.slice(0, 80) || 'timeout'}). The domain must be added in Render → skyfly → Settings → Custom Domains.` });
    }
    const main = config.dashboardHost === d.domain;
    steps.push({ ok: main, text: main ? `Skyfly uses https://${d.domain} as its main address (PUBLIC_BASE_URL).` : `Skyfly's main address is still ${config.publicBaseUrl}. Set PUBLIC_BASE_URL=https://${d.domain} in Render only after DNS and HTTPS pass.` });
    domainsPage(req, res, { connection: { domain: d.domain, steps, at: new Date() } });
  }));

  // ---- Super Admins: who may sign in to this area. Granting or removing needs the acting Super Admin's
  // password again; the last Super Admin cannot be removed, and nobody removes themselves.
  const ADMIN_NOTICES = { granted: 'Super Admin access granted.', revoked: 'Super Admin access removed.' };
  const adminsPage = async (req, res, { error = null, status = 200 } = {}) => {
    const { rows: admins } = await pool.query('SELECT id, name, email, created_at FROM users WHERE is_platform_admin ORDER BY id');
    res.set('Cache-Control', 'no-store');
    res.status(status).render('admin/admins', { admins, me: req.session.userId, error, notice: ADMIN_NOTICES[req.query.done] ?? null });
  };
  const confirmPassword = async (req) => {
    const { rows: [me] } = await pool.query('SELECT password_hash FROM users WHERE id = $1', [req.session.userId]);
    return Boolean(me && (await verifyPassword(String(req.body.password || ''), me.password_hash)));
  };
  router.get('/admin/admins', asyncHandler((req, res) => adminsPage(req, res)));
  router.post('/admin/admins', asyncHandler(async (req, res) => {
    if (!(await confirmPassword(req))) return adminsPage(req, res, { error: 'Your password was not correct.', status: 403 });
    const email = String(req.body.email || '').trim().toLowerCase();
    const { rows: [u] } = await pool.query('SELECT id, is_platform_admin FROM users WHERE email = $1 AND email NOT LIKE $2', [email, E2E_EMAIL_LIKE]);
    if (!u) return adminsPage(req, res, { error: 'No Skyfly account uses that email. The person must have an account first.', status: 404 });
    if (!u.is_platform_admin) {
      await pool.query('UPDATE users SET is_platform_admin = true WHERE id = $1', [u.id]);
      await audit(pool, req, { action: 'admin.access_granted', entityType: 'user', entityId: u.id, details: { email } });
    }
    res.redirect('/admin/admins?done=granted');
  }));
  router.post('/admin/admins/:userId/revoke', asyncHandler(async (req, res) => {
    if (!(await confirmPassword(req))) return adminsPage(req, res, { error: 'Your password was not correct.', status: 403 });
    const id = Number(req.params.userId);
    if (!Number.isInteger(id) || id === req.session.userId) return adminsPage(req, res, { error: 'You cannot remove your own Super Admin access.', status: 400 });
    const { rowCount } = await pool.query(
      'UPDATE users SET is_platform_admin = false WHERE id = $1 AND is_platform_admin AND (SELECT count(*) FROM users WHERE is_platform_admin) > 1', [id]);
    if (!rowCount) return adminsPage(req, res, { error: 'That account is not a Super Admin, or it is the last one.', status: 400 });
    await audit(pool, req, { action: 'admin.access_revoked', entityType: 'user', entityId: id });
    res.redirect('/admin/admins?done=revoked');
  }));

  router.get('/admin/settings', asyncHandler(async (req, res) => {
    res.render('admin/settings', { settings: await platformSettings(pool), notice: req.query.done ? 'Saved.' : null, error: null });
  }));

  router.post('/admin/settings', asyncHandler(async (req, res) => {
    const trialDays = Number(req.body.trial_days);
    if (!Number.isInteger(trialDays) || trialDays < 0 || trialDays > 90) {
      return res.status(400).render('admin/settings', { settings: await platformSettings(pool), notice: null, error: 'Trial days must be a whole number from 0 to 90.' });
    }
    const signup = req.body.client_signup === 'open' ? 'open' : 'invite_only';
    await savePlatformSetting(pool, 'client_signup', signup);
    await savePlatformSetting(pool, 'trial_days', trialDays);
    await savePlatformSetting(pool, 'renewal_instructions', String(req.body.renewal_instructions ?? '').trim().slice(0, 2000));
    await audit(pool, req, { action: 'admin.settings_updated', details: { clientSignup: signup, trialDays } });
    res.redirect('/admin/settings?done=1');
  }));

  // ---- Google key: the platform's service account for Google Sheets (uploaded as the downloaded file).
  const GOOGLE_NOTICES = { uploaded: 'Key file saved (encrypted) and checked. The results are below.', checked: 'Checked again.', sheet: 'Laroseorders saved for Larose (read-only, not the default). The results are below.' };
  const googlePage = async (req, res, { error = null, status = 200 } = {}) => {
    const stored = await storedGoogleKey(pool, config.encryptionKey).catch(() => null);
    res.set('Cache-Control', 'no-store');
    res.status(status).render('admin/google', {
      status: googleStatus, email: googleAccountEmail(), stored, error, notice: GOOGLE_NOTICES[req.query.done] ?? null, canStore: Boolean(config.encryptionKey),
      setup: req.session.googleSetup ?? null,
    });
  };
  router.get('/admin/google', asyncHandler((req, res) => googlePage(req, res)));

  router.post('/admin/google', (req, res, next) => keyUpload.single('file')(req, res, (err) => {
    if (err) { req.uploadError = 'The file could not be read. Choose the .json key file Google downloaded (about 2 KB).'; req.body = req.body || {}; }
    requireCsrf(req, res, next);
  }), asyncHandler(async (req, res) => {
    if (req.uploadError) return googlePage(req, res, { error: req.uploadError, status: 400 });
    if (!config.encryptionKey) return googlePage(req, res, { error: 'SKYFLY_ENCRYPTION_KEY is not set on the server, so the key cannot be stored safely.', status: 400 });
    // The downloaded file, or its contents pasted (for phones where choosing a file is awkward).
    const text = req.file?.buffer?.toString('utf8') || String(req.body.key_text ?? '').slice(0, 20000);
    if (!text.trim()) return googlePage(req, res, { error: 'Choose the .json key file Google downloaded when you created the key, or paste its whole contents.', status: 400 });
    const sheetLink = String(req.body.larose_sheet ?? '').trim();
    const sheetId = sheetLink ? (sheetLink.match(SPREADSHEET_ID_RE)?.[1] ?? (/^[A-Za-z0-9_-]{30,100}$/.test(sheetLink) ? sheetLink : null)) : null;
    if (sheetLink && !sheetId) return googlePage(req, res, { error: 'The Laroseorders link must be a Google Sheets link (https://docs.google.com/spreadsheets/d/…) or its ID.', status: 400 });
    const { account, problem } = readServiceAccount(text);
    if (!account) return googlePage(req, res, { error: `This file cannot be used: ${problem}.`, status: 400 });
    await saveGoogleKey(pool, config.encryptionKey, text);
    const r = await useServiceAccount(account, 'key file uploaded in Platform admin');
    console.log(`Google Sheets API: key file uploaded in Platform admin; service account of project ${r.project}; sign-in ${r.auth}; Sheets API ${r.sheetsApi}`);
    // Spreadsheets saved before the key worked are checked now (read-only; waiting orders stay held).
    if (r.auth === 'ok') await recheckGoogleConnections(pool, config.encryptionKey);
    await audit(pool, req, { action: 'admin.google_key_uploaded', details: { project: r.project, email: account.client_email, auth: r.auth, sheetsApi: r.sheetsApi } });
    // Optional, same step: connect Laroseorders to Larose (read-only check, NOT the default, so nothing
    // is copied) and compare the waiting orders with it by order ID. Nothing is written or sent.
    if (sheetId && r.auth === 'ok') req.session.googleSetup = await connectLarose(req, sheetId);
    res.redirect('/admin/google?done=uploaded');
  }));

  async function connectLarose(req, sheetId) {
    const { rows: [b] } = await pool.query("SELECT id FROM businesses WHERE slug = 'larose-nigeria'");
    if (!b) return { error: 'The Larose business was not found.' };
    const apiUrl = `gsheets:${sheetId}`;
    let { rows: [c] } = await pool.query('SELECT id FROM sheet_connections WHERE business_id = $1 AND api_url_hash = $2', [b.id, urlHash(apiUrl)]);
    if (!c) {
      const id = await addConnection(pool, config.encryptionKey, b.id, {
        name: 'Laroseorders', apiUrl, tab: SKYFLY_TAB, spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${sheetId}/edit`, makeDefault: false });
      c = { id };
      await audit(pool, req, { action: 'google_sheets.connected', businessId: b.id, entityType: 'sheet_connection', entityId: id, details: { name: 'Laroseorders', default: false } });
    }
    const conn = await loadConnection(pool, config.encryptionKey, b.id, c.id);
    const { status, detail } = await checkConnection(pool, conn);
    if (status !== 'ok') return { connectionId: c.id, check: status, detail };
    try {
      const cmp = await reconcileWaiting(pool, conn);
      return { connectionId: c.id, check: status, detail, waiting: cmp.waiting, present: cmp.present.length, missing: cmp.missing.length, tests: cmp.tests, title: cmp.title, isDefault: cmp.isDefault };
    } catch (err) {
      return { connectionId: c.id, check: status, detail, error: `Comparison failed: ${err.message}` };
    }
  }

  // The Laroseorders link alone, with the key already saved (read-only, not the default).
  router.post('/admin/google/larose-sheet', asyncHandler(async (req, res) => {
    const link = String(req.body.larose_sheet ?? '').trim();
    const sheetId = link.match(SPREADSHEET_ID_RE)?.[1] ?? (/^[A-Za-z0-9_-]{30,100}$/.test(link) ? link : null);
    if (!sheetId) return googlePage(req, res, { error: 'Paste the Laroseorders link (https://docs.google.com/spreadsheets/d/…) or its ID.', status: 400 });
    if (!googleStatus.configured) return googlePage(req, res, { error: 'Upload the key file first.', status: 400 });
    req.session.googleSetup = await connectLarose(req, sheetId);
    res.redirect('/admin/google?done=sheet');
  }));

  router.post('/admin/google/check', asyncHandler(async (req, res) => {
    if (googleStatus.configured) {
      Object.assign(googleStatus, await googleSelfCheck());
      console.log(`Google Sheets API: checked again; sign-in ${googleStatus.auth}; Sheets API ${googleStatus.sheetsApi}`);
      if (googleStatus.auth === 'ok') {
        await recheckGoogleConnections(pool, config.encryptionKey);
        await compareHeldGoogleConnections(pool, config.encryptionKey);
      }
    }
    res.redirect('/admin/google?done=checked');
  }));

  return router;
}
