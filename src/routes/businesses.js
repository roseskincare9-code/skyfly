import { Router } from 'express';
import { requireAuth, slugify } from '../lib/auth.js';
import { seedLarose } from '../scripts/seed-larose.js';
import { audit } from '../lib/audit.js';
import { adminVerified } from '../lib/adminSession.js';
import { platformSettings, subscriptionState, createBusiness } from '../services/tenancy.js';

export function businessRoutes({ pool }) {
  const router = Router();
  router.use(requireAuth);

  router.get('/', async (req, res, next) => {
    try {
      const { rows } = await pool.query(
        `SELECT b.id, b.name, b.slug, b.currency, b.created_at, b.subscription_status, b.subscription_expires_on, m.role,
                (now() AT TIME ZONE b.timezone)::date::text AS local_today
           FROM business_members m JOIN businesses b ON b.id = m.business_id
          WHERE m.user_id = $1 ORDER BY b.created_at`,
        [req.session.userId],
      );
      const { rows: [me] } = await pool.query('SELECT is_platform_admin, last_business_id FROM users WHERE id = $1', [req.session.userId]);
      me.is_platform_admin = me.is_platform_admin && adminVerified(req);
      // A client with exactly one business goes straight to it.
      if (rows.length === 1 && !me.is_platform_admin && req.query.all !== '1') return res.redirect(`/businesses/${rows[0].id}`);
      // An account with several businesses returns to the one it last opened (only if still a member);
      // "Businesses" (/?all=1) lists them all to switch.
      const last = rows.find((b) => Number(b.id) === Number(me.last_business_id));
      if (last && req.query.all !== '1') return res.redirect(`/businesses/${last.id}`);
      // Offer one-click Larose setup until the Larose landing page is registered by anyone (platform owner only).
      const { rows: [larose] } = await pool.query("SELECT 1 FROM landing_pages WHERE slug = 'larosenigeria'");
      const settings = await platformSettings(pool);
      res.render('dashboard', {
        businesses: rows.map((b) => ({ ...b, sub: subscriptionState(b) })), offerLarose: !larose && me.is_platform_admin,
        // Only a Super Admin manages several businesses; anyone else may create one only while they have none.
        isPlatformAdmin: me.is_platform_admin, canCreate: me.is_platform_admin || (settings.clientSignup === 'open' && rows.length === 0), trialDays: settings.trialDays,
      });
    } catch (err) {
      next(err);
    }
  });

  // Same as `npm run seed:larose`, without needing Render's Shell. Safe to repeat.
  router.post('/setup/larose', async (req, res, next) => {
    try {
      const { rows: [user] } = await pool.query('SELECT email, is_platform_admin FROM users WHERE id = $1', [req.session.userId]);
      if (!user.is_platform_admin || !adminVerified(req)) return res.status(404).render('error', { message: 'Page not found.' });
      const businessId = await seedLarose(pool, user.email);
      await audit(pool, req, { action: 'business.larose_setup', businessId });
      res.redirect(`/businesses/${businessId}`);
    } catch (err) {
      if (/belongs to a different user/.test(err.message)) return res.status(409).render('error', { message: 'The Larose business already belongs to another account.' });
      next(err);
    }
  });

  router.post('/businesses', async (req, res, next) => {
    try {
      const name = String(req.body.name || '').trim().slice(0, 100);
      const slug = slugify(name);
      if (!name || !slug) {
        return res.redirect('/');
      }
      // Clients may create their own business only when the platform owner has opened sign-up.
      // It starts as a trial (or locked until the platform owner activates it, with 0 trial days).
      const { rows: [me] } = await pool.query('SELECT is_platform_admin FROM users WHERE id = $1', [req.session.userId]);
      me.is_platform_admin = me.is_platform_admin && adminVerified(req);
      const settings = await platformSettings(pool);
      if (!me.is_platform_admin && settings.clientSignup !== 'open') return res.status(403).render('error', { message: 'New businesses are set up by the Skyfly team. Ask them for an invitation.' });
      // Each account manages one business; only a Super Admin manages several.
      if (!me.is_platform_admin && (await pool.query('SELECT 1 FROM business_members WHERE user_id = $1 LIMIT 1', [req.session.userId])).rowCount) {
        return res.status(403).render('error', { message: 'Each Skyfly account manages one business. To run another business, register it with a different email address.' });
      }
      const b = await createBusiness(pool, { userId: req.session.userId, name, slug, asAdmin: me.is_platform_admin, trialDays: settings.trialDays });
      const { status } = b;
      await audit(pool, req, { action: 'business.created', businessId: b.id, details: { status } });
      res.redirect(`/businesses/${b.id}`);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
