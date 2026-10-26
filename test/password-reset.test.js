// Stage 0: the first real account becomes the platform owner even when the automated live-test account
// already exists; password reset by email (when Skyfly has a sender) and by a link the platform owner
// makes for a client member. Links work once, expire, and end the account's other sessions.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import request from 'supertest';
import { setup, resetDatabase, csrfToken, signUp } from './helpers.js';
import { ensureE2eAccount, E2E_EMAIL } from '../src/services/setup.js';

const mail = []; let down = false;
const mock = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    if (down) { res.writeHead(503, { 'Content-Type': 'application/json' }); return res.end('{"message":"down"}'); }
    mail.push(JSON.parse(body || '{}'));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id: `email_${mail.length}` }));
  });
});
await new Promise((r) => mock.listen(0, r));
const { pool, app } = setup({
  allowSignup: true, signupFirstOnly: true, publicBaseUrl: 'https://skyfly.test', emailApiBase: `http://127.0.0.1:${mock.address().port}`,
  notifyEmail: { provider: 'resend', apiKey: 're_test_0123456789abcdef', fromEmail: 'accounts@skyfly.test', fromName: 'Skyfly' },
});
const quiet = { log() {} };
const linkFrom = (m) => m.text.match(/https:\/\/skyfly\.test(\/reset-password\/[A-Za-z0-9_-]+)/)[1];
const login = async (email, password) => {
  const agent = request.agent(app);
  const _csrf = await csrfToken(agent, '/login');
  const res = await agent.post('/login').type('form').send({ _csrf, email, password });
  return { agent, ok: res.status === 302 };
};
const forgot = async (email) => {
  const agent = request.agent(app);
  const _csrf = await csrfToken(agent, '/forgot-password');
  return agent.post('/forgot-password').type('form').send({ _csrf, email });
};
const reset = async (path, password, confirm = password) => {
  const agent = request.agent(app);
  const page = await agent.get(path);
  const _csrf = page.text.match(/name="_csrf" value="([^"]+)"/)?.[1];
  return { page, res: _csrf ? await agent.post(path).type('form').send({ _csrf, password, confirm }) : null };
};
let owner; let client;

before(async () => {
  await resetDatabase(pool);
  await ensureE2eAccount(pool, quiet); // as on every server start: the live-test account exists first
});
after(async () => { await pool.end(); mock.close(); });

describe('first account', () => {
  test('the first real sign-up is open and becomes the platform owner, even though the live-test account exists', async () => {
    // Only the live-test accounts (manager, owner A, owner B) exist so far.
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM users WHERE email NOT LIKE 'e2e-%@skyfly.invalid'")).rows[0].n, 0);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM users WHERE email LIKE 'e2e-%@skyfly.invalid'")).rows[0].n, 3);
    assert.match((await request(app).get('/signup').expect(200)).text, /name="password"/);
    owner = await signUp(app, { email: 'owner@skyfly.test' });
    const { rows: [u] } = await pool.query("SELECT is_platform_admin FROM users WHERE email = 'owner@skyfly.test'");
    assert.equal(u.is_platform_admin, true);
    const { rows: e2e } = await pool.query("SELECT is_platform_admin FROM users WHERE email LIKE 'e2e-%@skyfly.invalid'");
    assert.ok(e2e.length === 3 && e2e.every((x) => !x.is_platform_admin));
  });
  test('after that, sign-up is closed again (invitation only)', async () => {
    await request(app).get('/signup').expect(404);
  });
});

