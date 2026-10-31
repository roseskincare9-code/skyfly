// One public registration page for every new business owner: /signup creates the account and its own
// business (a trial), links them, and opens that business's dashboard. Nobody becomes Super Admin this
// way. Three owners (A, B, C) each see only their own business; a separate Super Admin sees all three.
// With Skyfly's email sender set up, the owner confirms their email before the dashboard opens.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { setup, resetDatabase, csrfToken, adminSignIn } from './helpers.js';

const PASSWORD = 'correct-horse-battery';
// As in production: no Super Admin by signing up; client sign-up opened in Platform settings.
const prod = setup({ adminBootstrapFirstAccount: false, allowSignup: true, signupFirstOnly: true, allowedOrigins: [] });
const pool = prod.pool;
const server = prod.app.listen(0);
const owners = {};

async function register(srv, { name, email, business }) {
  const agent = request.agent(srv);
  const page = await agent.get('/signup');
  if (page.status !== 200) return { agent, res: page };
  const _csrf = page.text.match(/name="_csrf" value="([^"]+)"/)[1];
  return { agent, page, res: await agent.post('/signup').type('form').send({ _csrf, name, email, password: PASSWORD, confirm: PASSWORD, business_name: business }) };
}

before(async () => {
  await resetDatabase(pool);
  // The platform owner exists already (made Super Admin with scripts/grant-admin.mjs or by another Super Admin).
  await pool.query("INSERT INTO users (email, password_hash, name, is_platform_admin) VALUES ('admin@skyfly.test', 'x', 'Admin', true)");
});
after(async () => { server.close(); await pool.end(); });

describe('public registration', () => {
  test('closed while Platform settings say "by invitation only"', async () => {
    const { res } = await register(server, { name: 'Early', email: 'early@x.test', business: 'Early Shop' });
    assert.equal(res.status, 404);
  });

  test('when open: each owner registers with name, email, password and business name, and lands in their own new business', async () => {
    await pool.query("UPDATE platform_settings SET value = '\"open\"' WHERE key = 'client_signup'");
    const { page } = await register(server, { name: 'probe', email: 'probe@x.test' }).catch(() => ({}));
    assert.match(page.text, /name="business_name"[^>]*required/, 'the form asks for the business name');
    for (const k of ['A', 'B', 'C']) {
      const { agent, res } = await register(server, { name: `Owner ${k}`, email: `owner-${k.toLowerCase()}@shop-${k.toLowerCase()}.test`, business: `Shop ${k}` });
      assert.equal(res.status, 302, k);
      const { rows: [b] } = await pool.query('SELECT b.id, b.subscription_status, m.role FROM businesses b JOIN business_members m ON m.business_id = b.id JOIN users u ON u.id = m.user_id WHERE u.email = $1', [`owner-${k.toLowerCase()}@shop-${k.toLowerCase()}.test`]);
      assert.equal(res.headers.location, `/businesses/${b.id}`, `${k} goes straight to their business`);
      assert.deepEqual([b.subscription_status, b.role], ['trial', 'owner']);
      owners[k] = { agent, biz: b.id };
    }
    const { rows } = await pool.query("SELECT count(*)::int AS n FROM users WHERE is_platform_admin AND email <> 'admin@skyfly.test'");
    assert.equal(rows[0].n, 0, 'nobody became Super Admin by registering');
  });

  test('the same email cannot register twice', async () => {
    const { res } = await register(server, { name: 'Again', email: 'owner-a@shop-a.test', business: 'Another' });
    assert.equal(res.status, 409);
    assert.match(res.text, /already exists/);
  });
});

