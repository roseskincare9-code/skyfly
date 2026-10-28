// Email automations, run by a background worker in the web process (every minute):
//  1. contacts: customers with an email become contacts of their own business
//  2. plan: each active step gets one queued email per eligible order (a unique key per
//     step and order makes a second email for the same step impossible)
//  3. cancel: queued emails whose order is no longer eligible are cancelled with the reason
//  4. send: due emails are claimed, every rule is checked again with the latest order and
//     contact data, and the email goes out through the business's provider. It is marked
//     "sent" only when the provider confirms it.
// Emails stuck in "sending" (the server stopped mid-send) are marked failed with
// "outcome unknown" and are never retried automatically, so nobody gets two copies.
import { singleRunner, JOB_LOCKS } from '../lib/singleRunner.js';
import { decrypt } from '../lib/secrets.js';
import { formatMoney } from '../lib/money.js';
import { STATUS_LABELS, PAYMENT_LABELS } from '../lib/statuses.js';
import { sendEmail, renderEmail, SendError, PROVIDERS } from './emailProviders.js';
import { subscriptionState, expireSubscriptions } from './tenancy.js';
import { classifyCheckouts } from './checkouts.js';
import { planOrderNotifications, sendOrderNotifications } from './orderNotifications.js';

const RETRY_MINUTES = [5, 30, 120];
const MAX_ATTEMPTS = RETRY_MINUTES.length + 1;
const LATE_HOURS = 48;            // an email more than 2 days late is skipped, not sent
const STUCK_MINUTES = 15;

export const ANCHORS = {
  processing_since: 'Days after the order entered Processing',
  order_date: 'Days after the order was placed',
  delivered_date: 'Days after the order was marked Delivered',
  unpaid_since: 'Days after the order, while it is not marked Paid',
  last_order: 'Days after the customer\'s latest order, if they have not ordered again',
};
// Payment states in which an "order not yet paid" reminder still applies.
export const UNPAID = ['unpaid', 'pending', 'failed'];
// SQL: a later live order from the same customer exists (used by "has not ordered again").
const NEWER_ORDER = `EXISTS (SELECT 1 FROM orders n WHERE n.business_id = o.business_id AND lower(n.email) = lower(o.email)
  AND n.created_at > o.created_at AND NOT n.is_test AND n.status NOT IN ('cancelled', 'returned'))`;

// ---- 1. Contacts from orders (recent ones; existing customers were added by the migration).
export async function syncContacts(pool, { days = 3 } = {}) {
  await pool.query(
    `INSERT INTO email_contacts (business_id, email, name, phone, source, marketing_consent, consent_at, consent_source)
     SELECT DISTINCT ON (o.business_id, lower(o.email)) o.business_id, lower(o.email), o.customer_name, o.phone, 'order',
            o.marketing_consent, CASE WHEN o.marketing_consent THEN o.created_at END, CASE WHEN o.marketing_consent THEN 'checkout ' || o.reference END
       FROM orders o WHERE o.email IS NOT NULL AND NOT o.is_test AND o.created_at > now() - make_interval(days => $1)
      ORDER BY o.business_id, lower(o.email), o.created_at DESC
     ON CONFLICT (business_id, email) DO UPDATE SET
       marketing_consent = email_contacts.marketing_consent OR (EXCLUDED.marketing_consent AND email_contacts.unsubscribed_at IS NULL),
       consent_at = CASE WHEN NOT email_contacts.marketing_consent AND EXCLUDED.marketing_consent AND email_contacts.unsubscribed_at IS NULL THEN EXCLUDED.consent_at ELSE email_contacts.consent_at END,
       consent_source = CASE WHEN NOT email_contacts.marketing_consent AND EXCLUDED.marketing_consent AND email_contacts.unsubscribed_at IS NULL THEN EXCLUDED.consent_source ELSE email_contacts.consent_source END,
       updated_at = now()`, [days]);
}

