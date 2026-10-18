// Google Sheets through Google's own Sheets API with a service account (no Apps Script, no
// SheetDB). The platform has one service account (GOOGLE_SERVICE_ACCOUNT_JSON on the server);
// a business shares its spreadsheet with that account's email as Editor, and Skyfly then:
//   - reports every tab read-only (name, rows),
//   - writes only to its own tab ("Skyfly Orders" unless another is named), created if missing,
//     adding its column row (or the Skyfly columns a header lacks) — other tabs are never changed,
//   - before adding an order, looks for it in every tab (skyflyId, orderId, or the reference in
//     "source"), so an order already in the spreadsheet is never added twice.
import { createSign } from 'node:crypto';
import { SHEET_COLUMNS } from './sheetColumns.js';

const SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
let access = null; // { serviceAccount: { client_email, private_key }, apiBase, tokenUrl }
let token = null;  // { value, expiresAt }

export function setGoogleAccess(google) { access = google?.serviceAccount ? google : null; token = null; }
export const googleAccountEmail = () => access?.serviceAccount.client_email ?? null;
export const SPREADSHEET_ID_RE = /\/spreadsheets\/d\/([A-Za-z0-9_-]{20,100})/;

// Reads GOOGLE_SERVICE_ACCOUNT_JSON (the key file's JSON, or the same base64-encoded).
export function parseServiceAccount(raw) {
  if (!raw) return null;
  let text = String(raw).trim();
  if (!text.startsWith('{')) { try { text = Buffer.from(text, 'base64').toString('utf8'); } catch { return null; } }
  try {
    const j = JSON.parse(text);
    if (!/^[^@\s]+@[^@\s]+\.iam\.gserviceaccount\.com$/.test(j.client_email || '') || !/BEGIN PRIVATE KEY/.test(j.private_key || '')) return null;
    return { client_email: j.client_email, private_key: j.private_key };
  } catch { return null; }
}

export class GoogleApiError extends Error {
  constructor(message, status = null) { super(message); this.status = status; }
}

const b64url = (v) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');

async function accessToken() {
  if (!access) throw new GoogleApiError('Google service account is not set up on the server (GOOGLE_SERVICE_ACCOUNT_JSON).');
  if (token && token.expiresAt > Date.now() + 60000) return token.value;
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${b64url({ alg: 'RS256', typ: 'JWT' })}.${b64url({ iss: access.serviceAccount.client_email, scope: SCOPE, aud: access.tokenUrl, iat: now, exp: now + 3600 })}`;
  const signature = createSign('RSA-SHA256').update(unsigned).sign(access.serviceAccount.private_key, 'base64url');
  let res;
  try {
    res = await fetch(access.tokenUrl, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, signal: AbortSignal.timeout(15000),
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${signature}` }),
    });
  } catch { throw new GoogleApiError('Google sign-in could not be reached (network error).'); }
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.access_token) throw new GoogleApiError(`Google refused the service account sign-in (HTTP ${res.status}${json.error ? `: ${json.error}` : ''}). Check GOOGLE_SERVICE_ACCOUNT_JSON.`, res.status);
  token = { value: json.access_token, expiresAt: Date.now() + (json.expires_in || 3600) * 1000 };
  return token.value;
}

