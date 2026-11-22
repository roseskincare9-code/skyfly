// workspaceAccess(): a member always opens their own business; anyone else never does; a platform admin who is
// not a member opens a client's business only when the caller allows it (a verified Super Admin sign-in).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setup, resetDatabase } from './helpers.js';
import { workspaceAccess } from '../src/services/tenancy.js';

const { pool } = setup({});
let owner; let stranger; let admin; let biz;
before(async () => {
  await resetDatabase(pool);
  const u = async (email, isAdmin = false) => (await pool.query('INSERT INTO users (email, password_hash, name, is_platform_admin) VALUES ($1, $2, $3, $4) RETURNING id', [email, 'x', email, isAdmin])).rows[0].id;
  [owner, stranger, admin] = [await u('owner@a.test'), await u('other@b.test'), await u('admin@skyfly.test', true)];
  biz = (await pool.query("INSERT INTO businesses (owner_id, name, slug, currency) VALUES ($1, 'A', 'a', 'NGN') RETURNING id", [owner])).rows[0].id;
  await pool.query("INSERT INTO business_members (business_id, user_id, role) VALUES ($1, $2, 'owner')", [biz, owner]);
});
after(() => pool.end());

test('the member opens it; another business owner never does, even if asking for admin access', async () => {
  assert.equal((await workspaceAccess(pool, owner, biz)).role, 'owner');
  assert.equal(await workspaceAccess(pool, stranger, biz), null);
  assert.equal(await workspaceAccess(pool, stranger, biz, { allowAdmin: true }), null);
});

test('a platform admin who is not a member needs the verified Super Admin sign-in (allowAdmin)', async () => {
  assert.equal(await workspaceAccess(pool, admin, biz), null);
  const a = await workspaceAccess(pool, admin, biz, { allowAdmin: true });
  assert.equal(a.viaAdmin, true);
});
