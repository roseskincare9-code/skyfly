// Edit a hosted page version in the browser (text, title, prices, colours, images,
// sections) and preview versions on phone and desktop. Each save is a new version.
import { Router } from 'express';
import path from 'node:path';
import multer from 'multer';
import { asyncHandler } from '../lib/http.js';
import { audit } from '../lib/audit.js';
import { requireCsrf } from '../lib/csrf.js';
import { readFile } from '../hosting/storage.js';
import { previewToken } from '../hosting/preview.js';
import { analyzePage, applyChanges, EditError } from '../hosting/editor.js';
import { FIELD_LABELS } from '../hosting/adapter.js';
import { deriveVersion as deriveShared, connectVersion } from '../hosting/connect.js';
import { businessCatalogue } from '../hosting/validate.js';

const IMAGE_TYPES = { 'image/jpeg': [0xff, 0xd8], 'image/png': [0x89, 0x50], 'image/gif': [0x47, 0x49], 'image/webp': [0x52, 0x49] };
const images = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024, files: 30, fieldSize: 2 * 1024 * 1024, fields: 5000 } });

function receiveImages(req, res, next) {
  images.any()(req, res, (err) => {
    if (err) { req.uploadError = err.code === 'LIMIT_FILE_SIZE' ? 'Each image must be 15 MB or smaller.' : 'The form could not be read. Try again.'; req.body = req.body || {}; }
    requireCsrf(req, res, next);
  });
}

