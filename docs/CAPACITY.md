# Skyfly capacity and business isolation

How Skyfly keeps one busy business from slowing down the others, what was measured, and when the
shared platform needs more resources. Live figures: **Platform admin → Capacity** (also as JSON at
`/admin/capacity.json`).

## Architecture: one shared platform, protected workspaces

1. **Admin dashboard**: Platform admin manages every business: subscriptions, members, page limit,
   subdomain, and Capacity.
2. **Shared infrastructure**: one Render web service (any number of instances) and one Postgres
   database for all businesses. A new business is a set of rows, never a new server.
3. **Business workspaces**: every row belongs to one business. The dashboard and API only reach a
   business through `workspaceAccess` (membership or platform admin), and every query is scoped by
   `business_id`. Tests check that another account gets 404.

   Isolation is enforced in the application, not by Postgres row-level security. All access goes
   through the application's scoped queries.

## How one business is kept from monopolising the platform

| Shared resource | Protection |
|---|---|
| Database connections | Public traffic runs in two lanes. Per business: at most 4 page, tracking, catalog or "Tag loaded" requests and 3 orders at once. All businesses together: 10 + 6, out of 20 connections, so the dashboard and workers keep theirs. Waiting requests sit in a short queue per business (at most 200 waiting for up to 5 s, or 100 waiting for up to 15 s for orders). Businesses take turns. When the queue is full or the wait runs out, the visitor gets "busy, try again" (503 with `Retry-After`) for that business only. |
| Checkout | Orders have their own lane, so browsing can never take checkout's place. An order is saved first; Sheets, emails and the server-side Purchase event happen afterwards and never delay the answer. |
| Database work per visitor | Page lookups, tracking IDs, catalog and rendered page HTML are cached for 30 s, and saved files are cached permanently because they never change. Any change saved in the dashboard clears the cache, so owners see their changes at once. Repeated "Tag loaded" reports skip the database. |
| Stuck queries | 15 s statement limit, 10 s wait for a connection, idle-in-transaction limit. |
| Order floods | Per IP (`ORDER_RATE_LIMIT`), and per business at most 1000 orders per 10 minutes (`ORDER_BUSINESS_LIMIT`). |
| Background queues | Sheet copies and automation emails take businesses in turn, in bounded batches with retries and back-off. Duplicate rows and emails are prevented by idempotency keys and unique steps. With several instances, each job runs on one instance at a time (advisory lock). |
| Landing pages | Each business may have 4 pages by default; the platform admin changes the limit per business. |

## Load test (isolated; never touches the live site, database or Google Sheet)

`node scripts/load-test.mjs`: a throwaway database with 41 businesses, each with a published
page and 2 products.
- **The high-traffic business** has 7 Meta pixels.
- **The 40 others** each get 0.1 visitors/s, 4/s in total.

Each visitor loads:
- the page, its CSS and an 80 KB image, and the Skyfly script;
- the page's tracking and catalog;
- the "Tag loaded" report.

2% of visitors place an order. The server runs in production mode on **one CPU core**, with
Postgres on its own core. Each step lasts 30 s.

The test was run on 2026-10-28. Times are typical / 95th percentile in ms, with the error rate in
brackets.

| High-traffic business (visitors/s) | Before: other businesses' page | Before: other businesses' order | After: other businesses' page | After: other businesses' order | After: high-traffic page / order | DB transactions per visitor (before → after) |
|---|---|---|---|---|---|---|
| 0 | 7/17 | 20/24 | 5/17 | 22/22 | – | 17.2 → 4.4 |
| 10 | 7/23 | 21/28 | 5/12 | 24/24 | 4/12 · 33/36 | 16.7 → 1.2 |
| 25 | 6/19 | 16/16 | 5/15 | 14/14 | 3/16 · 20/74 | 16.7 → 0.8 |
| 50 | 8/49 | 28/28 | 5/23 | 20/45 | 3/20 · 20/38 | 16.4 → 0.8 |
| 100 | 12/56 | 42/50 | 17/145 | 43/43 | 14/117 · 58/665 | 16.4 → 0.6 |
| **150** | **1587/1866** | **3168/3303** | **128/265** | **232/232** | 85/206 · 439/954 | 16.3 → 0.6 |
| 200 | – | – | 136/451 | 689/973 | 116/287 · 649/2525 | – → 0.5 |
| 300 | – | – | 273/980 (1.9%) | 1108/20011 (33%) | errors 2–8% | – → 0.5 |

