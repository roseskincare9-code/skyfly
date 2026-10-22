// Order notifications to the business: one email per order Skyfly saved, to the business's own
// verified notification address. Queued after the order is committed (an email problem never
// affects the order), sent by the email worker, retried on temporary errors, never twice for
// the same order (one email_messages row per order, unique key "order:<id>"). "Sent" means the
// email provider confirmed it accepted the email, nothing more.
import { createHash, randomBytes } from 'node:crypto';
import { decrypt } from '../lib/secrets.js';
import { formatMoney } from '../lib/money.js';
import { sendEmail, SendError } from './emailProviders.js';

const RETRY_MINUTES = [1, 5, 30, 120];
const VERIFY_HOURS = 48;
const EMAIL_RE = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]{2,}$/;
export const validNotifyEmail = (e) => EMAIL_RE.test(e) && e.length <= 200;
const hashToken = (t) => createHash('sha256').update(t).digest('hex');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// The business's own email provider if it set one up, otherwise Skyfly's sender (server config).
export async function notifyTransport(pool, config, businessId) {
  const { rows: [s] } = await pool.query('SELECT * FROM email_settings WHERE business_id = $1', [businessId]);
  if (s?.api_key_enc && s.from_email && config.encryptionKey) {
    try {
      return { provider: s.provider, apiKey: decrypt(config.encryptionKey, s.api_key_enc), baseOverride: config.emailApiBase || null, fromEmail: s.from_email, fromName: s.from_name, replyTo: s.reply_to };
    } catch { /* key no longer readable: fall back to Skyfly's sender */ }
  }
  const p = config.notifyEmail;
  if (p?.apiKey && p.fromEmail) return { provider: p.provider, apiKey: p.apiKey, baseOverride: config.emailApiBase || null, fromEmail: p.fromEmail, fromName: p.fromName };
  return null;
}

// Why this business's orders can't be emailed right now (null when they can).
export function recipientProblem(b) {
  if (!b.notify_email) return 'No notification email set (Settings → Order notifications)';
  if (!b.notify_enabled) return 'Order notifications are turned off';
  if (!b.notify_verified_at) return `${b.notify_email} is not verified yet (Settings → Order notifications)`;
  return null;
}

// Queues (or records why not) one notification for each website/API order saved since the
// business turned notifications on. Safe to run any number of times.
export async function planOrderNotifications(pool) {
  const { rowCount } = await pool.query(
    `INSERT INTO email_messages (business_id, kind, order_id, to_email, subject, scheduled_for, status, reason, idempotency_key)
     SELECT o.business_id, 'order_notification', o.id, coalesce(b.notify_email, ''), NULL, now(),
            CASE WHEN b.notify_email IS NOT NULL AND b.notify_enabled AND b.notify_verified_at IS NOT NULL THEN 'queued' ELSE 'skipped' END,
            CASE WHEN b.notify_email IS NULL THEN 'No notification email set (Settings → Order notifications)'
                 WHEN NOT b.notify_enabled THEN 'Order notifications are turned off'
                 WHEN b.notify_verified_at IS NULL THEN b.notify_email || ' is not verified yet (Settings → Order notifications)' END,
            'order:' || o.id
       FROM orders o JOIN businesses b ON b.id = o.business_id
      WHERE o.source IN ('web', 'api') AND b.notify_since IS NOT NULL AND o.created_at >= b.notify_since
        AND o.created_at > now() - interval '7 days'
        AND NOT EXISTS (SELECT 1 FROM email_messages m WHERE m.idempotency_key = 'order:' || o.id)
     ON CONFLICT (idempotency_key) DO NOTHING`);
  return rowCount;
}

