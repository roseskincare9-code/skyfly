// Automatic launch checks: public registration opens in production only when the settings it needs actually
// WORK, not merely exist. Checked at start-up and every 6 hours (and on demand by a Super Admin):
//  - email: one real send through the configured provider to the provider's official test inbox
//    (Resend: delivered@resend.dev, which accepts the email and delivers it to nobody);
//  - bot check: Cloudflare is asked to verify a dummy token with the secret key. "invalid-input-response"
//    means the key is valid; "invalid-input-secret" means it is not.
// Results are kept per settings fingerprint (a hash; never the keys), so changing a key needs a new pass.
import { createHash } from 'node:crypto';
import { sendEmail } from './emailProviders.js';
import { savePlatformSetting } from './tenancy.js';

const state = { email: null, captcha: null };
const fp = (...parts) => createHash('sha256').update(parts.map(String).join('|')).digest('hex').slice(0, 16);
export const emailFingerprint = (config) => (config.notifyEmail ? fp(config.notifyEmail.provider, config.notifyEmail.fromEmail, config.notifyEmail.apiKey) : null);
export const captchaFingerprint = (config) => (config.turnstile ? fp(config.turnstile.siteKey, config.turnstile.secretKey) : null);
const TEST_INBOX = { resend: 'delivered@resend.dev' };

export async function checkEmail(config) {
  const p = config.notifyEmail;
  if (!p) return { ok: false, detail: 'Not configured (SKYFLY_NOTIFY_PROVIDER, SKYFLY_NOTIFY_API_KEY, SKYFLY_NOTIFY_FROM).' };
  const to = TEST_INBOX[p.provider];
  if (!to) return { ok: true, detail: `${p.provider}: no official test inbox, so only the settings were checked.` };
  try {
    await sendEmail({ provider: p.provider, apiKey: p.apiKey, baseOverride: config.emailApiBase || null }, {
      to, fromEmail: p.fromEmail, fromName: p.fromName || 'Skyfly', replyTo: null, headers: {},
      idempotencyKey: `launch-check:${emailFingerprint(config)}:${new Date().toISOString().slice(0, 13)}`,
      subject: 'Skyfly sender check', text: 'Automatic check that Skyfly can send email. Sent to the provider test inbox; no person receives it.',
      html: '<p>Automatic check that Skyfly can send email. Sent to the provider test inbox; no person receives it.</p>',
    });
    return { ok: true, detail: `Sent from ${p.fromEmail} through ${p.provider} (accepted by the provider).` };
  } catch (err) {
    return { ok: false, detail: `The provider refused the test email: ${String(err.message).slice(0, 200)}` };
  }
}

export async function checkCaptcha(config) {
  if (!config.turnstile) return { ok: false, detail: 'Not configured (TURNSTILE_SITE_KEY, TURNSTILE_SECRET_KEY).' };
  try {
    const res = await fetch(config.turnstileVerifyUrl || 'https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ secret: config.turnstile.secretKey, response: 'skyfly-launch-check' }), signal: AbortSignal.timeout(8000),
    });
    const json = await res.json().catch(() => ({}));
    const codes = json['error-codes'] ?? [];
    if (codes.some((c) => /secret/.test(c))) return { ok: false, detail: `Cloudflare rejected the secret key (${codes.join(', ')}).` };
    if (json.success === true) return { ok: false, detail: 'Cloudflare accepted a dummy token: this is a test key, not a production key.' };
    return { ok: true, detail: 'Cloudflare accepted the secret key (the dummy token was refused, as it should be).' };
  } catch (err) {
    return { ok: false, detail: `Could not reach Cloudflare: ${String(err.message).slice(0, 160)}` };
  }
}

export async function runLaunchChecks(pool, config, log = console) {
  const at = new Date().toISOString();
  const [email, captcha] = await Promise.all([checkEmail(config), checkCaptcha(config)]);
  state.email = { ...email, at, fingerprint: emailFingerprint(config) };
  state.captcha = { ...captcha, at, fingerprint: captchaFingerprint(config) };
  await savePlatformSetting(pool, 'launch_checks', state).catch(() => {});
  log.log(`Launch checks: email ${email.ok ? 'PASS' : 'FAIL'} (${email.detail}) | bot check ${captcha.ok ? 'PASS' : 'FAIL'} (${captcha.detail})`);
  return { ...state };
}

// For signup gating: a check counts only if it passed for the settings in use now.
export const launchState = () => ({ ...state });
export function launchBlockers(config) {
  const out = [];
  const passed = (s, f) => s && s.ok && s.fingerprint === f;
  if (config.notifyEmail && !passed(state.email, emailFingerprint(config))) out.push(`email sender check ${state.email ? `failed: ${state.email.detail}` : 'not run yet'}`);
  if (config.turnstile && !passed(state.captcha, captchaFingerprint(config))) out.push(`bot check ${state.captcha ? `failed: ${state.captcha.detail}` : 'not run yet'}`);
  return out;
}

let timer = null;
export function startLaunchChecks(pool, config, log = console) {
  const first = runLaunchChecks(pool, config, log).catch((err) => log.error('Launch checks failed:', err.message));
  clearInterval(timer);
  timer = setInterval(() => runLaunchChecks(pool, config, log).catch(() => {}), 6 * 3600e3);
  timer.unref?.();
  return first;
}
