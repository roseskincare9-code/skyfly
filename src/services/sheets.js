// Google Sheets for orders, managed centrally per business. Each business keeps its
// spreadsheet connections (SheetDB API URLs, stored encrypted) in one place and picks a
// default; landing pages use it automatically unless one is given its own sheet.
// Orders are saved in Skyfly first; the server then copies each one to its sheet, with a
// visible status, retries with back-off, and a search before every write so a row is
// never added twice.
import { createHash } from 'node:crypto';
import { encrypt, decrypt } from '../lib/secrets.js';
import { SHEET_COLUMNS, REQUIRED_COLUMNS, SKYFLY_TAB } from './sheetColumns.js';
export { SKYFLY_TAB };
import { STATUS_LABELS } from '../lib/statuses.js';

export const SHEETDB_URL_RE = /^https:\/\/sheetdb\.io\/api\/v1\/[A-Za-z0-9]{6,40}$/;
export const GOOGLE_SHEET_URL_RE = /^https:\/\/docs\.google\.com\/spreadsheets\/d\/[A-Za-z0-9_-]{20,100}(\/[^\s"'<>]*)?$/;
const RETRY_MINUTES = [1, 5, 15, 60, 180, 360, 720];
// How long copies wait while a sheet can't take rows (free SheetDB plans have a small monthly request quota).
const HOLD_MINUTES = 360;
const MAX_ATTEMPTS = 20;
const TIMEOUT_MS = 15000;

export { SHEET_COLUMNS, REQUIRED_COLUMNS } from './sheetColumns.js';

export class SheetError extends Error {
  constructor(message, status = null) { super(message); this.status = status; }
}

async function call(url, options = {}) {
  let res;
  try {
    res = await fetch(url, { ...options, signal: AbortSignal.timeout(TIMEOUT_MS), headers: { Accept: 'application/json', ...(options.body ? { 'Content-Type': 'application/json' } : {}) } });
  } catch (err) {
    throw new SheetError(`Google Sheet (SheetDB) could not be reached: ${err.name === 'TimeoutError' ? 'no answer in 15 seconds' : 'network error'}`);
  }
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  if (!res.ok) throw new SheetError(`Google Sheet (SheetDB) answered HTTP ${res.status}${json?.error ? `: ${String(json.error).slice(0, 160)}` : ''}`, res.status);
  return json;
}

// ---- Google Apps Script connections ("<web app URL>?key=<secret>"): the business's own script in
// its spreadsheet (services/appsScript.js) answers keys/search/append, straight from Google.
export const isAppsScript = (conn) => /\/macros\/s\/[A-Za-z0-9_-]+\/exec\?key=/.test(conn?.url || '');

async function scriptCall(conn, { params = {}, body = null }) {
  const u = new URL(conn.url);
  const key = u.searchParams.get('key');
  u.search = '';
  if (conn.sheet_tab) params.tab = conn.sheet_tab;
  const url = body ? u.toString() : `${u}?${new URLSearchParams({ key, ...params })}`;
  let res;
  try {
    res = await fetch(url, {
      method: body ? 'POST' : 'GET', redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT_MS * 2),
      ...(body ? { body: JSON.stringify({ key, tab: conn.sheet_tab || null, ...body }), headers: { 'Content-Type': 'text/plain;charset=utf-8' } } : {}),
    });
  } catch (err) {
    throw new SheetError(`Google Sheet (Apps Script) could not be reached: ${err.name === 'TimeoutError' ? 'no answer in 30 seconds' : 'network error'}`);
  }
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  if (!res.ok || !json) {
    throw new SheetError(`Google Sheet (Apps Script) answered HTTP ${res.status} without data. Check the script is deployed as a Web app with access "Anyone".`, res.ok ? null : res.status);
  }
  if (json.ok !== true) {
    const msg = String(json.error || 'unknown error').slice(0, 160);
    throw new SheetError(`Google Sheet (Apps Script): ${msg}`, /too many times|quota|rate/i.test(msg) ? 429 : /wrong key/i.test(msg) ? 403 : null);
  }
  return json;
}

// The same three operations for either kind of connection.
async function sheetKeys(conn) {
  return isAppsScript(conn) ? (await scriptCall(conn, { params: { action: 'keys' } })).columns : call(endpoint(conn, '/keys'));
}
async function sheetSearch(conn, text) {
  return isAppsScript(conn) ? (await scriptCall(conn, { params: { action: 'search', field: 'source', q: text } })).rows : call(endpoint(conn, '/search', { source: `*${text}*` }));
}

export const isEmptySheetError = (err) => /Spreadsheet is empty|Fill first row/i.test(String(err?.message || err));

// ---- Stored connection URLs: encrypted with SKYFLY_ENCRYPTION_KEY (plain only where no key is configured, e.g. tests).
export function sealUrl(key, url) { return key ? encrypt(key, url) : `plain:${url}`; }
export function openUrl(key, stored) {
  if (String(stored).startsWith('plain:')) return stored.slice(6);
  if (!key) throw new SheetError('The saved SheetDB URL is encrypted but the server has no encryption key.');
  try { return decrypt(key, stored); } catch { throw new SheetError('The saved SheetDB URL can no longer be read (the server key changed). Enter the URL again.'); }
}
export const urlHash = (url) => createHash('sha256').update(url).digest('hex');
export const urlHint = (url) => url.split('?')[0].slice(-4); // never part of an Apps Script key

function endpoint(conn, path = '', params = {}) {
  const q = new URLSearchParams(params);
  if (conn.sheet_tab) q.set('sheet', conn.sheet_tab);
  const qs = q.toString();
  return `${conn.url}${path}${qs ? `?${qs}` : ''}`;
}

// Loads one connection of this business (never another business's), with its URL decrypted.
export async function loadConnection(pool, key, businessId, connectionId) {
  if (!/^\d+$/.test(String(connectionId ?? ''))) return null;
  const { rows: [conn] } = await pool.query('SELECT * FROM sheet_connections WHERE id = $1 AND business_id = $2', [connectionId, businessId]);
  if (!conn) return null;
  try { conn.url = openUrl(key, conn.api_url_enc); } catch (err) { conn.url = null; conn.urlError = err.message; }
  return conn;
}

export async function addConnection(db, key, businessId, { name, apiUrl, tab = null, spreadsheetUrl = null, makeDefault = false }) {
  const { rows: [conn] } = await db.query(
    `INSERT INTO sheet_connections (business_id, name, api_url_enc, api_url_hash, api_hint, sheet_tab, spreadsheet_url, provider)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [businessId, name, sealUrl(key, apiUrl), urlHash(apiUrl), urlHint(apiUrl), tab || null, spreadsheetUrl || null,
      isAppsScript({ url: apiUrl }) ? 'apps_script' : 'sheetdb']);
  await db.query(
    'UPDATE businesses SET default_sheet_connection_id = $1 WHERE id = $2 AND ($3 OR default_sheet_connection_id IS NULL)',
    [conn.id, businessId, makeDefault]);
  return conn.id;
}

// Moves the single per-business URL used before central Google Sheets into an encrypted
// connection that becomes the business default. Runs on every sync pass; no-op once done.
export async function adoptLegacyUrls(pool, key) {
  const { rows } = await pool.query('SELECT id, sheet_backup_url FROM businesses WHERE sheet_backup_url IS NOT NULL');
  for (const b of rows) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: [locked] } = await client.query('SELECT sheet_backup_url FROM businesses WHERE id = $1 FOR UPDATE', [b.id]);
      if (locked?.sheet_backup_url) {
        const url = locked.sheet_backup_url;
        const { rows: [existing] } = await client.query(
          'SELECT id FROM sheet_connections WHERE business_id = $1 AND api_url_hash = $2 ORDER BY id LIMIT 1', [b.id, urlHash(url)]);
        if (existing) await client.query('UPDATE businesses SET default_sheet_connection_id = coalesce(default_sheet_connection_id, $1) WHERE id = $2', [existing.id, b.id]);
        else await addConnection(client, key, b.id, { name: 'Orders sheet', apiUrl: url });
        await client.query('UPDATE businesses SET sheet_backup_url = NULL WHERE id = $1', [b.id]);
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
  return rows.length;
}

// Reads the sheet's column row and compares it with what Skyfly writes. Saves the result.
export async function checkConnection(pool, conn) {
  let status; let detail; let columns = null; let tabSummary = '';
  if (!conn.url) {
    status = 'error'; detail = conn.urlError;
  } else {
    try {
      // Apps Script: first a read-only look at every tab, reported to the owner.
      const tabs = isAppsScript(conn) ? (await scriptCall(conn, { params: { action: 'tabs' } })).tabs : null;
      columns = await sheetKeys(conn);
      if (!Array.isArray(columns)) throw new SheetError('The sheet did not return its column names.');
      if (tabs) {
        const target = conn.sheet_tab || SKYFLY_TAB;
        tabSummary = `Tabs: ${tabs.map((t) => (t.name === target ? `${t.name} (Skyfly writes here)` : `${t.name} (${Math.max(t.rows - 1, 0)} rows below row 1, not changed)`)).join('; ')}.`;
      }
      const missingRequired = REQUIRED_COLUMNS.filter((c) => !columns.includes(c));
      const missing = SHEET_COLUMNS.filter((c) => !columns.includes(c));
      const extra = columns.filter((c) => c && !SHEET_COLUMNS.includes(c));
      if (missingRequired.length) {
        status = 'needs_columns';
        detail = `Row 1 is missing the column${missingRequired.length > 1 ? 's' : ''} ${missingRequired.join(', ')}. Skyfly needs them to write orders and avoid duplicates.`;
      } else {
        status = 'ok';
        detail = [
          tabSummary,
          `All ${SHEET_COLUMNS.length - missing.length} of Skyfly's ${SHEET_COLUMNS.length} columns match.`,
          missing.length ? `Not in the sheet (left out): ${missing.join(', ')}.` : '',
          extra.length ? `Extra columns left empty: ${extra.join(', ')}.` : '',
        ].filter(Boolean).join(' ');
      }
    } catch (err) {
      if (isEmptySheetError(err)) { status = 'needs_columns'; detail = 'The sheet is empty: row 1 has no column names, so SheetDB refuses every new row.'; }
      else { status = 'error'; detail = err.message; }
    }
  }
  await pool.query(
    'UPDATE sheet_connections SET check_status = $2, check_detail = $3, sheet_columns = $4, checked_at = now() WHERE id = $1',
    [conn.id, status, detail, columns ? JSON.stringify(columns) : null]);
  Object.assign(conn, { check_status: status, check_detail: detail, sheet_columns: columns });
  return { status, detail, columns };
}

