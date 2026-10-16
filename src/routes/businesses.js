import { Router } from 'express';
import { requireAuth, slugify } from '../lib/auth.js';
import { seedLarose } from '../scripts/seed-larose.js';
import { audit } from '../lib/audit.js';
import { platformSettings, subscriptionState } from '../services/tenancy.js';

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
      const { rows: [me] } = await pool.query('SELECT is_platform_admin FROM users WHERE id = $1', [req.session.userId]);
      // A client with exactly one business goes straight to it.
      if (rows.length === 1 && !me.is_platform_admin && req.query.all !== '1') return res.redirect(`/businesses/${rows[0].id}`);
      // Offer one-click Larose setup until the Larose landing page is registered by anyone (platform owner only).
      const { rows: [larose] } = await pool.query("SELECT 1 FROM landing_pages WHERE slug = 'larosenigeria'");
      const settings = await platformSettings(pool);
      res.render('dashboard', {
        businesses: rows.map((b) => ({ ...b, sub: subscriptionState(b) })), offerLarose: !larose && me.is_platform_admin,
        isPlatformAdmin: me.is_platform_admin, canCreate: me.is_platform_admin || settings.clientSignup === 'open', trialDays: settings.trialDays,
      });
    } catch (err) {
      next(err);
    }
  });

  // Same as `npm run seed:larose`, without needing Render's Shell. Safe to repeat.
  router.post('/setup/larose', async (req, res, next) => {
    try {
      const { rows: [user] } = await pool.query('SELECT email, is_platform_admin FROM users WHERE id = $1', [req.session.userId]);
      if (!user.is_platform_admin) return res.status(404).render('error', { message: 'Page not found.' });
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
      const settings = await platformSettings(pool);
      if (!me.is_platform_admin && settings.clientSignup !== 'open') return res.status(403).render('error', { message: 'New businesses are set up by the Skyfly team. Ask them for an invitation.' });
      const status = me.is_platform_admin ? 'active' : (settings.trialDays > 0 ? 'trial' : 'locked');
      const { rows: [b] } = await pool.query(
        `INSERT INTO businesses (owner_id, name, slug, subscription_status, subscription_started_on, subscription_expires_on, subscription_updated_at)
         VALUES ($1, $2, $3 || CASE WHEN EXISTS (SELECT 1 FROM businesses WHERE slug = $3)
                                    THEN '-' || substr(md5(random()::text), 1, 6) ELSE '' END,
                 $4, CASE WHEN $5 THEN NULL ELSE (now() AT TIME ZONE 'Africa/Lagos')::date END,
                 CASE WHEN $5 OR $6 = 0 THEN NULL ELSE (now() AT TIME ZONE 'Africa/Lagos')::date + $6::int END, now())
         RETURNING id`,
        [req.session.userId, name, slug, status, me.is_platform_admin, settings.trialDays],
      );
      await pool.query("INSERT INTO business_members (business_id, user_id, role) VALUES ($1, $2, 'owner')", [b.id, req.session.userId]);
      await audit(pool, req, { action: 'business.created', businessId: b.id, details: { status } });
      res.redirect(`/businesses/${b.id}`);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
