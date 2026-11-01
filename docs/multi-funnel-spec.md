# Skyfly Multi-Funnel Landing Page Management — Technical Specification

Status: **specification only — not implemented.** Version 1.0, 1 November 2026.
Owner decisions still needed are listed in §16.

## 1. Purpose and principles

Each business keeps its own library of sales funnels. It can import or upload what it already uses,
reuse it, and create new funnels from templates or AI drafts. Every funnel can be published or
unpublished on its own.

The system follows these principles:

1. **No fixed funnel types.**
   - "Single product", "bundle" or "lead + upsell" are only examples.
   - A funnel is any ordered set of steps (pages) the business chooses.
   - Each step has a free-text label and an optional role (§3).
2. **Reuse, don't rebuild.**
   - Existing pages, files and designs are imported and preserved wherever technically possible.
   - What cannot be reproduced is reported element by element, with a safe editable alternative.
3. **Nothing is overwritten.**
   - Content changes create new versions, and publishing creates an immutable *release*.
   - Historical pages, versions, releases and orders are never modified or deleted by these features.
4. **Every funnel is checked before it takes orders.**
   - This applies to imported, duplicated, templated, AI-drafted and reactivated funnels alike.
   - A check that would let customers order wrongly blocks publishing.
5. **Strict tenant isolation**, the same as the rest of Skyfly:
   - server-side membership checks on every route;
   - same-business database triggers;
   - route-sweep tests.
6. **Entitlement-controlled.**
   - The number of funnels, steps and storage, and access to AI generation, come from the business's
     subscription and platform limits.
   - All of these are enforced on the server.

## 2. What exists today (the foundation)

| Capability | Today | Where |
|---|---|---|
| Landing pages per business | `landing_pages` with status `draft / active / paused / archived` | `migrations/002`, `src/lib/statuses.js` |
| Uploaded page files | Immutable `page_versions` + `page_files` stored in Postgres | `migrations/005`, `src/hosting/storage.js` |
| Import | ZIP/HTML upload, import from URL, Skyfly JSON export/import | `src/hosting/importer.js`, `urlImport.js`, `landingPages.js` |
| Duplicate / template | Duplicate a page; create from a product template | `POST /landing-pages/:id/duplicate`, `/template` |
| Auto-connect | The adapter finds forms and Order buttons and connects them to Skyfly checkout | `src/hosting/adapter.js`, `connect.js` |
| Pre-publish checks | PASS / WARNING / BLOCKED report; BLOCKED refuses publishing | `src/hosting/validate.js` |
| Publish / unpublish / live check | Per page | `landingPages.js` |
| Public serving | `/p/<slug>/`, business subdomains, custom domains | `src/hosting/server.js`, `domains.js`, `subdomains.js` |
| Editor | Text and image editing, sandboxed preview | `src/hosting/editor.js`, `pageEditor.js` |
| Tracking | Per-business pixels, all pages or chosen pages, Purchase only after a saved order | `tracking_pixels`, `src/services/pixels.js` |
| Orders | Server-priced, idempotent, linked to `landing_page_id` | `src/services/orders.js` |
| Limits | `businesses.max_landing_pages` (default 4, set by the Super Admin) | migration 040 |

The multi-funnel system **builds on these pieces and does not replace them**. A landing page stays the
unit that holds versions and files, and a funnel groups pages into steps.

## 3. Concepts

- **Funnel:** a named, business-owned set of one or more ordered **steps**, with shared settings:
  - products, WhatsApp handoff, tracking, domain and category.
  - A one-page funnel is still a funnel.
- **Step:** one landing page in a funnel.
  - It has a business-chosen label (free text, e.g. "Main offer", "Thank you").
  - It has an optional **role** from a short technical list. The role affects behaviour, not design:
    - `entry` — the public start of the funnel;
    - `checkout` — has the order form;
    - `after_order` — reached only with a saved order, e.g. an upsell or thank-you;
    - `info` — no order form.
  - Businesses may add any number of steps in any order, within limits.
- **Library:** all funnels of a business, including drafts, paused, archived and imported ones, searchable
  and filterable.
- **Category and tags:** business-defined labels for organising the library, such as "Skincare",
  "Ramadan 2026" or "Test". There is no global list.
