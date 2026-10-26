// The whole client workflow, for two separate businesses side by side: the platform owner creates
// each business (contact details, subscription, owner invite), and its owner adds products, a Meta
// pixel, an Apps Script spreadsheet and a verified notification email, uploads a landing-page ZIP,
// publishes it (checkout connected automatically) at its own address, and takes orders. Orders,
// tracking, spreadsheet rows, emails and access stay with their own business; expiry locks the
// workspace without deleting anything, and renewal restores it. Meta, the spreadsheets and the email
// provider are local stand-ins.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import request from 'supertest';
import yazl from 'yazl';
import { setup, resetDatabase, csrfToken, signUp } from './helpers.js';
import { syncDue } from '../src/services/sheets.js';
import { planOrderNotifications, sendOrderNotifications } from '../src/services/orderNotifications.js';
import { expireSubscriptions } from '../src/services/tenancy.js';
import { clearOriginCache } from '../src/lib/origins.js';
import { SHEET_COLUMNS } from '../src/services/sheetColumns.js';

// ---- stand-ins: Meta Conversions API, the email provider and one Apps Script web app per business
const meta = []; const mail = []; let mailDown = false;
const scripts = { a: { key: null, rows: [] }, b: { key: null, rows: [] } };
const echoes = new Map();
const mock = createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const json = (status, o) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (u.pathname === '/echo') return json(200, echoes.get(u.searchParams.get('id')));
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    if (u.pathname.startsWith('/meta/')) { meta.push({ pixel: u.pathname.split('/')[2], body: JSON.parse(body || '{}') }); return json(200, { events_received: 1 }); }
    if (u.pathname === '/emails') {
      if (mailDown) return json(503, { message: 'Service unavailable' });
      mail.push(JSON.parse(body || '{}'));
      return json(200, { id: `email_${mail.length}` });
    }
    const s = scripts[(u.pathname.match(/AKfycbTest([ab])Deployment/) || [])[1]];
    const p = req.method === 'POST' ? JSON.parse(body) : Object.fromEntries(u.searchParams);
    let out;
    if (!s || p.key !== s.key) out = { ok: false, error: 'Wrong key' };
    else if (req.method === 'GET' && p.action === 'tabs') out = { ok: true, tabs: [{ name: 'History', rows: 12, columns: 6, firstRow: ['Date'] }, { name: 'Skyfly Orders', rows: 1, columns: 14, firstRow: [] }] };
    else if (req.method === 'GET' && p.action === 'keys') out = { ok: true, columns: [...SHEET_COLUMNS] };
    else if (req.method === 'GET' && p.action === 'search') out = { ok: true, rows: s.rows.filter((r) => String(r.source).includes(p.q)) };
    else if (req.method === 'POST' && p.id && s.rows.some((r) => r.skyflyId === p.id)) out = { ok: true, created: 0, existing: true };
    else if (req.method === 'POST') { s.rows.push(p.row); out = { ok: true, created: 1 }; }
    else out = { ok: false, error: 'Unknown action' };
    if (req.method !== 'POST') return json(200, out);
    const id = randomBytes(6).toString('hex');
    echoes.set(id, out);
    res.writeHead(302, { Location: `/echo?id=${id}` });
    res.end();
  });
});
await new Promise((r) => mock.listen(0, r));
const MOCK = `http://127.0.0.1:${mock.address().port}`;
const encryptionKey = randomBytes(32);
const { pool, app } = setup({
  allowSignup: true, signupFirstOnly: true, pagesBaseUrl: '', allowedOrigins: [], publicBaseUrl: 'https://skyfly.test',
  encryptionKey, metaGraphBase: `${MOCK}/meta`, emailApiBase: MOCK,
  notifyEmail: { provider: 'resend', apiKey: 're_test_0123456789abcdef', fromEmail: 'orders@skyfly.test', fromName: 'Skyfly' },
});
const settle = () => new Promise((r) => setTimeout(r, 250));

