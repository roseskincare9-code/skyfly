// The platform's own domains (e.g. getskyfly.com): expiry, renewal and reminders.
// Two sources are always kept apart and labelled on the dashboard:
//  - verified: read from the public domain registry over RDAP (registered, registrar, expiry date,
//    status codes). A renewal is verified only when the registry's expiry date moves later.
//  - entered by the owner: registrar, registrar link, expiry date, "auto-renew is on". The registry
//    never shows whether auto-renew is switched on; only the registrar's account does.
// No payment details or registrar passwords are stored.
import { sendEmail } from './emailProviders.js';
import { E2E_EMAIL_LIKE } from './setup.js';

export const REMINDER_DAYS = [30, 14, 7];
const CHECK_EVERY_MS = 12 * 3600 * 1000;
const DAY = 864e5;
// RDAP servers for common endings; others are found in IANA's list.
const RDAP_BASES = { com: 'https://rdap.verisign.com/com/v1/', net: 'https://rdap.verisign.com/net/v1/' };
const IANA_BOOTSTRAP = 'https://data.iana.org/rdap/dns.json';
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const DOMAIN_COLUMNS = `id, domain, registrar_name, registrar_url, manual_expires_on, manual_auto_renew, manual_auto_renew_confirmed_on, notes,
  rdap_checked_at, rdap_error, registered, registry_registrar, registry_expires_at, registry_statuses, previous_expires_at, renewal_verified_at, updated_at`;

// Only an https link to the registrar is kept (it becomes the "Open registrar" button).
export function normalizeRegistrarUrl(input) {
  const s = String(input ?? '').trim();
  if (!s) return { value: null };
  let u;
  try { u = new URL(s); } catch { return { error: 'The registrar link must be a full address starting with https://' }; }
  if (u.protocol !== 'https:' || u.username || u.password) return { error: 'The registrar link must start with https:// (no sign-in details in the link).' };
  return { value: u.href.slice(0, 500) };
}

async function rdapBase(tld, fetchImpl) {
  if (RDAP_BASES[tld]) return RDAP_BASES[tld];
  const res = await fetchImpl(IANA_BOOTSTRAP, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`IANA's registry list answered HTTP ${res.status}`);
  const entry = (await res.json()).services?.find(([tlds]) => tlds.includes(tld));
  if (!entry) throw new Error(`no public registry lookup (RDAP) exists for .${tld}`);
  return entry[1][0].endsWith('/') ? entry[1][0] : `${entry[1][0]}/`;
}

// Reads the domain from its registry. { registered: false } when the registry has no such domain.
export async function rdapLookup(domain, { fetchImpl = fetch } = {}) {
  const base = await rdapBase(domain.split('.').pop(), fetchImpl);
  const res = await fetchImpl(`${base}domain/${encodeURIComponent(domain)}`, { headers: { Accept: 'application/rdap+json' }, signal: AbortSignal.timeout(15000) });
  if (res.status === 404) return { registered: false, statuses: [] };
  if (!res.ok) throw new Error(`the registry answered HTTP ${res.status}`);
  const j = await res.json();
  const event = (action) => j.events?.find((e) => e.eventAction === action)?.eventDate ?? null;
  const registrar = j.entities?.find((e) => e.roles?.includes('registrar'));
  const name = registrar?.vcardArray?.[1]?.find((v) => v[0] === 'fn')?.[3] ?? null;
  return { registered: true, registrar: name, expiresAt: event('expiration'), registeredAt: event('registration'), statuses: Array.isArray(j.status) ? j.status : [] };
}

// Checks the registry and stores the result. A later expiry date than before = renewal verified.
export async function refreshDomain(pool, id, { fetchImpl = fetch } = {}) {
  const { rows: [d] } = await pool.query('SELECT domain, registry_expires_at FROM platform_domains WHERE id = $1', [id]);
  if (!d) return null;
  try {
    const r = await rdapLookup(d.domain, { fetchImpl });
    const before = d.registry_expires_at ? new Date(d.registry_expires_at).getTime() : null;
    const after = r.expiresAt ? new Date(r.expiresAt).getTime() : null;
    const renewed = before !== null && after !== null && after > before;
    await pool.query(
      `UPDATE platform_domains SET rdap_checked_at = now(), rdap_error = NULL, registered = $2, registry_registrar = $3, registry_expires_at = $4,
              registry_statuses = $5, previous_expires_at = CASE WHEN $6 THEN registry_expires_at ELSE previous_expires_at END,
              renewal_verified_at = CASE WHEN $6 THEN now() ELSE renewal_verified_at END, updated_at = now()
        WHERE id = $1`,
      [id, r.registered, r.registrar ?? null, r.expiresAt ?? null, r.statuses, renewed]);
    return { ok: true, ...r, renewed };
  } catch (err) {
    const message = String(err.name === 'TimeoutError' ? 'the registry did not answer in 15 seconds' : err.message).slice(0, 200);
    await pool.query('UPDATE platform_domains SET rdap_checked_at = now(), rdap_error = $2, updated_at = now() WHERE id = $1', [id, message]);
    return { ok: false, error: message };
  }
}