// ---- 2. Plan: one queued email per active step and eligible order.
export async function planMessages(pool) {
  const { rowCount } = await pool.query(
    `WITH x AS (
       SELECT a.id AS automation_id, a.business_id, a.activated_at, s.id AS step_id, s.template_id, s.delay_days, s.send_hour, s.purpose,
              o.id AS order_id, lower(o.email) AS email, b.timezone,
              CASE WHEN a.anchor IN ('order_date', 'unpaid_since', 'last_order') THEN o.created_at ELSE
                (SELECT max(h.created_at) FROM order_status_history h WHERE h.order_id = o.id AND h.kind = 'fulfillment'
                    AND h.to_status = CASE a.anchor WHEN 'processing_since' THEN 'processing' ELSE 'delivered' END) END AS anchor_at
         FROM email_automations a
         JOIN businesses b ON b.id = a.business_id
         JOIN email_settings es ON es.business_id = a.business_id AND es.api_key_enc IS NOT NULL AND es.from_email IS NOT NULL
         JOIN email_automation_steps s ON s.automation_id = a.id AND s.business_id = a.business_id AND s.removed_at IS NULL
         JOIN orders o ON o.business_id = a.business_id AND o.email IS NOT NULL AND NOT o.is_test
        WHERE a.status = 'active' AND a.activated_at IS NOT NULL
          AND o.created_at > now() - interval '400 days'
          AND CASE a.anchor WHEN 'processing_since' THEN o.status = 'processing'
                            WHEN 'delivered_date' THEN o.status = 'delivered'
                            WHEN 'unpaid_since' THEN o.status NOT IN ('cancelled', 'returned') AND o.payment_status = ANY(ARRAY['unpaid', 'pending', 'failed'])
                            WHEN 'last_order' THEN o.status NOT IN ('cancelled', 'returned') AND NOT ${NEWER_ORDER}
                            ELSE o.status NOT IN ('cancelled', 'returned') END
     ), timed AS (
       SELECT x.*, GREATEST(x.anchor_at,
                ((x.anchor_at AT TIME ZONE x.timezone)::date + x.delay_days + make_time(x.send_hour, 0, 0)) AT TIME ZONE x.timezone) AS due_at
         FROM x WHERE x.anchor_at IS NOT NULL AND x.anchor_at >= x.activated_at
     )
     INSERT INTO email_messages (business_id, kind, automation_id, step_id, template_id, order_id, contact_id, to_email, purpose, scheduled_for, idempotency_key)
     SELECT t.business_id, 'automation', t.automation_id, t.step_id, t.template_id, t.order_id, c.id, t.email, t.purpose, t.due_at,
            'auto:' || t.step_id || ':' || t.order_id
       FROM timed t LEFT JOIN email_contacts c ON c.business_id = t.business_id AND c.email = t.email
      WHERE t.due_at > now() - make_interval(hours => $1)
     ON CONFLICT (idempotency_key) DO NOTHING`, [LATE_HOURS]);
  return rowCount;
}

// ---- 3. Cancel queued emails that no longer apply (optionally for one order, right after a status change).
export async function cancelIneligible(pool, { orderId = null } = {}) {
  const params = orderId ? [orderId] : [];
  const { rowCount } = await pool.query(
    `UPDATE email_messages m SET status = 'cancelled', updated_at = now(),
            reason = CASE WHEN a.status = 'stopped' THEN 'Automation stopped'
                          WHEN s.removed_at IS NOT NULL THEN 'Step removed from the automation'
                          WHEN a.anchor = 'unpaid_since' AND NOT (o.payment_status = ANY(ARRAY['unpaid', 'pending', 'failed'])) THEN 'Order is now marked ' || o.payment_status
                          WHEN a.anchor = 'last_order' AND ${NEWER_ORDER} THEN 'Customer ordered again'
                          ELSE 'Order is now ' || o.status END
       FROM email_automations a, orders o, email_automation_steps s
      WHERE m.status = 'queued' AND m.kind = 'automation' AND a.id = m.automation_id AND o.id = m.order_id AND s.id = m.step_id
        ${orderId ? 'AND m.order_id = $1' : ''}
        AND (a.status = 'stopped' OR s.removed_at IS NOT NULL
             OR o.status IN ('cancelled', 'returned')
             OR (a.anchor = 'processing_since' AND o.status <> 'processing')
             OR (a.anchor = 'delivered_date' AND o.status <> 'delivered')
             OR (a.anchor = 'unpaid_since' AND NOT (o.payment_status = ANY(ARRAY['unpaid', 'pending', 'failed'])))
             OR (a.anchor = 'last_order' AND ${NEWER_ORDER}))`, params);
  return rowCount;
}

