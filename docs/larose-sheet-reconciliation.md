# Larose orders and Google Sheet reconciliation

Status: **prepared; nothing has been written to any sheet.** Every step that changes something needs the
owner's approval.

## Facts (3 Nov 2026, from the read-only start-up report)

- **Skyfly:** 29 real Larose orders (16 Oct → 2 Nov) have never reached a Google Sheet. Every one is
  stored in Skyfly with its items, prices and customer details, and none is lost. This report covers all
  of them, including the 27 you asked about.
- **Larose's default sheet** (connection 1, SheetDB "Orders sheet") is **empty**: row 1 has no column
  names, so SheetDB refuses every row. Its quota is also exhausted (HTTP 429). It has never succeeded.
- **"Laroseorders"** (connection 2, Google API, spreadsheet ID starting `15fOup…`) is **empty**: one tab,
  "Sheet1", with 0 rows.
- **Matching:** each order was compared with every row of every tab by Skyfly reference, Skyfly ID,
  phone, time and name. None of the 29 is in either sheet, and no sheet row is missing from Skyfly.
- **Possible duplicates inside Skyfly** (same phone; to confirm with the customers, never deleted):
  - …9562: LR-6QT3XVA and LR-WXCSSFX, the same items 12 hours apart. Possible duplicate.
  - …3176: LR-JQPVMAS and LR-4ZC64BM, the same items 5½ days apart. Probably a repeat order.
  - …1243: LR-R6SY6JW and LR-4NTXAC7, different items. Separate orders.

Re-run the evidence at any time: Actions → "Sheet reconciliation report (read-only)" → match
"Sheet evidence".

## Export (owner, from the dashboard)

The orders contain customers' names, phones and addresses. The code repository is **public**, so no
export is ever written to it.

1. Sign in, open Larose → **Google Sheets** → **Export CSV**. This gives the orders in the sheet's own
   column order (timestamp, full name, address, phone, package, quantity, total, order ID, status). Test
   orders are excluded.
2. Or open Larose → **Orders** → **Export** for the full order list.
3. Keep the file private.

## Reconciliation process (after approval)

1. **Owner confirms the target spreadsheet.** Is `15fOup…` ("Laroseorders") the right file? If your real
   sheet with historical rows is a different file, share it with Skyfly's service account and add it as a
   connection. Run the evidence report again: it will then match against those rows too.
2. **Owner decides on the possible duplicates above:** keep both, or mark one as cancelled in Skyfly.
   Nothing is ever deleted.
3. **With approval:**
   - Make "Laroseorders" Larose's default sheet.
   - Release the held orders.
   - Skyfly **appends** each real order once, to its own tab "Skyfly orders". Before each row it checks
     every tab for the order's reference and Skyfly ID, so an order already in the sheet is skipped and
     never duplicated.
   - Existing rows are never edited or deleted, and test orders are never copied.
4. **Check:** the evidence report should show all 29 orders as "in sheet by Skyfly ID". The Orders page
   shows each order's copy status.

## What is never done

- Existing spreadsheet rows are not overwritten, reordered or deleted.
- Orders are not invented or reconstructed from anywhere but Skyfly's own saved records.
- Test orders are not sent to the Larose sheet.
- Nothing happens before the owner approves steps 1–3.
