import express, { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { timingSafeEqual } from 'node:crypto';
import { asyncHandler } from '../lib/http.js';
import { createOrder, OrderError, validateOrderInput } from '../services/orders.js';
import { maskPhone, whatsappDigits } from '../lib/phone.js';

export const DEFAULT_WHATSAPP = '+2347039361243';

// CORS for the public order API: only origins listed in ALLOWED_ORIGINS may call it from a browser.
function cors(allowedOrigins) {
  return (req, res, next) => {
    const origin = req.headers.origin;
    if (origin) {
      if (!allowedOrigins.includes(origin)) {
        return res.status(403).json({ ok: false, error: 'ORIGIN_NOT_ALLOWED', message: 'This website is not allowed to submit orders.' });
      }
      res.set('Access-Control-Allow-Origin', origin);
      res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
      res.set('Access-Control-Allow-Headers', 'Content-Type');
      res.set('Access-Control-Max-Age', '600');
    }
    res.vary('Origin');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  };
}

function baseUrl(req, config) {
  return config.publicBaseUrl || `${req.protocol}://${req.get('host')}`;
}

export function publicRoutes({ pool, config }) {
  const router = Router();

  const api = Router();
  api.use(cors(config.allowedOrigins));
  // Cross-origin responses must be readable by the landing page.
  api.use((req, res, next) => { res.set('Cross-Origin-Resource-Policy', 'cross-origin'); next(); });
  api.use(rateLimit({
    windowMs: 10 * 60 * 1000,
    limit: config.orderRateLimit,
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
      const input = validateOrderInput(req.body);
      const { order, replayed } = await createOrder(pool, input);
      res.status(replayed ? 200 : 201).json({
        ok: true,
        reference: order.reference,
        total: Number(order.total_minor) / 100,
        currency: order.currency,
        confirmationUrl: `${baseUrl(req, config)}/o/${order.reference}?t=${order.access_token}`,
        replayed,
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

  router.use('/api/public', api);

  // Customer confirmation page. The secret token in the link keeps orders private.
  router.get('/o/:reference', asyncHandler(async (req, res) => {
    const { rows } = await pool.query(
      `SELECT o.id, o.reference, o.access_token, o.customer_name, o.phone, o.state, o.address, o.currency,
              o.total_minor, o.created_at, b.name AS business_name, b.whatsapp_number
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
      'SELECT product_name, quantity, unit_price_minor, line_total_minor FROM order_items WHERE order_id = $1 ORDER BY id',
      [order.id],
    );
    const firstName = order.customer_name.split(' ')[0];
    const waText = `Hi ${order.business_name}! I just placed order ${order.reference}. Please confirm my order. Thank you!`;
    const waUrl = `https://wa.me/${whatsappDigits(order.whatsapp_number || DEFAULT_WHATSAPP)}?text=${encodeURIComponent(waText)}`;

    res.set('Cache-Control', 'no-store');
    res.set('Referrer-Policy', 'no-referrer');
    res.render('confirmation', {
      order, items: items.rows, firstName, waUrl, maskedPhone: maskPhone(order.phone),
    });
  }));

  return router;
}
