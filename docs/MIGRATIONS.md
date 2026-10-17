# Database migrations: safety and rollback

Migrations run automatically on every deploy (`npm run migrate && npm start`), each one
inside a transaction: if any statement fails, nothing from that file is applied and the
service does not start with a half-changed database.

## Releases 012–014 (client workspaces, email automations, subdomains)

All three are **additive**: they add tables and columns and fill new columns. No existing
row is deleted, and no existing column is dropped or renamed.

| File | What it adds | What it changes in existing rows |
|---|---|---|
| 012_tenancy_subscriptions | `business_members`, `business_invites`, `platform_settings`, subscription columns on `businesses`, `users.is_platform_admin` | the first account becomes platform owner; every business owner becomes an "owner" member; Larose is marked `internal` (never expires) |
| 013_email_automations | `email_settings`, `email_contacts`, `email_templates`, `email_automations`, `email_automation_steps`, `email_messages`, `orders.marketing_consent` | customers who already gave an email become contacts **without** marketing consent |
| 014_business_subdomains | `businesses.subdomain` (+ status columns) | none |

### Safety copy

Before changing anything, 012 copies the business-critical tables into the schema
`backup_before_012` (businesses, orders, order_items, order_status_history, products,
landing_pages, pixel_settings). It is in the same database: it protects against a bad
migration, not against losing the database. For that, see "Off-site backup" below.

### Rolling back the application

The old code (commit `7f813ba`) ignores the new tables and columns, so redeploying it on
Render ("Manual Deploy" → choose the commit) is safe and needs no database change.

### Rolling back the data (only if ever needed)

Do this only with a fresh off-site backup and the service stopped:

```sql
-- See what changed since the copy (should be only new rows).
SELECT count(*) FROM orders o WHERE NOT EXISTS (SELECT 1 FROM backup_before_012.orders b WHERE b.id = o.id);
-- Remove the new structures (the copy is kept).
DROP TABLE email_messages, email_automation_steps, email_automations, email_templates, email_contacts, email_settings,
           business_invites, business_members, platform_settings CASCADE;
ALTER TABLE businesses DROP COLUMN subdomain, DROP COLUMN subdomain_checked_at, DROP COLUMN subdomain_status,
  DROP COLUMN timezone, DROP COLUMN subscription_status, DROP COLUMN subscription_price_minor, DROP COLUMN subscription_currency,
  DROP COLUMN subscription_started_on, DROP COLUMN subscription_expires_on, DROP COLUMN subscription_notes, DROP COLUMN subscription_updated_at;
ALTER TABLE users DROP COLUMN is_platform_admin;
ALTER TABLE orders DROP COLUMN marketing_consent;
DELETE FROM schema_migrations WHERE name IN ('012_tenancy_subscriptions.sql', '013_email_automations.sql', '014_business_subdomains.sql');
```

Orders placed after the upgrade stay in `orders` either way.

### Backups (do this regularly)

Verified with the Render API on 2026-10-17: the database `skyfly-db` is on the **free plan**,
was created **2026-10-15 13:40 UTC** and **expires 2026-11-14 13:40 UTC**. Point-in-time
recovery is **not available** on this plan, and no exports exist. Outside connections are
blocked (only the Skyfly service can connect), which is good for security.

So the backup is made from inside Skyfly:

1. Platform admin → **System status & backup** → **Download full backup**. One JSON file with
   every business, order, customer, page, setting and history row (the download is logged).
   Keep it private: it contains customer names, phones, addresses and hashed passwords.
2. To restore, create a **new, empty** Postgres database and run:
   `DATABASE_URL=<new database URL> node scripts/restore-backup.mjs skyfly-backup-….json`
   It applies the migrations, inserts every row with its original id, and continues the
   numbering after them. It refuses to run on a database that already has businesses, so it
   can never overwrite live data. Then point the service's `DATABASE_URL` at it.

The round trip (download → restore into a separate database → every table identical) is
covered by `test/backup.test.js`.

### Expiry

Render deletes a free database after its expiry plus a short grace period, with all data.
Keeping it requires upgrading `skyfly-db` to a paid instance in the Render dashboard
(skyfly-db → Upgrade). The smallest paid instance (Basic-256mb) is listed by Render at
**$6/month plus $0.30 per GB of storage per month**; check render.com/pricing before upgrading.
Upgrading keeps the same database and data. This needs the owner's approval.
