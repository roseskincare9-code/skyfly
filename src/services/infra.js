// Super Admin infrastructure manager: what the platform pays for, when each renewal is due, and alerts.
// Everything here is entered by a Super Admin (marked "entered by you"). Nothing renews automatically from
// Skyfly; the provider's own billing does that. No credentials are stored.
import { sendEmail } from './emailProviders.js';
import { E2E_EMAIL_LIKE } from './setup.js';

export const CATEGORIES = { hosting: 'Hosting', database: 'Database', domain: 'Domain & DNS', email: 'Email', monitoring: 'Monitoring', security: 'Security', other: 'Other' };
export const FREQUENCIES = { monthly: 'Monthly', yearly: 'Yearly', one_time: 'One-time', usage: 'Usage-based', free: 'Free' };
export const PAYMENT_STATUSES = { paid: 'Paid', due: 'Due', overdue: 'Overdue', failed: 'Payment failed', free: 'Free', unknown: 'Unknown' };
// Alert thresholds in days before the renewal date (0 = the date itself).
export const THRESHOLDS = [30, 14, 7, 3, 0];
const DAY = 864e5;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// The date that matters for a service: the next payment, else the expiry.
export const renewalDate = (s) => s.next_payment_on || s.expires_on || null;
const dateStr = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : d ? String(d).slice(0, 10) : null);

export function serviceSummary(s, now = new Date()) {
  const date = dateStr(renewalDate(s));
  const today = Date.parse(now.toISOString().slice(0, 10));
  const daysLeft = date ? Math.round((Date.parse(date) - today) / DAY) : null;
  const alerts = [];
  if (s.payment_status === 'failed') alerts.push({ level: 'act', text: 'Payment failed: update the payment method at the provider.' });
  if (s.payment_status === 'overdue') alerts.push({ level: 'act', text: 'Payment overdue.' });
  if (daysLeft !== null && daysLeft < 0) alerts.push({ level: 'act', text: `Renewal date passed ${-daysLeft} day(s) ago (${date}).` });
  else if (daysLeft !== null && daysLeft <= 30 && s.billing_frequency !== 'free') {
    alerts.push({ level: daysLeft <= 7 ? 'act' : 'watch', text: `${daysLeft === 0 ? 'Renews today' : `Renews in ${daysLeft} day(s)`} (${date})${s.auto_renew === true ? ', auto-renew on at the provider' : s.auto_renew === false ? ', auto-renew OFF: renew by hand' : ', auto-renew not confirmed'}.` });
  }
  if (s.billing_frequency === 'free' && daysLeft !== null && daysLeft <= 30) alerts.push({ level: daysLeft <= 7 ? 'act' : 'watch', text: `Free plan ends ${daysLeft < 0 ? `${-daysLeft} day(s) ago` : `in ${daysLeft} day(s)`} (${date}).` });
  const level = alerts.some((a) => a.level === 'act') ? 'act' : alerts.length ? 'watch' : 'ok';
  return { date, daysLeft, alerts, level };
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

// Background job: each threshold (30/14/7/3/0 days, plus failed payment) alerts once per renewal date.
export async function remindInfra(pool, config, { now = new Date() } = {}) {
  const results = [];
  for (const s of await listServices(pool)) {
    const sum = serviceSummary(s, now);
    const keys = [];
    if (s.payment_status === 'failed') keys.push(['failed', dateStr(s.updated_at) ?? sum.date ?? dateStr(now)]);
    // The tightest step reached: 30, 14, 7, 3 or 0 days before (one reminder per step and date).
    const step = sum.daysLeft !== null && sum.daysLeft >= 0 ? [...THRESHOLDS].sort((a, b) => a - b).find((d) => sum.daysLeft <= d) : undefined;
    if (step !== undefined) keys.push([`${step}d`, sum.date]);
    for (const [threshold, due] of keys) {
      const { rows: [r] } = await pool.query(
        `INSERT INTO infra_service_reminders (service_id, threshold, due_on, status, detail) VALUES ($1, $2, $3, 'not_sent', 'Sending')
         ON CONFLICT (service_id, threshold, due_on) DO NOTHING RETURNING id`, [s.id, threshold, due]);
      if (!r) continue;
      const p = config.notifyEmail;
      const { rows: admins } = await pool.query('SELECT email FROM users WHERE is_platform_admin AND disabled_at IS NULL AND email NOT LIKE $1 ORDER BY id', [E2E_EMAIL_LIKE]);
      let status = 'not_sent'; let detail;
      if (!p?.apiKey || !p.fromEmail) detail = 'No email sender configured: shown in Platform admin → Infrastructure only.';
      else if (!admins.length) detail = 'No Super Admin email address.';
      else {
        const what = threshold === 'failed' ? 'payment failed' : sum.daysLeft === 0 ? 'renews today' : `renews in ${sum.daysLeft} days (${sum.date})`;
        const subject = `${s.name} (${s.provider}): ${what}`;
        const text = `${s.name} — ${s.provider}${s.plan ? `, ${s.plan}` : ''}: ${what}.\n${sum.alerts.map((a) => `- ${a.text}`).join('\n')}\n${s.manage_url ? `\nManage: ${s.manage_url}\n` : ''}${config.publicBaseUrl ? `Infrastructure in Skyfly: ${config.publicBaseUrl}/admin/infrastructure\n` : ''}`;
        const html = `<p><strong>${esc(s.name)}</strong> — ${esc(s.provider)}: ${esc(what)}.</p><ul>${sum.alerts.map((a) => `<li>${esc(a.text)}</li>`).join('')}</ul>${s.manage_url ? `<p><a href="${esc(s.manage_url)}">Manage at the provider</a></p>` : ''}`;
        const sent = [];
        for (const a of admins) {
          try {
            await sendEmail({ provider: p.provider, apiKey: p.apiKey, baseOverride: config.emailApiBase || null }, { to: a.email, fromEmail: p.fromEmail, fromName: p.fromName, subject, text, html, idempotencyKey: `infra-reminder:${r.id}:${a.email}` });
            sent.push(a.email);
          } catch (err) { detail = `Not sent: ${String(err.message).slice(0, 120)}`; }
        }
        if (sent.length) { status = 'sent'; detail = `Sent to ${sent.length} Super Admin(s)`; }
      }
      await pool.query('UPDATE infra_service_reminders SET status = $2, detail = $3 WHERE id = $1', [r.id, status, detail]);
      results.push({ service: s.name, threshold, status });
    }
  }
  return results;
}
