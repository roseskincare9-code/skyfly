# Google Sheets: connect by sharing (Google Sheets API, no Apps Script)

Use this when the Apps Script editor will not open. Skyfly writes through Google's own Sheets API
with **its own Google service account**: you share the spreadsheet with that account's email, the
same way you share with a person. Free; no Apps Script, no SheetDB. Existing tabs and their history
are never changed: Skyfly writes only to its own tab ("Skyfly Orders", created automatically) and,
before adding an order, checks every tab so an order is never added twice. Orders are always saved
in Skyfly first; if Google is unavailable they wait and are copied later.

## One-time: create Skyfly's service account (platform owner, about 5 minutes, free)

1. Open https://console.cloud.google.com/projectcreate (any Google account you control) →
   Project name `skyfly` → **Create**. No billing account is needed.
2. Open https://console.cloud.google.com/apis/library/sheets.googleapis.com (project `skyfly`
   selected at the top) → **Enable**.
3. Open https://console.cloud.google.com/iam-admin/serviceaccounts → **Create service account** →
   name `skyfly-sheets` → **Create and continue** → skip the optional steps → **Done**. No roles are needed.
4. Click the new account → **Keys** → **Add key** → **Create new key** → **JSON** → **Create**.
   A `.json` file downloads. Treat it like a password; never send it in chat or email.
5. Render → workspace **skyfly** → service **skyfly** → **Environment** → **Add Environment Variable**:
   key `GOOGLE_SERVICE_ACCOUNT_JSON`, value = the whole content of the `.json` file (open it in a text
   editor, select all, copy, paste) → **Save, rebuild and deploy**.

### Easiest: upload the key file in Skyfly

Skyfly → **Platform admin → Google key** → choose the downloaded `.json` file → **Upload and check**.
Skyfly stores it encrypted (SKYFLY_ENCRYPTION_KEY), uses it at once (no redeploy), signs in to
Google and checks the Sheets API, and shows the service account email to share spreadsheets with.
An uploaded key is used instead of the `GOOGLE_SERVICE_ACCOUNT_JSON` setting.

## Per spreadsheet (business owner, 1 minute)

1. Skyfly → the business → **Google Sheets** → "Connect by sharing your sheet". It shows an email
   ending in `.iam.gserviceaccount.com`.
2. Open the spreadsheet (e.g. Laroseorders) → **Share** → add that email as **Editor** → untick
   "Notify people" → **Share**.
3. Copy the spreadsheet's link (or just its ID) from the address bar into Skyfly → **Connect**. Skyfly
   lists your tabs ("not changed") without writing anything; its own "Skyfly Orders" tab is added when
   the first order is copied. The link can be saved before
   the server's key works; it is checked again automatically at the next start-up.
4. Orders that were already waiting are **held**: click "Compare waiting orders with the spreadsheet"
   (read-only: every tab is searched by order ID) to see how many are already there and how many are
   missing, then "Send the waiting orders". Each is still looked up before it is added, so none is
   added twice. New orders are copied as usual.

The key must be the whole downloaded `.json` file (about 2,300 characters, starting with `{`). The
40-character "key ID" shown in Google Cloud's key list is not the key; Skyfly says so on the Google
Sheets page, on `/healthz`, and in the deploy check.

---

# Google Sheets: direct connection (Google Apps Script)

Free, and independent of SheetDB and its monthly request limit. **Existing data is safe:** Skyfly
writes only to its own tab, "Skyfly Orders" (created automatically), never changes or deletes other
tabs, and before adding a row checks every tab so an order already in the spreadsheet is not added
again. When you connect, Skyfly shows each tab and how many rows it has (read-only). Orders are always saved in Skyfly
first; each one is then copied to the sheet once (checked by its Skyfly order ID in the `skyflyId`
column, and by its reference). If Google is unavailable or over its quota, the order waits in Skyfly
and is copied later; nothing is lost.

## Steps (about 3 minutes)

1. In Skyfly: your business → **Google Sheets** → **Connect a spreadsheet directly**. Skyfly shows
   the script below **with a private key already filled in**. Copy it from there (the key in this
   file is a placeholder and will not work). The key stays the same if you reload the page, until
   you connect. A script in "No projects" on script.google.com is normal before this step: the
   script is created inside the spreadsheet in step 2.
2. Open the Google Sheet → **Extensions → Apps Script**. Delete everything in `Code.gs`, paste the
   script, click **Save**.
3. **Deploy → New deployment** → gear icon → **Web app**:
   - Description: `Skyfly orders`
   - Execute as: **Me** (be signed in as the account that owns the spreadsheet, e.g.
     laroseskincare3@gmail.com; the script writes with that account's access)
   - Who has access: **Anyone** (Skyfly's server calls it; requests without the key are refused)
   - Click **Deploy**, then **Authorize access**, choose the spreadsheet's account. Google shows
     "Google hasn't verified this app" (it is your own script): click **Advanced** →
     **Go to Skyfly orders (unsafe)** → **Allow**. It asks for access to spreadsheets only.
4. Copy the **Web app URL** (`https://script.google.com/macros/s/…/exec`).
5. In Skyfly, paste it into **Web app URL**, optionally a tab name, tick **Make it the default
   spreadsheet**, and click **Connect**. Skyfly checks it at once and lists your tabs (existing ones "not changed").
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
var COLUMNS = ["timestamp","fullName","address","phone","email","package","source","state","quantity","notes","skyflyId","total","orderId","status"];
// Skyfly writes only to this tab (created if missing). Other tabs and their history are never changed.
var DEFAULT_TAB = "Skyfly Orders";

function sheet_(tab) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var name = tab || DEFAULT_TAB;
  var sh = ss.getSheetByName(name) || ss.insertSheet(name);
  if (sh.getLastRow() === 0) { sh.appendRow(COLUMNS); return sh; }
  // An existing column row keeps its columns and data; any Skyfly column it lacks is added at the end.
  var h = header_(sh), missing = COLUMNS.filter(function (c) { return h.indexOf(c) < 0; });
  if (missing.length) sh.getRange(1, h.filter(String).length ? sh.getLastColumn() + 1 : 1, 1, missing.length).setValues([missing]);
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
// Read-only summary of every tab (name, size, first row), so the owner can see what is there.
function tabs_() {
  return SpreadsheetApp.getActiveSpreadsheet().getSheets().map(function (s) {
    var cols = s.getLastColumn();
    var first = cols ? s.getRange(1, 1, 1, Math.min(cols, 20)).getValues()[0].map(function (v) { return String(v).slice(0, 40); }) : [];
    return { name: s.getName(), rows: s.getLastRow(), columns: cols, firstRow: first };
  });
}
// Has this order already been written anywhere in the spreadsheet (any tab)?
function written_(id, ref) {
  return SpreadsheetApp.getActiveSpreadsheet().getSheets().some(function (s) {
    return (id && find_(s, 'skyflyId', id, true).length) || (ref && (find_(s, 'orderId', ref, true).length || find_(s, 'source', ref).length));
  });
}
function doGet(e) {
  var p = e.parameter || {};
  if (!KEY || p.key !== KEY) return out_({ ok: false, error: 'Wrong key' });
  if (p.action === 'tabs') return out_({ ok: true, tabs: tabs_() });
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
    // One row per Skyfly order: if its order ID or reference is already in any tab, nothing is added.
    if (written_(body.id, body.ref)) return out_({ ok: true, created: 0, existing: true });
    var sh = sheet_(body.tab);
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
