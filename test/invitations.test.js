// Invitations: each link belongs to one business and one email, works once, expires, is replaced by a
// newer link, never adds someone without their agreement, and lands the person in that business only.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { setup, resetDatabase, csrfToken, signUp } from './helpers.js';

const { pool, app: expressApp } = setup({ allowedOrigins: [] });
const app = expressApp.listen(0);
const PASSWORD = 'correct-horse-battery';
let admin; let bizA; let bizB;

async function invite(email, business = bizA, role = 'owner') {
  const _csrf = await csrfToken(admin, `/admin/businesses/${business}`);
  const res = await admin.post(`/admin/businesses/${business}/invite`).type('form').send({ _csrf, email, role });
  return { res, token: res.text.match(/\/invite\/([A-Za-z0-9_-]+)/)?.[1] };
}
async function accept(token, agent = request.agent(app), name = 'Invited Person') {
  const page = await agent.get(`/invite/${token}`);
  if (page.status !== 200) return { agent, res: page };
  const _csrf = page.text.match(/name="_csrf" value="([^"]+)"/)[1];
  return { agent, res: await agent.post(`/invite/${token}`).type('form').send({ _csrf, name, password: PASSWORD }) };
}
const members = async (email) => (await pool.query(
  'SELECT m.business_id, m.role FROM business_members m JOIN users u ON u.id = m.user_id WHERE u.email = $1 ORDER BY 1', [email])).rows;

before(async () => {
  await resetDatabase(pool);
  admin = await signUp(app, { email: 'admin@skyfly.test' });
  for (const name of ['Shop A', 'Shop B']) {
    const _csrf = await csrfToken(admin, '/?all=1');
    await admin.post('/businesses').type('form').send({ _csrf, name }).expect(302);
  }
  [bizA, bizB] = (await pool.query("SELECT id FROM businesses WHERE name IN ('Shop A', 'Shop B') ORDER BY name")).rows.map((r) => r.id);
});
after(async () => { app.close(); await pool.end(); });

test('an invited owner creates their account and lands in that business only', async () => {
  const { token } = await invite('new-owner@shop-a.test');
  assert.match(token, /^[A-Za-z0-9_-]{32}$/, '24 random bytes');
  const stored = (await pool.query("SELECT token_hash, expires_at > now() + interval '13 days' AS fourteen_days FROM business_invites WHERE email = 'new-owner@shop-a.test'")).rows[0];
  assert.notEqual(stored.token_hash, token, 'only a hash of the token is stored');
  assert.ok(stored.fourteen_days);
  const { agent, res } = await accept(token);
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, `/businesses/${bizA}`);
  assert.deepEqual(await members('new-owner@shop-a.test'), [{ business_id: bizA, role: 'owner' }]);
  assert.equal((await agent.get(`/businesses/${bizB}`)).status, 404);
  assert.equal((await agent.get('/admin')).status, 404);
  const home = await agent.get('/');
  assert.equal(home.headers.location, `/businesses/${bizA}`, 'signing in goes straight to the one business');
});

test('a link works once: using it again says it was already used', async () => {
  const { token } = await invite('once@shop-a.test');
  assert.equal((await accept(token)).res.status, 302);
  const again = await accept(token);
  assert.equal(again.res.status, 410);
  assert.match(again.res.text, /already been used/);
});