// ---- the two clients
const SAMPLE = readFileSync(new URL('../src/demo/import-sample/index.html', import.meta.url), 'utf8');
const BIZ = {
  a: { name: 'Bloom Beauty', owner: 'owner@bloom.test', notify: 'orders@bloom.test', pixel: '111111111111111', token: 'EAAB-bloom-secret-token-0123456789', testCode: 'TEST11111',
    products: [['radiance-serum', 'Radiance Serum', 15000], ['glow-duo', 'Glow Duo Set', 27500]], upsell: ['travel-mist', 'Travel Mist', 3000], html: SAMPLE },
  b: { name: 'Kano Kitchen', owner: 'owner@kano.test', notify: 'orders@kano.test', pixel: '222222222222222', token: null,
    products: [['spice-box', 'Spice Box', 8000], ['feast-hamper', 'Feast Hamper', 19000]], upsell: null,
    html: SAMPLE.replaceAll('Radiance Serum', 'Spice Box').replaceAll('Glow Duo Set', 'Feast Hamper').replaceAll('15,000', '8,000').replaceAll('27,500', '19,000') },
};
const SIZE = JSON.stringify([{ name: 'Size', values: [{ label: '30ml', delta_minor: 0 }, { label: '50ml', delta_minor: 500000 }] }]);
let admin;
const zip = (entries) => new Promise((resolve) => {
  const z = new yazl.ZipFile();
  for (const [name, content] of Object.entries(entries)) z.addBuffer(Buffer.from(content), name);
  const chunks = [];
  z.outputStream.on('data', (c) => chunks.push(c)).on('end', () => resolve(Buffer.concat(chunks)));
  z.end();
});
const form = async (agent, page, path, fields, status = 302) => {
  const _csrf = await csrfToken(agent, page);
  const res = await agent.post(path).type('form').send({ _csrf, ...fields });
  assert.equal(res.status, status, `${path}: HTTP ${res.status} ${(res.text.match(/class="error"[^>]*>([^<]*)/) || [])[1] ?? res.text.slice(0, 200)}`);
  return res;
};
let n = 0;
const order = (c, { name = 'TEST ORDER workflow', product = c.products[0][0], size = '50ml', upsell = false, key = null } = {}) =>
  request(app).post('/api/public/orders').set('Origin', 'null').send({
    landingPage: c.slug, idempotencyKey: key ?? `two-business-${String(n += 1).padStart(6, '0')}`,
    customer: { name, phone: '08031234567', email: 'buyer@example.test', address: '12 Fictional Road, Ikeja, Lagos' },
    items: [{ product, quantity: 1, options: { Size: size } }, ...(upsell ? [{ product: c.upsell[0], quantity: 1, upsell: true }] : [])],
  });

before(async () => {
  await resetDatabase(pool);
  admin = await signUp(app, { email: 'platform@skyfly.test' }); // first account: the platform owner
});
after(async () => { await pool.end(); mock.close(); });