function content(config, b, o, items) {
  const date = new Date(o.created_at).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: b.timezone || 'Africa/Lagos' });
  const money = (m) => formatMoney(m, o.currency);
  const lines = items.map((i) => `${i.product_name}${i.options?.length ? ` (${i.options.map((x) => `${x.name}: ${x.value}`).join(', ')})` : ''} × ${i.quantity}${i.is_upsell ? ' (add-on)' : ''} — ${money(i.line_total_minor)}`);
  const link = `${config.publicBaseUrl}/businesses/${b.id}/orders/${o.id}`;
  const test = o.is_test ? '[TEST ORDER] ' : '';
  const subject = `${test}New order ${o.reference} — ${money(o.total_minor)}`;
  const rows = [
    ['Order', o.reference], ['Date', date], ['Customer', o.customer_name], ['Phone', o.phone], ['Email', o.email || '—'],
    ['Address', [o.address, o.state].filter(Boolean).join(', ') || '—'], ['Notes', o.notes || '—'],
  ];
  const delivery = Number(o.delivery_fee_minor ?? 0) > 0 ? [`Delivery — ${money(o.delivery_fee_minor)}`] : [];
  const text = [
    `${test}${b.name}: a new order was saved in Skyfly.`, '',
    ...rows.map(([k, v]) => `${k}: ${v}`), '', 'Products:', ...lines.map((l) => `  ${l}`), ...delivery.map((l) => `  ${l}`),
    `Total confirmed by Skyfly: ${money(o.total_minor)}`, '', `Open the order in Skyfly (sign-in required): ${link}`,
    ...(o.is_test ? ['', 'This is a test order: it is not counted in sales.'] : []),
  ].join('\n');
  const html = `<div style="font-family:Arial,sans-serif;font-size:15px;color:#222">
<p><strong>${esc(test)}${esc(b.name)}</strong>: a new order was saved in Skyfly.</p>
<table cellpadding="4" style="border-collapse:collapse">${rows.map(([k, v]) => `<tr><td style="color:#666">${esc(k)}</td><td>${esc(v)}</td></tr>`).join('')}</table>
<p style="margin-bottom:4px"><strong>Products</strong></p><ul style="margin-top:0">${[...lines, ...delivery].map((l) => `<li>${esc(l)}</li>`).join('')}</ul>
<p><strong>Total confirmed by Skyfly: ${esc(money(o.total_minor))}</strong></p>
<p><a href="${esc(link)}">Open the order in Skyfly</a> (sign-in required)</p>${o.is_test ? '<p style="color:#666">This is a test order: it is not counted in sales.</p>' : ''}</div>`;
  return { subject, text, html };
}

async function finish(pool, id, fields) {
  const keys = Object.keys(fields);
  await pool.query(`UPDATE email_messages SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_at = now() WHERE id = $1`,
    [id, ...keys.map((k) => fields[k])]);
}

// Sends queued order notifications. Each is claimed once (no double send by parallel runs).
export async function sendOrderNotifications(pool, config, { limit = 20 } = {}) {
  const { rows: claimed } = await pool.query(
    `UPDATE email_messages SET status = 'sending', attempts = attempts + 1, updated_at = now()
      WHERE id IN (SELECT id FROM email_messages WHERE status = 'queued' AND kind = 'order_notification'
                     AND (next_attempt_at IS NULL OR next_attempt_at <= now()) ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED)
      RETURNING *`, [limit]);
  let sent = 0;
  for (const m of claimed) {
    try {
      const { rows: [b] } = await pool.query('SELECT * FROM businesses WHERE id = $1', [m.business_id]);
      const { rows: [o] } = await pool.query('SELECT * FROM orders WHERE id = $1 AND business_id = $2', [m.order_id, m.business_id]);
      if (!o) { await finish(pool, m.id, { status: 'cancelled', reason: 'Order no longer exists' }); continue; }
      // The recipient is checked again just before sending, against the business's current settings.
      const problem = recipientProblem(b) ?? (b.notify_email !== m.to_email ? 'The notification email changed after this order' : null);
      if (problem) { await finish(pool, m.id, { status: 'skipped', reason: problem }); continue; }
      const transport = await notifyTransport(pool, config, b.id);
      if (!transport) {
        await finish(pool, m.id, { status: 'failed', reason: 'No email sending is set up (Email → Sending setup, or Skyfly\'s sender on the server). Retry once it is.' });
        continue;
      }
      const { rows: items } = await pool.query('SELECT * FROM order_items WHERE order_id = $1 ORDER BY id', [o.id]);
      const c = content(config, b, o, items);
      const result = await sendEmail(transport, {
        to: m.to_email, fromEmail: transport.fromEmail, fromName: transport.fromName || 'Skyfly', replyTo: o.email || transport.replyTo || null,
        subject: c.subject, text: c.text, html: c.html, headers: {}, idempotencyKey: m.idempotency_key,
      });
      await finish(pool, m.id, { status: 'sent', sent_at: new Date(), provider: transport.provider, provider_message_id: result.id, subject: c.subject, reason: null });
      sent += 1;
    } catch (err) {
      const retry = err instanceof SendError && err.retryable && m.attempts < RETRY_MINUTES.length;
      await finish(pool, m.id, retry
        ? { status: 'queued', reason: `Attempt ${m.attempts} failed: ${err.message}`, next_attempt_at: new Date(Date.now() + RETRY_MINUTES[m.attempts - 1] * 60e3) }
        : { status: 'failed', reason: String(err.message || err).slice(0, 500) });
    }
  }
  return sent;
}

