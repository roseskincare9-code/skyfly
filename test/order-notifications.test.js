// Order workflow: connect a page, choose where its orders go, and email the business for every
// saved order (to its own verified address only; once per order; an email problem never touches
// the order). The email provider is a stand-in: nothing leaves this machine.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { setup, resetDatabase, signUp, csrfToken, openClientSignup, ORIGIN } from './helpers.js';
import { seedLarose } from '../src/scripts/seed-larose.js';
import { clearOriginCache } from '../src/lib/origins.js';
import { runEmailJobs } from '../src/services/emailAutomation.js';
import { formatMoney } from '../src/lib/money.js';

const mail = []; let mode = 'ok';
const mock = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const msg = JSON.parse(body || '{}');
    if (mode === 'down') { res.writeHead(503, { 'Content-Type': 'application/json' }); return res.end('{"message":"Service unavailable"}'); }
    if (mode === 'refused') { res.writeHead(422, { 'Content-Type': 'application/json' }); return res.end('{"message":"Invalid from address"}'); }
    mail.push({ ...msg, idempotencyKey: req.headers['idempotency-key'] });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id: `email_${mail.length}` }));
  });
});
await new Promise((r) => mock.listen(0, r));
const PAGES = {};
const { pool, app, config } = setup({
  encryptionKey: randomBytes(32), emailApiBase: `http://127.0.0.1:${mock.address().port}`, publicBaseUrl: 'https://skyfly.test',
  notifyEmail: { provider: 'resend', apiKey: 're_test_0123456789abcdef', fromEmail: 'orders@skyfly.test', fromName: 'Skyfly' },
  urlImportGet: async (u) => (PAGES[u.href] ? { body: Buffer.from(PAGES[u.href]) } : { body: Buffer.from('<html><body>No Skyfly here</body></html>') }),
});
const run = () => runEmailJobs(pool, config);
let owner; let larose; let n = 0;
// Package 3 × 2 at Skyfly's current price (the test does not depend on a particular price).
const twoPackage3 = async () => 2 * Number((await pool.query("SELECT price_minor FROM products WHERE business_id = $1 AND code = 'package-3'", [larose])).rows[0].price_minor);
const order = (fields = {}, origin = ORIGIN) => request(app).post('/api/public/orders').set('Origin', origin).send({
  landingPage: 'larosenigeria', idempotencyKey: `order-notify-${String(n += 1).padStart(6, '0')}`,
  customer: { name: 'Ngozi Eze', phone: '08031112222', address: '5 Allen Avenue, Ikeja', state: 'Lagos', email: 'ngozi@example.test' },
  items: [{ product: 'package-3', quantity: 2 }], ...fields,
});
const notification = async (reference) => (await pool.query(
  "SELECT m.* FROM email_messages m JOIN orders o ON o.id = m.order_id WHERE o.reference = $1 AND m.kind = 'order_notification'", [reference])).rows;
function post(agent, path, fields, from = path) {
  const p = csrfToken(agent, from).then((_csrf) => agent.post(path).type('form').send({ _csrf, ...fields }));
  p.expect = (status) => p.then((res) => { assert.equal(res.status, status, `${path}: HTTP ${res.status}`); return res; });
  return p;
}
async function verify(agent, businessId) {
  const before = mail.length;
  await post(agent, `/businesses/${businessId}/settings/notifications/verify`, {}, `/businesses/${businessId}/settings`).expect(302);
  const link = mail[before].text.match(/https:\/\/skyfly\.test(\/notify\/verify\/[A-Za-z0-9_-]+)/)[1];
  const page = await request(app).get(link).expect(200);
  assert.match(page.text, /Confirm order notifications/);
  await request(app).post(link).type('form').send({}).expect(200);
  return mail[before];
}

before(async () => {
  await resetDatabase(pool);
  owner = await signUp(app, { email: 'laroseskincare3@gmail.com' });
  larose = await seedLarose(pool, 'laroseskincare3@gmail.com');
  await openClientSignup(pool);
  clearOriginCache();
});
after(async () => { await pool.end(); mock.close(); });
// Each test starts with the stand-in provider working (a failed test must not break the next).
import { beforeEach } from 'node:test';
beforeEach(() => { mode = 'ok'; });