describe('three private workspaces', () => {
  test('each owner opens only their own business; every other one answers "not found"; no Super Admin', async () => {
    for (const [k, o] of Object.entries(owners)) {
      await o.agent.get(`/businesses/${o.biz}`).expect(200);
      assert.equal((await o.agent.get('/')).headers.location, `/businesses/${o.biz}`);
      for (const [k2, other] of Object.entries(owners)) {
        if (k2 === k) continue;
        for (const path of ['', '/orders', '/products', '/customers', '/landing-pages', '/pixels', '/team', '/settings', '/analytics', '/integrations', '/orders/export.csv']) {
          assert.equal((await o.agent.get(`/businesses/${other.biz}${path}`)).status, 404, `${k} → ${k2}${path}`);
        }
        const _csrf = await csrfToken(o.agent, `/businesses/${o.biz}`);
        assert.equal((await o.agent.post(`/businesses/${other.biz}/products`).type('form').send({ _csrf, code: 'x', name: 'X', price: '1' })).status, 404);
      }
      assert.equal((await o.agent.get('/admin')).status, 404);
      assert.equal((await o.agent.get('/admin/login')).status, 404);
    }
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM products WHERE code = 'x'")).rows[0].n, 0);
  });

  test('logout, then another owner on the same browser: nothing of the first one remains', async () => {
    const browser = request.agent(server);
    let _csrf = await csrfToken(browser, '/login');
    await browser.post('/login').type('form').send({ _csrf, email: 'owner-a@shop-a.test', password: PASSWORD }).expect(302);
    await browser.get(`/businesses/${owners.A.biz}`).expect(200);
    _csrf = await csrfToken(browser, `/businesses/${owners.A.biz}`);
    await browser.post('/logout').type('form').send({ _csrf }).expect(302);
    assert.equal((await browser.get(`/businesses/${owners.A.biz}`)).headers.location, '/login');
    _csrf = await csrfToken(browser, '/login');
    await browser.post('/login').type('form').send({ _csrf, email: 'owner-c@shop-c.test', password: PASSWORD }).expect(302);
    assert.equal((await browser.get('/')).headers.location, `/businesses/${owners.C.biz}`);
    assert.equal((await browser.get(`/businesses/${owners.A.biz}`)).status, 404);
  });

  test('the Super Admin (separate sign-in) sees all three businesses', async () => {
    const { hashPassword } = await import('../src/lib/passwords.js');
    await pool.query("UPDATE users SET password_hash = $1 WHERE email = 'admin@skyfly.test'", [await hashPassword(PASSWORD)]);
    const admin = request.agent(server);
    await adminSignIn(admin, { email: 'admin@skyfly.test' });
    const list = await admin.get('/admin').expect(200);
    for (const k of ['A', 'B', 'C']) assert.match(list.text, new RegExp(`Shop ${k}`));
    await admin.get(`/businesses/${owners.B.biz}/orders`).expect(200);
  });
});

describe('email confirmation (with Skyfly\'s email sender set up)', () => {
  test('the owner confirms their email before the dashboard opens; the link works once', async () => {
    const mailed = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url, opts) => {
      if (String(url).startsWith('https://api.resend.com/')) { mailed.push(JSON.parse(opts.body)); return new Response('{"id":"m"}', { status: 200 }); }
      return realFetch(url, opts);
    };
    const mail = setup({ adminBootstrapFirstAccount: false, allowSignup: true, signupFirstOnly: true, allowedOrigins: [], notifyEmail: { provider: 'resend', apiKey: 'k', fromEmail: 'hello@skyfly.test', fromName: 'Skyfly' } });
    const srv = mail.app.listen(0);
    try {
      const { agent, res } = await register(srv, { name: 'Owner D', email: 'owner-d@shop-d.test', business: 'Shop D' });
      assert.equal(res.headers.location, '/verify-email');
      const { rows: [b] } = await pool.query("SELECT id FROM businesses WHERE name = 'Shop D'");
      assert.equal((await agent.get(`/businesses/${b.id}`)).headers.location, '/verify-email', 'dashboard waits for the confirmation');
      const _csrf = await csrfToken(agent, '/verify-email');
      assert.equal((await agent.post(`/businesses/${b.id}/products`).type('form').send({ _csrf, code: 'y', name: 'Y', price: '1' })).status, 403);
      assert.equal(mailed.length, 1);
      assert.deepEqual(mailed[0].to, ['owner-d@shop-d.test']);
      const token = mailed[0].text.match(/\/verify-email\/([A-Za-z0-9_-]+)/)[1];
      assert.equal((await agent.get(`/verify-email/${token}`)).headers.location, '/');
      assert.equal((await agent.get('/')).headers.location, `/businesses/${b.id}`);
      await agent.get(`/businesses/${b.id}`).expect(200);
      assert.equal((await request(srv).get(`/verify-email/${token}`)).status, 410, 'a link works once');
    } finally {
      globalThis.fetch = realFetch;
      srv.close();
      await mail.pool.end();
    }
  });
});