// Placeholders for one order.
export async function orderValues(db, order, business) {
  const { rows: items } = await db.query('SELECT product_name, quantity FROM order_items WHERE order_id = $1 ORDER BY id', [order.id]);
  const name = String(order.customer_name || '').trim();
  return {
    customer_name: name, first_name: name.split(/\s+/)[0] || name,
    order_reference: order.reference,
    order_items: items.map((i) => `${i.product_name}${i.quantity > 1 ? ` x${i.quantity}` : ''}`).join(', '),
    order_total: formatMoney(order.total_minor, order.currency),
    order_date: new Date(order.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: business.timezone }),
    business_name: business.name,
  };
}

export const SAMPLE_VALUES = (business) => ({
  customer_name: 'Ada Okafor', first_name: 'Ada', order_reference: 'XX-SAMPLE1', order_items: 'Sample product x2',
  order_total: formatMoney(2500000, business.currency), order_date: new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: business.timezone }),
  business_name: business.name,
});

export function providerFor(settings, key, config) {
  if (!settings?.api_key_enc || !settings.from_email) return null;
  return { provider: settings.provider, apiKey: decrypt(key, settings.api_key_enc), baseOverride: config.emailApiBase || null };
}

const unsubscribeUrl = (config, token) => `${config.publicBaseUrl}/u/${token}`;

// Final checks right before sending, against the latest data. Returns a reason to skip/cancel, or null.
function ineligible(m, ctx) {
  const { business, automation, step, order, contact } = ctx;
  if (!subscriptionState(business).open) return ['skipped', 'The business\'s Skyfly subscription is not active'];
  if (!automation || automation.status === 'stopped') return ['cancelled', 'Automation stopped'];
  if (!step || step.removed_at) return ['cancelled', 'Step removed from the automation'];
  if (!order) return ['cancelled', 'Order no longer exists'];
  if (order.business_id !== m.business_id) return ['cancelled', 'Order belongs to another business'];
  if (['cancelled', 'returned'].includes(order.status)) return ['cancelled', `Order is now ${STATUS_LABELS[order.status]}`];
  if (automation.anchor === 'processing_since' && order.status !== 'processing') return ['cancelled', `Order is now ${STATUS_LABELS[order.status] ?? order.status}`];
  if (automation.anchor === 'delivered_date' && order.status !== 'delivered') return ['cancelled', `Order is now ${STATUS_LABELS[order.status] ?? order.status}`];
  if (automation.anchor === 'unpaid_since' && !UNPAID.includes(order.payment_status)) return ['cancelled', `Order is now marked ${PAYMENT_LABELS[order.payment_status] ?? order.payment_status}`];
  if (automation.anchor === 'last_order' && ctx.orderedAgain) return ['cancelled', 'Customer ordered again'];
  if (!order.email || order.email.toLowerCase() !== m.to_email) return ['skipped', 'The order\'s email address changed'];
  if (contact?.unsubscribed_at) return ['skipped', 'Contact unsubscribed'];
  if (contact?.suppressed_at) return ['skipped', `Contact suppressed${contact.suppressed_reason ? `: ${contact.suppressed_reason}` : ''}`];
  if (step.purpose === 'marketing' && !contact?.marketing_consent) return ['skipped', 'No marketing consent from this contact'];
  if (Date.now() - new Date(m.scheduled_for).getTime() > LATE_HOURS * 3600e3) return ['skipped', 'More than 2 days late (Skyfly was not running); not sent late'];
  return null;
}

async function finish(pool, id, fields) {
  const keys = Object.keys(fields);
  await pool.query(
    `UPDATE email_messages SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_at = now() WHERE id = $1`,
    [id, ...keys.map((k) => fields[k])]);
}