// For a spreadsheet with no column row: adds a "Skyfly Orders" tab whose first row holds
// Skyfly's columns, and points the connection at it. Existing tabs are not touched.
export async function setupColumns(pool, conn, { auto = false } = {}) {
  if (isAppsScript(conn)) return checkConnection(pool, conn); // the script writes its own column row
  if (auto) await pool.query('UPDATE sheet_connections SET auto_setup_at = now() WHERE id = $1', [conn.id]);
  const tabConn = { ...conn, sheet_tab: SKYFLY_TAB };
  try {
    await call(`${conn.url}/sheet`, { method: 'POST', body: JSON.stringify({ name: SKYFLY_TAB, first_row: SHEET_COLUMNS }) });
  } catch (err) {
    // The tab may already exist (an earlier attempt): use it if it has the right columns.
    let cols = null;
    try { cols = await call(endpoint(tabConn, '/keys')); } catch { /* not there */ }
    if (!Array.isArray(cols) || !REQUIRED_COLUMNS.every((c) => cols.includes(c))) {
      throw new SheetError(err.status === 402
        ? `Skyfly could not add a "${SKYFLY_TAB}" tab: the SheetDB plan does not allow adding tabs. Type the column names into row 1 of the sheet instead, then click "Check connection" (Skyfly also checks every 6 hours) and the waiting orders are sent.`
        : `Skyfly could not add the "${SKYFLY_TAB}" tab: ${err.message}`, err.status);
    }
  }
  await pool.query('UPDATE sheet_connections SET sheet_tab = $2, updated_at = now() WHERE id = $1', [conn.id, SKYFLY_TAB]);
  conn.sheet_tab = SKYFLY_TAB;
  return checkConnection(pool, conn);
}

