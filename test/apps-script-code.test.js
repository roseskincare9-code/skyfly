// Runs the exact Apps Script that Skyfly gives businesses (services/appsScript.js) against a
// stand-in for Google's SpreadsheetApp, so its behaviour is tested, not only Skyfly's side.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { appsScriptSource } from '../src/services/appsScript.js';
import { SHEET_COLUMNS } from '../src/services/sheetColumns.js';

function fakeSheet(rows = []) {
  const data = rows.map((r) => [...r]);
  const formats = [];
  const width = () => Math.max(0, ...data.map((r) => r.length));
  const sheet = {
    data, formats,
    getLastRow: () => data.length,
    getLastColumn: () => width(),
    appendRow: (r) => { data.push([...r]); },
    getRange: (row, col, nr, nc) => ({
      getValues: () => Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => data[row - 1 + i]?.[col - 1 + j] ?? '')),
      setValues: (vals) => vals.forEach((r, i) => { data[row - 1 + i] ??= []; r.forEach((v, j) => { data[row - 1 + i][col - 1 + j] = v; }); }),
      setNumberFormats: (f) => { formats.push({ row, f }); },
      createTextFinder: (text) => {
        let whole = false;
        const finder = {
          matchEntireCell: (w) => { whole = w; return finder; },
          findAll: () => {
            const hits = [];
            for (let i = 0; i < nr; i += 1) {
              const v = String(data[row - 1 + i]?.[col - 1] ?? '');
              if (whole ? v === text : v.includes(text)) hits.push({ getRow: () => row + i });
            }
            return hits;
          },
        };
        return finder;
      },
    }),
  };
  return sheet;
}

// A spreadsheet of named tabs (the first tab is given; others are created by the script).
function book(first, firstName = 'Sheet1') {
  const tabs = [];
  if (first) { first.getName = () => firstName; tabs.push(first); }
  return {
    tabs,
    get: (name) => tabs.find((t) => t.getName() === name),
    api: {
      getSheets: () => tabs,
      getSheetByName: (n) => tabs.find((t) => t.getName() === n) ?? null,
      insertSheet: (n) => { const t = fakeSheet(); t.getName = () => n; tabs.push(t); return t; },
    },
  };
}

function load(key, wb) {
  const ctx = {
    SpreadsheetApp: { getActiveSpreadsheet: () => wb.api },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: (s) => ({ setMimeType: () => JSON.parse(s) }) },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
  };
  vm.createContext(ctx);
  vm.runInContext(appsScriptSource(key), ctx);
  return { get: (p) => ctx.doGet({ parameter: p }), post: (b) => ctx.doPost({ postData: { contents: JSON.stringify(b) } }) };
}

const KEY = 'k'.repeat(32);
const row = (ref, id, phone = '+2348031234567') => Object.fromEntries(SHEET_COLUMNS.map((c) => [c, { source: `Larose | Skyfly ${ref} | TEST ORDER`, skyflyId: id, orderId: ref, phone, total: 103000, quantity: 2 }[c] ?? `${c}-x`]));

