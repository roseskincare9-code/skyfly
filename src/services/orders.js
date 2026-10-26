import { resolveOptions, optionsLabel } from '../lib/options.js';
import { createHash } from 'node:crypto';
import { normalizePhone } from '../lib/phone.js';
import { generateReference, generateToken } from '../lib/reference.js';
import { originsForPage } from '../lib/origins.js';
import { STATUS_VALUES, PAYMENT_VALUES } from '../lib/statuses.js';

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
      const upsell = raw?.upsell === true;
      if (!code || seen.has(code) || (upsell && items.some((i) => i.upsell))) { fields.items = 'Select a valid package.'; break; }
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QUANTITY) {
        fields.quantity = `Quantity must be between 1 and ${MAX_QUANTITY}.`;
        break;
      }
      const displayed = raw?.unitPrice;
      if (displayed !== undefined && displayed !== null && !(Number.isFinite(Number(displayed)) && Number(displayed) >= 0)) {
        fields.items = 'Select a valid package.';
        break;
      }
      // Chosen product options, e.g. { Size: "50ml" }: names and values are checked against the product.
      const rawOptions = raw?.options ?? null;
      let options = null;
      if (rawOptions !== null) {
        const entries = typeof rawOptions === 'object' && !Array.isArray(rawOptions) ? Object.entries(rawOptions) : null;
        if (!entries || entries.length > 5 || entries.some(([k, v]) => typeof v !== 'string' || !k.trim() || k.length > 40 || v.length > 60)) {
          fields.items = 'Select valid product options.';
          break;
        }
        options = Object.fromEntries(entries.map(([k, v]) => [k.trim(), v.trim()]).filter(([, v]) => v));
      }
      seen.add(code);
      items.push({ code, quantity, upsell, options, displayedPrice: displayed === undefined || displayed === null ? null : Number(displayed) });
    }
    // An add-on is only ever offered with a package.
    if (!fields.items && !fields.quantity && !items.some((i) => !i.upsell)) fields.items = 'Select a package.';
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
    fbp: optional(a.fbp, 200),
    fbc: optional(a.fbc, 300),
    ttp: optional(a.ttp, 200),
    ttclid: optional(a.ttclid, 300),
  };

  // Only true when the page asked and the customer ticked it; never assumed.
  const marketingConsent = customer.marketingConsent === true && Boolean(email);
  return { landingPage, idempotencyKey, customer: { name, phone, email, address, state, notes, marketingConsent }, items, attribution };
}

function fingerprint(input) {
  const { customer, items, landingPage } = input;
  const canonical = JSON.stringify([landingPage, customer, items.map((i) => [i.code, i.quantity, ...(i.upsell ? ['upsell'] : []), ...(i.options && Object.keys(i.options).length ? [Object.entries(i.options).map(([k, v]) => `${k.toLowerCase()}=${v.toLowerCase()}`).sort()] : [])])]);
  return createHash('sha256').update(canonical).digest('hex');
}

export async function loadLandingPage(client, slug) {
  const { rows } = await client.query(
    `SELECT lp.id, lp.business_id, lp.status, lp.url, lp.custom_domain, lp.test_mode, lp.upsell_product_id,
            (lp.published_version_id IS NOT NULL) AS hosted, b.currency, b.order_prefix, b.subdomain AS business_subdomain,
            b.delivery_fee_minor, b.free_delivery_from_minor
       FROM landing_pages lp JOIN businesses b ON b.id = lp.business_id
      WHERE lp.slug = $1`,
    [slug],
  );
  return rows[0];
}