describe('Larose: notifications to its own verified address', () => {
  test('an address is set per business and must be verified before any order email is sent', async () => {
    await post(owner, `/businesses/${larose}/settings/notifications`, { notify_email: 'LaroseSkincare3@gmail.com', notify_enabled: 'on' }, `/businesses/${larose}/settings`).expect(302);
    const settings = await owner.get(`/businesses/${larose}/settings`).expect(200);
    assert.match(settings.text, /laroseskincare3@gmail\.com/);
    assert.match(settings.text, /Not verified/);
    const res = await order().expect(201);
    await run();
    assert.equal(mail.length, 0, 'nothing sent to an unverified address');
    const [m] = await notification(res.body.reference);
    assert.deepEqual([m.status, m.reason], ['skipped', 'laroseskincare3@gmail.com is not verified yet (Settings → Order notifications)']);
    const v = await verify(owner, larose);
    assert.deepEqual(v.to, ['laroseskincare3@gmail.com']);
    assert.match((await owner.get(`/businesses/${larose}/settings`)).text, /Verified/);
  });

  test('a saved order: one email to the Larose address with the order number, date, customer, products, confirmed total and a sign-in link', async () => {
    mail.length = 0;
    const res = await order().expect(201);
    await run();
    assert.equal(mail.length, 1);
    const [e] = mail;
    const { rows: [o] } = await pool.query('SELECT id FROM orders WHERE reference = $1', [res.body.reference]);
    assert.deepEqual(e.to, ['laroseskincare3@gmail.com']);
    const total = formatMoney(await twoPackage3(), 'NGN');
    assert.equal(res.body.total * 100, await twoPackage3(), 'the total Skyfly confirmed');
    assert.equal(e.subject, `New order ${res.body.reference} — ${total}`);
    for (const s of [res.body.reference, 'Ngozi Eze', '+2348031112222', '5 Allen Avenue, Ikeja, Lagos', 'Package 3 – Power Glow × 2', `Total confirmed by Skyfly: ${total}`,
      `https://skyfly.test/businesses/${larose}/orders/${o.id}`, 'Date: ']) assert.ok(e.text.includes(s), `email lacks "${s}"`);
    assert.equal(e.idempotencyKey, `order:${o.id}`, 'the provider sees one key per order');
    const [m] = await notification(res.body.reference);
    assert.deepEqual([m.status, m.to_email, m.provider_message_id], ['sent', 'laroseskincare3@gmail.com', 'email_1']);
    const page = await owner.get(`/businesses/${larose}/orders/${o.id}`).expect(200);
    assert.match(page.text, /Saved in Skyfly/);
    assert.match(page.text, /Accepted by the email provider/);
    assert.match(page.text, /Delivery to the inbox is not confirmed/);
    const list = await owner.get(`/businesses/${larose}/orders`).expect(200);
    assert.match(list.text, /Email: sent ✓/);
  });

  test('the same submission again (double tap, retry) and later job runs: still one email', async () => {
    mail.length = 0;
    const body = { idempotencyKey: 'order-notify-repeat-0001' };
    const a = await order(body).expect(201);
    await order(body).expect(200);
    await run(); await run();
    assert.equal(mail.length, 1);
    assert.equal((await notification(a.body.reference)).length, 1);
  });

  test('a refused order (invalid details, wrong price) sends no email and saves nothing', async () => {
    mail.length = 0;
    const before = (await pool.query('SELECT count(*)::int AS n FROM orders')).rows[0].n;
    await order({ customer: { name: 'X', phone: '1' } }).expect(400);
    await order({ items: [{ product: 'package-3', quantity: 1, unitPrice: 1 }] }).expect(409);
    await run();
    assert.equal(mail.length, 0);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM orders')).rows[0].n, before);
  });

  test('an email failure never touches the order: temporary errors are retried, a refused email is shown as failed and can be resent', async () => {
    mail.length = 0; mode = 'down';
    const res = await order().expect(201);
    await run();
    let [m] = await notification(res.body.reference);
    assert.equal(m.status, 'queued', 'retried later');
    assert.match(m.reason, /Attempt 1 failed/);
    const { rows: [o] } = await pool.query('SELECT id, total_minor FROM orders WHERE reference = $1', [res.body.reference]);
    assert.equal(Number(o.total_minor), await twoPackage3(), 'the order is saved whatever the email does');
    assert.match((await owner.get(`/businesses/${larose}/orders/${o.id}`)).text, /Pending/);
    mode = 'refused';
    await pool.query("UPDATE email_messages SET next_attempt_at = now() WHERE id = $1", [m.id]);
    await run();
    [m] = await notification(res.body.reference);
    assert.equal(m.status, 'failed');
    assert.match((await owner.get(`/businesses/${larose}/orders/${o.id}`)).text, /Failed[\s\S]*Invalid from address/);
    mode = 'ok';
    await post(owner, `/businesses/${larose}/orders/${o.id}/notify-retry`, {}, `/businesses/${larose}/orders/${o.id}`).expect(302);
    await run();
    [m] = await notification(res.body.reference);
    assert.equal(m.status, 'sent');
    assert.equal(mail.length, 1);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM orders WHERE reference = $1', [res.body.reference])).rows[0].n, 1);
  });

  test('a public request cannot choose the recipient', async () => {
    mail.length = 0;
    await order({ notify_email: 'attacker@evil.test', notifyEmail: 'attacker@evil.test', to: 'attacker@evil.test' }).expect(201);
    await run();
    assert.deepEqual(mail.map((e) => e.to[0]), ['laroseskincare3@gmail.com']);
  });

  test('changing the address needs a new verification; turning notifications off stops them', async () => {
    mail.length = 0;
    await post(owner, `/businesses/${larose}/settings/notifications`, { notify_email: 'laroseskincare3@gmail.com' }, `/businesses/${larose}/settings`).expect(302);
    const off = await order().expect(201);
    await run();
    assert.equal(mail.length, 0);
    assert.equal((await notification(off.body.reference))[0].reason, 'Order notifications are turned off');
    await post(owner, `/businesses/${larose}/settings/notifications`, { notify_email: 'new-inbox@larose.test', notify_enabled: 'on' }, `/businesses/${larose}/settings`).expect(302);
    const changed = await order().expect(201);
    await run();
    assert.equal(mail.length, 0, 'the new address is not verified yet');
    assert.match((await notification(changed.body.reference))[0].reason, /new-inbox@larose\.test is not verified/);
    await post(owner, `/businesses/${larose}/settings/notifications`, { notify_email: 'laroseskincare3@gmail.com', notify_enabled: 'on' }, `/businesses/${larose}/settings`).expect(302);
    await verify(owner, larose);
  });
});

