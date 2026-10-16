// The left sidebar: every item opens a real page; Customers and Analytics show real data.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { setup, resetDatabase, csrfToken, signUp, ORIGIN } from './helpers.js';
import { seedLarose } from '../src/scripts/seed-larose.js';

const { pool, app } = setup();
let owner;
let id;

before(async () => {
  await resetDatabase(pool);
  owner = await signUp(app, { name: 'Temitope Adebayo', email: 'owner@larose.test' });
  id = await seedLarose(pool, 'owner@larose.test');
  const send = (name, phone, key, product, qty) => request(app).post('/api/public/orders').set('Origin', ORIGIN).send({
    landingPage: 'larosenigeria', idempotencyKey: key,
    customer: { name, phone, address: '1 Test Street, Lekki', state: 'Lagos' },
    items: [{ product, quantity: qty }], attribution: { utm_source: 'facebook' },
  }).expect(201);
  await send('Ngozi Adeyemi', '08051234567', 'sidebar-test-key-0000001', 'package-3', 2);
  await send('Ngozi Adeyemi', '08051234567', 'sidebar-test-key-0000002', 'package-1', 1);
  await send('Amaka Bello', '08061234567', 'sidebar-test-key-0000003', 'package-2', 1);
  await send('TEST ORDER please ignore', '08071234567', 'sidebar-test-key-0000004', 'package-5', 1);
});
after(() => pool.end());

test('every sidebar item opens a working page and is highlighted there', async () => {
  const home = await owner.get(`/businesses/${id}`).expect(200);
  const links = [...home.text.matchAll(/<nav class="side-nav">([\s\S]*?)<\/nav>/g)][0][1].match(/href="([^"]+)"/g).map((h) => h.slice(6, -1));
  assert.deepEqual(links.map((l) => l.replace(`/businesses/${id}`, '') || '/'), ['/', '/orders', '/products', '/customers', '/landing-pages', '/analytics', '/pixels', '/google-sheets', '/api-keys', '/activity', '/settings']);
  for (const link of links) {
    const res = await owner.get(link).expect(200);
    assert.match(res.text, /<a href="[^"]+" class="on" aria-current=page>/, `${link} highlights its item`);
    assert.ok(res.text.includes(`<a href="${link}" class="on"`), `${link} is the highlighted item`);
  }
});

test('dashboard shows real figures, a greeting, the business switcher and the pending count', async () => {
  const res = await owner.get(`/businesses/${id}?days=7`).expect(200);
  assert.match(res.text, /Good (morning|afternoon|evening), Temitope/);
  assert.match(res.text, /<div class="n">3<\/div><div class="l">Total orders/, 'test order left out');
  assert.match(res.text, /<div class="n">2<\/div><div class="l">New customers/);
  assert.match(res.text, /<span class="badge" title="3 pending">3<\/span>/);
  assert.match(res.text, /Package 3 – Power Glow/);
  assert.match(res.text, /class="biz-menu"[\s\S]*Larose Natural Skincare Nigeria/);
  assert.match(res.text, /<a href="\?days=7"|days=7" class="on"/);
});

test('customers are grouped by phone with real totals; test orders are left out', async () => {
  const res = await owner.get(`/businesses/${id}/customers`).expect(200);
  assert.match(res.text, /<div class="n">2<\/div><div class="l">Customers/);
  assert.match(res.text, /<div class="n">1<\/div><div class="l">Ordered more than once/);
  assert.match(res.text, /Ngozi Adeyemi[\s\S]*?₦126,500/, '2 × 51,500 + 23,500');
  assert.doesNotMatch(res.text, /TEST ORDER/);
  const search = await owner.get(`/businesses/${id}/customers?q=0806`).expect(200);
  assert.match(search.text, /Amaka Bello/);
  assert.doesNotMatch(search.text, /Ngozi Adeyemi/);
});

test('analytics shows real totals and breakdowns', async () => {
  const res = await owner.get(`/businesses/${id}/analytics?days=30`).expect(200);
  assert.match(res.text, /<div class="n">3<\/div><div class="l">Orders/);
  assert.match(res.text, /<div class="n">₦159,500<\/div><div class="l">Order value/);
  assert.match(res.text, /facebook/);
  assert.match(res.text, /Larose Nigeria \(GitHub Pages\)/);
});

test('other accounts and signed-out visitors cannot open these pages', async () => {
  const other = await signUp(app, { email: 'other@shop.test' });
  for (const p of ['', '/customers', '/analytics']) {
    await other.get(`/businesses/${id}${p}`).expect(404);
    await request(app).get(`/businesses/${id}${p}`).expect(302);
  }
  void csrfToken;
});