// Values starting with = + - @ would run as formulas in Google Sheets; a leading
// apostrophe keeps them as text. Phone numbers (+234…) stay as they are.
const safe = (v) => { const s = String(v ?? ''); return /^[=+\-@]/.test(s) && !/^\+\d[\d\s]{5,}$/.test(s) ? `'${s}` : s; };

// Same columns the landing page has always written.
export function sheetRow(order, items, pageName) {
  const pkg = items.map((i) => `${i.product_name}${i.quantity > 1 ? ` x${i.quantity}` : ''}`).join(', ');
  const origin = order.source === 'manual' ? 'Entered in Skyfly' : (pageName || 'Website');
  return {
    timestamp: new Date(order.created_at).toISOString(),
    fullName: safe(order.customer_name),
    address: safe(order.address + (order.state ? `, ${order.state}` : '')),
    phone: safe(order.phone),
    email: safe(order.email || ''),
    package: safe(pkg),
    source: safe(`${origin} | Skyfly ${order.reference} | ID ${String(order.idempotency_key || '').slice(0, 8)}${order.is_test ? ' | TEST ORDER' : ''}`),
    state: safe(order.state || ''),
    quantity: items.reduce((n, i) => n + i.quantity, 0),
    notes: safe(order.customer_notes || ''),
    skyflyId: order.idempotency_key || '',
    total: Number(order.total_minor) / 100,
    orderId: order.reference,
    status: STATUS_LABELS[order.status] ?? order.status ?? '',
  };
}

