// Serves hosted landing pages. Runs only for requests on the pages host or a
// custom domain, never the dashboard host, so page scripts cannot read
// dashboard cookies or data (different origin). No dashboard CSP is applied,
// which keeps imported pages working as they were designed.
import { createHash } from 'node:crypto';
import { Router } from 'express';
import { asyncHandler } from '../lib/http.js';
import { readFile } from './storage.js';
import { verifyPreviewToken } from './preview.js';
import { isHtml } from './files.js';
import { optimizeCss } from './speed.js';
import { subdomainOf } from '../services/subdomains.js';

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,59}$/;

function decodePath(raw) {
  try {
    const p = decodeURIComponent(raw);
    return p.includes('\0') ? null : p;
  } catch {
    return null;
  }
}

function notFound(res, message = 'Page not found') {
  res.status(404).type('text/plain').set('Cache-Control', 'no-store').send(message);
}

// Preview of any version on the dashboard's own address, isolated by the browser sandbox
// (no same-origin access: the page's scripts can't read the dashboard or its cookies).
// Works without a separate pages domain. Ordering and tracking are off in previews.
export function sandboxPreview({ pool, config, transformHtml = null }) {
  const router = Router();
  const send = makeSender(pool, transformHtml);
  router.get(/^\/_sandbox\/(\d+)\/([^/]+)(\/.*)?$/, asyncHandler(async (req, res) => {
    const versionId = Number(req.params[0]);
    if (!verifyPreviewToken(config.sessionSecret, versionId, req.params[1])) return notFound(res, 'This preview link has expired. Open a new preview from the dashboard.');
    if (req.params[2] === undefined) return res.redirect(301, `${req.path}/`);
    const { rows: [page] } = await pool.query(
      'SELECT lp.id, lp.slug, lp.business_id FROM page_versions v JOIN landing_pages lp ON lp.id = v.landing_page_id WHERE v.id = $1', [versionId]);
    if (!page) return notFound(res);
    res.set('Content-Security-Policy', "sandbox allow-scripts allow-forms allow-popups allow-modals; frame-ancestors 'self'");
    res.set('Cross-Origin-Resource-Policy', 'same-origin');
    await send(req, res, { page, versionId, rest: req.params[2], preview: true });
  }));
  return router;
}

function makeSender(pool, transformHtml) {
  return async function send(req, res, { page, versionId, rest, preview }) {
    const { rows: [version] } = await pool.query('SELECT entry_path FROM page_versions WHERE id = $1', [versionId]);
    if (!version) return notFound(res);
    let filePath = decodePath(rest);
    if (filePath === null) return notFound(res);
    if (filePath === '' || filePath === '/') filePath = version.entry_path;
    else if (filePath.endsWith('/')) filePath = `${filePath}index.html`;
    filePath = filePath.replace(/^\/+/, '');

    const file = await readFile(pool, versionId, filePath);
    if (!file) return notFound(res);

    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
    if (preview) res.set('X-Robots-Tag', 'noindex');

    let body = file.data;
    let etag = `"${file.sha256.slice(0, 32)}"`;
    // "?v=<this version>" URLs (written into the served HTML) never change content: cache for a year.
    const pinned = req.query.v === String(versionId);
    if (isHtml(filePath)) {
      res.set('Cache-Control', preview ? 'no-store' : 'no-cache');
      if (transformHtml) {
        const html = await transformHtml(body.toString('utf8'), { page, preview, filePath, versionId });
        body = Buffer.from(html);
        etag = `W/"${createHash('sha1').update(body).digest('hex').slice(0, 24)}"`;
      }
    } else {
      res.set('Cache-Control', pinned ? 'public, max-age=31536000, immutable' : 'public, max-age=300');
      if (pinned && /^text\/css/.test(file.contentType)) {
        body = Buffer.from(optimizeCss(body.toString('utf8'), versionId));
        etag = `W/"${file.sha256.slice(0, 24)}-${versionId}"`;
      }
    }
    res.set('ETag', etag);
    if (req.headers['if-none-match'] === etag) return res.status(304).end();
    res.type(file.contentType).send(body);
  };
}

