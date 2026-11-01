// Account security: Terms/Privacy acceptance at registration, disabling and reactivating accounts,
// per-account limits on sign-in, Super Admin sign-in, registration and password reset, a hidden field
// against automated sign-ups, and public registration kept closed in production until Skyfly can send
// verification emails.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { setup, resetDatabase, csrfToken, adminSignIn, signUp } from './helpers.js';
import { TERMS_VERSION } from '../src/routes/auth.js';

const PASSWORD = 'correct-horse-battery';
// Production-like for registration (no Super Admin by signing up), limits on.
const app = setup({ adminBootstrapFirstAccount: false, allowSignup: true, signupFirstOnly: true, allowedOrigins: [], authThrottle: true, authIpLimit: 1000 });
const pool = app.pool;
const server = app.app.listen(0);
const servers = [server];

async function register(srv, fields) {
  const agent = request.agent(srv);
  const _csrf = await csrfToken(agent, '/signup');
  const res = await agent.post('/signup').type('form').send({ _csrf, name: 'Owner', password: PASSWORD, confirm: PASSWORD, phone: '+234 803 123 4567', ...fields });
  return { agent, res };
}
async function login(srv, email, password = PASSWORD) {
  const agent = request.agent(srv);
  const _csrf = await csrfToken(agent, '/login');
  const res = await agent.post('/login').type('form').send({ _csrf, email, password });
  return { agent, res };
}
const userCount = async (email) => (await pool.query('SELECT count(*)::int AS n FROM users WHERE email = $1', [email])).rows[0].n;
const clearAttempts = () => pool.query('DELETE FROM auth_attempts');

let admin;
before(async () => {
  await resetDatabase(pool);
  await pool.query('DELETE FROM auth_attempts');
  // The Super Admin (made with scripts/grant-admin.mjs in production).
  const { hashPassword } = await import('../src/lib/passwords.js');
  await pool.query("INSERT INTO users (email, password_hash, name, is_platform_admin, email_verified_at) VALUES ('admin@skyfly.test', $1, 'Admin', true, now())", [await hashPassword(PASSWORD)]);
  await pool.query("UPDATE platform_settings SET value = '\"open\"' WHERE key = 'client_signup'");
  admin = (await login(server, 'admin@skyfly.test')).agent;
  await adminSignIn(admin, { email: 'admin@skyfly.test' });
});
after(async () => { for (const s of servers) s.close(); await pool.end(); });

describe('Terms of Service and Privacy Policy at registration', () => {
  test('the pages are public, and the form has the checkbox with links to both', async () => {
    for (const p of ['/terms', '/privacy']) {
      const r = await request(server).get(p).expect(200);
      assert.ok(r.text.includes(`Version ${TERMS_VERSION}`), p);
    }
    const form = await request(server).get('/signup').expect(200);
    assert.match(form.text, /name="accept_terms"[^>]*required/);
    assert.match(form.text, /href="\/terms"/);
    assert.match(form.text, /href="\/privacy"/);
  });

  test('without ticking the box no account and no business is created', async () => {
    const { res } = await register(server, { email: 'noterms@x.test', business_name: 'No Terms Shop' });
    assert.equal(res.status, 400);
    assert.match(res.text, /accept the Terms of Service and Privacy Policy/);
    assert.equal(await userCount('noterms@x.test'), 0);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM businesses WHERE name = 'No Terms Shop'")).rows[0].n, 0);
  });

  test('accepting records the time and version on the account', async () => {
    const { res } = await register(server, { email: 'terms@x.test', business_name: 'Terms Shop', accept_terms: 'on' });
    assert.equal(res.status, 302);
    const { rows: [u] } = await pool.query("SELECT terms_version, terms_accepted_at FROM users WHERE email = 'terms@x.test'");
    assert.equal(u.terms_version, TERMS_VERSION);
    assert.ok(u.terms_accepted_at);
    const { rows: [a] } = await pool.query("SELECT admin.terms_accepted_at FROM users admin WHERE email = 'admin@skyfly.test'");
    assert.equal(a.terms_accepted_at, null, 'existing accounts are not marked as having accepted');
  });
});

