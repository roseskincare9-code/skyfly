# Import: Larose Nigeria – Glow Packages (₦)

**Package:** `larose-nigeria.zip` (upload this) · **Form key:** `larosenigeria` · **Business:** Larose Natural Skincare Nigeria

## What changed compared with the live page
- Embedded images are now separate files in `assets/images/` (identical images, same layout).
- "Order on WhatsApp Now" and "Yes! I Want This — WhatsApp Me" now scroll to the order form instead of opening WhatsApp.
  "Chat With Us on WhatsApp", the floating WhatsApp bubble (its label now reads "Questions? Chat on WhatsApp!" instead of "Order on WhatsApp!") and the footer number (09049206695) stay as contact options.
- Order form: unchanged from the live page. It already saves orders in Skyfly first and copies them to the Google Sheet.
  If Skyfly can't save an order, it still goes to the Google Sheet as before.

## Before importing (once, in Skyfly)
1. Log in at https://skyfly-gybf.onrender.com and click **Set up Larose** (creates the business, the 5 packages and the page with form key `larosenigeria`).

## Import
1. Business **Larose Natural Skincare Nigeria** → **Pages** → open **Larose Nigeria (GitHub Pages)**.
2. Upload `larose-nigeria.zip` as a new version of that page (keeps form key `larosenigeria`, so orders keep arriving under the same page).
   Do not import it as a separate new page: two pages cannot share the form key.
3. Check the import report: no missing files, "form connected to Skyfly", Meta Pixel 1357015185691765 found.

## Preview and publish (needs Skyfly page hosting)
Previewing and publishing hosted pages needs `PAGES_BASE_URL` (a domain or subdomain for pages, e.g. `pages.yourbrand.com`) set on the Skyfly service. Until then, keep the live page on GitHub Pages; the uploaded version is stored safely as a draft.

## Requirements
- No secrets or API keys in the page. Orders are accepted only from this page's registered address.
- External services: Skyfly order API (`https://skyfly-gybf.onrender.com`), SheetDB (Google Sheet backup), Google Fonts, Meta Pixel.
