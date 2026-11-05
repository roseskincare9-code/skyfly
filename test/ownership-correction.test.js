// Ownership correction (Super Admin): give a business its own owner, then remove the shared founder account
// from it. Never removes the last owner; needs the Super Admin's password; the business's data is untouched.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { setup, resetDatabase, csrfToken, signUp, adminSignIn } from './helpers.js';

const PASSWORD = 'correct-horse-battery';
const { pool, app: expressApp } = setup({ allowedOrigins: [] });
const server = expressApp.listen(0);
let founder; let bizId;
before(async () => {
  await resetDatabase(pool);
  founder = await signUp(server, { name: 'Founder', email: 'founder@skyfly.test' }); // first account: Super Admin (development)
  const _csrf = await csrfToken(founder, '/?all=1');
  const r = await founder.post('/businesses').type('form').send({ _csrf, name: 'ScaleForge test' }).expect(302);
  bizId = Number(r.headers.location.match(/(\d+)$/)[1]);
  await pool.query("INSERT INTO products (business_id, code, name, price_minor) VALUES ($1, 'p', 'Kept product', 100)", [bizId]);
});
after(async () => { server.close(); await pool.end(); });

const remove = async (userId, password = PASSWORD) => {
  const _csrf = await csrfToken(founder, `/admin/businesses/${bizId}`);
  return founder.post(`/admin/businesses/${bizId}/members/${userId}/remove`).type('form').send({ _csrf, password });
};

test('the only owner cannot be removed', async () => {
  const { rows: [f] } = await pool.query("SELECT id FROM users WHERE email = 'founder@skyfly.test'");
  const r = await remove(f.id);
  assert.equal(r.status, 400);
  assert.match(r.text, /only owner/);
});

test('after the new owner accepts, the founder account is removed; the new owner sees only that business', async () => {
  // The Super Admin invites the business's own owner (link shown when no email sender is set up).
  let _csrf = await csrfToken(founder, `/admin/businesses/${bizId}`);
  const inv = await founder.post(`/admin/businesses/${bizId}/invite`).type('form').send({ _csrf, email: 'owner@scaleforge.test', role: 'owner' }).expect(200);
  const link = inv.text.match(/\/invite\/[A-Za-z0-9_-]+/)[0];
  const owner = request.agent(server);
  _csrf = await csrfToken(owner, link);
  await owner.post(link).type('form').send({ _csrf, name: 'ScaleForge Owner', password: PASSWORD }).expect(302);
  const { rows: [f] } = await pool.query("SELECT id FROM users WHERE email = 'founder@skyfly.test'");
  assert.equal((await remove(f.id, 'wrong-password-123')).status, 403);
  const r = await remove(f.id);
  assert.equal(r.status, 200);
  assert.match(r.text, /was removed from ScaleForge test/);
  const { rows } = await pool.query('SELECT u.email, m.role FROM business_members m JOIN users u ON u.id = m.user_id WHERE m.business_id = $1', [bizId]);
  assert.deepEqual(rows, [{ email: 'owner@scaleforge.test', role: 'owner' }]);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM products WHERE business_id = $1', [bizId])).rows[0].n, 1, 'data untouched');
  assert.equal((await owner.get('/')).headers.location, `/businesses/${bizId}`, 'the owner lands in their only business');
  assert.ok((await pool.query("SELECT 1 FROM audit_log WHERE action = 'admin.member_removed' AND business_id = $1", [bizId])).rows.length);
  // The founder is still Super Admin and still reaches the business through support access (logged), not membership.
  await adminSignIn(founder, { email: 'founder@skyfly.test' });
  assert.equal((await founder.get(`/businesses/${bizId}`)).status, 200);
});

test('business owners cannot use the Super Admin removal tool', async () => {
  const owner = request.agent(server);
  const c = await csrfToken(owner, '/login');
  await owner.post('/login').type('form').send({ _csrf: c, email: 'owner@scaleforge.test', password: PASSWORD }).expect(302);
  const c2 = await csrfToken(owner, '/login');
  assert.equal((await owner.post(`/admin/businesses/${bizId}/members/1/remove`).type('form').send({ _csrf: c2, password: PASSWORD })).status, 404);
});
