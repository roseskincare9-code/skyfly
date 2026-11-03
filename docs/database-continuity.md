# Skyfly database continuity plan (free plan expires 14 November 2026)

This is a plan only. **Nothing here is done without the owner's approval:** no upgrade, no deletion
and no new database.

## Current state (checked 3 Nov 2026)

| Item | State |
|---|---|
| Database | Render Postgres `skyfly-db`, PostgreSQL 16, Frankfurt, **free plan** |
| Expiry | **2026-11-14 13:40 UTC**. Render deletes free databases after expiry |
| Render point-in-time recovery | Not available on the free plan |
| Render logical exports | None |
| Skyfly backups | Daily at 02:17 UTC (GitHub Actions "Database backup"), plus on demand |
| Backup contents | Every data table, through `/admin/backup.json` and the server's backup key. `test/backup.test.js` fails if a new table is missing from the backup |
| Backup check | Every backup is restored into an empty throwaway PostgreSQL 16 database, and the row counts are compared before the file is kept |
| Backup storage | GitHub Actions artifact `skyfly-backup-encrypted`, AES-256 (`openssl -pbkdf2 -iter 250000`), kept **30 days** |
| Passphrase | GitHub secret `BACKUP_PASSPHRASE` if set; otherwise the owner sign-in secret; otherwise Render → skyfly → Environment → `SKYFLY_BACKUP_KEY` |

## Plan A (recommended): upgrade the existing database in place

Render can change a free database's instance type to a paid one; the data and the connection stay the
same. Confirm the option in the Render dashboard before the day.

1. **Two days before (12 Nov):** run "Database backup" on demand and check that it is green, with the
   restore check and row counts. Download the encrypted artifact and keep it somewhere offline.
2. **Owner action:** Render → `skyfly-db` → change the instance type to **Basic-256mb** (about $6.30 a
   month). Do not delete or recreate the database.
3. **Right after:**
   - "Database status (read-only)": the plan is no longer `free` and there is no expiry date.
   - "Verify deployment": the app and database are healthy.
   - "Database backup": the row counts match the backup from step 1, plus any new orders.
4. If anything differs, stop and compare with the step 1 backup before making any change.

## Plan B (only if the database is lost): restore from the latest backup

1. Create a **new, empty** Render Postgres 16 (paid plan, Frankfurt).
2. Decrypt the newest backup:
   ```
   openssl enc -d -aes-256-cbc -pbkdf2 -iter 250000 -in skyfly-backup.json.enc -out backup.json -pass env:PASS
   ```
   `PASS` is the passphrase from the table above.
3. Restore:
   ```
   DATABASE_URL=<new database URL> node scripts/restore-backup.mjs backup.json
   ```
   The script applies the migrations, loads every table, and **refuses to run on a database that already
   holds businesses**.
4. Point the skyfly service's `DATABASE_URL` at the new database and deploy.
5. Check with "Verify deployment", "Database status" and "Access links and domain check". Compare the row
   counts with the backup log.

**Possible loss:** anything saved after the last backup. To keep this close to zero, run a backup on
demand right before any database change.

## Risks and what removes them

| Risk | Mitigation |
|---|---|
| The database is deleted at expiry | Plan A before 14 Nov (owner approval and click) |
| Backups older than 30 days are deleted | Download one copy offline before the upgrade |
| The passphrase depends on a Render setting | Add a `BACKUP_PASSPHRASE` GitHub secret and keep a copy offline |
| A new table is not backed up | `test/backup.test.js` blocks any change that misses one |
| A restore into a non-empty database | `restore-backup.mjs` refuses to run |