- **Version:** an immutable snapshot of a step's page files (existing `page_versions`).
- **Release:** an immutable record of one publication of a funnel. It records:
  - the version of each step;
  - the product, price and option snapshot;
  - the WhatsApp number;
  - the tracking IDs in force;
  - the check report, the publisher and the time.
- **Health check:** the server-side check suite (§7). It runs before every publish and on demand, and
  produces a stored report.
- **Origin:** how a funnel came to exist:
  - `upload`, `url_import`, `json_import`, `template`, `ai_draft`, `duplicate`, `reactivated`,
    `migrated` (existing pages, §13).

## 4. Data model (additive migrations only)

All new tables carry `business_id`. Every link between rows is guarded by the existing
`skyfly_same_business()` trigger pattern (migration 038), so a funnel can never reference another
business's page, product, pixel, sheet or release.

```sql
CREATE TABLE funnel_categories (
  id BIGSERIAL PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  UNIQUE (business_id, lower(name))
);

CREATE TABLE funnels (
  id BIGSERIAL PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  slug TEXT NOT NULL,                         -- public path segment, unique per business
  category_id BIGINT REFERENCES funnel_categories(id) ON DELETE SET NULL,
  tags TEXT[] NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'paused', 'archived')),
  origin TEXT NOT NULL,                       -- see §3
  origin_ref TEXT,                            -- e.g. source URL, file name, template key, source funnel id
  current_release_id BIGINT,                  -- the live release (NULL when not published)
  whatsapp_number TEXT,                       -- NULL = the business's number
  custom_domain TEXT,
  notes TEXT,
  created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at TIMESTAMPTZ,
  UNIQUE (business_id, slug)
);

CREATE TABLE funnel_steps (
  id BIGSERIAL PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  funnel_id BIGINT NOT NULL REFERENCES funnels(id) ON DELETE CASCADE,
  landing_page_id BIGINT NOT NULL REFERENCES landing_pages(id),   -- never cascades into pages
  position INT NOT NULL,
  label TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 60),
  role TEXT NOT NULL DEFAULT 'info' CHECK (role IN ('entry', 'checkout', 'after_order', 'info')),
  step_slug TEXT NOT NULL,
  UNIQUE (funnel_id, position), UNIQUE (funnel_id, step_slug)
);

CREATE TABLE funnel_releases (                -- immutable: no UPDATE except unpublished_at
  id BIGSERIAL PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  funnel_id BIGINT NOT NULL REFERENCES funnels(id) ON DELETE CASCADE,
  number INT NOT NULL,                        -- 1, 2, 3… per funnel
  steps JSONB NOT NULL,                       -- [{stepId, landingPageId, versionId, role, slug}]
  catalog JSONB NOT NULL,                     -- product codes, names, prices, options at publish time
  whatsapp_number TEXT,
  tracking JSONB NOT NULL,                    -- tracking pixel ids + platform ids in force
  check_report_id BIGINT NOT NULL,
  published_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  published_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  unpublished_at TIMESTAMPTZ,
  UNIQUE (funnel_id, number)
);

CREATE TABLE funnel_check_reports (
  id BIGSERIAL PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  funnel_id BIGINT NOT NULL REFERENCES funnels(id) ON DELETE CASCADE,
  trigger TEXT NOT NULL,                      -- publish | manual | import | reactivate | nightly
  outcome TEXT NOT NULL CHECK (outcome IN ('pass', 'warning', 'blocked')),
  results JSONB NOT NULL,                     -- [{check, status, message, step, element, fix}]
  created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE funnel_import_items (            -- what an import could not reproduce (§8)
  id BIGSERIAL PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  funnel_id BIGINT NOT NULL REFERENCES funnels(id) ON DELETE CASCADE,
  version_id BIGINT NOT NULL REFERENCES page_versions(id),
  kind TEXT NOT NULL,                         -- e.g. external_form, foreign_pixel, server_script
  location TEXT NOT NULL,                     -- file + CSS path/line
  detail TEXT NOT NULL,
  decision TEXT NOT NULL DEFAULT 'pending' CHECK (decision IN ('pending', 'replaced', 'removed', 'kept_disabled')),
  decided_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  decided_at TIMESTAMPTZ
);

-- Attribution (nullable, additive; old orders keep NULL):
ALTER TABLE orders ADD COLUMN funnel_id BIGINT REFERENCES funnels(id);
ALTER TABLE orders ADD COLUMN funnel_release_id BIGINT REFERENCES funnel_releases(id);
ALTER TABLE checkout_sessions ADD COLUMN funnel_id BIGINT REFERENCES funnels(id);
```

