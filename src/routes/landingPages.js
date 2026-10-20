import { Router } from 'express';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { analyzeFiles } from '../hosting/report.js';
import { asyncHandler } from '../lib/http.js';
import { slugify } from '../lib/auth.js';
import { LANDING_PAGE_STATUSES } from '../lib/statuses.js';
import multer from 'multer';
import { audit } from '../lib/audit.js';
import { requireCsrf } from '../lib/csrf.js';
import { clearOriginCache } from '../lib/origins.js';
import { importUpload, ImportError } from '../hosting/importer.js';
import { saveVersion, readFile } from '../hosting/storage.js';
import { detectCheckout, FIELD_LABELS } from '../hosting/adapter.js';
import { validateVersion, publishVersion, checkLive, businessCatalogue } from '../hosting/validate.js';
import { connectVersion, needsAnswers } from '../hosting/connect.js';
import { LIMITS } from '../hosting/files.js';
import { optimizeVersion } from '../hosting/images.js';
import { previewToken } from '../hosting/preview.js';
import { domainReadiness, normalizeDomain } from '../hosting/domains.js';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: LIMITS.uploadBytes, files: 1, fields: 10 } });

// Parses one uploaded file, then checks the CSRF token (which arrives in the multipart body).
function receiveFile(req, res, next) {
  upload.single('file')(req, res, (err) => {
    if (err) {
      req.uploadError = err.code === 'LIMIT_FILE_SIZE'
        ? `The file is larger than ${LIMITS.uploadBytes / 1024 / 1024} MB.`
        : 'The upload could not be read. Try again.';
      req.body = req.body || {};
    }
    requireCsrf(req, res, next);
  });
}

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

// Where a published page opens: the pages address when one is configured, else a stable
// path on the Skyfly address (served in a browser sandbox, see hosting/server.js).
const TEMPLATE_FILES = [['index.html', 'text/html; charset=utf-8'], ['style.css', 'text/css; charset=utf-8'], ['hero.jpg', 'image/jpeg'],
  ['product-1.jpg', 'image/jpeg'], ['product-2.jpg', 'image/jpeg'], ['product-3.jpg', 'image/jpeg']];
const escapeHtml = (v) => String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function publishedUrl(config, page) {
  if (config.pagesBaseUrl) return `${config.pagesBaseUrl}/${page.slug}/`;
  return config.publicBaseUrl ? `${config.publicBaseUrl}/p/${page.slug}/` : null;
}

function readPage(body) {
  const name = String(body.name ?? '').trim().slice(0, 200);
  const slug = slugify(String(body.slug ?? '') || name);
  const url = safeUrl(body.url);
  const status = LANDING_PAGE_STATUSES.includes(body.status) ? body.status : 'draft';
  const notes = String(body.notes ?? '').trim().slice(0, 2000) || null;
  const productIds = [].concat(body.products ?? []).filter((id) => /^\d+$/.test(id));
  const testMode = body.test_mode === 'on';
  // Optional upsell: one of the business's products, offered with an "Add" button at checkout.
  const upsellProductId = /^\d+$/.test(String(body.upsell_product_id ?? '')) ? String(body.upsell_product_id) : null;
  const upsellHeadline = String(body.upsell_headline ?? '').trim().slice(0, 120) || null;
  const upsellText = String(body.upsell_text ?? '').trim().slice(0, 400) || null;
  const errors = [];
  if (!name) errors.push('Name is required.');
  if (!slug) errors.push('Form key is required.');
  if (url === undefined) errors.push('Enter a valid http(s) URL.');
  if (upsellProductId && productIds.includes(upsellProductId)) errors.push('The upsell must be a different product from the packages on the page.');
  return { name, slug, url: url ?? null, status, notes, productIds, testMode, upsellProductId, upsellHeadline, upsellText, errors };
}

