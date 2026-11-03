// Cloudflare Turnstile: a privacy-friendly bot check on registration. The browser widget puts a one-time
// token in the form (cf-turnstile-response); the server checks it with Cloudflare before creating anything.
// Keys: TURNSTILE_SITE_KEY (public, shown in the page) and TURNSTILE_SECRET_KEY (server only).
export const TURNSTILE_ORIGIN = 'https://challenges.cloudflare.com';
const VERIFY = `${TURNSTILE_ORIGIN}/turnstile/v0/siteverify`;

// Returns { ok, codes }. Fails closed: no token, a network error or an unexpected answer all mean "no".
export async function verifyTurnstile(config, token, ip) {
  if (!config.turnstile) return { ok: false, codes: ['not-configured'] };
  const t = String(token ?? '');
  if (!t || t.length > 2048) return { ok: false, codes: ['missing-input-response'] };
  try {
    const res = await fetch(config.turnstileVerifyUrl || VERIFY, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ secret: config.turnstile.secretKey, response: t, ...(ip ? { remoteip: ip } : {}) }),
      signal: AbortSignal.timeout(8000),
    });
    const json = await res.json().catch(() => ({}));
    return { ok: json.success === true, codes: json['error-codes'] ?? [] };
  } catch (err) {
    return { ok: false, codes: [`network: ${err.message}`] };
  }
}

// Adds Turnstile's origin to the page's Content-Security-Policy (script and frame), on the signup page only.
export function allowTurnstile(res) {
  const csp = String(res.getHeader('Content-Security-Policy') || '');
  if (!csp) return;
  let out = csp.replace(/(^|;)(\s*script-src)\s+([^;]*)/, `$1$2 $3 ${TURNSTILE_ORIGIN}`);
  out = /(^|;)\s*frame-src\s/.test(out) ? out.replace(/(^|;)(\s*frame-src)\s+([^;]*)/, `$1$2 $3 ${TURNSTILE_ORIGIN}`) : `${out};frame-src 'self' ${TURNSTILE_ORIGIN}`;
  res.setHeader('Content-Security-Policy', out);
}
