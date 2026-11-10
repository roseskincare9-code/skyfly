// Browser check of the drop-in checkout's payment choice on a phone: Payment on Delivery (NGN) or
// Pay online in USD with the business's connected gateways (stand-in Stripe here). Shows the USD total
// before paying, sends the customer to the gateway's page, and the order is paid only after the
// gateway's signed confirmation. Screenshots in test/e2e/screenshots/payments.
//   node --env-file-if-exists=.env.test test/e2e/payments-checkout.e2e.js
import { createServer } from 'node:http';
import { createHmac } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { chromium, devices } from 'playwright-core';
import { setup, resetDatabase } from '../helpers.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const shots = path.join(root, 'test/e2e/screenshots/payments');
mkdirSync(shots, { recursive: true });
const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${srv.address().port}`)));

// Stand-in Stripe: checkout sessions on the connected account, and its hosted page.
const sessions = {};
const gwServer = createServer(async (req, res) => {
  let raw = ''; for await (const c of req) raw += c;
  const p = new URL(req.url, 'http://x').pathname; const form = Object.fromEntries(new URLSearchParams(raw));
  const send = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (p === '/stripe/v1/checkout/sessions') {
    const id = `cs_test_${Object.keys(sessions).length + 1}`;
    let amount = 0; for (let i = 0; form[`line_items[${i}][quantity]`]; i += 1) amount += Number(form[`line_items[${i}][quantity]`]) * Number(form[`line_items[${i}][price_data][unit_amount]`]);
    sessions[id] = { id, account: req.headers['stripe-account'], amount_total: amount, currency: 'usd', payment_status: 'unpaid', status: 'open', payment_intent: 'pi_1', success_url: form.success_url };
    return send({ id, url: `${GW}/pay/${id}` });
  }
  if (p.startsWith('/stripe/v1/checkout/sessions/')) return send(sessions[p.split('/').pop()]);
  if (p.startsWith('/pay/')) { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(`<h1>Stripe test checkout</h1><p id="amt">$${(sessions[p.split('/').pop()].amount_total / 100).toFixed(2)}</p>`); }
  send({});
});
const GW = await listen(gwServer);

const WHSEC = 'whsec_e2e';
const payments = { stripe: { secretKey: 'sk_test_e2e', clientId: 'ca_e2e', webhookSecret: WHSEC, mode: 'test', apiBase: `${GW}/stripe`, connectBase: `${GW}/connect` } };
let SHOP;
const shopServer = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Laros</title></head>
<body style="font-family:sans-serif;margin:0"><header style="padding:16px;background:#f3eefe"><h1>Laros Glow Serum</h1></header>
<div data-skyfly-checkout="laros-page"></div><script src="${DASH}/sdk/skyfly.js" data-api="${DASH}" data-page="laros-page"></script></body></html>`);
});
SHOP = await listen(shopServer);
const { pool, app } = setup({ payments, allowedOrigins: [SHOP] });
const DASH = await listen(createServer(app));

await resetDatabase(pool);
const { rows: [u] } = await pool.query("INSERT INTO users (email, password_hash, name) VALUES ('owner@laros.test', 'x', 'Owner') RETURNING id");
const { rows: [b] } = await pool.query("INSERT INTO businesses (owner_id, name, slug, currency, usd_delivery_fee_minor) VALUES ($1, 'Laros Skincare', 'laros', 'NGN', 500) RETURNING id", [u.id]);
await pool.query("INSERT INTO business_members (business_id, user_id, role) VALUES ($1, $2, 'owner')", [b.id, u.id]);
const { rows: [lp] } = await pool.query("INSERT INTO landing_pages (business_id, slug, name, url, status, order_destination) VALUES ($1, 'laros-page', 'Laros', $2, 'active', 'checkout') RETURNING id", [b.id, `${SHOP}/`]);
const { rows: [pr] } = await pool.query("INSERT INTO products (business_id, code, name, price_minor, usd_price_minor) VALUES ($1, 'serum', 'Glow Serum', 2500000, 1999) RETURNING id", [b.id]);
await pool.query('INSERT INTO landing_page_products (landing_page_id, product_id) VALUES ($1, $2)', [lp.id, pr.id]);
await pool.query("INSERT INTO payment_connections (business_id, provider, status, account_id, mode, enabled, connected_at) VALUES ($1, 'stripe', 'connected', 'acct_LAROS', 'test', true, now())", [b.id]);