// ---- 4. Send due emails.
export async function sendDue(pool, config, { limit = 20 } = {}) {
  const key = config.encryptionKey;
  await pool.query(
    `UPDATE email_messages SET status = 'failed', outcome_unknown = true, updated_at = now(),
            reason = 'The server stopped while sending, so it is not known whether the email went out. Check the provider''s log before retrying.'
      WHERE status = 'sending' AND updated_at < now() - make_interval(mins => $1)`, [STUCK_MINUTES]);
  const { rows: claimed } = await pool.query(
    `UPDATE email_messages SET status = 'sending', attempts = attempts + 1, updated_at = now()
      WHERE status = 'queued'
        -- Businesses take turns, so one business's large send can't delay everyone else's emails.
        AND id IN (SELECT id FROM (
              SELECT id, scheduled_for, row_number() OVER (PARTITION BY business_id ORDER BY scheduled_for, id) AS turn FROM email_messages
               WHERE status = 'queued' AND kind = 'automation' AND scheduled_for <= now()
                 AND (next_attempt_at IS NULL OR next_attempt_at <= now())) due
             ORDER BY turn, scheduled_for, id LIMIT $1)
      RETURNING *`, [limit]);
  let sent = 0;
  for (const m of claimed) {
    try {
      const [{ rows: [business] }, { rows: [automation] }, { rows: [step] }, { rows: [order] }, { rows: [contact] }, { rows: [settings] }, { rows: [template] }] = await Promise.all([
        pool.query('SELECT b.*, (now() AT TIME ZONE b.timezone)::date::text AS local_today FROM businesses b WHERE b.id = $1', [m.business_id]),
        pool.query('SELECT * FROM email_automations WHERE id = $1 AND business_id = $2', [m.automation_id, m.business_id]),
        pool.query('SELECT * FROM email_automation_steps WHERE id = $1 AND business_id = $2', [m.step_id, m.business_id]),
        pool.query('SELECT * FROM orders WHERE id = $1', [m.order_id]),
        pool.query('SELECT * FROM email_contacts WHERE business_id = $1 AND email = $2', [m.business_id, m.to_email]),
        pool.query('SELECT * FROM email_settings WHERE business_id = $1', [m.business_id]),
        pool.query('SELECT t.* FROM email_templates t JOIN email_automation_steps s ON s.template_id = t.id AND s.business_id = t.business_id WHERE s.id = $1', [m.step_id]),
      ]);
      if (automation?.status === 'paused') { // waits; sent after "Resume" if still eligible and not too late
        await finish(pool, m.id, { status: 'queued', attempts: m.attempts - 1, next_attempt_at: new Date(Date.now() + 15 * 60e3) });
        continue;
      }
      const orderedAgain = automation?.anchor === 'last_order' && order
        ? (await pool.query(`SELECT ${NEWER_ORDER} AS yes FROM orders o WHERE o.id = $1`, [order.id])).rows[0].yes : false;
      const no = ineligible(m, { business, automation, step, order, contact, orderedAgain });
      if (no) { await finish(pool, m.id, { status: no[0], reason: no[1] }); continue; }
      let transport;
      try { transport = providerFor(settings, key, config); } catch { transport = null; }
      if (!transport) { await finish(pool, m.id, { status: 'skipped', reason: 'Email sending is not set up (or its API key can no longer be read): Email Automations → Sending setup' }); continue; }
      const rendered = renderEmail({
        template, values: await orderValues(pool, order, business), business, settings,
        unsubscribeUrl: contact ? unsubscribeUrl(config, contact.unsubscribe_token) : null, purpose: step.purpose,
      });
      const headers = contact ? { 'List-Unsubscribe': `<${unsubscribeUrl(config, contact.unsubscribe_token)}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } : {};
      const result = await sendEmail(transport, {
        to: m.to_email, fromEmail: settings.from_email, fromName: settings.from_name || business.name, replyTo: settings.reply_to,
        subject: rendered.subject, text: rendered.text, html: rendered.html, headers, idempotencyKey: m.idempotency_key,
      });
      await finish(pool, m.id, { status: 'sent', sent_at: new Date(), provider: settings.provider, provider_message_id: result.id, subject: rendered.subject, reason: null, contact_id: contact?.id ?? null });
      sent += 1;
    } catch (err) {
      const retry = err instanceof SendError && err.retryable && m.attempts < MAX_ATTEMPTS;
      await finish(pool, m.id, retry
        ? { status: 'queued', reason: `Attempt ${m.attempts} failed: ${err.message}`, next_attempt_at: new Date(Date.now() + RETRY_MINUTES[m.attempts - 1] * 60e3) }
        : { status: 'failed', reason: String(err.message || err).slice(0, 500) });
    }
  }
  return sent;
}

// Owner's "Retry": only failed emails; an "outcome unknown" one needs explicit confirmation.
export async function retryMessages(pool, businessId, { messageId = null, includeUnknown = false } = {}) {
  const params = [businessId];
  let where = "business_id = $1 AND status = 'failed' AND kind = 'automation'";
  if (messageId) { params.push(messageId); where += ` AND id = $${params.length}`; }
  if (!includeUnknown) where += ' AND NOT outcome_unknown';
  const { rowCount } = await pool.query(
    `UPDATE email_messages SET status = 'queued', next_attempt_at = NULL, attempts = 0, outcome_unknown = false,
            scheduled_for = GREATEST(scheduled_for, now() - interval '1 hour'), reason = 'Retry requested', updated_at = now() WHERE ${where}`, params);
  return rowCount;
}

// A test email (sample or real order data) to an address the owner types. Recorded in the history.
export async function sendTestEmail(pool, config, { business, template, to, orderId = null }) {
  const { rows: [settings] } = await pool.query('SELECT * FROM email_settings WHERE business_id = $1', [business.id]);
  let transport;
  try { transport = providerFor(settings, config.encryptionKey, config); } catch { transport = null; }
  if (!transport) throw new SendError('Email sending is not set up yet (provider, API key and sender address).');
  let values = SAMPLE_VALUES(business);
  if (orderId) {
    const { rows: [order] } = await pool.query('SELECT * FROM orders WHERE id = $1 AND business_id = $2', [orderId, business.id]);
    if (order) values = await orderValues(pool, order, business);
  }
  const tpl = template ?? { subject: 'Skyfly test email from {{business_name}}', body: 'This is a test email sent from Skyfly to check your email sending setup.\n\nIf you can read this, sending works.' };
  const rendered = renderEmail({ template: tpl, values, business, settings, unsubscribeUrl: null, purpose: 'operational' });
  const idem = `test:${business.id}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
  const { rows: [msg] } = await pool.query(
    `INSERT INTO email_messages (business_id, kind, template_id, to_email, subject, scheduled_for, status, attempts, idempotency_key)
     VALUES ($1, 'test', $2, $3, $4, now(), 'sending', 1, $5) RETURNING id`, [business.id, template?.id ?? null, to, `[TEST] ${rendered.subject}`, idem]);
  try {
    const result = await sendEmail(transport, {
      to, fromEmail: settings.from_email, fromName: settings.from_name || business.name, replyTo: settings.reply_to,
      subject: `[TEST] ${rendered.subject}`, text: rendered.text, html: rendered.html, headers: {}, idempotencyKey: idem,
    });
    await finish(pool, msg.id, { status: 'sent', sent_at: new Date(), provider: settings.provider, provider_message_id: result.id });
    await pool.query('UPDATE email_settings SET verified_at = now(), last_error = NULL WHERE business_id = $1', [business.id]);
    return result;
  } catch (err) {
    await finish(pool, msg.id, { status: 'failed', reason: String(err.message).slice(0, 500) });
    await pool.query('UPDATE email_settings SET last_error = $2 WHERE business_id = $1', [business.id, String(err.message).slice(0, 500)]);
    throw err;
  }
}

// One pass of all background jobs. The worker runs it every minute.
export async function runEmailJobs(pool, config) {
  await expireSubscriptions(pool);
  await syncContacts(pool);
  const planned = await planMessages(pool);
  const cancelled = await cancelIneligible(pool);
  const sent = await sendDue(pool, config);
  // Order notifications to the business (separate from customer emails; see orderNotifications.js).
  await planOrderNotifications(pool);
  const notified = await sendOrderNotifications(pool, config);
  // Checkout sessions: idle ones become abandoned; the retention policy is applied.
  const checkouts = await classifyCheckouts(pool);
  return { planned, cancelled, sent, notified, abandoned: checkouts.abandoned };
}

export function startEmailWorker(pool, config, { intervalMs = 60000, log = console } = {}) {
  let running = false;
  // Last run, shown on /healthz so production runs can be checked from outside.
  const status = { lastRunAt: null, lastOkAt: null, lastError: null, last: null };
  const run = async () => {
    if (running) return;
    running = true;
    status.lastRunAt = new Date().toISOString();
    try {
      // One instance at a time (see lib/singleRunner.js); null when another instance is running it.
      status.last = await singleRunner(pool, JOB_LOCKS.email, () => runEmailJobs(pool, config)) ?? status.last;
      status.lastOkAt = status.lastRunAt;
      status.lastError = null;
    } catch (err) { status.lastError = String(err.message).slice(0, 200); log.error('Email automation error:', err.message); } finally { running = false; }
  };
  const timer = setInterval(run, intervalMs);
  timer.unref?.();
  setTimeout(run, 5000).unref?.();
  return { kick: () => setImmediate(run), stop: () => clearInterval(timer), status };
}

export { PROVIDERS };
