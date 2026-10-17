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

function load(key, sheet) {
  const ctx = {
    SpreadsheetApp: { getActiveSpreadsheet: () => ({ getSheets: () => [sheet], getSheetByName: () => sheet, insertSheet: () => sheet }) },
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
  test('a blank sheet gets Skyfly\'s column row; requests without the right key are refused', () => {
    const sheet = fakeSheet();
    const s = load(KEY, sheet);
    assert.deepEqual(s.get({ key: 'wrong', action: 'keys' }), { ok: false, error: 'Wrong key' });
    assert.deepEqual(s.post({ key: 'wrong', row: row('LR-1', 'id-1') }), { ok: false, error: 'Wrong key' });
    assert.equal(sheet.data.length, 0, 'nothing written without the key');
    assert.deepEqual(s.get({ key: KEY, action: 'keys' }).columns, SHEET_COLUMNS);
    assert.deepEqual(s.post({ key: KEY }), { ok: false, error: 'Wrong key' }, 'no row, nothing written');
    assert.deepEqual(load('', fakeSheet()).get({ key: '', action: 'keys' }), { ok: false, error: 'Wrong key' }, 'an empty key never matches');
  });

  test('one row per Skyfly order: the same order ID or reference is never added twice', () => {
    const sheet = fakeSheet();
    const s = load(KEY, sheet);
    assert.deepEqual(s.post({ key: KEY, id: 'id-1', ref: 'LR-AAA1111', row: row('LR-AAA1111', 'id-1') }), { ok: true, created: 1 });
    assert.deepEqual(s.post({ key: KEY, id: 'id-1', ref: 'LR-AAA1111', row: row('LR-AAA1111', 'id-1') }), { ok: true, created: 0, existing: true });
    assert.deepEqual(s.post({ key: KEY, id: 'id-1', ref: 'LR-OTHER99', row: row('LR-OTHER99', 'id-1') }).existing, true, 'same order ID');
    assert.equal(s.post({ key: KEY, id: 'id-2', ref: 'LR-BBB2222', row: row('LR-BBB2222', 'id-2') }).created, 1, 'a different order is added');
    assert.equal(sheet.data.length, 3, 'column row + 2 orders');
    const found = s.get({ key: KEY, action: 'search', field: 'source', q: 'LR-BBB2222' }).rows;
    assert.equal(found.length, 1);
    assert.equal(found[0].orderId, 'LR-BBB2222');
  });

  test('text stays text (a phone number keeps its +); numbers stay numbers', () => {
    const sheet = fakeSheet();
    const s = load(KEY, sheet);
    s.post({ key: KEY, id: 'id-9', ref: 'LR-CCC3333', row: row('LR-CCC3333', 'id-9') });
    const f = sheet.formats.at(-1).f[0];
    assert.equal(f[SHEET_COLUMNS.indexOf('phone')], '@');
    assert.equal(f[SHEET_COLUMNS.indexOf('total')], 'General');
    assert.equal(sheet.data[1][SHEET_COLUMNS.indexOf('phone')], '+2348031234567');
  });

  test('a sheet that already has orders keeps them: missing Skyfly columns are added at the end of row 1', () => {
    const old = SHEET_COLUMNS.slice(0, 12);
    const sheet = fakeSheet([old, old.map((c) => `old-${c}`)]);
    const s = load(KEY, sheet);
    assert.deepEqual(s.get({ key: KEY, action: 'keys' }).columns, [...old, 'orderId', 'status']);
    assert.deepEqual(sheet.data[1], old.map((c) => `old-${c}`), 'existing record untouched');
    s.post({ key: KEY, id: 'id-5', ref: 'LR-DDD4444', row: row('LR-DDD4444', 'id-5') });
    assert.equal(sheet.data[2][12], 'LR-DDD4444', 'new rows fill the added columns');
    // A sheet with different own columns keeps them; Skyfly's are appended after.
    const custom = fakeSheet([['Name', 'Phone'], ['Ada', '080']]);
    assert.deepEqual(load(KEY, custom).get({ key: KEY, action: 'keys' }).columns, ['Name', 'Phone', ...SHEET_COLUMNS]);
    assert.deepEqual(custom.data[1], ['Ada', '080']);
  });
});
