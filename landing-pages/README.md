# Landing pages prepared for Skyfly

Every existing landing page found in your GitHub account, prepared as a separate
package for import into Skyfly. **No live page was changed.** The originals are
kept untouched in `sources/<page>/original.html` (with the repository and commit
they came from in `source.json`).

Rebuild everything with `npm run pages:prepare` (or `python3 landing-pages/prepare.py`).

| Package | Source | Type | Ordering in the prepared page | Ready to import |
|---|---|---|---|---|
| `larose-nigeria` | Larosenigeria / index.html (live) | Product orders (₦) | Skyfly first, Google Sheet backup (already live); WhatsApp order buttons now open the form | Yes, after **Set up Larose** |
| `larose-uk` | Larose-Skincare- / index.html | Product orders (£) | **Updated:** was Google Sheet + "confirm on WhatsApp"; now Skyfly first, Google Sheet backup | Yes, after creating the **Larose UK** business (see its IMPORT.md) |
| `scaleforge-nigeria` | Scaleforge-nigeria / index.html | Service enquiry | Unchanged (WhatsApp 07035912743, no products or form) | Yes, as a page; ordering needs your decision |
| `scaleforge-london` | Scaleforgelondon / index.html | Service enquiry | Unchanged (WhatsApp 07035912743, no products or form) | Yes, as a page; ordering needs your decision |
| `ai-skincare-academy` | AI-ACADEMY / index.html | Course booking | Unchanged ("Book Your Seat — ₦3,000" links nowhere today) | Yes, as a page; booking needs your decision |

Not packaged (older copies of the pages above, kept in their repositories):
`Larosenigeria/index.html2` (old version with the blocked number 07039361243, no form) and
`Larose-Skincare-/index-old.html` (old UK version, no form). The `VYORA` repository is empty.
`aivora` was not opened.

## What each package contains

```
packages/<page>/index.html            the page (design unchanged)
packages/<page>/assets/images/…       images that were embedded in the HTML, now separate files
packages/<page>/skyfly-manifest.json  name, files, integrations, products, editable fields
packages/<page>/IMPORT.md             step-by-step import and set-up
dist/<page>.zip                       the file you upload in Skyfly (index.html + assets)
```

## How the prepared pages were checked

- **Same look:** for every page, the original and the version with images moved out were
  screenshotted on mobile and desktop and are pixel-identical.
- **Import:** every ZIP goes through Skyfly's own importer: no missing files, no absolute paths,
  the manifest lists exactly the files in the ZIP, the Larose pages show "form connected".
- **Ordering (local Skyfly, Chromium on a phone screen):** UK page — empty form shows errors and
  sends nothing; a double tap saves one order (£240 for 2 × Package 2, +44 phone, campaign kept),
  one Google Sheet row marked `Skyfly LU-…`, then the Skyfly confirmation page; Skyfly down → the
  order still reaches the Sheet marked `NOT IN SKYFLY` and the original success box shows; Skyfly
  and Sheet both down → clear error, details kept. Nigeria page — an order saves once in Skyfly and
  once in the Sheet. No step opens WhatsApp.
- **Not yet tested against the live Skyfly service**: that needs the Larose business set up there.

## Editing pages inside Skyfly: what works today and what is missing

Works today: importing pages as versions, duplicating a page, products and prices, pixels
per business or per page, order form connection, order management.

Not built yet:
1. **A content editor.** Skyfly stores each upload as a version but cannot edit text, images,
   prices, colours, fonts, sections or form fields in the browser. Each `skyfly-manifest.json`
   already lists those editable parts (headings, buttons, packages, form fields, colours, fonts,
   sections, images), so an editor can be built on it. Until then, edits are made in the page's
   HTML and uploaded as a new version.
2. **Preview and publish of hosted pages** need `PAGES_BASE_URL` (a domain or subdomain for
   pages, e.g. `pages.yourbrand.com`) set on the Skyfly service. A domain costs money from a
   registrar; Render custom domains themselves are free.

Note on prices: the pages send the price they show. If a price is changed in Skyfly but not on
the page, Skyfly refuses the order as "price changed" and the order goes to the Google Sheet
backup instead. Change prices in both places together.