describe('routing for each browser state', () => {
  test('signed out: /signup shows registration, /login shows sign-in, /admin opens the Super Admin sign-in', async () => {
    const anon = request(server);
    const s = await anon.get('/signup');
    assert.equal(s.status, 200);
    for (const f of ['name="name"', 'name="business_name"', 'name="email"', 'name="password"', 'name="confirm"', 'Create Business Account']) assert.ok(s.text.includes(f), f);
    const l = await anon.get('/login');
    for (const f of ['data-owner-login', 'name="email"', 'name="password"', 'Sign In', 'href="/forgot-password"']) assert.ok(l.text.includes(f), f);
    assert.equal((await anon.get('/admin')).headers.location, '/admin/login?next=%2Fadmin');
  });

  test("a browser with an old session is told whose session it is on /signup and /login (never sent into that workspace)", async () => {
    const o = owners.A;
    for (const path of ['/signup', '/login']) {
      const res = await o.agent.get(path);
      assert.equal(res.status, 200, path);
      assert.match(res.text, /data-signed-in/);
      assert.match(res.text, /owner-a@shop-a\.test/);
      assert.doesNotMatch(res.text, /Shop B|Shop C/);
    }
    const _csrf = await csrfToken(o.agent, '/signup');
    const post = await o.agent.post('/signup').type('form').send({ _csrf, name: 'X', email: 'x@new.test', password: PASSWORD, confirm: PASSWORD, business_name: 'Sneaky' });
    assert.equal(post.status, 409, 'cannot register a second account while signed in');
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM users WHERE email = 'x@new.test'")).rows[0].n, 0);
  });

  test('registration checks: the two passwords must match, and the business name is required', async () => {
    const agent = request.agent(server);
    const _csrf = await csrfToken(agent, '/signup');
    const a = await agent.post('/signup').type('form').send({ _csrf, name: 'Mismatch', email: 'm@x.test', password: PASSWORD, confirm: 'different-password-1', business_name: 'M Shop' });
    assert.equal(a.status, 400); assert.match(a.text, /not the same/);
    const b = await agent.post('/signup').type('form').send({ _csrf, name: 'No Biz', email: 'n@x.test', password: PASSWORD, confirm: PASSWORD, business_name: '' });
    assert.equal(b.status, 400); assert.match(b.text, /business name/);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM users WHERE email IN ('m@x.test', 'n@x.test')")).rows[0].n, 0);
  });

  test('without an email sender, password recovery says so honestly (no "email sent" message)', async () => {
    const page = await request(server).get('/forgot-password');
    assert.match(page.text, /data-reset-unavailable/);
    const agent = request.agent(server);
    const _csrf = await csrfToken(agent, '/login');
    const res = await agent.post('/forgot-password').type('form').send({ _csrf, email: 'owner-a@shop-a.test' });
    assert.equal(res.status, 503);
    assert.doesNotMatch(res.text, /on its way/);
  });

  test('the Super Admin can resend (old link stops working) and revoke an invitation', async () => {
    const admin = request.agent(server);
    await adminSignIn(admin, { email: 'admin@skyfly.test' });
    let _csrf = await csrfToken(admin, `/admin/businesses/${owners.B.biz}`);
    const first = await admin.post(`/admin/businesses/${owners.B.biz}/invite`).type('form').send({ _csrf, email: 'staff@shop-b.test', role: 'staff' });
    const oldToken = first.text.match(/\/invite\/([A-Za-z0-9_-]+)/)[1];
    const { rows: [inv] } = await pool.query("SELECT id FROM business_invites WHERE email = 'staff@shop-b.test' AND revoked_at IS NULL");
    _csrf = await csrfToken(admin, `/admin/businesses/${owners.B.biz}`);
    const resent = await admin.post(`/admin/businesses/${owners.B.biz}/invites/${inv.id}/resend`).type('form').send({ _csrf }).expect(200);
    const newToken = resent.text.match(/\/invite\/([A-Za-z0-9_-]+)/)[1];
    assert.notEqual(newToken, oldToken);
    assert.equal((await request(server).get(`/invite/${oldToken}`)).status, 410);
    assert.equal((await request(server).get(`/invite/${newToken}`)).status, 200);
    const { rows: [inv2] } = await pool.query("SELECT id FROM business_invites WHERE email = 'staff@shop-b.test' AND revoked_at IS NULL");
    _csrf = await csrfToken(admin, `/admin/businesses/${owners.B.biz}`);
    await admin.post(`/admin/businesses/${owners.B.biz}/invites/${inv2.id}/revoke`).type('form').send({ _csrf }).expect(200);
    assert.equal((await request(server).get(`/invite/${newToken}`)).status, 410);
    // Another business's invitation cannot be touched through this business's page.
    _csrf = await csrfToken(admin, `/admin/businesses/${owners.A.biz}`);
    assert.equal((await admin.post(`/admin/businesses/${owners.A.biz}/invites/${inv2.id}/resend`).type('form').send({ _csrf })).status, 404);
  });
});