// Published pages on the Skyfly address itself: <publicBaseUrl>/p/<slug>/...
// Used when there is no separate pages address. The page runs in a browser sandbox (an
// opaque origin), so its scripts cannot read the dashboard, its cookies or other pages'
// storage, even though it shares the address. Orders reach Skyfly with "Origin: null".
export function pathPages({ pool, transformHtml = null }) {
  const router = Router();
  const send = makeSender(pool, transformHtml);
  router.get(/^\/p\/([^/]+)(\/.*)?$/, asyncHandler(async (req, res) => {
    const slug = req.params[0];
    if (!SLUG_RE.test(slug)) return notFound(res);
    if (req.params[1] === undefined) return res.redirect(301, `/p/${slug}/`);
    const { rows: [page] } = await pool.query(
      'SELECT id, slug, business_id, status, published_version_id FROM landing_pages WHERE slug = $1', [slug]);
    if (!page || page.status !== 'active' || !page.published_version_id) return notFound(res);
    res.set('Content-Security-Policy', 'sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads');
    // Files are loaded by the sandboxed (cross-origin) page.
    res.set('Cross-Origin-Resource-Policy', 'cross-origin');
    res.set('Access-Control-Allow-Origin', '*');
    await send(req, res, { page, versionId: page.published_version_id, rest: req.params[1], preview: false });
  }));
  return router;
}

export function pageServer({ pool, config, transformHtml = null }) {
  const router = Router();
  const send = makeSender(pool, transformHtml);
  // Looked up on every request (one indexed query) so unpublishing takes effect immediately.
  async function pageByDomain(host) {
    const { rows: [page] } = await pool.query(
      'SELECT id, slug, business_id, status, published_version_id FROM landing_pages WHERE custom_domain = $1', [host],
    );
    return page ?? null;
  }


  // Signed preview of any version: /_preview/<versionId>/<token>/...
  router.get(/^\/_preview\/(\d+)\/([^/]+)(\/.*)?$/, asyncHandler(async (req, res) => {
    const versionId = Number(req.params[0]);
    if (!verifyPreviewToken(config.sessionSecret, versionId, req.params[1])) return notFound(res, 'This preview link has expired. Open a new preview from the dashboard.');
    if (req.params[2] === undefined) return res.redirect(301, `${req.path}/`);
    const { rows: [page] } = await pool.query(
      'SELECT lp.id, lp.slug, lp.business_id FROM page_versions v JOIN landing_pages lp ON lp.id = v.landing_page_id WHERE v.id = $1', [versionId],
    );
    if (!page) return notFound(res);
    await send(req, res, { page, versionId, rest: req.params[2], preview: true });
  }));

  router.get('*', asyncHandler(async (req, res) => {
    const host = req.hostname.toLowerCase();

    // Business subdomain: <sub>.<PLATFORM_DOMAIN>/<page-slug>/ serves only that business's pages.
    const sub = host === config.pagesHost ? null : subdomainOf(host, config);
    if (sub) {
      const { rows: [b] } = await pool.query('SELECT id FROM businesses WHERE subdomain = $1', [sub]);
      if (!b) return notFound(res, 'Site not found');
      const m = req.path.match(/^\/([^/]+)(\/.*)?$/);
      if (!m) {
        // The root opens the business's only (or first) published page.
        const { rows: [first] } = await pool.query(
          "SELECT slug FROM landing_pages WHERE business_id = $1 AND status = 'active' AND published_version_id IS NOT NULL ORDER BY id LIMIT 1", [b.id]);
        return first ? res.redirect(302, `/${first.slug}/`) : notFound(res);
      }
      if (!SLUG_RE.test(m[1])) return notFound(res);
      if (m[2] === undefined) return res.redirect(301, `/${m[1]}/`);
      const { rows: [page] } = await pool.query(
        'SELECT id, slug, business_id, status, published_version_id FROM landing_pages WHERE slug = $1 AND business_id = $2', [m[1], b.id]);
      if (!page || page.status !== 'active' || !page.published_version_id) return notFound(res);
      return send(req, res, { page, versionId: page.published_version_id, rest: m[2], preview: false });
    }

    const custom = host === config.pagesHost ? null : await pageByDomain(host);

    if (custom) {
      if (custom.status !== 'active' || !custom.published_version_id) return notFound(res);
      return send(req, res, { page: custom, versionId: custom.published_version_id, rest: req.path, preview: false });
    }
    if (host !== config.pagesHost) return notFound(res, 'Site not found');

    // Pages host: /<slug>/...
    const match = req.path.match(/^\/([^/]+)(\/.*)?$/);
    if (!match || !SLUG_RE.test(match[1])) return notFound(res);
    if (match[2] === undefined) return res.redirect(301, `/${match[1]}/`);
    const { rows: [page] } = await pool.query(
      'SELECT id, slug, business_id, status, published_version_id FROM landing_pages WHERE slug = $1', [match[1]],
    );
    if (!page || page.status !== 'active' || !page.published_version_id) return notFound(res);
    await send(req, res, { page, versionId: page.published_version_id, rest: match[2], preview: false });
  }));

  router.all('*', (req, res) => res.status(405).type('text/plain').send('Method not allowed'));
  return router;
}
