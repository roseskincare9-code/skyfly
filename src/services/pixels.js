// Pixel settings, browser tracking config, and server-side Purchase events
// (Meta Conversions API, TikTok Events API). Purchase is sent once per order and provider, when
// the order is saved or marked Paid (per pixel setting); test orders go only to Test events.
import { createHash } from 'node:crypto';
import { decrypt } from '../lib/secrets.js';

export const PROVIDERS = ['meta', 'tiktok'];
// Purchase (browser) fires once per order, only after Skyfly has saved it (never for test orders).
export const BROWSER_EVENTS = ['PageView', 'ViewContent', 'InitiateCheckout', 'Lead', 'Purchase'];
// With browser Purchase on, Purchase means "order saved"; otherwise it means "marked Paid".
export const purchaseOnSave = (s) => Array.isArray(s?.events) && s.events.includes('Purchase');
export const PIXEL_ID_RULES = {
  meta: { re: /^\d{10,20}$/, hint: 'a number of 10–20 digits, e.g. 123456789012345' },
  tiktok: { re: /^[A-Z0-9]{10,40}$/, hint: '10–40 letters and digits, e.g. C4ABCDEFGH1234567890' },
};

// Page-specific settings win over the business default, per provider.
export async function effectiveSettings(pool, businessId, landingPageId) {
  const { rows } = await pool.query(
    `SELECT * FROM pixel_settings WHERE business_id = $1 AND (landing_page_id IS NULL OR landing_page_id = $2)
      ORDER BY landing_page_id NULLS LAST`,
    [businessId, landingPageId ?? 0],
  );
  const result = {};
  for (const provider of PROVIDERS) result[provider] = rows.find((r) => r.provider === provider) ?? null;
  return result;
}

// What the browser needs: only enabled pixels with valid IDs. No secrets.
export async function browserConfig(pool, page) {
  const settings = await effectiveSettings(pool, page.business_id, page.id);
  const pixels = [];
  for (const provider of PROVIDERS) {
    const s = settings[provider];
    if (s?.enabled && s.pixel_id && PIXEL_ID_RULES[provider].re.test(s.pixel_id)) {
      pixels.push({ provider, id: s.pixel_id, events: s.events.filter((e) => BROWSER_EVENTS.includes(e)) });
    }
  }
  return { page: page.slug, pixels };
}

const sha256 = (v) => createHash('sha256').update(v).digest('hex');

function metaPayload(order, items, eventId, testCode) {
  const userData = {
    ph: [sha256(order.phone.replace(/\D/g, ''))],
    country: [sha256('ng')],
  };
  if (order.email) userData.em = [sha256(order.email.trim().toLowerCase())];
  const first = order.customer_name.trim().split(/\s+/)[0]?.toLowerCase();
  if (first) userData.fn = [sha256(first)];
  if (order.client_ip) userData.client_ip_address = order.client_ip;
  if (order.user_agent) userData.client_user_agent = order.user_agent;
  if (order.fbp) userData.fbp = order.fbp;
  if (order.fbc) userData.fbc = order.fbc;
  const event = {
    event_name: 'Purchase',
    event_time: Math.floor(Date.now() / 1000),
    event_id: eventId,
    action_source: order.source_url ? 'website' : 'system_generated',
    user_data: userData,
    custom_data: {
      currency: order.currency,
      value: order.total_minor / 100,
      order_id: order.reference,
      content_type: 'product',
      contents: items.map((i) => ({ id: i.product_code, quantity: i.quantity, item_price: i.unit_price_minor / 100 })),
    },
  };
  if (order.source_url) event.event_source_url = order.source_url;
  return { data: [event], ...(testCode ? { test_event_code: testCode } : {}) };
}

