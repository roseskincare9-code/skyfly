// Google Sheet backup of orders, sent by the server through the business's SheetDB
// API URL (the same sheet the landing page used before). Every order has a sync
// status; failures are retried with back-off and are visible in the dashboard.
// Retries first look the order reference up in the sheet, so a row is never added twice.
import { createHash } from 'node:crypto';

export const SHEETDB_URL_RE = /^https:\/\/sheetdb\.io\/api\/v1\/[A-Za-z0-9]{6,40}$/;
const RETRY_MINUTES = [1, 5, 15, 60, 180, 360, 720];
const MAX_ATTEMPTS = 20;
const TIMEOUT_MS = 15000;

async function call(url, options = {}) {
  const res = await fetch(url, { ...options, signal: AbortSignal.timeout(TIMEOUT_MS), headers: { Accept: 'application/json', ...(options.body ? { 'Content-Type': 'application/json' } : {}) } });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  if (!res.ok) throw new Error(`Google Sheet (SheetDB) answered HTTP ${res.status}${json?.error ? `: ${String(json.error).slice(0, 120)}` : ''}`);
  return json;
}

// Same columns the landing page has always written.
export function sheetRow(order, items, pageName) {
  const pkg = items.map((i) => `${i.product_name}${i.quantity > 1 ? ` x${i.quantity}` : ''}`).join(', ');
  const origin = order.source === 'manual' ? 'Entered in Skyfly' : (pageName || 'Website');
  return {
    timestamp: new Date(order.created_at).toISOString(),
    fullName: order.customer_name,
    address: order.address + (order.state ? `, ${order.state}` : ''),
    phone: order.phone,
    email: order.email || '',
    package: pkg,
    source: `${origin} | Skyfly ${order.reference} | ID ${String(order.idempotency_key || '').slice(0, 8)}${order.is_test ? ' | TEST ORDER' : ''}`,
    state: order.state || '',
    quantity: items.reduce((n, i) => n + i.quantity, 0),
    notes: order.customer_notes || '',
    skyflyId: order.idempotency_key || '',
    total: Number(order.total_minor) / 100,
  };
}

async function alreadyInSheet(url, reference) {
  const rows = await call(`${url}/search?source=${encodeURIComponent(`*${reference}*`)}`);
  return Array.isArray(rows) && rows.length > 0;
}

// Sends one order to the sheet (or confirms it is already there) and records the result.
export async function syncOrder(pool, orderId) {
  const { rows: [o] } = await pool.query(
    `SELECT o.*, b.sheet_backup_url, lp.name AS page_name FROM orders o
       JOIN businesses b ON b.id = o.business_id LEFT JOIN landing_pages lp ON lp.id = o.landing_page_id
      WHERE o.id = $1`, [orderId]);
  if (!o) return null;
  if (!o.sheet_backup_url) {
    await pool.query("UPDATE orders SET sheet_sync_status = 'skipped', sheet_sync_error = NULL WHERE id = $1", [orderId]);
    return 'skipped';
  }
  const { rows: items } = await pool.query('SELECT product_name, quantity FROM order_items WHERE order_id = $1 ORDER BY id', [orderId]);
  try {
    // Always check first: the landing page (older versions) or a slow earlier attempt may already have written this order.
    if (!(await alreadyInSheet(o.sheet_backup_url, o.reference))) {
      await call(o.sheet_backup_url, { method: 'POST', body: JSON.stringify({ data: sheetRow(o, items, o.page_name) }) });
    }
    await pool.query(
      "UPDATE orders SET sheet_sync_status = 'synced', sheet_synced_at = now(), sheet_sync_error = NULL, sheet_sync_attempts = sheet_sync_attempts + 1 WHERE id = $1",
      [orderId]);
    return 'synced';
  } catch (err) {
    const attempts = o.sheet_sync_attempts + 1;
    const wait = RETRY_MINUTES[Math.min(attempts - 1, RETRY_MINUTES.length - 1)];
    await pool.query(
      `UPDATE orders SET sheet_sync_status = 'failed', sheet_sync_attempts = $2, sheet_sync_error = $3,
              sheet_sync_next_at = now() + make_interval(mins => $4) WHERE id = $1`,
      [orderId, attempts, String(err.message || err).slice(0, 300), wait]);
    return 'failed';
  }
}