describe('password reset by email', () => {
  test('a known address gets one link; an unknown address gets the same answer and no email', async () => {
    const before = mail.length;
    const known = await forgot('owner@skyfly.test');
    const unknown = await forgot('nobody@skyfly.test');
    assert.equal(known.status, 200); assert.equal(unknown.status, 200);
    const strip = (t) => t.replace(/name="_csrf" value="[^"]+"/g, '');
    assert.equal(strip(known.text), strip(unknown.text), 'the page never reveals which addresses have accounts');
    assert.equal(mail.length, before + 1);
    assert.deepEqual(mail.at(-1).to, ['owner@skyfly.test']);
    assert.match(mail.at(-1).text, /works once, for 60 minutes/);
    await forgot(E2E_EMAIL);
    assert.equal(mail.length, before + 1, 'never for the automated live-test account');
    const { rows } = await pool.query('SELECT token_hash FROM password_resets');
    assert.ok(rows.every((r) => /^[0-9a-f]{64}$/.test(r.token_hash)) && !rows.some((r) => mail.at(-1).text.includes(r.token_hash)), 'only a hash is stored');
  });

  test('the link sets a new password once, ends other sessions, and the old password stops working', async () => {
    const path = linkFrom(mail.at(-1));
    assert.ok((await owner.get('/').expect(200)).text.length, 'signed in before');
    const short = await reset(path, 'short');
    assert.equal(short.res.status, 400);
    const mismatch = await reset(path, 'a-new-password-1234', 'something-else-1234');
    assert.equal(mismatch.res.status, 400);
    const ok = await reset(path, 'a-new-password-1234');
    assert.equal(ok.res.status, 200);
    assert.match(ok.res.text, /Your password has been changed/);
    await owner.get('/').expect(302).expect('Location', '/login');
    assert.equal((await login('owner@skyfly.test', 'correct-horse-battery')).ok, false);
    assert.equal((await login('owner@skyfly.test', 'a-new-password-1234')).ok, true);
    const again = await reset(path, 'another-password-1234');
    assert.equal(again.page.status, 404, 'the link works once');
    assert.match(again.page.text, /doesn't work any more/);
  });

  test('an expired link and a made-up link do not work', async () => {
    await forgot('owner@skyfly.test');
    const path = linkFrom(mail.at(-1));
    await pool.query("UPDATE password_resets SET expires_at = now() - interval '1 minute' WHERE used_at IS NULL");
    assert.equal((await reset(path, 'yet-another-password-1')).page.status, 404);
    assert.equal((await reset('/reset-password/' + 'x'.repeat(43), 'yet-another-password-1')).page.status, 404);
    assert.equal((await login('owner@skyfly.test', 'a-new-password-1234')).ok, true, 'password unchanged');
  });

  test('if the email provider is down, the page answers the same and nothing breaks', async () => {
    down = true;
    const res = await forgot('owner@skyfly.test');
    down = false;
    assert.equal(res.status, 200);
    assert.match(res.text, /If that address has a Skyfly account/);
  });
});

describe('password reset link made by the platform owner', () => {
  let bizId;
  before(async () => {
    owner = (await login('owner@skyfly.test', 'a-new-password-1234')).agent;
    const { rows: [u] } = await pool.query("INSERT INTO users (email, password_hash, name) VALUES ('client@shop.test', 'x', 'Client') RETURNING id");
    bizId = (await pool.query("INSERT INTO businesses (owner_id, name, slug, currency) VALUES ($1, 'Client Shop', 'client-shop', 'NGN') RETURNING id", [u.id])).rows[0].id;
    await pool.query("INSERT INTO business_members (business_id, user_id, role) VALUES ($1, $2, 'owner')", [bizId, u.id]);
    client = u.id;
  });

  test('the owner gets a one-time link for a member, shown once and logged; the member sets a password with it', async () => {
    const _csrf = await csrfToken(owner, `/admin/businesses/${bizId}`);
    const res = await owner.post(`/admin/businesses/${bizId}/members/${client}/reset-link`).type('form').send({ _csrf }).expect(200);
    const path = res.text.match(/https:\/\/skyfly\.test(\/reset-password\/[A-Za-z0-9_-]+)/)[1];
    assert.match(res.text, /works once, for 24 hours/);
    const { rows: [a] } = await pool.query("SELECT 1 FROM audit_log WHERE action = 'admin.password_reset_link' AND business_id = $1", [bizId]);
    assert.ok(a);
    assert.equal((await reset(path, 'client-password-1234')).res.status, 200);
    assert.equal((await login('client@shop.test', 'client-password-1234')).ok, true);
  });

  test('not for someone outside the business, not for the live-test account, and not for a non-owner', async () => {
    const _csrf = await csrfToken(owner, `/admin/businesses/${bizId}`);
    const { rows: [e2e] } = await pool.query('SELECT id FROM users WHERE email = $1', [E2E_EMAIL]);
    await pool.query("INSERT INTO business_members (business_id, user_id, role) VALUES ($1, $2, 'manager')", [bizId, e2e.id]);
    await owner.post(`/admin/businesses/${bizId}/members/${e2e.id}/reset-link`).type('form').send({ _csrf }).expect(404);
    const { rows: [ownerRow] } = await pool.query("SELECT id FROM users WHERE email = 'owner@skyfly.test'");
    await owner.post(`/admin/businesses/${bizId}/members/${ownerRow.id}/reset-link`).type('form').send({ _csrf }).expect(404);
    const member = (await login('client@shop.test', 'client-password-1234')).agent;
    const token = await csrfToken(member, `/businesses/${bizId}/orders`);
    const res = await member.post(`/admin/businesses/${bizId}/members/${client}/reset-link`).type('form').send({ _csrf: token });
    assert.equal(res.status, 404);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM password_resets WHERE user_id = $1 AND used_at IS NULL", [client])).rows[0].n, 0);
  });
});
