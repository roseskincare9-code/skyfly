// AI Media Buyer (Cloudy) inside each business workspace: /businesses/:id/media-buyer.
// Mounted behind the workspace membership check and the "marketing" permission (Owner, Manager), so every
// query below runs for req.business.id only. Meta tokens never reach the browser.
import { Router } from 'express';
import multer from 'multer';
import { asyncHandler, sendWithRanges } from '../lib/http.js';
import { requireCsrf } from '../lib/csrf.js';
import { audit } from '../lib/audit.js';
import { connectAccount, listConnections, selectAccount, disconnectAccount, performance, createPausedCampaign, listCampaigns, ANALYSIS_PERIODS, MetaError } from '../services/metaAds.js';
import { ask, generate, reviewCreative, cloudyReady, cloudyProvider, cloudyHandles, CloudyError, TASK_NAMES } from '../services/cloudy.js';
import { analyze, analystReady, AnalystError, META_CHANGING, ENGINES, recommendationsOf } from '../services/analyst.js';
import { prepareAction, executeAction, ActionError } from '../services/actions.js';
import { runWhatsAppAudit, importLeads, leadLogSummary } from '../services/whatsapp.js';
import { connectionHealth } from '../services/metaAds.js';
import { generatePlan, updatePlan, buildPlan, launchBuild, BuildError, planContext } from '../services/builder.js';
import { startLogin, pendingGrant, connectFromGrant, cancelGrant, refreshDiscovery, metaLoginReady, metaLoginMissing, redirectUri } from '../services/metaLogin.js';
import { onboardingState, onboardingTurn, completeOnboarding, startAutoWorkflow, engineFor, FIELDS as ONBOARDING_FIELDS } from '../services/mbOnboarding.js';

export const TABS = ['overview', 'analysis', 'whatsapp', 'campaigns', 'creatives', 'recommendations', 'briefs', 'approvals', 'reports', 'settings'];
const KINDS = ['image', 'video', 'logo', 'document', 'reference'];
const MAX = { video: 40 * 1024 * 1024, other: 8 * 1024 * 1024 };
const ALLOWED_MIME = /^(image\/(png|jpeg|webp|gif)|video\/(mp4|quicktime|webm)|application\/pdf|text\/plain)$/;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX.video, files: 1, fields: 10 } });
const csvUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024, files: 1, fields: 5 } });
const PROFILE_FIELDS = ['industry', 'business_location', 'website', 'social_accounts', 'offer', 'prices', 'locations', 'audience', 'customer_profile', 'goals', 'platforms', 'fulfilment', 'payment_methods', 'constraints', 'brand_description', 'brand_voice'];