Additional database rules:

- **Triggers:**
  - `funnel_steps.landing_page_id`, `funnels.category_id`, `funnels.current_release_id`,
    `orders.funnel_id` and `orders.funnel_release_id` must all belong to the same business.
  - `funnel_releases` refuses updates other than setting `unpublished_at` once.
- **No hard deletes of published history:**
  - A funnel that has ever been published, or has orders, can only be archived.
  - Deleting is allowed only for never-published drafts without orders.
  - Deleting a funnel never deletes its landing pages. The pages return to the library as unattached
    pages and are archived together with the funnel.
- **Backups:** the new tables are added to `TABLE_ORDER` in `src/services/backup.js`. The existing test
  `every data table is in the backup` enforces this.

## 5. Entitlements and usage limits

Limits come from the subscription plan, with optional per-business overrides set by the Super Admin,
the same way `max_landing_pages` works today.

```sql
CREATE TABLE plan_entitlements (
  plan TEXT PRIMARY KEY,                      -- e.g. trial, starter, growth, internal
  max_published_funnels INT NOT NULL,         -- live at the same time
  max_library_funnels INT NOT NULL,           -- all non-archived funnels
  max_steps_per_funnel INT NOT NULL,
  max_storage_mb INT NOT NULL,                -- page files across the business
  ai_drafts_per_month INT NOT NULL,
  custom_domains INT NOT NULL
);
ALTER TABLE businesses ADD COLUMN plan TEXT REFERENCES plan_entitlements(plan);
ALTER TABLE businesses ADD COLUMN entitlement_overrides JSONB NOT NULL DEFAULT '{}';
```

Enforcement:

- **Server-side, inside the transaction that creates or publishes**, using
  `SELECT … FROM businesses … FOR UPDATE`, the same pattern as today's page limit. Two simultaneous
  requests can therefore never exceed a limit.
- **Archived funnels** never count towards the library limit. **Paused funnels** count towards the
  library limit but not the published limit.
- **Going over a limit** (for example after a downgrade) **never deletes or unpublishes anything
  automatically.**
  - New creation or publishing is refused, with a clear message.
  - The owner chooses what to archive or pause.
  - Existing live funnels keep taking orders.
- **Expired or locked subscriptions** keep today's behaviour: the dashboard shows the renewal screen.
  Whether a locked business's published funnels keep taking orders is an owner decision (§16).
- **Usage is shown** in the library ("3 of 5 live funnels, 120 of 500 MB").

## 6. Workflows

### 6.1 Import an existing funnel

Sources:

- a ZIP containing one or more HTML pages and assets;
- a single HTML file;
- a public URL, where the existing URL import crawls the given page and, optionally, its linked
  same-site steps;
- a Skyfly JSON export.

Steps:

1. **Upload.** The existing safe-import rules apply: no symlinks, no encrypted files, allow-listed
   types, size limits.
2. **Split and order.**
   - Each HTML file becomes a step, in the order detected from in-page links (entry first). The owner can
     reorder, relabel and set roles.
   - A ZIP with a single page becomes a one-step funnel.
3. **Analyse.** The adapter finds forms, Order buttons, prices, WhatsApp links, pixel snippets, external
   scripts and iframes. Unsupported elements become `funnel_import_items` (§8).
4. **Map products.** Prices and product names found in the page are matched to the business's catalog
   by code, name and price. The owner confirms or picks products. Prices in the page are never trusted:
   orders are always priced by the server.
5. **Health check** (§7), stored as an `import` report.
6. **Save as a draft** in the library. Nothing goes live until the owner publishes.

### 6.2 Upload files and assets

- Owners can upload a new version of any step: a ZIP, an HTML file, or extra assets. This creates a new
  immutable version, and earlier versions stay listed.
- Shared assets can be uploaded once per funnel and referenced by every step. They are stored the same
  way as `page_files`, keyed by content hash, so duplicates don't use extra storage.

### 6.3 Library

- A list of funnels with filters:
  - status;
  - category and tags;
  - origin;
  - "has orders";
  - check outcome.
