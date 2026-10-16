// Sends one email through the business's own provider account. A send counts as done only
// when the provider confirms it (an id or HTTP 202); everything else is an error with the
// provider's reason. Errors say whether retrying may help (network, rate limit, 5xx).
const TIMEOUT_MS = 20000;

export const PROVIDERS = {
  resend: { label: 'Resend', base: 'https://api.resend.com', keyHelp: 'Resend → API Keys (starts with re_)', keyRe: /^re_[A-Za-z0-9_]{10,}$/ },
  brevo: { label: 'Brevo (Sendinblue)', base: 'https://api.brevo.com', keyHelp: 'Brevo → SMTP & API → API Keys (starts with xkeysib-)', keyRe: /^xkeysib-[A-Za-z0-9-]{20,}$/ },
  sendgrid: { label: 'SendGrid', base: 'https://api.sendgrid.com', keyHelp: 'SendGrid → Settings → API Keys (starts with SG.)', keyRe: /^SG\.[A-Za-z0-9_.-]{20,}$/ },
};

export class SendError extends Error {
  constructor(message, { retryable = false, status = null } = {}) { super(message); this.retryable = retryable; this.status = status; }
}

function requestFor(provider, msg, apiKey) {
  const from = msg.fromName ? `${msg.fromName.replace(/[<>"]/g, '')} <${msg.fromEmail}>` : msg.fromEmail;
  if (provider === 'resend') {
    return {
      path: '/emails',
      headers: { Authorization: `Bearer ${apiKey}`, 'Idempotency-Key': msg.idempotencyKey.slice(0, 256) },
      body: { from, to: [msg.to], subject: msg.subject, html: msg.html, text: msg.text, ...(msg.replyTo ? { reply_to: msg.replyTo } : {}), headers: msg.headers },
      id: (json) => json?.id,
    };
  }
  if (provider === 'brevo') {
    return {
      path: '/v3/smtp/email',
      headers: { 'api-key': apiKey },
      body: {
        sender: { email: msg.fromEmail, ...(msg.fromName ? { name: msg.fromName } : {}) }, to: [{ email: msg.to }], subject: msg.subject,
        htmlContent: msg.html, textContent: msg.text, ...(msg.replyTo ? { replyTo: { email: msg.replyTo } } : {}), headers: msg.headers,
      },
      id: (json) => json?.messageId,
    };
  }
  return {
    path: '/v3/mail/send',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: {
      personalizations: [{ to: [{ email: msg.to }] }], from: { email: msg.fromEmail, ...(msg.fromName ? { name: msg.fromName } : {}) },
      ...(msg.replyTo ? { reply_to: { email: msg.replyTo } } : {}), subject: msg.subject,
      content: [{ type: 'text/plain', value: msg.text }, { type: 'text/html', value: msg.html }], headers: msg.headers,
    },
    id: (json, res) => res.headers.get('x-message-id') || (res.status === 202 ? 'accepted' : null),
  };
}

// baseOverride is for tests and local development only (never set in production).
export async function sendEmail({ provider, apiKey, baseOverride = null }, msg) {
  const spec = PROVIDERS[provider];
  if (!spec) throw new SendError(`Unknown email provider "${provider}".`);
  const req = requestFor(provider, msg, apiKey);
  let res;
  try {
    res = await fetch(`${baseOverride || spec.base}${req.path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...req.headers },
      body: JSON.stringify(req.body), signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new SendError(`${spec.label} could not be reached (${err.name === 'TimeoutError' ? 'no answer in 20 seconds' : 'network error'}).`, { retryable: true });
  }
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  if (!res.ok) {
    const detail = json?.message || json?.error?.message || json?.errors?.[0]?.message || json?.error || text.slice(0, 160);
    throw new SendError(`${spec.label} refused the email (HTTP ${res.status}${detail ? `: ${String(detail).slice(0, 200)}` : ''}).`,
      { retryable: res.status === 429 || res.status >= 500, status: res.status });
  }
  const id = req.id(json, res);
  if (!id) throw new SendError(`${spec.label} answered without confirming the email.`, { retryable: false, status: res.status });
  return { id: String(id).slice(0, 200) };
}

// ---- Templates: owner-written subject and text with a few placeholders.
export const PLACEHOLDERS = {
  customer_name: 'Customer\'s full name',
  first_name: 'Customer\'s first name',
  order_reference: 'Order reference, e.g. LR-AB12CD3',
  order_items: 'What was ordered, e.g. "Package 3 x2"',
  order_total: 'Order total with currency',
  order_date: 'Order date',
  business_name: 'Your business name',
};

export function unknownPlaceholders(text) {
  return [...String(text).matchAll(/\{\{\s*([a-z_]+)\s*\}\}/g)].map((m) => m[1]).filter((k) => !(k in PLACEHOLDERS));
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fill = (text, values) => String(text).replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (m, k) => values[k] ?? '');

// Builds subject, text and HTML. Every automated email carries an unsubscribe link; marketing
// emails also carry the sender's postal address when one is set.
export function renderEmail({ template, values, business, settings, unsubscribeUrl, purpose }) {
  const subject = fill(template.subject, values).replace(/[\r\n]+/g, ' ').slice(0, 200);
  const body = fill(template.body, values).trim();
  const footerLines = [
    `${business.name}${purpose === 'marketing' && settings.postal_address ? ` · ${settings.postal_address}` : ''}`,
    unsubscribeUrl ? `Don't want these emails? Unsubscribe: ${unsubscribeUrl}` : null,
  ].filter(Boolean);
  const text = `${body}\n\n--\n${footerLines.join('\n')}\n`;
  const paragraphs = body.split(/\n{2,}/).map((p) => `<p style="margin:0 0 14px">${escapeHtml(p).replace(/\n/g, '<br>')}</p>`).join('');
  const footer = `<p style="margin:24px 0 0;color:#7A6871;font-size:12px">${escapeHtml(footerLines[0])}${unsubscribeUrl ? `<br><a href="${escapeHtml(unsubscribeUrl)}" style="color:#7A6871">Unsubscribe</a>` : ''}</p>`;
  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#FFF8F5;font-family:Arial,Helvetica,sans-serif;color:#2B2229;font-size:15px;line-height:1.55"><div style="max-width:560px;margin:0 auto;background:#fff;border-radius:12px;padding:24px">${paragraphs}${footer}</div></body></html>`;
  return { subject, text, html };
}
