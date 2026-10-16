# Import: Larose UK – Glow Packages (£)

**Package:** `larose-uk.zip` (upload this) · **Form key:** `larose-uk` · **Business:** Larose UK (GBP)

## What changed compared with the live page
- Embedded images are now separate files in `assets/images/` (identical images, same layout).
- **Ordering:** the form used to save to the Google Sheet and then show a "confirm on WhatsApp" box, even when the save failed.
  It now saves the order in Skyfly first and opens the Skyfly confirmation page; Skyfly then copies it to the Google Sheet (marked `Skyfly LU-…`).
  If Skyfly can't save the order, it goes to the Google Sheet (marked `NOT IN SKYFLY`) and the original success box is shown, so no order is lost.
  Missing or invalid details are shown on the form; double taps never create a second order.
- New fields in the page's own style: Quantity (1–5) and Notes (optional). UK mobiles typed as `07…` are sent as `+44…`.
- "Yes! I Want This — WhatsApp Me" now scrolls to the order form. The submit button reads "Place My Order →".
  "Chat With Us on WhatsApp", the floating bubble (its label now reads "Questions? Chat on WhatsApp!" instead of "Order on WhatsApp!") and the footer number stay as contact options.
- The Skyfly page script is added (for pixels set in Skyfly). The page's own Meta Pixel is kept and not loaded twice.

## Set up in Skyfly first (once)
1. Home page → **New business** → name `Larose UK`.
2. Open it → **Settings**: Currency **British pound (£)**, Order reference prefix `LU`, WhatsApp `09049206695` → Save.
   (Set the currency before the first order; it is locked afterwards.)
3. **Products** → add each package with exactly this code and price:

   | Code | Name | Price (£) |
   |---|---|---|
   | `uk-package-1` | Package 1 – The Starter Glow (1kg Soap + Free Glow Oil) | 75 |
   | `uk-package-2` | Package 2 – The Power Glow (2kg Soap + Free Glow Oil) | 120 |
   | `uk-package-3` | Package 3 – Total Transformation (2kg Soap + Oil + Body Milk + Facial Set) | 220 |
4. **Pages** → **Register an external page**: Name `Larose UK`, Form key `larose-uk`,
   External URL = the address where the UK page is live, tick the 3 products → Save.
5. **Settings → Google Sheet backup**: enter the SheetDB API URL (the same one the page uses, `https://sheetdb.io/api/v1/m111fq96ve953`) so Skyfly copies each UK order to the sheet. The sheet needs its header row first (see the Nigeria notes).
6. **Pixels** (optional): the page's Meta Pixel 1357015185691765 can be added here too; it will not load twice.

## Import
1. Larose UK → **Pages** → open **Larose UK** → upload `larose-uk.zip` as a new version.
2. The import report should show no missing files and "form connected to Skyfly".

## Going live (only after testing)
The live UK page (repository `Larose-Skincare-`) is **unchanged**. To switch it, replace its `index.html` and add the `assets/` folder from this package,
then place one test order and check it appears once in Skyfly (Orders) and once in the Google Sheet.
Hosting it in Skyfly instead needs `PAGES_BASE_URL` (see Larose Nigeria instructions).

## Requirements
- No secrets or API keys in the page.
- External services: Skyfly order API (`https://skyfly-gybf.onrender.com`), SheetDB (Google Sheet backup), Google Fonts, Meta Pixel.