async function api(spreadsheetId, path, { method = 'GET', body = null, query = {} } = {}) {
  const url = new URL(`${access?.apiBase ?? ''}/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}${path}`);
  for (const [k, v] of Object.entries(query)) [].concat(v).forEach((x) => url.searchParams.append(k, x));
  let res;
  try {
    res = await fetch(url, {
      method, signal: AbortSignal.timeout(30000),
      headers: { Authorization: `Bearer ${await accessToken()}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  } catch (err) {
    if (err instanceof GoogleApiError) throw err;
    throw new GoogleApiError('Google Sheets could not be reached (network error or no answer in 30 seconds).');
  }
  const json = await res.json().catch(() => null);
  if (res.ok) return json ?? {};
  const msg = String(json?.error?.message || '').slice(0, 160);
  if (res.status === 403 || res.status === 404) {
    throw new GoogleApiError(`Skyfly cannot open this spreadsheet. In Google Sheets, click Share and add ${googleAccountEmail()} as Editor${msg ? ` (Google: ${msg})` : ''}.`, 403);
  }
  if (res.status === 429) throw new GoogleApiError(`Google Sheets is busy (request quota reached${msg ? `: ${msg}` : ''}). Skyfly tries again later.`, 429);
  throw new GoogleApiError(`Google Sheets answered HTTP ${res.status}${msg ? `: ${msg}` : ''}`, res.status);
}

const quoteTab = (name) => `'${String(name).replace(/'/g, "''")}'`;
const colName = (n) => { let s = ''; for (let i = n; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s; return s; };

// Every tab with all its values (read-only).
async function readAll(id) {
  const meta = await api(id, '', { query: { fields: 'sheets.properties.title' } });
  const titles = (meta.sheets || []).map((s) => s.properties.title);
  if (!titles.length) return [];
  const data = await api(id, '/values:batchGet', { query: { ranges: titles.map(quoteTab), majorDimension: 'ROWS' } });
  return titles.map((title, i) => ({ title, values: data.valueRanges?.[i]?.values ?? [] }));
}

// Read-only summary of every tab, for the owner.
export async function listTabs(id) {
  return (await readAll(id)).map((t) => ({ name: t.title, rows: t.values.length }));
}

// Skyfly's tab: created if missing; its first row gets Skyfly's columns (an existing header keeps
// its columns and gets any missing Skyfly columns added at the end). Returns the header.
export async function ensureTab(id, tab) {
  const tabs = await readAll(id);
  let target = tabs.find((t) => t.title === tab);
  if (!target) {
    await api(id, ':batchUpdate', { method: 'POST', body: { requests: [{ addSheet: { properties: { title: tab } } }] } });
    target = { title: tab, values: [] };
  }
  const header = (target.values[0] ?? []).map(String);
  if (!header.some(Boolean)) {
    await api(id, `/values/${encodeURIComponent(`${quoteTab(tab)}!A1`)}`, { method: 'PUT', query: { valueInputOption: 'RAW' }, body: { values: [SHEET_COLUMNS] } });
    return [...SHEET_COLUMNS];
  }
  const missing = SHEET_COLUMNS.filter((c) => !header.includes(c));
  if (missing.length) {
    await api(id, `/values/${encodeURIComponent(`${quoteTab(tab)}!${colName(header.length + 1)}1`)}`, { method: 'PUT', query: { valueInputOption: 'RAW' }, body: { values: [missing] } });
  }
  return [...header, ...missing];
}

// Rows anywhere in the spreadsheet that belong to this order.
export async function findOrderRows(id, { ref, skyflyId = null }) {
  const found = [];
  for (const t of await readAll(id)) {
    const header = (t.values[0] ?? []).map(String);
    const col = (c) => header.indexOf(c);
    for (const row of t.values.slice(1)) {
      const cell = (c) => (col(c) >= 0 ? String(row[col(c)] ?? '') : '');
      if ((skyflyId && cell('skyflyId') === skyflyId) || (ref && (cell('orderId') === ref || cell('source').includes(ref)))) {
        found.push({ tab: t.title, source: cell('source') });
      }
    }
  }
  return found;
}

// Values are written RAW: nothing is ever run as a formula, and text such as +234… phone numbers
// stays text. (The apostrophe Skyfly adds for other writers is not needed here.)
const raw = (v) => (typeof v === 'string' && /^'[=+\-@]/.test(v) ? v.slice(1) : v);

// Adds the order unless it is already in any tab. Returns 'created' or 'existing'.
export async function appendOrder(id, tab, row, { ref, skyflyId }) {
  if ((await findOrderRows(id, { ref, skyflyId })).length) return 'existing';
  const header = await ensureTab(id, tab);
  const values = header.map((c) => (row[c] === undefined || row[c] === null ? '' : raw(row[c])));
  await api(id, `/values/${encodeURIComponent(`${quoteTab(tab)}!A1`)}:append`, {
    method: 'POST', query: { valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS' }, body: { values: [values] },
  });
  return 'created';
}