async function alreadyInSheet(conn, reference) {
  const rows = await sheetSearch(conn, reference);
  return Array.isArray(rows) && rows.length > 0;
}

async function sheetIsEmpty(conn) {
  if (isAppsScript(conn)) return false;
  try { await call(endpoint(conn, '/keys')); return false; } catch (err) { return isEmptySheetError(err); }
}

// The sheet an order goes to: its landing page's own sheet, else the business default.
// Both references are constrained to the order's business in the database.
async function targetFor(pool, key, o) {
  const id = o.page_sheet_id ?? o.default_sheet_id;
  return id ? loadConnection(pool, key, o.business_id, id) : null;
}

// Sends one order to its sheet (or confirms it is already there) and records the result.
export async function syncOrder(pool, orderId, { key = null } = {}) {
  const { rows: [o] } = await pool.query(
    `SELECT o.*, lp.name AS page_name, lp.sheet_connection_id AS page_sheet_id, b.default_sheet_connection_id AS default_sheet_id
       FROM orders o JOIN businesses b ON b.id = o.business_id LEFT JOIN landing_pages lp ON lp.id = o.landing_page_id
      WHERE o.id = $1`, [orderId]);
  if (!o) return null;
  const conn = await targetFor(pool, key, o);
  if (!conn) {
    await pool.query("UPDATE orders SET sheet_sync_status = 'skipped', sheet_sync_error = NULL, sheet_connection_id = NULL WHERE id = $1", [orderId]);
    return 'skipped';
  }
  // The sheet is known not to accept rows (no column row, automatic fix already tried), or SheetDB's
  // request quota is used up: wait for the periodic check instead of spending requests on every order.
  const blocked = (conn.check_status === 'needs_columns' && (conn.auto_setup_at || conn.sheet_tab))
    || (conn.quota_until && new Date(conn.quota_until) > new Date());
  if (blocked) {
    await pool.query(
      `UPDATE orders SET sheet_sync_status = 'failed', sheet_sync_error = $2, sheet_connection_id = $3,
              sheet_sync_next_at = now() + make_interval(mins => $4) WHERE id = $1`,
      [orderId, conn.check_status === 'needs_columns'
        ? 'Waiting: the Google Sheet has no column names in row 1. Skyfly checks again every 6 hours and then sends this order.'
        : 'Waiting: SheetDB\'s monthly request limit is used up. Skyfly tries again later.', conn.id, HOLD_MINUTES]);
    return 'failed';
  }
  const { rows: items } = await pool.query('SELECT product_name, quantity FROM order_items WHERE order_id = $1 ORDER BY id', [orderId]);
  const attempt = async () => {
    if (!conn.url) throw new SheetError(conn.urlError);
    // Apps Script checks for the order and adds it in one locked step.
    if (isAppsScript(conn)) {
      await scriptCall(conn, { body: { action: 'append', id: o.idempotency_key, ref: o.reference, row: sheetRow(o, items, o.page_name) } });
      return;
    }
    // Always check first: the landing page (older versions) or a slow earlier attempt may already have written this order.
    if (!(await alreadyInSheet(conn, o.reference))) {
      const r = await call(endpoint(conn), { method: 'POST', body: JSON.stringify({ data: sheetRow(o, items, o.page_name) }) });
      if (typeof r?.created === 'number' && r.created < 1) throw new SheetError('SheetDB answered but added no row.');
    }
  };
  try {
    try {
      await attempt();
    } catch (err) {
      // An empty spreadsheet (no column row) is fixed once, automatically, with a Skyfly tab.
      if (!conn.url || conn.sheet_tab || conn.auto_setup_at || !(isEmptySheetError(err) || await sheetIsEmpty(conn))) throw err;
      try {
        await setupColumns(pool, conn, { auto: true });
      } catch (setupErr) {
        throw new SheetError(`The sheet is empty (no column names in row 1). ${setupErr.message}`);
      }
      await requeue(pool, o.business_id); // every failed copy of this business goes out again now
      await attempt();
    }
    await pool.query(
      `UPDATE orders SET sheet_sync_status = 'synced', sheet_synced_at = now(), sheet_sync_error = NULL,
              sheet_sync_attempts = sheet_sync_attempts + 1, sheet_connection_id = $2 WHERE id = $1`,
      [orderId, conn.id]);
    await pool.query('UPDATE sheet_connections SET last_success_at = now() WHERE id = $1', [conn.id]);
    return 'synced';
  } catch (err) {
    // Remember sheet-wide problems so the other waiting orders don't each spend requests on them.
    if (err.status === 429) await pool.query("UPDATE sheet_connections SET quota_until = now() + make_interval(mins => $2) WHERE id = $1", [conn.id, HOLD_MINUTES]);
    else if (isEmptySheetError(err)) await pool.query("UPDATE sheet_connections SET check_status = 'needs_columns', checked_at = now(), check_detail = 'The sheet is empty: row 1 has no column names, so SheetDB refuses every new row.' WHERE id = $1", [conn.id]);
    // A used-up quota is a pause, not a failed attempt: SheetDB's quota resets monthly, so orders
    // waiting weeks for it must not run out of attempts.
    const attempts = err.status === 429 ? o.sheet_sync_attempts : o.sheet_sync_attempts + 1;
    const wait = err.status === 429 ? HOLD_MINUTES : RETRY_MINUTES[Math.min(attempts - 1, RETRY_MINUTES.length - 1)];
    const message = String(err.message || err).slice(0, 300);
    await pool.query(
      `UPDATE orders SET sheet_sync_status = 'failed', sheet_sync_attempts = $2, sheet_sync_error = $3,
              sheet_sync_next_at = now() + make_interval(mins => $4), sheet_connection_id = $5 WHERE id = $1`,
      [orderId, attempts, message, wait, conn.id]);
    await pool.query('UPDATE sheet_connections SET last_error = $2, last_error_at = now() WHERE id = $1', [conn.id, message]);
    return 'failed';
  }
}

