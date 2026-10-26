import express, { Router } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { timingSafeEqual } from 'node:crypto';
import { asyncHandler } from '../lib/http.js';
import { createOrder, OrderError, validateOrderInput, isTestName } from '../services/orders.js';
import { recordPurchase } from '../services/pixels.js';
import { maskPhone, whatsappDigits } from '../lib/phone.js';
import { allKnownOrigins, originsForPage } from '../lib/origins.js';
import { hashApiKey } from '../lib/apiKeys.js';
import { subscriptionState } from '../services/tenancy.js';
import { browserConfig, markBrowserSeen } from '../services/pixels.js';
import { confirmVerification } from '../services/orderNotifications.js';
import { validateCheckoutInput, saveCheckout, resumeCheckout, linkOrder } from '../services/checkouts.js';

// Used when a business has no WhatsApp number in Settings.
export const DEFAULT_WHATSAPP = '+2349049206695';

// CORS for the public order API. Preflights are answered for any registered
// page's website; the POST itself is checked against the specific page.
function cors(pool, config) {
  return asyncHandler(async (req, res, next) => {
    const origin = req.headers.origin;
    res.vary('Origin');
    if (origin) {
      const known = await allKnownOrigins(pool, config);
      if (!known.has(origin)) {
        return res.status(403).json({ ok: false, error: 'ORIGIN_NOT_ALLOWED', message: 'This website is not allowed to submit orders.' });
      }
      res.set('Access-Control-Allow-Origin', origin);
      res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
      res.set('Access-Control-Allow-Headers', 'Content-Type');
      res.set('Access-Control-Max-Age', '600');
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });
}

// Server-to-server callers authenticate with "Authorization: Bearer sky_...".
async function apiKeyAuth(pool, req) {
  const header = req.get('authorization') || '';
  const match = header.match(/^Bearer\s+(sky_[A-Za-z0-9_-]{20,})$/);
  if (!match) return null;
  const { rows } = await pool.query(
    'UPDATE api_keys SET last_used_at = now() WHERE key_hash = $1 AND revoked_at IS NULL RETURNING business_id',
    [hashApiKey(match[1])],
  );
  return rows[0] ? { businessId: rows[0].business_id } : false;
}

function baseUrl(req, config) {
  return config.publicBaseUrl || `${req.protocol}://${req.get('host')}`;
}

export function publicRoutes({ pool, config, onOrderSaved = () => {} }) {
  const router = Router();

  // Checkout progress (abandoned checkouts): saved often while a customer fills in an order form, so
  // it has its own, higher rate limit and never uses up the customer's order attempts. Accepts JSON
  // and the text/plain body that navigator.sendBeacon sends when the page is closed.
  const checkouts = Router();
  checkouts.use(cors(pool, config));
  checkouts.use((req, res, next) => { res.set('Cross-Origin-Resource-Policy', 'cross-origin'); next(); });
  checkouts.use(rateLimit({
    windowMs: 10 * 60 * 1000, limit: config.orderRateLimit * 15, keyGenerator: (req) => ipKeyGenerator(req.ip),
    standardHeaders: 'draft-7', legacyHeaders: false, skip: (req) => req.method === 'OPTIONS',
    handler: (req, res) => res.status(429).json({ ok: false, error: 'RATE_LIMITED' }),
  }));
  checkouts.use(express.json({ limit: '20kb' }), express.text({ limit: '20kb', type: 'text/plain' }));
  checkouts.post('/', asyncHandler(async (req, res) => {
    if (!req.headers.origin) return res.status(401).json({ ok: false, error: 'UNAUTHORIZED' });
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch { return res.status(400).json({ ok: false, error: 'BAD_REQUEST' }); } }
    if (typeof body?.website === 'string' && body.website.trim() !== '') return res.status(400).json({ ok: false, error: 'VALIDATION' });
    try {
      const { rows: [dest] } = await pool.query('SELECT order_destination FROM landing_pages WHERE slug = $1', [String(body?.landingPage ?? '').toLowerCase()]);
      if (dest?.order_destination === 'whatsapp') return res.json({ ok: true, ended: true });
      res.json(await saveCheckout(pool, validateCheckoutInput(body), { origin: req.headers.origin }, config));
    } catch (err) {
      if (err instanceof OrderError) return res.status(err.status).json({ ok: false, error: err.code });
      throw err;
    }
  }));
  // Resume link (?skyfly_checkout=…): the page and the chosen products only, never personal details.
  checkouts.get('/:token', asyncHandler(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const r = await resumeCheckout(pool, req.params.token);
    if (!r) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
    res.json({ ok: true, ...r });
  }));
  checkouts.use((err, req, res, next) => {
    const status = err.type === 'entity.parse.failed' || err.type === 'entity.too.large' ? 400 : 500;
    if (status === 500) console.error('Checkout API error:', err.message);
    res.status(status).json({ ok: false, error: status === 400 ? 'BAD_REQUEST' : 'SERVER_ERROR' });
  });
  router.use('/api/public/checkouts', checkouts);

  // "Browser tag loaded": a published page reports which tracking IDs' scripts loaded on it (text/plain
  // from navigator.sendBeacon). Only that page's business's IDs that track that page are updated; a
  // website not registered for the page is refused.
  const seen = Router();
  seen.use(cors(pool, config));
  seen.use(rateLimit({ windowMs: 10 * 60 * 1000, limit: config.orderRateLimit * 15, keyGenerator: (req) => ipKeyGenerator(req.ip), standardHeaders: 'draft-7', legacyHeaders: false, skip: (req) => req.method === 'OPTIONS', handler: (req, res) => res.status(429).json({ ok: false }) }));
  seen.use(express.text({ limit: '10kb', type: 'text/plain' }), express.json({ limit: '10kb' }));
  seen.post('/', asyncHandler(async (req, res) => {
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch { return res.status(400).json({ ok: false }); } }
    const { rows: [page] } = await pool.query(
      `SELECT lp.id, lp.slug, lp.business_id, lp.url, lp.custom_domain, (lp.published_version_id IS NOT NULL) AS hosted, b.subdomain AS business_subdomain
         FROM landing_pages lp JOIN businesses b ON b.id = lp.business_id WHERE lp.slug = $1 AND lp.status = 'active'`, [String(body?.page ?? '').toLowerCase()]);
    if (!page || !originsForPage(page, config).has(req.headers.origin)) return res.status(403).json({ ok: false });
    await markBrowserSeen(pool, page, body?.pixels);
    res.json({ ok: true });
  }));
  router.use('/api/public/pixels-seen', seen);

  const api = Router();
  api.use(cors(pool, config));
  // Cross-origin responses must be readable by the landing page.
  api.use((req, res, next) => { res.set('Cross-Origin-Resource-Policy', 'cross-origin'); next(); });
  api.use(rateLimit({
    windowMs: 10 * 60 * 1000,
    // Always counted per IP (made-up keys can't buy extra attempts); servers using an
    // API key send many customers' orders from one IP, so they get a higher allowance.
    limit: (req) => (req.get('authorization') ? config.orderRateLimit * 15 : config.orderRateLimit),
    keyGenerator: (req) => ipKeyGenerator(req.ip),
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skip: (req) => req.method === 'OPTIONS',
    handler: (req, res) => res.status(429).json({
      ok: false, error: 'RATE_LIMITED', message: 'Too many attempts. Please wait a few minutes and try again.',
    }),
  }));
  api.use(express.json({ limit: '20kb' }));

  api.post('/orders', asyncHandler(async (req, res) => {
    // Honeypot field: real customers never see or fill it.
    if (typeof req.body?.website === 'string' && req.body.website.trim() !== '') {
      return res.status(400).json({ ok: false, error: 'VALIDATION', message: 'Your order could not be submitted.' });
    }
    try {
      const key = await apiKeyAuth(pool, req);
      if (key === false) return res.status(401).json({ ok: false, error: 'UNAUTHORIZED', message: 'Invalid or revoked API key.' });
      if (key) {
        // The business API (API keys) is part of the client's subscription.
        const { rows: [b] } = await pool.query(
          'SELECT subscription_status, subscription_expires_on, (now() AT TIME ZONE timezone)::date::text AS local_today FROM businesses WHERE id = $1', [key.businessId]);
        if (!subscriptionState(b).open) return res.status(402).json({ ok: false, error: 'SUBSCRIPTION_INACTIVE', message: 'This Skyfly account is not active. Contact the Skyfly team to renew.' });
      }
      if (!key && !req.headers.origin) {
        return res.status(401).json({ ok: false, error: 'UNAUTHORIZED', message: 'Browser requests must come from a registered website; server requests need an API key.' });
      }
      const input = validateOrderInput(req.body);
      // A page set to "WhatsApp direct" takes orders as WhatsApp conversations, not in Skyfly.
      const { rows: [dest] } = await pool.query('SELECT order_destination FROM landing_pages WHERE slug = $1', [input.landingPage ?? '']);
      if (!key && dest?.order_destination === 'whatsapp') {
        return res.status(409).json({ ok: false, error: 'WHATSAPP_ONLY', message: 'This page takes orders on WhatsApp. Please use the WhatsApp button.' });
      }
      const client = { ip: req.ip, userAgent: (req.get('user-agent') || '').slice(0, 400) };
      const { order, replayed } = await createOrder(pool, input, { ...(key || { origin: req.headers.origin }), client }, config);
      // The checkout session this order completes (same business only; a retry changes nothing).
      await linkOrder(pool, order.id, { checkoutId: typeof req.body?.checkoutId === 'string' ? req.body.checkoutId : null })
        .catch((err) => console.error('Checkout link error:', err.message));
      if (!replayed) {
        onOrderSaved(order.id);
        recordPurchase(pool, config, order.id, { trigger: 'saved' }).catch((err) => console.error('Purchase event error:', err.message));
      }
      // Reached only after the order is committed: the reply is the proof of a saved order.
      const { rows: [biz] } = await pool.query(
        'SELECT b.slug, b.name, b.whatsapp_number FROM orders o JOIN businesses b ON b.id = o.business_id WHERE o.id = $1', [order.id]);
      const { rows: lines } = await pool.query(
        'SELECT product_name, quantity, line_total_minor, is_upsell, options FROM order_items WHERE order_id = $1 ORDER BY id', [order.id]);
      // The business's own WhatsApp number (the Larose default for Larose only), with the order reference prefilled.
      const number = biz.whatsapp_number || (biz.slug === 'larose-nigeria' ? DEFAULT_WHATSAPP : null);
      res.status(replayed ? 200 : 201).json({
        ok: true,
        saved: true,
        reference: order.reference,
        business: biz.slug,
        // Same ID for the browser pixel and the server event, so the platform counts one purchase.
        purchaseEventId: `purchase_${order.reference}`,
        total: Number(order.total_minor) / 100,
        deliveryFee: Number(order.delivery_fee_minor ?? 0) / 100,
        currency: order.currency,
        confirmationUrl: `${baseUrl(req, config)}/o/${order.reference}?t=${order.access_token}`,
        // What Skyfly saved and priced (packages and any add-on), for the page's thank-you message.
        items: lines.map((l) => ({ name: l.product_name, quantity: l.quantity, total: Number(l.line_total_minor) / 100, upsell: l.is_upsell, options: l.options ?? null })),
        // "Checkout + WhatsApp" pages show an optional WhatsApp button after the save; "Checkout" pages none.
        whatsappUrl: number && dest?.order_destination !== 'checkout' ? `https://wa.me/${whatsappDigits(number)}?text=${encodeURIComponent(`Hi ${biz.name}! I just placed order ${order.reference}. Please confirm my order. Thank you!`)}` : null,
        replayed,
        // Test orders ("TEST ORDER …", or any order from a page in test mode) are never counted as purchases.
        test: Boolean(order.is_test) || isTestName(input.customer.name),
      });
    } catch (err) {
      if (err instanceof OrderError) {
        return res.status(err.status).json({ ok: false, error: err.code, message: err.message, ...err.details });
      }
      throw err;
    }
  }));

  // JSON errors for the API (malformed JSON, database down) so the form can show a retry message.
  api.use((err, req, res, next) => {
    const status = err.type === 'entity.parse.failed' || err.type === 'entity.too.large' ? 400 : 500;
    if (status === 500) console.error('Order API error:', err.message);
    res.status(status).json({
      ok: false,
      error: status === 400 ? 'BAD_REQUEST' : 'SERVER_ERROR',
      message: 'We could not save your order. Please try again in a moment.',
    });
  });

  // Public, read-only tracking settings for a page (pixel IDs are public anyway; no secrets).
  router.get('/api/public/pages/:slug/tracking', asyncHandler(async (req, res) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Cross-Origin-Resource-Policy', 'cross-origin');
    res.set('Cache-Control', 'public, max-age=60');
    const { rows: [page] } = await pool.query(
      "SELECT id, slug, business_id FROM landing_pages WHERE slug = $1 AND status = 'active'", [String(req.params.slug)],
    );
    if (!page) return res.status(404).json({ page: req.params.slug, pixels: [] });
    res.json(await browserConfig(pool, page, config));
  }));

  // Public catalog for the drop-in checkout: the page's active products and Skyfly's prices
  // (shown to the customer; the order is priced again by Skyfly when it is saved).
  router.get('/api/public/pages/:slug/catalog', asyncHandler(async (req, res) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Cross-Origin-Resource-Policy', 'cross-origin');
    res.set('Cache-Control', 'public, max-age=60');
    const { rows: [page] } = await pool.query(
      `SELECT lp.id, lp.slug, lp.upsell_headline, lp.upsell_text, lp.order_destination, b.currency, b.whatsapp_number, b.slug AS business_slug,
              b.delivery_fee_minor, b.free_delivery_from_minor,
              u.code AS upsell_code, u.name AS upsell_name, u.price_minor AS upsell_price, u.compare_at_price_minor AS upsell_compare_at
         FROM landing_pages lp JOIN businesses b ON b.id = lp.business_id
         LEFT JOIN products u ON u.id = lp.upsell_product_id AND u.active AND u.business_id = lp.business_id
        WHERE lp.slug = $1 AND lp.status = 'active'`, [String(req.params.slug)]);
    if (!page) return res.status(404).json({ page: req.params.slug, products: [] });
    const { rows } = await pool.query(
      `SELECT p.code, p.name, p.price_minor, p.description, p.compare_at_price_minor, p.options FROM products p JOIN landing_page_products lpp ON lpp.product_id = p.id
        WHERE lpp.landing_page_id = $1 AND p.active ORDER BY p.sort_order, p.id`, [page.id]);
    const number = page.whatsapp_number || (page.business_slug === 'larose-nigeria' ? DEFAULT_WHATSAPP : null);
    res.json({
      page: page.slug, currency: page.currency, whatsapp: number ? whatsappDigits(number) : null,
      // whatsapp = the button opens a WhatsApp conversation (no order in Skyfly); checkout /
      // checkout_whatsapp = Skyfly's checkout (with an optional WhatsApp button after the save).
      destination: page.order_destination,
      products: rows.map((p) => ({
        code: p.code, name: p.name, price: Number(p.price_minor) / 100,
        ...(p.description ? { description: p.description } : {}),
        ...(p.compare_at_price_minor && Number(p.compare_at_price_minor) > Number(p.price_minor) ? { compareAt: Number(p.compare_at_price_minor) / 100 } : {}),
        ...(p.options?.length ? { options: p.options.map((g) => ({ name: g.name, values: g.values.map((v) => ({ label: v.label, delta: v.delta_minor / 100 })) })) } : {}),
      })),
      // Delivery fee (0 = free), free from this subtotal when set. Skyfly charges it again when saving.
      delivery: { fee: Number(page.delivery_fee_minor) / 100, freeFrom: page.free_delivery_from_minor === null ? null : Number(page.free_delivery_from_minor) / 100 },
      // Optional add-on offered at checkout (null when none is set). Skyfly prices it again on saving.
      upsell: page.upsell_code ? {
        code: page.upsell_code, name: page.upsell_name, price: Number(page.upsell_price) / 100,
        // The usual price, shown crossed out (only when higher than the add-on price).
        ...(page.upsell_compare_at && Number(page.upsell_compare_at) > Number(page.upsell_price) ? { compareAt: Number(page.upsell_compare_at) / 100 } : {}),
        headline: page.upsell_headline || `Add ${page.upsell_name}`, text: page.upsell_text || '',
      } : null,
    });
  }));

  router.use('/api/public', api);

  // Customer confirmation page. The secret token in the link keeps orders private.
  router.get('/o/:reference', asyncHandler(async (req, res) => {
    const { rows } = await pool.query(
      `SELECT o.id, o.reference, o.access_token, o.customer_name, o.phone, o.state, o.address, o.currency, o.delivery_fee_minor,
              o.total_minor, o.created_at, b.name AS business_name, b.whatsapp_number, b.slug AS business_slug
         FROM orders o JOIN businesses b ON b.id = o.business_id
        WHERE o.reference = $1`,
      [String(req.params.reference).toUpperCase()],
    );
    const order = rows[0];
    const token = Buffer.from(String(req.query.t ?? ''));
    const expected = Buffer.from(order?.access_token ?? '');
    if (!order || token.length !== expected.length || !timingSafeEqual(token, expected)) {
      return res.status(404).render('error', { message: 'Order not found.' });
    }
    const items = await pool.query(
      'SELECT product_name, quantity, unit_price_minor, line_total_minor, is_upsell FROM order_items WHERE order_id = $1 ORDER BY id',
      [order.id],
    );
    const firstName = order.customer_name.split(' ')[0];
    const waText = `Hi ${order.business_name}! I just placed order ${order.reference}. Please confirm my order. Thank you!`;
    // Each business's own number only; the Larose default applies to the Larose business alone.
    const number = order.whatsapp_number || (order.business_slug === 'larose-nigeria' ? DEFAULT_WHATSAPP : null);
    const waUrl = number ? `https://wa.me/${whatsappDigits(number)}?text=${encodeURIComponent(waText)}` : null;

    res.set('Cache-Control', 'no-store');
    res.set('Referrer-Policy', 'no-referrer');
    res.render('confirmation', {
      order, items: items.rows, firstName, waUrl, maskedPhone: maskPhone(order.phone),
    });
  }));

  // Unsubscribe from a business's emails. The link's token identifies the contact. Opening the
  // link shows a confirm button (so mail scanners don't unsubscribe people); mail apps use the
  // one-click POST (List-Unsubscribe-Post).
  const unsubscribe = async (token) => {
    if (!/^[0-9a-f]{64}$/.test(String(token))) return null;
    const { rows: [c] } = await pool.query(
      `SELECT c.id, c.business_id, c.unsubscribed_at, b.name AS business_name FROM email_contacts c JOIN businesses b ON b.id = c.business_id
        WHERE c.unsubscribe_token = $1`, [token]);
    return c ?? null;
  };
  // Order-notification address check: the link opens a page, and only its button confirms
  // (so email scanners that open links can't confirm an address by themselves).
  router.get('/notify/verify/:token', (req, res) => {
    if (!/^[A-Za-z0-9_-]{20,64}$/.test(req.params.token)) return res.status(404).render('error', { message: 'This link is not valid.' });
    res.set('Cache-Control', 'no-store');
    res.render('notify-verify', { token: req.params.token, done: null });
  });
  router.post('/notify/verify/:token', express.urlencoded({ extended: false, limit: '1kb' }), asyncHandler(async (req, res) => {
    const done = await confirmVerification(pool, req.params.token);
    if (!done) return res.status(404).render('error', { message: 'This link is not valid any more (it works once, for 48 hours). Send a new one from Settings → Order notifications.' });
    res.set('Cache-Control', 'no-store');
    res.render('notify-verify', { token: null, done });
  }));

  router.get('/u/:token', asyncHandler(async (req, res) => {
    const c = await unsubscribe(req.params.token);
    if (!c) return res.status(404).render('error', { message: 'This unsubscribe link is not valid.' });
    res.set('Cache-Control', 'no-store');
    res.render('unsubscribe', { c, token: req.params.token, done: Boolean(c.unsubscribed_at) });
  }));
  router.post('/u/:token', express.urlencoded({ extended: false, limit: '2kb' }), asyncHandler(async (req, res) => {
    const c = await unsubscribe(req.params.token);
    if (!c) return res.status(404).render('error', { message: 'This unsubscribe link is not valid.' });
    if (!c.unsubscribed_at) {
      await pool.query('UPDATE email_contacts SET unsubscribed_at = now(), marketing_consent = false, updated_at = now() WHERE id = $1', [c.id]);
      // Anything still queued for this person is skipped.
      await pool.query("UPDATE email_messages SET status = 'skipped', reason = 'Contact unsubscribed', updated_at = now() WHERE contact_id = $1 AND status = 'queued'", [c.id]);
      await pool.query("INSERT INTO audit_log (business_id, action, entity_type, entity_id) VALUES ($1, 'contact.unsubscribed', 'contact', $2)", [c.business_id, String(c.id)]);
    }
    if (req.body?.['List-Unsubscribe'] === 'One-Click') return res.status(200).send('Unsubscribed');
    res.render('unsubscribe', { c, token: req.params.token, done: true });
  }));

  return router;
}