describe('1. each business is created and configured', () => {
  for (const k of ['a', 'b']) {
    test(`${k.toUpperCase()}: created with a subscription, contact details and its own owner; products, pixel, sheet and verified email set up`, async () => {
      const c = BIZ[k];
      const created = await form(admin, '/admin/businesses/new', '/admin/businesses', {
        name: c.name, currency: 'NGN', timezone: 'Africa/Lagos', subscription_status: 'active', price: '15000', expires_on: '2099-12-31', owner_email: c.owner,
      }, 200);
      const invite = created.text.match(/https?:\/\/[^\s"<]+\/invite\/([A-Za-z0-9_-]+)/)[1];
      c.id = (await pool.query('SELECT id FROM businesses WHERE name = $1', [c.name])).rows[0].id;
      await form(admin, `/admin/businesses/${c.id}`, `/admin/businesses/${c.id}/details`,
        { name: c.name, contact_name: `${c.name} Owner`, contact_phone: '+2348030000000', contact_email: c.owner, website: 'https://example.com' }, 200);
      // The owner joins with the invitation.
      c.agent = request.agent(app);
      await form(c.agent, `/invite/${invite}`, `/invite/${invite}`, { name: `${c.name} Owner`, password: 'client-password-1234' });
      const base = `/businesses/${c.id}`;
      for (const [code, name, price] of [...c.products, ...(c.upsell ? [c.upsell] : [])]) {
        await form(c.agent, `${base}/products`, `${base}/products`, { code, name, price: String(price), options: code === c.upsell?.[0] ? '' : 'Size: 30ml, 50ml (+5000)' });
      }
      const fields = { provider: 'meta', enabled: 'on', pixel_id: c.pixel, events: ['PageView', 'InitiateCheckout', 'Lead', 'Purchase'] };
      if (c.token) Object.assign(fields, { server_purchase: 'on', access_token: c.token, test_event_code: c.testCode });
      await form(c.agent, `${base}/pixels`, `${base}/pixels`, fields);
      const sheets = await c.agent.get(`${base}/google-sheets`).expect(200);
      scripts[k].key = sheets.text.match(/name="script_key" value="([A-Za-z0-9_-]{32})"/)[1];
      await form(c.agent, `${base}/google-sheets`, `${base}/google-sheets/connections`,
        { kind: 'apps_script', name: `${c.name} orders`, api_url: `${MOCK}/macros/s/AKfycbTest${k}Deployment0123456789/exec`, script_key: scripts[k].key, make_default: 'on' });
      await form(c.agent, `${base}/settings`, `${base}/settings/notifications`, { notify_email: c.notify, notify_enabled: 'on' });
      await form(c.agent, `${base}/settings`, `${base}/settings/notifications/verify`, {});
      const link = mail.at(-1).text.match(/\/notify\/verify\/([A-Za-z0-9_-]+)/)[1];
      assert.deepEqual(mail.at(-1).to, [c.notify]);
      await request(app).post(`/notify/verify/${link}`).type('form').send({}).expect(200);
      const { rows: [b] } = await pool.query('SELECT * FROM businesses WHERE id = $1', [c.id]);
      assert.equal(b.subscription_status, 'active');
      assert.equal(b.contact_name, `${c.name} Owner`);
      assert.ok(b.notify_verified_at);
      const { rows: [sc] } = await pool.query('SELECT check_status FROM sheet_connections WHERE id = $1 AND business_id = $2', [b.default_sheet_connection_id, c.id]);
      assert.equal(sc.check_status, 'ok');
    });
  }

  test('the owner\'s setup checklist reflects what is set up for each business', async () => {
    const page = await admin.get(`/admin/businesses/${BIZ.a.id}`).expect(200);
    for (const step of ['details', 'notify', 'products', 'pixel', 'sheet']) assert.match(page.text, new RegExp(`data-step="${step}" data-done="true"`), step);
    for (const step of ['page', 'test']) assert.match(page.text, new RegExp(`data-step="${step}" data-done="false"`), step);
  });
});

describe('2–4. landing-page ZIP → publish → unique address that loads', () => {
  for (const k of ['a', 'b']) {
    test(`${k.toUpperCase()}: the ZIP is imported under its business, checked, published with its checkout connected, at its own address`, async () => {
      const c = BIZ[k];
      const base = `/businesses/${c.id}/landing-pages`;
      const _csrf = await csrfToken(c.agent, base);
      const upload = await c.agent.post(`${base}/upload`).field('_csrf', _csrf).field('name', `${c.name} offer`)
        .attach('file', await zip({ 'index.html': c.html, 'img/note.txt': 'asset' }), 'page.zip');
      assert.equal(upload.status, 302, upload.text.slice(0, 300));
      c.pageId = Number(upload.headers.location.match(/landing-pages\/(\d+)/)[1]);
      const { rows: [lp] } = await pool.query('SELECT business_id, slug FROM landing_pages WHERE id = $1', [c.pageId]);
      assert.equal(lp.business_id, c.id);
      c.slug = lp.slug;
      await pool.query('UPDATE products SET options = $2 WHERE business_id = $1 AND code = ANY($3)', [c.id, SIZE, c.products.map((p) => p[0])]);
      if (c.upsell) {
        await pool.query(`UPDATE landing_pages SET upsell_product_id = (SELECT id FROM products WHERE business_id = $1 AND code = $2), upsell_headline = 'Add a Travel Mist' WHERE id = $3`,
          [c.id, c.upsell[0], c.pageId]);
      }
      const { rows: [v] } = await pool.query('SELECT id FROM page_versions WHERE landing_page_id = $1 ORDER BY id DESC LIMIT 1', [c.pageId]);
      await form(c.agent, `${base}/${c.pageId}`, `${base}/${c.pageId}/publish`, { version_id: String(v.id) });
      clearOriginCache();
      const live = await request(app).get(`/p/${c.slug}/`).set('User-Agent', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)').expect(200);
      assert.match(live.text, /\/sdk\/skyfly\.js/);
      assert.match(live.text, /name="viewport"/, 'phone layout');
      assert.match(live.text, /data-skyfly-form=/, 'checkout connected to Skyfly');
      assert.ok(live.text.includes(c.products[0][1]));
    });
  }

  test('the two pages have different addresses, and each serves only its own business\'s pixel without any token', async () => {
    assert.notEqual(BIZ.a.slug, BIZ.b.slug);
    for (const [k, other] of [['a', 'b'], ['b', 'a']]) {
      const cfg = await request(app).get(`/api/public/pages/${BIZ[k].slug}/tracking`).expect(200);
      assert.deepEqual(cfg.body.pixels.map((p) => p.id), [BIZ[k].pixel]);
      assert.ok(!JSON.stringify(cfg.body).includes(BIZ[other].pixel));
      assert.ok(!/token|EAAB|secret/i.test(JSON.stringify(cfg.body)));
      const html = (await request(app).get(`/p/${BIZ[k].slug}/`).expect(200)).text;
      assert.ok(!html.includes('EAAB'), 'no access token in the page');
    }
  });
});

describe('5–9. checkout straight to Skyfly, under the right business, priced by Skyfly', () => {
  test('A: option and upsell priced on the server; a changed browser price is refused; the order is listed under A only', async () => {
    const c = BIZ.a;
    const res = await order(c, { upsell: true }).expect(201);
    assert.equal(res.body.total, 15000 + 5000 + 3000, 'serum 50ml + Travel Mist');
    assert.deepEqual(res.body.items.map((i) => [i.name, i.total, i.upsell]), [['Radiance Serum (Size: 50ml)', 20000, false], ['Travel Mist', 3000, true]]);
    c.testRef = res.body.reference;
    const { rows: [o] } = await pool.query('SELECT business_id, is_test, total_minor FROM orders WHERE reference = $1', [c.testRef]);
    assert.deepEqual([o.business_id, o.is_test, Number(o.total_minor)], [c.id, true, 2300000]);
    const tampered = await request(app).post('/api/public/orders').set('Origin', 'null').send({
      landingPage: c.slug, idempotencyKey: 'two-biz-tampered-000001',
      customer: { name: 'TEST ORDER tampered', phone: '08031234567', address: '12 Fictional Road, Ikeja' },
      items: [{ product: 'radiance-serum', quantity: 1, unitPrice: 100, options: { Size: '30ml' } }],
    });
    assert.equal(tampered.status, 409);
    assert.match((await c.agent.get(`/businesses/${c.id}/orders`).expect(200)).text, new RegExp(c.testRef));
    assert.doesNotMatch((await BIZ.b.agent.get(`/businesses/${BIZ.b.id}/orders`).expect(200)).text, new RegExp(c.testRef));
  });

  test('B: its own products and prices; A\'s products are refused on B\'s page', async () => {
    const c = BIZ.b;
    const res = await order(c, { size: '30ml' }).expect(201);
    assert.equal(res.body.total, 8000);
    c.testRef = res.body.reference;
    assert.equal((await order(c, { product: 'radiance-serum' })).status, 400, 'another business\'s product');
    const { rows: [o] } = await pool.query('SELECT business_id FROM orders WHERE reference = $1', [c.testRef]);
    assert.equal(o.business_id, c.id);
  });

  test('the same submission twice is one order; the reply is the saved order (never a WhatsApp hand-off)', async () => {
    const first = await order(BIZ.a, { key: 'two-biz-repeat-000001' }).expect(201);
    const again = await order(BIZ.a, { key: 'two-biz-repeat-000001' }).expect(200);
    assert.equal(again.body.reference, first.body.reference);
    assert.equal(again.body.replayed, true);
    assert.equal(first.body.saved, true);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM orders WHERE idempotency_key = $1', ['two-biz-repeat-000001'])).rows[0].n, 1);
  });

  test('server-side Purchase: a test order goes to A\'s pixel with its test code only; B (no token) sends nothing; same event ID as the browser', async () => {
    await settle();
    const forA = meta.filter((m) => m.pixel === BIZ.a.pixel);
    assert.ok(forA.length >= 1);
    const ev = forA.find((m) => m.body.data[0].event_id === `test_purchase_${BIZ.a.testRef}`);
    assert.ok(ev, JSON.stringify(forA.map((m) => m.body.data[0].event_id)));
    assert.equal(ev.body.test_event_code, BIZ.a.testCode);
    assert.equal(ev.body.data[0].custom_data.value, 23000);
    assert.equal(ev.body.data[0].custom_data.currency, 'NGN');
    assert.equal(meta.filter((m) => m.pixel === BIZ.b.pixel).length, 0);
    const real = await order(BIZ.a, { name: 'Ada Customer', size: '30ml' }).expect(201);
    await settle();
    const sale = meta.find((m) => m.body.data[0].event_id === `purchase_${real.body.reference}`);
    assert.ok(sale && !sale.body.test_event_code, 'a real order\'s Purchase carries the same event ID the browser uses');
    assert.equal(real.body.purchaseEventId, `purchase_${real.body.reference}`);
    BIZ.a.realRef = real.body.reference;
  });
});

describe('10–11. spreadsheets and emails, per business', () => {
  test('each real order is copied once to its own business\'s spreadsheet; test orders never are; repeating the sync adds nothing', async () => {
    const real = await order(BIZ.b, { name: 'Bayo Customer', size: '30ml' }).expect(201);
    BIZ.b.realRef = real.body.reference;
    const sync = async () => { await pool.query("UPDATE orders SET sheet_sync_next_at = now() WHERE sheet_sync_status IN ('pending', 'failed')"); await syncDue(pool, { key: encryptionKey }); };
    await sync(); await sync();
    const refs = (k) => scripts[k].rows.map((r) => r.skyflyId ? r : r).map((r) => JSON.stringify(r));
    assert.equal(refs('a').filter((r) => r.includes(BIZ.a.realRef)).length, 1);
    assert.equal(refs('b').filter((r) => r.includes(BIZ.b.realRef)).length, 1);
    assert.ok(!refs('a').some((r) => r.includes(BIZ.b.realRef)) && !refs('b').some((r) => r.includes(BIZ.a.realRef)), 'each sheet has only its own business\'s orders');
    assert.ok(![...refs('a'), ...refs('b')].some((r) => r.includes(BIZ.a.testRef) || r.includes(BIZ.b.testRef)), 'test orders never reach a spreadsheet');
    const { rows } = await pool.query('SELECT reference, sheet_sync_status FROM orders WHERE reference = ANY($1)', [[BIZ.a.realRef, BIZ.b.realRef]]);
    assert.ok(rows.every((r) => r.sheet_sync_status === 'synced'));
  });

  test('order emails go to each business\'s own verified address; a provider outage shows as pending, then sends on retry, once', async () => {
    mail.length = 0;
    await planOrderNotifications(pool);
    mailDown = true;
    await sendOrderNotifications(pool, { notifyEmail: { provider: 'resend', apiKey: 're_test_0123456789abcdef', fromEmail: 'orders@skyfly.test' }, emailApiBase: MOCK, encryptionKey });
    mailDown = false;
    const { rows: waiting } = await pool.query("SELECT status, reason FROM email_messages WHERE kind = 'order_notification' AND status = 'queued'");
    assert.ok(waiting.length >= 2 && waiting.every((m) => /failed/.test(m.reason)), 'the failure is shown and the email waits for a retry');
    await pool.query("UPDATE email_messages SET next_attempt_at = now() WHERE kind = 'order_notification'");
    await sendOrderNotifications(pool, { notifyEmail: { provider: 'resend', apiKey: 're_test_0123456789abcdef', fromEmail: 'orders@skyfly.test' }, emailApiBase: MOCK, encryptionKey });
    const to = (ref) => mail.filter((m) => m.text.includes(ref)).map((m) => m.to[0]);
    assert.deepEqual(to(BIZ.a.realRef), [BIZ.a.notify]);
    assert.deepEqual(to(BIZ.b.realRef), [BIZ.b.notify]);
    await sendOrderNotifications(pool, { notifyEmail: { provider: 'resend', apiKey: 're_test_0123456789abcdef', fromEmail: 'orders@skyfly.test' }, emailApiBase: MOCK, encryptionKey });
    assert.deepEqual(to(BIZ.a.realRef), [BIZ.a.notify], 'never twice');
    const { rows: [sent] } = await pool.query("SELECT m.status FROM email_messages m JOIN orders o ON o.id = m.order_id WHERE o.reference = $1", [BIZ.a.realRef]);
    assert.equal(sent.status, 'sent');
  });
});

describe('12. one business cannot reach another\'s data or credentials', () => {
  test('B\'s owner gets "not found" for A\'s orders, pixels, sheets, settings and page; A\'s token never appears', async () => {
    const { rows: [o] } = await pool.query('SELECT id FROM orders WHERE reference = $1', [BIZ.a.realRef]);
    for (const p of ['', '/orders', `/orders/${o.id}`, '/orders/export.csv', '/pixels', '/google-sheets', '/settings', `/landing-pages/${BIZ.a.pageId}`, '/products']) {
      await BIZ.b.agent.get(`/businesses/${BIZ.a.id}${p}`).expect(404);
    }
    const own = await BIZ.a.agent.get(`/businesses/${BIZ.a.id}/pixels`).expect(200);
    assert.ok(!own.text.includes(BIZ.a.token), 'even its own token is never shown again');
    const { rows: [px] } = await pool.query("SELECT access_token_enc FROM pixel_settings WHERE business_id = $1 AND provider = 'meta'", [BIZ.a.id]);
    assert.ok(px.access_token_enc && !px.access_token_enc.includes(BIZ.a.token), 'stored encrypted');
  });
});

describe('13. subscription expiry and renewal', () => {
  test('after expiry A is locked out (orders kept, B unaffected); renewal restores access', async () => {
    const count = async () => (await pool.query('SELECT count(*)::int AS n FROM orders WHERE business_id = $1', [BIZ.a.id])).rows[0].n;
    const before = await count();
    await pool.query("UPDATE businesses SET subscription_expires_on = (now() AT TIME ZONE timezone)::date - 1 WHERE id = $1", [BIZ.a.id]);
    await expireSubscriptions(pool);
    const locked = await BIZ.a.agent.get(`/businesses/${BIZ.a.id}/orders`);
    assert.notEqual(locked.status, 200);
    assert.equal(await count(), before, 'no order deleted');
    await BIZ.b.agent.get(`/businesses/${BIZ.b.id}/orders`).expect(200);
    await form(admin, `/admin/businesses/${BIZ.a.id}`, `/admin/businesses/${BIZ.a.id}/subscription`,
      { subscription_status: 'active', price: '15000', expires_on: '2099-12-31' });
    await BIZ.a.agent.get(`/businesses/${BIZ.a.id}/orders`).expect(200);
    assert.equal(await count(), before);
  });
});

describe('the owner\'s checklist at the end', () => {
  test('every step is done for A once its page is live and a test order exists', async () => {
    await pool.query("UPDATE landing_pages SET live_status = 'ok: HTTP 200, page and Skyfly checkout script served', live_checked_at = now() WHERE id = $1", [BIZ.a.pageId]);
    const page = await admin.get(`/admin/businesses/${BIZ.a.id}`).expect(200);
    assert.equal((page.text.match(/data-done="true"/g) || []).length, 8, page.text.match(/data-step="[a-z]+" data-done="false"/g)?.join());
    assert.match(page.text, /8 of 8 done/);
  });
});