- Search by name, slug, notes and step labels.
- Sort by updated, published, orders and revenue (revenue comes from Skyfly orders only).
- Each card shows:
  - live URL;
  - status;
  - latest check outcome;
  - steps;
  - orders over the last 30 days;
  - last published, and by whom.

### 6.4 Duplicate

- Creates a new draft funnel (`origin = duplicate`, `origin_ref` = the source id).
- New landing pages are created, pointing to copies of the source's current versions. Files are
  immutable, so copying shares content-hashed files.
- Settings are copied; releases, orders and statistics are not.
- A new unique slug is generated ("…-copy").
- A health check runs on the copy.

### 6.5 Rename, categorise, tag

- Name, category, tags and notes can be edited at any time.
- Changing the slug of a published funnel needs confirmation. The old path keeps redirecting (301) to
  the new one for at least 90 days, so live ads don't break.

### 6.6 Archive and unarchive

- Archiving unpublishes the funnel if needed (§6.9) and hides it from the default library view.
- Archiving frees library capacity.
- Pages, versions, releases and orders are kept.
- Unarchiving returns the funnel as a draft.

### 6.7 Reactivate a previously published funnel

- The owner picks the funnel itself or any of its past releases.
- Skyfly builds a **new draft** from that release's step versions (`origin = reactivated`).
- Current settings are used for products and prices, WhatsApp and tracking, because these may have
  changed since the release:
  - differences from the release snapshot are listed, for example "Glow Duo was ₦30,000, now ₦32,000"
    or "pixel 1234… no longer exists";
  - the owner confirms.
- A full health check must pass before publishing.
- The old release is never modified.

### 6.8 Create from a template or AI draft

- **Templates:** a business-neutral starting structure (sections, steps, roles) filled with the
  business's own products, prices, WhatsApp number and brand colours. Templates contain placeholders,
  never invented facts.
- **AI drafts** (needs an AI provider decision, §16):
  - Inputs are only what the business provides:
    - product facts, prices and offers;
    - delivery terms;
    - genuine testimonials (each with a source the owner confirms).
  - The generator **must not** invent:
    - reviews or ratings;
    - stock numbers;
    - countdown deadlines;
    - certifications;
    - medical or performance claims.
  - Optional sections such as testimonials, gifts, FAQs and specifications are omitted when there is no
    input, rather than invented.
  - Output is a normal draft (`origin = ai_draft`), marked "AI draft — review before publishing".
  - The first publish requires a confirmation that the owner has reviewed the content.
  - The prompt, model and inputs are stored with the draft for audit.
  - Monthly usage counts against `ai_drafts_per_month`.

### 6.9 Publish and unpublish (independently per funnel)

**Publish** happens in one transaction:

1. Lock the business row and check entitlements.
2. Run the health check. If the outcome is `blocked`, refuse and show the report.
3. Create a `funnel_releases` row with the snapshots.
4. Point `funnels.current_release_id` at it.
5. Set the steps' landing pages active, pointing to the release's versions.
6. Clear the public caches for the funnel's hosts.
7. Run the live URL check after commit (§7.7).

**Unpublish:**

- Sets `unpublished_at` on the current release and clears `current_release_id`.
- The steps' pages stop serving; their public URLs answer "This offer is not available right now",
  with the business's WhatsApp link when one is configured.
- Orders already saved are untouched.
- Abandoned-checkout resume links for the funnel then show the same message.

**Independence:** publishing or unpublishing one funnel never changes another funnel. A landing page can
belong to only one *published* funnel at a time, to avoid ambiguous attribution. Duplicates get their
own pages (§6.4).

**Pause:** like unpublish, but the release stays current, so it can be resumed without a new release.
Paused funnels don't count towards the published limit.

## 7. Mandatory health checks

Each check reports PASS, WARNING or BLOCKED for each step. The check suite extends today's
`validate.js`. Every check runs on the server against the exact versions to be published.