export function landingPageRoutes({ pool, config }) {
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
          'UPDATE landing_pages SET name = $1, slug = $2, url = $3, status = $4, notes = $5, test_mode = $8, updated_at = now() WHERE id = $6 AND business_id = $7',
          [page.name, page.slug, page.url, page.status, page.notes, id, businessId, page.testMode === true],
        );
        // Only one of this business's own products can be the upsell.
        await client.query(
          `UPDATE landing_pages SET upsell_product_id = (SELECT id FROM products WHERE id = $2::bigint AND business_id = $3),
                  upsell_headline = $4, upsell_text = $5 WHERE id = $1`,
          [id, page.upsellProductId ?? null, businessId, page.upsellHeadline ?? null, page.upsellText ?? null],
        );
        await client.query('DELETE FROM landing_page_products WHERE landing_page_id = $1', [id]);
      } else {
        const { rows } = await client.query(
          'INSERT INTO landing_pages (business_id, name, slug, url, status, notes, test_mode) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id',
          [businessId, page.name, page.slug, page.url, page.status, page.notes, page.testMode === true],
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
              (SELECT count(*)::int FROM orders o WHERE o.landing_page_id = lp.id AND NOT o.is_test) AS order_count,
              coalesce((SELECT (v.report->>'connected')::boolean FROM page_versions v WHERE v.landing_page_id = lp.id ORDER BY v.id DESC LIMIT 1), false) AS code_detected,
              (SELECT string_agg(p.name, ', ' ORDER BY p.sort_order, p.id) FROM landing_page_products x
                 JOIN products p ON p.id = x.product_id WHERE x.landing_page_id = lp.id) AS product_names,
              (SELECT name FROM sheet_connections sc WHERE sc.business_id = lp.business_id
                  AND sc.id = coalesce(lp.sheet_connection_id, b.default_sheet_connection_id)) AS sheet_name
         FROM landing_pages lp JOIN businesses b ON b.id = lp.business_id WHERE lp.business_id = $1 ORDER BY lp.status = 'archived', lp.created_at`,
      [req.business.id],
    );
    // The exact public address of each published page, so nobody has to guess it from the form key.
    for (const p of rows) {
      const live = p.status === 'active' && p.published_version_id;
      p.public_url = live ? (p.custom_domain && p.domain_status?.startsWith('ok') ? `https://${p.custom_domain}/` : publishedUrl(config, p)) : null;
    }
    res.render('landing-pages', { pages: rows, error: req.query.error ?? null });
  }));

  router.get('/new', asyncHandler(async (req, res) => {
    res.render('landing-page-form', {
      page: { name: '', slug: '', url: '', status: 'draft', notes: '', productIds: [] },
      products: await products(req.business.id), error: null, notice: null, statuses: LANDING_PAGE_STATUSES, hosting: null,
    });
  }));

  router.post('/', asyncHandler(async (req, res) => {
    const page = readPage(req.body);
    const renderError = async (msg, status) => res.status(status).render('landing-page-form', {
      page, products: await products(req.business.id), error: msg, notice: null, statuses: LANDING_PAGE_STATUSES, hosting: null,
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

  async function renderPage(req, res, page, { error = null, notice = null, status = 200, validationFor = null } = {}) {
    const { rows: versions } = await pool.query(
      `SELECT id, source_name, entry_path, file_count, total_bytes, report, created_at FROM page_versions
        WHERE landing_page_id = $1 ORDER BY id DESC LIMIT 10`,
      [page.id],
    );
    const hosting = {
      enabled: Boolean(config.pagesBaseUrl || config.publicBaseUrl),
      pathHosting: !config.pagesBaseUrl,
      versions: versions.map((v) => ({
        ...v,
        previewUrl: config.pagesBaseUrl ? `${config.pagesBaseUrl}/_preview/${v.id}/${previewToken(config.sessionSecret, v.id)}/` : null,
      })),
      publishedUrl: page.published_version_id ? publishedUrl(config, page) : null,
      domainUrl: page.custom_domain ? `https://${page.custom_domain}/` : null,
      cnameTarget: config.renderHost || (config.publicBaseUrl ? new URL(config.publicBaseUrl).hostname : ''),
      apiBase: config.publicBaseUrl || '',
    };
    const { rows: [sheet] } = await pool.query(
      `SELECT sc.name, lp.sheet_connection_id IS NOT NULL AS own FROM landing_pages lp JOIN businesses b ON b.id = lp.business_id
         JOIN sheet_connections sc ON sc.business_id = lp.business_id AND sc.id = coalesce(lp.sheet_connection_id, b.default_sheet_connection_id)
        WHERE lp.id = $1`, [page.id]);
    // Import → products → checkout → preview → checks → publish, for the latest version (or the one just refused).
    const current = await pool.query('SELECT * FROM landing_pages WHERE id = $1', [page.id]).then((r) => ({ ...page, ...r.rows[0] }));
    let workflow = null;
    const target = versions.find((v) => v.id === Number(validationFor)) ?? versions[0];
    if (target) {
      const catalogue = await businessCatalogue(pool, req.business.id);
      const html = (await readFile(pool, target.id, target.entry_path))?.data.toString('utf8') ?? '';
      const detected = detectCheckout(html, catalogue);
      const validation = await validateVersion(pool, config, current, target.id);
      const check = (k) => validation.checks.find((c) => c.key === k)?.status;
      // Publish can connect the checkout itself (every match confident) when that is all that blocks it.
      const blockedKeys = validation.checks.filter((c) => c.status === 'BLOCKED').map((c) => c.key);
      const autoConnect = validation.blocked && check('checkout') === 'BLOCKED' && blockedKeys.every((k) => ['checkout', 'products'].includes(k))
        && !needsAnswers(detected).any && (detected.candidates.length > 0 || check('products') !== 'BLOCKED');
      workflow = {
        version: target, detected, validation, catalogue, fieldLabels: FIELD_LABELS, autoConnect,
        steps: [
          { n: 1, label: 'Import', done: true },
          { n: 2, label: 'Products', done: check('products') === 'PASS' },
          { n: 3, label: 'Checkout', done: ['PASS', 'WARNING'].includes(check('checkout')) && check('mapping') !== 'BLOCKED' && check('fields') !== 'BLOCKED' },
          { n: 4, label: 'Preview', done: true },
          { n: 5, label: 'Checks', done: !validation.blocked },
          { n: 6, label: 'Publish', done: current.status === 'active' && Number(current.published_version_id) === target.id },
        ],
      };
    }
    res.set('Cache-Control', 'no-store');
    res.status(status).render('landing-page-form', {
      page: current, products: await products(req.business.id), error, notice, statuses: LANDING_PAGE_STATUSES, hosting, sheet: sheet ?? null, workflow,
    });
  }

  router.get('/:pageId', asyncHandler(async (req, res) => {
    const page = await loadPage(req);
    if (!page) return res.status(404).render('error', { message: 'Landing page not found.' });
    const notice = { edited: 'Your changes were saved as a new version (the previous version is unchanged). Preview it below.', uploaded: 'New version uploaded. Preview it, then publish.', template: 'Page created from the starter template with your products and Skyfly checkout. Edit its text and images (Edit), preview it, then publish.', published: 'Published.', published_connected: 'Checkout connected to Skyfly automatically (new version) and published.', unpublished: 'Unpublished. The page is offline.', domain: 'Domain saved.', checkout: 'Skyfly checkout added as a new version. Preview it, then publish.', connected: 'Checkout connected as a new version: the page now saves orders in Skyfly. Preview it, check the results below, then publish.' }[req.query.done] ?? null;
    const error = typeof req.query.error === 'string' ? req.query.error.slice(0, 300) : null;
    await renderPage(req, res, page, { notice, error });
  }));

  // A new page from Skyfly's starter template (Skyfly checkout included), with all of the
  // business's products connected; edit its text, images and colours, then publish.
  router.post('/template', asyncHandler(async (req, res) => {
    const name = String(req.body.name ?? '').trim().slice(0, 200) || `${req.business.name} page`;
    const files = TEMPLATE_FILES.map(([file, contentType]) => {
      let data = readFileSync(new URL(`../templates/product/${file}`, import.meta.url));
      if (file === 'index.html') data = Buffer.from(data.toString('utf8').replaceAll('{{BUSINESS}}', escapeHtml(req.business.name)));
      return { path: file, contentType, size: data.length, sha256: createHash('sha256').update(data).digest('hex'), data };
    });
    const slug = await uniqueSlug(slugify(name) || 'page');
    const { rows: all } = await pool.query('SELECT id FROM products WHERE business_id = $1 AND active ORDER BY sort_order, id', [req.business.id]);
    const pageId = await savePage(req.business.id, { name, slug, url: null, status: 'draft', notes: null, productIds: all.map((p) => String(p.id)) });
    const versionId = await saveVersion(pool, { pageId, userId: req.session.userId, upload: {
      sourceName: 'Skyfly starter template', entryPath: 'index.html', files, totalBytes: files.reduce((n, f) => n + f.size, 0), report: analyzeFiles(files, 'index.html'),
    } });
    await audit(pool, req, { action: 'page.created_from_template', businessId: req.business.id, entityType: 'landing_page', entityId: pageId, details: { versionId } });
    res.redirect(`${res.locals.base}/landing-pages/${pageId}?done=template`);
  }));

  // Import a new page from a ZIP or HTML file (creates the page record too).
  router.post('/upload', receiveFile, asyncHandler(async (req, res) => {
    const fail = (message, problems = []) => res.redirect(`${res.locals.base}/landing-pages?error=${encodeURIComponent([message, ...problems.slice(0, 5)].join(' • '))}`);
    if (req.uploadError) return fail(req.uploadError);
    const name = String(req.body.name ?? '').trim().slice(0, 200) || String(req.file?.originalname ?? 'Imported page').replace(/\.(zip|html?)$/i, '');
    let imported;
    try {
      imported = await importUpload(req.file);
    } catch (err) {
      if (err instanceof ImportError) return fail(err.message, err.problems);
      throw err;
    }
    const slug = await uniqueSlug(slugify(name) || 'page');
    const pageId = await savePage(req.business.id, { name, slug, url: null, status: 'draft', notes: null, productIds: [] });
    const versionId = await saveVersion(pool, { pageId, userId: req.session.userId, upload: imported });
    await audit(pool, req, { action: 'page.imported', businessId: req.business.id, entityType: 'landing_page', entityId: pageId, details: { versionId, file: imported.sourceName, files: imported.files.length } });
    res.redirect(`${res.locals.base}/landing-pages/${pageId}?done=uploaded`);
  }));

  // Upload a new version of an existing page.
  router.post('/:pageId/upload', receiveFile, asyncHandler(async (req, res) => {
    const page = await loadPage(req);
    if (!page) return res.status(404).render('error', { message: 'Landing page not found.' });
    if (req.uploadError) return renderPage(req, res, page, { error: req.uploadError, status: 400 });
    let imported;
    try {
      imported = await importUpload(req.file);
    } catch (err) {
      if (err instanceof ImportError) return renderPage(req, res, page, { error: [err.message, ...err.problems.slice(0, 10)].join(' • '), status: 400 });
      throw err;
    }
    const versionId = await saveVersion(pool, { pageId: page.id, userId: req.session.userId, upload: imported });
    await audit(pool, req, { action: 'page.version_uploaded', businessId: req.business.id, entityType: 'landing_page', entityId: page.id, details: { versionId, file: imported.sourceName } });
    res.redirect(`${res.locals.base}/landing-pages/${page.id}?done=uploaded`);
  }));

  router.post('/:pageId/publish', asyncHandler(async (req, res) => {
    const page = await loadPage(req);
    if (!page) return res.status(404).render('error', { message: 'Landing page not found.' });
    const versionId = Number(req.body.version_id);
    const { rows: [version] } = await pool.query('SELECT id FROM page_versions WHERE id = $1 AND landing_page_id = $2', [versionId, page.id]);
    if (!version) return renderPage(req, res, page, { error: 'Choose a version to publish.', status: 400 });
    // Server-side checks first: a version customers could not order from is not published.
    let validation = await validateVersion(pool, config, page, version.id);
    let autoConnected = false;
    if (validation.blocked && validation.checks.find((c) => c.key === 'checkout')?.status === 'BLOCKED') {
      // Not connected yet: Publish connects the checkout itself when every product and field was matched confidently.
      const { rows: [full] } = await pool.query('SELECT id, entry_path, source_name FROM page_versions WHERE id = $1', [version.id]);
      const connected = await connectVersion(pool, { page, version: full, userId: req.session.userId, onlyIfConfident: true });
      if (connected?.needsAnswers) {
        return renderPage(req, res, page, { error: 'Not published yet: some products or form fields on this page need your answer. Choose them in step 3, click "Connect checkout automatically", then publish.', status: 400, validationFor: version.id });
      }
      if (connected?.versionId) {
        version.id = connected.versionId;
        autoConnected = true;
        await audit(pool, req, { action: 'page.checkout_connected', businessId: req.business.id, entityType: 'landing_page', entityId: page.id, details: { from: full.id, versionId: version.id, changes: connected.changes.slice(0, 20), automatic: true } });
        validation = await validateVersion(pool, config, { ...page, ...(await pool.query('SELECT * FROM landing_pages WHERE id = $1', [page.id])).rows[0] }, version.id);
        if (validation.blocked) {
          // Still not publishable: the automatic version is not kept (nothing changes until the owner fixes the rest).
          await pool.query('DELETE FROM page_versions WHERE id = $1 AND landing_page_id = $2', [version.id, page.id]);
          version.id = full.id;
          autoConnected = false;
        }
      }
    }
    if (validation.blocked) {
      const why = validation.checks.filter((c) => c.status === 'BLOCKED').map((c) => `${c.label}: ${c.message}`).join(' • ');
      return renderPage(req, res, page, { error: `Not published. ${why}`, status: 400, validationFor: version.id });
    }
    // A different version may have a different form, so its connection must be proven again.
    await publishVersion(pool, page, version.id);
    // WebP sizes for the page's images, in the background (the page is live either way).
    optimizeVersion(pool, version.id).catch((err) => console.error('Image optimization failed:', err.message));
    clearOriginCache();
    await audit(pool, req, { action: 'page.published', businessId: req.business.id, entityType: 'landing_page', entityId: page.id, details: { versionId: version.id } });
    // The address is only shown as live once Skyfly has opened it like a visitor would.
    if (config.liveCheck !== false) await checkLive(pool, config, page).catch(() => null);
    res.redirect(`${res.locals.base}/landing-pages/${page.id}?done=${autoConnected ? 'published_connected' : 'published'}`);
  }));

  router.post('/:pageId/check-live', asyncHandler(async (req, res) => {
    const page = await loadPage(req);
    if (!page) return res.status(404).render('error', { message: 'Landing page not found.' });
    if (page.status === 'active' && page.published_version_id) await checkLive(pool, config, page);
    res.redirect(`${res.locals.base}/landing-pages/${page.id}#hosting`);
  }));

  router.post('/:pageId/unpublish', asyncHandler(async (req, res) => {
    const page = await loadPage(req);
    if (!page) return res.status(404).render('error', { message: 'Landing page not found.' });
    await pool.query("UPDATE landing_pages SET status = 'draft', updated_at = now() WHERE id = $1", [page.id]);
    clearOriginCache();
    await audit(pool, req, { action: 'page.unpublished', businessId: req.business.id, entityType: 'landing_page', entityId: page.id });
    res.redirect(`${res.locals.base}/landing-pages/${page.id}?done=unpublished`);
  }));

  router.post('/:pageId/domain', asyncHandler(async (req, res) => {
    const page = await loadPage(req);
    if (!page) return res.status(404).render('error', { message: 'Landing page not found.' });
    const domain = normalizeDomain(req.body.domain);
    const reserved = [config.publicBaseUrl, config.pagesBaseUrl].filter(Boolean).map((u) => new URL(u).hostname);
    if (domain === null || reserved.includes(domain) || (domain && domain.endsWith('.onrender.com'))) {
      return renderPage(req, res, page, { error: 'Enter a domain you own, like shop.example.com.', status: 400 });
    }
    try {
      await pool.query(
        'UPDATE landing_pages SET custom_domain = $1, domain_status = NULL, domain_checked_at = NULL, updated_at = now() WHERE id = $2',
        [domain || null, page.id],
      );
    } catch (err) {
      if (err.code === '23505') return renderPage(req, res, page, { error: 'That domain is already used by another page.', status: 409 });
      throw err;
    }
    clearOriginCache();
    await audit(pool, req, { action: 'page.domain_changed', businessId: req.business.id, entityType: 'landing_page', entityId: page.id, details: { domain: domain || null } });
    res.redirect(`${res.locals.base}/landing-pages/${page.id}?done=domain`);
  }));

  router.post('/:pageId/domain/check', asyncHandler(async (req, res) => {
    const page = await loadPage(req);
    if (!page?.custom_domain) return res.status(404).render('error', { message: 'No domain to check.' });
    const target = config.renderHost || new URL(config.publicBaseUrl || 'http://localhost').hostname;
    const result = await domainReadiness(page.custom_domain, target);
    await pool.query('UPDATE landing_pages SET domain_status = $1, domain_checked_at = now() WHERE id = $2', [`${result.ok ? 'ok' : 'not_ready'}: ${result.message}`, page.id]);
    res.redirect(`${res.locals.base}/landing-pages/${page.id}`);
  }));

  router.post('/:pageId', asyncHandler(async (req, res) => {
    const existing = await loadPage(req);
    if (!existing) return res.status(404).render('error', { message: 'Landing page not found.' });
    const page = { ...existing, ...readPage(req.body), id: existing.id };
    const renderError = (msg, status) => renderPage(req, res, page, { error: msg, status });
    if (page.errors.length) return renderError(page.errors.join(' '), 400);
    try {
      await savePage(req.business.id, page, existing.id);
    } catch (err) {
      if (err.code === '23505') return renderError(`The form key "${page.slug}" is already used.`, 409);
      throw err;
    }
    clearOriginCache();
    await audit(pool, req, { action: 'page.updated', businessId: req.business.id, entityType: 'landing_page', entityId: existing.id, details: { status: page.status, url: page.url } });
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
