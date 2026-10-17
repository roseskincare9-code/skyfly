// Google Sheets, managed in one place per business: spreadsheet connections, the default
// sheet new landing pages use, per-page overrides, copy status and retries, CSV downloads,
// and recovery of orders that reached only the sheet.
import { Router } from 'express';
import { asyncHandler } from '../lib/http.js';
import { audit } from '../lib/audit.js';
import { toCsv } from '../lib/csv.js';
import {
  SHEETDB_URL_RE, GOOGLE_SHEET_URL_RE, SHEET_COLUMNS, SKYFLY_TAB, FALLBACK_MARKERS,
  addConnection, adoptLegacyUrls, checkConnection, loadConnection, setupColumns, sheetRow,
  sealUrl, urlHash, urlHint, fallbackRows, prefillFromRow, requeue, rowKey, isAppsScript,
} from '../services/sheets.js';
import { APPS_SCRIPT_URL_RE, appsScriptSource, newScriptKey } from '../services/appsScript.js';

const NOTICES = {
  added: 'Spreadsheet connected.', saved: 'Saved.', default: 'Default spreadsheet changed. Pages without their own sheet now use it.',
  checked: 'Connection checked.', setup: `Added the "${SKYFLY_TAB}" tab with Skyfly's columns. Failed copies are being retried now.`,
  removed: 'Spreadsheet connection removed.', page: 'Landing page sheet saved.', retrying: 'Retrying failed copies now. Refresh in a few seconds.',
};

