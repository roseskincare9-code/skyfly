import { Router } from 'express';
import { requireAuth, slugify } from '../lib/auth.js';

export function businessRoutes({ pool }) {
  const router = Router();
  router.use(requireAuth);

  router.get('/', async (req, res, next) => {
    try {
      const { rows } = await pool.query(
        'SELECT id, name, slug, currency, created_at FROM businesses WHERE owner_id = $1 ORDER BY created_at',
        [req.session.userId],
      );
      res.render('dashboard', { businesses: rows });
    } catch (err) {
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
