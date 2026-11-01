// Per-account (and per-address) limits for sign-in, registration and password reset, on top of the
// per-IP limits in app.js. Keys are stored only as hashes. A limit applies whether or not an account
// exists for that email, so the answer never tells anyone which emails have accounts.
import { createHash } from 'node:crypto';

const hash = (kind, key) => createHash('sha256').update(`${kind}:${String(key ?? '').trim().toLowerCase()}`).digest('hex');

export const LIMITS = {
  login_failed: { limit: 5, minutes: 15 }, // wrong password for one email
  admin_login_failed: { limit: 5, minutes: 15 },
  reset_requested: { limit: 3, minutes: 60 }, // reset emails for one address
  signup_ip: { limit: 5, minutes: 24 * 60 }, // new accounts from one IP per day
};

export async function tooMany(pool, kind, key) {
  const { limit, minutes } = LIMITS[kind];
  const { rows: [r] } = await pool.query(
    'SELECT count(*)::int AS n FROM auth_attempts WHERE kind = $1 AND key_hash = $2 AND created_at > now() - make_interval(mins => $3)',
    [kind, hash(kind, key), minutes]);
  return r.n >= limit;
}

export async function record(pool, kind, key) {
  await pool.query('INSERT INTO auth_attempts (kind, key_hash) VALUES ($1, $2)', [kind, hash(kind, key)]);
  // Housekeeping: now and then, drop rows no limit looks at any more.
  if (Math.random() < 0.05) await pool.query("DELETE FROM auth_attempts WHERE created_at < now() - interval '2 days'").catch(() => {});
}

export async function clear(pool, kind, key) {
  await pool.query('DELETE FROM auth_attempts WHERE kind = $1 AND key_hash = $2', [kind, hash(kind, key)]);
}
