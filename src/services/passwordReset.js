// Password reset: a one-time link, by email (when Skyfly has an email sender) or made by the platform
// owner for a client and passed on personally. Only the link's hash is stored. Using a link sets the
// new password, ends every signed-in session of the account and closes its other open links.
import { createHash, randomBytes } from 'node:crypto';
import { hashPassword } from '../lib/passwords.js';
import { sendEmail } from './emailProviders.js';
import { isE2eEmail } from './setup.js';

const EMAIL_LINK_MINUTES = 60;
export const ADMIN_LINK_HOURS = 24;
const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const sha256 = (v) => createHash('sha256').update(v).digest('hex');

export async function createResetLink(pool, userId, { createdBy = null, minutes = EMAIL_LINK_MINUTES } = {}) {
  const token = randomBytes(32).toString('base64url');
  await pool.query(
    'INSERT INTO password_resets (user_id, token_hash, created_by, expires_at) VALUES ($1, $2, $3, now() + make_interval(mins => $4))',
    [userId, sha256(token), createdBy, minutes]);
  return token;
}

// The account a link belongs to, while the link is unused and not expired.
export async function findReset(pool, token) {
  if (!/^[A-Za-z0-9_-]{40,60}$/.test(String(token))) return null;
  const { rows: [r] } = await pool.query(
    `SELECT pr.id, pr.user_id, u.email FROM password_resets pr JOIN users u ON u.id = pr.user_id
      WHERE pr.token_hash = $1 AND pr.used_at IS NULL AND pr.expires_at > now()`, [sha256(token)]);
  return r ?? null;
}

export async function completeReset(pool, token, password) {
  const passwordHash = await hashPassword(password);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [r] } = await client.query(
      `UPDATE password_resets SET used_at = now()
        WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now() RETURNING user_id`, [sha256(token)]);
    if (!r) { await client.query('ROLLBACK'); return null; }
    await client.query('UPDATE users SET password_hash = $2 WHERE id = $1', [r.user_id, passwordHash]);
    await client.query('UPDATE password_resets SET used_at = now() WHERE user_id = $1 AND used_at IS NULL', [r.user_id]);
    await client.query("DELETE FROM user_sessions WHERE sess->>'userId' = $1", [String(r.user_id)]);
    await client.query('COMMIT');
    return r.user_id;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// "Forgot password": emails a link when the address has an account and Skyfly's sender is set up.
// The page says the same thing either way, so it never reveals which addresses have accounts.
export async function requestResetEmail(pool, config, email, base) {
  const sender = config.notifyEmail;
  if (!sender || isE2eEmail(email)) return { sent: false, reason: sender ? 'no account' : 'no sender' };
  const { rows: [u] } = await pool.query('SELECT id, name, email FROM users WHERE email = $1', [email]);
  if (!u) return { sent: false, reason: 'no account' };
  const token = await createResetLink(pool, u.id);
  const link = `${base}/reset-password/${token}`;
  await sendEmail({ provider: sender.provider, apiKey: sender.apiKey, baseOverride: config.emailApiBase || null }, {
    to: u.email, fromEmail: sender.fromEmail, fromName: sender.fromName || 'Skyfly', replyTo: null, headers: {}, idempotencyKey: `password-reset:${sha256(token).slice(0, 32)}`,
    subject: 'Reset your Skyfly password',
    text: `Hi ${u.name},\n\nUse this link to choose a new Skyfly password. It works once, for ${EMAIL_LINK_MINUTES} minutes:\n\n${link}\n\nIf you didn't ask for this, ignore this email; your password stays the same.`,
    html: `<p>Hi ${esc(u.name)},</p><p>Use this link to choose a new Skyfly password. It works once, for ${EMAIL_LINK_MINUTES} minutes:</p><p><a href="${esc(link)}">Choose a new password</a></p><p>If you didn't ask for this, ignore this email; your password stays the same.</p>`,
  });
  return { sent: true };
}