// Orders due for a (re)try, oldest first. Returns how many were processed.
export async function syncDue(pool, { limit = 10, key = null } = {}) {
  await adoptLegacyUrls(pool, key);
  const { rows } = await pool.query(
    `SELECT id FROM orders WHERE sheet_sync_status IN ('pending', 'failed') AND sheet_sync_next_at <= now()
        AND sheet_sync_attempts < $1 ORDER BY id LIMIT $2`, [MAX_ATTEMPTS, limit]);
  for (const r of rows) await syncOrder(pool, r.id, { key });
  return rows.length;
}

// Re-checks spreadsheets that are not working (e.g. an empty sheet waiting for its column
// row) every 6 hours while copies are waiting. When one starts working, its business's failed copies go out at once.
export async function recheckConnections(pool, key, { minutes = HOLD_MINUTES } = {}) {
  const { rows } = await pool.query(
    `SELECT c.id, c.business_id FROM sheet_connections c
      WHERE c.check_status <> 'ok' AND (c.checked_at IS NULL OR c.checked_at < now() - make_interval(mins => $1))
        AND (c.quota_until IS NULL OR c.quota_until < now())
        AND EXISTS (SELECT 1 FROM orders o WHERE o.business_id = c.business_id AND o.sheet_sync_status = 'failed')`, [minutes]);
  let fixed = 0;
  for (const r of rows) {
    const conn = await loadConnection(pool, key, r.business_id, r.id);
    const { status } = await checkConnection(pool, conn);
    if (status === 'ok') { fixed += 1; await requeue(pool, r.business_id); }
  }
  return fixed;
}

