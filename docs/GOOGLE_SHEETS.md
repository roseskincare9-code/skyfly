# Google Sheets: direct connection (Google Apps Script)

Free, and independent of SheetDB and its monthly request limit. Orders are always saved in Skyfly
first; each one is then copied to the sheet once (checked by its Skyfly order ID in the `skyflyId`
column, and by its reference). If Google is unavailable or over its quota, the order waits in Skyfly
and is copied later; nothing is lost.

## Steps (about 3 minutes)

1. In Skyfly: your business → **Google Sheets** → **Connect a spreadsheet directly**. Skyfly shows
   the script below **with a private key already filled in**. Copy it from there (the key in this
   file is a placeholder and will not work).
2. Open the Google Sheet → **Extensions → Apps Script**. Delete everything in `Code.gs`, paste the
   script, click **Save**.
3. **Deploy → New deployment** → gear icon → **Web app**:
   - Description: `Skyfly orders`
   - Execute as: **Me** (the script writes to your sheet with your access)
   - Who has access: **Anyone** (Skyfly's server calls it; requests without the key are refused)
   - Click **Deploy**, then **Authorize access** and allow it for your Google account.
4. Copy the **Web app URL** (`https://script.google.com/macros/s/…/exec`).
5. In Skyfly, paste it into **Web app URL**, optionally a tab name, tick **Make it the default
   spreadsheet**, and click **Connect**. Skyfly checks it at once ("All 12 of Skyfly's 12 columns match").
6. Place a test order (a name starting with `TEST ORDER`, or on a page in test mode) and look at the
   sheet: one row, with `TEST ORDER` in the source column.

If you change the script later, use **Deploy → Manage deployments → Edit → Version: New version** so
the URL stays the same. Never share the script or its URL: the key in it is what allows rows to be added.

## The script (as Skyfly generates it)

```javascript
// Skyfly -> this Google Sheet. Paste into Extensions > Apps Script (replace everything), Save,
// then Deploy > New deployment > Web app: Execute as "Me", Who has access "Anyone".
// Copy the Web app URL into Skyfly. Keep this key private: it is what lets Skyfly add rows.
var KEY = 'KEY-SHOWN-ON-YOUR-SKYFLY-GOOGLE-SHEETS-PAGE';
var COLUMNS = ["timestamp","fullName","address","phone","email","package","source","state","quantity","notes","skyflyId","total"];

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
```
