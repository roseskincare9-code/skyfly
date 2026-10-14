import { Router } from 'express';
import { requireAuth, slugify } from '../lib/auth.js';
import { seedLarose } from '../scripts/seed-larose.js';
import { audit } from '../lib/audit.js';

export function businessRoutes({ pool }) {
  const router = Router();
  router.use(requireAuth);

  router.get('/', async (req, res, next) => {
    try {
      const { rows } = await pool.query(
        'SELECT id, name, slug, currency, created_at FROM businesses WHERE owner_id = $1 ORDER BY created_at',
        [req.session.userId],
      );
      // Offer one-click Larose setup until the Larose landing page is registered by anyone.
      const { rows: [larose] } = await pool.query("SELECT 1 FROM landing_pages WHERE slug = 'larosenigeria'");
      res.render('dashboard', { businesses: rows, offerLarose: !larose });
    } catch (err) {
      next(err);
    }
  });

  // Same as `npm run seed:larose`, without needing Render's Shell. Safe to repeat.
  router.post('/setup/larose', async (req, res, next) => {
    try {
      const { rows: [user] } = await pool.query('SELECT email FROM users WHERE id = $1', [req.session.userId]);
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
      const name = String(req.body.name || '').trim();
      const slug = slugify(name);
      if (!name || !slug) {
        return res.redirect('/');
      }
      await pool.query(
        `INSERT INTO businesses (owner_id, name, slug)
         VALUES ($1, $2, $3 || CASE WHEN EXISTS (SELECT 1 FROM businesses WHERE slug = $3)
                                    THEN '-' || substr(md5(random()::text), 1, 6) ELSE '' END)`,
        [req.session.userId, name, slug],
      );
      res.redirect('/');
    } catch (err) {
      next(err);
    }
  });

  return router;
}