const browser = await chromium.launch();
let failed = false;
const step = async (name, fn) => { try { await fn(); console.log(`  ✓ ${name}`); } catch (err) { failed = true; console.log(`  ✗ ${name}: ${err.message.split('\n')[0]}`); } };
try {
  const ctx = await browser.newContext({ ...devices['iPhone 13'] });
  const page = await ctx.newPage();
  await page.goto(SHOP);
  await step('the checkout loads with the package in NGN', async () => {
    await page.waitForSelector('[data-skyfly-checkout] form', { timeout: 10000 });
    assert.match(await page.textContent('[data-skyfly-checkout]'), /₦25,000/);
  });
  await step('details → review shows both payment options, COD in NGN and Pay online in USD', async () => {
    await page.fill('[name=name]', 'Ada Obi'); await page.fill('[name=phone]', '08031234567');
    await page.fill('[name=address]', '12 Allen Avenue, Ikeja'); await page.fill('[name=email]', 'ada@example.test').catch(() => {});
    await page.click('[data-skyfly-checkout] form [type=submit]');
    await page.waitForSelector('[data-skyfly-payment]');
    const t = await page.textContent('[data-skyfly-payment]');
    assert.match(t, /Payment on Delivery[\s\S]*₦25,000/);
    assert.match(t, /Pay online in USD[\s\S]*\$24\.99 USD/);
    await page.screenshot({ path: path.join(shots, '1-payment-choice.png'), fullPage: true });
  });
  await step('choosing Pay online shows Stripe and the exact USD amount before paying', async () => {
    await page.check('input[name=sky_pay][value=online]');
    await page.waitForSelector('input[name=sky_gw][value=stripe]');
    const txt = await page.textContent('[data-skyfly-payment]');
    assert.match(txt.replace(/\s+/g, ' '), /charged \$24\.99 USD/, txt);
    assert.match(await page.textContent('[data-place]'), /Continue to secure payment/);
    assert.equal(await page.textContent('[data-review-total]'), '$24.99 USD', 'the review total is what is charged');
    await page.screenshot({ path: path.join(shots, '2-pay-online.png'), fullPage: true });
  });
  await step('placing the order opens the gateway page for $24.99 on Laros\'s account; the order is pending', async () => {
    await Promise.all([page.waitForURL(/\/pay\/cs_test_/), page.click('[data-place]')]);
    assert.equal(await page.textContent('#amt'), '$24.99');
    const s = Object.values(sessions).at(-1);
    assert.equal(s.account, 'acct_LAROS');
    const { rows: [o] } = await pool.query("SELECT payment_status, currency, total_minor FROM orders ORDER BY id DESC LIMIT 1");
    assert.deepEqual([o.payment_status, o.currency, Number(o.total_minor)], ['pending', 'USD', 2499]);
  });
  await step('after Stripe\'s signed confirmation the confirmation page shows "Paid online"', async () => {
    const s = Object.values(sessions).at(-1); s.payment_status = 'paid';
    const body = JSON.stringify({ id: 'evt_e2e', type: 'checkout.session.completed', account: 'acct_LAROS', data: { object: s } });
    const t = Math.floor(Date.now() / 1000);
    const r = await fetch(`${DASH}/webhooks/stripe`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Stripe-Signature': `t=${t},v1=${createHmac('sha256', WHSEC).update(`${t}.${body}`).digest('hex')}` }, body });
    assert.equal((await r.json()).outcome, 'paid');
    await page.goto(s.success_url.replace('{CHECKOUT_SESSION_ID}', s.id).replace('http://skyfly.test', DASH));
    await page.waitForSelector('[data-payment="paid"]');
    await page.screenshot({ path: path.join(shots, '3-paid.png'), fullPage: true });
  });
} finally {
  await browser.close(); gwServer.close(); shopServer.close(); await pool.end();
}
if (failed) process.exit(1);
console.log('Payment checkout browser check passed.');
process.exit(0);