// Owner's "Retry" for one order's notification (failed, or skipped while unverified/no sender).
export async function retryOrderNotification(pool, businessId, orderId) {
  const { rows: [b] } = await pool.query('SELECT * FROM businesses WHERE id = $1', [businessId]);
  const problem = recipientProblem(b);
  if (problem) return { ok: false, error: problem };
  const { rowCount } = await pool.query(
    `UPDATE email_messages SET status = 'queued', to_email = $3, attempts = 0, next_attempt_at = NULL, reason = 'Retry requested', updated_at = now()
      WHERE business_id = $1 AND order_id = $2 AND kind = 'order_notification' AND status IN ('failed', 'skipped')`, [businessId, orderId, b.notify_email]);
  return rowCount ? { ok: true } : { ok: false, error: 'Nothing to retry for this order.' };
}

// Sets the business's notification address (unverified until its link is opened).
export async function setNotifyEmail(pool, businessId, email, enabled) {
  await pool.query(
    `UPDATE businesses SET notify_enabled = $3,
            notify_verified_at = CASE WHEN notify_email IS DISTINCT FROM $2 THEN NULL ELSE notify_verified_at END,
            notify_verify_hash = CASE WHEN notify_email IS DISTINCT FROM $2 THEN NULL ELSE notify_verify_hash END,
            notify_since = CASE WHEN $2 IS NULL THEN notify_since ELSE coalesce(notify_since, now()) END,
            notify_email = $2
      WHERE id = $1`, [businessId, email, enabled]);
}

// Emails a one-time link (48 hours) to the business's notification address.
export async function sendVerification(pool, config, business) {
  if (!business.notify_email) throw new SendError('Save a notification email first.');
  const transport = await notifyTransport(pool, config, business.id);
  if (!transport) throw new SendError('No email sending is set up yet: connect a provider under Email → Sending setup (or ask the Skyfly team to set Skyfly\'s sender).');
  const token = randomBytes(24).toString('base64url');
  await pool.query('UPDATE businesses SET notify_verify_hash = $2, notify_verify_sent_at = now() WHERE id = $1', [business.id, hashToken(token)]);
  const link = `${config.publicBaseUrl}/notify/verify/${token}`;
  const idem = `verify:${business.id}:${Date.now()}`;
  const { rows: [msg] } = await pool.query(
    `INSERT INTO email_messages (business_id, kind, to_email, subject, scheduled_for, status, attempts, idempotency_key)
     VALUES ($1, 'verification', $2, $3, now(), 'sending', 1, $4) RETURNING id`, [business.id, business.notify_email, `Confirm order notifications for ${business.name}`, idem]);
  try {
    const result = await sendEmail(transport, {
      to: business.notify_email, fromEmail: transport.fromEmail, fromName: transport.fromName || 'Skyfly', replyTo: null,
      subject: `Confirm order notifications for ${business.name}`, headers: {}, idempotencyKey: idem,
      text: `Open this link to receive an email for every new order of ${business.name} in Skyfly:\n\n${link}\n\nThe link works for ${VERIFY_HOURS} hours. If you did not ask for this, ignore this email.`,
      html: `<p>Open this link to receive an email for every new order of <strong>${esc(business.name)}</strong> in Skyfly:</p><p><a href="${esc(link)}">Confirm order notifications</a></p><p style="color:#666">The link works for ${VERIFY_HOURS} hours. If you did not ask for this, ignore this email.</p>`,
    });
    await finish(pool, msg.id, { status: 'sent', sent_at: new Date(), provider: transport.provider, provider_message_id: result.id });
  } catch (err) {
    await finish(pool, msg.id, { status: 'failed', reason: String(err.message).slice(0, 500) });
    throw err;
  }
}

// The link from the verification email. Returns the business name and address, or null.
export async function confirmVerification(pool, token) {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(String(token))) return null;
  const { rows: [b] } = await pool.query(
    `UPDATE businesses SET notify_verified_at = now(), notify_verify_hash = NULL, notify_since = coalesce(notify_since, now())
      WHERE notify_verify_hash = $1 AND notify_verify_sent_at > now() - make_interval(hours => $2) RETURNING name, notify_email`,
    [hashToken(token), VERIFY_HOURS]);
  return b ?? null;
}

// The notification state of one order, for the dashboard.
export async function notificationFor(pool, orderId) {
  const { rows: [m] } = await pool.query(
    "SELECT status, reason, to_email, sent_at, provider, attempts, next_attempt_at FROM email_messages WHERE order_id = $1 AND kind = 'order_notification'", [orderId]);
  return m ?? null;
}