describe('Skyfly Apps Script', () => {
  test('requests without the right key are refused and change nothing', () => {
    const wb = book(fakeSheet());
    const s = load(KEY, wb);
    assert.deepEqual(s.get({ key: 'wrong', action: 'tabs' }), { ok: false, error: 'Wrong key' });
    assert.deepEqual(s.post({ key: 'wrong', row: row('LR-1', 'id-1') }), { ok: false, error: 'Wrong key' });
    assert.deepEqual(s.post({ key: KEY }), { ok: false, error: 'Wrong key' }, 'no row');
    assert.equal(wb.tabs.length, 1, 'no tab created');
    assert.deepEqual(load('', book(fakeSheet())).get({ key: '', action: 'keys' }), { ok: false, error: 'Wrong key' }, 'an empty key never matches');
  });

  test('a spreadsheet with historical orders: every tab is reported read-only, and Skyfly writes only to its own new tab', () => {
    const history = [['Date', 'Customer', 'Phone', 'Package'], ['2026-09-01', 'Old Customer', '0803', 'Combo'], ['2026-09-02', 'Older Customer', '0805', 'Starter']];
    const wb = book(fakeSheet(history), 'Laroseorders');
    const s = load(KEY, wb);
    const tabs = s.get({ key: KEY, action: 'tabs' }).tabs;
    assert.deepEqual(tabs, [{ name: 'Laroseorders', rows: 3, columns: 4, firstRow: ['Date', 'Customer', 'Phone', 'Package'] }]);
    assert.equal(wb.tabs.length, 1, 'looking creates nothing');
    assert.deepEqual(s.get({ key: KEY, action: 'keys' }).columns, SHEET_COLUMNS, 'Skyfly Orders tab created with the column row');
    s.post({ key: KEY, id: 'id-1', ref: 'LR-AAA1111', row: row('LR-AAA1111', 'id-1') });
    assert.deepEqual(wb.get('Laroseorders').data, history, 'historical tab exactly as it was');
    assert.equal(wb.get('Skyfly Orders').data.length, 2);
  });

  test('one row per Skyfly order: an order ID or reference already in any tab is never added again', () => {
    const old = [SHEET_COLUMNS.slice(0, 12), SHEET_COLUMNS.slice(0, 12).map((c) => ({ source: 'Larose | Skyfly LR-OLD0001 | ID abc', skyflyId: 'id-old' }[c] ?? 'x'))];
    const wb = book(fakeSheet(old), 'Sheet1');
    const s = load(KEY, wb);
    assert.deepEqual(s.post({ key: KEY, id: 'id-old', ref: 'LR-OLD0001', row: row('LR-OLD0001', 'id-old') }), { ok: true, created: 0, existing: true }, 'written earlier to another tab');
    assert.deepEqual(s.post({ key: KEY, id: 'id-1', ref: 'LR-AAA1111', row: row('LR-AAA1111', 'id-1') }), { ok: true, created: 1 });
    assert.deepEqual(s.post({ key: KEY, id: 'id-1', ref: 'LR-AAA1111', row: row('LR-AAA1111', 'id-1') }), { ok: true, created: 0, existing: true });
    assert.equal(s.post({ key: KEY, id: 'id-1', ref: 'LR-ZZZ', row: row('LR-ZZZ', 'id-1') }).existing, true, 'same order ID');
    assert.equal(s.post({ key: KEY, id: 'id-2', ref: 'LR-BBB2222', row: row('LR-BBB2222', 'id-2') }).created, 1);
    assert.equal(wb.get('Skyfly Orders').data.length, 3, 'column row + 2 orders');
    assert.deepEqual(wb.get('Sheet1').data, old, 'other tab untouched');
    assert.equal(s.get({ key: KEY, action: 'search', field: 'source', q: 'LR-BBB2222' }).rows[0].orderId, 'LR-BBB2222');
  });

  test('text stays text (a phone number keeps its +); numbers stay numbers', () => {
    const wb = book(null);
    const s = load(KEY, wb);
    s.post({ key: KEY, id: 'id-9', ref: 'LR-CCC3333', row: row('LR-CCC3333', 'id-9') });
    const t = wb.get('Skyfly Orders');
    const f = t.formats.at(-1).f[0];
    assert.equal(f[SHEET_COLUMNS.indexOf('phone')], '@');
    assert.equal(f[SHEET_COLUMNS.indexOf('total')], 'General');
    assert.equal(t.data[1][SHEET_COLUMNS.indexOf('phone')], '+2348031234567');
  });

  test('if the owner names an existing Skyfly-format tab, its rows are kept and missing columns are added at the end', () => {
    const old = SHEET_COLUMNS.slice(0, 12);
    const wb = book(fakeSheet([old, old.map((c) => `old-${c}`)]), 'Orders');
    const s = load(KEY, wb);
    assert.deepEqual(s.get({ key: KEY, action: 'keys', tab: 'Orders' }).columns, [...old, 'orderId', 'status']);
    assert.deepEqual(wb.get('Orders').data[1], old.map((c) => `old-${c}`), 'existing record untouched');
    s.post({ key: KEY, tab: 'Orders', id: 'id-5', ref: 'LR-DDD4444', row: row('LR-DDD4444', 'id-5') });
    assert.equal(wb.get('Orders').data[2][12], 'LR-DDD4444');
    assert.equal(wb.tabs.length, 1, 'no extra tab');
  });
});
