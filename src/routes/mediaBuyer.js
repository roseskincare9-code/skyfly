// AI Media Buyer (Cloudy) inside each business workspace: /businesses/:id/media-buyer.
// Mounted behind the workspace membership check and the "marketing" permission (Owner, Manager), so every
// query below runs for req.business.id only. Meta tokens never reach the browser.
import { Router } from 'express';
import multer from 'multer';
import { asyncHandler } from '../lib/http.js';
import { requireCsrf } from '../lib/csrf.js';
import { audit } from '../lib/audit.js';
import { connectAccount, connectionFor, performance, createPausedCampaign, MetaError } from '../services/metaAds.js';
import { ask, generate, reviewCreative, cloudyReady, CloudyError, TASK_NAMES } from '../services/cloudy.js';

export const TABS = ['overview', 'campaigns', 'creatives', 'recommendations', 'briefs', 'approvals', 'reports', 'settings'];
const KINDS = ['image', 'video', 'logo', 'document', 'reference'];
const MAX = { video: 40 * 1024 * 1024, other: 8 * 1024 * 1024 };
const ALLOWED_MIME = /^(image\/(png|jpeg|webp|gif)|video\/(mp4|quicktime|webm)|application\/pdf|text\/plain)$/;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX.video, files: 1, fields: 10 } });
const PROFILE_FIELDS = ['industry', 'website', 'offer', 'prices', 'locations', 'audience', 'customer_profile', 'goals', 'platforms', 'brand_description', 'brand_voice'];

