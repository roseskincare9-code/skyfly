// Super Admin infrastructure manager (services, renewal alerts once per step, spend totals, no secrets),
// subscription revenue / backup age on the overview, and the Account page (password change with a
// confirmation email; data export / deletion requests handled by a Super Admin).
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { setup, resetDatabase, csrfToken, adminSignIn, signUp, openClientSignup } from './helpers.js';
import { serviceSummary, totals, remindInfra } from '../src/services/infra.js';

const PASSWORD = 'correct-horse-battery';
const realFetch = globalThis.fetch;
const mailed = [];
globalThis.fetch = async (url, opts) => {
  if (String(url).startsWith('https://api.resend.com/')) { mailed.push(JSON.parse(opts.body)); return new Response('{"id":"m"}', { status: 200 }); }
  return realFetch(url, opts);
};
const notifyEmail = { provider: 'resend', apiKey: 're_test_not_real_000', fromEmail: 'no-reply@skyfly.test', fromName: 'Skyfly' };
const app = setup({ allowedOrigins: [], notifyEmail });
const pool = app.pool;
const server = app.app.listen(0);
let admin; let owner;

before(async () => {
  await resetDatabase(pool);
  await pool.query('DELETE FROM infra_services');
  admin = await signUp(server, { name: 'Founder', email: 'founder@skyfly.test' });
  await openClientSignup(pool);
  owner = await signUp(server, { name: 'Owner', email: 'owner@shop.test', business: 'Owner Shop' });
});
after(async () => { server.close(); globalThis.fetch = realFetch; await pool.end(); });

const adminPost = async (path, form) => { const _csrf = await csrfToken(admin, '/admin/infrastructure'); return admin.post(path).type('form').send({ _csrf, ...form }); };
const day = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);

describe('infrastructure manager', () => {
  test('summaries: renewal steps, free-plan end, failed payment; totals per currency (yearly ÷ 12)', () => {
    const now = new Date();
    assert.equal(serviceSummary({ next_payment_on: day(5), billing_frequency: 'monthly', payment_status: 'paid' }, now).level, 'act');
    assert.equal(serviceSummary({ next_payment_on: day(20), billing_frequency: 'monthly', payment_status: 'paid' }, now).level, 'watch');
    assert.equal(serviceSummary({ next_payment_on: day(60), billing_frequency: 'monthly', payment_status: 'paid' }, now).level, 'ok');
    assert.match(serviceSummary({ expires_on: day(11), billing_frequency: 'free', payment_status: 'free' }, now).alerts[0].text, /Free plan ends in 11 day/);
    assert.equal(serviceSummary({ next_payment_on: day(90), billing_frequency: 'monthly', payment_status: 'failed' }, now).level, 'act');
    assert.deepEqual(totals([{ price_minor: 700, currency: 'USD', billing_frequency: 'monthly' }, { price_minor: 1200, currency: 'USD', billing_frequency: 'yearly' }, { price_minor: 5000, currency: 'NGN', billing_frequency: 'one_time' }]),
      [{ currency: 'USD', monthly: 800, yearly: 9600 }]);
  });

  test('a Super Admin adds services; keys in the notes and non-https links are refused; owners get 404', async () => {
    assert.equal((await adminPost('/admin/infrastructure', { name: 'Skyfly database', provider: 'Render', category: 'database', plan: 'Free', billing_frequency: 'free', payment_status: 'free', expires_on: day(11), manage_url: 'https://dashboard.render.com/billing' })).status, 302);
    assert.equal((await adminPost('/admin/infrastructure', { name: 'Web', provider: 'Render', price: '7', currency: 'USD', billing_frequency: 'monthly', next_payment_on: day(3), payment_status: 'due', auto_renew: 'yes' })).status, 302);
    assert.equal((await adminPost('/admin/infrastructure', { name: 'Bad', provider: 'X', notes: 'key re_abcdefghijklmnop' })).status, 400);
    assert.equal((await adminPost('/admin/infrastructure', { name: 'Bad', provider: 'X', manage_url: 'http://insecure.example' })).status, 400);
    const page = await admin.get('/admin/infrastructure').expect(200);
    assert.match(page.text, /Free plan ends in 11 day/);
    assert.match(page.text, /data-infra-totals[\s\S]*\$7</);
    assert.match(page.text, /entered by you/);
    assert.equal((await owner.get('/admin/infrastructure')).status, 404);
    const _csrf = await csrfToken(owner, '/login');
    assert.equal((await owner.post('/admin/infrastructure').type('form').send({ _csrf, name: 'x', provider: 'y' })).status, 404);
  });

  test('renewal reminders go to Super Admins once per step and date; never to business owners', async () => {
    mailed.length = 0;
    const first = await remindInfra(pool, app.config);
    assert.deepEqual(first.map((r) => [r.service, r.threshold, r.status]).sort(), [['Skyfly database', '14d', 'sent'], ['Web', '3d', 'sent']]);
    assert.ok(mailed.every((m) => m.to.includes('founder@skyfly.test')));
    assert.ok(!mailed.some((m) => m.to.includes('owner@shop.test')));
    assert.deepEqual(await remindInfra(pool, app.config), [], 'not sent twice');
  });

  test('the overview shows subscription revenue, backup age (with an alert when none) and infrastructure alerts', async () => {
    const page = await admin.get('/admin').expect(200);
    assert.match(page.text, /data-subscription-revenue/);
    assert.match(page.text, /data-backup-alert/);
    assert.match(page.text, /data-infra-alert[\s\S]*Skyfly database/);
    await pool.query("INSERT INTO audit_log (action, created_at) VALUES ('admin.backup_downloaded', now() - interval '2 hours')");
    assert.doesNotMatch((await admin.get('/admin')).text, /data-backup-alert/);
  });
});