| # | Check | BLOCKED when | WARNING when |
|---|---|---|---|
| 7.1 | **Business ownership** | Any step, page, version, product, pixel, sheet connection, domain or category belongs to another business (also prevented by DB triggers; checked explicitly for a clear message) | — |
| 7.2 | **Products and prices** | A checkout step has no connected product; a product is inactive or deleted; a package or option in the form doesn't exist in the catalog; an `after_order` step offers a product not configured as an upsell | A price shown in the page text differs from the catalog price (orders always use the catalog price, but the customer would see a different number); a product has no description |
| 7.3 | **Checkout and order submission** | The entry step can't reach a checkout step; a checkout form isn't connected to Skyfly checkout (adapter), or posts to an external handler; a required field (name, phone, address or state, per business settings) is missing; the **dry-run order** fails | The confirmation step has no visible order reference area |
| 7.4 | **WhatsApp number** | WhatsApp handoff is on but neither the funnel nor the business has a valid E.164 number; the page contains hard-coded `wa.me` / `api.whatsapp.com` links to a **different** number | The number has never received a test message (unverifiable) |
| 7.5 | **Pixels and tracking** | The page hard-codes a pixel or tag ID that is not one of this business's tracking IDs (it would send this business's customer data to someone else); a Purchase event fires outside the saved-order path | A pixel is installed but never seen by a browser ("Saved" status); duplicate base codes for the same ID |
| 7.6 | **Mobile responsiveness** | No viewport meta tag together with a fixed width over 480 px; the order form is not reachable at 390 px width | Horizontal overflow at 390 px; tap targets under 40 px; images over 1 MB; slow-load warnings from the existing speed check |
| 7.7 | **Valid public URL** | Slug collides or uses a reserved word; the custom domain or subdomain is not verified; **after publish**, the live URL does not answer HTTP 200 with the expected release id | Old slug redirect is missing; the page has no `<title>` or social preview |

How each check works:

- **Dry-run order (7.3).** A new internal function runs the full order path (validation, pricing,
  idempotency, business and page checks) inside a transaction that is **always rolled back**:
  - no order, no Google Sheet row, no email, no pixel event;
  - it uses a synthetic customer marked as a test;
  - it runs on the server only, never through the public API.
- **Mobile (7.6).** Static checks (viewport, CSS widths, image sizes) always run. A rendered check
  (headless Chromium at 390×844 and 1366×768, screenshots stored with the report) runs in a background
  job when a worker is available. Render's free instance may not have the memory, so the rendered check
  could instead run in GitHub Actions (§16). Without it, the result is labelled "static checks only",
  never "passed".
- **Scheduled re-checks.** A nightly check of published funnels re-runs 7.1, 7.2, 7.4, 7.5 and 7.7, and
  tells the owner (dashboard, and email when a sender is configured) if something broke, such as a
  deactivated product or a removed pixel. It never unpublishes automatically.

## 8. Preserving imported designs; unsupported elements

- The original files are always kept as the first version, untouched. Every fix produces a new version,
  so the owner can compare and roll back.
- **Detected unsupported or unsafe elements**, each with a recommended safe alternative:

| Kind | Example | Safe alternative offered |
|---|---|---|
| `external_form` | Form posting to another site, Google Form, Formspree | Replace with Skyfly checkout bound to the same fields (adapter), keeping the design |
| `server_script` | PHP, ASP, `.cgi` files | Remove; equivalent function provided by Skyfly (orders, WhatsApp) |
| `foreign_checkout` | Third-party payment or checkout widget | Skyfly checkout block; payment providers are a separate decision |
| `foreign_pixel` | Pixel/tag ID not in the business's Tracking & Pixels | Remove from HTML; add the ID properly under Tracking (if it is theirs) |
| `whatsapp_mismatch` | `wa.me` link with another number | Rewrite to the funnel/business number |
| `iframe_embed` | Embedded external page or video | Keep known-safe video hosts; otherwise a static image + link |
| `fake_urgency` | Countdown timers that reset, random "only 3 left" widgets | Remove, or replace with a real end date / real stock from the catalog |
| `review_widget` | Third-party review widgets or hard-coded ratings without a source | Testimonials section fed only by owner-confirmed testimonials |
| `broken_asset` | Missing images, fonts, CSS | List the paths; upload the missing files or use a placeholder |

- **Nothing is removed silently.** Each item needs an owner decision (`replaced`, `removed` or
  `kept_disabled`).
- **Items that block publishing:** pending `external_form`, `foreign_pixel`, `whatsapp_mismatch` and
  `server_script` on a step that takes orders.
