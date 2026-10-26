// Checkout sessions ("abandoned checkouts"): what a customer has entered and chosen on an order
// form, saved as they go, so the business can see who started an order but did not finish it.
//   active    → the customer is (or was recently) filling in the form
//   abandoned → no activity for the business's set time (Settings; default 60 minutes), no order
//   completed → an order was placed while the session was active
//   recovered → an order was placed after the session had been abandoned
//   expired   → abandoned for EXPIRE_DAYS; personal details erased
// Sessions are never orders: they are not counted in sales or revenue, never sent to ad platforms
// (no Purchase) or to Google Sheets, and never create an order. Payment details are never stored.
import { normalizePhone } from '../lib/phone.js';
import { originsForPage } from '../lib/origins.js';
import { loadLandingPage, loadPricedItems, deliveryFor, isTestName, OrderError } from './orders.js';

export const STATUSES = ['active', 'abandoned', 'completed', 'recovered', 'expired'];
export const STATUS_LABELS = { active: 'In progress', abandoned: 'Abandoned', completed: 'Ordered', recovered: 'Recovered', expired: 'Expired' };
// Retention: personal details are erased EXPIRE_DAYS after the session ends (abandoned sessions
// then become "expired"; ordered ones keep only the link to their order, which holds the details);
// every session is deleted DELETE_DAYS after its last activity.
export const EXPIRE_DAYS = 30;
export const DELETE_DAYS = 180;
// An order placed this soon after a session's last activity, from the same phone number, is that
// session's order even when the page did not send the session's ID (e.g. a page's own form).
const PHONE_MATCH_DAYS = 7;
const TOKEN_RE = /^[A-Za-z0-9_-]{16,100}$/;

const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
// A payment card number typed by mistake (14–19 digits passing the card checksum) is never stored.
// Phone numbers (at most 13 digits with the country code) are kept.
function luhn(digits) {
  let sum = 0;
  for (let i = 0; i < digits.length; i += 1) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return sum % 10 === 0;
}
const scrub = (v) => v.replace(/\d(?:[ -]?\d){13,18}/g, (m) => (luhn(m.replace(/\D/g, '')) ? '[number removed]' : m));
const PERSONAL = ['customer_name', 'phone', 'email', 'address', 'state', 'notes'];

// Validates what the browser sends. Everything is optional except the session ID and page:
// a customer may have typed only part of the form.
export function validateCheckoutInput(body) {
  const token = str(body?.token, 100);
  const landingPage = str(body?.landingPage, 200).toLowerCase();
  if (!TOKEN_RE.test(token) || !landingPage) throw new OrderError(400, 'VALIDATION', 'Invalid checkout.');
  const c = body?.customer ?? {};
  const rawPhone = str(c.phone, 40).replace(/[^\d+() -]/g, '');
  const email = str(c.email, 200).toLowerCase();
  const items = [];
  const seen = new Set();
  for (const raw of (Array.isArray(body?.items) ? body.items : []).slice(0, 10)) {
    const code = str(raw?.product, 100).toLowerCase();
    const quantity = Number(raw?.quantity ?? 1);
    if (!code || seen.has(code) || !Number.isInteger(quantity) || quantity < 1 || quantity > 20) continue;
    let options = null;
    if (raw?.options && typeof raw.options === 'object' && !Array.isArray(raw.options)) {
      options = Object.fromEntries(Object.entries(raw.options).slice(0, 5)
        .filter(([k, v]) => typeof v === 'string' && k.trim() && k.length <= 40 && v.trim() && v.length <= 60).map(([k, v]) => [k.trim(), v.trim()]));
    }
    seen.add(code);
    items.push({ code, quantity, upsell: raw?.upsell === true, options, displayedPrice: null });
  }
  const step = ['started', 'details', 'review'].includes(body?.step) ? body.step : 'started';
  const seq = Number.isInteger(body?.seq) && body.seq > 0 && body.seq < 2 ** 31 ? body.seq : 1;
  const a = body?.attribution ?? {};
  return {
    token, landingPage, step, seq,
    customer: {
      name: scrub(str(c.name, 120).replace(/\s+/g, ' ')),
      phone: normalizePhone(rawPhone) || rawPhone,
      email: /^[^\s@]+@[^\s@]+$/.test(email) ? email : '',
      address: scrub(str(c.address, 500)),
      state: scrub(str(c.state, 60)),
      notes: scrub(str(c.notes, 1000)),
      marketingConsent: c.marketingConsent === true && Boolean(email),
    },
    items,
    attribution: { sourceUrl: str(a.pageUrl, 1000) || null, utmSource: str(a.utm_source, 200) || null, utmCampaign: str(a.utm_campaign, 200) || null },
  };
}