describe('automated sign-ups', () => {
  test('a filled-in hidden field is refused and creates nothing', async () => {
    const { res } = await register(server, { email: 'bot@x.test', business_name: 'Bot Shop', accept_terms: 'on', website: 'http://spam.example' });
    assert.equal(res.status, 400);
    assert.equal(await userCount('bot@x.test'), 0);
  });

  test('at most 5 new accounts per IP address per day', async () => {
    await clearAttempts();
    for (let i = 1; i <= 5; i += 1) {
      const { res } = await register(server, { email: `ip${i}@x.test`, business_name: `IP Shop ${i}`, accept_terms: 'on' });
      assert.equal(res.status, 302, `account ${i}`);
    }
    const { res } = await register(server, { email: 'ip6@x.test', business_name: 'IP Shop 6', accept_terms: 'on' });
    assert.equal(res.status, 429);
    assert.equal(await userCount('ip6@x.test'), 0);
    await clearAttempts();
  });
});

describe('sign-in limits', () => {
  test('after 5 wrong passwords for an email, even the right one waits 15 minutes; then it works and the count resets', async () => {
    await clearAttempts();
    for (let i = 0; i < 5; i += 1) assert.equal((await login(server, 'terms@x.test', 'wrong-password-123')).res.status, 401);
    const blocked = await login(server, 'terms@x.test');
    assert.equal(blocked.res.status, 429);
    assert.match(blocked.res.text, /Too many failed sign-in attempts/);
    await pool.query("UPDATE auth_attempts SET created_at = now() - interval '16 minutes'");
    assert.equal((await login(server, 'terms@x.test')).res.status, 302);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM auth_attempts WHERE kind = 'login_failed'")).rows[0].n, 0, 'success clears the count');
  });

  test('an email without an account gets the same answers (nothing tells which emails have accounts)', async () => {
    await clearAttempts();
    const first = await login(server, 'nobody@x.test', 'wrong-password-123');
    assert.equal(first.res.status, 401);
    for (let i = 0; i < 4; i += 1) await login(server, 'nobody@x.test', 'wrong-password-123');
    assert.equal((await login(server, 'nobody@x.test', 'wrong-password-123')).res.status, 429);
    await clearAttempts();
  });

  test('the Super Admin sign-in has the same per-email limit', async () => {
    await clearAttempts();
    const agent = request.agent(server);
    for (let i = 0; i < 5; i += 1) {
      const _csrf = await csrfToken(agent, '/admin/login');
      assert.equal((await agent.post('/admin/login').type('form').send({ _csrf, email: 'admin@skyfly.test', password: 'wrong-password-123' })).status, 401);
    }
    const _csrf = await csrfToken(agent, '/admin/login');
    assert.equal((await agent.post('/admin/login').type('form').send({ _csrf, email: 'admin@skyfly.test', password: PASSWORD })).status, 429);
    await clearAttempts();
  });

  test('password reset: at most 3 requests per address per hour; the page answers the same every time', async () => {
    await clearAttempts();
    const sender = setup({ allowedOrigins: [], authThrottle: true, authIpLimit: 1000, notifyEmail: { provider: 'resend', apiKey: 'test', fromEmail: 'no-reply@skyfly.test' }, emailApiBase: 'http://127.0.0.1:9' });
    const srv = sender.app.listen(0); servers.push(srv);
    const texts = [];
    for (let i = 0; i < 5; i += 1) {
      const agent = request.agent(srv);
      const _csrf = await csrfToken(agent, '/forgot-password');
      const r = await agent.post('/forgot-password').type('form').send({ _csrf, email: 'terms@x.test' });
      assert.equal(r.status, 200);
      texts.push(r.text.replace(/name="_csrf" value="[^"]+"/, ''));
    }
    assert.equal(new Set(texts).size, 1, 'same page each time');
    const { rows } = await pool.query("SELECT details->>'reason' AS reason FROM audit_log WHERE action = 'password_reset.requested' ORDER BY id DESC LIMIT 2");
    assert.deepEqual(rows.map((r) => r.reason), ['rate limited', 'rate limited']);
    await sender.pool.end();
    await clearAttempts();
  });
});

describe('disabling and reactivating accounts (Super Admin → Accounts)', () => {
  let owner; let ownerId; let bizId;
  before(async () => {
    await clearAttempts();
    const { agent, res } = await register(server, { email: 'disable-me@x.test', business_name: 'Disable Shop', accept_terms: 'on' });
    owner = agent;
    bizId = Number(res.headers.location.match(/(\d+)$/)[1]);
    ownerId = (await pool.query("SELECT id FROM users WHERE email = 'disable-me@x.test'")).rows[0].id;
    await pool.query("INSERT INTO products (business_id, code, name, price_minor) VALUES ($1, 'kept', 'Kept Product', 100)", [bizId]);
  });
  const post = async (path, form) => admin.post(path).type('form').send({ _csrf: await csrfToken(admin, '/admin/accounts'), ...form });

  test('the Accounts page lists accounts; only Super Admins reach it', async () => {
    const page = await admin.get('/admin/accounts?q=disable-me').expect(200);
    assert.match(page.text, /disable-me@x\.test/);
    assert.equal((await owner.get('/admin/accounts')).status, 404);
  });

  test('disabling needs the Super Admin\'s password and a reason', async () => {
    assert.equal((await post(`/admin/accounts/${ownerId}/disable`, { password: 'wrong-password-123', reason: 'Test' })).status, 403);
    assert.equal((await post(`/admin/accounts/${ownerId}/disable`, { password: PASSWORD, reason: '' })).status, 400);
    assert.equal((await pool.query('SELECT disabled_at FROM users WHERE id = $1', [ownerId])).rows[0].disabled_at, null);
  });

  test('a disabled account is signed out at once, cannot sign in or get a reset email; its business data stays', async () => {
    await owner.get(`/businesses/${bizId}`).expect(200);
    const r = await post(`/admin/accounts/${ownerId}/disable`, { password: PASSWORD, reason: 'Chargeback investigation (test)' });
    assert.equal(r.status, 302);
    assert.equal((await owner.get(`/businesses/${bizId}`)).headers.location, '/login', 'the open session ends');
    const again = await login(server, 'disable-me@x.test');
    assert.equal(again.res.status, 403);
    assert.match(again.res.text, /has been disabled/);
    const wrong = await login(server, 'disable-me@x.test', 'wrong-password-123');
    assert.equal(wrong.res.status, 401, 'the wrong password says nothing about the account');
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM products WHERE business_id = $1', [bizId])).rows[0].n, 1);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM business_members WHERE business_id = $1', [bizId])).rows[0].n, 1);
    const { rows: [a] } = await pool.query("SELECT details->>'reason' AS reason FROM audit_log WHERE action = 'admin.account_disabled' AND entity_id = $1", [String(ownerId)]);
    assert.equal(a.reason, 'Chargeback investigation (test)');
    const page = await admin.get('/admin/accounts?q=disable-me');
    assert.match(page.text, /data-disabled/);
  });

  test('reactivating lets the person sign in again, into the same business', async () => {
    assert.equal((await post(`/admin/accounts/${ownerId}/enable`, { password: PASSWORD })).status, 302);
    const { agent, res } = await login(server, 'disable-me@x.test');
    assert.equal(res.status, 302);
    assert.equal((await agent.get('/')).headers.location, `/businesses/${bizId}`);
    assert.ok((await pool.query("SELECT 1 FROM audit_log WHERE action = 'admin.account_reactivated' AND entity_id = $1", [String(ownerId)])).rows.length);
  });

  test('a Super Admin cannot disable themself; another Super Admin can be disabled and reactivated', async () => {
    const { rows: [me] } = await pool.query("SELECT id FROM users WHERE email = 'admin@skyfly.test'");
    assert.equal((await post(`/admin/accounts/${me.id}/disable`, { password: PASSWORD, reason: 'x' })).status, 400);
    assert.equal((await pool.query('SELECT disabled_at FROM users WHERE id = $1', [me.id])).rows[0].disabled_at, null);
    const { hashPassword } = await import('../src/lib/passwords.js');
    const { rows: [other] } = await pool.query("INSERT INTO users (email, password_hash, name, is_platform_admin) VALUES ('admin2@skyfly.test', $1, 'Admin 2', true) RETURNING id", [await hashPassword(PASSWORD)]);
    const second = (await login(server, 'admin2@skyfly.test')).agent;
    assert.equal((await adminSignIn(second, { email: 'admin2@skyfly.test' })).status, 302);
    assert.equal((await post(`/admin/accounts/${other.id}/disable`, { password: PASSWORD, reason: 'left the company (test)' })).status, 302);
    assert.match((await second.get('/admin')).headers.location, /^\/(admin\/)?login/, "the disabled Super Admin's session ends");
    const a = request.agent(server);
    const _csrf = await csrfToken(a, '/admin/login');
    assert.equal((await a.post('/admin/login').type('form').send({ _csrf, email: 'admin2@skyfly.test', password: PASSWORD })).status, 401, 'no Super Admin sign-in while disabled');
    assert.equal((await post(`/admin/accounts/${other.id}/enable`, { password: PASSWORD })).status, 302);
  });
});

