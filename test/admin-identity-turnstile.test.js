// A separate Super Admin identity by invitation (an admin-only account that belongs to no business), and
// Cloudflare Turnstile on registration (verified on the server; in production registration needs it).
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { setup, resetDatabase, csrfToken, adminSignIn } from './helpers.js';

const PASSWORD = 'correct-horse-battery';
const realFetch = globalThis.fetch;
const verifyCalls = [];
// Cloudflare's siteverify, simulated: only the token "pass-token" is human.
globalThis.fetch = async (url, opts) => {
  if (String(url).includes('/turnstile/v0/siteverify')) {
    const body = new URLSearchParams(String(opts.body));
    verifyCalls.push(Object.fromEntries(body));
    return new Response(JSON.stringify(body.get('response') === 'pass-token' ? { success: true } : { success: false, 'error-codes': ['invalid-input-response'] }), { status: 200 });
  }
  return realFetch(url, opts);
};

const turnstile = { siteKey: '1x00000000000000000000AA', secretKey: 'test-secret-not-real' };
const app = setup({ adminBootstrapFirstAccount: false, allowSignup: true, signupFirstOnly: true, allowedOrigins: [], turnstile, authIpLimit: 1000 });
const pool = app.pool;
const server = app.app.listen(0);
const servers = [server];
let admin;

before(async () => {
  await resetDatabase(pool);
  const { hashPassword } = await import('../src/lib/passwords.js');
  await pool.query("INSERT INTO users (email, password_hash, name, is_platform_admin, email_verified_at) VALUES ('founder@skyfly.test', $1, 'Founder', true, now())", [await hashPassword(PASSWORD)]);
  await pool.query("UPDATE platform_settings SET value = '\"open\"' WHERE key = 'client_signup'");
  admin = request.agent(server);
  const c0 = await csrfToken(admin, '/login');
  await admin.post('/login').type('form').send({ _csrf: c0, email: 'founder@skyfly.test', password: PASSWORD }).expect(302);
  await adminSignIn(admin, { email: 'founder@skyfly.test' });
});
after(async () => { for (const s of servers) s.close(); globalThis.fetch = realFetch; await pool.end(); });

async function register(fields) {
  const agent = request.agent(server);
  const page = await agent.get('/signup');
  const _csrf = page.text.match(/name="_csrf" value="([^"]+)"/)[1];
  return { page, res: await agent.post('/signup').type('form').send({ _csrf, name: 'Bot Test', business_name: 'Bot Shop', phone: '+234 803 111 2222', password: PASSWORD, confirm: PASSWORD, accept_terms: 'on', ...fields }) };
}
const accounts = async (email) => (await pool.query('SELECT count(*)::int AS n FROM users WHERE email = $1', [email])).rows[0].n;

describe('Cloudflare Turnstile on registration', () => {
  test('the form shows the widget, and only the signup page allows Cloudflare\'s script and frame', async () => {
    const { page } = await register({ email: 'probe@x.test', 'cf-turnstile-response': 'pass-token' });
    assert.match(page.text, /class="cf-turnstile"[^>]*data-sitekey="1x00000000000000000000AA"/);
    assert.match(page.text, /challenges\.cloudflare\.com\/turnstile\/v0\/api\.js/);
    const csp = page.headers['content-security-policy'];
    assert.match(csp, /script-src[^;]*https:\/\/challenges\.cloudflare\.com/);
    assert.match(csp, /frame-src[^;]*https:\/\/challenges\.cloudflare\.com/);
    assert.doesNotMatch((await request(server).get('/login')).headers['content-security-policy'], /challenges\.cloudflare\.com/);
  });

  test('without the check, or with a failed one, nothing is created; the secret is sent only to Cloudflare', async () => {
    for (const token of [undefined, '', 'bot-token']) {
      const email = `bot-${token ?? 'none'}@x.test`;
      const { res } = await register({ email, ...(token === undefined ? {} : { 'cf-turnstile-response': token }) });
      assert.equal(res.status, 400, String(token));
      assert.match(res.text, /complete the security check/);
      assert.equal(await accounts(email), 0);
    }
    assert.ok(verifyCalls.every((c) => c.secret === 'test-secret-not-real'));
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM audit_log WHERE action = 'signup.blocked' AND details->>'reason' = 'turnstile'")).rows[0].n, 3);
  });

  test('a passed check registers normally: own business, Owner role, no Super Admin', async () => {
    const { res } = await register({ email: 'human@x.test', business_name: 'Human Shop', 'cf-turnstile-response': 'pass-token' });
    assert.equal(res.status, 302);
    const { rows: [u] } = await pool.query("SELECT u.is_platform_admin, m.role, b.name FROM users u JOIN business_members m ON m.user_id = u.id JOIN businesses b ON b.id = m.business_id WHERE u.email = 'human@x.test'");
    assert.deepEqual([u.is_platform_admin, u.role, u.name], [false, 'owner', 'Human Shop']);
  });

  test('in production, registration stays closed without Turnstile even with an email sender', async () => {
    const prod = setup({ adminBootstrapFirstAccount: false, allowSignup: true, signupFirstOnly: true, allowedOrigins: [], requireEmailForSignup: true, requireCaptchaForSignup: true,
      notifyEmail: { provider: 'resend', apiKey: 'k', fromEmail: 'no-reply@skyfly.test' } });
    const srv = prod.app.listen(0); servers.push(srv);
    assert.equal((await request(srv).get('/signup')).status, 404);
    assert.doesNotMatch((await request(srv).get('/login')).text, /data-signup-cta/);
    await prod.pool.end();
  });
});