// Prices the chosen items from Skyfly's catalog; items that can't be priced (no longer on the page,
// an option that no longer exists) are left out rather than refusing the whole save.
async function priceItems(pool, page, items) {
  const priced = [];
  for (const item of items.filter((i) => !i.upsell).concat(items.filter((i) => i.upsell))) {
    if (item.upsell && !priced.some((p) => !p.upsell)) continue; // an add-on only goes with a package
    try {
      const [p] = await loadPricedItems(pool, page, [item]);
      priced.push({ code: p.code, name: p.name, quantity: p.quantity, unitPrice: p.unitPrice, lineTotal: p.lineTotal, upsell: p.isUpsell, options: item.options && Object.keys(item.options).length ? item.options : null });
    } catch (err) {
      if (!(err instanceof OrderError)) throw err;
    }
  }
  return priced;
}

// Saves (creates or updates) a session from a landing page. Returns { ok, status } or
// { ok: true, ended: true } when the session already led to an order or expired (the page then
// starts a new one). An update with an older sequence number than the saved one is ignored.
export async function saveCheckout(pool, input, { origin }, config) {
  const page = await loadLandingPage(pool, input.landingPage);
  if (!page || page.status !== 'active') throw new OrderError(400, 'UNKNOWN_LANDING_PAGE', 'This order form is not active.');
  if (!originsForPage(page, config).has(origin)) throw new OrderError(403, 'ORIGIN_NOT_ALLOWED', 'This website is not allowed to save checkouts for that landing page.');
  const items = await priceItems(pool, page, input.items);
  const subtotal = items.reduce((s, i) => s + i.lineTotal, 0);
  const delivery = items.length ? deliveryFor(page, subtotal) : 0;
  const c = input.customer;
  const isTest = Boolean(page.test_mode) || isTestName(c.name);
  const values = [
    page.business_id, page.id, input.token, input.step, c.name || null, c.phone || null, c.email || null, c.address || null,
    c.state || null, c.notes || null, c.marketingConsent, JSON.stringify(items), page.currency, subtotal, delivery, subtotal + delivery,
    isTest, input.attribution.sourceUrl, input.attribution.utmSource, input.attribution.utmCampaign, input.seq,
  ];
  const { rows: [row] } = await pool.query(
    `INSERT INTO checkout_sessions (business_id, landing_page_id, token, step, customer_name, phone, email, address, state, notes,
       marketing_consent, items, currency, subtotal_minor, delivery_fee_minor, total_minor, is_test, source_url, utm_source, utm_campaign, seq)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)
     ON CONFLICT (token) DO UPDATE SET
       landing_page_id = EXCLUDED.landing_page_id, step = EXCLUDED.step, customer_name = EXCLUDED.customer_name, phone = EXCLUDED.phone,
       email = EXCLUDED.email, address = EXCLUDED.address, state = EXCLUDED.state, notes = EXCLUDED.notes,
       marketing_consent = EXCLUDED.marketing_consent, items = EXCLUDED.items, currency = EXCLUDED.currency,
       subtotal_minor = EXCLUDED.subtotal_minor, delivery_fee_minor = EXCLUDED.delivery_fee_minor, total_minor = EXCLUDED.total_minor,
       is_test = checkout_sessions.is_test OR EXCLUDED.is_test, seq = EXCLUDED.seq, last_activity_at = now(),
       -- A customer who comes back to an abandoned checkout is active again (abandoned_at is kept, so
       -- an order now counts as recovered).
       status = 'active'
     WHERE checkout_sessions.business_id = EXCLUDED.business_id
       AND checkout_sessions.status IN ('active', 'abandoned') AND checkout_sessions.seq < EXCLUDED.seq
     RETURNING id, status`, values);
  if (row) return { ok: true, status: row.status };
  const { rows: [existing] } = await pool.query('SELECT business_id, status FROM checkout_sessions WHERE token = $1', [input.token]);
  // Another business's session ID, or a session that has ended: the page starts a new session.
  if (!existing || String(existing.business_id) !== String(page.business_id) || !['active', 'abandoned'].includes(existing.status)) return { ok: true, ended: true };
  return { ok: true, status: existing.status, stale: true };
}

