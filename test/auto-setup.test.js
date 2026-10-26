import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { setup, resetDatabase, signUp, ORIGIN } from './helpers.js';
import { ensureLaroseForOwner } from '../src/services/setup.js';

const { pool, app, config } = setup({ allowSignup: true, signupFirstOnly: true, autoSetupLarose: true });
const quiet = { log: () => {} };

before(() => resetDatabase(pool));
after(() => pool.end());

test('signing up the owner sets up Larose once; running it again changes nothing', async () => {
  const owner = await signUp(app, { email: 'owner@larose.test' });
  const { rows } = await pool.query("SELECT b.name, b.currency, b.whatsapp_number FROM businesses b JOIN landing_pages lp ON lp.business_id = b.id WHERE lp.slug = 'larosenigeria'");
  assert.deepEqual(rows, [{ name: 'Larose Natural Skincare Nigeria', currency: 'NGN', whatsapp_number: '+2349049206695' }]);
  assert.equal(await ensureLaroseForOwner(pool, config, quiet), null);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM businesses')).rows[0].n, 1);
  const home = await owner.get('/').expect(200);
  assert.match(home.text, /Larose Natural Skincare Nigeria/);
  assert.doesNotMatch(home.text, /<button type="submit">Set up Larose<\/button>/);
  const { rows: [meta] } = await pool.query("SELECT pixel_id, enabled FROM tracking_pixels WHERE platform = 'meta' ORDER BY id LIMIT 1");
  assert.deepEqual(meta, { pixel_id: '1357015185691765', enabled: true });
});

test('an owner who signed up before this feature gets Larose at the next start', async () => {
  await resetDatabase(pool);
  await pool.query("INSERT INTO users (email, password_hash, name) VALUES ('owner@larose.test', 'x', 'Owner')");
  assert.ok(await ensureLaroseForOwner(pool, config, quiet));
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM landing_pages WHERE slug = 'larosenigeria'")).rows[0].n, 1);
});

test('nothing is set up automatically when there is more than one account, or when turned off', async () => {
  await resetDatabase(pool);
  await pool.query("INSERT INTO users (email, password_hash, name) VALUES ('a@x.test', 'x', 'A'), ('b@x.test', 'x', 'B')");
  assert.equal(await ensureLaroseForOwner(pool, config, quiet), null);
  await pool.query("DELETE FROM users WHERE email = 'b@x.test'");
  assert.equal(await ensureLaroseForOwner(pool, { ...config, autoSetupLarose: false }, quiet), null);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM businesses')).rows[0].n, 0);
});

test('orders placed as "TEST ORDER …" are marked as test orders; real names are not', async () => {
  await resetDatabase(pool);
  await signUp(app, { email: 'owner@larose.test' });
  const send = (name, key) => request(app).post('/api/public/orders').set('Origin', ORIGIN).send({
    landingPage: 'larosenigeria', idempotencyKey: key,
    customer: { name, phone: '08012345678', address: '1 Test Street, Lagos', state: 'Lagos' },
    items: [{ product: 'package-1', quantity: 1 }],
  });
  assert.equal((await send('TEST ORDER Skyfly E2E 1 please ignore', 'auto-setup-test-0000001')).status, 201);
  assert.equal((await send('Testimony Adebayo', 'auto-setup-test-0000002')).status, 201);
  const { rows } = await pool.query('SELECT customer_name, is_test FROM orders ORDER BY id');
  assert.deepEqual(rows.map((r) => r.is_test), [true, false]);
});
