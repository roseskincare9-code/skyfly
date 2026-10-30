// Tracking & Pixels: a business's tracking IDs for Meta, TikTok and X, any number per platform. Each
// is saved on its own (adding one never changes another), switched on or off, assigned to all pages
// or chosen landing pages, and verified step by step. IDs and settings are stored in the database and
// used by the pages straight away (no code change or redeploy). Pasted pixel code is only read for its
// IDs; it is never stored or run. Access tokens are encrypted and never shown again.
import { Router } from 'express';
import { asyncHandler } from '../lib/http.js';
import { audit } from '../lib/audit.js';
import { encrypt } from '../lib/secrets.js';
import { parsePixelCode } from '../services/pixelCode.js';
import {
  PLATFORMS, PLATFORM_LABELS, SHORT_LABELS, PROVIDERS, EVENTS, PIXEL_ID_RULES, X_EVENTS, X_EVENT_RE, TIKTOK_PURCHASE_EVENTS,
  normalizePixelId, sendTestEvent, markServerVerified, markVerificationFailed, trackingStatus, platformPixel,
} from '../services/pixels.js';

// A generous safety ceiling (not a product limit): stops a runaway script, never a real business.
const MAX_PER_BUSINESS = 1000;
const EVENT_HELP = {
  PageView: 'every visit to an assigned page',
  ViewContent: 'a visit to a product page',
  InitiateCheckout: 'the visitor starts the order form',
  Lead: 'Skyfly saved the order (TikTok: SubmitForm)',
  Purchase: 'Skyfly saved the order and gave it its number: once per order, never for test orders or unfinished checkouts',
};

