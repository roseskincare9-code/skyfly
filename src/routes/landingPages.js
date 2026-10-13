import { Router } from 'express';
import { asyncHandler } from '../lib/http.js';
import { slugify } from '../lib/auth.js';
import { LANDING_PAGE_STATUSES } from '../lib/statuses.js';

function safeUrl(input) {
  const s = String(input ?? '').trim();
  if (!s) return null;
  try {
    const u = new URL(s);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : undefined;
  } catch {
    return undefined;
  }
}

function readPage(body) {
  const name = String(body.name ?? '').trim().slice(0, 200);
  const slug = slugify(String(body.slug ?? '') || name);
  const url = safeUrl(body.url);
  const status = LANDING_PAGE_STATUSES.includes(body.status) ? body.status : 'draft';
  const notes = String(body.notes ?? '').trim().slice(0, 2000) || null;
  const productIds = [].concat(body.products ?? []).filter((id) => /^\d+$/.test(id));
  const errors = [];
  if (!name) errors.push('Name is required.');
  if (!slug) errors.push('Form key is required.');
  if (url === undefined) errors.push('Enter a valid http(s) URL.');
  return { name, slug, url: url ?? null, status, notes, productIds, errors };
}

export function landingPageRoutes({ pool }) {
  const router = Router({ mergeParams: true });

  async function products(businessId) {
    const { rows } = await pool.query(
      'SELECT id, code, name, price_minor, active FROM products WHERE business_id = $1 ORDER BY sort_order, id',
      [businessId],
    );
    return rows;
  }

  async function loadPage(req) {
    if (!/^\d+$/.test(req.params.pageId)) return null;
    const { rows } = await pool.query('SELECT * FROM landing_pages WHERE id = $1 AND business_id = $2', [req.params.pageId, req.business.id]);
    if (!rows[0]) return null;
    const linked = await pool.query('SELECT product_id FROM landing_page_products WHERE landing_page_id = $1', [rows[0].id]);
    return { ...rows[0], productIds: linked.rows.map((r) => String(r.product_id)) };
  }

  // Saves a page and its product links in one transaction. Only this business's products can be linked.
  async function savePage(businessId, page, id = null) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      let pageId = id;
      if (id) {
        await client.query(
          'UPDATE landing_pages SET name = $1, slug = $2, url = $3, status = $4, notes = $5, updated_at = now() WHERE id = $6 AND business_id = $7',
          [page.name, page.slug, page.url, page.status, page.notes, id, businessId],
        );
        await client.query('DELETE FROM landing_page_products WHERE landing_page_id = $1', [id]);
      } else {
        const { rows } = await client.query(
          'INSERT INTO landing_pages (business_id, name, slug, url, status, notes) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
          [businessId, page.name, page.slug, page.url, page.status, page.notes],
        );
        pageId = rows[0].id;
      }
      await client.query(
        `INSERT INTO landing_page_products (landing_page_id, product_id)
         SELECT $1, id FROM products WHERE business_id = $2 AND id = ANY($3::bigint[])`,
        [pageId, businessId, page.productIds],
      );
      await client.query('COMMIT');
      return pageId;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async function uniqueSlug(base) {
    for (let n = 0; n < 50; n += 1) {
      const candidate = n === 0 ? base : `${base.slice(0, 55)}-${n + 1}`;
      const { rows } = await pool.query('SELECT 1 FROM landing_pages WHERE slug = $1', [candidate]);
      if (!rows[0]) return candidate;
    }
    throw new Error('Could not find a free form key');
  }

  router.get('/', asyncHandler(async (req, res) => {
    const { rows } = await pool.query(
      `SELECT lp.*,
              (SELECT count(*)::int FROM orders o WHERE o.landing_page_id = lp.id) AS order_count,
              (SELECT string_agg(p.name, ', ' ORDER BY p.sort_order, p.id) FROM landing_page_products x
                 JOIN products p ON p.id = x.product_id WHERE x.landing_page_id = lp.id) AS product_names
         FROM landing_pages lp WHERE lp.business_id = $1 ORDER BY lp.status = 'archived', lp.created_at`,
      [req.business.id],
    );
    res.render('landing-pages', { pages: rows, error: req.query.error ?? null });
  }));

  router.get('/new', asyncHandler(async (req, res) => {
    res.render('landing-page-form', {
      page: { name: '', slug: '', url: '', status: 'draft', notes: '', productIds: [] },
      products: await products(req.business.id), error: null, statuses: LANDING_PAGE_STATUSES,
    });
  }));

  router.post('/', asyncHandler(async (req, res) => {
    const page = readPage(req.body);
    const renderError = async (msg, status) => res.status(status).render('landing-page-form', {
      page, products: await products(req.business.id), error: msg, statuses: LANDING_PAGE_STATUSES,
    });
    if (page.errors.length) return renderError(page.errors.join(' '), 400);
    try {
      await savePage(req.business.id, page);
    } catch (err) {
      if (err.code === '23505') return renderError(`The form key "${page.slug}" is already used.`, 409);
      throw err;
    }
    res.redirect(`${res.locals.base}/landing-pages`);
  }));

  router.post('/import', asyncHandler(async (req, res) => {
    let data;
    try {
      data = JSON.parse(String(req.body.json ?? ''));
    } catch {
      return res.redirect(`${res.locals.base}/landing-pages?error=${encodeURIComponent('Import file is not valid JSON.')}`);
    }
    if (data?.format !== 'skyfly.landing-page.v1') {
      return res.redirect(`${res.locals.base}/landing-pages?error=${encodeURIComponent('Not a Skyfly landing page export.')}`);
    }
    const codes = Array.isArray(data.products) ? data.products.map(String) : [];
    const { rows } = await pool.query('SELECT id FROM products WHERE business_id = $1 AND code = ANY($2::text[])', [req.business.id, codes]);
    const page = readPage({
      name: data.name, url: data.url, notes: data.notes, status: 'draft', products: rows.map((r) => String(r.id)),
    });
    if (page.errors.length) return res.redirect(`${res.locals.base}/landing-pages?error=${encodeURIComponent(page.errors.join(' '))}`);
    page.slug = await uniqueSlug(slugify(data.slug || page.name));
    await savePage(req.business.id, page);
    res.redirect(`${res.locals.base}/landing-pages`);
  }));

  router.get('/:pageId', asyncHandler(async (req, res) => {
    const page = await loadPage(req);
    if (!page) return res.status(404).render('error', { message: 'Landing page not found.' });
    res.render('landing-page-form', { page, products: await products(req.business.id), error: null, statuses: LANDING_PAGE_STATUSES });
  }));

  router.post('/:pageId', asyncHandler(async (req, res) => {
    const existing = await loadPage(req);
    if (!existing) return res.status(404).render('error', { message: 'Landing page not found.' });
    const page = { ...readPage(req.body), id: existing.id };
    const renderError = async (msg, status) => res.status(status).render('landing-page-form', {
      page, products: await products(req.business.id), error: msg, statuses: LANDING_PAGE_STATUSES,
    });
    if (page.errors.length) return renderError(page.errors.join(' '), 400);
    try {
      await savePage(req.business.id, page, existing.id);
    } catch (err) {
      if (err.code === '23505') return renderError(`The form key "${page.slug}" is already used.`, 409);
      throw err;
    }
    res.redirect(`${res.locals.base}/landing-pages`);
  }));

  router.post('/:pageId/duplicate', asyncHandler(async (req, res) => {
    const page = await loadPage(req);
    if (!page) return res.status(404).render('error', { message: 'Landing page not found.' });
    const slug = await uniqueSlug(`${page.slug.slice(0, 52)}-copy`);
    await savePage(req.business.id, { ...page, name: `${page.name} (copy)`.slice(0, 200), slug, status: 'draft' });
    res.redirect(`${res.locals.base}/landing-pages`);
  }));

  // Exports the page's Skyfly settings (not the page's HTML, which lives on its own host).
  router.get('/:pageId/export.json', asyncHandler(async (req, res) => {
    const page = await loadPage(req);
    if (!page) return res.status(404).render('error', { message: 'Landing page not found.' });
    const { rows } = await pool.query(
      `SELECT p.code FROM landing_page_products x JOIN products p ON p.id = x.product_id
        WHERE x.landing_page_id = $1 ORDER BY p.sort_order, p.id`,
      [page.id],
    );
    res.set('Content-Disposition', `attachment; filename="landing-page-${page.slug}.json"`);
    res.json({
      format: 'skyfly.landing-page.v1',
      name: page.name, slug: page.slug, url: page.url, notes: page.notes, products: rows.map((r) => r.code),
    });
  }));

  // Mobile-sized preview of the live page in an iframe.
  router.get('/:pageId/preview', asyncHandler(async (req, res) => {
    const page = await loadPage(req);
    if (!page || !page.url) return res.status(404).render('error', { message: 'This landing page has no URL to preview.' });
    const origin = new URL(page.url).origin;
    res.set('Content-Security-Policy', `default-src 'self'; style-src 'self' 'unsafe-inline'; frame-src ${origin}`);
    res.render('landing-page-preview', { page });
  }));

  return router;
}
