// Read-only reconciliation of orders waiting to be copied against an existing spreadsheet, using all the
// evidence a row can carry: Skyfly reference or ID, phone number, time, name and product. Older landing
// page versions wrote rows into the sheet themselves (without a Skyfly reference), so "not found by
// reference" does not prove an order is missing. Nothing is written anywhere. The log lines mask
// customer details (first initial, last 4 phone digits).
import { readAllTabs, spreadsheetTitle } from './googleSheetsApi.js';

const digits10 = (v) => { const d = String(v ?? '').replace(/\D/g, ''); return d.length >= 7 ? d.slice(-10) : ''; };
const firstName = (v) => String(v ?? '').trim().split(/\s+/)[0]?.toLowerCase() ?? '';
export const maskName = (v) => { const f = String(v ?? '').trim(); return f ? `${f[0].toUpperCase()}.` : '?'; };
export const maskPhone = (v) => { const d = String(v ?? '').replace(/\D/g, ''); return d.length >= 4 ? `…${d.slice(-4)}` : '?'; };
const LAGOS_OFFSET_MIN = 60; // sheet times without a zone are read as Lagos time (UTC+1)

// A sheet time: ISO, a Sheets serial number, or d/m/y or m/d/y with optional time. Ambiguous day/month
// orders are resolved to the reading closest to `near` (the order's own time).
export function parseSheetTime(raw, near = null) {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  if (/^\d{4}-\d\d-\d\dT/.test(s)) { const t = Date.parse(s); return Number.isNaN(t) ? null : t; }
  if (/^\d{5}(\.\d+)?$/.test(s)) return Math.round((Number(s) - 25569) * 86400000) - LAGOS_OFFSET_MIN * 60000;
  const m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})(?:[ ,T]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?)?$/i);
  if (!m) { const t = Date.parse(s); return Number.isNaN(t) ? null : t; }
  let [, a, b, y, hh = '0', mm = '0', ss = '0', ap] = m;
  y = Number(y.length === 2 ? `20${y}` : y);
  const h = ap ? (Number(hh) % 12) + (ap.toLowerCase() === 'pm' ? 12 : 0) : Number(hh);
  const at = (day, month) => (month >= 1 && month <= 12 && day >= 1 && day <= 31 ? Date.UTC(y, month - 1, day, h, Number(mm), Number(ss)) - LAGOS_OFFSET_MIN * 60000 : null);
  const options = [at(Number(a), Number(b)), at(Number(b), Number(a))].filter((t) => t !== null);
  if (!options.length) return null;
  return near ? options.sort((x, z) => Math.abs(x - near) - Math.abs(z - near))[0] : options[0];
}

// Which column holds what, from the header row (any wording the older pages used).
export function columnsOf(header) {
  const h = header.map((c) => String(c ?? '').trim().toLowerCase());
  const find = (re, not = null) => h.findIndex((c) => re.test(c) && !(not && not.test(c)));
  return {
    phone: find(/phone|mobile|whats ?app|tel/),
    name: find(/full ?name|^name$|customer|client/, /business|product|package|page/),
    time: find(/time ?stamp|date|time|created|submitted/),
    product: find(/package|product|item|offer|bundle/),
    quantity: find(/qty|quantity/),
    total: find(/total|amount|price/),
    orderId: h.indexOf('orderid'),
    skyflyId: h.indexOf('skyflyid'),
    source: h.indexOf('source'),
  };
}

// Pure matcher. orders: [{ reference, idempotency_key, created_at, customer_name, phone, total_minor, items, is_test }]
// tabs: [{ title, values }]. Returns one result per order, plus sheet rows matched to no order at all.
export function matchEvidence(orders, tabs, allOrders = orders) {
  const rows = [];
  for (const t of tabs) {
    const header = t.values[0] ?? [];
    const col = columnsOf(header);
    t.values.slice(1).forEach((r, i) => {
      const get = (k) => (col[k] >= 0 ? String(r[col[k]] ?? '') : '');
      if (!r.some((v) => String(v ?? '').trim())) return;
      rows.push({ tab: t.title, row: i + 2, phone: digits10(get('phone')), name: get('name'), time: get('time'), product: get('product'), quantity: get('quantity'), total: get('total'),
        ids: `${get('orderId')} ${get('skyflyId')} ${get('source')}` });
    });
  }
  const used = new Set();
  const results = orders.map((o) => {
    const at = new Date(o.created_at).getTime();
    const byId = rows.find((r) => (o.reference && r.ids.includes(o.reference)) || (o.idempotency_key && r.ids.includes(o.idempotency_key)));
    if (byId) { used.add(byId); return { order: o, verdict: 'IN_SHEET_BY_SKYFLY_ID', row: byId }; }
    const phone = digits10(o.phone);
    const samePhone = rows.filter((r) => phone && r.phone === phone && !used.has(r))
      .map((r) => ({ r, t: parseSheetTime(r.time, at) }))
      .map((x) => ({ ...x, diffMin: x.t === null ? null : Math.round((x.t - at) / 60000) }))
      .sort((x, y) => (x.diffMin === null) - (y.diffMin === null) || Math.abs(x.diffMin ?? 0) - Math.abs(y.diffMin ?? 0));
    const best = samePhone[0];
    if (best) {
      const nameMatch = firstName(best.r.name) && firstName(best.r.name) === firstName(o.customer_name);
      const close = best.diffMin !== null && Math.abs(best.diffMin) <= 180;
      used.add(best.r);
      return { order: o, verdict: close ? 'LIKELY_IN_SHEET_SAME_PHONE_AND_TIME' : 'SAME_PHONE_DIFFERENT_TIME', row: best.r, diffMin: best.diffMin, nameMatch, samePhoneRows: samePhone.length };
    }
    const byNameTime = rows.filter((r) => !used.has(r) && firstName(r.name) && firstName(r.name) === firstName(o.customer_name))
      .map((r) => ({ r, t: parseSheetTime(r.time, at) })).filter((x) => x.t !== null && Math.abs(x.t - at) <= 30 * 60000)[0];
    if (byNameTime) return { order: o, verdict: 'POSSIBLE_SAME_NAME_AND_TIME_DIFFERENT_PHONE', row: byNameTime.r, diffMin: Math.round((byNameTime.t - at) / 60000) };
    return { order: o, verdict: 'NOT_FOUND_IN_SHEET' };
  });
  // Rows that belong to no Skyfly order of this business at all (by ID or phone).
  const knownPhones = new Set(allOrders.map((o) => digits10(o.phone)).filter(Boolean));
  const knownIds = allOrders.flatMap((o) => [o.reference, o.idempotency_key]).filter(Boolean);
  const sheetOnly = rows.filter((r) => !used.has(r) && !(r.phone && knownPhones.has(r.phone)) && !knownIds.some((id) => r.ids.includes(id)));
  return { results, sheetOnly, rowCount: rows.length };
}