- The editor (`src/hosting/editor.js`) lets owners edit text, images and colours in any imported
  version. Sections that can't be edited safely are shown read-only, with "replace with an editable
  section".

## 9. Order and data integrity

- **Orders keep `landing_page_id` and gain `funnel_id` and `funnel_release_id`**, so every order shows
  exactly which published content and prices the customer saw.
- **Releases snapshot the catalog**, and the existing server-side pricing still decides the charged
  total. Changing a price never alters past orders or releases.
- **Purchase events** stay tied to a saved order. Event IDs (`purchase_<reference>`) deduplicate
  browser and server events across steps. Step views send `PageView`/`ViewContent` once per step load.
- **No feature in this spec updates or deletes rows in `orders`, `order_items`, `page_versions`,
  `page_files` or `funnel_releases`** (apart from the single `unpublished_at` stamp).
- **New audit-log actions:**
  - `funnel.created`, `funnel.imported`, `funnel.duplicated`, `funnel.reactivated`;
  - `funnel.renamed`, `funnel.archived`, `funnel.unarchived`;
  - `funnel.published` (with release number), `funnel.unpublished`, `funnel.paused`;
  - `funnel.check_run`, `funnel.import_item_decided`, `funnel.ai_draft_created`.

## 10. Public serving

- **URLs:**
  - `/p/<funnel-slug>/` for the entry step and `/p/<funnel-slug>/<step-slug>/` for other steps;
  - also on the business subdomain and on a verified per-funnel custom domain.
  - Existing single-page URLs keep working: migrated pages map to one-step funnels with the same slug.
- **`after_order` steps** open only with a valid order token (the same mechanism as `/o/:reference?t=…`).
  Without one they redirect to the entry step, so a thank-you or upsell page can't be faked or used to
  fire Purchase events.
- **Caching:** public responses are cached per host and path, keyed by `current_release_id`. Publish and
  unpublish clear the funnel's keys. The existing `load.clearCaches()` is extended.
- **Fairness:** the per-business bulkhead and order limits (migration 039) apply per business across all
  of its funnels.

## 11. Routes (all under `/businesses/:businessId`, behind the existing workspace middleware)

```
GET    /funnels                              library (filters, search, usage)
GET    /funnels/new                          create: import | upload | URL | template | AI draft | blank
POST   /funnels/import                       upload ZIP/HTML (multipart, CSRF in body)
POST   /funnels/import-url                   import from a public URL
POST   /funnels/import-json                  Skyfly JSON export
POST   /funnels/template                     create from a template
POST   /funnels/ai-draft                     create an AI draft (entitlement-limited)
GET    /funnels/:funnelId                    overview: steps, checks, releases, orders
POST   /funnels/:funnelId                    rename, slug, category, tags, notes, WhatsApp, domain
POST   /funnels/:funnelId/steps              add a step (existing page or new upload)
POST   /funnels/:funnelId/steps/:stepId      label, role, slug, position
POST   /funnels/:funnelId/steps/:stepId/remove
POST   /funnels/:funnelId/import-items/:itemId   decide replaced | removed | kept_disabled
POST   /funnels/:funnelId/check              run the health check now
GET    /funnels/:funnelId/checks/:reportId   a stored report (with screenshots when rendered)
POST   /funnels/:funnelId/publish
POST   /funnels/:funnelId/unpublish
POST   /funnels/:funnelId/pause | /resume
POST   /funnels/:funnelId/duplicate
POST   /funnels/:funnelId/archive | /unarchive
POST   /funnels/:funnelId/releases/:releaseId/reactivate
GET    /funnels/:funnelId/export.json
GET    /funnel-categories, POST /funnel-categories, POST /funnel-categories/:id
```

Rules that apply to every route:

- Permissions: viewing needs `catalog`; publishing and unpublishing need `catalog`; domains need
  `settings`. Staff (orders only) never see these routes.
- Every `:funnelId`, `:stepId`, `:releaseId`, `:itemId` and `:reportId` is loaded with
  `AND business_id = $business`.
- Because the route-sweep tests read the route files, every new route is automatically included in the
  isolation tests (`test/isolation-sweep.test.js`, `test/e2e/live-isolation.e2e.js`).

## 12. Screens

1. **Library:**
   - cards or a table with filters;
   - usage bar (live and library funnels, storage, AI drafts);
   - "New funnel" with the six ways to create one.
