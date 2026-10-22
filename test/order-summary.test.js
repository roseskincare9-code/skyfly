// The start-up "Orders check" log lines: latest test orders as their business's Orders page lists them.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { setup, resetDatabase, signUp } from './helpers.js';
import { seedLarose } from '../src/scripts/seed-larose.js';
import { testOrderSummary } from '../src/services/orders.js';

const { pool, app } = setup({ allowedOrigins: ['https://roseskincare9-code.github.io'] });
const order = (name, key) => request(app).post('/api/public/orders').set('Origin', 'https://roseskincare9-code.github.io').send({
  landingPage: 'larosenigeria', idempotencyKey: key,
  customer: { name, phone: '08031234567', address: '1 Test Road, Ikeja' }, items: [{ product: 'package-3', quantity: 2 }],
});

before(async () => {
  await resetDatabase(pool);
  await signUp(app, { email: 'owner@larose.test' });
  await seedLarose(pool, 'owner@larose.test');
});
after(() => pool.end());

test('lists only test orders, with business, items, total and how many orders the business list shows', async () => {
  const t = await order('TEST ORDER summary check', 'summary-check-000001').expect(201);
  await order('TEST ORDER summary check', 'summary-check-000001').expect(200); // replay: same order
  await order('Real Customer', 'summary-check-000002').expect(201);
  const lines = await testOrderSummary(pool);
  assert.equal(lines.length, 1, lines.join('\n'));
  assert.match(lines[0], new RegExp(`${t.body.reference} — business larose-nigeria, page larosenigeria, Package 3 – Power Glow x2, total 116,000 NGN, status \\w+, sheet copy \\w+, listed 1x in larose-nigeria Orders, 1 order\\(s\\) for this submission`));
  assert.doesNotMatch(lines[0], /Real Customer|08031234567|Test Road/);
});
