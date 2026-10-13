import { Router } from 'express';
import { asyncHandler } from '../lib/http.js';
import { parseMajorToMinor } from '../lib/money.js';
import { slugify } from '../lib/auth.js';

function readProduct(body) {
  const name = String(body.name ?? '').trim().slice(0, 200);
  const code = slugify(String(body.code ?? '') || name).slice(0, 50);
  const price = parseMajorToMinor(body.price);
  const sortOrder = Number.parseInt(body.sort_order, 10) || 0;
  const errors = [];
  if (!name) errors.push('Name is required.');
  if (!code) errors.push('Code is required.');
  if (price === null) errors.push('Enter a valid price, e.g. 23500.');
  return { name, code, price, sortOrder, active: body.active === 'on', errors };
}

export function productRoutes({ pool }) {
  const router = Router({ mergeParams: true });

  async function render(req, res, error = null, status = 200) {
    const { rows } = await pool.query(
      `SELECT p.*, (SELECT count(*)::int FROM order_items i WHERE i.product_id = p.id) AS times_ordered
         FROM products p WHERE p.business_id = $1 ORDER BY p.sort_order, p.id`,
      [req.business.id],
    );
    res.status(status).render('products', { products: rows, error });
  }

  router.get('/', asyncHandler((req, res) => render(req, res)));

  router.post('/', asyncHandler(async (req, res) => {
    const p = readProduct({ ...req.body, active: 'on' });
    if (p.errors.length) return render(req, res, p.errors.join(' '), 400);
    try {
      await pool.query(
        'INSERT INTO products (business_id, code, name, price_minor, sort_order) VALUES ($1, $2, $3, $4, $5)',
        [req.business.id, p.code, p.name, p.price, p.sortOrder],
      );
    } catch (err) {
      if (err.code === '23505') return render(req, res, `A product with code "${p.code}" already exists.`, 409);
      throw err;
    }
    res.redirect(`${res.locals.base}/products`);
  }));

  // The code is the stable key landing pages send, so it is not editable here.
  router.post('/:productId', asyncHandler(async (req, res) => {
    const p = readProduct({ ...req.body, code: 'unchanged' });
    if (p.errors.length) return render(req, res, p.errors.join(' '), 400);
    const { rowCount } = await pool.query(
      `UPDATE products SET name = $1, price_minor = $2, sort_order = $3, active = $4, updated_at = now()
        WHERE id = $5 AND business_id = $6`,
      [p.name, p.price, p.sortOrder, p.active, req.params.productId, req.business.id],
    );
    if (!rowCount) return res.status(404).render('error', { message: 'Product not found.' });
    res.redirect(`${res.locals.base}/products`);
  }));

  return router;
}