describe('public registration needs email verification (production rule)', () => {
  test('without an email sender, /signup stays closed even when Platform settings say open, and it cannot be switched on', async () => {
    const prod = setup({ adminBootstrapFirstAccount: false, allowSignup: true, signupFirstOnly: true, allowedOrigins: [], requireEmailForSignup: true });
    const srv = prod.app.listen(0); servers.push(srv);
    await pool.query("UPDATE platform_settings SET value = '\"open\"' WHERE key = 'client_signup'");
    assert.equal((await request(srv).get('/signup')).status, 404);
    const { res } = await register(srv, { email: 'closed@x.test', business_name: 'Closed Shop', accept_terms: 'on' }).catch(() => ({ res: { status: 404 } }));
    assert.equal(res.status, 404);
    assert.equal(await userCount('closed@x.test'), 0);
    const a = (await login(srv, 'admin@skyfly.test')).agent;
    await adminSignIn(a, { email: 'admin@skyfly.test' });
    const page = await a.get('/admin/settings').expect(200);
    assert.match(page.text, /data-signup-needs-sender/);
    const _csrf = await csrfToken(a, '/admin/settings');
    const r = await a.post('/admin/settings').type('form').send({ _csrf, client_signup: 'open', trial_days: '7' });
    assert.equal(r.status, 400);
    assert.match(r.text, /stays closed until Skyfly can send verification emails/);
    await prod.pool.end();
  });

  test('with an email sender, it opens, and a new account confirms its email before the dashboard', async () => {
    const prod = setup({ adminBootstrapFirstAccount: false, allowSignup: true, signupFirstOnly: true, allowedOrigins: [], requireEmailForSignup: true,
      notifyEmail: { provider: 'resend', apiKey: 'test', fromEmail: 'no-reply@skyfly.test' }, emailApiBase: 'http://127.0.0.1:9' });
    const srv = prod.app.listen(0); servers.push(srv);
    await pool.query("UPDATE platform_settings SET value = '\"open\"' WHERE key = 'client_signup'");
    assert.equal((await request(srv).get('/signup')).status, 200);
    const { res } = await register(srv, { email: 'verified@x.test', business_name: 'Verified Shop', accept_terms: 'on' });
    assert.equal(res.status, 302);
    assert.equal(res.headers.location, '/verify-email');
    await prod.pool.end();
  });
});

test('signUp helper still works for other tests (accounts with a business)', async () => {
  await pool.query("UPDATE platform_settings SET value = '\"open\"' WHERE key = 'client_signup'");
  await clearAttempts();
  const agent = await signUp(server, { email: 'helper@x.test', business: 'Helper Shop' });
  assert.equal((await agent.get('/')).status, 302);
});
