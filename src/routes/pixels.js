import { Router } from 'express';
import { asyncHandler } from '../lib/http.js';
import { audit } from '../lib/audit.js';
import { encrypt } from '../lib/secrets.js';
import { BROWSER_EVENTS, PIXEL_ID_RULES, PROVIDERS, sendTestEvent } from '../services/pixels.js';

const LABELS = { meta: 'Meta Pixel (Facebook / Instagram)', tiktok: 'TikTok Pixel' };

export function pixelRoutes({ pool, config }) {
  const router = Router({ mergeParams: true });

  async function scope(req) {
    const raw = String(req.query.page ?? req.body?.page ?? '');
    if (!/^\d+$/.test(raw)) return { page: null };
    const { rows: [page] } = await pool.query('SELECT id, name, slug FROM landing_pages WHERE id = $1 AND business_id = $2', [raw, req.business.id]);
    return { page: page ?? null };
  }

  async function render(req, res, { page, error = null, notice = null, status = 200 }) {
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
    res.set('Cache-Control', 'no-store');
    res.status(status).render('pixels', {
      active: 'pixels', page, settings, pages, recent, error, notice, LABELS, PROVIDERS, BROWSER_EVENTS, PIXEL_ID_RULES,
      encryptionReady: Boolean(config.encryptionKey),
    });
  }

  router.get('/', asyncHandler(async (req, res) => {
    const { page } = await scope(req);
    const notice = { saved: 'Saved.', removed: 'Page now uses the business defaults.' }[req.query.done] ?? null;
    await render(req, res, { page, notice });
  }));

  router.post('/', asyncHandler(async (req, res) => {
    const { page } = await scope(req);
    const provider = String(req.body.provider);
    if (!PROVIDERS.includes(provider)) return res.status(400).render('error', { message: 'Unknown provider.' });

    const rule = PIXEL_ID_RULES[provider];
    const pixelId = String(req.body.pixel_id ?? '').trim().replace(/\s/g, '');
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
    if (errors.length) return render(req, res, { page, error: errors.join(' '), status: 400 });

    const { rows: [existing] } = await pool.query(
      `SELECT id, access_token_enc FROM pixel_settings WHERE business_id = $1 AND provider = $2 AND landing_page_id ${page ? '= $3' : 'IS NULL'}`,
      page ? [req.business.id, provider, page.id] : [req.business.id, provider],
    );
    // The token is write-only: blank keeps the saved one; "remove" clears it.
    let tokenEnc = existing?.access_token_enc ?? null;
    if (req.body.remove_token === 'on') tokenEnc = null;
    else if (token) tokenEnc = encrypt(config.encryptionKey, token);
    if (serverPurchase && !tokenEnc) {
      return render(req, res, { page, error: 'Server-side Purchase needs an access token. Add the token or turn that option off.', status: 400 });
    }

    const values = [normalizedId || null, enabled, events, serverPurchase, tokenEnc, testCode || null, req.session.userId];
    if (existing) {
      await pool.query(
        `UPDATE pixel_settings SET pixel_id = $1, enabled = $2, events = $3, server_purchase = $4, access_token_enc = $5,
                test_event_code = $6, updated_by = $7, updated_at = now() WHERE id = $8`,
        [...values, existing.id],
      );
    } else {
      await pool.query(
        `INSERT INTO pixel_settings (pixel_id, enabled, events, server_purchase, access_token_enc, test_event_code, updated_by, business_id, landing_page_id, provider)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [...values, req.business.id, page?.id ?? null, provider],
      );
    }
    await audit(pool, req, {
      action: 'pixel.updated', businessId: req.business.id, entityType: 'pixel', entityId: `${provider}${page ? `:page:${page.id}` : ''}`,
      details: { pixelId: normalizedId || null, enabled, events, serverPurchase, tokenChanged: Boolean(token) || req.body.remove_token === 'on' },
    });
    res.redirect(`${res.locals.base}/pixels?${page ? `page=${page.id}&` : ''}done=saved`);
  }));

  router.post('/remove-override', asyncHandler(async (req, res) => {
    const { page } = await scope(req);
    if (!page) return res.status(404).render('error', { message: 'Landing page not found.' });
    await pool.query('DELETE FROM pixel_settings WHERE landing_page_id = $1 AND business_id = $2', [page.id, req.business.id]);
    await audit(pool, req, { action: 'pixel.override_removed', businessId: req.business.id, entityType: 'landing_page', entityId: page.id });
    res.redirect(`${res.locals.base}/pixels?page=${page.id}&done=removed`);
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
    await audit(pool, req, { action: 'pixel.test_sent', businessId: req.business.id, entityType: 'pixel', entityId: provider, details: { ok: result.ok, error: result.error ?? null } });
    const message = result.ok
      ? `Test Purchase accepted by ${LABELS[provider]}. Check the "Test events" screen in the ad platform to confirm it arrived.`
      : `Test failed: ${result.error}`;
    await render(req, res, { page, notice: result.ok ? message : null, error: result.ok ? null : message, status: result.ok ? 200 : 502 });
  }));

  return router;
}
