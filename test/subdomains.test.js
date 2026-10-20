// Business subdomains on the planned platform domain: reserved names, uniqueness, honest status,
// and serving each business's published pages only on its own subdomain.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createPool } from '../src/db.js';
import { createApp } from '../src/app.js';
import { resetDatabase, csrfToken, signUp, makeConfig, testDatabaseUrl, ORIGIN } from './helpers.js';
import { clearOriginCache } from '../src/lib/origins.js';

const pool = createPool(testDatabaseUrl(), false);
const noDomain = createApp({ pool, config: makeConfig() });
const withDomain = createApp({ pool, config: makeConfig({ platformDomain: 'platform.test' }) });
let admin;
const ids = {};

const html = (title) => Buffer.from(`<!doctype html><html><head><title>${title}</title></head><body><h1>${title} — skincare for every day</h1><div data-skyfly-checkout></div></body></html>`);
async function publishPage(agent, businessId, name) {
  const _csrf = await csrfToken(agent, `/businesses/${businessId}/landing-pages`);
  const up = await agent.post(`/businesses/${businessId}/landing-pages/upload`).field('_csrf', _csrf).field('name', name).attach('file', html(name), 'index.html').expect(302);
  const pageId = up.headers.location.match(/landing-pages\/(\d+)/)[1];
  const { rows: [v] } = await pool.query('SELECT id FROM page_versions WHERE landing_page_id = $1', [pageId]);
  // A page is published only with something to order.
  const { rows: [item] } = await pool.query('INSERT INTO products (business_id, code, name, price_minor) VALUES ($1, $2, $3, 100000) RETURNING id', [businessId, `item-${pageId}`, `${name} item`]);
  await pool.query('INSERT INTO landing_page_products (landing_page_id, product_id) VALUES ($1, $2)', [pageId, item.id]);
  const _csrf2 = await csrfToken(agent, `/businesses/${businessId}/landing-pages/${pageId}`);
  await agent.post(`/businesses/${businessId}/landing-pages/${pageId}/publish`).type('form').send({ _csrf: _csrf2, version_id: v.id }).expect(302);
  return (await pool.query('SELECT slug FROM landing_pages WHERE id = $1', [pageId])).rows[0].slug;
}
async function setSub(app, agent, businessId, subdomain) {
  const _csrf = await csrfToken(agent, `/admin/businesses/${businessId}`);
  return agent.post(`/admin/businesses/${businessId}/subdomain`).type('form').send({ _csrf, subdomain });
}

before(async () => {
  await resetDatabase(pool);
  admin = await signUp(withDomain, { name: 'Platform Owner', email: 'owner@platform.test' });
  for (const name of ['Glow', 'Beauty']) {
    const _csrf = await csrfToken(admin, '/');
    const res = await admin.post('/businesses').type('form').send({ _csrf, name }).expect(302);
    ids[name] = Number(res.headers.location.match(/businesses\/(\d+)/)[1]);
  }
  ids.glowSlug = await publishPage(admin, ids.Glow, 'Glow Promo');
  ids.beautySlug = await publishPage(admin, ids.Beauty, 'Beauty Promo');
});
after(() => pool.end());

describe('choosing a subdomain', () => {
  test('reserved and malformed names are refused; names are unique across businesses', async () => {
    for (const bad of ['app', 'admin', 'www', '-glow', 'gl--ow', 'Glow Shop', 'a'.repeat(40)]) {
      const res = await setSub(withDomain, admin, ids.Glow, bad);
      assert.equal(res.status, 400, bad);
    }
    assert.equal((await setSub(withDomain, admin, ids.Glow, 'glow')).status, 302);
    assert.equal((await setSub(withDomain, admin, ids.Beauty, 'glow')).status, 409);
    assert.equal((await setSub(withDomain, admin, ids.Beauty, 'beauty')).status, 302);
    const { rows } = await pool.query("SELECT action FROM audit_log WHERE action = 'admin.subdomain_changed'");
    assert.equal(rows.length, 2);
  });

  test('without a configured platform domain the status says it is not live, and nothing is served', async () => {
    const admin2 = request.agent(noDomain);
    const _csrf = await csrfToken(admin2, '/login');
    await admin2.post('/login').type('form').send({ _csrf, email: 'owner@platform.test', password: 'correct-horse-battery' }).expect(302);
    const page = await admin2.get(`/admin/businesses/${ids.Glow}`).expect(200);
    assert.match(page.text, /Reserved, not live: the platform domain is not configured yet/);
    await request(noDomain).get(`/${ids.glowSlug}/`).set('Host', 'glow.platform.test').expect(404);
  });
});

describe('serving pages on business subdomains', () => {
  test('each subdomain serves only its own business\'s published pages', async () => {
    const res = await request(withDomain).get(`/${ids.glowSlug}/`).set('Host', 'glow.platform.test').expect(200);
    assert.match(res.text, /Glow Promo/);
    await request(withDomain).get(`/${ids.beautySlug}/`).set('Host', 'glow.platform.test').expect(404);
    await request(withDomain).get(`/${ids.beautySlug}/`).set('Host', 'beauty.platform.test').expect(200);
    await request(withDomain).get('/').set('Host', 'glow.platform.test').expect(302).expect('Location', `/${ids.glowSlug}/`);
    await request(withDomain).get('/x/').set('Host', 'unknown.platform.test').expect(404);
  });

  test('the dashboard is never served on a business subdomain', async () => {
    const res = await request(withDomain).get(`/businesses/${ids.Glow}/orders`).set('Host', 'glow.platform.test');
    assert.equal(res.status, 404);
    await request(withDomain).post('/login').set('Host', 'glow.platform.test').send('x=1').expect(405);
  });

  test('order forms on a business subdomain are accepted for that business only', async () => {
    const { rows: [p] } = await pool.query('INSERT INTO products (business_id, code, name, price_minor) VALUES ($1, $2, $3, 500000) RETURNING id', [ids.Glow, 'glow-serum', 'Glow serum']);
    const { rows: [lp] } = await pool.query('SELECT id FROM landing_pages WHERE slug = $1', [ids.glowSlug]);
    await pool.query('INSERT INTO landing_page_products (landing_page_id, product_id) VALUES ($1, $2)', [lp.id, p.id]);
    clearOriginCache();
    const body = (key) => ({ landingPage: ids.glowSlug, idempotencyKey: key, customer: { name: 'Sub Domain', phone: '08051234567', address: '1 Test Street, Lagos' }, items: [{ product: 'glow-serum', quantity: 1 }] });
    const ok = await request(withDomain).post('/api/public/orders').set('Origin', 'https://glow.platform.test').send(body('subdomain-order-key-0001'));
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    const wrong = await request(withDomain).post('/api/public/orders').set('Origin', 'https://beauty.platform.test').send(body('subdomain-order-key-0002'));
    assert.equal(wrong.status, 403);
    assert.ok(ORIGIN);
  });
});
