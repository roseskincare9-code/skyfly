import { createHash } from 'node:crypto';
import { normalizePhone } from '../lib/phone.js';
import { generateReference, generateToken } from '../lib/reference.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const MAX_ITEMS = 10;
const MAX_QUANTITY = 20;

export class OrderError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const str = (v) => (typeof v === 'string' ? v.trim() : '');
const optional = (v, max) => {
  const s = str(v);
  return s ? s.slice(0, max) : null;
};

// Validates untrusted input from a public landing page. Prices are never taken
// from the client; an optional displayed price is only compared to ours.
export function validateOrderInput(body) {
  const fields = {};
  const customer = body?.customer ?? {};

  const name = str(customer.name).replace(/\s+/g, ' ');
  if (name.length < 2 || name.length > 120) fields.name = 'Enter your full name.';

  const phone = normalizePhone(customer.phone);
  if (!phone) fields.phone = 'Enter a valid phone number, e.g. 08012345678.';

  const email = str(customer.email).toLowerCase() || null;
  if (email && (email.length > 200 || !EMAIL_RE.test(email))) fields.email = 'Enter a valid email address or leave it blank.';

  const address = str(customer.address);
  if (address.length < 5 || address.length > 500) fields.address = 'Enter your full delivery address.';

  const state = optional(customer.state, 60);
  const notes = optional(customer.notes, 1000);

  const idempotencyKey = str(body?.idempotencyKey);
  if (!/^[A-Za-z0-9_-]{16,100}$/.test(idempotencyKey)) fields.idempotencyKey = 'Missing submission key. Refresh the page and try again.';

  const rawItems = Array.isArray(body?.items) ? body.items : [];
  const items = [];
  if (rawItems.length === 0 || rawItems.length > MAX_ITEMS) {
    fields.items = 'Select a package.';
  } else {
    const seen = new Set();
    for (const raw of rawItems) {
      const code = str(raw?.product).toLowerCase();
      const quantity = Number(raw?.quantity ?? 1);
      if (!code || seen.has(code)) { fields.items = 'Select a valid package.'; break; }
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QUANTITY) {
        fields.quantity = `Quantity must be between 1 and ${MAX_QUANTITY}.`;
        break;
      }
      const displayed = raw?.unitPrice;
      if (displayed !== undefined && displayed !== null && !(Number.isFinite(Number(displayed)) && Number(displayed) >= 0)) {
        fields.items = 'Select a valid package.';
        break;
      }
      seen.add(code);
      items.push({ code, quantity, displayedPrice: displayed === undefined || displayed === null ? null : Number(displayed) });
    }
  }

  const landingPage = str(body?.landingPage).toLowerCase();
  if (!landingPage) fields.landingPage = 'Missing landing page.';

  if (Object.keys(fields).length > 0) {
    throw new OrderError(400, 'VALIDATION', 'Please check the highlighted details and try again.', { fields });
  }

  const a = body?.attribution ?? {};
  const attribution = {
    sourceUrl: optional(a.pageUrl, 1000),
    referrer: optional(a.referrer, 1000),
    utmSource: optional(a.utm_source, 200),
    utmMedium: optional(a.utm_medium, 200),
    utmCampaign: optional(a.utm_campaign, 200),
    utmContent: optional(a.utm_content, 200),
    utmTerm: optional(a.utm_term, 200),
  };

  return { landingPage, idempotencyKey, customer: { name, phone, email, address, state, notes }, items, attribution };
}

function fingerprint(input) {
  const { customer, items, landingPage } = input;
  const canonical = JSON.stringify([landingPage, customer, items.map((i) => [i.code, i.quantity])]);
  return createHash('sha256').update(canonical).digest('hex');
}

async function loadLandingPage(client, slug) {
  const { rows } = await client.query(
    `SELECT lp.id, lp.business_id, lp.status, b.currency, b.order_prefix
       FROM landing_pages lp JOIN businesses b ON b.id = lp.business_id
      WHERE lp.slug = $1`,
    [slug],
  );
  return rows[0];
}

