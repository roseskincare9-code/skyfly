// The Super Admin is a separate, server-checked role: nobody gets it by signing up first (in
// production) or by sending a role in a form; it needs its own sign-in, which expires; support access
// to a client's workspace needs that sign-in and is logged; and only a signed-in Super Admin, with
// their password, can grant or remove it.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { setup, resetDatabase, csrfToken, adminSignIn } from './helpers.js';
import { ADMIN_SESSION_HOURS } from '../src/lib/adminSession.js';

// As configured in production (see the config test below): no admin by signing up first.
const prod = setup({ adminBootstrapFirstAccount: false, allowedOrigins: [] });
const dev = setup({ allowedOrigins: [] });
const pool = prod.pool;
const prodServer = prod.app.listen(0);
const devServer = dev.app.listen(0);
const PASSWORD = 'correct-horse-battery';

async function signUpOn(server, email, extra = {}) {
  const agent = request.agent(server);
  const _csrf = await csrfToken(agent, '/signup');
  const res = await agent.post('/signup').type('form').send({ _csrf, name: email.split('@')[0], email, password: PASSWORD, confirm: PASSWORD, business_name: `${email.split('@')[0]} Shop`, ...extra });
  assert.equal(res.status, 302, `sign-up ${email}`);
  return agent;
}
async function login(server, email) {
  const agent = request.agent(server);
  const _csrf = await csrfToken(agent, '/login');
  await agent.post('/login').type('form').send({ _csrf, email, password: PASSWORD }).expect(302);
  return agent;
}
const isAdmin = async (email) => (await pool.query('SELECT is_platform_admin FROM users WHERE email = $1', [email])).rows[0]?.is_platform_admin;

before(() => resetDatabase(pool));
after(async () => { prodServer.close(); devServer.close(); await prod.pool.end(); await dev.pool.end(); });

describe('becoming a Super Admin', () => {
  test('the production configuration never makes the first account a Super Admin', async () => {
    const { loadConfig } = await import('../src/config.js');
    const saved = { ...process.env };
    Object.assign(process.env, { NODE_ENV: 'production', SESSION_SECRET: 'x'.repeat(40), PUBLIC_BASE_URL: 'https://skyfly.test', DATABASE_URL: 'postgres://x@localhost/x' });
    try {
      assert.equal(loadConfig().adminBootstrapFirstAccount, false);
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
    }
  });

  test('in production the very first account is an ordinary account, even when the form says it is an admin', async () => {
    const first = await signUpOn(prodServer, 'first@new.test', { is_platform_admin: 'true', role: 'admin', isAdmin: '1' });
    assert.equal(await isAdmin('first@new.test'), false);
    assert.equal((await first.get('/admin')).status, 404);
    assert.equal((await first.get('/admin/login')).status, 404);
    // Its credentials do not open the Super Admin sign-in either.
    const other = request.agent(prodServer);
    const _csrf = await csrfToken(other, '/admin/login');
    const res = await other.post('/admin/login').type('form').send({ _csrf, email: 'first@new.test', password: PASSWORD });
    assert.equal(res.status, 401);
    assert.equal((await other.get('/admin')).status, 302, 'still not signed in to Super Admin');
  });

  test('the recovery script is the way to make the first Super Admin on a new database', async () => {
    const { execFile } = await import('node:child_process');
    const out = await new Promise((resolve, reject) => execFile(process.execPath, ['scripts/grant-admin.mjs', 'first@new.test'],
      { env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL } }, (err, stdout, stderr) => (err ? reject(new Error(stderr)) : resolve(stdout))));
    assert.match(out, /first@new\.test is now a Super Admin/);
    assert.equal(await isAdmin('first@new.test'), true);
  });
});