// Prices every item from Skyfly's catalog: a package must be on the page; an add-on must be the
// page's configured upsell. Totals sent by the browser are never used.
export async function loadPricedItems(client, page, items) {
  const codes = items.map((i) => i.code);
  const { rows } = await client.query(
    `SELECT p.id, p.code, p.name, p.price_minor, p.options, (lpp.product_id IS NOT NULL) AS on_page
       FROM products p
       LEFT JOIN landing_page_products lpp ON lpp.product_id = p.id AND lpp.landing_page_id = $1
      WHERE p.active AND p.business_id = $2 AND p.code = ANY($3::text[]) AND (lpp.product_id IS NOT NULL OR p.id = $4)`,
    [page.id, page.business_id, codes, page.upsell_product_id ?? null],
  );
  const byCode = new Map(rows.map((r) => [r.code, r]));

  return items.map((item) => {
    const product = byCode.get(item.code);
    const allowed = product && (item.upsell ? String(product.id) === String(page.upsell_product_id) : product.on_page);
    if (!allowed) {
      throw new OrderError(400, 'UNKNOWN_PRODUCT', item.upsell
        ? 'That add-on is no longer available. Please refresh the page.'
        : 'That package is no longer available. Please choose another package.', {
        fields: { items: item.upsell ? 'This add-on is not available.' : 'This package is not available.' },
      });
    }
    const picked = resolveOptions(product.options, item.options ?? {});
    if (picked.error) throw new OrderError(400, 'VALIDATION', picked.error, { fields: { items: picked.error } });
    const base = Number(product.price_minor);
    // The page shows the product's own price; options add (or take off) their difference here.
    const unit = Math.max(0, base + picked.chosen.reduce((sum, c) => sum + c.delta_minor, 0));
    if (item.displayedPrice !== null && Math.round(item.displayedPrice * 100) !== base) {
      throw new OrderError(409, 'PRICE_CHANGED', 'The price of this package has changed. Please refresh the page to see the current price.', {
        product: item.code,
      });
    }
    return {
      productId: product.id,
      code: product.code,
      // The chosen options are part of the saved name, so every list, sheet and email shows them.
      name: picked.chosen.length ? `${product.name} (${optionsLabel(picked.chosen)})`.slice(0, 200) : product.name,
      options: picked.chosen.length ? picked.chosen : null,
      unitPrice: unit,
      quantity: item.quantity,
      lineTotal: unit * item.quantity,
      isUpsell: item.upsell === true,
    };
  });
}

async function findByIdempotencyKey(client, businessId, key) {
  const { rows } = await client.query(
    `SELECT id, reference, access_token, request_fingerprint, total_minor, currency, is_test, delivery_fee_minor
       FROM orders WHERE business_id = $1 AND idempotency_key = $2`,
    [businessId, key],
  );
  return rows[0];
}

// Checks placed as "TEST ORDER …" are test orders from the start: left out of sales
// totals and never sent to ad platforms as purchases.
export function isTestName(name) {
  return /^\s*test order\b/i.test(String(name ?? ''));
}

