// Email automations: provider setup, processing follow-ups that stop on Delivered, post-purchase
// timing, consent and unsubscribes, safe retries without duplicates, isolation between businesses.
// Emails go to a stand-in provider (never a real one) and only to test addresses.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { setup, resetDatabase, csrfToken, signUp, ORIGIN, openClientSignup } from './helpers.js';
import { runEmailJobs, planMessages, sendDue, retryMessages } from '../src/services/emailAutomation.js';
import { clearOriginCache } from '../src/lib/origins.js';

// Stand-in for Resend: POST /emails. mode: ok | down (500) | reject (422)
const provider = { mode: 'ok', sent: [], keys: new Set() };
const mock = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    if (req.url !== '/emails' || req.headers.authorization !== 'Bearer re_test_key_1234567890') { res.writeHead(401); return res.end('{"message":"bad key"}'); }
    if (provider.mode === 'down') { res.writeHead(500); return res.end('{"message":"internal error"}'); }
    if (provider.mode === 'reject') { res.writeHead(422); return res.end('{"message":"The from address domain is not verified"}'); }
    const msg = JSON.parse(body);
    provider.sent.push({ ...msg, idem: req.headers['idempotency-key'] });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id: `msg_${provider.sent.length}` }));
  });
});
await new Promise((r) => mock.listen(0, r));

const key = randomBytes(32);
const { pool, app, config } = setup({ encryptionKey: key, emailApiBase: `http://127.0.0.1:${mock.address().port}` });
let owner;
let other;
const B = {};
let n = 0;

