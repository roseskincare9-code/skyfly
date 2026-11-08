// Super Admin infrastructure manager: what the platform pays for, when each renewal is due, and alerts.
// Everything here is entered by a Super Admin (marked "entered by you"). Nothing renews automatically from
// Skyfly; the provider's own billing does that. No credentials are stored.
import { sendEmail } from './emailProviders.js';
import { E2E_EMAIL_LIKE } from './setup.js';

export const CATEGORIES = { hosting: 'Hosting', database: 'Database', domain: 'Domain & DNS', email: 'Email', monitoring: 'Monitoring', security: 'Security', other: 'Other' };
export const FREQUENCIES = { monthly: 'Monthly', yearly: 'Yearly', one_time: 'One-time', usage: 'Usage-based', free: 'Free' };
export const PAYMENT_STATUSES = { paid: 'Paid', due: 'Due', overdue: 'Overdue', failed: 'Payment failed', free: 'Free', unknown: 'Unknown' };
// Whether the provider has a usable payment method (never card details).
export const PAYMENT_METHODS = { on_file: 'On file', missing: 'Missing', expired: 'Expired', failed: 'Declined / failed', not_needed: 'Not needed', unknown: 'Not confirmed' };
// Alert thresholds in days before the renewal date (0 = the date itself): 30 (early notice), 14, 7, 3, 0.
export const THRESHOLDS = [30, 14, 7, 3, 0];
// A failed payment or an unusable payment method alerts at once (not on a schedule).
export const paymentProblem = (s) => s.payment_status === 'failed' || ['failed', 'expired'].includes(s.payment_method_status);
const DAY = 864e5;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// The date that matters for a service: the next payment, else the expiry.
export const renewalDate = (s) => s.next_payment_on || s.expires_on || null;
const dateStr = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : d ? String(d).slice(0, 10) : null);

// The domain a service is about (e.g. "getskyfly.com domain" -> getskyfly.com), to compare with the registry.
export const serviceDomain = (s) => (s.category === 'domain' ? (/\b([a-z0-9-]+(?:\.[a-z0-9-]+)+)\b/i.exec(s.name)?.[1]?.toLowerCase() ?? null) : null);

// registryExpiresOn: the registry's own expiry date for the service's domain, when known (read every 12 hours).
export function serviceSummary(s, now = new Date(), { registryExpiresOn = null } = {}) {
  const date = dateStr(renewalDate(s));
  const today = Date.parse(now.toISOString().slice(0, 10));
  const daysLeft = date ? Math.round((Date.parse(date) - today) / DAY) : null;
  const alerts = [];
  if (s.payment_status === 'failed') alerts.push({ level: 'act', text: 'Payment failed: update the payment method at the provider.' });
  if (s.payment_method_status === 'failed') alerts.push({ level: 'act', text: 'The payment method was declined: update it at the provider.' });
  if (s.payment_method_status === 'expired') alerts.push({ level: 'act', text: 'The payment method has expired: update it at the provider.' });
  if (s.payment_method_status === 'missing' && s.billing_frequency !== 'free') alerts.push({ level: 'watch', text: 'No payment method on file at the provider.' });
  // A domain renewal is confirmed only by the registry: a recorded date later than the registry's is not yet confirmed.
  const registry = dateStr(registryExpiresOn);
  if (registry && s.expires_on && dateStr(s.expires_on) > registry) alerts.push({ level: 'watch', text: `Renewal recorded to ${dateStr(s.expires_on)}, but the registry still shows ${registry}: not confirmed by the registry yet.` });
  if (s.payment_status === 'overdue') alerts.push({ level: 'act', text: 'Payment overdue.' });
  if (daysLeft !== null && daysLeft < 0) alerts.push({ level: 'act', text: `Renewal date passed ${-daysLeft} day(s) ago (${date}).` });
  else if (daysLeft !== null && daysLeft <= 30 && s.billing_frequency !== 'free') {
    alerts.push({ level: daysLeft <= 7 ? 'act' : 'watch', text: `${daysLeft === 0 ? 'Renews today' : `Renews in ${daysLeft} day(s)`} (${date})${s.auto_renew === true ? ', auto-renew on at the provider' : s.auto_renew === false ? ', auto-renew OFF: renew by hand' : ', auto-renew not confirmed'}.` });
  }
  if (s.billing_frequency === 'free' && daysLeft !== null && daysLeft <= 30) alerts.push({ level: daysLeft <= 7 ? 'act' : 'watch', text: `Free plan ends ${daysLeft < 0 ? `${-daysLeft} day(s) ago` : `in ${daysLeft} day(s)`} (${date}).` });
  const level = alerts.some((a) => a.level === 'act') ? 'act' : alerts.length ? 'watch' : 'ok';
  return { date, daysLeft, alerts, level, registry, registryConfirmed: Boolean(registry && s.expires_on && dateStr(s.expires_on) <= registry) };
}

