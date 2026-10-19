import express, { Router } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { timingSafeEqual } from 'node:crypto';
import { asyncHandler } from '../lib/http.js';
import { createOrder, OrderError, validateOrderInput, isTestName } from '../services/orders.js';
import { recordPurchase } from '../services/pixels.js';
import { maskPhone, whatsappDigits } from '../lib/phone.js';
import { allKnownOrigins } from '../lib/origins.js';
import { hashApiKey } from '../lib/apiKeys.js';
import { subscriptionState } from '../services/tenancy.js';
import { browserConfig } from '../services/pixels.js';

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
      const client = { ip: req.ip, userAgent: (req.get('user-agent') || '').slice(0, 400) };
      const { order, replayed } = await createOrder(pool, input, { ...(key || { origin: req.headers.origin }), client }, config);
      if (!replayed) {
        onOrderSaved(order.id);
        recordPurchase(pool, config, order.id, { trigger: 'saved' }).catch((err) => console.error('Purchase event error:', err.message));
      }
      // Reached only after the order is committed: the reply is the proof of a saved order.
      const { rows: [biz] } = await pool.query(
        'SELECT b.slug, b.name, b.whatsapp_number FROM orders o JOIN businesses b ON b.id = o.business_id WHERE o.id = $1', [order.id]);
      const { rows: lines } = await pool.query(
        'SELECT product_name, quantity, line_total_minor, is_upsell FROM order_items WHERE order_id = $1 ORDER BY id', [order.id]);
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
        currency: order.currency,
        confirmationUrl: `${baseUrl(req, config)}/o/${order.reference}?t=${order.access_token}`,
        // What Skyfly saved and priced (packages and any add-on), for the page's thank-you message.
        items: lines.map((l) => ({ name: l.product_name, quantity: l.quantity, total: Number(l.line_total_minor) / 100, upsell: l.is_upsell })),
        whatsappUrl: number ? `https://wa.me/${whatsappDigits(number)}?text=${encodeURIComponent(`Hi ${biz.name}! I just placed order ${order.reference}. Please confirm my order. Thank you!`)}` : null,
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
      `SELECT lp.id, lp.slug, lp.upsell_headline, lp.upsell_text, b.currency, b.whatsapp_number, b.slug AS business_slug,
              u.code AS upsell_code, u.name AS upsell_name, u.price_minor AS upsell_price
         FROM landing_pages lp JOIN businesses b ON b.id = lp.business_id
         LEFT JOIN products u ON u.id = lp.upsell_product_id AND u.active AND u.business_id = lp.business_id
        WHERE lp.slug = $1 AND lp.status = 'active'`, [String(req.params.slug)]);
    if (!page) return res.status(404).json({ page: req.params.slug, products: [] });
    const { rows } = await pool.query(
      `SELECT p.code, p.name, p.price_minor FROM products p JOIN landing_page_products lpp ON lpp.product_id = p.id
        WHERE lpp.landing_page_id = $1 AND p.active ORDER BY p.sort_order, p.id`, [page.id]);
    const number = page.whatsapp_number || (page.business_slug === 'larose-nigeria' ? DEFAULT_WHATSAPP : null);
    res.json({
      page: page.slug, currency: page.currency, whatsapp: number ? whatsappDigits(number) : null,
      products: rows.map((p) => ({ code: p.code, name: p.name, price: Number(p.price_minor) / 100 })),
      // Optional add-on offered at checkout (null when none is set). Skyfly prices it again on saving.
      upsell: page.upsell_code ? {
        code: page.upsell_code, name: page.upsell_name, price: Number(page.upsell_price) / 100,
        headline: page.upsell_headline || `Add ${page.upsell_name}`, text: page.upsell_text || '',
      } : null,
    });
  }));

  router.use('/api/public', api);

  // Customer confirmation page. The secret token in the link keeps orders private.
  router.get('/o/:reference', asyncHandler(async (req, res) => {
    const { rows } = await pool.query(
      `SELECT o.id, o.reference, o.access_token, o.customer_name, o.phone, o.state, o.address, o.currency,
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
