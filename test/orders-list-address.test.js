// The Orders list shows each order's delivery address right after the customer's name, then the
// phone number and email (the address was only on the order's own page before).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { setup, resetDatabase, signUp, ORIGIN } from './helpers.js';
import { seedLarose } from '../src/scripts/seed-larose.js';
import { clearOriginCache } from '../src/lib/origins.js';

const { pool, app } = setup({});
let owner; let larose;

before(async () => {
  await resetDatabase(pool);
  owner = await signUp(app, { email: 'owner@larose.test' });
  larose = await seedLarose(pool, 'owner@larose.test');
  clearOriginCache();
});
after(() => pool.end());

test('a saved order lists name, delivery address, phone and email in that order', async () => {
  const res = await request(app).post('/api/public/orders').set('Origin', ORIGIN).send({
    landingPage: 'larosenigeria', idempotencyKey: 'orders-list-address-000001',
    customer: { name: 'TEST ORDER Address Check', phone: '08031112222', email: 'address.check@example.test', address: '12 Fictional Crescent, Lekki Phase 1, Lagos' },
    items: [{ product: 'package-2', quantity: 1 }],
  }).expect(201);
  assert.equal(res.body.deliveryAddress, '12 Fictional Crescent, Lekki Phase 1, Lagos', 'the reply returns the saved address');
  const html = (await owner.get(`/businesses/${larose}/orders`).expect(200)).text;
  const row = html.slice(html.indexOf(res.body.reference));
  const at = (s) => row.indexOf(s);
  assert.ok(at('12 Fictional Crescent, Lekki Phase 1, Lagos') > 0, 'address shown in the list');
  assert.ok(at('TEST ORDER Address Check') < at('12 Fictional Crescent') && at('12 Fictional Crescent') < at('+2348031112222') && at('+2348031112222') < at('address.check@example.test'),
    'name, then address, then phone, then email');
});

test('an order without a delivery address is refused and nothing is saved', async () => {
  const count = async () => (await pool.query('SELECT count(*)::int AS n FROM orders')).rows[0].n;
  const n = await count();
  for (const address of [undefined, '', '   ', 'abc']) {
    const res = await request(app).post('/api/public/orders').set('Origin', ORIGIN).send({
      landingPage: 'larosenigeria', idempotencyKey: `orders-list-address-no-${String(address).length}x`,
      customer: { name: 'TEST ORDER No Address', phone: '08031112222', email: 'x@example.test', address },
      items: [{ product: 'package-2', quantity: 1 }],
    }).expect(400);
    assert.equal(res.body.fields?.address, 'Enter your full delivery address.');
  }
  assert.equal(await count(), n);
});

test('the reply to a repeated submission returns the same saved address; a very short address is flagged for follow-up', async () => {
  const body = {
    landingPage: 'larosenigeria', idempotencyKey: 'orders-list-address-000002',
    customer: { name: 'TEST ORDER Short Address', phone: '08031113333', email: 'short@example.test', address: 'Lekki' },
    items: [{ product: 'package-1', quantity: 1 }],
  };
  const first = await request(app).post('/api/public/orders').set('Origin', ORIGIN).send(body).expect(201);
  const again = await request(app).post('/api/public/orders').set('Origin', ORIGIN).send(body).expect(200);
  assert.equal(again.body.reference, first.body.reference);
  assert.equal(again.body.deliveryAddress, 'Lekki');
  const html = (await owner.get(`/businesses/${larose}/orders`).expect(200)).text;
  const row = (ref) => html.slice(html.indexOf(ref), html.indexOf('</tr>', html.indexOf(ref)));
  assert.match(row(first.body.reference), /data-address-check/);
  const full = (await pool.query("SELECT reference FROM orders WHERE customer_name = 'TEST ORDER Address Check'")).rows[0].reference;
  assert.doesNotMatch(row(full), /data-address-check/, 'a full address is not flagged');
});