// Monthly cost of a service in its own currency (yearly ÷ 12; one-time, usage and free count as 0).
export const monthlyMinor = (s) => (s.price_minor == null ? 0 : s.billing_frequency === 'monthly' ? Number(s.price_minor) : s.billing_frequency === 'yearly' ? Math.round(Number(s.price_minor) / 12) : 0);

export async function listServices(pool, { archived = false } = {}) {
  const { rows } = await pool.query(`SELECT * FROM infra_services WHERE ${archived ? 'archived_at IS NOT NULL' : 'archived_at IS NULL'} ORDER BY coalesce(next_payment_on, expires_on) NULLS LAST, name`);
  return rows;
}

export function totals(services) {
  const byCurrency = {};
  for (const s of services) {
    const m = monthlyMinor(s);
    if (!m) continue;
    byCurrency[s.currency] = (byCurrency[s.currency] ?? 0) + m;
  }
  return Object.entries(byCurrency).map(([currency, monthly]) => ({ currency, monthly, yearly: monthly * 12 }));
}

// Email every active Super Admin (test accounts excluded). Returns { status, detail } for the record.
export async function emailSuperAdmins(pool, config, { subject, text, html, key }) {
  const p = config.notifyEmail;
  const { rows: admins } = await pool.query('SELECT email FROM users WHERE is_platform_admin AND disabled_at IS NULL AND email NOT LIKE $1 ORDER BY id', [E2E_EMAIL_LIKE]);
  if (!p?.apiKey || !p.fromEmail) return { status: 'not_sent', detail: 'No email sender configured: shown in Platform admin only.' };
  if (!admins.length) return { status: 'not_sent', detail: 'No Super Admin email address.' };
  const sent = []; let detail = null;
  for (const a of admins) {
    try {
      await sendEmail({ provider: p.provider, apiKey: p.apiKey, baseOverride: config.emailApiBase || null }, { to: a.email, fromEmail: p.fromEmail, fromName: p.fromName, subject, text, html, idempotencyKey: `${key}:${a.email}` });
      sent.push(a.email);
    } catch (err) { detail = `Not sent: ${String(err.message).slice(0, 120)}`; }
  }
  return sent.length ? { status: 'sent', detail: `Sent to ${sent.length} Super Admin(s)` } : { status: 'not_sent', detail };
}

// Background job (and at once when a payment problem is saved): each threshold (30/14/7/3/0 days) alerts
// once per renewal date, and a payment problem once per day it is seen.
export async function remindInfra(pool, config, { now = new Date() } = {}) {
  const results = [];
  for (const s of await listServices(pool)) {
    const sum = serviceSummary(s, now);
    const keys = [];
    if (paymentProblem(s)) keys.push(['failed', dateStr(s.updated_at) ?? dateStr(now)]);
    // The tightest step reached: 30, 14, 7, 3 or 0 days before (one reminder per step and date).
    const step = sum.daysLeft !== null && sum.daysLeft >= 0 ? [...THRESHOLDS].sort((a, b) => a - b).find((d) => sum.daysLeft <= d) : undefined;
    if (step !== undefined) keys.push([`${step}d`, sum.date]);
    for (const [threshold, due] of keys) {
      const { rows: [r] } = await pool.query(
        `INSERT INTO infra_service_reminders (service_id, threshold, due_on, status, detail) VALUES ($1, $2, $3, 'not_sent', 'Sending')
         ON CONFLICT (service_id, threshold, due_on) DO NOTHING RETURNING id`, [s.id, threshold, due]);
      if (!r) continue;
      const what = threshold === 'failed' ? 'payment problem' : sum.daysLeft === 0 ? 'renews today' : `renews in ${sum.daysLeft} days (${sum.date})`;
      const subject = `${threshold === 'failed' ? 'ACTION NEEDED: ' : ''}${s.name} (${s.provider}): ${what}`;
      const text = `${s.name} — ${s.provider}${s.plan ? `, ${s.plan}` : ''}: ${what}.\n${sum.alerts.map((a) => `- ${a.text}`).join('\n')}\n${s.manage_url ? `\nManage: ${s.manage_url}\n` : ''}${config.publicBaseUrl ? `Infrastructure in Skyfly: ${config.publicBaseUrl}/admin/infrastructure\n` : ''}`;
      const html = `<p><strong>${esc(s.name)}</strong> — ${esc(s.provider)}: ${esc(what)}.</p><ul>${sum.alerts.map((a) => `<li>${esc(a.text)}</li>`).join('')}</ul>${s.manage_url ? `<p><a href="${esc(s.manage_url)}">Manage at the provider</a></p>` : ''}`;
      const { status, detail } = await emailSuperAdmins(pool, config, { subject, text, html, key: `infra-reminder:${r.id}` });
      await pool.query('UPDATE infra_service_reminders SET status = $2, detail = $3 WHERE id = $1', [r.id, status, detail]);
      results.push({ service: s.name, threshold, status });
    }
  }
  return results;
}