What this shows:
- **Before**, at 150 visitors/s the 10 database connections were exhausted. Every business slowed
  down together: pages took 1.6–1.9 s and orders 3.2 s.
- **After**, the database work per visitor dropped from about 16 transactions to under 1. The
  high-traffic business's orders queue in its own lane: its p95 rose to 665 ms at 100/s, while the
  other businesses' orders stayed at 43 ms.
- The other businesses place only about 2% × 4/s × 30 s ≈ 2–3 orders per step, so their order
  times are a small sample.
- **Limit:** above about 150–200 visitors/s on one core, everything slows down. The limit there is
  CPU in the single Node process, which every business shares. The lanes protect the database, not
  the CPU, so the remedy is more CPU or more instances.
- At 300/s, the load generator on the same machine was probably also a limit; treat that row as
  indicative.
- Server CPU per visitor (full hosted-page visit) was about **6–8 ms**. A visitor to an external page
  such as Larose's GitHub page uses less, because only tracking, catalog, "Tag loaded" and the order
  reach Skyfly.

## Safe capacity on Render (estimates from the measured CPU per visitor)

Render web instances get a share of a CPU. At about 7 ms per visitor and a 60% CPU target:

| Web plan (price from Render's public price list; confirm before buying) | CPU | Sustained visitors/s | Visitors/day if spread over 12 busy hours |
|---|---|---|---|
| **Free (current)** | 0.1 | ~8 | ~350,000 in theory. In practice it sleeps after 15 min idle: the first visitor waits ~1 min, which is bad for ads. |
| Starter ($7/month) | 0.5 | ~40 | far above current need |
| Standard ($25/month) | 1 | ~80 | |
| Each extra instance | +same | adds the same again | sessions, caches and job locks already work with several instances |

Larose at 50,000 visitors a day averages 0.6/s. A strong ad hour of 10× is about 6–15/s. That is
inside the free plan's CPU but close to its limit, and the free plan's cold starts and lack of
backups are the real risks.

**Database (free, expires 2026-11-14):**
- 1 GB of storage.
- No backups or point-in-time recovery from Render. The daily GitHub backup workflow covers this
  meanwhile.
- Hosted page files are stored in Postgres, so 200–500 businesses × 4 pages will outgrow 1 GB. That
  needs a paid database, or moving page files to object storage (R2/S3; `src/hosting/storage.js` is
  the only module to change).

**What 200–500 businesses need** is mostly total traffic and storage, not the business count.

Two caveats on these figures:
- Up to ~40 visitors/s combined is expected to be fine on Starter. Larger combined traffic needs
  Standard or a second instance.
- None of these figures were measured on Render itself. Capacity on Render must be confirmed with
  the Capacity page once real traffic runs.

## When to add resources (also shown as advice on the Capacity page)

- **CPU above 70%, or event-loop delay above 250 ms:** upgrade the web plan, or add an instance.
- **Requests waiting for a database connection, or connections above 80% of the database maximum:**
  upgrade the database plan, then raise `DB_POOL_MAX`.
- **Real visitors often get "Busy" answers:** the business has outgrown its share. Raise the
  `FAIR_*` settings together with the resources.
- **Google Sheet or email backlog older than an hour:** check that business's connection.

## Settings (environment variables, all optional)

`DB_POOL_MAX` (20), `DB_STATEMENT_TIMEOUT_MS` (15000), `PUBLIC_CACHE_MS` (30000 in production),
`ORDER_BUSINESS_LIMIT` (1000 per 10 min), `FAIR_READ_PER_BUSINESS` (4), `FAIR_READ_TOTAL` (10),
`FAIR_READ_QUEUE` (200), `FAIR_READ_WAIT_MS` (5000), `FAIR_ORDER_PER_BUSINESS` (3),
`FAIR_ORDER_TOTAL` (6), `FAIR_ORDER_QUEUE` (100), `FAIR_ORDER_WAIT_MS` (15000).
