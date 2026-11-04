// Automatic launch checks: registration opens in production only when the email sender really sends (to the
// provider's test inbox) and Cloudflare accepts the Turnstile secret, for the settings in use now.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { setup, resetDatabase } from './helpers.js';
import { checkEmail, checkCaptcha, runLaunchChecks, launchBlockers } from '../src/services/launchChecks.js';

const realFetch = globalThis.fetch;
const sent = [];
let resendOk = true;
let secretOk = true;
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  if (u.startsWith('https://api.resend.com/')) {
    sent.push(JSON.parse(opts.body));
    return resendOk ? new Response('{"id":"x"}', { status: 200 }) : new Response('{"message":"The getskyfly.com domain is not verified"}', { status: 403 });
  }
  if (u.includes('/turnstile/v0/siteverify')) {
    return new Response(JSON.stringify({ success: false, 'error-codes': [secretOk ? 'invalid-input-response' : 'invalid-input-secret'] }), { status: 200 });
  }
  return realFetch(url, opts);
};
const prodLike = {
  adminBootstrapFirstAccount: false, allowSignup: true, signupFirstOnly: true, allowedOrigins: [],
  requireEmailForSignup: true, requireCaptchaForSignup: true, requireLaunchChecks: true,
  notifyEmail: { provider: 'resend', apiKey: 're_test_not_real_000', fromEmail: 'no-reply@getskyfly.test', fromName: 'Skyfly' },
  turnstile: { siteKey: 'site-key', secretKey: 'secret-key' },
};
const app = setup(prodLike);
const pool = app.pool;
const server = app.app.listen(0);
before(async () => {
  await resetDatabase(pool);
  await pool.query("INSERT INTO users (email, password_hash, name, is_platform_admin) VALUES ('admin@skyfly.test', 'x', 'Admin', true)"); // not a first account
  await pool.query("UPDATE platform_settings SET value = '\"open\"' WHERE key = 'client_signup'");
});
after(async () => { server.close(); globalThis.fetch = realFetch; await pool.end(); });

test('the email check sends only to the provider test inbox; a refused sender fails', async () => {
  sent.length = 0;
  assert.equal((await checkEmail(app.config)).ok, true);
  assert.deepEqual(sent.map((m) => m.to), [['delivered@resend.dev']]);
  resendOk = false;
  const r = await checkEmail(app.config);
  assert.equal(r.ok, false);
  assert.match(r.detail, /not verified/);
  resendOk = true;
  assert.equal((await checkEmail({})).ok, false, 'missing settings fail');
});

test('the bot check passes with a valid secret, fails with a bad one or a test key', async () => {
  assert.equal((await checkCaptcha(app.config)).ok, true);
  secretOk = false;
  assert.equal((await checkCaptcha(app.config)).ok, false);
  secretOk = true;
});

test('registration (and the Sign Up button) stay closed until both checks pass for the current settings', async () => {
  // Before any check has run.
  assert.match(launchBlockers(app.config).join(' '), /not run yet/);
  assert.equal((await request(server).get('/signup')).status, 404);
  resendOk = false;
  await runLaunchChecks(pool, app.config, { log() {} });
  assert.equal((await request(server).get('/signup')).status, 404, 'email check failed');
  assert.doesNotMatch((await request(server).get('/login')).text, /data-signup-cta/);
  resendOk = true;
  await runLaunchChecks(pool, app.config, { log() {} });
  assert.equal((await request(server).get('/signup')).status, 200, 'both pass: open');
  assert.match((await request(server).get('/login')).text, /data-signup-cta/);
  // A changed key needs a new pass.
  const changed = { ...app.config, notifyEmail: { ...app.config.notifyEmail, apiKey: 're_another_key_0000' } };
  assert.match(launchBlockers(changed).join(' '), /email sender check/);
  const { rows: [s] } = await pool.query("SELECT value FROM platform_settings WHERE key = 'launch_checks'");
  assert.ok(s.value.email.ok && s.value.captcha.ok);
  assert.doesNotMatch(JSON.stringify(s.value), /re_test_not_real|secret-key/, 'no keys stored');
});

test('a closed /signup says the true reason: "opens soon" while only the set-up is missing, "by invitation" when chosen', async () => {
  const pending = setup({ ...prodLike, notifyEmail: null, turnstile: null });
  const srv = pending.app.listen(0);
  try {
    await pool.query("UPDATE platform_settings SET value = '\"open\"' WHERE key = 'client_signup'");
    let r = await request(srv).get('/signup');
    assert.equal(r.status, 404);
    assert.match(r.text, /data-reason="setup"/);
    assert.match(r.text, /registration opens soon/i);
    assert.doesNotMatch(r.text, /by invitation/);
    await pool.query("UPDATE platform_settings SET value = '\"invite_only\"' WHERE key = 'client_signup'");
    r = await request(srv).get('/signup');
    assert.match(r.text, /data-reason="invite_only"/);
    assert.match(r.text, /Registration is by invitation/);
  } finally { srv.close(); await pending.pool.end(); await pool.query("UPDATE platform_settings SET value = '\"open\"' WHERE key = 'client_signup'"); }
});
