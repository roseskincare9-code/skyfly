# Skyfly capacity assessment and infrastructure upgrade plan

Prepared 3 Nov 2026 from measurements, not guesses. **Prices are Render's list prices as last known: confirm
on https://render.com/pricing before buying.** No upgrade is done without the owner's approval.

## Measured (Render metrics, last 7 days, read-only "Database status" run)
| Metric | Value |
|---|---|
| Web service | Free instance, 1 instance, Frankfurt; **sleeps after 15 idle minutes** (awake 72 of 168 hours) |
| Web CPU | max 0.004 cores, average 0.002 |
| Web memory | max 185 MB, average 91 MB |
| First request after sleep | about 0.4 s when awake; a cold start after sleeping can take up to about a minute |
| Database | Free, PostgreSQL 16, **18 MB used**, expires **14 Nov 2026 13:40 UTC** |
| DB connections | max 4, average 1 (pool limit set by `DB_POOL_MAX`) |
| DB CPU / memory | max 0.009 cores / 54 MB |
| Errors | no 5xx in the latest 100 requests (Verify deployment) |

Built-in protection already in place: per-business request bulkheads and queues, per-business order limits,
database statement timeouts, cached public pages, background workers that run one at a time.

## Capacity for 200–500 registered businesses
- **Registered ≠ active.** 500 registered businesses typically means tens of owners signed in at once and
  order bursts when a business runs ads. Load comes from public landing-page views and order submissions,
  not from the number of accounts.
- **Storage:** 18 MB today with 9 businesses (most of it page files and the audit log). Even at 2 MB per
  business, 500 businesses is about 1 GB: fits a small paid database; watch page-file growth.
- **Web:** current use is far below one small instance. The real problems on the free plan are
  **sleeping** (slow first visit, background jobs stop while asleep) and no SLA, not CPU.
- **Database:** a 256 MB-RAM instance is enough for the first hundreds of businesses at current query patterns;
  move up when CPU or connections stay high (the Capacity page and Render metrics show this).
- No system can promise zero downtime; a single instance restarts on each deploy (seconds).

## Recommended plan (owner approval needed for each payment)
| Item | Now | Recommended | Approx. price | When |
|---|---|---|---|---|
| Database `skyfly-db` | Free (expires 14 Nov) | **Basic-256mb**, in place (same database) | about $6/month + storage about $0.30/GB/month | **Before 14 Nov** |
| Web service `skyfly` | Free (sleeps) | **Starter** (always on) | about $7/month | Before public launch |
| Monitoring | Render metrics + GitHub checks | Add an uptime monitor on `/healthz` (e.g. a free tier) and error reporting | $0–$26/month | Before public launch |
| Email | not configured | Resend free tier (3,000 emails/month) to start | $0, then about $20/month | Now (needed for registration) |
| Bot check | not configured | Cloudflare Turnstile | $0 | Now (needed for registration) |

## Database upgrade: procedure, downtime, rollback, checks
1. **Before:** run "Database backup" on demand and check it is green; download the encrypted artifact and keep it offline; run "Backup restore test (isolated)".
2. **Upgrade (owner):** Render → `skyfly-db` → Settings → change the instance type to Basic-256mb. Render keeps the same database and connection string. **Expected downtime:** a short restart of the database (typically minutes); Skyfly shows errors for new requests during it and recovers on its own.
3. **After:** "Database status" (plan no longer free, no expiry), "Verify deployment" (health, background jobs), "Backup restore test (isolated)" on a new backup; row counts must match the pre-upgrade backup plus new orders.
4. **Rollback:** a plan change does not alter data. If the database were lost, follow Plan B in `docs/database-continuity.md` (restore the verified backup into a new database). Paid plans add Render's own backups/recovery options (check which apply to the chosen plan).