export function googleSheetsRoutes({ pool, config, onOrderSaved = () => {} }) {
  const router = Router({ mergeParams: true });
  const key = config.encryptionKey ?? null;
  const validApiUrl = (u) => SHEETDB_URL_RE.test(u) || (!config.isProduction && /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/api\/v1\/[A-Za-z0-9]+$/.test(u));
  const validScriptUrl = (u) => APPS_SCRIPT_URL_RE.test(u) || (!config.isProduction && /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(u));
  const readTab = (v) => String(v ?? '').trim().slice(0, 100) || null;

  function readForm(body, { requireUrl }) {
    const errors = [];
    const name = String(body.name ?? '').trim().slice(0, 120) || 'Orders sheet';
    let apiUrl = String(body.api_url ?? '').trim().replace(/\/+$/, '');
    if (body.kind === 'apps_script') {
      // The web app URL plus the secret key written into the script shown on this page.
      const scriptKey = String(body.script_key ?? '');
      if (!validScriptUrl(apiUrl)) errors.push('Enter the Web app URL from Apps Script (Deploy → Manage deployments), like https://script.google.com/macros/s/…/exec.');
      else if (!/^[A-Za-z0-9_-]{32}$/.test(scriptKey)) errors.push('The script key is missing. Copy the script on this page again.');
      else apiUrl = `${apiUrl}?key=${scriptKey}`;
    } else if (requireUrl || apiUrl) {
      if (!validApiUrl(apiUrl)) errors.push('Enter the SheetDB API URL, like https://sheetdb.io/api/v1/abc123def456.');
    }
    const spreadsheetUrl = String(body.spreadsheet_url ?? '').trim();
    if (spreadsheetUrl && !GOOGLE_SHEET_URL_RE.test(spreadsheetUrl)) errors.push('The spreadsheet link must be a Google Sheets link (https://docs.google.com/spreadsheets/d/…).');
    return { name, apiUrl, tab: readTab(body.sheet_tab), spreadsheetUrl: spreadsheetUrl || null, errors };
  }

  async function render(req, res, { error = null, notice = null, status = 200, form = {} } = {}) {
    const b = req.business;
    // A fresh secret for a new Apps Script connection (kept when the form is shown again after an error).
    const scriptKey = /^[A-Za-z0-9_-]{32}$/.test(String(form.script_key ?? '')) ? form.script_key : newScriptKey();
    await adoptLegacyUrls(pool, key);
    const { rows: [biz] } = await pool.query('SELECT default_sheet_connection_id FROM businesses WHERE id = $1', [b.id]);
    const defaultId = biz.default_sheet_connection_id;
    const [{ rows: connections }, { rows: counts }, { rows: pages }] = await Promise.all([
      pool.query(
        `SELECT c.id, c.name, c.api_hint, c.provider, c.sheet_tab, c.spreadsheet_url, c.check_status, c.check_detail, c.checked_at,
                c.last_success_at, c.last_error, c.last_error_at, c.created_at,
                (SELECT count(*)::int FROM orders o WHERE o.sheet_connection_id = c.id AND o.sheet_sync_status = 'synced') AS synced,
                (SELECT count(*)::int FROM orders o WHERE o.sheet_connection_id = c.id AND o.sheet_sync_status = 'failed') AS failed
           FROM sheet_connections c WHERE c.business_id = $1 ORDER BY c.id`, [b.id]),
      pool.query('SELECT sheet_sync_status AS s, count(*)::int AS n FROM orders WHERE business_id = $1 GROUP BY 1', [b.id]),
      pool.query('SELECT id, name, slug, status, sheet_connection_id FROM landing_pages WHERE business_id = $1 ORDER BY status = \'archived\', created_at', [b.id]),
    ]);
    const count = Object.fromEntries(counts.map((r) => [r.s, r.n]));
    const { rows: [last] } = await pool.query(
      "SELECT max(sheet_synced_at) AS at FROM orders WHERE business_id = $1 AND sheet_sync_status = 'synced'", [b.id]);

    // Recovery: rows that reached only the sheet, from the default spreadsheet (or the one chosen).
    let rows = [];
    let fetchError = null;
    const checkId = req.query.check === '1' ? (req.query.connection || defaultId) : null;
    if (checkId) {
      const conn = await loadConnection(pool, key, b.id, checkId);
      try {
        if (!conn) throw new Error('Choose a connected spreadsheet.');
        if (!conn.url) throw new Error(conn.urlError);
        const sheetRows = await fallbackRows(conn);
        const keys = sheetRows.map(rowKey);
        const { rows: done } = await pool.query(
          `SELECT r.row_key, o.id, o.reference FROM sheet_recoveries r LEFT JOIN orders o ON o.id = r.order_id
            WHERE r.business_id = $1 AND r.row_key = ANY($2::text[])`, [b.id, keys]);
        const doneBy = new Map(done.map((d) => [d.row_key, d]));
        const [{ rows: products }, { rows: [page] }] = await Promise.all([
          pool.query('SELECT id, code, name FROM products WHERE business_id = $1', [b.id]),
          pool.query("SELECT id FROM landing_pages WHERE business_id = $1 ORDER BY (slug = 'larosenigeria') DESC, id LIMIT 1", [b.id]),
        ]);
        rows = sheetRows.map((r) => ({
          row: r, recovered: doneBy.get(rowKey(r)) ?? null,
          prefill: new URLSearchParams(prefillFromRow(r, products, page?.id)).toString(),
        }));
      } catch (err) {
        fetchError = err.message;
      }
    }
    res.set('Cache-Control', 'no-store');
    res.status(status).render('google-sheets', {
      active: 'sheet', error, notice, count, connections, defaultId, pages, lastSync: last.at, form,
      rows, fetchError, checked: Boolean(checkId), markers: FALLBACK_MARKERS, columns: SHEET_COLUMNS, skyflyTab: SKYFLY_TAB,
      encrypted: Boolean(key), scriptKey, appsScript: appsScriptSource(scriptKey),
    });
  }

  const done = (res, what, anchor = '') => res.redirect(`${res.locals.base}/google-sheets?done=${what}${anchor}`);
  const notFound = (res) => res.status(404).render('error', { message: 'Spreadsheet connection not found.' });

  router.get('/', asyncHandler((req, res) => render(req, res, { notice: NOTICES[req.query.done] ?? null })));

  router.post('/connections', asyncHandler(async (req, res) => {
    const f = readForm(req.body, { requireUrl: true });
    if (f.errors.length) return render(req, res, { error: f.errors.join(' '), status: 400, form: { ...req.body, api_url: '' } });
    let id;
    try {
      id = await addConnection(pool, key, req.business.id, { ...f, makeDefault: req.body.make_default === 'on' });
    } catch (err) {
      if (err.code === '23505') return render(req, res, { error: 'This spreadsheet (and tab) is already connected.', status: 409 });
      throw err;
    }
    const conn = await loadConnection(pool, key, req.business.id, id);
    await checkConnection(pool, conn);
    await audit(pool, req, { action: 'google_sheets.connected', businessId: req.business.id, entityType: 'sheet_connection', entityId: id, details: { name: f.name, tab: f.tab } });
    done(res, 'added', `#sheet-${id}`);
  }));

  router.post('/connections/:id', asyncHandler(async (req, res) => {
    const conn = await loadConnection(pool, key, req.business.id, req.params.id);
    if (!conn) return notFound(res);
    const f = readForm(req.body, { requireUrl: false });
    if (f.errors.length) return render(req, res, { error: f.errors.join(' '), status: 400 });
    try {
      // The URL is only replaced when a new one is entered (it is never shown again).
      await pool.query(
        `UPDATE sheet_connections SET name = $2, sheet_tab = $3, spreadsheet_url = $4, updated_at = now(),
                api_url_enc = coalesce($5, api_url_enc), api_url_hash = coalesce($6, api_url_hash), api_hint = coalesce($7, api_hint),
                auto_setup_at = CASE WHEN $5::text IS NULL THEN auto_setup_at END,
                provider = coalesce($9, provider)
          WHERE id = $1 AND business_id = $8`,
        [conn.id, f.name, f.tab, f.spreadsheetUrl, f.apiUrl ? sealUrl(key, f.apiUrl) : null, f.apiUrl ? urlHash(f.apiUrl) : null, f.apiUrl ? urlHint(f.apiUrl) : null, req.business.id,
          f.apiUrl ? (isAppsScript({ url: f.apiUrl }) ? 'apps_script' : 'sheetdb') : null]);
    } catch (err) {
      if (err.code === '23505') return render(req, res, { error: 'This spreadsheet (and tab) is already connected.', status: 409 });
      throw err;
    }
    await checkConnection(pool, await loadConnection(pool, key, req.business.id, conn.id));
    await audit(pool, req, { action: 'google_sheets.updated', businessId: req.business.id, entityType: 'sheet_connection', entityId: conn.id, details: { name: f.name, tab: f.tab, urlChanged: Boolean(f.apiUrl) } });
    done(res, 'saved', `#sheet-${conn.id}`);
  }));

  router.post('/connections/:id/default', asyncHandler(async (req, res) => {
    const conn = await loadConnection(pool, key, req.business.id, req.params.id);
    if (!conn) return notFound(res);
    await pool.query('UPDATE businesses SET default_sheet_connection_id = $1 WHERE id = $2', [conn.id, req.business.id]);
    await audit(pool, req, { action: 'google_sheets.default_changed', businessId: req.business.id, entityType: 'sheet_connection', entityId: conn.id });
    done(res, 'default');
  }));

  router.post('/connections/:id/check', asyncHandler(async (req, res) => {
    const conn = await loadConnection(pool, key, req.business.id, req.params.id);
    if (!conn) return notFound(res);
    const wasOk = conn.check_status === 'ok';
    const { status } = await checkConnection(pool, conn);
    // Just fixed (e.g. the column row was added): send the waiting copies now.
    if (status === 'ok' && !wasOk && await requeue(pool, req.business.id)) onOrderSaved();
    done(res, 'checked', `#sheet-${conn.id}`);
  }));

  router.post('/connections/:id/setup', asyncHandler(async (req, res) => {
    const conn = await loadConnection(pool, key, req.business.id, req.params.id);
    if (!conn) return notFound(res);
    if (!conn.url) return render(req, res, { error: conn.urlError, status: 400 });
    try {
      await setupColumns(pool, conn);
    } catch (err) {
      return render(req, res, { error: `${err.message} Add the column names to row 1 of the sheet yourself instead (listed below), then click "Check connection".`, status: 502 });
    }
    // Copies that failed because the sheet had no columns go out again, to the new tab.
    if (await requeue(pool, req.business.id)) onOrderSaved();
    await audit(pool, req, { action: 'google_sheets.columns_added', businessId: req.business.id, entityType: 'sheet_connection', entityId: conn.id, details: { tab: SKYFLY_TAB } });
    done(res, 'setup', `#sheet-${conn.id}`);
  }));

  router.post('/connections/:id/delete', asyncHandler(async (req, res) => {
    const conn = await loadConnection(pool, key, req.business.id, req.params.id);
    if (!conn) return notFound(res);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('UPDATE businesses SET default_sheet_connection_id = NULL WHERE id = $1 AND default_sheet_connection_id = $2', [req.business.id, conn.id]);
      await client.query('UPDATE landing_pages SET sheet_connection_id = NULL WHERE business_id = $1 AND sheet_connection_id = $2', [req.business.id, conn.id]);
      // Orders keep their copy status; waiting ones will go to the new default (if any).
      await client.query('UPDATE orders SET sheet_connection_id = NULL WHERE business_id = $1 AND sheet_connection_id = $2', [req.business.id, conn.id]);
      await client.query('DELETE FROM sheet_connections WHERE id = $1 AND business_id = $2', [conn.id, req.business.id]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    await audit(pool, req, { action: 'google_sheets.removed', businessId: req.business.id, entityType: 'sheet_connection', entityId: conn.id, details: { name: conn.name } });
    done(res, 'removed');
  }));

  // A landing page's own sheet ("" = use the business default).
  router.post('/pages/:pageId', asyncHandler(async (req, res) => {
    if (!/^\d+$/.test(req.params.pageId)) return res.status(404).render('error', { message: 'Landing page not found.' });
    const choice = String(req.body.sheet_connection_id ?? '');
    let connId = null;
    if (choice) {
      const conn = await loadConnection(pool, key, req.business.id, choice);
      if (!conn) return render(req, res, { error: 'Choose one of this business\'s spreadsheets.', status: 400 });
      connId = conn.id;
    }
    const { rowCount } = await pool.query(
      'UPDATE landing_pages SET sheet_connection_id = $1, updated_at = now() WHERE id = $2 AND business_id = $3', [connId, req.params.pageId, req.business.id]);
    if (!rowCount) return res.status(404).render('error', { message: 'Landing page not found.' });
    await audit(pool, req, { action: 'google_sheets.page_sheet_changed', businessId: req.business.id, entityType: 'landing_page', entityId: req.params.pageId, details: { sheet: connId ?? 'default' } });
    done(res, 'page', '#pages');
  }));

  router.post('/retry-failed', asyncHandler(async (req, res) => {
    const connId = /^\d+$/.test(String(req.body.connection_id ?? '')) ? req.body.connection_id : null;
    const n = await requeue(pool, req.business.id, null, connId);
    if (n) onOrderSaved();
    await audit(pool, req, { action: 'sheet_backup.retry_failed', businessId: req.business.id, details: { orders: n } });
    done(res, 'retrying');
  }));

  // Orders as rows in the Google Sheet's own columns (to paste or import into a sheet).
  router.get('/export.csv', asyncHandler(async (req, res) => {
    const params = [req.business.id];
    const where = ['o.business_id = $1'];
    let conn = null;
    if (req.query.connection) {
      conn = await loadConnection(pool, key, req.business.id, req.query.connection);
      if (!conn) return notFound(res);
      params.push(conn.id);
      where.push(`coalesce(o.sheet_connection_id, lp.sheet_connection_id, b.default_sheet_connection_id) = $${params.length}`);
    }
    if (req.query.test !== 'include') where.push('NOT o.is_test');
    const { rows } = await pool.query(
      `SELECT o.*, lp.name AS page_name FROM orders o JOIN businesses b ON b.id = o.business_id
         LEFT JOIN landing_pages lp ON lp.id = o.landing_page_id WHERE ${where.join(' AND ')} ORDER BY o.created_at`, params);
    const { rows: items } = await pool.query(
      'SELECT order_id, product_name, quantity FROM order_items WHERE order_id = ANY($1::bigint[]) ORDER BY id', [rows.map((o) => o.id)]);
    const byOrder = Map.groupBy(items, (i) => String(i.order_id));
    await audit(pool, req, { action: 'google_sheets.exported', businessId: req.business.id, details: { rows: rows.length, sheet: conn?.id ?? 'all' } });
    const csv = toCsv([...SHEET_COLUMNS, 'copyStatus'], rows.map((o) => {
      const r = sheetRow(o, byOrder.get(String(o.id)) ?? [], o.page_name);
      return [...SHEET_COLUMNS.map((c) => r[c]), o.sheet_sync_status];
    }));
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="sheet-rows-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.set('Cache-Control', 'no-store');
    res.send(`﻿${csv}`);
  }));

  return router;
}
