# Skyfly

A lightweight platform for managing multiple businesses. Phase 1 is order
management: landing pages hosted anywhere (such as GitHub Pages) submit orders
to Skyfly, and the owner manages them in a private dashboard.

Skyfly is a standalone project. It has its own repository, dependencies,
database, secrets and Render service, and shares nothing with any other project.

**Owner setup and deployment:** see [docs/SETUP.md](docs/SETUP.md).
**Larose Nigeria landing page integration:** see [integrations/larosenigeria](integrations/larosenigeria/README.md).

## Features (Phase 1)

- Owner login (hashed passwords, Postgres sessions, CSRF protection, login rate limit)
- Business workspaces; every page and query is scoped to the signed-in owner
- Overview: order counts per status, orders today, sales totals with stated definitions, orders per landing page
- Orders: search (reference, name, phone, email), filter (status, landing page, dates), detail view,
  status updates with history and notes, click-to-call, WhatsApp, CSV export
- Public order API with CORS allow-list, server-side validation and pricing,
  idempotency keys, rate limit and a honeypot field
- Customer confirmation page with order reference, items, total, next steps and a prefilled WhatsApp button
- Products: prices in integer minor units; line items snapshot the price paid
- Landing page library: register, edit, connect products, preview, open, duplicate, import/export settings

### Sales definitions

| Figure | Statuses counted |
|---|---|
| Confirmed sales | Confirmed, Processing, Dispatched, Delivered |
| Delivered sales | Delivered |
| Awaiting confirmation (not sales) | New, Pending confirmation |
| Cancelled / returned | Cancelled, Returned |

## Public order API

`POST /api/public/orders` (JSON, from an origin listed in `ALLOWED_ORIGINS`)

```json
{
  "landingPage": "larosenigeria",
  "idempotencyKey": "uuid-from-the-browser",
  "customer": { "name": "", "phone": "", "email": "", "address": "", "state": "", "notes": "" },
  "items": [{ "product": "package-3", "quantity": 1, "unitPrice": 51500 }],
  "attribution": { "pageUrl": "", "referrer": "", "utm_source": "", "utm_medium": "", "utm_campaign": "" }
}
```

- `201` new order / `200` same key and same details (replay): `{ ok, reference, total, currency, confirmationUrl }`
- `400 VALIDATION` with `fields`, `400 UNKNOWN_PRODUCT`, `400 UNKNOWN_LANDING_PAGE`
- `409 PRICE_CHANGED` when `unitPrice` doesn't match Skyfly's price; `409 IDEMPOTENCY_CONFLICT`
- `429 RATE_LIMITED`, `500 SERVER_ERROR` (safe to retry with the same key)

Prices always come from Skyfly's database. `unitPrice` is only checked against them.

## Stack

Node.js 22, Express, server-rendered EJS, PostgreSQL (`pg`, plain SQL
migrations), `express-session` with `connect-pg-simple`, Helmet. Tests use
`node:test`, `supertest` and Playwright (Chromium).

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
LANDING_SOURCE=/path/to/Larosenigeria/index.html npm run test:e2e   # browser, mobile
```

## Layout

```
src/
  server.js, app.js, config.js, db.js, migrate.js
  services/orders.js     order validation, pricing, idempotent save
  routes/                public (API + confirmation), auth, workspace, orders, products, landingPages, settings
  lib/                   money, phone, references, CSRF, CSV, statuses
  scripts/seed-larose.js
  views/                 EJS templates
migrations/              SQL, applied in order
integrations/larosenigeria/   landing page patch + instructions
docs/SETUP.md            owner steps
test/                    integration + e2e tests
```