// What a resume link restores: the page and the selections only (never personal details).
export async function resumeCheckout(pool, token) {
  if (!TOKEN_RE.test(String(token || ''))) return null;
  const { rows: [s] } = await pool.query(
    `SELECT s.items, s.step, lp.slug FROM checkout_sessions s LEFT JOIN landing_pages lp ON lp.id = s.landing_page_id
      WHERE s.token = $1 AND s.status IN ('active', 'abandoned')`, [token]);
  if (!s) return null;
  return {
    landingPage: s.slug, step: s.step,
    items: (s.items || []).map((i) => ({ product: i.code, quantity: i.quantity, upsell: Boolean(i.upsell), ...(i.options ? { options: i.options } : {}) })),
  };
}

// Links a saved order to its session: by the session ID the page sent, else by the same phone number
// (within PHONE_MATCH_DAYS of the session's last activity). Same business only. Repeating it for
// the same order (a retry) changes nothing. Returns the linked session's status, or null.
export async function linkOrder(pool, orderId, { checkoutId = null } = {}) {
  const token = TOKEN_RE.test(String(checkoutId || '')) ? checkoutId : null;
  const { rows: [order] } = await pool.query('SELECT id, business_id, phone, is_test FROM orders WHERE id = $1', [orderId]);
  if (!order) return null;
  const { rows: [already] } = await pool.query('SELECT status FROM checkout_sessions WHERE order_id = $1 LIMIT 1', [order.id]);
  if (already) return already.status;
  const { rows: [s] } = await pool.query(
    `SELECT id FROM checkout_sessions
      WHERE business_id = $1 AND order_id IS NULL AND status IN ('active', 'abandoned')
        AND (token = $2 OR ($2::text IS NULL AND phone = $3 AND last_activity_at > now() - make_interval(days => ${PHONE_MATCH_DAYS})))
      ORDER BY (token = $2) DESC NULLS LAST, last_activity_at DESC LIMIT 1`, [order.business_id, token, order.phone ?? null]);
  if (!s) return null;
  const { rows: [done] } = await pool.query(
    `UPDATE checkout_sessions SET order_id = $2, completed_at = now(), last_activity_at = now(),
            status = CASE WHEN abandoned_at IS NULL THEN 'completed' ELSE 'recovered' END, is_test = is_test OR $3
      WHERE id = $1 AND order_id IS NULL RETURNING status`, [s.id, order.id, Boolean(order.is_test)]);
  return done?.status ?? null;
}

// Background job (every minute) and before a business's list is shown: marks idle sessions as
// abandoned, applies the retention policy. Returns counts.
export async function classifyCheckouts(pool, { businessId = null } = {}) {
  const scope = businessId === null ? '' : ' AND s.business_id = $1';
  const params = businessId === null ? [] : [businessId];
  const abandoned = await pool.query(
    `UPDATE checkout_sessions s SET status = 'abandoned', abandoned_at = now()
       FROM businesses b
      WHERE b.id = s.business_id AND s.status = 'active'
        AND s.last_activity_at < now() - make_interval(mins => b.abandoned_after_minutes)${scope}`, params);
  const expired = await pool.query(
    `UPDATE checkout_sessions s SET status = 'expired', expired_at = now(), details_erased_at = now(),
            ${PERSONAL.map((c) => `${c} = NULL`).join(', ')}, marketing_consent = false, source_url = NULL
      WHERE s.status = 'abandoned' AND s.last_activity_at < now() - make_interval(days => ${EXPIRE_DAYS})${scope}`, params);
  const erased = await pool.query(
    `UPDATE checkout_sessions s SET details_erased_at = now(), ${PERSONAL.map((c) => `${c} = NULL`).join(', ')}, marketing_consent = false, source_url = NULL
      WHERE s.status IN ('completed', 'recovered') AND s.details_erased_at IS NULL
        AND s.completed_at < now() - make_interval(days => ${EXPIRE_DAYS})${scope}`, params);
  const deleted = await pool.query(
    `DELETE FROM checkout_sessions s WHERE s.last_activity_at < now() - make_interval(days => ${DELETE_DAYS})${scope}`, params);
  return { abandoned: abandoned.rowCount, expired: expired.rowCount, erased: erased.rowCount, deleted: deleted.rowCount };
}
