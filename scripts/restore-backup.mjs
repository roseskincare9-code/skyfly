// Restores a Skyfly backup file (Platform admin → System status → Download full backup)
// into a NEW, EMPTY database. It applies the migrations first, then the data. It refuses to
// run on a database that already holds businesses, so live data can never be overwritten.
//
//   DATABASE_URL=postgres://...new-empty-db... node scripts/restore-backup.mjs skyfly-backup-2026-10-17.json
import { readFile } from 'node:fs/promises';
import { createPool } from '../src/db.js';
import { migrate } from '../src/migrate.js';
import { restoreBackup } from '../src/services/backup.js';

const file = process.argv[2];
if (!file || !process.env.DATABASE_URL) {
  console.error('Usage: DATABASE_URL=<new empty database> node scripts/restore-backup.mjs <backup.json>');
  process.exit(1);
}
const pool = createPool(process.env.DATABASE_URL, process.env.DATABASE_SSL === 'true' || /render\.com/.test(process.env.DATABASE_URL));
try {
  const backup = JSON.parse(await readFile(file, 'utf8'));
  await migrate(pool);
  const counts = await restoreBackup(pool, backup);
  console.log(`Restored backup from ${backup.createdAt}:`);
  for (const [t, n] of Object.entries(counts)) console.log(`  ${t.padEnd(24)} ${n}`);
} catch (err) {
  console.error(`Restore failed, nothing was changed: ${err.message}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