const asDate = (v) => (v ? new Date(v instanceof Date ? v : /^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T00:00:00Z` : v) : null);
const DANGER = /redemption|pending delete|pendingdelete|hold|renew prohibited|renewprohibited/i;

// What the dashboard shows for one domain: the expiry (and where it came from), days left, and the
// renewal status with each statement labelled "verified" or "entered by you".
export function domainSummary(d, now = new Date()) {
  const verified = Boolean(d.registered && d.registry_expires_at);
  const expires = verified ? asDate(d.registry_expires_at) : asDate(d.manual_expires_on);
  const source = verified ? 'verified' : expires ? 'manual' : null;
  const daysLeft = expires ? Math.floor((expires.getTime() - now.getTime()) / DAY) : null;
  const statuses = d.registry_statuses ?? [];
  const facts = [];
  if (d.registered === false) facts.push({ kind: 'verified', text: 'Not registered: the registry has no record of this domain. It has not been bought yet (or the purchase is still being processed).' });
  if (verified) facts.push({ kind: 'verified', text: `Registered${d.registry_registrar ? ` with ${d.registry_registrar}` : ''}; the registry's expiry date is ${expires.toISOString().slice(0, 10)}.` });
  if (d.renewal_verified_at) facts.push({ kind: 'verified', text: `Renewal confirmed: the registry's expiry date moved from ${asDate(d.previous_expires_at)?.toISOString().slice(0, 10) ?? '?'} to ${expires?.toISOString().slice(0, 10)} (seen ${asDate(d.renewal_verified_at).toISOString().slice(0, 10)}).` });
  if (statuses.length) facts.push({ kind: 'verified', text: `Registry status: ${statuses.join(', ')}.` });
  if (d.manual_auto_renew === true) facts.push({ kind: 'manual', text: `Auto-renew is on at the registrar${d.manual_auto_renew_confirmed_on ? ` (you last checked on ${d.manual_auto_renew_confirmed_on})` : ''}. The registry does not show this; it is confirmed only when the expiry date moves after renewal.` });
  if (d.manual_auto_renew === false) facts.push({ kind: 'manual', text: 'Auto-renew is off at the registrar. Renew by hand before the expiry date.' });
  if (!verified && d.manual_expires_on) facts.push({ kind: 'manual', text: `Expiry date ${d.manual_expires_on} (typed in, not read from the registry).` });
  if (d.rdap_error) facts.push({ kind: 'error', text: `Last registry check failed: ${d.rdap_error}.` });
  if (!d.rdap_checked_at) facts.push({ kind: 'unknown', text: 'The registry has not been checked yet.' });

  let level = 'ok';
  let headline = expires ? `Expires in ${daysLeft} day${daysLeft === 1 ? '' : 's'}` : 'Expiry date unknown';
  if (daysLeft !== null && daysLeft < 0) { level = 'act'; headline = `Expired ${-daysLeft} day${daysLeft === -1 ? '' : 's'} ago`; }
  else if (daysLeft !== null && daysLeft <= 7) level = 'act';
  else if (daysLeft !== null && daysLeft <= 30) level = 'watch';
  if (statuses.some((s) => DANGER.test(s))) level = 'act';
  if (d.registered === false) { level = 'watch'; headline = 'Not registered yet'; }
  if (!expires && d.registered !== false) level = 'watch';
  // Auto-renew that has not happened: the registry's expiry date has not moved although the date is close.
  // Registrars usually renew well before expiry, so this means the renewal (often the payment) failed.
  if (verified && daysLeft !== null && daysLeft <= 14) {
    const why = d.manual_auto_renew === true ? 'Auto-renew is on, but the registry still shows the old expiry date: the renewal has not happened' : 'Auto-renew is not confirmed as on';
    facts.push({ kind: 'error', text: `${why}. Check auto-renew and the payment method at the registrar, or renew by hand now.` });
    level = 'act';
  }
  return { expiresOn: expires ? expires.toISOString().slice(0, 10) : null, source, daysLeft, level, headline, facts };
}

export async function listDomains(pool) {
  const { rows } = await pool.query(`SELECT ${DOMAIN_COLUMNS} FROM platform_domains ORDER BY domain`);
  return rows;
}

// Sends the 30-, 14- and 7-day reminders (each at most once per expiry date) to the platform admins.
// Without Skyfly's email sender the reminder is recorded as not sent and shown in Platform admin only.
export async function remindDomains(pool, config, { now = new Date() } = {}) {
  const results = [];
  for (const d of await listDomains(pool)) {
    const s = domainSummary(d, now);
    if (s.daysLeft === null || d.registered === false) continue;
    const due = [...REMINDER_DAYS].sort((a, b) => a - b).find((t) => s.daysLeft <= t);
    if (due === undefined) continue;
    const { rows: [r] } = await pool.query(
      `INSERT INTO platform_domain_reminders (domain_id, days_before, expires_on, status, detail) VALUES ($1, $2, $3, 'not_sent', 'Sending')
       ON CONFLICT (domain_id, days_before, expires_on) DO NOTHING RETURNING id`, [d.id, due, s.expiresOn]);
    if (!r) continue;
    let status = 'not_sent';
    let detail;
    const p = config.notifyEmail;
    const { rows: admins } = await pool.query('SELECT email FROM users WHERE is_platform_admin AND email NOT LIKE $1 ORDER BY id', [E2E_EMAIL_LIKE]);
    if (!p?.apiKey || !p.fromEmail) detail = 'No Skyfly email sender is configured (SKYFLY_NOTIFY_* on Render), so this reminder is shown in Platform admin only.';
    else if (!admins.length) detail = 'No platform admin email address to send to.';
    else {
      const when = s.daysLeft < 0 ? `expired on ${s.expiresOn}` : `expires on ${s.expiresOn} (in ${s.daysLeft} day${s.daysLeft === 1 ? '' : 's'})`;
      const renewalStuck = s.source === 'verified' && s.daysLeft <= 14 && d.manual_auto_renew === true;
      const subject = `${d.domain} ${s.daysLeft < 0 ? 'has expired' : `expires in ${s.daysLeft} days`}: ${renewalStuck ? 'auto-renew has not renewed it' : 'check its renewal'}`;
      const source = s.source === 'verified' ? 'read from the domain registry' : 'entered by you in Skyfly (not read from the registry)';
      const text = `${d.domain} ${when}. Expiry date ${source}.\n\nIf auto-renew is on at the registrar, check that the payment method there is valid. `
        + 'Skyfly confirms the renewal once the registry shows a later expiry date.\n'
        + `${d.registrar_url ? `\nRegistrar: ${d.registrar_url}\n` : ''}${config.publicBaseUrl ? `Domain details: ${config.publicBaseUrl}/admin/domains\n` : ''}`;
      const html = `<p><strong>${esc(d.domain)}</strong> ${esc(when)}. Expiry date ${esc(source)}.</p>`
        + '<p>If auto-renew is on at the registrar, check that the payment method there is valid. Skyfly confirms the renewal once the registry shows a later expiry date.</p>'
        + `${d.registrar_url ? `<p><a href="${esc(d.registrar_url)}">Open the registrar</a></p>` : ''}${config.publicBaseUrl ? `<p><a href="${esc(config.publicBaseUrl)}/admin/domains">Domain details in Skyfly</a></p>` : ''}`;
      const sent = [];
      const failed = [];
      for (const a of admins) {
        try {
          await sendEmail({ provider: p.provider, apiKey: p.apiKey, baseOverride: config.emailApiBase || null }, {
            to: a.email, fromEmail: p.fromEmail, fromName: p.fromName, subject, text, html, idempotencyKey: `domain-reminder:${r.id}:${a.email}`,
          });
          sent.push(a.email);
        } catch (err) { failed.push(`${a.email}: ${String(err.message).slice(0, 120)}`); }
      }
      if (sent.length) status = 'sent';
      detail = [sent.length ? `Accepted by the email provider for ${sent.join(', ')}` : null, failed.length ? `Not sent: ${failed.join('; ')}` : null].filter(Boolean).join('. ');
    }
    await pool.query('UPDATE platform_domain_reminders SET status = $2, detail = $3 WHERE id = $1', [r.id, status, detail]);
    results.push({ domain: d.domain, daysBefore: due, status, detail });
  }
  return results;
}

// Background job (runs with the email worker, one server at a time): checks each domain's registry
// at most every 12 hours, then sends any reminder that is due.
export async function runDomainJobs(pool, config, { fetchImpl = fetch, now = new Date() } = {}) {
  const { rows } = await pool.query(
    'SELECT id FROM platform_domains WHERE rdap_checked_at IS NULL OR rdap_checked_at < $1', [new Date(now.getTime() - CHECK_EVERY_MS)]);
  for (const { id } of rows) await refreshDomain(pool, id, { fetchImpl });
  return { checked: rows.length, reminders: await remindDomains(pool, config, { now }) };
}