export function mediaBuyerRoutes({ pool, config }) {
  const router = Router();
  const base = (req) => `${res0(req)}/media-buyer`;
  const res0 = (req) => `/businesses/${req.business.id}`;
  const known = (err) => err instanceof MetaError || err instanceof CloudyError;

  async function page(req, res, extra = {}, status = 200) {
    const tab = TABS.includes(req.query.tab) ? req.query.tab : (extra.tab ?? 'overview');
    const id = req.business.id;
    const [{ rows: [profile] }, connection, { rows: items }, { rows: creatives }, { rows: messages }] = await Promise.all([
      pool.query('SELECT * FROM ad_profiles WHERE business_id = $1', [id]),
      connectionFor(pool, id),
      pool.query('SELECT id, kind, title, body, status, data_basis, meta_result, created_at, decided_at FROM ad_items WHERE business_id = $1 ORDER BY id DESC LIMIT 60', [id]),
      pool.query('SELECT id, kind, name, mime, size_bytes, notes, ai_review, created_at FROM ad_creatives WHERE business_id = $1 ORDER BY id DESC LIMIT 60', [id]),
      pool.query('SELECT role, content, created_at FROM ad_messages WHERE business_id = $1 ORDER BY id DESC LIMIT 20', [id]),
    ]);
    // Live Meta numbers only on the pages that show them (each page load reads Meta; nothing is cached).
    const period = ['today', 'yesterday', 'last_7d', 'last_30d'].includes(req.query.period) ? req.query.period : 'last_7d';
    const perf = ['overview', 'campaigns'].includes(tab) && connection?.status === 'verified' ? await performance(pool, config, id, period) : null;
    res.set('Cache-Control', 'no-store');
    res.status(status).render('media-buyer', {
      active: 'mediabuyer', tab, period, profile: profile ?? {}, connection: connection ? { ...connection, token_enc: undefined } : null,
      perf, items, creatives, messages: messages.reverse(), aiOn: cloudyReady(config), mbBase: base(req),
      notice: typeof req.query.done === 'string' ? req.query.done : null, error: null, answer: null, ...extra,
    });
  }

  router.get('/', asyncHandler((req, res) => page(req, res)));

  router.post('/profile', asyncHandler(async (req, res) => {
    const v = Object.fromEntries(PROFILE_FIELDS.map((k) => [k, String(req.body[k] ?? '').trim().slice(0, 2000) || null]));
    const budget = String(req.body.daily_budget ?? '').replace(/[^\d.]/g, '');
    const budgetMinor = budget ? Math.round(Number(budget) * 100) : null;
    await pool.query(
      `INSERT INTO ad_profiles (business_id, ${PROFILE_FIELDS.join(', ')}, daily_budget_minor, updated_at)
       VALUES ($1, ${PROFILE_FIELDS.map((_, i) => `$${i + 2}`).join(', ')}, $${PROFILE_FIELDS.length + 2}, now())
       ON CONFLICT (business_id) DO UPDATE SET ${PROFILE_FIELDS.map((k) => `${k} = EXCLUDED.${k}`).join(', ')}, daily_budget_minor = EXCLUDED.daily_budget_minor, updated_at = now()`,
      [req.business.id, ...PROFILE_FIELDS.map((k) => v[k]), Number.isFinite(budgetMinor) ? budgetMinor : null]);
    await audit(pool, req, { action: 'media_buyer.profile_saved', businessId: req.business.id });
    res.redirect(`${base(req)}?tab=settings&done=profile`);
  }));

  router.post('/connect', asyncHandler(async (req, res) => {
    try {
      const r = await connectAccount(pool, config, { businessId: req.business.id, userId: req.session.userId, token: req.body.token, adAccountId: req.body.ad_account_id, pageId: req.body.page_id || null });
      await audit(pool, req, { action: 'media_buyer.meta_connected', businessId: req.business.id, details: { adAccount: r.account.id, page: r.page?.id ?? null, pixel: r.pixel?.id ?? null } });
      return res.redirect(`${base(req)}?tab=settings&done=connected`);
    } catch (err) {
      if (!(err instanceof MetaError)) throw err;
      await audit(pool, req, { action: 'media_buyer.meta_connect_failed', businessId: req.business.id, details: { error: err.message } });
      return page(req, res, { tab: 'settings', error: err.message }, err.status === 409 ? 409 : 400);
    }
  }));

  router.post('/disconnect', asyncHandler(async (req, res) => {
    await pool.query('DELETE FROM ad_connections WHERE business_id = $1', [req.business.id]);
    await audit(pool, req, { action: 'media_buyer.meta_disconnected', businessId: req.business.id });
    res.redirect(`${base(req)}?tab=settings&done=disconnected`);
  }));

  // Creative library: upload (multipart; CSRF checked after parsing), view, AI review, delete.
  router.post('/creatives', (req, res, next) => upload.single('file')(req, res, (err) => {
    if (err) { req.uploadError = err.code === 'LIMIT_FILE_SIZE' ? 'The file is larger than 40 MB.' : 'The upload could not be read.'; req.body ||= {}; }
    requireCsrf(req, res, next);
  }), asyncHandler(async (req, res) => {
    const f = req.file;
    const kind = KINDS.includes(req.body.kind) ? req.body.kind : 'image';
    const error = req.uploadError ?? (!f ? 'Choose a file.' : !ALLOWED_MIME.test(f.mimetype) ? 'Upload an image (PNG, JPG, WebP, GIF), a video (MP4, MOV, WebM), a PDF or a text file.'
      : f.size > (f.mimetype.startsWith('video/') ? MAX.video : MAX.other) ? `That file is too large (images and documents up to 8 MB, videos up to 40 MB).` : null);
    if (error) return page(req, res, { tab: 'creatives', error }, 400);
    const { rows: [c] } = await pool.query(
      'INSERT INTO ad_creatives (business_id, kind, name, mime, size_bytes, data, notes, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id',
      [req.business.id, kind, String(f.originalname).slice(0, 200), f.mimetype, f.size, f.buffer, String(req.body.notes ?? '').trim().slice(0, 1000) || null, req.session.userId]);
    await audit(pool, req, { action: 'media_buyer.creative_uploaded', businessId: req.business.id, entityType: 'ad_creative', entityId: c.id });
    res.redirect(`${base(req)}?tab=creatives&done=uploaded`);
  }));

  router.get('/creatives/:creativeId/file', asyncHandler(async (req, res) => {
    if (!/^\d+$/.test(req.params.creativeId)) return res.status(404).render('error', { message: 'Not found.' });
    const { rows: [c] } = await pool.query('SELECT name, mime, data FROM ad_creatives WHERE id = $1 AND business_id = $2', [req.params.creativeId, req.business.id]);
    if (!c) return res.status(404).render('error', { message: 'Not found.' });
    res.set({ 'Content-Type': c.mime, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Disposition': `inline; filename="${c.name.replace(/[^\w.-]/g, '_')}"` });
    res.send(c.data);
  }));

  router.post('/creatives/:creativeId/review', asyncHandler(async (req, res) => {
    if (!/^\d+$/.test(req.params.creativeId)) return res.status(404).render('error', { message: 'Not found.' });
    try { await reviewCreative(pool, config, { businessId: req.business.id, creativeId: Number(req.params.creativeId) }); }
    catch (err) { if (!known(err)) throw err; return page(req, res, { tab: 'creatives', error: err.message }, err.status); }
    res.redirect(`${base(req)}?tab=creatives&done=reviewed`);
  }));

  router.post('/creatives/:creativeId/delete', asyncHandler(async (req, res) => {
    const { rowCount } = /^\d+$/.test(req.params.creativeId)
      ? await pool.query('DELETE FROM ad_creatives WHERE id = $1 AND business_id = $2', [req.params.creativeId, req.business.id]) : { rowCount: 0 };
    if (!rowCount) return res.status(404).render('error', { message: 'Not found.' });
    res.redirect(`${base(req)}?tab=creatives&done=deleted`);
  }));

  // Conversation with Cloudy (this business's data only).
  router.post('/ask', asyncHandler(async (req, res) => {
    try {
      const answer = await ask(pool, config, { businessId: req.business.id, userId: req.session.userId, question: req.body.question });
      return page(req, res, { tab: 'overview', answer });
    } catch (err) { if (!known(err)) throw err; return page(req, res, { tab: 'overview', error: err.message }, err.status); }
  }));

  // Audit, recommendations, creative briefs, campaign draft, daily / weekly report.
  router.post('/generate/:task', asyncHandler(async (req, res) => {
    if (!TASK_NAMES.includes(req.params.task)) return res.status(404).render('error', { message: 'Not found.' });
    try {
      const id = await generate(pool, config, { businessId: req.business.id, userId: req.session.userId, task: req.params.task, note: req.body.note });
      await audit(pool, req, { action: 'media_buyer.generated', businessId: req.business.id, entityType: 'ad_item', entityId: id, details: { task: req.params.task } });
      res.redirect(`${base(req)}/items/${id}`);
    } catch (err) {
      if (!known(err)) throw err;
      const tab = { audit: 'reports', report_daily: 'reports', report_weekly: 'reports', briefs: 'briefs', campaign_draft: 'approvals', recommendations: 'recommendations' }[req.params.task];
      return page(req, res, { tab, error: err.message }, err.status);
    }
  }));

  const loadItem = async (req) => {
    if (!/^\d+$/.test(req.params.itemId)) return null;
    const { rows: [i] } = await pool.query('SELECT * FROM ad_items WHERE id = $1 AND business_id = $2', [req.params.itemId, req.business.id]);
    return i ?? null;
  };
  router.get('/items/:itemId', asyncHandler(async (req, res) => {
    const item = await loadItem(req);
    if (!item) return res.status(404).render('error', { message: 'Not found.' });
    res.set('Cache-Control', 'no-store');
    res.render('media-buyer-item', { active: 'mediabuyer', item, mbBase: base(req), notice: typeof req.query.done === 'string' ? req.query.done : null, error: null });
  }));

  // Approval: a campaign draft becomes a PAUSED campaign shell in the business's own Meta account (nothing
  // can spend); a recommendation is marked approved (to carry out). Rejection changes nothing in Meta.
  router.post('/items/:itemId/approve', asyncHandler(async (req, res) => {
    const item = await loadItem(req);
    if (!item) return res.status(404).render('error', { message: 'Not found.' });
    if (item.status !== 'proposed') return res.redirect(`${base(req)}/items/${item.id}`);
    if (item.kind === 'campaign_draft') {
      try {
        const meta = await createPausedCampaign(pool, config, req.business.id, item.body);
        await pool.query("UPDATE ad_items SET status = 'executed', meta_result = $3, decided_by = $4, decided_at = now() WHERE id = $1 AND business_id = $2", [item.id, req.business.id, JSON.stringify(meta), req.session.userId]);
        await audit(pool, req, { action: 'media_buyer.campaign_created_paused', businessId: req.business.id, entityType: 'ad_item', entityId: item.id, details: { campaign: meta.id, status: meta.effective_status } });
      } catch (err) {
        if (!(err instanceof MetaError)) throw err;
        await pool.query("UPDATE ad_items SET meta_result = $3 WHERE id = $1 AND business_id = $2", [item.id, req.business.id, JSON.stringify({ error: err.message })]);
        return res.status(err.status === 409 ? 409 : 502).render('media-buyer-item', { active: 'mediabuyer', item: { ...item, meta_result: { error: err.message } }, mbBase: base(req), notice: null, error: err.message });
      }
    } else {
      await pool.query("UPDATE ad_items SET status = 'approved', decided_by = $3, decided_at = now() WHERE id = $1 AND business_id = $2", [item.id, req.business.id, req.session.userId]);
      await audit(pool, req, { action: 'media_buyer.approved', businessId: req.business.id, entityType: 'ad_item', entityId: item.id });
    }
    res.redirect(`${base(req)}/items/${item.id}?done=approved`);
  }));

  router.post('/items/:itemId/reject', asyncHandler(async (req, res) => {
    const item = await loadItem(req);
    if (!item) return res.status(404).render('error', { message: 'Not found.' });
    if (item.status === 'proposed') {
      await pool.query("UPDATE ad_items SET status = 'rejected', decided_by = $3, decided_at = now() WHERE id = $1 AND business_id = $2", [item.id, req.business.id, req.session.userId]);
      await audit(pool, req, { action: 'media_buyer.rejected', businessId: req.business.id, entityType: 'ad_item', entityId: item.id });
    }
    res.redirect(`${base(req)}/items/${item.id}?done=rejected`);
  }));

  return router;
}
