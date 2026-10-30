// Recovery: makes an existing account a Super Admin (or removes it with --revoke), directly in the
// database. Production never makes anyone a Super Admin by signing up; use this for the first one on a
// new database, or if every Super Admin has lost access. Run where DATABASE_URL reaches the database:
//   DATABASE_URL=... node scripts/grant-admin.mjs owner@example.com [--revoke]
import { createPool } from '../src/db.js';

const email = String(process.argv[2] ?? '').trim().toLowerCase();
const revoke = process.argv.includes('--revoke');
if (!email || !process.env.DATABASE_URL) {
  console.error('Usage: DATABASE_URL=... node scripts/grant-admin.mjs <account email> [--revoke]');
  process.exit(1);
}
const pool = createPool(process.env.DATABASE_URL, process.env.DATABASE_SSL === 'true' || /render\.com/.test(process.env.DATABASE_URL));
try {
  const { rows: [u] } = await pool.query('UPDATE users SET is_platform_admin = $2 WHERE email = $1 RETURNING id', [email, !revoke]);
  if (!u) throw new Error(`no account uses ${email}`);
  await pool.query("INSERT INTO audit_log (action, entity_type, entity_id, details) VALUES ($1, 'user', $2, $3)",
    [revoke ? 'admin.access_revoked' : 'admin.access_granted', String(u.id), JSON.stringify({ email, via: 'grant-admin script' })]);
  console.log(`${email} ${revoke ? 'is no longer' : 'is now'} a Super Admin.`);
} catch (err) {
  console.error(`Not changed: ${err.message}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