// ---- Backups reported by the GitHub Actions jobs (backup key). Times, sizes and counts only.
export const BACKUP_STALE_HOURS = 36;
export async function recordBackupRun(pool, config, b) {
  const { rows: [row] } = await pool.query(
    `INSERT INTO backup_runs (kind, status, run_id, run_url, size_bytes, sha256, tables, total_rows, detail)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
    [b.kind, b.status, b.run_id, b.run_url, b.size_bytes, b.sha256, b.tables, b.total_rows, b.detail]);
  if (row.status === 'failed') {
    const what = row.kind === 'backup' ? 'Database backup FAILED' : 'Backup restore test FAILED';
    const text = `${what}.\n${row.detail ? `${row.detail}\n` : ''}${row.run_url ? `Run: ${row.run_url}\n` : ''}${config.publicBaseUrl ? `System status in Skyfly: ${config.publicBaseUrl}/admin/system\n` : ''}`;
    const html = `<p><strong>${esc(what)}</strong></p>${row.detail ? `<p>${esc(row.detail)}</p>` : ''}${row.run_url ? `<p><a href="${esc(row.run_url)}">Open the run</a></p>` : ''}`;
    const { detail } = await emailSuperAdmins(pool, config, { subject: `ACTION NEEDED: ${what}`, text, html, key: `backup-run:${row.id}` });
    await pool.query('UPDATE backup_runs SET notified = $2 WHERE id = $1', [row.id, detail]);
    row.notified = detail;
  }
  return row;
}

// The state the Super Admin dashboard shows: newest successful backup and restore test, newest failure.
export async function backupHealth(pool, now = new Date()) {
  const latest = async (kind, status) => (await pool.query(`SELECT * FROM backup_runs WHERE kind = $1 ${status ? 'AND status = $2' : ''} ORDER BY id DESC LIMIT 1`, status ? [kind, status] : [kind])).rows[0] ?? null;
  const [lastBackup, lastOk, lastRestore, lastRestoreOk] = [await latest('backup'), await latest('backup', 'success'), await latest('restore_test'), await latest('restore_test', 'success')];
  const ageHours = lastOk ? Math.round((now - new Date(lastOk.created_at)) / 36e5) : null;
  const alerts = [];
  if (lastBackup?.status === 'failed') alerts.push(`The last backup failed (${lastBackup.created_at.toISOString().slice(0, 16).replace('T', ' ')} UTC)${lastBackup.detail ? `: ${lastBackup.detail}` : ''}.`);
  if (lastRestore?.status === 'failed') alerts.push('The last restore test failed.');
  if (ageHours === null) alerts.push('No successful backup has been reported yet.');
  else if (ageHours > BACKUP_STALE_HOURS) alerts.push(`The newest successful backup is ${ageHours} hours old.`);
  const { rows: recent } = await pool.query('SELECT * FROM backup_runs ORDER BY id DESC LIMIT 15');
  return { lastBackup, lastOk, lastRestore, lastRestoreOk, ageHours, alerts, recent };
}

// Background job: no successful backup for 36 hours (e.g. the job did not run at all) alerts once a day.
export async function remindBackups(pool, config, { now = new Date() } = {}) {
  const h = await backupHealth(pool, now);
  if (h.ageHours === null || h.ageHours <= BACKUP_STALE_HOURS) return null;
  const day = now.toISOString().slice(0, 10);
  const { rows: [seen] } = await pool.query("SELECT 1 FROM audit_log WHERE action = 'backup.stale_alert' AND details->>'day' = $1", [day]);
  if (seen) return null;
  const { detail } = await emailSuperAdmins(pool, config, {
    subject: `ACTION NEEDED: no successful Skyfly backup for ${h.ageHours} hours`,
    text: `The newest successful database backup is ${h.ageHours} hours old. Check the "Database backup" job in GitHub Actions.\n`,
    html: `<p>The newest successful database backup is <strong>${h.ageHours} hours</strong> old. Check the "Database backup" job in GitHub Actions.</p>`,
    key: `backup-stale:${day}`,
  });
  await pool.query("INSERT INTO audit_log (action, entity_type, details) VALUES ('backup.stale_alert', 'backup', $1)", [JSON.stringify({ day, ageHours: h.ageHours, email: detail })]);
  return { day, detail };
}