// Orders due for a (re)try, oldest first. Returns how many were processed.
export async function syncDue(pool, { limit = 10 } = {}) {
  const { rows } = await pool.query(
    `SELECT id FROM orders WHERE sheet_sync_status IN ('pending', 'failed') AND sheet_sync_next_at <= now()
        AND sheet_sync_attempts < $1 ORDER BY id LIMIT $2`, [MAX_ATTEMPTS, limit]);
  for (const r of rows) await syncOrder(pool, r.id);
  return rows.length;
}

// New orders wait a few minutes before their first copy, so a row the landing page
// writes itself (older page versions) is in the sheet before Skyfly checks for it.
export const FIRST_COPY_DELAY_MINUTES = 3;

// Background loop in the web process: runs every minute, and right away when an order arrives.
export function startSheetWorker(pool, { intervalMs = 60000, log = console } = {}) {
  let running = false;
  let again = false;
  const run = async () => {
    if (running) { again = true; return; }
    running = true;
    try {
      do { again = false; while (await syncDue(pool) === 10) { /* drain */ } } while (again);
    } catch (err) {
      log.error('Google Sheet sync error:', err.message);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(run, intervalMs);
  timer.unref?.();
  setTimeout(run, 2000).unref?.();
  return { kick: () => { setImmediate(run); }, stop: () => clearInterval(timer) };
}

// Makes a failed or skipped order eligible for an immediate retry.
export async function requeue(pool, businessId, orderId = null) {
  const { rowCount } = await pool.query(
    `UPDATE orders SET sheet_sync_status = 'pending', sheet_sync_next_at = now(),
            sheet_sync_attempts = LEAST(sheet_sync_attempts, ${MAX_ATTEMPTS - 1})
      WHERE business_id = $1 AND sheet_sync_status IN ('failed'${orderId ? ", 'skipped'" : ''}) ${orderId ? 'AND id = $2' : ''}`,
    orderId ? [businessId, orderId] : [businessId]);
  return rowCount;
}

// ---- Recovery: rows that reached only the Google Sheet (Skyfly was not reachable or not connected).
export const FALLBACK_MARKERS = ['NOT IN SKYFLY', 'SKYFLY NOT CONNECTED'];

export function rowKey(row) {
  return createHash('sha256').update(JSON.stringify([row.timestamp, row.phone, row.package, row.fullName])).digest('hex').slice(0, 32);
}

export async function fallbackRows(url) {
  const found = [];
  for (const marker of FALLBACK_MARKERS) {
    const rows = await call(`${url}/search?source=${encodeURIComponent(`*${marker}*`)}`);
    if (Array.isArray(rows)) found.push(...rows);
  }
  const seen = new Set();
  return found.filter((r) => { const k = rowKey(r); if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)));
}

// Turns a sheet row into values for the "New order" form (checked by the owner before saving).
export function prefillFromRow(row, products, landingPageId) {
  const pkg = String(row.package || '');
  const n = pkg.match(/Package\s*(\d+)/i)?.[1];
  const product = products.find((p) => p.code === `package-${n}`) || products.find((p) => pkg.toLowerCase().startsWith(p.name.toLowerCase().slice(0, 12)));
  const qty = Number(pkg.match(/\sx(\d+)\s*$/)?.[1] || row.quantity || 1);
  const state = String(row.state || '').trim();
  let address = String(row.address || '').trim();
  if (state && address.endsWith(`, ${state}`)) address = address.slice(0, -(state.length + 2));
  return {
    name: row.fullName || '', phone: row.phone || '', email: row.email || '', address, state,
    notes: [row.notes, `Recovered from Google Sheet backup (${row.timestamp || 'no time'})`].filter(Boolean).join(' · '),
    product_0: product ? String(product.id) : '', quantity_0: String(Number.isInteger(qty) && qty > 0 && qty <= 100 ? qty : 1),
    landing_page_id: landingPageId ? String(landingPageId) : '', sheet_row_key: rowKey(row),
  };
}
