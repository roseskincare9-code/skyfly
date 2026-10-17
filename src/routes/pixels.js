import { Router } from 'express';
import { asyncHandler } from '../lib/http.js';
import { audit } from '../lib/audit.js';
import { encrypt } from '../lib/secrets.js';
import { parsePixelCode } from '../services/pixelCode.js';
import { BROWSER_EVENTS, PIXEL_ID_RULES, PROVIDERS, sendTestEvent, markServerVerified, effectiveSettings } from '../services/pixels.js';

const LABELS = { meta: 'Meta Pixel (Facebook / Instagram)', tiktok: 'TikTok Pixel' };

export function pixelRoutes({ pool, config }) {
  const router = Router({ mergeParams: true });

  async function scope(req) {
    const raw = String(req.query.page ?? req.body?.page ?? '');
    if (!/^\d+$/.test(raw)) return { page: null };
    const { rows: [page] } = await pool.query('SELECT id, name, slug FROM landing_pages WHERE id = $1 AND business_id = $2', [raw, req.business.id]);
    return { page: page ?? null };
  }

  async function render(req, res, { page, error = null, notice = null, status = 200, form = null }) {
    const { rows } = await pool.query(
      `SELECT * FROM pixel_settings WHERE business_id = $1 AND landing_page_id ${page ? '= $2' : 'IS NULL'}`,
      page ? [req.business.id, page.id] : [req.business.id],
    );
    const settings = Object.fromEntries(PROVIDERS.map((p) => [p, rows.find((r) => r.provider === p) ?? null]));
    const { rows: pages } = await pool.query(
      `SELECT lp.id, lp.name, lp.status, (SELECT array_agg(provider) FROM pixel_settings ps WHERE ps.landing_page_id = lp.id) AS overrides
         FROM landing_pages lp WHERE lp.business_id = $1 AND lp.status <> 'archived' ORDER BY lp.name`,
      [req.business.id],
    );
    const { rows: recent } = await pool.query(
      `SELECT e.provider, e.status, e.event_name, e.last_error, e.created_at, e.sent_at, o.reference, o.id AS order_id
         FROM conversion_events e JOIN orders o ON o.id = e.order_id WHERE o.business_id = $1 ORDER BY e.id DESC LIMIT 10`,
      [req.business.id],
    );
    // A Skyfly-owned business without its own Meta pixel uses Skyfly's (set on the server).
    const { meta: inUse } = await effectiveSettings(pool, req.business.id, page?.id, config);
    const skyflyPixel = inUse?.platform ? inUse : null;
    res.set('Cache-Control', 'no-store');
    res.status(status).render('pixels', {
      active: 'pixels', page, settings, skyflyPixel, pages, recent, error, notice, form, LABELS, PROVIDERS, BROWSER_EVENTS, PIXEL_ID_RULES,
      encryptionReady: Boolean(config.encryptionKey),
    });
  }

  router.get('/', asyncHandler(async (req, res) => {
    const { page } = await scope(req);
    const notice = { saved: 'Saved.', removed: 'Page now uses the business defaults.', deleted: 'Pixel removed.' }[req.query.done] ?? null;
    await render(req, res, { page, notice });
  }));

  router.post('/', asyncHandler(async (req, res) => {
    const { page } = await scope(req);
    const provider = String(req.body.provider);
    if (!PROVIDERS.includes(provider)) return res.status(400).render('error', { message: 'Unknown provider.' });

    const rule = PIXEL_ID_RULES[provider];
    // Two ways to install: type the Pixel ID, or paste the platform's base code.
    // Pasted code is only read for its Pixel ID; it is never stored or run.
    const installMethod = req.body.install_method === 'code' ? 'code' : 'id';
    let pixelId = String(req.body.pixel_id ?? '').trim().replace(/\s/g, '');
    if (installMethod === 'code') {
      const pasted = String(req.body.pixel_code ?? '').trim();
      const { rows: [current] } = await pool.query(
        `SELECT pixel_id, install_method FROM pixel_settings WHERE business_id = $1 AND provider = $2 AND landing_page_id ${page ? '= $3' : 'IS NULL'}`,
        page ? [req.business.id, provider, page.id] : [req.business.id, provider],
      );
      if (!pasted && current?.install_method === 'code' && current.pixel_id) {
        pixelId = current.pixel_id; // editing other settings: keep the pixel taken from the code saved earlier
      } else {
        const parsed = parsePixelCode(provider, pasted);
        if (parsed.error) return render(req, res, { page, error: parsed.error, status: 400, form: { provider, method: 'code' } });
        pixelId = parsed.pixelId;
      }
    }
    const normalizedId = provider === 'tiktok' ? pixelId.toUpperCase() : pixelId;
    const enabled = req.body.enabled === 'on';
    const events = [].concat(req.body.events ?? []).filter((e) => BROWSER_EVENTS.includes(e));
    const serverPurchase = req.body.server_purchase === 'on';
    const token = String(req.body.access_token ?? '').trim();
    const testCode = String(req.body.test_event_code ?? '').trim();
    const errors = [];
    if (normalizedId && !rule.re.test(normalizedId)) errors.push(`The ${LABELS[provider]} ID should be ${rule.hint}.`);
    if (enabled && !normalizedId) errors.push('Enter the pixel ID before turning it on.');
    if (token && (!/^[\x21-\x7e]{20,1000}$/.test(token))) errors.push('That access token does not look right. Copy it again from the ad platform.');
    if (token && !config.encryptionKey) errors.push('Access tokens can\'t be stored until SKYFLY_ENCRYPTION_KEY is set on the server.');
    if (testCode && !/^[A-Za-z0-9_-]{3,40}$/.test(testCode)) errors.push('The test event code should be letters and numbers, e.g. TEST12345.');
    if (errors.length) return render(req, res, { page, error: errors.join(' '), status: 400, form: { provider, method: installMethod } });

    const { rows: [existing] } = await pool.query(
      `SELECT id, access_token_enc, pixel_id FROM pixel_settings WHERE business_id = $1 AND provider = $2 AND landing_page_id ${page ? '= $3' : 'IS NULL'}`,
      page ? [req.business.id, provider, page.id] : [req.business.id, provider],
    );
    // The token is write-only: blank keeps the saved one; "remove" clears it.
    let tokenEnc = existing?.access_token_enc ?? null;
    if (req.body.remove_token === 'on') tokenEnc = null;
    else if (token) tokenEnc = encrypt(config.encryptionKey, token);
    if (serverPurchase && !tokenEnc) {
      return render(req, res, { page, error: 'Server-side Purchase needs an access token. Add the token or turn that option off.', status: 400 });
    }

    const values = [normalizedId || null, enabled, events, serverPurchase, tokenEnc, testCode || null, req.session.userId, installMethod];
    if (existing) {
      // Verification belongs to a specific pixel and token: changing them means verifying again.
      const idChanged = (existing.pixel_id ?? null) !== (normalizedId || null);
      const tokenChanged = tokenEnc !== existing.access_token_enc;
      await pool.query(
        `UPDATE pixel_settings SET pixel_id = $1, enabled = $2, events = $3, server_purchase = $4, access_token_enc = $5,
                test_event_code = $6, updated_by = $7, install_method = $8, updated_at = now(),
                server_verified_at = CASE WHEN $10 OR $11 THEN NULL ELSE server_verified_at END,
                browser_verified_at = CASE WHEN $10 THEN NULL ELSE browser_verified_at END
          WHERE id = $9`,
        [...values, existing.id, idChanged, tokenChanged],
      );
    } else {
      await pool.query(
        `INSERT INTO pixel_settings (pixel_id, enabled, events, server_purchase, access_token_enc, test_event_code, updated_by, install_method, business_id, landing_page_id, provider)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [...values, req.business.id, page?.id ?? null, provider],
      );
    }
    await audit(pool, req, {
      action: 'pixel.updated', businessId: req.business.id, entityType: 'pixel', entityId: `${provider}${page ? `:page:${page.id}` : ''}`,
      details: { pixelId: normalizedId || null, installMethod, enabled, events, serverPurchase, tokenChanged: Boolean(token) || req.body.remove_token === 'on' },
    });
    res.redirect(`${res.locals.base}/pixels?${page ? `page=${page.id}&` : ''}done=saved`);
  }));

  // Deletes one platform's pixel (and its encrypted token) for this scope.
  router.post('/remove', asyncHandler(async (req, res) => {
    const { page } = await scope(req);
    const provider = String(req.body.provider);
    if (!PROVIDERS.includes(provider)) return res.status(400).render('error', { message: 'Unknown provider.' });
    const { rows: [removed] } = await pool.query(
      `DELETE FROM pixel_settings WHERE business_id = $1 AND provider = $2 AND landing_page_id ${page ? '= $3' : 'IS NULL'} RETURNING pixel_id`,
      page ? [req.business.id, provider, page.id] : [req.business.id, provider],
    );
    if (removed) {
      await audit(pool, req, {
        action: 'pixel.removed', businessId: req.business.id, entityType: 'pixel', entityId: `${provider}${page ? `:page:${page.id}` : ''}`,
        details: { pixelId: removed.pixel_id },
      });
    }
    res.redirect(`${res.locals.base}/pixels?${page ? `page=${page.id}&` : ''}done=deleted`);
  }));

  router.post('/remove-override', asyncHandler(async (req, res) => {
    const { page } = await scope(req);
    if (!page) return res.status(404).render('error', { message: 'Landing page not found.' });
    await pool.query('DELETE FROM pixel_settings WHERE landing_page_id = $1 AND business_id = $2', [page.id, req.business.id]);
    await audit(pool, req, { action: 'pixel.override_removed', businessId: req.business.id, entityType: 'landing_page', entityId: page.id });
    res.redirect(`${res.locals.base}/pixels?page=${page.id}&done=removed`);
  }));

  // Skyfly can't see inside Meta/TikTok, so browser events are verified by the owner
  // with the platform's own tools, and recorded here with who and when.
  router.post('/browser-verified', asyncHandler(async (req, res) => {
    const { page } = await scope(req);
    const provider = String(req.body.provider);
    if (!PROVIDERS.includes(provider)) return res.status(400).render('error', { message: 'Unknown provider.' });
    const verified = req.body.verified === 'true';
    const { rowCount } = await pool.query(
      `UPDATE pixel_settings SET browser_verified_at = ${verified ? 'now()' : 'NULL'}, browser_verified_by = $1
        WHERE business_id = $2 AND provider = $3 AND enabled AND pixel_id IS NOT NULL AND landing_page_id ${page ? '= $4' : 'IS NULL'}`,
      page ? [req.session.userId, req.business.id, provider, page.id] : [req.session.userId, req.business.id, provider],
    );
    if (!rowCount) return render(req, res, { page, error: 'Turn the pixel on and save its ID first.', status: 400 });
    await audit(pool, req, { action: verified ? 'pixel.browser_verified' : 'pixel.browser_unverified', businessId: req.business.id, entityType: 'pixel', entityId: provider });
    res.redirect(`${res.locals.base}/pixels?${page ? `page=${page.id}&` : ''}done=saved`);
  }));

  router.post('/test', asyncHandler(async (req, res) => {
    const { page } = await scope(req);
    const provider = String(req.body.provider);
    if (!PROVIDERS.includes(provider)) return res.status(400).render('error', { message: 'Unknown provider.' });
    const { rows: [s] } = await pool.query(
      `SELECT * FROM pixel_settings WHERE business_id = $1 AND provider = $2 AND landing_page_id ${page ? '= $3' : 'IS NULL'}`,
      page ? [req.business.id, provider, page.id] : [req.business.id, provider],
    );
    const result = await sendTestEvent(config, provider, s, req.business.currency);
    if (result.ok) await markServerVerified(pool, s.id);
    await audit(pool, req, { action: 'pixel.test_sent', businessId: req.business.id, entityType: 'pixel', entityId: provider, details: { ok: result.ok, error: result.error ?? null } });
    const message = result.ok
      ? `Test Purchase accepted by ${LABELS[provider]}. Check the "Test events" screen in the ad platform to confirm it arrived.`
      : `Test failed: ${result.error}`;
    await render(req, res, { page, notice: result.ok ? message : null, error: result.ok ? null : message, status: result.ok ? 200 : 502 });
  }));

  return router;
}