export function mediaBuyerRoutes({ pool, config }) {
  const router = Router();
  const base = (req) => `${res0(req)}/media-buyer`;
  const res0 = (req) => `/businesses/${req.business.id}`;
  const known = (err) => err instanceof MetaError || err instanceof CloudyError || err instanceof AnalystError || err instanceof ActionError || err instanceof BuildError;
  const engineOn = Object.fromEntries(Object.entries(ENGINES).map(([k, e]) => [k, e.ready(config)]));

  async function page(req, res, extra = {}, status = 200) {
    const tab = TABS.includes(req.query.tab) ? req.query.tab : (extra.tab ?? 'overview');
    const id = req.business.id;
    const [{ rows: [profile] }, accounts, { rows: items }, { rows: creatives }, { rows: messages }] = await Promise.all([
      pool.query('SELECT * FROM ad_profiles WHERE business_id = $1', [id]),
      listConnections(pool, id),
      pool.query('SELECT id, kind, title, body, status, data_basis, meta_result, ad_account_id, created_at, decided_at FROM ad_items WHERE business_id = $1 ORDER BY id DESC LIMIT 60', [id]),
      pool.query('SELECT id, kind, name, mime, size_bytes, notes, ai_review, created_at FROM ad_creatives WHERE business_id = $1 ORDER BY id DESC LIMIT 60', [id]),
      pool.query("SELECT role, content, created_at FROM ad_messages WHERE business_id = $1 AND topic = 'ask' ORDER BY id DESC LIMIT 20", [id]),
    ]);
    // Live Meta numbers only on the pages that show them (each page load reads Meta; nothing is cached).
    const period = ['today', 'yesterday', 'last_7d', 'last_30d'].includes(req.query.period) ? req.query.period : 'last_7d';
    const connection = accounts.find((a) => a.selected) ?? accounts[0] ?? null; // the selected account
    const perf = ['overview', 'campaigns'].includes(tab) && connection?.status === 'verified' ? await performance(pool, config, id, period, connection.ad_account_id) : null;
    // Performance Analysis tab (ChatGPT): past analyses, monitoring alerts and settings, scope choices.
    const { rows: alerts } = await pool.query('SELECT * FROM ad_alerts WHERE business_id = $1 AND dismissed_at IS NULL ORDER BY id DESC LIMIT 30', [id]);
    const analysis = tab === 'analysis' ? {
      runs: (await pool.query("SELECT id, ad_account_id, engine, scope, status, error, model, data_fetched_at, created_at FROM ad_analyses WHERE business_id = $1 AND kind = 'performance' ORDER BY id DESC LIMIT 15", [id])).rows,
      usage: (await pool.query(`SELECT e.key AS engine, count(*)::int AS calls, coalesce(sum((e.value->>'input_tokens')::bigint), 0)::bigint AS input_tokens, coalesce(sum((e.value->>'output_tokens')::bigint), 0)::bigint AS output_tokens
        FROM ad_analyses a, jsonb_each(a.usage) e WHERE a.business_id = $1 AND a.created_at > now() - interval '30 days' AND jsonb_typeof(e.value) = 'object' GROUP BY 1 ORDER BY 1`, [id])).rows,
      monitor: (await pool.query('SELECT * FROM ad_monitor_settings WHERE business_id = $1', [id])).rows[0] ?? null,
      products: (await pool.query('SELECT id, name FROM products WHERE business_id = $1 ORDER BY id LIMIT 50', [id])).rows,
      campaigns: connection?.status === 'verified' ? await listCampaigns(pool, config, id, connection.ad_account_id) : [],
      periods: ANALYSIS_PERIODS,
    } : null;
    const whatsapp = tab === 'whatsapp' ? {
      runs: (await pool.query("SELECT id, ad_account_id, engine, status, error, model, data_fetched_at, created_at FROM ad_analyses WHERE business_id = $1 AND kind = 'whatsapp' ORDER BY id DESC LIMIT 10", [id])).rows,
      leads: await leadLogSummary(pool, id),
    } : null;
    const onb = await onboardingState(pool, id);
    const onbMessages = tab === 'overview' ? (await pool.query("SELECT role, content, created_at FROM ad_messages WHERE business_id = $1 AND topic = 'onboarding' ORDER BY id DESC LIMIT 30", [id])).rows.reverse() : [];
    const builds = ['overview', 'approvals'].includes(tab) ? (await pool.query('SELECT b.id, b.ad_item_id, b.status, b.error, b.daily_budget_minor, b.launched_at, b.updated_at, i.title FROM ad_builds b JOIN ad_items i ON i.id = b.ad_item_id WHERE b.business_id = $1 ORDER BY b.id DESC LIMIT 20', [id])).rows : [];
    const activity = tab === 'overview' ? (await pool.query("SELECT action, details, created_at FROM audit_log WHERE business_id = $1 AND action LIKE 'media_buyer.%' ORDER BY id DESC LIMIT 12", [id])).rows : [];
    const actionLog = tab === 'approvals' ? (await pool.query('SELECT * FROM ad_action_log WHERE business_id = $1 ORDER BY id DESC LIMIT 30', [id])).rows : [];
    res.set('Cache-Control', 'no-store');
    res.status(status).render('media-buyer', {
      active: 'mediabuyer', tab, period, profile: profile ?? {}, connection, accounts, isOwner: req.role === 'owner',
      perf, items, creatives, messages: messages.reverse(), aiOn: cloudyReady(config), aiProvider: cloudyProvider(config), analystOn: analystReady(config), cloudyHandles: (task) => cloudyHandles(config, task), alerts, analysis, whatsapp, actionLog, engineOn, onb, onbMessages, onboardingFields: ONBOARDING_FIELDS, builds, activity, aiEngine: engineFor(config), mbBase: base(req),
      lastConnectFailure: tab === 'settings' ? (await pool.query("SELECT details, created_at FROM audit_log WHERE business_id = $1 AND action = 'media_buyer.meta_connect_failed' AND created_at > now() - interval '30 days' AND NOT EXISTS (SELECT 1 FROM audit_log s WHERE s.business_id = $1 AND s.action = 'media_buyer.meta_connected' AND s.id > audit_log.id) ORDER BY id DESC LIMIT 1", [id])).rows[0] ?? null : null,
      metaLogin: { ready: metaLoginReady(config), missing: metaLoginMissing(config), redirectUri: config.publicBaseUrl ? redirectUri(config) : null, grant: tab === 'settings' && req.role === 'owner' ? await pendingGrant(pool, { businessId: id, userId: req.session.userId }) : null },
      notice: typeof req.query.done === 'string' ? req.query.done : null, fbError: typeof req.query.fb_error === 'string' ? req.query.fb_error.slice(0, 300) : null, error: null, answer: null, ...extra,
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
    if ((await onboardingState(pool, req.business.id)).complete) await completeOnboarding(pool, config, req.business.id, req.session.userId);
    await audit(pool, req, { action: 'media_buyer.profile_saved', businessId: req.business.id });
    res.redirect(`${base(req)}?tab=settings&done=profile`);
  }));

  router.post('/connect', asyncHandler(async (req, res) => {
    try {
      const r = await connectAccount(pool, config, { businessId: req.business.id, userId: req.session.userId, token: req.body.token, adAccountId: req.body.ad_account_id, pageId: req.body.page_id || null });
      await audit(pool, req, { action: 'media_buyer.meta_connected', businessId: req.business.id, details: { adAccount: r.account.id, page: r.page?.id ?? null, pixel: r.pixel?.id ?? null } });
      await connectionHealth(pool, config, req.business.id, r.account.id).catch(() => null);
      const st = await onboardingState(pool, req.business.id);
      if (st.complete && st.onboarding.completed_at && st.onboarding.auto_status !== 'done') startAutoWorkflow(pool, config, req.business.id, req.session.userId);
      return res.redirect(`${base(req)}?tab=settings&done=connected`);
    } catch (err) {
      if (!(err instanceof MetaError)) throw err;
      await audit(pool, req, { action: 'media_buyer.meta_connect_failed', businessId: req.business.id, details: { error: err.message } });
      return page(req, res, { tab: 'settings', error: err.message }, err.status === 409 ? 409 : 400);
    }
  }));

  // Facebook Login (official Meta OAuth): only the business owner starts it; Meta sends them back to
  // /meta/oauth/callback, then they pick which of their ad accounts to connect to THIS business.
  router.post('/connect/facebook', asyncHandler(async (req, res) => {
    if (req.role !== 'owner' || res.locals.viaAdmin) return res.status(403).render('error', { message: 'Only the business owner can connect ad accounts with Facebook Login (not a Super Admin visiting).' });
    try {
      const url = await startLogin(pool, config, { businessId: req.business.id, userId: req.session.userId });
      await audit(pool, req, { action: 'media_buyer.facebook_login_started', businessId: req.business.id });
      return res.redirect(303, url);
    } catch (err) {
      if (!(err instanceof MetaError)) throw err;
      return page(req, res, { tab: 'settings', error: err.message }, err.status === 409 ? 409 : 400);
    }
  }));

  router.post('/connect/facebook/accounts', asyncHandler(async (req, res) => {
    if (req.role !== 'owner' || res.locals.viaAdmin) return res.status(403).render('error', { message: 'Only the business owner can connect ad accounts.' });
    try {
      const r = await connectFromGrant(pool, config, { businessId: req.business.id, userId: req.session.userId, grantId: String(req.body.grant ?? ''), accountIds: req.body.accounts });
      for (const a of r.results.filter((x) => x.ok)) {
        await audit(pool, req, { action: 'media_buyer.meta_connected', businessId: req.business.id, details: { adAccount: a.id, via: 'facebook_login' } });
        await connectionHealth(pool, config, req.business.id, a.id).catch(() => null);
      }
      const failed = r.results.filter((x) => !x.ok);
      if (failed.length) await audit(pool, req, { action: 'media_buyer.meta_connect_failed', businessId: req.business.id, details: { via: 'facebook_login', errors: failed.map((f) => `act_${f.id}: ${f.error}`).slice(0, 10) } });
      if (r.results.some((x) => x.ok)) {
        const st = await onboardingState(pool, req.business.id);
        if (st.complete && st.onboarding.completed_at && st.onboarding.auto_status !== 'done') startAutoWorkflow(pool, config, req.business.id, req.session.userId);
      }
      if (!failed.length) return res.redirect(`${base(req)}?tab=settings&done=connected`);
      return page(req, res, { tab: 'settings', error: `Not connected: ${failed.map((f) => `${f.name || ''} act_${f.id}: ${f.error}`).join(' · ')}${r.results.some((x) => x.ok) ? ' (the other selected accounts were connected)' : ''}` }, 400);
    } catch (err) {
      if (!(err instanceof MetaError)) throw err;
      return page(req, res, { tab: 'settings', error: err.message }, err.status === 410 ? 410 : 400);
    }
  }));

  // Re-reads the ad accounts with the Facebook Login token this business already holds (no new sign-in).
  router.post('/connect/facebook/refresh', asyncHandler(async (req, res) => {
    if (req.role !== 'owner' || res.locals.viaAdmin) return res.status(403).render('error', { message: 'Only the business owner can refresh the ad account list.' });
    try {
      await refreshDiscovery(pool, config, { businessId: req.business.id, userId: req.session.userId });
      await audit(pool, req, { action: 'media_buyer.facebook_accounts_refreshed', businessId: req.business.id });
      return res.redirect(`${base(req)}?tab=settings&done=fb_pick#facebook-accounts`);
    } catch (err) {
      if (!(err instanceof MetaError)) throw err;
      return page(req, res, { tab: 'settings', error: err.message }, err.status === 401 ? 409 : (err.status || 400));
    }
  }));

  router.post('/connect/facebook/cancel', asyncHandler(async (req, res) => {
    await cancelGrant(pool, { businessId: req.business.id, userId: req.session.userId });
    res.redirect(`${base(req)}?tab=settings`);
  }));

  // Switches the account the AI Media Buyer works on (only among this business's own accounts).
  router.post(['/accounts/select', '/accounts/:accountId/select'], asyncHandler(async (req, res) => {
    const accountId = String(req.params.accountId ?? req.body.account ?? '');
    if (!/^\d{5,20}$/.test(accountId) || !(await selectAccount(pool, req.business.id, accountId))) return res.status(404).render('error', { message: 'Not found.' });
    await audit(pool, req, { action: 'media_buyer.account_selected', businessId: req.business.id, details: { adAccount: accountId } });
    res.redirect(`${base(req)}?tab=${TABS.includes(req.body.tab) ? req.body.tab : 'overview'}&done=selected`);
  }));

  // Removes one ad account and deletes its token. Owner only.
  router.post('/accounts/:accountId/disconnect', asyncHandler(async (req, res) => {
    if (req.role !== 'owner') return res.status(403).render('error', { message: 'Only the business owner can disconnect an ad account.' });
    if (!/^\d{5,20}$/.test(req.params.accountId) || !(await disconnectAccount(pool, req.business.id, req.params.accountId))) return res.status(404).render('error', { message: 'Not found.' });
    await audit(pool, req, { action: 'media_buyer.meta_disconnected', businessId: req.business.id, details: { adAccount: req.params.accountId } });
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
    sendWithRanges(req, res, c.data);
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
    // A campaign draft is a full plan (built later in Meta as PAUSED) when an analysis engine is on.
    if (req.params.task === 'campaign_draft' && engineFor(config)) {
      try {
        const id = await generatePlan(pool, config, { businessId: req.business.id, userId: req.session.userId, note: req.body.note });
        await audit(pool, req, { action: 'media_buyer.plan_generated', businessId: req.business.id, entityType: 'ad_item', entityId: id });
        return res.redirect(`${base(req)}/items/${id}`);
      } catch (err) { if (!known(err)) throw err; return page(req, res, { tab: 'approvals', error: err.message }, err.status); }
    }
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

  // ---------- ChatGPT performance analysis (reads Meta only; never changes it)
  router.post('/analysis', asyncHandler(async (req, res) => {
    const b = req.body;
    const custom = b.period === 'custom';
    try {
      const id = await analyze(pool, config, {
        businessId: req.business.id, userId: req.session.userId, adAccountId: b.account || null, engine: ['chatgpt', 'claude', 'compare'].includes(b.engine) ? b.engine : 'chatgpt',
        period: ANALYSIS_PERIODS.includes(b.period) ? b.period : 'last_7d', since: custom ? b.since : null, until: custom ? b.until : null,
        campaignId: b.campaign || null, productId: /^\d+$/.test(b.product ?? '') ? b.product : null,
      });
      await audit(pool, req, { action: 'media_buyer.analysis_run', businessId: req.business.id, entityType: 'ad_analysis', entityId: id, details: { engine: b.engine || 'chatgpt' } });
      res.redirect(`${base(req)}/analysis/${id}`);
    } catch (err) { if (!known(err)) throw err; return page(req, res, { tab: 'analysis', error: err.message }, err.status); }
  }));

  const loadAnalysis = async (req) => {
    if (!/^\d+$/.test(req.params.analysisId)) return null;
    const { rows: [a] } = await pool.query('SELECT * FROM ad_analyses WHERE id = $1 AND business_id = $2', [req.params.analysisId, req.business.id]);
    return a ?? null;
  };
  router.get('/analysis/:analysisId', asyncHandler(async (req, res) => {
    const a = await loadAnalysis(req);
    if (!a) return res.status(404).render('error', { message: 'Not found.' });
    const { rows: proposed } = await pool.query("SELECT id, kind, body->>'rec_index' AS n, status FROM ad_items WHERE business_id = $1 AND body->>'analysis_id' = $2", [req.business.id, String(a.id)]);
    res.set('Cache-Control', 'no-store');
    if (a.kind === 'whatsapp') return res.render('media-buyer-whatsapp', { active: 'mediabuyer', a, mbBase: base(req), proposed, engineOn });
    res.render('media-buyer-analysis', { active: 'mediabuyer', a, mbBase: base(req), proposed, metaChanging: META_CHANGING, notice: typeof req.query.done === 'string' ? req.query.done : null });
  }));

  // A recommendation goes to Approvals (ANALYZE → RECOMMEND → REVIEW → APPROVAL). Approving it records the
  // decision; Skyfly does not change the campaign itself (the owner applies it in Ads Manager).
  // The recommendation picked from an analysis (for a comparison, from the engine named in the form).
  const pickRec = (a, req) => {
    const n = Number(req.params.n);
    const engine = a?.engine === 'compare' ? (req.body.engine === 'claude' ? 'claude' : 'chatgpt') : (a?.engine ?? 'chatgpt');
    const r = a?.kind === 'performance' && Number.isInteger(n) ? recommendationsOf(a, engine)[n] : null;
    return r ? { r, engine, key: a.engine === 'compare' ? `${engine}:${n}` : String(n) } : null;
  };
  // A recommendation goes to Approvals as a decision record (ANALYZE → RECOMMEND → REVIEW → APPROVAL).
  router.post('/analysis/:analysisId/recommendations/:n/propose', asyncHandler(async (req, res) => {
    const a = await loadAnalysis(req);
    const p = pickRec(a, req);
    if (!p) return res.status(404).render('error', { message: 'Not found.' });
    const { r, engine, key } = p;
    const { rows: [dup] } = await pool.query("SELECT id FROM ad_items WHERE business_id = $1 AND kind = 'recommendation' AND body->>'analysis_id' = $2 AND body->>'rec_index' = $3", [req.business.id, String(a.id), key]);
    if (dup) return res.redirect(`${base(req)}/items/${dup.id}`);
    const body = { source: `${ENGINES[engine].label} analysis`, analysis_id: String(a.id), rec_index: key, action: r.recommended_action, why: r.why_it_matters, observed: r.observed,
      supporting_metrics: r.supporting_metrics.map((m) => `${m.name}: ${m.value}`), expected_objective: r.expected_objective, confidence: r.confidence, risks: r.risks,
      needs_more_data: r.needs_more_data, needs_approval: true, applies_to: `${r.entity_level} ${r.entity_name} (${r.entity_id})` };
    const { rows: [item] } = await pool.query(
      "INSERT INTO ad_items (business_id, kind, title, body, status, data_basis, created_by, ad_account_id) VALUES ($1, 'recommendation', $2, $3, 'proposed', $4, $5, $6) RETURNING id",
      [req.business.id, `${r.action.replace(/_/g, ' ')}: ${r.entity_name}`.slice(0, 200), JSON.stringify(body), `${ENGINES[engine].label} analysis #${a.id}, ${a.scope.since} to ${a.scope.until}`, req.session.userId, a.ad_account_id]);
    await audit(pool, req, { action: 'media_buyer.recommendation_proposed', businessId: req.business.id, entityType: 'ad_item', entityId: item.id, details: { analysis: a.id, engine } });
    res.redirect(`${base(req)}/items/${item.id}`);
  }));

  // Prepare ONE Meta change from a recommendation (pause, or a daily budget): Skyfly reads the object's
  // current state from Meta and shows current vs proposed for approval. Nothing is changed here.
  router.post('/analysis/:analysisId/recommendations/:n/prepare', asyncHandler(async (req, res) => {
    const a = await loadAnalysis(req);
    const p = pickRec(a, req);
    if (!p) return res.status(404).render('error', { message: 'Not found.' });
    const { r, engine, key } = p;
    const op = r.action === 'pause' ? 'pause' : ['reduce_budget', 'increase_budget'].includes(r.action) ? 'set_daily_budget' : null;
    if (!op || !['campaign', 'adset'].includes(r.entity_level)) return res.status(400).render('error', { message: 'Only pausing or changing the daily budget of a campaign or ad set can be prepared as a Meta action.' });
    const { rows: [dup] } = await pool.query("SELECT id FROM ad_items WHERE business_id = $1 AND kind = 'action' AND status = 'proposed' AND body->>'analysis_id' = $2 AND body->>'rec_index' = $3", [req.business.id, String(a.id), key]);
    if (dup) return res.redirect(`${base(req)}/items/${dup.id}`);
    try {
      const id = await prepareAction(pool, config, {
        businessId: req.business.id, userId: req.session.userId, adAccountId: a.ad_account_id, op, level: r.entity_level, objectId: r.entity_id, proposedBudget: req.body.budget,
        reasoning: `${r.observed}\n${r.why_it_matters}\n${r.recommended_action}`, risks: r.risks, expected: r.expected_objective,
        source: { engine, supporting_metrics: r.supporting_metrics.map((m) => `${m.name}: ${m.value}`) }, link: { analysis_id: a.id, rec_index: key },
      });
      await audit(pool, req, { action: 'media_buyer.action_prepared', businessId: req.business.id, entityType: 'ad_item', entityId: id, details: { op, object: r.entity_id } });
      res.redirect(`${base(req)}/items/${id}`);
    } catch (err) {
      if (!known(err)) throw err;
      return res.status(err.status ?? 400).render('error', { message: err.message });
    }
  }));

  // ---------- WhatsApp Conversion Audit
  router.post('/whatsapp', asyncHandler(async (req, res) => {
    try {
      const id = await runWhatsAppAudit(pool, config, { businessId: req.business.id, userId: req.session.userId, adAccountId: req.body.account || null, engine: req.body.engine === 'claude' ? 'claude' : 'chatgpt' });
      await audit(pool, req, { action: 'media_buyer.whatsapp_audit_run', businessId: req.business.id, entityType: 'ad_analysis', entityId: id });
      res.redirect(`${base(req)}/analysis/${id}`);
    } catch (err) { if (!known(err)) throw err; return page(req, res, { tab: 'whatsapp', error: err.message }, err.status); }
  }));
  router.post('/whatsapp/leads', (req, res, next) => csvUpload.single('file')(req, res, (err) => {
    if (err) { req.uploadError = err.code === 'LIMIT_FILE_SIZE' ? 'The file is too large (2 MB at most).' : 'The upload could not be read.'; req.body ||= {}; }
    requireCsrf(req, res, next);
  }), asyncHandler(async (req, res) => {
    const error = req.uploadError ?? (!req.file ? 'Choose a CSV file.' : null);
    if (error) return page(req, res, { tab: 'whatsapp', error }, 400);
    try {
      const r = await importLeads(pool, req.business.id, req.file.buffer.toString('utf8'));
      await audit(pool, req, { action: 'media_buyer.whatsapp_leads_imported', businessId: req.business.id, details: { saved: r.saved, skipped: r.skipped.length } });
      res.redirect(`${base(req)}?tab=whatsapp&done=leads&saved=${r.saved}&skipped=${r.skipped.length}`);
    } catch (e) { if (!known(e)) throw e; return page(req, res, { tab: 'whatsapp', error: e.message }, e.status); }
  }));
  // The audit's test plan becomes a campaign draft (approval creates it PAUSED, as for every draft).
  router.post('/analysis/:analysisId/draft', asyncHandler(async (req, res) => {
    const a = await loadAnalysis(req);
    const plan = a?.kind === 'whatsapp' && a.status === 'ok' ? a.result?.test_plan : null;
    if (!plan) return res.status(404).render('error', { message: 'Not found.' });
    const { rows: [dup] } = await pool.query("SELECT id FROM ad_items WHERE business_id = $1 AND kind = 'campaign_draft' AND body->>'analysis_id' = $2", [req.business.id, String(a.id)]);
    if (dup) return res.redirect(`${base(req)}/items/${dup.id}`);
    const c = plan.creatives[0] ?? {};
    const body = { name: `WhatsApp test: ${plan.objective}`.slice(0, 120), objective: /engagement|message/i.test(plan.objective) ? 'OUTCOME_ENGAGEMENT' : 'OUTCOME_SALES', daily_budget: plan.daily_budget,
      audience: plan.audience, placements: 'As in the test plan', creatives: plan.creatives.map((x) => `${x.concept}: ${x.hook}`), primary_text: c.primary_text, headline: c.headline, cta: 'WHATSAPP_MESSAGE',
      reasoning: plan.structure, test_plan: `${plan.measurement}\nSuccess: ${plan.success_criteria}\nStop-loss: ${plan.stop_loss}\nScale: ${plan.scaling_criteria}`, analysis_id: String(a.id), rec_index: 'plan' };
    const { rows: [item] } = await pool.query(
      "INSERT INTO ad_items (business_id, kind, title, body, status, data_basis, created_by, ad_account_id) VALUES ($1, 'campaign_draft', $2, $3, 'proposed', $4, $5, $6) RETURNING id",
      [req.business.id, `Campaign draft: ${body.name}`.slice(0, 200), JSON.stringify(body), `WhatsApp Conversion Audit #${a.id}`, req.session.userId, a.ad_account_id]);
    await audit(pool, req, { action: 'media_buyer.generated', businessId: req.business.id, entityType: 'ad_item', entityId: item.id, details: { task: 'whatsapp_draft' } });
    res.redirect(`${base(req)}/items/${item.id}`);
  }));

  // Monitoring: rule-based alerts only (never pauses, edits or spends).
  router.post('/monitoring', asyncHandler(async (req, res) => {
    const b = req.body;
    const minor = (v) => { const n = Number(String(v ?? '').replace(/,/g, '')); return v === '' || v == null || !Number.isFinite(n) || n <= 0 ? null : Math.round(n * 100); };
    const ctr = Math.min(90, Math.max(5, Number(b.ctr_drop_pct) || 30));
    const freq = Math.min(20, Math.max(1, Number(b.frequency_max) || 3.5));
    const hours = [6, 12, 24].includes(Number(b.interval_hours)) ? Number(b.interval_hours) : 24;
    await pool.query(
      `INSERT INTO ad_monitor_settings (business_id, enabled, cpa_threshold_minor, no_conversion_spend_minor, ctr_drop_pct, frequency_max, interval_hours, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now())
       ON CONFLICT (business_id) DO UPDATE SET enabled = EXCLUDED.enabled, cpa_threshold_minor = EXCLUDED.cpa_threshold_minor, no_conversion_spend_minor = EXCLUDED.no_conversion_spend_minor,
         ctr_drop_pct = EXCLUDED.ctr_drop_pct, frequency_max = EXCLUDED.frequency_max, interval_hours = EXCLUDED.interval_hours, updated_at = now()`,
      [req.business.id, b.enabled === 'on' || b.enabled === 'true', minor(b.cpa_threshold), minor(b.no_conversion_spend), ctr, freq, hours]);
    await audit(pool, req, { action: 'media_buyer.monitoring_saved', businessId: req.business.id, details: { enabled: b.enabled === 'on' || b.enabled === 'true' } });
    res.redirect(`${base(req)}?tab=analysis&done=monitoring`);
  }));
  router.post('/alerts/:alertId/dismiss', asyncHandler(async (req, res) => {
    if (!/^\d+$/.test(req.params.alertId)) return res.status(404).render('error', { message: 'Not found.' });
    const { rowCount } = await pool.query('UPDATE ad_alerts SET dismissed_at = now() WHERE id = $1 AND business_id = $2 AND dismissed_at IS NULL', [req.params.alertId, req.business.id]);
    if (!rowCount) return res.status(404).render('error', { message: 'Not found.' });
    res.redirect(`${base(req)}?tab=analysis&done=dismissed`);
  }));

  // ---------- Onboarding conversation and the automatic analysis → plan workflow
  router.post('/onboarding/message', asyncHandler(async (req, res) => {
    try {
      const r = await onboardingTurn(pool, config, { businessId: req.business.id, userId: req.session.userId, message: req.body.message });
      if (r.saved.length) await audit(pool, req, { action: 'media_buyer.onboarding_updated', businessId: req.business.id, details: { fields: r.saved } });
      res.redirect(`${base(req)}?done=${r.started ? 'onboarded' : 'onboarding'}#onboarding`);
    } catch (err) { if (!known(err)) throw err; return page(req, res, { tab: 'overview', error: err.message }, err.status); }
  }));
  router.post('/onboarding/run', asyncHandler(async (req, res) => {
    await pool.query(`INSERT INTO ad_onboarding (business_id, auto_status, updated_at) VALUES ($1, 'idle', now()) ON CONFLICT (business_id) DO NOTHING`, [req.business.id]);
    startAutoWorkflow(pool, config, req.business.id, req.session.userId);
    await audit(pool, req, { action: 'media_buyer.auto_workflow_started', businessId: req.business.id });
    res.redirect(`${base(req)}?done=auto`);
  }));

  // ---------- Connection health (what the token can do), re-checked on request
  router.post('/accounts/:accountId/health', asyncHandler(async (req, res) => {
    try { await connectionHealth(pool, config, req.business.id, req.params.accountId); } catch (err) { if (!known(err)) throw err; return res.status(err.status === 404 ? 404 : 400).render('error', { message: err.message }); }
    res.redirect(`${base(req)}?tab=settings&done=health`);
  }));

  // ---------- Campaign plans: generate, edit, build in Meta (PAUSED), launch (explicit authorisation)
  router.post('/plan', asyncHandler(async (req, res) => {
    try {
      const id = await generatePlan(pool, config, { businessId: req.business.id, userId: req.session.userId, adAccountId: req.body.account || null, engine: ['chatgpt', 'claude'].includes(req.body.engine) ? req.body.engine : null, note: req.body.note });
      await audit(pool, req, { action: 'media_buyer.plan_generated', businessId: req.business.id, entityType: 'ad_item', entityId: id });
      res.redirect(`${base(req)}/items/${id}`);
    } catch (err) { if (!known(err)) throw err; return page(req, res, { tab: 'approvals', error: err.message }, err.status); }
  }));
  router.post('/items/:itemId/plan', asyncHandler(async (req, res) => {
    if (!/^\d+$/.test(req.params.itemId)) return res.status(404).render('error', { message: 'Not found.' });
    try { await updatePlan(pool, config, { businessId: req.business.id, itemId: req.params.itemId, changes: req.body }); } catch (err) { if (!known(err)) throw err; return res.status(err.status).render('error', { message: err.message }); }
    res.redirect(`${base(req)}/items/${req.params.itemId}?done=edited`);
  }));
  const loadBuild = async (req) => {
    if (!/^\d+$/.test(req.params.buildId)) return null;
    return (await pool.query('SELECT * FROM ad_builds WHERE id = $1 AND business_id = $2', [req.params.buildId, req.business.id])).rows[0] ?? null;
  };
  router.post('/builds/:buildId/retry', asyncHandler(async (req, res) => {
    const b = await loadBuild(req);
    if (!b) return res.status(404).render('error', { message: 'Not found.' });
    try { await buildPlan(pool, config, { businessId: req.business.id, userId: req.session.userId, itemId: b.ad_item_id }); } catch (err) { if (!known(err)) throw err; return res.status(err.status).render('error', { message: err.message }); }
    await audit(pool, req, { action: 'media_buyer.build_retried', businessId: req.business.id, entityType: 'ad_build', entityId: b.id });
    res.redirect(`${base(req)}/items/${b.ad_item_id}`);
  }));
  router.post('/builds/:buildId/launch', asyncHandler(async (req, res) => {
    const b = await loadBuild(req);
    if (!b) return res.status(404).render('error', { message: 'Not found.' });
    try {
      const r = await launchBuild(pool, config, { businessId: req.business.id, userId: req.session.userId, buildId: b.id, authorisedDaily: req.body.authorised_daily, confirmText: req.body.confirm });
      await audit(pool, req, { action: r.failed ? 'media_buyer.launch_failed' : 'media_buyer.launched', businessId: req.business.id, entityType: 'ad_build', entityId: b.id, details: { daily_minor: b.daily_budget_minor, campaign: r.campaign?.id, effective_status: r.campaign?.effective_status, error: r.failed } });
      res.redirect(`${base(req)}/items/${b.ad_item_id}?done=${r.failed ? 'launch_failed' : 'launched'}`);
    } catch (err) {
      if (!known(err)) throw err;
      await audit(pool, req, { action: 'media_buyer.launch_refused', businessId: req.business.id, entityType: 'ad_build', entityId: b.id, details: { error: err.message } });
      return res.redirect(`${base(req)}/items/${b.ad_item_id}?launch_error=${encodeURIComponent(err.message.slice(0, 300))}`);
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
    const plan = item.kind === 'campaign_draft' && item.body?.format === 'plan';
    const build = plan ? (await pool.query('SELECT * FROM ad_builds WHERE business_id = $1 AND ad_item_id = $2', [req.business.id, item.id])).rows[0] ?? null : null;
    const images = plan ? (await planContext(pool, req.business.id)).images : [];
    const conn = plan ? (await listConnections(pool, req.business.id)).find((c) => c.ad_account_id === item.ad_account_id) ?? null : null;
    res.render('media-buyer-item', { active: 'mediabuyer', item, mbBase: base(req), notice: typeof req.query.done === 'string' ? req.query.done : null, error: typeof req.query.launch_error === 'string' ? req.query.launch_error.slice(0, 300) : null, build, images, conn });
  }));

  // Approval: a campaign draft becomes a PAUSED campaign shell in the business's own Meta account (nothing
  // can spend); a recommendation is marked approved (to carry out). Rejection changes nothing in Meta.
  router.post('/items/:itemId/approve', asyncHandler(async (req, res) => {
    const item = await loadItem(req);
    if (!item) return res.status(404).render('error', { message: 'Not found.' });
    if (item.status !== 'proposed') return res.redirect(`${base(req)}/items/${item.id}`);
    if (item.kind === 'action') {
      // Applies exactly the change shown on this item, re-checked against Meta, then verified and logged.
      let done;
      try { done = await executeAction(pool, config, { businessId: req.business.id, userId: req.session.userId, itemId: item.id, limitConfirmed: req.body.raise_limit === 'yes' }); } catch (err) {
        if (!known(err)) throw err;
        return res.status(err.status ?? 400).render('media-buyer-item', { active: 'mediabuyer', item, mbBase: base(req), notice: null, error: err.message, build: null, images: [], conn: null });
      }
      if (!done) return res.redirect(`${base(req)}/items/${item.id}`);
      await audit(pool, req, { action: done.status === 'executed' ? 'media_buyer.action_executed' : 'media_buyer.action_failed', businessId: req.business.id, entityType: 'ad_item', entityId: item.id, details: { op: item.body.op, object: item.body.object_id, verified: Boolean(done.meta_result?.verified) } });
      return res.redirect(`${base(req)}/items/${item.id}?done=${done.status === 'executed' ? 'executed' : 'failed'}`);
    }
    if (item.kind === 'campaign_draft' && item.body?.format === 'plan') {
      // Approval of a plan = build it in Meta, everything PAUSED (nothing can spend until a separate launch).
      try {
        const b = await buildPlan(pool, config, { businessId: req.business.id, userId: req.session.userId, itemId: item.id });
        await audit(pool, req, { action: b.status === 'built' ? 'media_buyer.build_completed' : 'media_buyer.build_failed', businessId: req.business.id, entityType: 'ad_build', entityId: b.id, details: { error: b.error } });
        return res.redirect(`${base(req)}/items/${item.id}?done=${b.status === 'built' ? 'built' : 'build_failed'}`);
      } catch (err) {
        if (!known(err)) throw err;
        return res.status(err.status ?? 400).render('media-buyer-item', { active: 'mediabuyer', item, mbBase: base(req), notice: null, error: err.message, build: null, images: (await planContext(pool, req.business.id)).images, conn: null });
      }
    }
    if (item.kind === 'campaign_draft') {
      try {
        const meta = await createPausedCampaign(pool, config, req.business.id, item.body, item.ad_account_id);
        await pool.query("UPDATE ad_items SET status = 'executed', meta_result = $3, decided_by = $4, decided_at = now() WHERE id = $1 AND business_id = $2", [item.id, req.business.id, JSON.stringify(meta), req.session.userId]);
        await audit(pool, req, { action: 'media_buyer.campaign_created_paused', businessId: req.business.id, entityType: 'ad_item', entityId: item.id, details: { campaign: meta.id, status: meta.effective_status } });
      } catch (err) {
        if (!(err instanceof MetaError)) throw err;
        await pool.query("UPDATE ad_items SET meta_result = $3 WHERE id = $1 AND business_id = $2", [item.id, req.business.id, JSON.stringify({ error: err.message })]);
        return res.status(err.status === 409 ? 409 : 502).render('media-buyer-item', { active: 'mediabuyer', item: { ...item, meta_result: { error: err.message } }, mbBase: base(req), notice: null, error: err.message, build: null, images: [], conn: null });
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