export function pageEditorRoutes({ pool, config }) {
  const router = Router({ mergeParams: true });

  async function load(req) {
    if (!/^\d+$/.test(req.params.pageId) || !/^\d+$/.test(req.params.versionId)) return null;
    const { rows: [v] } = await pool.query(
      `SELECT v.id, v.entry_path, v.created_at, v.source_name, lp.id AS page_id, lp.name AS page_name, lp.business_id, lp.slug
         FROM page_versions v JOIN landing_pages lp ON lp.id = v.landing_page_id
        WHERE v.id = $1 AND lp.id = $2 AND lp.business_id = $3`, [req.params.versionId, req.params.pageId, req.business.id]);
    return v ?? null;
  }
  const sandboxBase = (versionId) => `/_sandbox/${versionId}/${previewToken(config.sessionSecret, versionId)}/`;

  router.get('/:pageId/versions/:versionId/preview', asyncHandler(async (req, res) => {
    const v = await load(req);
    if (!v) return res.status(404).render('error', { message: 'Version not found.' });
    res.set('Cache-Control', 'no-store');
    res.render('page-preview', { active: 'pages', v, url: sandboxBase(v.id) });
  }));

  async function renderEditor(req, res, v, { error = null, status = 200 } = {}) {
    const file = await readFile(pool, v.id, v.entry_path);
    const html = file.data.toString('utf8');
    const a = analyzePage(html);
    const { rows: products } = await pool.query('SELECT code, name, price_minor FROM products WHERE business_id = $1', [req.business.id]);
    const byCode = new Map(products.map((p) => [p.code, p]));
    // Group visible texts under the section they belong to, for an easier form.
    const groups = a.sections.length
      ? [{ label: 'Top of the page', texts: [] }, ...a.sections.map((s) => ({ label: s.label, start: s.start, end: s.end, texts: [] })), { label: 'Bottom of the page', texts: [] }]
      : [{ label: 'Page text', texts: [] }];
    for (const t of a.texts) {
      const i = a.sections.findIndex((s) => t.start >= s.start && t.end <= s.end);
      const g = !a.sections.length ? groups[0] : i >= 0 ? groups[i + 1] : (t.start < a.sections[0].start ? groups[0] : groups.at(-1));
      g.texts.push(t);
    }
    res.set('Cache-Control', 'no-store');
    res.status(status).render('page-editor', {
      active: 'pages', v, a, groups: groups.filter((g) => g.texts.length), error,
      imageBase: sandboxBase(v.id), entryDir: path.posix.dirname(v.entry_path),
      prices: a.prices.map((p) => ({ ...p, skyfly: p.product && byCode.get(p.product) ? Number(byCode.get(p.product).price_minor) / 100 : null })),
    });
  }

  // New version from an existing one: unchanged files keep their stored content; changed ones are added.
  const deriveVersion = (v, entryHtml, replaced, sourceName, userId) => deriveShared(pool, v, entryHtml, replaced, sourceName, userId);

  // Adds Skyfly's drop-in checkout to a page that has no connected order form, as a new version.
  router.post('/:pageId/versions/:versionId/add-checkout', asyncHandler(async (req, res) => {
    const v = await load(req);
    if (!v) return res.status(404).render('error', { message: 'Version not found.' });
    const html = (await readFile(pool, v.id, v.entry_path)).data.toString('utf8');
    const base = `${res.locals.base}/landing-pages/${v.page_id}`;
    if (/data-skyfly-checkout/.test(html)) return res.redirect(`${base}?error=${encodeURIComponent('This version already has the Skyfly checkout.')}#report`);
    const section = '\n<section id="order" style="padding:32px 16px"><div data-skyfly-checkout></div></section>\n';
    const end = html.match(/<\/body\s*>/i);
    const updated = end ? html.slice(0, end.index) + section + html.slice(end.index) : html + section;
    const versionId = await deriveVersion(v, updated, new Map(), `Skyfly checkout added (from ${v.source_name})`, req.session.userId);
    await audit(pool, req, { action: 'page.checkout_added', businessId: req.business.id, entityType: 'landing_page', entityId: v.page_id, details: { from: v.id, versionId } });
    res.redirect(`${base}?done=checkout`);
  }));

  // Universal checkout adapter: connects the page's own order forms and purchase buttons to Skyfly
  // (with the product and field matches confirmed in the dashboard), as a new version.
  router.post('/:pageId/versions/:versionId/connect', asyncHandler(async (req, res) => {
    const v = await load(req);
    if (!v) return res.status(404).render('error', { message: 'Version not found.' });
    const base = `${res.locals.base}/landing-pages/${v.page_id}`;
    const catalogue = await businessCatalogue(pool, req.business.id);
    const mapping = { products: {}, fields: {} };
    for (const [k, val] of Object.entries(req.body ?? {})) {
      if (k.startsWith('product__')) mapping.products[k.slice(9)] = catalogue.some((p) => p.code === String(val)) ? String(val) : '';
      if (k.startsWith('field__')) mapping.fields[k.slice(7)] = Object.hasOwn(FIELD_LABELS, String(val)) ? String(val) : 'ignore';
    }
    const result = await connectVersion(pool, { page: { id: v.page_id, business_id: req.business.id, slug: v.slug }, version: v, userId: req.session.userId, mapping });
    if (!result) return res.redirect(`${base}?error=${encodeURIComponent('Nothing left to connect in this version: its checkout is already connected to Skyfly.')}#workflow`);
    const { versionId, changes } = result;
    await audit(pool, req, { action: 'page.checkout_connected', businessId: req.business.id, entityType: 'landing_page', entityId: v.page_id, details: { from: v.id, versionId, changes: changes.slice(0, 20) } });
    res.redirect(`${base}?done=connected#workflow`);
  }));

  router.get('/:pageId/versions/:versionId/edit', asyncHandler(async (req, res) => {
    const v = await load(req);
    if (!v) return res.status(404).render('error', { message: 'Version not found.' });
    await renderEditor(req, res, v);
  }));

  router.post('/:pageId/versions/:versionId/edit', receiveImages, asyncHandler(async (req, res) => {
    const v = await load(req);
    if (!v) return res.status(404).render('error', { message: 'Version not found.' });
    if (req.uploadError) return renderEditor(req, res, v, { error: req.uploadError, status: 400 });
    const b = req.body;
    const pick = (prefix) => Object.fromEntries(Object.entries(b).filter(([k]) => k.startsWith(prefix)).map(([k, val]) => [k.slice(prefix.length), String(val)]));
    const changes = {
      title: b.title, description: b.description, texts: pick('text_'), colors: pick('color_'), prices: pick('price_'),
      sections: { order: String(b.section_order ?? '').split(',').filter((x) => /^\d+$/.test(x)), remove: Object.keys(pick('remove_section_')) },
    };
    if (b.section_order_input) {
      // Order typed as position numbers next to each section.
      const pos = pick('position_');
      changes.sections.order = Object.keys(pos).sort((x, y) => Number(pos[x]) - Number(pos[y]) || Number(x) - Number(y));
    }

    const entry = await readFile(pool, v.id, v.entry_path);
    let result;
    try {
      result = applyChanges(entry.data.toString('utf8'), changes);
    } catch (err) {
      if (err instanceof EditError) return renderEditor(req, res, v, { error: err.message, status: 400 });
      throw err;
    }

    // Replacement images: same file path, new content.
    const a = analyzePage(entry.data.toString('utf8'));
    const replaced = new Map();
    for (const f of req.files ?? []) {
      const m = f.fieldname.match(/^image_(\d+)$/);
      const img = m && a.images[Number(m[1])];
      if (!img || !f.size) continue;
      const magic = IMAGE_TYPES[f.mimetype];
      if (!magic || f.buffer[0] !== magic[0] || f.buffer[1] !== magic[1]) return renderEditor(req, res, v, { error: `${f.originalname}: upload a JPG, PNG, GIF or WebP image.`, status: 400 });
      const p = path.posix.normalize(path.posix.join(path.posix.dirname(v.entry_path), decodeURI(img.src.split(/[?#]/)[0])));
      replaced.set(p, f.buffer);
      result.changed.push(`image ${p}`);
    }
    if (!result.changed.length) return renderEditor(req, res, v, { error: 'Nothing was changed.', status: 400 });

    const versionId = await deriveVersion(v, result.html, replaced, `Edited in Skyfly (from ${v.source_name})`, req.session.userId);

    // Optionally keep Skyfly's product prices in step with the page.
    if (b.update_product_prices === 'on') {
      for (const [id, value] of Object.entries(changes.prices)) {
        const p = a.prices[Number(id)];
        const price = Number(String(value).replace(/[,\s₦£$€]/g, ''));
        if (p?.product && Number.isFinite(price) && String(price) !== p.value) {
          await pool.query('UPDATE products SET price_minor = $1, updated_at = now() WHERE business_id = $2 AND code = $3', [Math.round(price * 100), req.business.id, p.product]);
        }
      }
    }
    await audit(pool, req, { action: 'page.edited', businessId: req.business.id, entityType: 'landing_page', entityId: v.page_id, details: { fromVersion: v.id, versionId, changed: result.changed.slice(0, 50) } });
    res.redirect(`${res.locals.base}/landing-pages/${v.page_id}?done=edited&version=${versionId}`);
  }));

  return router;
}
