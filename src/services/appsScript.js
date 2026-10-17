// The Google Apps Script a business pastes into its own spreadsheet to receive Skyfly orders
// directly from Google (free; no SheetDB and no SheetDB request quota). It answers only
// requests carrying the connection's secret key, writes the column row itself, never adds an
// order twice (checked under a lock), and stores text as text (phone numbers keep their "+").
import { randomBytes } from 'node:crypto';
import { SHEET_COLUMNS } from './sheetColumns.js';

export const APPS_SCRIPT_URL_RE = /^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]{20,}\/exec$/;
export const newScriptKey = () => randomBytes(24).toString('base64url');

export function appsScriptSource(key) {
  return `// Skyfly -> this Google Sheet. Paste into Extensions > Apps Script (replace everything), Save,
// then Deploy > New deployment > Web app: Execute as "Me", Who has access "Anyone".
// Copy the Web app URL into Skyfly. Keep this key private: it is what lets Skyfly add rows.
var KEY = '${key}';
var COLUMNS = ${JSON.stringify(SHEET_COLUMNS)};

function sheet_(tab) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = tab ? (ss.getSheetByName(tab) || ss.insertSheet(tab)) : ss.getSheets()[0];
  if (sh.getLastRow() === 0) sh.appendRow(COLUMNS);
  return sh;
}
function header_(sh) { return sh.getRange(1, 1, 1, Math.max(sh.getLastColumn(), 1)).getValues()[0].map(String); }
function out_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
function find_(sh, field, text, whole) {
  var h = header_(sh), col = h.indexOf(field);
  if (col < 0 || sh.getLastRow() < 2 || !text) return [];
  return sh.getRange(2, col + 1, sh.getLastRow() - 1, 1).createTextFinder(String(text)).matchEntireCell(Boolean(whole)).findAll().map(function (cell) {
    var values = sh.getRange(cell.getRow(), 1, 1, h.length).getValues()[0], row = {};
    h.forEach(function (k, i) { row[k] = values[i] instanceof Date ? values[i].toISOString() : values[i]; });
    return row;
  });
}
function doGet(e) {
  var p = e.parameter || {};
  if (!KEY || p.key !== KEY) return out_({ ok: false, error: 'Wrong key' });
  var sh = sheet_(p.tab);
  if (p.action === 'keys') return out_({ ok: true, columns: header_(sh) });
  if (p.action === 'search') return out_({ ok: true, rows: find_(sh, p.field || 'source', p.q) });
  return out_({ ok: false, error: 'Unknown action' });
}
function doPost(e) {
  var body;
  try { body = JSON.parse(e.postData.contents); } catch (err) { return out_({ ok: false, error: 'Bad request' }); }
  if (!KEY || body.key !== KEY || !body.row) return out_({ ok: false, error: 'Wrong key' });
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var sh = sheet_(body.tab);
    // One row per Skyfly order: the order ID (skyflyId column) or its reference already there = done.
    if ((body.id && find_(sh, 'skyflyId', body.id, true).length) || (body.ref && find_(sh, 'source', body.ref).length)) {
      return out_({ ok: true, created: 0, existing: true });
    }
    var h = header_(sh), values = [], formats = [];
    h.forEach(function (k) {
      var v = body.row[k];
      values.push(v === undefined || v === null ? '' : v);
      formats.push(typeof v === 'number' ? 'General' : '@');
    });
    var range = sh.getRange(sh.getLastRow() + 1, 1, 1, h.length);
    range.setNumberFormats([formats]);
    range.setValues([values]);
    return out_({ ok: true, created: 1 });
  } finally {
    lock.releaseLock();
  }
}
`;
}