describe('Account page', () => {
  test('changing the password needs the current one, signs out other devices and sends a confirmation email', async () => {
    const other = request.agent(server);
    const c = await csrfToken(other, '/login');
    await other.post('/login').type('form').send({ _csrf: c, email: 'owner@shop.test', password: PASSWORD }).expect(302);
    const page = await owner.get('/account').expect(200);
    assert.match(page.text, /data-change-password/);
    let _csrf = await csrfToken(owner, '/account');
    assert.equal((await owner.post('/account/password').type('form').send({ _csrf, current_password: 'wrong-password-1', password: 'new-password-123', confirm: 'new-password-123' })).status, 403);
    mailed.length = 0;
    _csrf = await csrfToken(owner, '/account');
    const r = await owner.post('/account/password').type('form').send({ _csrf, current_password: PASSWORD, password: 'new-password-123', confirm: 'new-password-123' });
    assert.equal(r.headers.location, '/account?done=password');
    assert.equal((await owner.get('/account')).status, 200, 'this device stays signed in');
    assert.equal((await other.get('/account')).headers.location, '/login', 'the other device is signed out');
    assert.ok(mailed.some((m) => m.subject === 'Your Skyfly password was changed' && m.to.includes('owner@shop.test') && !JSON.stringify(m).includes('new-password-123')));
  });

  test('data and deletion requests are recorded once; a Super Admin handles them with their password', async () => {
    let _csrf = await csrfToken(owner, '/account');
    assert.equal((await owner.post('/account/requests').type('form').send({ _csrf, kind: 'deletion', current_password: 'new-password-123', note: 'Closing my shop' })).status, 302);
    _csrf = await csrfToken(owner, '/account');
    assert.equal((await owner.post('/account/requests').type('form').send({ _csrf, kind: 'deletion', current_password: 'new-password-123' })).status, 409);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM users WHERE email = 'owner@shop.test'")).rows[0].n, 1, 'nothing deleted automatically');
    await adminSignIn(admin, { email: 'founder@skyfly.test' });
    const list = await admin.get('/admin/accounts').expect(200);
    assert.match(list.text, /data-account-requests[\s\S]*Account deletion[\s\S]*owner@shop\.test/);
    const { rows: [req] } = await pool.query("SELECT id FROM account_requests WHERE kind = 'deletion'");
    _csrf = await csrfToken(admin, '/admin/accounts');
    assert.equal((await admin.post(`/admin/account-requests/${req.id}/done`).type('form').send({ _csrf, password: 'wrong-password-1' })).status, 403);
    _csrf = await csrfToken(admin, '/admin/accounts');
    await admin.post(`/admin/account-requests/${req.id}/done`).type('form').send({ _csrf, password: PASSWORD, response: 'Account disabled (test)' }).expect(302);
    assert.equal((await pool.query('SELECT status FROM account_requests WHERE id = $1', [req.id])).rows[0].status, 'done');
    assert.match((await owner.get('/account')).text, /done — Account disabled \(test\)/);
  });
});