const jobs = () => runEmailJobs(pool, config);
const base = (b) => `/businesses/${b.id}`;
async function post(agent, b, path, body = {}) {
  const _csrf = await csrfToken(agent, `${base(b)}/email`);
  return agent.post(`${base(b)}${path}`).type('form').send({ _csrf, ...body });
}
const placeOrder = async (b, name, email, extra = {}) => {
  const res = await request(app).post('/api/public/orders').set('Origin', ORIGIN).send({
    landingPage: b.slug, idempotencyKey: `email-test-key-${String(n += 1).padStart(6, '0')}`,
    customer: { name, phone: '08051234567', address: '3 Test Close, Ikeja', state: 'Lagos', email, ...extra }, items: [{ product: b.code, quantity: 2 }],
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return (await pool.query('SELECT * FROM orders WHERE reference = $1', [res.body.reference])).rows[0];
};
const setStatus = (agent, b, orderId, status) => post(agent, b, `/orders/${orderId}/status`, { kind: 'fulfillment', status });
const messagesFor = async (orderId) => (await pool.query(
  'SELECT m.*, s.delay_days FROM email_messages m LEFT JOIN email_automation_steps s ON s.id = m.step_id WHERE m.order_id = $1 ORDER BY s.delay_days, m.id', [orderId])).rows;
const makeDue = (where, params = []) => pool.query(`UPDATE email_messages SET scheduled_for = now() - interval '1 minute' WHERE ${where}`, params);
const sentTo = (email) => provider.sent.filter((m) => m.to[0] === email);

async function makeBusiness(agent, name, slug, code) {
  const _csrf = await csrfToken(agent, '/?all=1');
  const res = await agent.post('/businesses').type('form').send({ _csrf, name }).expect(302);
  const id = Number(res.headers.location.match(/businesses\/(\d+)/)[1]);
  await pool.query("UPDATE businesses SET subscription_status = 'active', subscription_expires_on = NULL WHERE id = $1", [id]);
  const p = (await pool.query('INSERT INTO products (business_id, code, name, price_minor) VALUES ($1, $2, $3, 1000000) RETURNING id', [id, code, `${name} serum`])).rows[0].id;
  const lp = (await pool.query("INSERT INTO landing_pages (business_id, slug, name, url, status) VALUES ($1, $2, $3, $4, 'active') RETURNING id", [id, slug, `${name} page`, `${ORIGIN}/${slug}/`])).rows[0].id;
  await pool.query('INSERT INTO landing_page_products (landing_page_id, product_id) VALUES ($1, $2)', [lp, p]);
  return { id, slug, code, name };
}

before(async () => {
  await resetDatabase(pool);
  owner = await signUp(app, { name: 'Shop Owner', email: 'owner@shop.test' });
  await openClientSignup(pool);
  other = await signUp(app, { name: 'Other Owner', email: 'owner@other.test' });
  Object.assign(B, { one: await makeBusiness(owner, 'Glow One', 'glow-one', 'serum-one'), two: await makeBusiness(other, 'Beauty Two', 'beauty-two', 'serum-two') });
  clearOriginCache();
});
after(async () => { await pool.end(); mock.close(); });

describe('sending setup', () => {
  test('without a provider, nothing can be activated and the setup requirement is shown', async () => {
    const page = await owner.get(`${base(B.one)}/email`).expect(200);
    assert.match(page.text, /Email sending is not set up yet/);
    const created = await post(owner, B.one, '/email/automations', { preset: 'processing' });
    const id = created.headers.location.match(/automations\/(\d+)/)[1];
    const res = await post(owner, B.one, `/email/automations/${id}/status`, { action: 'activate' });
    assert.equal(res.status, 400);
    assert.match(res.text, /Set up email sending first/);
    await pool.query('DELETE FROM email_automations WHERE id = $1', [id]);
  });

  test('the provider key is checked, stored encrypted and never shown; a test email goes through the provider', async () => {
    const bad = await post(owner, B.one, '/email/settings', { provider: 'resend', api_key: 'not-a-key', from_email: 'orders@glow.test' });
    assert.match(decodeURIComponent(bad.headers.location), /does not look like a Resend API key/);
    await post(owner, B.one, '/email/settings', { provider: 'resend', api_key: 're_test_key_1234567890', from_email: 'orders@glow.test', from_name: 'Glow One', reply_to: 'help@glow.test' });
    const { rows: [s] } = await pool.query('SELECT * FROM email_settings WHERE business_id = $1', [B.one.id]);
    assert.ok(!s.api_key_enc.includes('re_test_key'));
    const page = await owner.get(`${base(B.one)}/email?tab=setup`).expect(200);
    assert.ok(!page.text.includes('re_test_key_1234567890'));
    assert.match(page.text, /…7890/);
    const res = await post(owner, B.one, '/email/settings/test', { to: 'me@owner.test' });
    assert.match(res.headers.location, /done=test/);
    assert.equal(sentTo('me@owner.test').length, 1);
    assert.match(sentTo('me@owner.test')[0].subject, /^\[TEST\]/);
    assert.equal(sentTo('me@owner.test')[0].from, 'Glow One <orders@glow.test>');
  });

  test('a provider refusal is shown with its reason, and nothing is marked as sent', async () => {
    provider.mode = 'reject';
    const res = await post(owner, B.one, '/email/settings/test', { to: 'me@owner.test' });
    provider.mode = 'ok';
    assert.match(decodeURIComponent(res.headers.location), /refused the email \(HTTP 422: The from address domain is not verified\)/);
    const { rows: [m] } = await pool.query("SELECT status FROM email_messages WHERE kind = 'test' ORDER BY id DESC LIMIT 1");
    assert.equal(m.status, 'failed');
  });
});

describe('A. order still processing', () => {
  let automationId;
  before(async () => {
    const created = await post(owner, B.one, '/email/automations', { preset: 'processing' });
    automationId = created.headers.location.match(/automations\/(\d+)/)[1];
    const page = await owner.get(`${base(B.one)}/email/automations/${automationId}`).expect(200);
    assert.match(page.text, /Day 1 at 10:00[\s\S]*Day 2 at 10:00[\s\S]*Day 3 at 10:00/);
    assert.doesNotMatch(page.text, /has been (shipped|dispatched|delivered)/i, 'starter messages never claim shipping');
    await post(owner, B.one, `/email/automations/${automationId}/status`, { action: 'activate' });
  });

  test('orders that were already processing before activation get nothing; new ones get day 1, 2, 3 at 10:00 Lagos time', async () => {
    const o = await placeOrder(B.one, 'Ada Processing', 'ada@customer.test');
    await jobs();
    assert.equal((await messagesFor(o.id)).length, 0, 'nothing while pending');
    await setStatus(owner, B.one, o.id, 'processing');
    await jobs();
    const msgs = await messagesFor(o.id);
    assert.deepEqual(msgs.map((m) => [m.delay_days, m.status]), [[1, 'queued'], [2, 'queued'], [3, 'queued']]);
    const { rows: hours } = await pool.query("SELECT extract(hour FROM scheduled_for AT TIME ZONE 'Africa/Lagos')::int AS h, (scheduled_for AT TIME ZONE 'Africa/Lagos')::date - (now() AT TIME ZONE 'Africa/Lagos')::date AS d FROM email_messages WHERE order_id = $1 ORDER BY scheduled_for", [o.id]);
    assert.deepEqual(hours.map((h) => [h.d, h.h]), [[1, 10], [2, 10], [3, 10]]);
    assert.equal(sentTo('ada@customer.test').length, 0, 'nothing is sent before its time');
  });

  test('day 1 is sent through the provider (once), with the order details and an unsubscribe link', async () => {
    const { rows: [o] } = await pool.query("SELECT * FROM orders WHERE customer_name = 'Ada Processing'");
    await makeDue("order_id = $1 AND step_id = (SELECT min(step_id) FROM email_messages WHERE order_id = $1)", [o.id]);
    await jobs();
    await jobs();
    const mails = sentTo('ada@customer.test');
    assert.equal(mails.length, 1);
    assert.equal(mails[0].subject, `Your order ${o.reference} is being prepared`);
    assert.match(mails[0].text, /Hi Ada,/);
    assert.match(mails[0].text, /Glow One serum x2/);
    assert.match(mails[0].text, /Unsubscribe: http:\/\/skyfly\.test\/u\/[0-9a-f]{64}/);
    assert.equal(mails[0].headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
    assert.match(mails[0].idem, /^auto:\d+:\d+$/, 'provider idempotency key');
    const [first] = await messagesFor(o.id);
    assert.equal(first.status, 'sent');
    assert.equal(first.provider_message_id, `msg_${provider.sent.length}`);
  });

  test('changing the order to Delivered stops the remaining processing follow-ups at once', async () => {
    const { rows: [o] } = await pool.query("SELECT * FROM orders WHERE customer_name = 'Ada Processing'");
    await setStatus(owner, B.one, o.id, 'delivered');
    const msgs = await messagesFor(o.id);
    assert.deepEqual(msgs.map((m) => [m.delay_days, m.status, m.reason]), [[1, 'sent', null], [2, 'cancelled', 'Order is now delivered'], [3, 'cancelled', 'Order is now delivered']]);
    await makeDue('order_id = $1', [o.id]);
    await jobs();
    assert.equal(sentTo('ada@customer.test').length, 1, 'no further emails');
  });

  test('changing the order to Cancelled in the dashboard stops its follow-ups at once', async () => {
    const o = await placeOrder(B.one, 'Cancel Me', 'cancel@customer.test');
    await setStatus(owner, B.one, o.id, 'processing');
    await jobs();
    assert.equal((await messagesFor(o.id)).filter((m) => m.status === 'queued').length, 3);
    await setStatus(owner, B.one, o.id, 'cancelled');
    assert.ok((await messagesFor(o.id)).every((m) => m.status === 'cancelled' && m.reason === 'Order is now cancelled'));
    await makeDue('order_id = $1', [o.id]);
    await jobs();
    assert.equal(sentTo('cancel@customer.test').length, 0);
  });

  test('the latest status is checked again right before sending', async () => {
    const o = await placeOrder(B.one, 'Bisi Recheck', 'bisi@customer.test');
    await setStatus(owner, B.one, o.id, 'processing');
    await jobs();
    // Changed without going through the dashboard (e.g. another tool): the send-time check catches it.
    await pool.query("UPDATE orders SET status = 'cancelled' WHERE id = $1", [o.id]);
    await makeDue('order_id = $1', [o.id]);
    await sendDue(pool, config);
    assert.equal(sentTo('bisi@customer.test').length, 0);
    assert.ok((await messagesFor(o.id)).every((m) => m.status === 'cancelled' && /Cancelled/.test(m.reason)));
  });

  test('pausing holds emails; stopping cancels them; planning twice never makes duplicates', async () => {
    const o = await placeOrder(B.one, 'Chi Pause', 'chi@customer.test');
    await setStatus(owner, B.one, o.id, 'processing');
    await jobs();
    await planMessages(pool);
    await planMessages(pool);
    assert.equal((await messagesFor(o.id)).length, 3);
    await post(owner, B.one, `/email/automations/${automationId}/status`, { action: 'pause' });
    await makeDue('order_id = $1', [o.id]);
    await sendDue(pool, config);
    assert.equal(sentTo('chi@customer.test').length, 0);
    assert.ok((await messagesFor(o.id)).every((m) => m.status === 'queued'));
    await post(owner, B.one, `/email/automations/${automationId}/status`, { action: 'stop' });
    assert.ok((await messagesFor(o.id)).every((m) => m.status === 'cancelled' && m.reason === 'Automation stopped'));
  });
});

describe('B. post-purchase follow-up', () => {
  let automationId;
  let o;
  before(async () => {
    const created = await post(owner, B.one, '/email/automations', { preset: 'post_purchase' });
    automationId = created.headers.location.match(/automations\/(\d+)/)[1];
    await post(owner, B.one, `/email/automations/${automationId}/status`, { action: 'activate' });
    o = await placeOrder(B.one, 'Dayo Delivered', 'dayo@customer.test');
    await setStatus(owner, B.one, o.id, 'delivered');
    // Delivered 7 days ago (and the automation was already active then).
    await pool.query("UPDATE order_status_history SET created_at = now() - interval '7 days 1 hour' WHERE order_id = $1 AND to_status = 'delivered'", [o.id]);
    await pool.query("UPDATE email_automations SET activated_at = now() - interval '8 days' WHERE id = $1", [automationId]);
  });

  test('messages are scheduled 7, 10 and 30 days after delivery; day 7 is sent now', async () => {
    await jobs();
    const msgs = await messagesFor(o.id);
    assert.deepEqual(msgs.map((m) => [m.delay_days, m.purpose]), [[7, 'operational'], [10, 'operational'], [30, 'marketing']]);
    const { rows: due } = await pool.query(
      `SELECT s.delay_days, (m.scheduled_for AT TIME ZONE 'Africa/Lagos')::date - (h.created_at AT TIME ZONE 'Africa/Lagos')::date AS days
         FROM email_messages m JOIN email_automation_steps s ON s.id = m.step_id
         JOIN order_status_history h ON h.order_id = m.order_id AND h.to_status = 'delivered' WHERE m.order_id = $1 ORDER BY s.delay_days`, [o.id]);
    assert.deepEqual(due.map((d) => d.days), [7, 10, 30]);
    // Day 7 at 10:00 has passed or is today; make it due if it is later today.
    await makeDue('order_id = $1 AND step_id = (SELECT id FROM email_automation_steps WHERE automation_id = $2 AND delay_days = 7)', [o.id, automationId]);
    await jobs();
    assert.equal(sentTo('dayo@customer.test').length, 1);
    assert.match(sentTo('dayo@customer.test')[0].subject, /Getting the best from your/);
  });

  test('a marketing step is skipped without consent, and sent once consent is recorded', async () => {
    await makeDue('order_id = $1', [o.id]);
    await pool.query("UPDATE email_messages SET status = 'queued' WHERE order_id = $1 AND status <> 'sent'", [o.id]);
    await jobs();
    const msgs = await messagesFor(o.id);
    assert.deepEqual(msgs.map((m) => [m.delay_days, m.status]), [[7, 'sent'], [10, 'sent'], [30, 'skipped']]);
    assert.equal(msgs[2].reason, 'No marketing consent from this contact');
    // A customer who ticked "send me offers" at checkout.
    const o2 = await placeOrder(B.one, 'Efe Consent', 'efe@customer.test', { marketingConsent: true });
    await setStatus(owner, B.one, o2.id, 'delivered');
    await pool.query("UPDATE order_status_history SET created_at = now() - interval '31 days' WHERE order_id = $1 AND to_status = 'delivered'", [o2.id]);
    await pool.query("UPDATE email_automations SET activated_at = now() - interval '40 days' WHERE id = $1", [automationId]);
    await jobs();
    await makeDue('order_id = $1', [o2.id]);
    await jobs();
    const mails = sentTo('efe@customer.test');
    assert.ok(mails.some((m) => m.subject === 'A thank-you from Glow One'), 'marketing email sent with consent');
    assert.match(mails.find((m) => m.subject === 'A thank-you from Glow One').text, /Glow One/);
  });

  test('unsubscribing (link or one-click) stops every automated email to that contact', async () => {
    const o3 = await placeOrder(B.one, 'Femi Unsub', 'femi@customer.test', { marketingConsent: true });
    await setStatus(owner, B.one, o3.id, 'delivered');
    await jobs();
    const { rows: [c] } = await pool.query("SELECT unsubscribe_token FROM email_contacts WHERE email = 'femi@customer.test'");
    const page = await request(app).get(`/u/${c.unsubscribe_token}`).expect(200);
    assert.match(page.text, /Stop automated emails from <strong>Glow One/);
    await request(app).post(`/u/${c.unsubscribe_token}`).type('form').send('List-Unsubscribe=One-Click').expect(200);
    await makeDue('order_id = $1', [o3.id]);
    await jobs();
    assert.equal(sentTo('femi@customer.test').length, 0);
    assert.ok((await messagesFor(o3.id)).every((m) => m.status === 'skipped' && m.reason === 'Contact unsubscribed'));
    const contacts = await owner.get(`${base(B.one)}/email-contacts?filter=unsubscribed`).expect(200);
    assert.match(contacts.text, /femi@customer\.test/);
  });
});

describe('failures and retries', () => {
  let automationId;
  before(async () => {
    const created = await post(owner, B.one, '/email/automations', { preset: 'processing' });
    automationId = created.headers.location.match(/automations\/(\d+)/)[1];
    await post(owner, B.one, `/email/automations/${automationId}/status`, { action: 'activate' });
  });

  test('a provider outage is retried automatically, then shown as failed; "Retry" sends it exactly once', async () => {
    const o = await placeOrder(B.one, 'Gbenga Retry', 'gbenga@customer.test');
    await setStatus(owner, B.one, o.id, 'processing');
    await jobs();
    const [day1] = await messagesFor(o.id);
    await makeDue('id = $1', [day1.id]);
    provider.mode = 'down';
    for (let i = 0; i < 4; i += 1) {
      await pool.query('UPDATE email_messages SET next_attempt_at = now() WHERE id = $1', [day1.id]);
      await sendDue(pool, config);
    }
    let m = (await pool.query('SELECT * FROM email_messages WHERE id = $1', [day1.id])).rows[0];
    assert.equal(m.status, 'failed');
    assert.equal(m.attempts, 4);
    assert.match(m.reason, /HTTP 500/);
    const history = await owner.get(`${base(B.one)}/email?tab=history&status=failed`).expect(200);
    assert.match(history.text, /gbenga@customer\.test[\s\S]*HTTP 500/);
    provider.mode = 'ok';
    const res = await post(owner, B.one, '/email/messages/retry', {});
    assert.match(res.headers.location, /done=retry/);
    await sendDue(pool, config);
    await sendDue(pool, config);
    m = (await pool.query('SELECT * FROM email_messages WHERE id = $1', [day1.id])).rows[0];
    assert.equal(m.status, 'sent');
    assert.equal(sentTo('gbenga@customer.test').length, 1, 'exactly one email');
  });

  test('a provider refusal (4xx) is not retried automatically', async () => {
    const o = await placeOrder(B.one, 'Hauwa Reject', 'hauwa@customer.test');
    await setStatus(owner, B.one, o.id, 'processing');
    await jobs();
    const [day1] = await messagesFor(o.id);
    await makeDue('id = $1', [day1.id]);
    provider.mode = 'reject';
    await sendDue(pool, config);
    provider.mode = 'ok';
    const m = (await pool.query('SELECT * FROM email_messages WHERE id = $1', [day1.id])).rows[0];
    assert.equal(m.status, 'failed');
    assert.equal(m.attempts, 1);
    assert.match(m.reason, /HTTP 422/);
  });

  test('an email whose outcome is unknown (server stopped mid-send) is never resent without confirmation', async () => {
    const o = await placeOrder(B.one, 'Ike Unknown', 'ike@customer.test');
    await setStatus(owner, B.one, o.id, 'processing');
    await jobs();
    const [day1] = await messagesFor(o.id);
    await pool.query("UPDATE email_messages SET status = 'sending', scheduled_for = now() - interval '1 hour', updated_at = now() - interval '20 minutes' WHERE id = $1", [day1.id]);
    await sendDue(pool, config);
    let m = (await pool.query('SELECT * FROM email_messages WHERE id = $1', [day1.id])).rows[0];
    assert.equal(m.status, 'failed');
    assert.equal(m.outcome_unknown, true);
    assert.equal(await retryMessages(pool, B.one.id, { messageId: day1.id }), 0, 'plain retry leaves it alone');
    assert.equal(await retryMessages(pool, B.one.id, { messageId: day1.id, includeUnknown: true }), 1);
    await sendDue(pool, config);
    m = (await pool.query('SELECT * FROM email_messages WHERE id = $1', [day1.id])).rows[0];
    assert.equal(m.status, 'sent');
    assert.equal(sentTo('ike@customer.test').length, 1);
  });

  test('when a subscription expires, queued emails are skipped (not sent) and nothing is deleted', async () => {
    const o = await placeOrder(B.one, 'Jide Expired', 'jide@customer.test');
    await setStatus(owner, B.one, o.id, 'processing');
    await jobs();
    await pool.query("UPDATE businesses SET subscription_status = 'expired' WHERE id = $1", [B.one.id]);
    await makeDue('order_id = $1', [o.id]);
    await sendDue(pool, config);
    await pool.query("UPDATE businesses SET subscription_status = 'active' WHERE id = $1", [B.one.id]);
    assert.equal(sentTo('jide@customer.test').length, 0);
    assert.ok((await messagesFor(o.id)).every((m) => m.status === 'skipped' && /subscription is not active/.test(m.reason)));
  });
});

describe('templates and isolation', () => {
  test('templates: unknown placeholders are refused; preview shows the real text; test send uses the template', async () => {
    const bad = await post(owner, B.one, '/email/templates', { name: 'Bad', subject: 'Hi {{nmae}}', body: 'Hello' });
    assert.equal(bad.status, 400);
    assert.match(bad.text, /Unknown placeholder: \{\{nmae\}\}/);
    const ok = await post(owner, B.one, '/email/templates', { name: 'Thanks', subject: 'Thanks {{first_name}}', body: 'Your order {{order_reference}} for {{order_total}}.' });
    const id = ok.headers.location.match(/templates\/(\d+)/)[1];
    const page = await owner.get(`${base(B.one)}/email/templates/${id}`).expect(200);
    assert.match(page.text, /Thanks Ada/);
    assert.match(page.text, /XX-SAMPLE1 for \$25,000/, "the business's own currency");
    await post(owner, B.one, `/email/templates/${id}/test`, { to: 'me@owner.test' });
    assert.equal(sentTo('me@owner.test').at(-1).subject, '[TEST] Thanks Ada');
  });

  test('another business cannot see or use these templates, automations or contacts, and gets no emails from them', async () => {
    const { rows: [t] } = await pool.query('SELECT id FROM email_templates WHERE business_id = $1 LIMIT 1', [B.one.id]);
    const { rows: [a] } = await pool.query('SELECT id FROM email_automations WHERE business_id = $1 LIMIT 1', [B.one.id]);
    await other.get(`${base(B.one)}/email`).expect(404);
    await other.get(`${base(B.two)}/email/templates/${t.id}`).expect(404);
    await other.get(`${base(B.two)}/email/automations/${a.id}`).expect(404);
    // Business two sets up its own automation and tries to use business one's template in a step.
    await post(other, B.two, '/email/settings', { provider: 'resend', api_key: 're_test_key_1234567890', from_email: 'hello@beauty.test' });
    const created = await post(other, B.two, '/email/automations', { preset: 'processing' });
    const twoAuto = created.headers.location.match(/automations\/(\d+)/)[1];
    const steal = await post(other, B.two, `/email/automations/${twoAuto}/steps`, { delay_days: '5', send_hour: '10', template_id: String(t.id) });
    assert.equal(steal.status, 400);
    await post(other, B.two, `/email/automations/${twoAuto}/status`, { action: 'activate' });
    const before = provider.sent.length;
    const o = await placeOrder(B.two, 'Kemi Two', 'kemi@customer.test');
    await setStatus(other, B.two, o.id, 'processing');
    await jobs();
    await makeDue('order_id = $1', [o.id]);
    await jobs();
    const mine = provider.sent.slice(before);
    assert.ok(mine.length >= 1);
    assert.ok(mine.every((m) => m.to[0] === 'kemi@customer.test' && m.from.includes('hello@beauty.test')), 'business two emails only its own customers, from its own sender');
    const { rows } = await pool.query('SELECT DISTINCT business_id FROM email_messages WHERE order_id = $1', [o.id]);
    assert.deepEqual(rows.map((r) => r.business_id), [B.two.id]);
  });
});

describe('follow-ups counted from the order date (customers who ordered 7, 10 or 30 days ago)', () => {
  let automationId;
  before(async () => {
    const created = await post(owner, B.one, '/email/automations', { preset: 'post_purchase' });
    automationId = created.headers.location.match(/automations\/(\d+)/)[1];
    await post(owner, B.one, `/email/automations/${automationId}`, { name: 'After ordering', anchor: 'order_date' });
    await post(owner, B.one, `/email/automations/${automationId}/status`, { action: 'activate' });
    await pool.query("UPDATE email_automations SET activated_at = now() - interval '60 days' WHERE id = $1", [automationId]);
  });
  const planned = async (orderId) => (await pool.query(
    `SELECT s.delay_days, (m.scheduled_for AT TIME ZONE 'Africa/Lagos')::date - (o.created_at AT TIME ZONE 'Africa/Lagos')::date AS days
       FROM email_messages m JOIN email_automation_steps s ON s.id = m.step_id JOIN orders o ON o.id = m.order_id
      WHERE m.order_id = $1 AND m.automation_id = $2 ORDER BY s.delay_days`, [orderId, automationId])).rows;

  test('days are counted from the order\'s real timestamp; planning again never duplicates; stale steps are not sent late', async () => {
    const recent = await placeOrder(B.one, 'Ola Seven', 'ola@customer.test');
    const old = await placeOrder(B.one, 'Ada Forty', 'ada@customer.test');
    await pool.query("UPDATE orders SET created_at = now() - interval '7 days 1 hour' WHERE id = $1", [recent.id]);
    await pool.query("UPDATE orders SET created_at = now() - interval '40 days' WHERE id = $1", [old.id]);
    await jobs();
    await jobs();
    const r = await planned(recent.id);
    assert.deepEqual(r.map((m) => [m.delay_days, m.days]), [[7, 7], [10, 10], [30, 30]], 'one message per step, on order date + N days');
    assert.deepEqual(await planned(old.id), [], 'an order from 40 days ago gets no late day-7/10/30 emails');
  });
});