function tiktokPayload(order, items, eventId, pixelId, eventName, testCode) {
  const user = { phone: sha256(order.phone) };
  if (order.email) user.email = sha256(order.email.trim().toLowerCase());
  if (order.client_ip) user.ip = order.client_ip;
  if (order.user_agent) user.user_agent = order.user_agent;
  if (order.ttp) user.ttp = order.ttp;
  if (order.ttclid) user.ttclid = order.ttclid;
  return {
    event_source: 'web',
    event_source_id: pixelId,
    ...(testCode ? { test_event_code: testCode } : {}),
    data: [{
      event: eventName,
      event_time: Math.floor(Date.now() / 1000),
      event_id: eventId,
      user,
      properties: {
        currency: order.currency,
        value: order.total_minor / 100,
        order_id: order.reference,
        content_type: 'product',
        contents: items.map((i) => ({ content_id: i.product_code, content_name: i.product_name, quantity: i.quantity, price: i.unit_price_minor / 100 })),
      },
      ...(order.source_url ? { page: { url: order.source_url } } : {}),
    }],
  };
}

async function post(url, headers, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, json, text: text.slice(0, 500) };
}

// Sends one Purchase to one provider. Returns { ok, status, error }.
async function deliver(config, provider, settings, order, items, eventId, { test = false } = {}) {
  const token = decrypt(config.encryptionKey, settings.access_token_enc);
  const testCode = test ? settings.test_event_code : null;
  try {
    if (provider === 'meta') {
      const r = await post(`${config.metaGraphBase}/${settings.pixel_id}/events?access_token=${encodeURIComponent(token)}`, {},
        metaPayload(order, items, eventId, testCode));
      const ok = r.status === 200 && r.json?.events_received >= 1;
      return { ok, status: r.status, error: ok ? null : (r.json?.error?.message || r.text) };
    }
    const r = await post(`${config.tiktokApiBase}/event/track/`, { 'Access-Token': token },
      tiktokPayload(order, items, eventId, settings.pixel_id, config.tiktokPurchaseEvent || 'CompletePayment', testCode));
    const ok = r.status === 200 && r.json?.code === 0;
    return { ok, status: r.status, error: ok ? null : (r.json?.message || r.text) };
  } catch (err) {
    return { ok: false, status: null, error: err.name === 'TimeoutError' ? 'Timed out' : err.message };
  }
}

async function loadOrder(pool, orderId) {
  const { rows: [order] } = await pool.query('SELECT * FROM orders WHERE id = $1', [orderId]);
  const { rows: items } = await pool.query('SELECT * FROM order_items WHERE order_id = $1 ORDER BY id', [orderId]);
  return { order, items };
}

function serverReady(config, s) {
  return Boolean(s?.enabled && s.server_purchase && s.pixel_id && s.access_token_enc && config.encryptionKey);
}

// Server-side Purchase: when an order is saved (pixels counting Purchase at save) or when it is
// marked Paid (the others). Same event_id as the browser event, so the platform counts it once.
export async function recordPurchase(pool, config, orderId, { trigger = 'paid' } = {}) {
  const { order, items } = await loadOrder(pool, orderId);
  if (!order) return [];
  if (order.is_test) return trigger === 'saved' ? recordTestPurchase(pool, config, order, items) : [];
  if (trigger === 'paid' && order.payment_status !== 'paid') return [];
  const settings = await effectiveSettings(pool, order.business_id, order.landing_page_id);
  const results = [];
  for (const provider of PROVIDERS) {
    const s = settings[provider];
    if (!serverReady(config, s)) continue;
    if ((trigger === 'saved') !== purchaseOnSave(s)) continue;
    const eventId = `purchase_${order.reference}`;
    // The unique key (order, provider, event) means a second "Paid" never sends twice.
    const { rows: [event] } = await pool.query(
      `INSERT INTO conversion_events (order_id, provider, pixel_id, event_name, event_id)
       VALUES ($1, $2, $3, 'Purchase', $4) ON CONFLICT DO NOTHING RETURNING id`,
      [order.id, provider, s.pixel_id, eventId],
    );
    if (!event) continue;
    results.push(await attempt(pool, config, event.id, provider, s, order, items, eventId));
  }
  return results;
}

