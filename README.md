# Skyfly

A lightweight platform for managing multiple businesses. Phase 1 is order
management: landing pages hosted anywhere (such as GitHub Pages) submit orders
to Skyfly, and the owner manages them in a private dashboard.

Skyfly is a standalone project. It has its own repository, dependencies,
database, secrets and Render service, and shares nothing with any other project.

**Owner setup and deployment:** see [docs/SETUP.md](docs/SETUP.md).
**Larose Nigeria landing page integration:** see [integrations/larosenigeria](integrations/larosenigeria/README.md).

## What it does

1. **Landing-page hosting:** import a ZIP or HTML page, preview, publish/unpublish,
   custom domains. Files are stored in Postgres, so they survive redeploys. Pages
   are served on their own host, never the dashboard's.
2. **Orders:** a dashboard with search, filters, CSV export and manual entry;
   order status (Pending, Confirmed/Approved, Processing, Dispatched, Delivered,
   Cancelled, Returned) separate from payment status (Unpaid, Pending, Paid,
   Failed, Refunded); a public order API; a confirmation page with a WhatsApp
   button; an audit log.
3. **Pixels:** Meta and TikTok pixel IDs per business or per page; browser
   PageView, ViewContent, InitiateCheckout and Lead; **Purchase only
   server-side, once, when an order is marked Paid**.

How to use it: [docs/GUIDE.md](docs/GUIDE.md). Setup and deployment: [docs/SETUP.md](docs/SETUP.md).

## Public order API

`POST /api/public/orders` (JSON)

Authentication, one of:
- **Browser:** the request's `Origin` must be the landing page's own website (its
  external URL, its Skyfly pages host or its custom domain, plus `ALLOWED_ORIGINS`).
- **Server-to-server:** `Authorization: Bearer sky_…` (API key from Settings → API keys).

```json
{
  "landingPage": "form-key",
  "idempotencyKey": "uuid-generated-once-per-submission",
  "customer": { "name": "", "phone": "", "email": "", "address": "", "state": "", "notes": "" },
  "items": [{ "product": "package-3", "quantity": 1, "unitPrice": 51500 }],
  "attribution": { "pageUrl": "", "referrer": "", "utm_source": "", "utm_campaign": "", "fbp": "", "fbc": "", "ttclid": "" }
}
```

- `201` new order / `200` replay of the same key and details: `{ ok, reference, total, currency, confirmationUrl }`
- `400 VALIDATION` (with `fields`), `UNKNOWN_PRODUCT`, `UNKNOWN_LANDING_PAGE`; `401` missing or invalid key;
  `403 ORIGIN_NOT_ALLOWED` / `FORBIDDEN`; `409 PRICE_CHANGED` / `IDEMPOTENCY_CONFLICT`; `429`; `500` (safe to retry with the same key)

Prices always come from Skyfly's database. `unitPrice` is only checked against them.
`GET /sdk/skyfly.js` is the browser helper that does all of this for you (see the guide).

## Stack

Node.js 22, Express, server-rendered EJS, PostgreSQL (`pg`, plain SQL
migrations), `express-session` with `connect-pg-simple`, Helmet, multer + yauzl
for uploads. Tests use `node:test`, `supertest` and Playwright (Chromium).

## Local development

```sh
npm install
cp .env.example .env          # then set SESSION_SECRET
createdb skyfly_dev
npm run migrate
npm run dev                   # http://localhost:3000
# after signing up at /signup:
npm run seed:larose -- you@example.com
```

## Tests

Tests wipe the database they use, so they refuse to run unless `DATABASE_URL`
names a `*_test` database.

```sh
createdb skyfly_test
echo 'DATABASE_URL=postgres://localhost:5432/skyfly_test' > .env.test
npm test                                         # API, dashboard, security
npm run test:e2e:hosting                         # browser: import, publish, pixels, order, Paid
LANDING_SOURCE=/path/to/Larosenigeria/index.html npm run test:e2e   # browser: Larose patch
```

## Layout

```
src/
  server.js, app.js, config.js, db.js, migrate.js
  services/orders.js     order validation, pricing, idempotent save, manual orders
  services/pixels.js     pixel settings, browser config, server-side Purchase
  hosting/               upload import + safety checks, storage, page server, report
  sdk/skyfly.js          browser helper: form connection + pixel events
  routes/                public (API + confirmation), auth, workspace, orders, products, landingPages, settings
  lib/                   money, phone, references, CSRF, CSV, statuses
  scripts/seed-larose.js
  views/                 EJS templates
migrations/              SQL, applied in order
integrations/larosenigeria/   landing page patch + instructions
docs/SETUP.md, GUIDE.md  owner setup and how-to
test/                    integration + e2e tests
```
