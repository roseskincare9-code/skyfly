import { Router } from 'express';
import { asyncHandler } from '../lib/http.js';
import { parseMajorToMinor } from '../lib/money.js';
import { slugify } from '../lib/auth.js';
import { audit } from '../lib/audit.js';
import { parseOptionsText, formatOptionsText } from '../lib/options.js';

function readProduct(body) {
  const name = String(body.name ?? '').trim().slice(0, 200);
  const code = slugify(String(body.code ?? '') || name).slice(0, 50);
  const price = parseMajorToMinor(body.price);
  const sortOrder = Number.parseInt(body.sort_order, 10) || 0;
  const description = String(body.description ?? '').trim().slice(0, 500) || null;
  const rawCompare = String(body.compare_at ?? '').trim();
  const compareAt = rawCompare ? parseMajorToMinor(rawCompare) : null;
  const { options, errors: optionErrors } = parseOptionsText(body.options);
  const errors = [];
  if (!name) errors.push('Name is required.');
  if (!code) errors.push('Code is required.');
  if (price === null) errors.push('Enter a valid price, e.g. 23500.');
  if (rawCompare && compareAt === null) errors.push('Enter a valid "was" price, or leave it empty.');
  if (compareAt !== null && price !== null && compareAt <= price) errors.push('The "was" price must be higher than the price.');
  errors.push(...optionErrors.map((e) => `Options: ${e}`));
  return { name, code, price, sortOrder, description, compareAt, options, active: body.active === 'on', errors };
}

export function productRoutes({ pool }) {
  const router = Router({ mergeParams: true });

  async function render(req, res, error = null, status = 200) {
    const { rows } = await pool.query(
      `SELECT p.*, (SELECT count(*)::int FROM order_items i WHERE i.product_id = p.id) AS times_ordered
         FROM products p WHERE p.business_id = $1 ORDER BY p.sort_order, p.id`,
      [req.business.id],
    );
    res.status(status).render('products', { products: rows, error, formatOptionsText });
  }

  router.get('/', asyncHandler((req, res) => render(req, res)));

  router.post('/', asyncHandler(async (req, res) => {
    const p = readProduct({ ...req.body, active: 'on' });
    if (p.errors.length) return render(req, res, p.errors.join(' '), 400);
    try {
      await pool.query(
        'INSERT INTO products (business_id, code, name, price_minor, sort_order, description, compare_at_price_minor, options) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
        [req.business.id, p.code, p.name, p.price, p.sortOrder, p.description, p.compareAt, JSON.stringify(p.options)],
      );
    } catch (err) {
      if (err.code === '23505') return render(req, res, `A product with code "${p.code}" already exists.`, 409);
      throw err;
    }
    await audit(pool, req, { action: 'product.created', businessId: req.business.id, entityType: 'product', entityId: p.code, details: { price: p.price } });
    res.redirect(`${res.locals.base}/products`);
  }));

  // The code is the stable key landing pages send, so it is not editable here.
  router.post('/:productId', asyncHandler(async (req, res) => {
    const p = readProduct({ ...req.body, code: 'unchanged' });
    if (p.errors.length) return render(req, res, p.errors.join(' '), 400);
    const { rowCount } = await pool.query(
      `UPDATE products SET name = $1, price_minor = $2, sort_order = $3, active = $4, description = $7, compare_at_price_minor = $8, options = $9, updated_at = now()
        WHERE id = $5 AND business_id = $6`,
      [p.name, p.price, p.sortOrder, p.active, req.params.productId, req.business.id, p.description, p.compareAt, JSON.stringify(p.options)],
    );
    if (!rowCount) return res.status(404).render('error', { message: 'Product not found.' });
    await audit(pool, req, { action: 'product.updated', businessId: req.business.id, entityType: 'product', entityId: req.params.productId, details: { price: p.price, active: p.active } });
    res.redirect(`${res.locals.base}/products`);
  }));

  return router;
}
