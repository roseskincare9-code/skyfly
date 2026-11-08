// An account with several businesses returns to the workspace it last opened (after a refresh or a new
// sign-in), only while it is still a member; "All businesses" lists them to switch. Data stays per
// business: the remembered workspace shows only its own records.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { setup, resetDatabase, csrfToken, signUp, openClientSignup } from './helpers.js';

const app = setup({ allowedOrigins: [] });
const pool = app.pool;
const server = app.app.listen(0);
let owner; let A; let B;
before(async () => {
  await resetDatabase(pool);
  await signUp(server, { name: 'Founder', email: 'founder@skyfly.test' });
  await openClientSignup(pool);
  owner = await signUp(server, { name: 'Owner', email: 'two@shop.test', business: 'Alpha Shop' });
  A = Number((await owner.get('/')).headers.location.match(/\/businesses\/(\d+)/)[1]);
  const _csrf = await csrfToken(owner, '/?all=1');
  await owner.post('/businesses').type('form').send({ _csrf, name: 'Beta Shop' });
  B = (await pool.query("SELECT id FROM businesses WHERE name = 'Beta Shop'")).rows[0].id;
  await pool.query("INSERT INTO products (business_id, code, name, price_minor) VALUES ($1, 'alpha-cream', 'Alpha Only Cream', 1000), ($2, 'beta-soap', 'Beta Only Soap', 500)", [A, B]);
});
after(async () => { server.close(); await pool.end(); });

test('opening a workspace remembers it; "/" and a new sign-in return to it; "All businesses" lists both', async () => {
  await owner.get(`/businesses/${B}/products`).expect(200);
  assert.equal((await owner.get('/')).headers.location, `/businesses/${B}`);
  const list = await owner.get('/?all=1').expect(200);
  assert.match(list.text, /Alpha Shop[\s\S]*Beta Shop/);
  // New sign-in: back to Beta, which shows Beta's records only.
  const again = request.agent(server);
  const _csrf = await csrfToken(again, '/login');
  assert.equal((await again.post('/login').type('form').send({ _csrf, email: 'two@shop.test', password: 'correct-horse-battery' })).status, 302);
  assert.equal((await again.get('/')).headers.location, `/businesses/${B}`);
  const products = await again.get(`/businesses/${B}/products`).expect(200);
  assert.match(products.text, /Beta Only Soap/);
  assert.doesNotMatch(products.text, /Alpha Only Cream/);
});

test('a remembered business the account no longer belongs to is ignored (no access through the memory)', async () => {
  await owner.get(`/businesses/${B}`).expect(200);
  await pool.query('DELETE FROM business_members WHERE business_id = $1', [B]);
  assert.equal((await owner.get('/')).headers.location, `/businesses/${A}`); // only Alpha left: straight to it
  assert.equal((await owner.get(`/businesses/${B}/products`)).status, 404);
});