describe('a second business: its own page, address, orders and emails', () => {
  let jewels; let jowner;
  test('connects its page (owner, destination, notification email) and verifies its own address', async () => {
    jowner = await signUp(app, { email: 'owner@goldjewels.test' });
    const res = await post(jowner, '/businesses', { name: 'Gold Jewels' }, '/?all=1').expect(302);
    jewels = Number(res.headers.location.match(/businesses\/(\d+)/)[1]);
    await pool.query("UPDATE businesses SET subscription_status = 'active', subscription_expires_on = NULL WHERE id = $1", [jewels]);
    const { rows: [p] } = await pool.query("INSERT INTO products (business_id, code, name, price_minor) VALUES ($1, 'gold-ring', 'Gold ring', 4500000) RETURNING id", [jewels]);
    const form = await jowner.get(`/businesses/${jewels}/landing-pages/new`).expect(200);
    assert.match(form.text, /Connect a landing page/);
    assert.match(form.text, /Order destination/);
    await post(jowner, `/businesses/${jewels}/landing-pages`, {
      name: 'Ring promo', url: 'https://goldjewels.example.com/rings/', slug: 'gold-rings', status: 'active', products: String(p.id),
      order_destination: 'checkout', notify_email: 'orders@goldjewels.example',
    }, `/businesses/${jewels}/landing-pages/new`).expect(302);
    clearOriginCache();
    const { rows: [b] } = await pool.query('SELECT notify_email, notify_verified_at FROM businesses WHERE id = $1', [jewels]);
    assert.deepEqual([b.notify_email, b.notify_verified_at], ['orders@goldjewels.example', null]);
    const v = await verify(jowner, jewels);
    assert.deepEqual(v.to, ['orders@goldjewels.example']);
  });

  test('its orders are emailed to its address only; Larose gets none of them, and neither sees the other', async () => {
    mail.length = 0;
    const res = await request(app).post('/api/public/orders').set('Origin', 'https://goldjewels.example.com').send({
      landingPage: 'gold-rings', idempotencyKey: 'order-notify-jewels-0001',
      customer: { name: 'Bisi Ade', phone: '08035556666', address: '2 Marina, Lagos Island', state: 'Lagos' }, items: [{ product: 'gold-ring', quantity: 1 }],
    }).expect(201);
    assert.equal(res.body.whatsappUrl, null, '"Skyfly checkout" pages show no WhatsApp button');
    await run();
    assert.deepEqual(mail.map((e) => e.to[0]), ['orders@goldjewels.example']);
    assert.match(mail[0].text, /Gold ring × 1/);
    assert.ok(!mail[0].text.includes('Larose'));
    const { rows: [o] } = await pool.query('SELECT id, business_id FROM orders WHERE reference = $1', [res.body.reference]);
    assert.equal(o.business_id, jewels);
    // (The Larose account is also the platform owner, who can open every business; isolation is
    // checked with the other business's own account below.) The order is listed only in its business.
    const laroseList = await owner.get(`/businesses/${larose}/orders?q=${res.body.reference}`).expect(200);
    assert.equal(laroseList.text.split(`>${res.body.reference}<`).length - 1, 0, 'not in Larose\'s orders');
    await jowner.get(`/businesses/${larose}/settings`).expect(404);
    await jowner.get(`/businesses/${larose}/orders`).expect(404);
  });

  test('a page can be added only to a business the user may manage', async () => {
    const r = await post(jowner, `/businesses/${jewels}/landing-pages`, { name: 'Sneaky', url: 'https://evil.example.com/', business_id: String(larose) }, `/businesses/${jewels}/landing-pages/new`);
    assert.equal(r.status, 404);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM landing_pages WHERE name = 'Sneaky'")).rows[0].n, 0);
  });

  test('Test connection: says what is missing, and passes once the page loads Skyfly with its form key', async () => {
    const { rows: [pg] } = await pool.query("SELECT id FROM landing_pages WHERE slug = 'gold-rings'");
    await post(jowner, `/businesses/${jewels}/landing-pages/${pg.id}/test-connection`, {}, `/businesses/${jewels}/landing-pages/${pg.id}`).expect(302);
    let page = await jowner.get(`/businesses/${jewels}/landing-pages/${pg.id}`).expect(200);
    // The order above already verified the connection; the check result is still recorded.
    const { rows: [c] } = await pool.query('SELECT connection_check FROM landing_pages WHERE id = $1', [pg.id]);
    assert.match(c.connection_check, /does not load Skyfly \(skyfly\.test\)/);
    PAGES['https://goldjewels.example.com/rings/'] = '<html><body><script src="https://skyfly.test/sdk/skyfly.js" data-page="gold-rings"></script></body></html>';
    await post(jowner, `/businesses/${jewels}/landing-pages/${pg.id}/test-connection`, {}, `/businesses/${jewels}/landing-pages/${pg.id}`).expect(302);
    assert.equal((await pool.query('SELECT connection_check FROM landing_pages WHERE id = $1', [pg.id])).rows[0].connection_check, 'ok');
    page = await jowner.get(`/businesses/${jewels}/landing-pages/${pg.id}`).expect(200);
    assert.match(page.text, /Orders connected ✓ verified/);
  });
});

