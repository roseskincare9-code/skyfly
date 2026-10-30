// Tenant isolation, checked on the backend for every route rather than a hand-picked list.
// Three identities: the Super Admin, Business A's owner and Business B's owner. Business A gets one
// of every kind of record. Then:
//  1. B, inside B's own workspace, sends every GET and POST route with A's record IDs.
//  2. B sends every route inside A's workspace.
//  3. A and B send every Super Admin route.
// Afterwards nothing of A's may have changed, and no response may show A's data. The route list is
// read from the route files, so a new route is swept automatically.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import request from 'supertest';
import { setup, resetDatabase, csrfToken, adminSignIn } from './helpers.js';

const { pool, app: expressApp } = setup({ allowedOrigins: [] });
// One listening server for the whole sweep (a new server per request runs out of ports).
const app = expressApp.listen(0);
async function signUp(server, { name, email, password = 'correct-horse-battery' }) {
  const agent = request.agent(server);
  const _csrf = await csrfToken(agent, '/signup');
  const res = await agent.post('/signup').type('form').send({ _csrf, name, email, password });
  if (res.status !== 302) throw new Error(`Sign-up failed with ${res.status}`);
  await adminSignIn(agent, { email, password });
  return agent;
}
const routesDir = new URL('../src/routes/', import.meta.url);
const MARKERS = ['Alpha Secretcustomer', 'AlphaSecretProduct', 'AlphaSecretPage', 'AlphaSecretPixel', 'AlphaSecretSubject', 'alpha-contact@secret.test', 'AlphaSecretKey', 'AlphaSecretSheet', 'Alpha Checkoutname', 'AlphaSecretAutomation', 'alpha-staff@secret.test'];
let admin; let ownerA; let ownerB;
const A = {}; const B = {};

