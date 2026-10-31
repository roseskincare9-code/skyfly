// Email verification for self-registered accounts: a one-time link (only its hash is stored, valid 48
// hours) sent with Skyfly's email sender. Required only when that sender is set up; without it there is
// no way to send the link, so accounts work unverified (the dashboard says so).
import { createHash, randomBytes } from 'node:crypto';
import { sendEmail } from './emailProviders.js';

const HOURS = 48;
const sha256 = (v) => createHash('sha256').update(v).digest('hex');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const senderReady = (config) => Boolean(config.notifyEmail?.apiKey && config.notifyEmail?.fromEmail);
export const needsVerification = (config, user) => senderReady(config) && Boolean(user) && !user.email_verified_at;

export async function markVerified(db, userId) {
  await db.query('UPDATE users SET email_verified_at = coalesce(email_verified_at, now()) WHERE id = $1', [userId]);
}

// Sends a fresh link (earlier unused links stop working).
export async function sendVerification(pool, config, user, base) {
  const sender = config.notifyEmail;
  const token = randomBytes(32).toString('base64url');
  await pool.query('UPDATE email_verifications SET used_at = now() WHERE user_id = $1 AND used_at IS NULL', [user.id]);
  await pool.query("INSERT INTO email_verifications (user_id, token_hash, expires_at) VALUES ($1, $2, now() + make_interval(hours => $3))", [user.id, sha256(token), HOURS]);
  const link = `${base}/verify-email/${token}`;
  await sendEmail({ provider: sender.provider, apiKey: sender.apiKey, baseOverride: config.emailApiBase || null }, {
    to: user.email, fromEmail: sender.fromEmail, fromName: sender.fromName || 'Skyfly', replyTo: null, headers: {},
    idempotencyKey: `verify-email:${sha256(token).slice(0, 32)}`,
    subject: 'Confirm your email for Skyfly',
    text: `Hi ${user.name},\n\nConfirm your email address to open your Skyfly dashboard (the link works once, for ${HOURS} hours):\n\n${link}\n\nIf you didn't create a Skyfly account, ignore this email.`,
    html: `<p>Hi ${esc(user.name)},</p><p>Confirm your email address to open your Skyfly dashboard (the link works once, for ${HOURS} hours):</p><p><a href="${esc(link)}">Confirm my email</a></p><p>If you didn't create a Skyfly account, ignore this email.</p>`,
  });
}

// Uses a link: the account is verified. Returns the user ID, or null for an unknown/used/expired link.
export async function useVerification(pool, token) {
  if (!/^[A-Za-z0-9_-]{40,60}$/.test(String(token ?? ''))) return null;
  const { rows: [r] } = await pool.query(
    `UPDATE email_verifications SET used_at = now() WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now() RETURNING user_id`, [sha256(token)]);
  if (!r) return null;
  await markVerified(pool, r.user_id);
  return r.user_id;
}
