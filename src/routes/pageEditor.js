// Edit a hosted page version in the browser (text, title, prices, colours, images,
// sections) and preview versions on phone and desktop. Each save is a new version.
import { Router } from 'express';
import { createHash } from 'node:crypto';
import path from 'node:path';
import multer from 'multer';
import { asyncHandler } from '../lib/http.js';
import { audit } from '../lib/audit.js';
import { requireCsrf } from '../lib/csrf.js';
import { readFile, saveVersion } from '../hosting/storage.js';
import { previewToken } from '../hosting/preview.js';
import { analyzeFiles } from '../hosting/report.js';
import { analyzePage, applyChanges, EditError } from '../hosting/editor.js';

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
      `SELECT v.id, v.entry_path, v.created_at, v.source_name, lp.id AS page_id, lp.name AS page_name, lp.business_id
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

    // New version: unchanged files keep their stored content; changed ones are added.
    const { rows: files } = await pool.query('SELECT path, content_type, size, sha256 FROM page_files WHERE version_id = $1 ORDER BY path', [v.id]);
    const newFiles = [];
    for (const f of files) {
      let data = null;
      if (f.path === v.entry_path) data = Buffer.from(result.html);
      else if (replaced.has(f.path)) data = replaced.get(f.path);
      else if (/\.(html?|css|m?js)$/i.test(f.path)) data = (await readFile(pool, v.id, f.path)).data;
      const sha256 = data ? createHash('sha256').update(data).digest('hex') : f.sha256;
      newFiles.push({ path: f.path, contentType: f.content_type, size: data ? data.length : f.size, sha256, data });
    }
    const upload = {
      sourceName: `Edited in Skyfly (from ${v.source_name})`.slice(0, 200), entryPath: v.entry_path, files: newFiles,
      totalBytes: newFiles.reduce((n, f) => n + f.size, 0), report: analyzeFiles(newFiles.filter((f) => f.data), v.entry_path),
    };
    const versionId = await saveVersion(pool, { pageId: v.page_id, userId: req.session.userId, upload });

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