// Inserts an order with its items and first history row inside an open transaction.
async function insertOrder(client, o) {
  const inserted = await client.query(
    `INSERT INTO orders (
       business_id, landing_page_id, reference, access_token, idempotency_key, request_fingerprint,
       customer_name, phone, email, address, state, customer_notes, currency, total_minor,
       source_url, referrer, utm_source, utm_medium, utm_campaign, utm_content, utm_term,
       status, payment_status, source, client_ip, user_agent, fbp, fbc, ttp, ttclid, is_test, marketing_consent, delivery_fee_minor)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33)
     ON CONFLICT (business_id, idempotency_key) DO NOTHING
     RETURNING id, reference, access_token, total_minor, currency, is_test, delivery_fee_minor`,
    [
      o.businessId, o.landingPageId, generateReference(o.prefix), generateToken(), o.idempotencyKey, o.fingerprint,
      o.customer.name, o.customer.phone, o.customer.email, o.customer.address, o.customer.state, o.customer.notes,
      o.currency, o.total,
      o.attribution.sourceUrl, o.attribution.referrer, o.attribution.utmSource, o.attribution.utmMedium,
      o.attribution.utmCampaign, o.attribution.utmContent, o.attribution.utmTerm,
      o.status, o.paymentStatus, o.source, o.client?.ip ?? null, o.client?.userAgent ?? null,
      o.attribution.fbp ?? null, o.attribution.fbc ?? null, o.attribution.ttp ?? null, o.attribution.ttclid ?? null,
      isTestName(o.customer.name) || o.testMode === true, o.customer.marketingConsent === true, o.deliveryFee ?? 0,
    ],
  );
  const order = inserted.rows[0];
  if (!order) return null;
  for (const item of o.items) {
    await client.query(
      `INSERT INTO order_items (order_id, product_id, product_code, product_name, unit_price_minor, quantity, line_total_minor, is_upsell, options)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [order.id, item.productId, item.code, item.name, item.unitPrice, item.quantity, item.lineTotal, item.isUpsell === true, item.options ? JSON.stringify(item.options) : null],
    );
  }
  await client.query(
    `INSERT INTO order_status_history (order_id, from_status, to_status, note, changed_by) VALUES ($1, NULL, $2, $3, $4)`,
    [order.id, o.status, o.historyNote, o.userId ?? null],
  );
  if (o.paymentStatus !== 'unpaid') {
    await client.query(
      `INSERT INTO order_status_history (order_id, from_status, to_status, note, changed_by, kind) VALUES ($1, 'unpaid', $2, NULL, $3, 'payment')`,
      [order.id, o.paymentStatus, o.userId ?? null],
    );
  }
  return order;
}

// The business's delivery fee, free once the subtotal reaches its free-delivery amount (if set).
export function deliveryFor(b, subtotalMinor) {
  const fee = Number(b.delivery_fee_minor ?? 0);
  if (!fee) return 0;
  if (b.free_delivery_from_minor !== null && b.free_delivery_from_minor !== undefined && subtotalMinor >= Number(b.free_delivery_from_minor)) return 0;
  return fee;
}

// Retries the whole transaction if the random reference collides (extremely rare).
async function withReferenceRetry(pool, fn) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const client = await pool.connect();
    try {
      return await fn(client);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      if (err.code === '23505' && err.constraint === 'orders_reference_key') continue;
      throw err;
    } finally {
      client.release();
    }
  }
  throw new Error('Could not allocate a unique order reference');
}

// Saves a public order exactly once per idempotency key. `auth` is either
// { origin } for browser forms or { businessId } for a verified API key.
export async function createOrder(pool, input, auth, config) {
  const print = fingerprint(input);

  return withReferenceRetry(pool, async (client) => {
    const page = await loadLandingPage(client, input.landingPage);
    if (!page || page.status !== 'active') {
      throw new OrderError(400, 'UNKNOWN_LANDING_PAGE', 'This order form is not accepting orders right now. Please contact us on WhatsApp.');
    }
    if (auth.businessId !== undefined) {
      if (page.business_id !== auth.businessId) {
        throw new OrderError(403, 'FORBIDDEN', 'This API key cannot submit orders for that landing page.');
      }
    } else if (!originsForPage(page, config).has(auth.origin)) {
      throw new OrderError(403, 'ORIGIN_NOT_ALLOWED', 'This website is not allowed to submit orders for that landing page.');
    }

    const existing = await findByIdempotencyKey(client, page.business_id, input.idempotencyKey);
    if (existing) return replay(existing, print);

    const items = await loadPricedItems(client, page, input.items);
    const subtotal = items.reduce((sum, i) => sum + i.lineTotal, 0);
    const deliveryFee = deliveryFor(page, subtotal);
    await client.query('BEGIN');
    const order = await insertOrder(client, {
      businessId: page.business_id, landingPageId: page.id, prefix: page.order_prefix, currency: page.currency,
      idempotencyKey: input.idempotencyKey, fingerprint: print, customer: input.customer, attribution: input.attribution,
      items, total: subtotal + deliveryFee, deliveryFee,
      status: 'pending', paymentStatus: 'unpaid', source: auth.businessId !== undefined ? 'api' : 'web', historyNote: 'Order placed',
      client: auth.client, testMode: page.test_mode,
    });
    if (!order) {
      // A concurrent request with the same key committed first.
      await client.query('ROLLBACK');
      return replay(await findByIdempotencyKey(client, page.business_id, input.idempotencyKey), print);
    }
    if (auth.businessId === undefined) {
      // The first saved browser submission proves this page's form is connected.
      await client.query(
        'UPDATE landing_pages SET order_connected_at = now(), order_connected_reference = $2 WHERE id = $1 AND order_connected_at IS NULL',
        [page.id, order.reference],
      );
    }
    await client.query('COMMIT');
    return { order, replayed: false };
  });
}

// Orders typed in by the owner (e.g. taken by phone). The owner may set the
// unit price, and choose the starting fulfilment and payment status.
export async function createManualOrder(pool, business, userId, body) {
  const fields = {};
  const input = (() => {
    try {
      return validateOrderInput({
        landingPage: 'manual',
        idempotencyKey: generateToken(),
        customer: body,
        items: [{ product: 'placeholder', quantity: 1 }],
      });
    } catch (err) {
      if (err instanceof OrderError) Object.assign(fields, err.details.fields);
      return null;
    }
  })();

  const status = STATUS_VALUES.includes(body.status) ? body.status : 'pending';
  const paymentStatus = PAYMENT_VALUES.includes(body.payment_status) ? body.payment_status : 'unpaid';
  const landingPageId = /^\d+$/.test(String(body.landing_page_id ?? '')) ? Number(body.landing_page_id) : null;

  const lines = [];
  for (let i = 0; i < 3; i += 1) {
    const productId = String(body[`product_${i}`] ?? '');
    if (!productId) continue;
    const quantity = Number(body[`quantity_${i}`] || 1);
    const priceText = String(body[`price_${i}`] ?? '').replace(/[,\s₦£$€]/g, '');
    if (!/^\d+$/.test(productId) || !Number.isInteger(quantity) || quantity < 1 || quantity > 100) {
      fields.items = 'Check the products and quantities.';
      continue;
    }
    if (priceText && !/^\d{1,12}(\.\d{1,2})?$/.test(priceText)) {
      fields.items = 'Enter prices as numbers, e.g. 23500.';
      continue;
    }
    lines.push({ productId: Number(productId), quantity, price: priceText ? Math.round(Number(priceText) * 100) : null });
  }
  if (lines.length === 0) fields.items = fields.items || 'Add at least one product.';
  if (Object.keys(fields).length) throw new OrderError(400, 'VALIDATION', 'Please check the highlighted details.', { fields });

  const { rows: products } = await pool.query(
    'SELECT id, code, name, price_minor FROM products WHERE business_id = $1 AND id = ANY($2::bigint[])',
    [business.id, lines.map((l) => l.productId)],
  );
  const byId = new Map(products.map((p) => [Number(p.id), p]));
  const items = lines.map((l) => {
    const p = byId.get(l.productId);
    if (!p) throw new OrderError(400, 'VALIDATION', 'Please check the highlighted details.', { fields: { items: 'Unknown product.' } });
    const unit = l.price ?? Number(p.price_minor);
    return { productId: p.id, code: p.code, name: p.name, unitPrice: unit, quantity: l.quantity, lineTotal: unit * l.quantity };
  });
  if (landingPageId) {
    const { rows } = await pool.query('SELECT 1 FROM landing_pages WHERE id = $1 AND business_id = $2', [landingPageId, business.id]);
    if (!rows[0]) throw new OrderError(400, 'VALIDATION', 'Unknown landing page.', { fields: { landing_page_id: 'Unknown landing page.' } });
  }

  return withReferenceRetry(pool, async (client) => {
    await client.query('BEGIN');
    const order = await insertOrder(client, {
      businessId: business.id, landingPageId, prefix: business.order_prefix, currency: business.currency,
      idempotencyKey: input.idempotencyKey, fingerprint: generateToken(), customer: input.customer,
      attribution: { sourceUrl: null, referrer: null, utmSource: null, utmMedium: null, utmCampaign: null, utmContent: null, utmTerm: null },
      items, total: items.reduce((sum, i) => sum + i.lineTotal, 0),
      status, paymentStatus, source: 'manual', historyNote: 'Entered manually', userId,
    });
    await client.query('COMMIT');
    return order;
  });
}

function replay(existing, print) {
  if (existing.request_fingerprint !== print) {
    throw new OrderError(409, 'IDEMPOTENCY_CONFLICT', 'This form was already submitted with different details. Refresh the page to place a new order.');
  }
  return { order: existing, replayed: true };
}

// Read-only summary of the latest TEST ORDERs, logged at start-up so a deployment can be checked
// against the database without signing in: per order, what its business's Orders page lists
// (business, page, items, total, status, sheet copy) and how many orders that list shows for the
// reference and for the same submission. Test orders only: no real customer data.
export async function testOrderSummary(pool, limit = 5) {
  const { rows } = await pool.query(
    `SELECT o.reference, b.slug AS business, lp.slug AS page, o.status, o.total_minor, o.currency, o.sheet_sync_status, o.created_at,
            (SELECT string_agg(i.product_name || ' x' || i.quantity || CASE WHEN i.is_upsell THEN ' (add-on)' ELSE '' END, ', ' ORDER BY i.id)
               FROM order_items i WHERE i.order_id = o.id) AS items,
            (SELECT count(*)::int FROM orders d WHERE d.business_id = o.business_id AND d.reference ILIKE o.reference) AS listed,
            (SELECT count(*)::int FROM orders d WHERE d.business_id = o.business_id AND d.idempotency_key = o.idempotency_key) AS submissions
       FROM orders o JOIN businesses b ON b.id = o.business_id LEFT JOIN landing_pages lp ON lp.id = o.landing_page_id
      WHERE o.is_test ORDER BY o.id DESC LIMIT $1`, [limit]);
  return rows.map((r) => `Orders check (test orders, read-only): ${r.reference} — business ${r.business}, page ${r.page ?? '-'}, ${r.items}, `
    + `total ${(Number(r.total_minor) / 100).toLocaleString('en-NG')} ${r.currency}, status ${r.status}, sheet copy ${r.sheet_sync_status}, `
    + `listed ${r.listed}x in ${r.business} Orders, ${r.submissions} order(s) for this submission, saved ${r.created_at.toISOString()}`);
}