describe('the Super Admin sign-in', () => {
  let admin;
  let bizId;
  before(async () => {
    const owner = await signUpOn(devServer, 'owner@client.test');
    await pool.query("UPDATE users SET is_platform_admin = false WHERE email = 'owner@client.test'");
    await pool.query("UPDATE platform_settings SET value = '\"open\"' WHERE key = 'client_signup'");
    const _csrf = await csrfToken(owner, '/?all=1');
    const res = await owner.post('/businesses').type('form').send({ _csrf, name: 'Client Shop' }).expect(302);
    bizId = Number(res.headers.location.match(/businesses\/(\d+)/)[1]);
    admin = await login(devServer, 'first@new.test');
  });

  test('signed out, the Super Admin area opens its own sign-in page (not the business login)', async () => {
    const res = await request(devServer).get('/admin/capacity');
    assert.equal(res.status, 302);
    assert.equal(res.headers.location, '/admin/login?next=%2Fadmin%2Fcapacity');
    assert.equal((await request(devServer).get('/businesses/1')).headers.location, '/login');
  });

  test('a normal sign-in is not enough: admin pages and support access ask for the Super Admin sign-in', async () => {
    assert.equal((await admin.get('/admin')).headers.location, '/admin/login?next=%2Fadmin');
    const ws = await admin.get(`/businesses/${bizId}/orders`);
    assert.equal(ws.status, 302);
    assert.equal(ws.headers.location, `/admin/login?next=${encodeURIComponent(`/businesses/${bizId}/orders`)}`);
    const _csrf = await csrfToken(admin, '/?all=1');
    assert.equal((await admin.post(`/admin/businesses/${bizId}/lock`).type('form').send({ _csrf })).status, 403);
    assert.equal((await pool.query('SELECT subscription_status FROM businesses WHERE id = $1', [bizId])).rows[0].subscription_status, 'trial');
  });

  test('another person\'s password, or a wrong one, does not pass', async () => {
    const _csrf = await csrfToken(admin, '/admin/login');
    assert.equal((await admin.post('/admin/login').type('form').send({ _csrf, email: 'first@new.test', password: 'wrong-password-123' })).status, 401);
    assert.equal((await admin.post('/admin/login').type('form').send({ _csrf, email: 'owner@client.test', password: PASSWORD })).status, 401, "a client's credentials");
    assert.equal((await admin.get('/admin')).status, 302, 'still not signed in to Super Admin');
  });

  test('after the Super Admin sign-in, support access works and is logged', async () => {
    const res = await adminSignIn(admin, { email: 'first@new.test' });
    assert.equal(res.status, 302);
    await admin.get('/admin').expect(200);
    await admin.get(`/businesses/${bizId}/orders`).expect(200);
    const { rows } = await pool.query("SELECT action FROM audit_log WHERE action IN ('admin.signed_in', 'admin.workspace_opened') ORDER BY id");
    assert.deepEqual(rows.map((r) => r.action), ['admin.signed_in', 'admin.workspace_opened']);
  });

  test(`the Super Admin sign-in ends after ${ADMIN_SESSION_HOURS} hours`, async () => {
    await pool.query(`UPDATE user_sessions SET sess = jsonb_set(sess::jsonb, '{adminVerifiedAt}', to_jsonb((extract(epoch FROM now() - interval '${ADMIN_SESSION_HOURS} hours 1 minute') * 1000)::bigint))::json
                       WHERE sess::jsonb ? 'adminVerifiedAt'`);
    assert.equal((await admin.get('/admin')).status, 302);
    assert.equal((await admin.get(`/businesses/${bizId}`)).status, 302);
    await adminSignIn(admin, { email: 'first@new.test' });
    await admin.get('/admin').expect(200);
  });

  test('the client\'s owner never reaches platform administration, and sees no platform menu', async () => {
    const owner = await login(devServer, 'owner@client.test');
    assert.equal((await owner.get('/admin')).status, 404);
    assert.equal((await owner.get('/admin/admins')).status, 404);
    assert.equal((await owner.get('/admin/login')).status, 404);
    const home = await owner.get(`/businesses/${bizId}`).expect(200);
    assert.doesNotMatch(home.text, /href="\/admin"/);
  });

  test('granting and removing Super Admin access needs the acting Super Admin\'s password; the last one stays', async () => {
    let _csrf = await csrfToken(admin, '/admin/admins');
    assert.equal((await admin.post('/admin/admins').type('form').send({ _csrf, email: 'owner@client.test', password: 'wrong-password-123' })).status, 403);
    assert.equal(await isAdmin('owner@client.test'), false);
    await admin.post('/admin/admins').type('form').send({ _csrf, email: 'owner@client.test', password: PASSWORD }).expect(302);
    assert.equal(await isAdmin('owner@client.test'), true);
    const { rows: [me] } = await pool.query("SELECT id FROM users WHERE email = 'first@new.test'");
    const { rows: [them] } = await pool.query("SELECT id FROM users WHERE email = 'owner@client.test'");
    _csrf = await csrfToken(admin, '/admin/admins');
    assert.equal((await admin.post(`/admin/admins/${me.id}/revoke`).type('form').send({ _csrf, password: PASSWORD })).status, 400, 'not yourself');
    await admin.post(`/admin/admins/${them.id}/revoke`).type('form').send({ _csrf, password: PASSWORD }).expect(302);
    assert.equal(await isAdmin('owner@client.test'), false);
    const { rows } = await pool.query("SELECT action FROM audit_log WHERE action LIKE 'admin.access_%' ORDER BY id");
    assert.deepEqual(rows.map((r) => r.action).slice(-2), ['admin.access_granted', 'admin.access_revoked']);
  });

  test('removing someone\'s Super Admin access ends their admin access at once', async () => {
    let _csrf = await csrfToken(admin, '/admin/admins');
    await admin.post('/admin/admins').type('form').send({ _csrf, email: 'owner@client.test', password: PASSWORD }).expect(302);
    const second = await login(devServer, 'owner@client.test');
    await adminSignIn(second, { email: 'owner@client.test' });
    await second.get('/admin').expect(200);
    const { rows: [them] } = await pool.query("SELECT id FROM users WHERE email = 'owner@client.test'");
    _csrf = await csrfToken(admin, '/admin/admins');
    await admin.post(`/admin/admins/${them.id}/revoke`).type('form').send({ _csrf, password: PASSWORD }).expect(302);
    assert.equal((await second.get('/admin')).status, 404);
  });
});