2. **Import wizard:** upload → steps (order, labels, roles) → products → unsupported elements → check
   report → save draft.
3. **Funnel overview:**
   - step strip with previews (mobile and desktop toggle);
   - check report with fix links;
   - release history (number, date, who, orders per release) with "Reactivate this release";
   - publish, unpause and unpublish buttons that show the URL.
4. **Step editor:** the existing editor and sandboxed preview, per version, with version history.
5. **Release diff:** what changed since the live release (content versions, prices, WhatsApp, pixels).

All screens must work on phones: the same layout rules as the current dashboard, with a mobile
screenshot test for each.

## 13. Migration from today's pages (additive, no data rewritten)

1. **Phase 0, schema:** create the new tables and nullable columns. No existing rows change.
2. **Phase 1, wrap existing pages:**
   - For each existing landing page, create a one-step funnel (`origin = migrated`) with the same slug,
     status mapped as follows:
     - `active` → `published`;
     - `paused` → `paused`;
     - `archived` → `archived`;
     - `draft` → `draft`.
   - For published pages, create release #1 from the current published version and catalog, marked as
     reconstructed.
   - Existing orders keep `funnel_id = NULL`. An optional, reviewed back-fill could link them through
     `landing_page_id`, but only with the owner's approval, because it changes historical rows.
3. **Phase 2:** the library UI and the routes in §11. The old Landing Pages screen links into the
   library.
4. **Phase 3:** multi-step funnels, `after_order` gating, release history and reactivation.
5. **Phase 4:** templates, AI drafts and the rendered mobile check.
6. **Larose and other live pages** are verified after Phase 1 with the existing live checks:
   - same URL, same HTML hash;
   - orders still saved, pixels unchanged.
   - If anything differs, Phase 1 for that page is rolled back by removing its funnel rows. No page data
     was changed, so this is safe.

## 14. Testing

- **Unit:**
  - each health check (PASS/WARNING/BLOCKED fixtures);
  - unsupported-element detection;
  - product mapping;
  - dry-run order (asserts zero rows written);
  - release immutability trigger;
  - entitlement races (two concurrent publishes at the limit, exactly one succeeds).
- **Isolation:**
  - the existing route sweep covers new routes automatically;
  - new trigger tests for every funnel link;
  - cross-business duplicate and reactivate attempts.
- **Browser (Playwright):**
  - import a multi-page ZIP → map products → decide import items → publish → order through each step;
  - check that WhatsApp opens only after the order is saved;
  - check that Purchase fires once;
  - unpublish → public URL shows the unavailable page;
  - reactivate an old release → price differences are shown and confirmed.
- **Live (GitHub Actions, test businesses only):** the same journey on getskyfly.com with
  `(test)`-labelled businesses and orders, never Larose's sheet. This follows the existing pattern in
  `test/e2e/live-*.e2e.js`.

## 15. Acceptance criteria

1. A business can import an existing multi-page funnel and publish it with its original design, with
   every unsupported element listed and decided.
2. The seven checks in §7 run on every publish, and a BLOCKED result prevents publishing.
3. Funnels can be duplicated, renamed, categorised, archived, unarchived, paused, reactivated from any
   past release, and published or unpublished independently.
4. No historical page version, release or order is modified by any operation (verified by a test that
   fingerprints these tables before and after the full journey).
5. Limits from the plan are enforced on the server and never cause automatic deletion or unpublishing.
6. Tenant isolation tests pass for every new route, and the live isolation audit passes.
7. Existing live pages, including Larose, are unchanged after migration, verified live.

## 16. Decisions needed from the platform owner

1. **Plans and numbers:** plan names and limits per plan (live funnels, library size, steps, storage,
   AI drafts, custom domains), and whether the trial includes AI drafts.
2. **Locked subscriptions:** should published funnels of an expired or locked business keep taking
   orders, or show "unavailable"?
3. **AI provider:** which provider and model for AI drafts, the monthly budget, and whether drafts can
   use the business's product images.
4. **Rendered mobile check:** run it in GitHub Actions (free, slower, minutes later) or on a paid
   Render worker (instant, monthly cost).
5. **Order back-fill:** whether to link existing orders to their migrated funnels (it changes historical
   rows; off by default).
6. **Old slug redirects:** how long to keep them (proposed 90 days minimum).