async function loadPricedItems(client, landingPageId, items) {
  const codes = items.map((i) => i.code);
  const { rows } = await client.query(
    `SELECT p.id, p.code, p.name, p.price_minor
       FROM products p
       JOIN landing_page_products lpp ON lpp.product_id = p.id AND lpp.landing_page_id = $1
      WHERE p.active AND p.code = ANY($2::text[])`,
    [landingPageId, codes],
  );
  const byCode = new Map(rows.map((r) => [r.code, r]));

  return items.map((item) => {
    const product = byCode.get(item.code);
    if (!product) {
      throw new OrderError(400, 'UNKNOWN_PRODUCT', 'That package is no longer available. Please choose another package.', {
        fields: { items: 'This package is not available.' },
      });
    }
    const unit = Number(product.price_minor);
    if (item.displayedPrice !== null && Math.round(item.displayedPrice * 100) !== unit) {
      throw new OrderError(409, 'PRICE_CHANGED', 'The price of this package has changed. Please refresh the page to see the current price.', {
        product: item.code,
      });
    }
    return {
      productId: product.id,
      code: product.code,
      name: product.name,
      unitPrice: unit,
      quantity: item.quantity,
      lineTotal: unit * item.quantity,
    };
  });
}

async function findByIdempotencyKey(client, businessId, key) {
  const { rows } = await client.query(
    `SELECT id, reference, access_token, request_fingerprint, total_minor, currency
       FROM orders WHERE business_id = $1 AND idempotency_key = $2`,
    [businessId, key],
  );
  return rows[0];
}

// Saves an order exactly once per idempotency key. Returns { order, replayed }.
export async function createOrder(pool, input) {
  const print = fingerprint(input);

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const client = await pool.connect();
    try {
      const page = await loadLandingPage(client, input.landingPage);
      if (!page || page.status !== 'active') {
        throw new OrderError(400, 'UNKNOWN_LANDING_PAGE', 'This order form is not accepting orders right now. Please contact us on WhatsApp.');
      }

      const existing = await findByIdempotencyKey(client, page.business_id, input.idempotencyKey);
      if (existing) return replay(existing, print);

      const items = await loadPricedItems(client, page.id, input.items);
      const total = items.reduce((sum, i) => sum + i.lineTotal, 0);
      const { customer: c, attribution: a } = input;

      await client.query('BEGIN');
      const inserted = await client.query(
        `INSERT INTO orders (
           business_id, landing_page_id, reference, access_token, idempotency_key, request_fingerprint,
           customer_name, phone, email, address, state, customer_notes, currency, total_minor,
           source_url, referrer, utm_source, utm_medium, utm_campaign, utm_content, utm_term)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
         ON CONFLICT (business_id, idempotency_key) DO NOTHING
         RETURNING id, reference, access_token, total_minor, currency`,
        [
          page.business_id, page.id, generateReference(page.order_prefix), generateToken(), input.idempotencyKey, print,
          c.name, c.phone, c.email, c.address, c.state, c.notes, page.currency, total,
          a.sourceUrl, a.referrer, a.utmSource, a.utmMedium, a.utmCampaign, a.utmContent, a.utmTerm,
        ],
      );

      if (!inserted.rows[0]) {
        // A concurrent request with the same key committed first.
        await client.query('ROLLBACK');
        return replay(await findByIdempotencyKey(client, page.business_id, input.idempotencyKey), print);
      }

      const order = inserted.rows[0];
      for (const item of items) {
        await client.query(
          `INSERT INTO order_items (order_id, product_id, product_code, product_name, unit_price_minor, quantity, line_total_minor)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [order.id, item.productId, item.code, item.name, item.unitPrice, item.quantity, item.lineTotal],
        );
      }
      await client.query(
        `INSERT INTO order_status_history (order_id, from_status, to_status, note) VALUES ($1, NULL, 'new', 'Order placed')`,
        [order.id],
      );
      await client.query('COMMIT');
      return { order, replayed: false };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      // Reference collision: extremely rare, so simply retry with a new reference.
      if (err.code === '23505' && err.constraint === 'orders_reference_key') continue;
      throw err;
    } finally {
      client.release();
    }
  }
  throw new Error('Could not allocate a unique order reference');
}

function replay(existing, print) {
  if (existing.request_fingerprint !== print) {
    throw new OrderError(409, 'IDEMPOTENCY_CONFLICT', 'This form was already submitted with different details. Refresh the page to place a new order.');
  }
  return { order: existing, replayed: true };
}