describe('order destinations', () => {
  test('WhatsApp direct: the page offers a WhatsApp conversation and Skyfly records no order', async () => {
    await pool.query("UPDATE landing_pages SET order_destination = 'whatsapp' WHERE slug = 'larosenigeria'");
    const cat = await request(app).get('/api/public/pages/larosenigeria/catalog').expect(200);
    assert.equal(cat.body.destination, 'whatsapp');
    assert.ok(cat.body.whatsapp);
    const before = (await pool.query('SELECT count(*)::int AS n FROM orders')).rows[0].n;
    const r = await order().expect(409);
    assert.equal(r.body.error, 'WHATSAPP_ONLY');
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM orders')).rows[0].n, before, 'no confirmed order');
    const sdk = await request(app).get('/sdk/skyfly.js').expect(200);
    assert.match(sdk.text, /Chat on WhatsApp to order/);
    assert.match(sdk.text, /nothing is ordered until then/);
  });

  test('Skyfly checkout + WhatsApp: the order is saved first; the WhatsApp button comes only with the saved reply', async () => {
    await pool.query("UPDATE landing_pages SET order_destination = 'checkout_whatsapp' WHERE slug = 'larosenigeria'");
    const r = await order().expect(201);
    assert.equal(r.body.saved, true);
    assert.match(r.body.whatsappUrl, new RegExp(`^https://wa\\.me/\\d+\\?text=.*${r.body.reference}`));
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM orders WHERE reference = $1', [r.body.reference])).rows[0].n, 1);
  });
});