const naira = (minor, cur) => `${cur || 'NGN'} ${(Number(minor) / 100).toLocaleString('en-NG')}`;

// Loads the waiting orders of the connection's business and logs the evidence report (masked).
export async function logSheetEvidence(pool, conn, sheetId) {
  const q = `SELECT o.id, o.reference, o.idempotency_key, o.created_at, o.customer_name, o.phone, o.total_minor, o.currency, o.is_test, o.status, o.sheet_sync_status, o.source,
                    (SELECT string_agg(i.product_name || ' x' || i.quantity, ', ' ORDER BY i.id) FROM order_items i WHERE i.order_id = o.id) AS items
               FROM orders o WHERE o.business_id = $1`;
  const { rows: waiting } = await pool.query(`${q} AND o.sheet_sync_status IN ('pending', 'failed') ORDER BY o.created_at`, [conn.business_id]);
  const { rows: all } = await pool.query(q, [conn.business_id]);
  const tabs = await readAllTabs(sheetId);
  const title = await spreadsheetTitle(sheetId).catch(() => null);
  const real = waiting.filter((o) => !o.is_test);
  const { results, sheetOnly, rowCount } = matchEvidence(real, tabs, all);
  const P = `Sheet evidence (read-only) connection ${conn.id} "${title ?? '?'}":`;
  console.log(`${P} ${tabs.length} tabs (${tabs.map((t) => `${t.title}: ${Math.max(0, t.values.length - 1)} rows`).join('; ')}), ${rowCount} data rows; ${waiting.length} waiting orders = ${real.length} real + ${waiting.length - real.length} test (test orders are never copied)`);
  for (const r of results) {
    const o = r.order;
    const where = r.row ? ` | sheet "${r.row.tab}" row ${r.row.row}, time "${r.row.time}"${r.diffMin != null ? ` (Δ ${r.diffMin} min)` : ''}, name ${maskName(r.row.name)}${r.nameMatch === undefined ? '' : r.nameMatch ? ' (same first name)' : ' (different first name)'}, product "${String(r.row.product).slice(0, 60)}", qty "${r.row.quantity}", total "${r.row.total}"${r.samePhoneRows > 1 ? `, ${r.samePhoneRows} rows with this phone` : ''}` : '';
    console.log(`${P} ${o.reference} | ${new Date(o.created_at).toISOString()} | ${naira(o.total_minor, o.currency)} | ${o.items ?? '-'} | ${o.source} | status ${o.status} | copy ${o.sheet_sync_status} | customer ${maskName(o.customer_name)} ${maskPhone(o.phone)} | ${r.verdict}${where}`);
  }
  const count = (v) => results.filter((r) => r.verdict === v).length;
  console.log(`${P} SUMMARY real waiting ${real.length}: by Skyfly ID ${count('IN_SHEET_BY_SKYFLY_ID')}, likely in sheet (same phone, within 3 h) ${count('LIKELY_IN_SHEET_SAME_PHONE_AND_TIME')}, same phone other time ${count('SAME_PHONE_DIFFERENT_TIME')}, possible (same name and time) ${count('POSSIBLE_SAME_NAME_AND_TIME_DIFFERENT_PHONE')}, not found ${count('NOT_FOUND_IN_SHEET')}; sheet rows matching no Skyfly order ${sheetOnly.length}`);
  for (const r of sheetOnly.slice(0, 60)) console.log(`${P} SHEET-ONLY "${r.tab}" row ${r.row} | time "${r.time}" | name ${maskName(r.name)} | phone ${maskPhone(r.phone)} | product "${String(r.product).slice(0, 60)}" | total "${r.total}"`);
  return { results, sheetOnly };
}