// New orders wait a few minutes before their first copy, so a row the landing page
// writes itself (older page versions) is in the sheet before Skyfly checks for it.
export const FIRST_COPY_DELAY_MINUTES = 3;

// Background loop in the web process: runs every minute, and right away when an order arrives.
export function startSheetWorker(pool, { key = null, intervalMs = 60000, log = console } = {}) {
  let running = false;
  let again = false;
  // Last run, shown on /healthz so production runs can be checked from outside.
  const status = { lastRunAt: null, lastOkAt: null, lastError: null };
  const run = async () => {
    if (running) { again = true; return; }
    running = true;
    status.lastRunAt = new Date().toISOString();
    try {
      await recheckConnections(pool, key);
      do { again = false; while (await syncDue(pool, { key }) === 10) { /* drain */ } } while (again);
      status.lastOkAt = status.lastRunAt;
      status.lastError = null;
    } catch (err) {
      status.lastError = String(err.message).slice(0, 200);
      log.error('Google Sheet sync error:', err.message);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(run, intervalMs);
  timer.unref?.();
  setTimeout(run, 2000).unref?.();
  return { kick: () => { setImmediate(run); }, stop: () => clearInterval(timer), status };
}

// Makes failed (or, for one order, skipped) copies eligible for an immediate retry, with a
// fresh set of attempts. Optionally only those for one sheet.
export async function requeue(pool, businessId, orderId = null, connectionId = null) {
  const params = [businessId];
  let where = `business_id = $1 AND sheet_sync_status IN ('failed'${orderId ? ", 'skipped'" : ''})`;
  if (orderId) { params.push(orderId); where += ` AND id = $${params.length}`; }
  if (connectionId) { params.push(connectionId); where += ` AND sheet_connection_id = $${params.length}`; }
  const { rowCount } = await pool.query(
    `UPDATE orders SET sheet_sync_status = 'pending', sheet_sync_next_at = now(), sheet_sync_attempts = 0 WHERE ${where}`, params);
  return rowCount;
}

// ---- Recovery: rows that reached only the Google Sheet (Skyfly was not reachable or not connected).
export const FALLBACK_MARKERS = ['NOT IN SKYFLY', 'SKYFLY NOT CONNECTED'];

export function rowKey(row) {
  return createHash('sha256').update(JSON.stringify([row.timestamp, row.phone, row.package, row.fullName])).digest('hex').slice(0, 32);
}

// Searches the connection's tab and, when that is Skyfly's own tab, the first tab too
// (older landing pages write their fallback rows there).
export async function fallbackRows(conn) {
  const targets = [conn];
  if (conn.sheet_tab === SKYFLY_TAB) targets.push({ ...conn, sheet_tab: null });
  const found = [];
  let firstError = null;
  for (const t of targets) {
    for (const marker of FALLBACK_MARKERS) {
      try {
        const rows = await sheetSearch(t, marker);
        if (Array.isArray(rows)) found.push(...rows);
      } catch (err) {
        if (t === conn && !isEmptySheetError(err)) firstError ??= err;
      }
    }
  }
  if (firstError && !found.length) throw firstError;
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