// A test order ("TEST ORDER …" or a page in test mode) placed through the real checkout sends its
// server-side Purchase only with the pixel's test event code, so it shows in the platform's Test
// events screen and never in real reporting. No test event code: nothing is sent.
const TEST_PURCHASE = 'Purchase (test)';
async function recordTestPurchase(pool, config, order, items) {
  const settings = await effectiveSettings(pool, order.business_id, order.landing_page_id);
  const results = [];
  for (const provider of PROVIDERS) {
    const s = settings[provider];
    if (!serverReady(config, s) || !s.test_event_code) continue;
    const eventId = `test_purchase_${order.reference}`;
    const { rows: [event] } = await pool.query(
      `INSERT INTO conversion_events (order_id, provider, pixel_id, event_name, event_id, test_mode)
       VALUES ($1, $2, $3, $4, $5, true) ON CONFLICT DO NOTHING RETURNING id`,
      [order.id, provider, s.pixel_id, TEST_PURCHASE, eventId],
    );
    if (!event) continue;
    results.push(await attempt(pool, config, event.id, provider, s, order, items, eventId, { test: true }));
  }
  return results;
}

// The platform accepting an event is what makes server-side Purchase "verified".
export async function markServerVerified(pool, settingsId) {
  await pool.query('UPDATE pixel_settings SET server_verified_at = now() WHERE id = $1', [settingsId]);
}

async function attempt(pool, config, eventRowId, provider, settings, order, items, eventId, { test = false } = {}) {
  const r = await deliver(config, provider, settings, order, items, eventId, { test });
  if (r.ok) await markServerVerified(pool, settings.id);
  await pool.query(
    `UPDATE conversion_events SET attempts = attempts + 1, status = $2, response_code = $3, last_error = $4,
            sent_at = CASE WHEN $2 = 'sent' THEN now() ELSE sent_at END WHERE id = $1`,
    [eventRowId, r.ok ? 'sent' : 'failed', r.status, r.error ? String(r.error).slice(0, 500) : null],
  );
  return { provider, ...r };
}

// Retries a failed event (same event_id, so the platform de-duplicates if it did arrive).
export async function retryEvent(pool, config, eventRowId, businessId) {
  const { rows: [ev] } = await pool.query(
    `SELECT e.* FROM conversion_events e JOIN orders o ON o.id = e.order_id
      WHERE e.id = $1 AND o.business_id = $2 AND e.status = 'failed'`,
    [eventRowId, businessId],
  );
  if (!ev) return null;
  const { order, items } = await loadOrder(pool, ev.order_id);
  const settings = (await effectiveSettings(pool, order.business_id, order.landing_page_id))[ev.provider];
  if (ev.test_mode) {
    if (!serverReady(config, settings) || !settings.test_event_code) return { ok: false, error: 'Add the access token and test event code again to resend this test event.' };
    return attempt(pool, config, ev.id, ev.provider, settings, order, items, ev.event_id, { test: true });
  }
  if (order.is_test) return null;
  // Purchase counted at save can be resent for any saved order; otherwise only once it is Paid.
  if (!purchaseOnSave(settings) && order.payment_status !== 'paid') return null;
  if (!serverReady(config, settings)) return { ok: false, error: 'Server-side Purchase is not set up for this pixel any more.' };
  return attempt(pool, config, ev.id, ev.provider, settings, order, items, ev.event_id);
}

// Sends a clearly-labelled test Purchase using the provider's test event code,
// so it shows in the platform's "Test events" screen and not in real reporting.
export async function sendTestEvent(config, provider, settings, businessCurrency) {
  if (!settings?.test_event_code) return { ok: false, error: 'Add a test event code first (from the platform\'s Test events screen).' };
  if (!serverReady(config, { ...settings, enabled: true, server_purchase: true })) return { ok: false, error: 'Save the pixel ID and access token first.' };
  const fake = {
    reference: `TEST-${Date.now().toString(36).toUpperCase()}`, phone: '+2348000000000', email: 'test@example.com',
    customer_name: 'Test Customer', currency: businessCurrency, total_minor: 100, source_url: null,
  };
  return deliver(config, provider, settings, fake, [{ product_code: 'test', product_name: 'Test', quantity: 1, unit_price_minor: 100 }],
    `test_${fake.reference}`, { test: true });
}