// Every route of a route file: [method, path] pairs, as written in the file.
function routesOf(file, { from = 0, to = Infinity } = {}) {
  const src = readFileSync(new URL(file, routesDir), 'utf8').slice(from, to);
  const out = [];
  for (const m of src.matchAll(/router\.(get|post)\((\[[^\]]*\]|'[^']*')/g)) {
    for (const p of m[2].match(/'[^']*'/g)) out.push([m[1], p.slice(1, -1)]);
  }
  return out;
}
function workspaceRoutes() {
  const emailSrc = readFileSync(new URL('email.js', routesDir), 'utf8');
  const split = emailSrc.indexOf('export function emailContactRoutes');
  const groups = [
    ['orders.js', '/orders'], ['checkouts.js', '/checkouts'], ['googleSheets.js', '/google-sheets'], ['products.js', '/products'],
    ['insights.js', ''], ['pageEditor.js', '/landing-pages'], ['landingPages.js', '/landing-pages'], ['settings.js', '/settings'],
    ['apiKeys.js', '/api-keys'], ['pixels.js', '/pixels'], ['team.js', '/team'],
  ];
  const list = groups.flatMap(([f, prefix]) => routesOf(f).map(([m, p]) => [m, prefix + (p === '/' ? '' : p), prefix]));
  list.push(...routesOf('email.js', { to: split }).map(([m, p]) => [m, `/email${p === '/' ? '' : p}`, '/email']));
  list.push(...routesOf('email.js', { from: split }).map(([m, p]) => [m, `/email-contacts${p === '/' ? '' : p}`, '/email-contacts']));
  list.push(['get', '', ''], ['get', '/activity', ''], ['get', '/subscription', ''], ['get', '/integrations', ''], ['get', '/sheet-backup', '']);
  return list;
}
// Fills a route's parameters with Business A's record IDs (":id" depends on the section).
function fill(path, prefix, ids = A) {
  const byId = { '/checkouts': ids.checkout, '/google-sheets': ids.sheet, '/pixels': ids.pixel };
  return path.replace(/:(\w+)/g, (_, name) => {
    const v = name === 'id' ? byId[prefix] : ids[name];
    assert.ok(v !== undefined, `no Business A record for :${name} in ${prefix}${path}`);
    return String(v);
  });
}

// Everything Business A owns, as one fingerprint (any change shows up).
async function fingerprintA() {
  const { rows: tables } = await pool.query(
    `SELECT table_name FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'business_id' AND table_name <> 'audit_log' ORDER BY 1`);
  const parts = [];
  for (const { table_name: t } of tables) {
    const { rows: [r] } = await pool.query(`SELECT md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) AS h FROM ${t} x WHERE business_id = $1`, [A.business]);
    parts.push(`${t}:${r.h}`);
  }
  for (const [t, where] of [['order_items', 'order_id IN (SELECT id FROM orders WHERE business_id = $1)'],
    ['page_versions', 'landing_page_id IN (SELECT id FROM landing_pages WHERE business_id = $1)'],
    ['landing_page_products', 'landing_page_id IN (SELECT id FROM landing_pages WHERE business_id = $1)'],
    ['tracking_pixel_pages', 'tracking_pixel_id IN (SELECT id FROM tracking_pixels WHERE business_id = $1)'],
    ['businesses', 'id = $1']]) {
    const { rows: [r] } = await pool.query(`SELECT md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) AS h FROM ${t} x WHERE ${where}`, [A.business]);
    parts.push(`${t}:${r.h}`);
  }
  return parts.join('\n');
}

async function newBusiness(agent, name) {
  const _csrf = await csrfToken(agent, '/');
  await agent.post('/businesses').type('form').send({ _csrf, name }).expect(302);
  return (await pool.query('SELECT id FROM businesses WHERE name = $1', [name])).rows[0].id;
}

// One of every kind of record for a business (directly in the database).
async function seed(ids, business, tag) {
  ids.business = business;
  const q = async (sql, params) => (await pool.query(sql, params)).rows[0]?.id;
  ids.productId = await q("INSERT INTO products (business_id, code, name, price_minor) VALUES ($1, $2, $3, 500000) RETURNING id", [business, `${tag.toLowerCase()}-cream`, `${tag}SecretProduct`]);
  ids.pageId = await q("INSERT INTO landing_pages (business_id, name, slug, status) VALUES ($1, $2, $3, 'draft') RETURNING id", [business, `${tag}SecretPage`, `${tag.toLowerCase()}-page`]);
  ids.versionId = await q("INSERT INTO page_versions (landing_page_id, entry_path, file_count, total_bytes, source_name) VALUES ($1, 'index.html', 0, 0, 'index.html') RETURNING id", [ids.pageId]);
  await pool.query('INSERT INTO landing_page_products (landing_page_id, product_id) VALUES ($1, $2)', [ids.pageId, ids.productId]);
  ids.orderId = await q(
    `INSERT INTO orders (business_id, landing_page_id, reference, access_token, customer_name, phone, address, currency, total_minor, idempotency_key, request_fingerprint, source)
     VALUES ($1, $2, $3, $4, $5, '+2348011112222', '1 Secret Street, Lagos', 'NGN', 500000, $6, 'fp', 'manual') RETURNING id`,
    [business, ids.pageId, `SKY-${tag.toUpperCase()}1`, `tok-${tag}-0123456789`, `${tag} Secretcustomer`, `idem-${tag}-0123456789`]);
  await pool.query("INSERT INTO order_items (order_id, product_id, product_code, product_name, quantity, unit_price_minor, line_total_minor) VALUES ($1, $2, 'c', $3, 1, 500000, 500000)", [ids.orderId, ids.productId, `${tag}SecretProduct`]);
  ids.eventId = await q("INSERT INTO conversion_events (order_id, provider, pixel_id, event_name, event_id) VALUES ($1, 'meta', '123456', 'Purchase', $2) RETURNING id", [ids.orderId, `ev-${tag}`]);
  ids.pixel = await q("INSERT INTO tracking_pixels (business_id, platform, name, pixel_id) VALUES ($1, 'meta', $2, $3) RETURNING id", [business, `${tag}SecretPixel`, tag === 'Alpha' ? '111111' : '222222']);
  ids.keyId = await q("INSERT INTO api_keys (business_id, name, key_hash, key_prefix) VALUES ($1, $2, $3, 'sk_x') RETURNING id", [business, `${tag}SecretKey`, `hash-${tag}`]);
  ids.templateId = await q("INSERT INTO email_templates (business_id, name, subject, body) VALUES ($1, 'T', $2, 'Hello') RETURNING id", [business, `${tag}SecretSubject`]);
  ids.automationId = await q("INSERT INTO email_automations (business_id, name, kind, anchor) VALUES ($1, $2, 'post_purchase', 'order_date') RETURNING id", [business, `${tag}SecretAutomation`]);
  ids.stepId = await q('INSERT INTO email_automation_steps (business_id, automation_id, template_id, delay_days) VALUES ($1, $2, $3, 1) RETURNING id', [business, ids.automationId, ids.templateId]);
  ids.contactId = await q("INSERT INTO email_contacts (business_id, email, source) VALUES ($1, $2, 'manual') RETURNING id", [business, `${tag.toLowerCase()}-contact@secret.test`]);
  ids.checkout = await q("INSERT INTO checkout_sessions (business_id, token, customer_name, status) VALUES ($1, $2, $3, 'abandoned') RETURNING id", [business, `chk-${tag}-0123456789abcd`, `${tag} Checkoutname`]);
  ids.sheet = await q("INSERT INTO sheet_connections (business_id, name, api_url_enc, api_url_hash, api_hint) VALUES ($1, $2, 'enc', $3, 'hint') RETURNING id", [business, `${tag}SecretSheet`, `hash-sheet-${tag}`]);
  ids.inviteId = await q("INSERT INTO business_invites (business_id, email, role, token_hash, expires_at) VALUES ($1, $2, 'staff', $3, now() + interval '7 days') RETURNING id", [business, `${tag.toLowerCase()}-invitee@secret.test`, `hash-invite-${tag}`]);
  ids.userId = await q("INSERT INTO users (email, password_hash, name) VALUES ($1, 'x', 'Staff') RETURNING id", [`${tag.toLowerCase()}-staff@secret.test`]);
  await pool.query("INSERT INTO business_members (business_id, user_id, role) VALUES ($1, $2, 'staff')", [business, ids.userId]);
}

const BODY = (extra = {}) => ({
  status: 'cancelled', payment_status: 'paid', name: 'HACKED', role: 'owner', email: 'hacker@b.test', price: '1', subject: 'x', body: 'x',
  enabled: 'on', delay_days: '1', template_id: String(A.templateId), version_id: String(A.versionId), product_ids: String(A.productId),
  page_id: String(A.pageId), connection_id: String(A.sheet), domain: 'hack.example.com', ...extra,
});
const leaks = (text) => MARKERS.filter((m) => String(text ?? '').includes(m));

before(async () => {
  await resetDatabase(pool);
  admin = await signUp(app, { name: 'Super Admin', email: 'admin@skyfly.test' });
  // Sign-up is invitation-only after the first account: owners join by invitation from the Super Admin.
  A.business = await newBusiness(admin, 'Business A');
  B.business = await newBusiness(admin, 'Business B');
  for (const [biz, email] of [[A.business, 'owner-a@shop-a.test'], [B.business, 'owner-b@shop-b.test']]) {
    const _csrf = await csrfToken(admin, `/admin/businesses/${biz}`);
    const res = await admin.post(`/admin/businesses/${biz}/invite`).type('form').send({ _csrf, email, role: 'owner' }).expect(200);
    const link = res.text.match(/\/invite\/([A-Za-z0-9_-]+)/)[1];
    const agent = request.agent(app);
    const _c = await csrfToken(agent, `/invite/${link}`);
    await agent.post(`/invite/${link}`).type('form').send({ _csrf: _c, name: 'Owner', password: 'correct-horse-battery' }).expect(302);
    if (biz === A.business) ownerA = agent; else ownerB = agent;
  }
  // The Super Admin set the businesses up and is not a member of them afterwards (support access only).
  await pool.query('DELETE FROM business_members m USING users u WHERE u.id = m.user_id AND u.email = $1', ['admin@skyfly.test']);
  await seed(A, A.business, 'Alpha');
  await seed(B, B.business, 'Beta');
});
after(async () => { app.close(); await pool.end(); });

describe('every workspace route', () => {
  const routes = workspaceRoutes();

  test('the sweep covers every route in the route files', () => {
    assert.ok(routes.length >= 110, `only ${routes.length} routes found`);
  });

  test("B, in its own workspace, gets nothing of A's with A's record IDs (every GET and POST), and changes nothing", async () => {
    const before = await fingerprintA();
    const results = [];
    for (const [method, path, prefix] of routes.filter(([, p]) => p.includes(':'))) {
      const url = `/businesses/${B.business}${fill(path, prefix)}`;
      let res;
      if (method === 'get') res = await ownerB.get(url);
      else {
        const _csrf = await csrfToken(ownerB, `/businesses/${B.business}`);
        res = await ownerB.post(url).type('form').send(BODY({ _csrf }));
      }
      results.push(`${method.toUpperCase()} ${url} -> ${res.status}`);
      assert.deepEqual(leaks(res.text), [], `${method.toUpperCase()} ${url} (${res.status}) shows Business A's data`);
      assert.ok(res.status !== 200 || method === 'get', `${method.toUpperCase()} ${url} answered 200`);
      assert.ok(!(res.status >= 500), `${method.toUpperCase()} ${url} errored (${res.status})`);
    }
    // A page of B's with a version of A's (the version must belong to the page).
    for (const [method, path] of routes.filter(([, p]) => p.includes(':versionId'))) {
      const url = `/businesses/${B.business}${path.replace(':pageId', B.pageId).replace(':versionId', A.versionId)}`;
      const res = method === 'get' ? await ownerB.get(url) : await ownerB.post(url).type('form').send(BODY({ _csrf: await csrfToken(ownerB, `/businesses/${B.business}`) }));
      assert.deepEqual(leaks(res.text), [], url);
      assert.ok([302, 400, 403, 404].includes(res.status), `${url} -> ${res.status}`);
    }
    assert.equal(await fingerprintA(), before, "Business A's records changed");
    assert.ok(results.length >= 60, `${results.length} ID-based requests`);
  });

  test("B gets 404 for every route inside A's workspace, GET and POST, and changes nothing", async () => {
    const before = await fingerprintA();
    for (const [method, path, prefix] of routes) {
      const url = `/businesses/${A.business}${fill(path, prefix)}`;
      const res = method === 'get' ? await ownerB.get(url)
        : await ownerB.post(url).type('form').send(BODY({ _csrf: await csrfToken(ownerB, `/businesses/${B.business}`) }));
      assert.equal(res.status, 404, `${method.toUpperCase()} ${url}`);
      assert.deepEqual(leaks(res.text), [], url);
    }
    assert.equal(await fingerprintA(), before);
  });

  test("A's own records open for A (the sweep is not passing because the routes are broken)", async () => {
    for (const path of ['/orders/:orderId', '/products', '/landing-pages/:pageId', '/pixels', '/email-contacts', '/checkouts/:id']) {
      const prefix = `/${path.split('/')[1]}`;
      const res = await ownerA.get(`/businesses/${A.business}${fill(path, prefix)}`).expect(200);
      assert.ok(leaks(res.text).length > 0, `${path} shows A's data to A`);
    }
  });
});

describe('Super Admin area', () => {
  // "Leave Super Admin" only clears this session's own Super Admin sign-in, so it is harmless for anyone.
  const adminRoutes = routesOf('admin.js').filter(([m, p]) => !(m === 'post' && p === '/admin/logout'));

  test('business owners get 404 for every Super Admin route, GET and POST', async () => {
    const before = await fingerprintA();
    for (const agent of [ownerA, ownerB]) {
      for (const [method, path] of adminRoutes) {
        const url = path.replace(/:id\b/g, A.business).replace(/:userId/g, A.userId);
        const res = method === 'get' ? await agent.get(url)
          : await agent.post(url).type('form').send(BODY({ _csrf: await csrfToken(agent, '/subscription'.replace('/subscription', `/businesses/${agent === ownerA ? A.business : B.business}`)) }));
        assert.equal(res.status, 404, `${method.toUpperCase()} ${url}`);
        assert.deepEqual(leaks(res.text), [], url);
      }
    }
    assert.equal(await fingerprintA(), before);
  });

  test('a business owner sees no platform menu', async () => {
    const res = await ownerA.get(`/businesses/${A.business}`).expect(200);
    assert.doesNotMatch(res.text, /href="\/admin"/);
  });
});

describe('sessions and business switching', () => {
  test('after A signs out, B signing in on the same browser sees only B', async () => {
    const browser = request.agent(app);
    let _csrf = await csrfToken(browser, '/login');
    await browser.post('/login').type('form').send({ _csrf, email: 'owner-a@shop-a.test', password: 'correct-horse-battery' }).expect(302);
    await browser.get(`/businesses/${A.business}`).expect(200);
    _csrf = await csrfToken(browser, `/businesses/${A.business}`);
    await browser.post('/logout').type('form').send({ _csrf }).expect(302);
    await browser.get(`/businesses/${A.business}`).expect(302);
    _csrf = await csrfToken(browser, '/login');
    const login = await browser.post('/login').type('form').send({ _csrf, email: 'owner-b@shop-b.test', password: 'correct-horse-battery' }).expect(302);
    const home = await browser.get(login.headers.location);
    assert.equal(home.status, 302, 'one business: straight into it');
    assert.equal(home.headers.location, `/businesses/${B.business}`);
    assert.equal((await browser.get(`/businesses/${A.business}`)).status, 404);
  });
});

describe('business API keys', () => {
  test("B's API key cannot place an order on A's page", async () => {
    const { createHash } = await import('node:crypto');
    const key = 'sk_live_betakey_0123456789abcdefghij';
    await pool.query('UPDATE api_keys SET key_hash = $2 WHERE id = $1', [B.keyId, createHash('sha256').update(key).digest('hex')]);
    await pool.query("UPDATE landing_pages SET status = 'active' WHERE id = $1", [A.pageId]);
    const before = (await pool.query('SELECT count(*)::int AS n FROM orders WHERE business_id = $1', [A.business])).rows[0].n;
    const res = await request(app).post('/api/public/orders').set('Authorization', `Bearer ${key}`).send({
      landingPage: 'alpha-page', customerName: 'Cross Business', phone: '+2348011112222', address: '1 Test Street, Lagos',
      items: [{ productCode: 'alpha-cream', quantity: 1 }], idempotencyKey: 'cross-business-0123456789',
    });
    assert.ok(res.status >= 400, `answered ${res.status}`);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM orders WHERE business_id = $1', [A.business])).rows[0].n, before);
    await pool.query("UPDATE landing_pages SET status = 'draft' WHERE id = $1", [A.pageId]);
  });
});

describe('database guards (even if application code forgot a check)', () => {
  const refused = async (sql, params) => assert.rejects(pool.query(sql, params), /cross-(business|page) reference refused/);

  test("the database refuses to link a record of B's to a record of A's", async () => {
    await refused("UPDATE orders SET landing_page_id = $2 WHERE id = $1", [B.orderId, A.pageId]);
    await refused("INSERT INTO order_items (order_id, product_id, product_code, product_name, quantity, unit_price_minor, line_total_minor) VALUES ($1, $2, 'c', 'x', 1, 1, 1)", [B.orderId, A.productId]);
    await refused('INSERT INTO landing_page_products (landing_page_id, product_id) VALUES ($1, $2)', [B.pageId, A.productId]);
    await refused('INSERT INTO tracking_pixel_pages (tracking_pixel_id, landing_page_id) VALUES ($1, $2)', [B.pixel, A.pageId]);
    await refused('UPDATE landing_pages SET upsell_product_id = $2 WHERE id = $1', [B.pageId, A.productId]);
    await refused('UPDATE checkout_sessions SET order_id = $2 WHERE id = $1', [B.checkout, A.orderId]);
    await refused("INSERT INTO email_messages (business_id, kind, order_id, to_email, scheduled_for, idempotency_key) VALUES ($1, 'test', $2, 'x@x.test', now(), 'guard-test-1')", [B.business, A.orderId]);
    await refused('UPDATE landing_pages SET published_version_id = $2 WHERE id = $1', [B.pageId, A.versionId]);
  });

  test('links within one business still work', async () => {
    await pool.query('UPDATE landing_pages SET upsell_product_id = $2 WHERE id = $1', [B.pageId, B.productId]);
    await pool.query('UPDATE landing_pages SET published_version_id = $2 WHERE id = $1', [B.pageId, B.versionId]);
    await pool.query('UPDATE landing_pages SET upsell_product_id = NULL, published_version_id = NULL WHERE id = $1', [B.pageId]);
  });
});