describe('a separate Super Admin identity (by invitation)', () => {
  let link;
  const post = async (path, form) => { const _csrf = await csrfToken(admin, '/admin/admins'); return admin.post(path).type('form').send({ _csrf, ...form }); };

  test('creating an invitation needs the Super Admin\'s password and an email without an account', async () => {
    assert.equal((await post('/admin/admins/invite', { email: 'ops@skyfly.test', password: 'wrong-password-123' })).status, 403);
    assert.equal((await post('/admin/admins/invite', { email: 'human@x.test', password: PASSWORD })).status, 409, 'existing account: use "grant" instead');
    const r = await post('/admin/admins/invite', { email: 'ops@skyfly.test', password: PASSWORD });
    assert.equal(r.status, 200);
    link = new URL(r.text.match(/value="(http[^"]+\/admin-invite\/[A-Za-z0-9_-]+)"/)[1]).pathname;
    const { rows: [i] } = await pool.query("SELECT token_hash FROM admin_invites WHERE email = 'ops@skyfly.test'");
    assert.ok(i.token_hash && !link.includes(i.token_hash), 'only the hash is stored');
  });

  test('business owners cannot create Super Admin invitations', async () => {
    const owner = request.agent(server);
    const c1 = await csrfToken(owner, '/login');
    await owner.post('/login').type('form').send({ _csrf: c1, email: 'human@x.test', password: PASSWORD }).expect(302);
    const c2 = await csrfToken(owner, '/login');
    assert.equal((await owner.post('/admin/admins/invite').type('form').send({ _csrf: c2, email: 'evil@x.test', password: PASSWORD })).status, 404);
    assert.equal((await owner.get(link)).status, 409, 'a signed-in user is asked to sign out first');
  });

  test('accepting creates an admin-only account (no business) that signs in to /admin; the link then stops working', async () => {
    const guest = request.agent(server);
    const page = await guest.get(link).expect(200);
    assert.match(page.text, /ops@skyfly\.test/);
    const _csrf = page.text.match(/name="_csrf" value="([^"]+)"/)[1];
    assert.equal((await guest.post(link).type('form').send({ _csrf, name: 'Ops', password: 'short', confirm: 'short' })).status, 400);
    const ok = await guest.post(link).type('form').send({ _csrf, name: 'Ops Admin', password: 'long-enough-password-1', confirm: 'long-enough-password-1' });
    assert.equal(ok.headers.location, '/admin/login?created=1');
    const { rows: [u] } = await pool.query("SELECT id, is_platform_admin, (SELECT count(*)::int FROM business_members WHERE user_id = users.id) AS memberships FROM users WHERE email = 'ops@skyfly.test'");
    assert.deepEqual([u.is_platform_admin, u.memberships], [true, 0]);
    assert.equal((await request(server).get(link)).status, 410);
    const ops = request.agent(server);
    assert.equal((await adminSignIn(ops, { email: 'ops@skyfly.test', password: 'long-enough-password-1' })).status, 302);
    const list = await ops.get('/admin').expect(200);
    assert.match(list.text, /Human Shop/);
    assert.ok((await pool.query("SELECT 1 FROM audit_log WHERE action = 'admin.access_granted' AND details->>'via' = 'invitation'")).rows.length);
  });

  test('the founder\'s old account can then lose Super Admin, removed by the new admin (business ownership is untouched)', async () => {
    const ops = request.agent(server);
    await adminSignIn(ops, { email: 'ops@skyfly.test', password: 'long-enough-password-1' });
    const { rows: [f] } = await pool.query("SELECT id FROM users WHERE email = 'founder@skyfly.test'");
    const _csrf = await csrfToken(ops, '/admin/admins');
    assert.equal((await ops.post(`/admin/admins/${f.id}/revoke`).type('form').send({ _csrf, password: 'long-enough-password-1' })).status, 302);
    assert.equal((await pool.query('SELECT is_platform_admin FROM users WHERE id = $1', [f.id])).rows[0].is_platform_admin, false);
  });

  test('a cancelled invitation link stops working', async () => {
    const ops = request.agent(server);
    await adminSignIn(ops, { email: 'ops@skyfly.test', password: 'long-enough-password-1' });
    let _csrf = await csrfToken(ops, '/admin/admins');
    const r = await ops.post('/admin/admins/invite').type('form').send({ _csrf, email: 'second@skyfly.test', password: 'long-enough-password-1' });
    const second = new URL(r.text.match(/value="(http[^"]+\/admin-invite\/[A-Za-z0-9_-]+)"/)[1]).pathname;
    const { rows: [i] } = await pool.query("SELECT id FROM admin_invites WHERE email = 'second@skyfly.test'");
    _csrf = await csrfToken(ops, '/admin/admins');
    await ops.post(`/admin/admins/invites/${i.id}/revoke`).type('form').send({ _csrf }).expect(302);
    assert.equal((await request(server).get(second)).status, 410);
  });
});
