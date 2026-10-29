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
  // Proof, read back from the restored database: every table has exactly the file's rows, and
  // every order (reference, business, total, status, payment) is identical.
  const problems = [];
  for (const [t, n] of Object.entries(counts)) {
    const { rows: [r] } = await pool.query(`SELECT count(*)::int AS n FROM ${t}`);
    console.log(`  ${t.padEnd(24)} ${String(n).padStart(6)} in the file, ${String(r.n).padStart(6)} restored${r.n === n ? '' : '  MISMATCH'}`);
    if (r.n !== n) problems.push(`${t}: ${n} in the file, ${r.n} restored`);
  }
  const o = backup.tables.orders;
  if (o) {
    const col = (name) => o.columns.indexOf(name);
    const key = (ref, biz, total, status, pay) => [ref, biz, total, status, pay].map(String).join('|');
    const fromFile = new Set(o.rows.map((r) => key(r[col('reference')], r[col('business_id')], r[col('total_minor')], r[col('status')], r[col('payment_status')])));
    const { rows } = await pool.query('SELECT reference, business_id, total_minor, status, payment_status FROM orders');
    const restored = new Set(rows.map((r) => key(r.reference, r.business_id, r.total_minor, r.status, r.payment_status)));
    const missing = [...fromFile].filter((k) => !restored.has(k));
    if (missing.length || restored.size !== fromFile.size) problems.push(`orders: ${missing.length} order(s) differ after restoring`);
    else console.log(`  orders: all ${fromFile.size} identical (reference, business, total, status, payment)`);
  }
  if (problems.length) throw new Error(`the restored database does not match the backup: ${problems.join('; ')}`);
  console.log('Verified: the restored database matches the backup file.');
} catch (err) {
  console.error(err.message.startsWith('the restored database') ? `Verification FAILED: ${err.message}` : `Restore failed, nothing was changed: ${err.message}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
