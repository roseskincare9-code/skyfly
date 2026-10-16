// Google Sheet backup: settings, sync status, retries, and recovery of orders that
// reached only the sheet (when Skyfly could not be reached from the landing page).
import { Router } from 'express';
import { asyncHandler } from '../lib/http.js';
import { audit } from '../lib/audit.js';
import { SHEETDB_URL_RE, FALLBACK_MARKERS, fallbackRows, prefillFromRow, requeue, rowKey } from '../services/sheets.js';

export function sheetBackupRoutes({ pool, config, onOrderSaved = () => {} }) {
  const router = Router({ mergeParams: true });
  const validUrl = (u) => SHEETDB_URL_RE.test(u) || (!config.isProduction && /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/api\/v1\/[A-Za-z0-9]+$/.test(u));

  async function render(req, res, { error = null, notice = null, status = 200 } = {}) {
    const b = req.business;
    const { rows: counts } = await pool.query(
      'SELECT sheet_sync_status AS s, count(*)::int AS n FROM orders WHERE business_id = $1 GROUP BY 1', [b.id]);
    const count = Object.fromEntries(counts.map((r) => [r.s, r.n]));
    let rows = [];
    let fetchError = null;
    if (b.sheet_backup_url && req.query.check === '1') {
      try {
        const sheetRows = await fallbackRows(b.sheet_backup_url);
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
    res.status(status).render('sheet-backup', { active: 'settings', error, notice, count, rows, fetchError, checked: req.query.check === '1', markers: FALLBACK_MARKERS });
  }

  router.get('/', asyncHandler((req, res) => render(req, res, { notice: { saved: 'Saved.', retrying: 'Retrying failed copies now. Refresh in a few seconds.' }[req.query.done] ?? null })));

  router.post('/', asyncHandler(async (req, res) => {
    const url = String(req.body.sheet_backup_url ?? '').trim().replace(/\/+$/, '');
    if (url && !validUrl(url)) return render(req, res, { error: 'Enter the SheetDB API URL, e.g. https://sheetdb.io/api/v1/abc123def456, or leave it empty to turn the backup off.', status: 400 });
    await pool.query('UPDATE businesses SET sheet_backup_url = $1 WHERE id = $2', [url || null, req.business.id]);
    await audit(pool, req, { action: 'sheet_backup.updated', businessId: req.business.id, details: { enabled: Boolean(url) } });
    res.redirect(`${res.locals.base}/sheet-backup?done=saved`);
  }));

  router.post('/retry-failed', asyncHandler(async (req, res) => {
    const n = await requeue(pool, req.business.id);
    if (n) onOrderSaved();
    await audit(pool, req, { action: 'sheet_backup.retry_failed', businessId: req.business.id, details: { orders: n } });
    res.redirect(`${res.locals.base}/sheet-backup?done=retrying`);
  }));

  return router;
}
