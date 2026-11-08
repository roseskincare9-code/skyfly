// Only a Super Admin belongs to several businesses. A business owner sees and manages exactly one: no
// second business, no list of others. The Super Admin returns to the workspace last opened (after a
// refresh or a new sign-in); "All businesses" lists them; data stays per business.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { setup, resetDatabase, csrfToken, signUp, openClientSignup } from './helpers.js';

const app = setup({ allowedOrigins: [] });
const pool = app.pool;
const server = app.app.listen(0);
let admin; let owner; let A; let B; let own;
before(async () => {
  await resetDatabase(pool);
  admin = await signUp(server, { name: 'Founder', email: 'founder@skyfly.test' });
  for (const name of ['Alpha Shop', 'Beta Shop']) {
    const _csrf = await csrfToken(admin, '/?all=1');
    await admin.post('/businesses').type('form').send({ _csrf, name }).expect(302);
  }
  [A, B] = (await pool.query("SELECT id FROM businesses WHERE name IN ('Alpha Shop', 'Beta Shop') ORDER BY name")).rows.map((r) => r.id);
  await openClientSignup(pool);
  owner = await signUp(server, { name: 'Owner', email: 'owner@shop.test', business: 'Owner Shop' });
  own = (await pool.query("SELECT id FROM businesses WHERE name = 'Owner Shop'")).rows[0].id;
  await pool.query("INSERT INTO products (business_id, code, name, price_minor) VALUES ($1, 'alpha-cream', 'Alpha Only Cream', 1000), ($2, 'beta-soap', 'Beta Only Soap', 500)", [A, B]);
});
after(async () => { server.close(); await pool.end(); });

test('a business owner has exactly one business: no second one, no other names, no "new business" form', async () => {
  const list = await owner.get('/?all=1').expect(200);
  assert.match(list.text, /Owner Shop/);
  assert.doesNotMatch(list.text, /Alpha Shop|Beta Shop/);
  assert.doesNotMatch(list.text, /action="\/businesses"/, 'no form to create another business');
  const _csrf = await csrfToken(owner, '/?all=1');
  const r = await owner.post('/businesses').type('form').send({ _csrf, name: 'Second Shop' });
  assert.equal(r.status, 403);
  assert.match(r.text, /Each Skyfly account manages one business/);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM businesses WHERE name = 'Second Shop'")).rows[0].n, 0);
  assert.equal((await owner.get('/')).headers.location, `/businesses/${own}`);
  for (const id of [A, B]) assert.equal((await owner.get(`/businesses/${id}/products`)).status, 404);
});

test('the Super Admin returns to the workspace last opened (refresh and new sign-in); "All businesses" lists them', async () => {
  await admin.get(`/businesses/${B}/products`).expect(200);
  assert.equal((await admin.get('/')).headers.location, `/businesses/${B}`);
  assert.match((await admin.get('/?all=1').expect(200)).text, /Alpha Shop[\s\S]*Beta Shop/);
  const again = request.agent(server);
  const _csrf = await csrfToken(again, '/login');
  assert.equal((await again.post('/login').type('form').send({ _csrf, email: 'founder@skyfly.test', password: 'correct-horse-battery' })).status, 302);
  assert.equal((await again.get('/')).headers.location, `/businesses/${B}`);
  const products = await again.get(`/businesses/${B}/products`).expect(200);
  assert.match(products.text, /Beta Only Soap/);
  assert.doesNotMatch(products.text, /Alpha Only Cream/);
});

test('a remembered business the account no longer belongs to is ignored (the memory never grants access)', async () => {
  await pool.query("UPDATE users SET last_business_id = $1 WHERE email = 'owner@shop.test'", [A]);
  assert.equal((await owner.get('/')).headers.location, `/businesses/${own}`);
  assert.equal((await owner.get(`/businesses/${A}`)).status, 404);
});

test('Super Admin access cannot be removed while the account still belongs to several businesses (database guard)', async () => {
  await assert.rejects(pool.query("UPDATE users SET is_platform_admin = false WHERE email = 'founder@skyfly.test'"), /skyfly_one_business/);
});