export function pixelRoutes({ pool, config }) {
  const router = Router({ mergeParams: true });
  const base = (res) => `${res.locals.base}/pixels`;

  async function pagesOf(businessId) {
    const { rows } = await pool.query(
      "SELECT id, name, slug, status FROM landing_pages WHERE business_id = $1 AND status <> 'archived' ORDER BY name", [businessId]);
    return rows;
  }
  async function load(req) {
    if (!/^\d+$/.test(String(req.params.id))) return null;
    const { rows: [p] } = await pool.query('SELECT * FROM tracking_pixels WHERE id = $1 AND business_id = $2', [req.params.id, req.business.id]);
    if (!p) return null;
    const { rows } = await pool.query(
      `SELECT lp.id, lp.name, lp.slug FROM tracking_pixel_pages pp JOIN landing_pages lp ON lp.id = pp.landing_page_id
        WHERE pp.tracking_pixel_id = $1 AND lp.business_id = $2 ORDER BY lp.name`, [p.id, req.business.id]);
    p.pages = rows;
    return p;
  }

  // Onboarding: "Skip for now" on the Overview's "Connect your Meta Pixel" step (it stays possible here).
  router.post('/skip-setup', asyncHandler(async (req, res) => {
    await pool.query('UPDATE businesses SET tracking_setup_skipped_at = now() WHERE id = $1 AND tracking_setup_skipped_at IS NULL', [req.business.id]);
    await audit(pool, req, { action: 'tracking.setup_skipped', businessId: req.business.id, entityType: 'business', entityId: req.business.id });
    res.redirect(res.locals.base);
  }));

  // ---------- list (one tab per platform) ----------
  router.get('/', asyncHandler(async (req, res) => {
    const platform = PLATFORMS.includes(req.query.platform) ? req.query.platform : 'meta';
    const b = req.business;
    const [{ rows: list }, { rows: counts }, pages, { rows: lastEvents }] = await Promise.all([
      pool.query(
        `SELECT tp.*, (SELECT count(*)::int FROM tracking_pixel_pages pp WHERE pp.tracking_pixel_id = tp.id) AS page_count,
                (SELECT count(*)::int FROM landing_pages lp WHERE lp.business_id = tp.business_id AND lp.status = 'active'
                    AND (lp.published_version_id IS NOT NULL OR lp.url IS NOT NULL)
                    AND (tp.all_pages OR EXISTS (SELECT 1 FROM tracking_pixel_pages pp WHERE pp.tracking_pixel_id = tp.id AND pp.landing_page_id = lp.id))) AS live_pages,
                (SELECT string_agg(lp.name, ', ' ORDER BY lp.name) FROM tracking_pixel_pages pp JOIN landing_pages lp ON lp.id = pp.landing_page_id WHERE pp.tracking_pixel_id = tp.id) AS page_names
           FROM tracking_pixels tp WHERE tp.business_id = $1 AND tp.platform = $2 ORDER BY tp.id`, [b.id, platform]),
      pool.query('SELECT platform, count(*)::int AS n, count(*) FILTER (WHERE enabled)::int AS on FROM tracking_pixels WHERE business_id = $1 GROUP BY platform', [b.id]),
      pagesOf(b.id),
      // The last server event per tracking ID (this business's orders only).
      pool.query(
        `SELECT DISTINCT ON (e.provider, e.pixel_id) e.provider, e.pixel_id, e.status, e.event_name, e.test_mode, coalesce(e.sent_at, e.created_at) AS at, o.reference
           FROM conversion_events e JOIN orders o ON o.id = e.order_id WHERE o.business_id = $1
          ORDER BY e.provider, e.pixel_id, e.id DESC`, [b.id]),
    ]);
    const byPlatform = Object.fromEntries(counts.map((c) => [c.platform, c]));
    const last = Object.fromEntries(lastEvents.map((e) => [`${e.provider}:${e.pixel_id}`, e]));
    const skyfly = platform === 'meta' && !list.length ? await platformPixel(pool, config, b.id) : null;
    res.set('Cache-Control', 'no-store');
    res.render('tracking', {
      active: 'pixels', platform, list: list.map((p) => ({ ...p, status: trackingStatus(p) })), byPlatform, pages, last, skyfly, PLATFORMS, PLATFORM_LABELS, SHORT_LABELS, PROVIDERS, X_EVENTS,
      notice: { added: 'Tracking ID added. It is used on its pages straight away.', saved: 'Saved.', on: 'Switched on.', off: 'Switched off. The other tracking IDs are unchanged.', removed: 'Tracking ID removed.' }[req.query.done] ?? null,
    });
  }));

  // ---------- add / edit form ----------
  function form(req, res, { p = null, platform, error = null, status = 200, values = null }) {
    res.set('Cache-Control', 'no-store');
    return pagesOf(req.business.id).then((pages) => res.status(status).render('tracking-form', {
      active: 'pixels', p, platform, pages, error, v: values ?? (p ? {
        name: p.name, pixel_id: p.pixel_id, enabled: p.enabled, all_pages: p.all_pages, pages: p.pages.map((x) => String(x.id)), events: p.events,
        eventIds: p.settings?.eventIds ?? {}, purchaseEvent: p.settings?.purchaseEvent ?? '', server_purchase: p.server_purchase, test_event_code: p.test_event_code ?? '',
        method: p.install_method,
      } : { name: '', pixel_id: '', enabled: true, all_pages: false, pages: [], events: [...EVENTS], eventIds: {}, purchaseEvent: '', server_purchase: false, test_event_code: '', method: 'id' }),
      PLATFORMS, PLATFORM_LABELS, SHORT_LABELS, PROVIDERS, EVENTS, EVENT_HELP, PIXEL_ID_RULES, X_EVENTS, TIKTOK_PURCHASE_EVENTS,
      encryptionReady: Boolean(config.encryptionKey),
    }));
  }
  router.get('/new', asyncHandler(async (req, res) => {
    const platform = PLATFORMS.includes(req.query.platform) ? req.query.platform : 'meta';
    await form(req, res, { platform });
  }));
  router.get('/:id/edit', asyncHandler(async (req, res) => {
    const p = await load(req);
    if (!p) return res.status(404).render('error', { message: 'Tracking ID not found.' });
    await form(req, res, { p, platform: p.platform });
  }));

  // Reads and checks the form. Returns { values, errors, data } (data is what is saved).
  async function read(req, existing) {
    const platform = existing?.platform ?? (PLATFORMS.includes(req.body.platform) ? req.body.platform : null);
    const b = req.body;
    const errors = [];
    if (!platform) return { platform: null, errors: ['Choose a platform.'], values: null };
    const label = SHORT_LABELS[platform];
    const name = String(b.name ?? '').replace(/\s+/g, ' ').trim();
    if (!name || name.length > 60) errors.push('Give the tracking ID a name (up to 60 characters), e.g. "Ad account 2".');
    const method = b.install_method === 'code' ? 'code' : 'id';
    let pixelId = normalizePixelId(platform, b.pixel_id);
    let codeEventIds = [];
    if (method === 'code') {
      const pasted = String(b.pixel_code ?? '').trim();
      if (!pasted && existing?.install_method === 'code') pixelId = existing.pixel_id;
      else {
        const parsed = parsePixelCode(platform, pasted);
        if (parsed.error) errors.push(parsed.error);
        else { pixelId = parsed.pixelId; codeEventIds = parsed.eventIds ?? []; }
      }
    }
    if (!errors.length && !PIXEL_ID_RULES[platform].re.test(pixelId)) errors.push(`The ${label} pixel ID should be ${PIXEL_ID_RULES[platform].hint}.`);
    const enabled = b.enabled === 'on';
    const events = [].concat(b.events ?? []).filter((e) => EVENTS.includes(e));
    if (enabled && !events.length) errors.push('Choose at least one event, or switch the tracking ID off.');
    const allPages = b.all_pages === 'on';
    const pageIds = [...new Set([].concat(b.pages ?? []).map(String).filter((x) => /^\d+$/.test(x)))];
    // An enabled ID with no page would track nothing: the owner chooses where it runs.
    if (enabled && !allPages && !pageIds.length) errors.push('Choose where this tracking ID runs: tick "All pages" or at least one landing page.');
    if (pageIds.length) {
      const { rows } = await pool.query("SELECT id FROM landing_pages WHERE business_id = $1 AND id = ANY($2::bigint[]) AND status <> 'archived'", [req.business.id, pageIds]);
      if (rows.length !== pageIds.length) errors.push('Choose landing pages of this business only.');
    }
    const settings = {};
    if (platform === 'x') {
      const eventIds = {};
      for (const e of X_EVENTS) {
        const raw = String(b[`x_event_${e}`] ?? '').trim().toLowerCase().replace(/^tw-[a-z0-9]+-/, '');
        if (!raw) continue;
        if (!X_EVENT_RE.test(raw)) errors.push(`The X event ID for ${e} should be 4–12 letters and digits (the last part of tw-${pixelId || 'pixel'}-xxxxx).`);
        else eventIds[e] = raw;
      }
      // Event IDs found in pasted code fill the Purchase box when it is empty.
      if (!eventIds.Purchase && codeEventIds.length === 1) eventIds.Purchase = codeEventIds[0];
      settings.eventIds = eventIds;
    }
    if (platform === 'tiktok' && TIKTOK_PURCHASE_EVENTS.includes(b.purchase_event)) settings.purchaseEvent = b.purchase_event;
    // Server-side Purchase (Meta, TikTok): the token is write-only; blank keeps the saved one.
    const serverPurchase = PROVIDERS.includes(platform) && b.server_purchase === 'on';
    const token = PROVIDERS.includes(platform) ? String(b.access_token ?? '').trim() : '';
    const testCode = PROVIDERS.includes(platform) ? String(b.test_event_code ?? '').trim() : '';
    if (token && !/^[\x21-\x7e]{20,1000}$/.test(token)) errors.push('That access token does not look right. Copy it again from the ad platform.');
    if (token && !config.encryptionKey) errors.push('Access tokens can\'t be stored until SKYFLY_ENCRYPTION_KEY is set on the server.');
    if (testCode && !/^[A-Za-z0-9_-]{3,40}$/.test(testCode)) errors.push('The test event code should be letters and numbers, e.g. TEST12345.');
    let tokenEnc = existing?.access_token_enc ?? null;
    if (b.remove_token === 'on' || !PROVIDERS.includes(platform)) tokenEnc = null;
    else if (token && !errors.length) tokenEnc = encrypt(config.encryptionKey, token);
    if (serverPurchase && !tokenEnc) errors.push('Server-side Purchase needs an access token. Add the token or turn that option off.');
    if (!errors.length) {
      const { rows: [twin] } = await pool.query(
        'SELECT name FROM tracking_pixels WHERE business_id = $1 AND platform = $2 AND pixel_id = $3 AND id <> $4', [req.business.id, platform, pixelId, existing?.id ?? 0]);
      if (twin) errors.push(`${label} pixel ${pixelId} is already saved here as "${twin.name}", so it would count every event twice. Edit that one instead.`);
    }
    const values = {
      name, pixel_id: method === 'code' ? '' : pixelId, enabled, all_pages: allPages, pages: pageIds, events, eventIds: settings.eventIds ?? {},
      purchaseEvent: settings.purchaseEvent ?? '', server_purchase: serverPurchase, test_event_code: testCode, method,
    };
    return { platform, errors, values, data: { name, pixelId, enabled, events, allPages, pageIds, settings, method, serverPurchase, tokenEnc, testCode: testCode || null, tokenChanged: Boolean(token) || b.remove_token === 'on' } };
  }

  async function savePages(client, id, pageIds) {
    await client.query('DELETE FROM tracking_pixel_pages WHERE tracking_pixel_id = $1', [id]);
    if (pageIds.length) {
      await client.query('INSERT INTO tracking_pixel_pages (tracking_pixel_id, landing_page_id) SELECT $1, unnest($2::bigint[]) ON CONFLICT DO NOTHING', [id, pageIds]);
    }
  }

  router.post('/', asyncHandler(async (req, res) => {
    const { platform, errors, values, data } = await read(req, null);
    const { rows: [count] } = await pool.query('SELECT count(*)::int AS n FROM tracking_pixels WHERE business_id = $1', [req.business.id]);
    if (count.n >= MAX_PER_BUSINESS) errors.push(`This business already has ${count.n} tracking IDs. Remove unused ones first.`);
    if (errors.length) return form(req, res, { platform: platform ?? 'meta', error: errors.join(' '), status: 400, values });
    const client = await pool.connect();
    let id;
    try {
      await client.query('BEGIN');
      ({ rows: [{ id }] } = await client.query(
        `INSERT INTO tracking_pixels (business_id, platform, name, pixel_id, enabled, all_pages, events, settings, install_method,
                                      server_purchase, access_token_enc, test_event_code, created_by, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $13) RETURNING id`,
        [req.business.id, platform, data.name, data.pixelId, data.enabled, data.allPages, data.events, JSON.stringify(data.settings), data.method,
          data.serverPurchase, data.tokenEnc, data.testCode, req.session.userId]));
      await savePages(client, id, data.pageIds);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      if (err.code === '23505') return form(req, res, { platform, error: `${SHORT_LABELS[platform]} pixel ${data.pixelId} is already saved for this business.`, status: 400, values });
      throw err;
    } finally { client.release(); }
    await audit(pool, req, {
      action: 'tracking.added', businessId: req.business.id, entityType: 'tracking_pixel', entityId: id,
      details: { platform, name: data.name, pixelId: data.pixelId, enabled: data.enabled, allPages: data.allPages, pages: data.pageIds.length, events: data.events, server: data.serverPurchase },
    });
    res.redirect(`${base(res)}?platform=${platform}&done=added`);
  }));

  router.post('/:id', asyncHandler(async (req, res) => {
    const p = await load(req);
    if (!p) return res.status(404).render('error', { message: 'Tracking ID not found.' });
    const { errors, values, data } = await read(req, p);
    if (errors.length) return form(req, res, { p, platform: p.platform, error: errors.join(' '), status: 400, values });
    // Verification belongs to a specific ID and token: changing them means verifying again.
    const idChanged = p.pixel_id !== data.pixelId;
    const tokenChanged = data.tokenEnc !== p.access_token_enc;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE tracking_pixels SET name = $2, pixel_id = $3, enabled = $4, all_pages = $5, events = $6, settings = $7, install_method = $8,
                server_purchase = $9, access_token_enc = $10, test_event_code = $11, updated_by = $12, updated_at = now(),
                browser_seen_at = CASE WHEN $13 THEN NULL ELSE browser_seen_at END,
                browser_verified_at = CASE WHEN $13 THEN NULL ELSE browser_verified_at END,
                test_event_at = CASE WHEN $13 OR $14 THEN NULL ELSE test_event_at END,
                server_verified_at = CASE WHEN $13 OR $14 THEN NULL ELSE server_verified_at END
          WHERE id = $1 AND business_id = $15`,
        [p.id, data.name, data.pixelId, data.enabled, data.allPages, data.events, JSON.stringify(data.settings), data.method, data.serverPurchase,
          data.tokenEnc, data.testCode, req.session.userId, idChanged, tokenChanged, req.business.id]);
      await savePages(client, p.id, data.pageIds);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally { client.release(); }
    await audit(pool, req, {
      action: 'tracking.updated', businessId: req.business.id, entityType: 'tracking_pixel', entityId: p.id,
      details: { platform: p.platform, name: data.name, pixelId: data.pixelId, enabled: data.enabled, allPages: data.allPages, pages: data.pageIds.length, events: data.events, server: data.serverPurchase, tokenChanged: data.tokenChanged },
    });
    res.redirect(`${base(res)}?platform=${p.platform}&done=saved`);
  }));

  // Switches one tracking ID on or off; the others are untouched.
  router.post('/:id/toggle', asyncHandler(async (req, res) => {
    const p = await load(req);
    if (!p) return res.status(404).render('error', { message: 'Tracking ID not found.' });
    const on = req.body.enabled === 'true';
    await pool.query('UPDATE tracking_pixels SET enabled = $3, updated_by = $4, updated_at = now() WHERE id = $1 AND business_id = $2', [p.id, req.business.id, on, req.session.userId]);
    await audit(pool, req, { action: on ? 'tracking.enabled' : 'tracking.disabled', businessId: req.business.id, entityType: 'tracking_pixel', entityId: p.id, details: { platform: p.platform, pixelId: p.pixel_id } });
    res.redirect(`${base(res)}?platform=${p.platform}&done=${on ? 'on' : 'off'}`);
  }));

  // ---------- remove (confirmation with what depends on it) ----------
  router.get('/:id/remove', asyncHandler(async (req, res) => {
    const p = await load(req);
    if (!p) return res.status(404).render('error', { message: 'Tracking ID not found.' });
    const { rows: [ev] } = await pool.query(
      `SELECT count(*)::int AS n FROM conversion_events e JOIN orders o ON o.id = e.order_id WHERE o.business_id = $1 AND e.provider = $2 AND e.pixel_id = $3`,
      [req.business.id, p.platform, p.pixel_id]);
    const { rows: [{ n: pageCount }] } = await pool.query("SELECT count(*)::int AS n FROM landing_pages WHERE business_id = $1 AND status <> 'archived'", [req.business.id]);
    res.set('Cache-Control', 'no-store');
    res.render('tracking-remove', { active: 'pixels', p, events: ev.n, pageCount, SHORT_LABELS });
  }));
  router.post('/:id/remove', asyncHandler(async (req, res) => {
    const p = await load(req);
    if (!p) return res.status(404).render('error', { message: 'Tracking ID not found.' });
    if (req.body.confirm !== p.pixel_id) return res.redirect(`${base(res)}/${p.id}/remove?wrong=1`);
    await pool.query('DELETE FROM tracking_pixels WHERE id = $1 AND business_id = $2', [p.id, req.business.id]);
    await audit(pool, req, { action: 'tracking.removed', businessId: req.business.id, entityType: 'tracking_pixel', entityId: p.id, details: { platform: p.platform, name: p.name, pixelId: p.pixel_id } });
    res.redirect(`${base(res)}?platform=${p.platform}&done=removed`);
  }));

  // ---------- verify ----------
  async function verifyPage(req, res, p, { notice = null, error = null, status = 200 } = {}) {
    const { rows: recent } = await pool.query(
      `SELECT e.status, e.event_name, e.test_mode, e.last_error, coalesce(e.sent_at, e.created_at) AS at, o.reference, o.id AS order_id
         FROM conversion_events e JOIN orders o ON o.id = e.order_id
        WHERE o.business_id = $1 AND e.provider = $2 AND e.pixel_id = $3 ORDER BY e.id DESC LIMIT 5`, [req.business.id, p.platform, p.pixel_id]);
    const pages = p.all_pages ? await pagesOf(req.business.id) : p.pages;
    const { rows: hosted } = await pool.query(
      'SELECT id, url, slug, (published_version_id IS NOT NULL) AS published FROM landing_pages WHERE id = ANY($1::bigint[])', [pages.map((x) => x.id)]);
    const urls = Object.fromEntries(hosted.map((h) => {
      const u = h.published && config.publicBaseUrl ? `${config.publicBaseUrl}/p/${h.slug}/` : h.url;
      try { const x = new URL(u); x.searchParams.set('skyfly_debug', '1'); return [h.id, x.toString()]; } catch { return [h.id, null]; }
    }));
    res.set('Cache-Control', 'no-store');
    res.status(status).render('tracking-verify', { active: 'pixels', p, pages, urls, recent, notice, error, SHORT_LABELS, PROVIDERS, X_EVENTS });
  }
  router.get('/:id/verify', asyncHandler(async (req, res) => {
    const p = await load(req);
    if (!p) return res.status(404).render('error', { message: 'Tracking ID not found.' });
    await verifyPage(req, res, p);
  }));
  // The owner confirms, after checking in the platform's own test tool, that events arrive (Skyfly can't see inside the platform).
  router.post('/:id/browser-verified', asyncHandler(async (req, res) => {
    const p = await load(req);
    if (!p) return res.status(404).render('error', { message: 'Tracking ID not found.' });
    const verified = req.body.verified === 'true';
    await pool.query(`UPDATE tracking_pixels SET browser_verified_at = ${verified ? 'now()' : 'NULL'}, browser_verified_by = $3 WHERE id = $1 AND business_id = $2`, [p.id, req.business.id, req.session.userId]);
    await audit(pool, req, { action: verified ? 'tracking.browser_verified' : 'tracking.browser_unverified', businessId: req.business.id, entityType: 'tracking_pixel', entityId: p.id });
    res.redirect(`${base(res)}/${p.id}/verify`);
  }));
  // A server test Purchase with the test event code (Meta, TikTok): shows in the platform's Test events only.
  router.post('/:id/test', asyncHandler(async (req, res) => {
    const p = await load(req);
    if (!p) return res.status(404).render('error', { message: 'Tracking ID not found.' });
    if (!PROVIDERS.includes(p.platform)) return verifyPage(req, res, p, { error: 'X tracking IDs are checked in the browser (see the steps below).', status: 400 });
    const result = await sendTestEvent(config, p.platform, p, req.business.currency);
    if (result.ok) await markServerVerified(pool, p.id, { test: true });
    else await markVerificationFailed(pool, p.id, result.error);
    await audit(pool, req, { action: 'tracking.test_sent', businessId: req.business.id, entityType: 'tracking_pixel', entityId: p.id, details: { ok: result.ok, error: result.error ?? null } });
    const fresh = await load(req);
    return result.ok
      ? verifyPage(req, res, fresh, { notice: `${SHORT_LABELS[p.platform]} accepted the test Purchase. Check its Test events screen to see it arrive.` })
      : verifyPage(req, res, fresh, { error: `Test failed: ${result.error}`, status: 502 });
  }));

  return router;
}