test('two people pressing "join" with the same link at the same moment: one account joins, once', async () => {
  const { token } = await invite('race@shop-a.test');
  const [p1, p2] = [request.agent(app), request.agent(app)];
  const forms = await Promise.all([p1, p2].map(async (a) => (await a.get(`/invite/${token}`)).text.match(/name="_csrf" value="([^"]+)"/)[1]));
  const results = await Promise.all([p1, p2].map((a, i) => a.post(`/invite/${token}`).type('form').send({ _csrf: forms[i], name: 'Racer', password: PASSWORD })));
  assert.deepEqual(results.map((r) => r.status).sort(), [302, 409].sort());
  assert.equal((await members('race@shop-a.test')).length, 1);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM business_invites WHERE email = 'race@shop-a.test' AND accepted_at IS NOT NULL")).rows[0].n, 1);
});

test('expired and replaced links are refused with a clear reason', async () => {
  const { token: old } = await invite('later@shop-a.test');
  const { token: fresh } = await invite('later@shop-a.test');
  const replaced = await accept(old);
  assert.equal(replaced.res.status, 410);
  assert.match(replaced.res.text, /cancelled or replaced by a newer one/);
  await pool.query("UPDATE business_invites SET expires_at = now() - interval '1 minute' WHERE email = 'later@shop-a.test' AND revoked_at IS NULL");
  const expired = await accept(fresh);
  assert.equal(expired.res.status, 410);
  assert.match(expired.res.text, /has expired/);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM users WHERE email = 'later@shop-a.test'")).rows[0].n, 0, 'no account was created');
  const garbage = await request(app).get('/invite/not-a-real-token-at-all-xyz');
  assert.equal(garbage.status, 410);
  assert.match(garbage.text, /not valid/);
});

test("an existing account is not added until it accepts, and only while signed in with the invited email", async () => {
  // An existing account that belongs to no business yet.
  await pool.query("INSERT INTO users (email, password_hash, name, email_verified_at) SELECT 'existing@shop-b.test', password_hash, 'Existing', now() FROM users WHERE email = 'admin@skyfly.test'");
  const existing = request.agent(app);
  const _l = await csrfToken(existing, '/login');
  await existing.post('/login').type('form').send({ _csrf: _l, email: 'existing@shop-b.test', password: PASSWORD }).expect(302);
  const { res, token } = await invite('existing@shop-b.test', bizB, 'owner');
  assert.equal(res.status, 200);
  assert.match(res.text, /Invite created for existing@shop-b\.test/, 'same answer whether or not the email has an account');
  assert.deepEqual(await members('existing@shop-b.test'), [], 'not added yet');
  // Someone else signed in cannot use it.
  const { agent: other } = await accept((await invite('someone@shop-a.test')).token);
  const page = await other.get(`/invite/${token}`);
  const _csrf = page.text.match(/name="_csrf" value="([^"]+)"/)[1];
  const wrong = await other.post(`/invite/${token}`).type('form').send({ _csrf });
  assert.equal(wrong.status, 403);
  assert.match(wrong.text, /This invitation is for existing@shop-b\.test/);
  // The invited person, signed in, joins.
  const page2 = await existing.get(`/invite/${token}`);
  const ok = await existing.post(`/invite/${token}`).type('form').send({ _csrf: page2.text.match(/name="_csrf" value="([^"]+)"/)[1] });
  assert.equal(ok.headers.location, `/businesses/${bizB}`);
  assert.deepEqual(await members('existing@shop-b.test'), [{ business_id: bizB, role: 'owner' }]);
});

test('an account that belongs to one business cannot be invited into, or added to, another (Super Admins excepted)', async () => {
  // Refused when inviting, from the Super Admin area and from a business's own Team page.
  const { res } = await invite('existing@shop-b.test', bizA, 'staff');
  assert.equal(res.status, 409);
  assert.match(res.text, /already belongs to another business/);
  // Refused by the database itself, even if application code forgot the check.
  const { rows: [u] } = await pool.query("SELECT id FROM users WHERE email = 'existing@shop-b.test'");
  await assert.rejects(pool.query("INSERT INTO business_members (business_id, user_id, role) VALUES ($1, $2, 'staff')", [bizA, u.id]), /skyfly_one_business/);
  assert.deepEqual(await members('existing@shop-b.test'), [{ business_id: bizB, role: 'owner' }]);
  // An invitation made before the account joined elsewhere cannot be used to join a second business.
  await pool.query("INSERT INTO users (email, password_hash, name, email_verified_at) SELECT 'late@shop.test', password_hash, 'Late', now() FROM users WHERE email = 'admin@skyfly.test'");
  const { token: tA } = await invite('late@shop.test', bizA, 'staff');
  const { token: tB } = await invite('late@shop.test', bizB, 'staff');
  const late = request.agent(app);
  const _l = await csrfToken(late, '/login');
  await late.post('/login').type('form').send({ _csrf: _l, email: 'late@shop.test', password: PASSWORD }).expect(302);
  for (const [t, status] of [[tA, 302], [tB, 409]]) {
    const p = await late.get(`/invite/${t}`);
    const r = await late.post(`/invite/${t}`).type('form').send({ _csrf: p.text.match(/name="_csrf" value="([^"]+)"/)[1] });
    assert.equal(r.status, status);
  }
  assert.deepEqual((await members('late@shop.test')).map((m) => m.business_id), [bizA]);
  // The Super Admin (a member of both test shops) is the only account allowed several businesses.
  assert.equal((await members('admin@skyfly.test')).length >= 2, true);
});

test('inviting someone already in the business changes nothing (their role stays)', async () => {
  const { res } = await invite('existing@shop-b.test', bizB, 'staff');
  assert.equal(res.status, 409);
  assert.match(res.text, /already in this business as Owner/);
  assert.deepEqual((await members('existing@shop-b.test')).find((m) => m.business_id === bizB), { business_id: bizB, role: 'owner' });
});

test('a business owner can invite only into their own business, and only an owner may invite', async () => {
  const { agent: ownerA } = await accept((await invite('owner2@shop-a.test')).token);
  let _csrf = await csrfToken(ownerA, `/businesses/${bizA}/team`);
  assert.equal((await ownerA.post(`/businesses/${bizB}/team/invite`).type('form').send({ _csrf, email: 'x@x.test', role: 'owner' })).status, 404);
  const { agent: staff } = await accept((await invite('staff@shop-a.test', bizA, 'staff')).token);
  _csrf = await csrfToken(staff, `/businesses/${bizA}`);
  assert.equal((await staff.post(`/businesses/${bizA}/team/invite`).type('form').send({ _csrf, email: 'y@y.test', role: 'owner' })).status, 403);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM business_invites WHERE email IN ('x@x.test', 'y@y.test')")).rows[0].n, 0);
});

test('with an email sender set up, the link goes only to the invited mailbox (never shown), and a failed send leaves nothing usable', async () => {
  const mailed = [];
  let failNext = false;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (String(url).startsWith('https://api.resend.com/')) {
      if (failNext) return new Response('{"message":"rejected"}', { status: 422 });
      mailed.push(JSON.parse(opts.body));
      return new Response('{"id":"m1"}', { status: 200 });
    }
    return realFetch(url, opts);
  };
  const mail = setup({ allowedOrigins: [], notifyEmail: { provider: 'resend', apiKey: 'test-key', fromEmail: 'team@skyfly.test', fromName: 'Skyfly' } });
  const server = mail.app.listen(0);
  try {
    // This owner joined before the sender was set up; they have confirmed their email since.
    await pool.query("UPDATE users SET email_verified_at = now() WHERE email = 'new-owner@shop-a.test'");
    const owner = request.agent(server);
    let _csrf = await csrfToken(owner, '/login');
    await owner.post('/login').type('form').send({ _csrf, email: 'new-owner@shop-a.test', password: PASSWORD }).expect(302);
    _csrf = await csrfToken(owner, `/businesses/${bizA}/team`);
    const res = await owner.post(`/businesses/${bizA}/team/invite`).type('form').send({ _csrf, email: 'mailed@shop-a.test', role: 'staff' }).expect(200);
    assert.match(res.text, /Invitation emailed to mailed@shop-a\.test/);
    assert.doesNotMatch(res.text, /\/invite\/[A-Za-z0-9_-]{20,}/, 'the link is not shown to the inviter');
    assert.equal(mailed.length, 1);
    assert.deepEqual(mailed[0].to, ['mailed@shop-a.test']);
    assert.match(mailed[0].subject, /invited to Shop A/);
    const token = mailed[0].text.match(/\/invite\/([A-Za-z0-9_-]+)/)[1];
    const { res: joined } = await accept(token, request.agent(server));
    assert.equal(joined.headers.location, `/businesses/${bizA}`);
    assert.deepEqual(await members('mailed@shop-a.test'), [{ business_id: bizA, role: 'staff' }]);

    failNext = true;
    _csrf = await csrfToken(owner, `/businesses/${bizA}/team`);
    const failed = await owner.post(`/businesses/${bizA}/team/invite`).type('form').send({ _csrf, email: 'bounce@shop-a.test', role: 'staff' });
    assert.equal(failed.status, 502);
    assert.match(failed.text, /could not be sent/);
    const { rows: [inv] } = await pool.query("SELECT revoked_at IS NOT NULL AS revoked FROM business_invites WHERE email = 'bounce@shop-a.test'");
    assert.equal(inv.revoked, true, 'the unsent link cannot be used');
  } finally {
    globalThis.fetch = realFetch;
    server.close();
    await mail.pool.end();
  }
});
