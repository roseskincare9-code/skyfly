// Order routing per business when publishing: a "WhatsApp direct" page needs the business's own
// WhatsApp number (never Larose's or another business's), and when the Skyfly checkout was added but
// the page's own "Order on WhatsApp" buttons still go elsewhere, Publish points them to the checkout.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setup, resetDatabase, csrfToken, signUp } from './helpers.js';
import { readFile } from '../src/hosting/storage.js';

const { pool, app } = setup({ allowedOrigins: [] });
let owner; let biz;
const HTML = `<!doctype html><html><head><title>Shop</title></head><body><h1>Second Shop</h1><p>Natural cream for every skin type, made with care.</p>
<a href="https://wa.me/2348000000000?text=order">Order on WhatsApp</a></body></html>`;

async function newPage(name, destination) {
  const list = `/businesses/${biz}/landing-pages`;
  let _csrf = await csrfToken(owner, list);
  const up = await owner.post(`${list}/upload`).field('_csrf', _csrf).field('name', name).attach('file', Buffer.from(HTML), 'index.html').expect(302);
  const pageId = up.headers.location.match(/landing-pages\/(\d+)/)[1];
  const base = `${list}/${pageId}`;
  const { rows: [v] } = await pool.query('SELECT id FROM page_versions WHERE landing_page_id = $1', [pageId]);
  _csrf = await csrfToken(owner, base);
  await owner.post(`${base}/versions/${v.id}/add-checkout`).type('form').send({ _csrf }).expect(302);
  await pool.query("INSERT INTO landing_page_products (landing_page_id, product_id) SELECT $1, id FROM products WHERE business_id = $2", [pageId, biz]);
  await pool.query('UPDATE landing_pages SET order_destination = $2 WHERE id = $1', [pageId, destination]);
  const { rows: [latest] } = await pool.query('SELECT id FROM page_versions WHERE landing_page_id = $1 ORDER BY id DESC LIMIT 1', [pageId]);
  return { pageId, base, versionId: latest.id };
}
const publish = async ({ base, versionId }) => {
  const _csrf = await csrfToken(owner, base);
  return owner.post(`${base}/publish`).type('form').send({ _csrf, version_id: versionId });
};

before(async () => {
  await resetDatabase(pool);
  owner = await signUp(app, { email: 'owner@second.test' });
  const _csrf = await csrfToken(owner, '/');
  await owner.post('/businesses').type('form').send({ _csrf, name: 'Second Shop' }).expect(302);
  biz = (await pool.query("SELECT id FROM businesses WHERE name = 'Second Shop'")).rows[0].id;
  await pool.query("INSERT INTO products (business_id, code, name, price_minor) VALUES ($1, 'cream', 'Second Cream', 900000)", [biz]);
});
after(() => pool.end());

test('a "WhatsApp direct" page is not published while the business has no WhatsApp number of its own', async () => {
  const p = await newPage('Direct', 'whatsapp');
  const res = await publish(p);
  assert.equal(res.status, 400);
  assert.match(res.text, /Order destination: This page is set to &#34;WhatsApp direct&#34;, but the business has no WhatsApp number/);
  assert.equal((await pool.query('SELECT status FROM landing_pages WHERE id = $1', [p.pageId])).rows[0].status, 'draft');
  await pool.query("UPDATE businesses SET whatsapp_number = '+2348059998888' WHERE id = $1", [biz]);
  assert.equal((await publish(p)).status, 302);
  const catalog = (await owner.get('/api/public/pages/direct/catalog').expect(200)).body;
  assert.equal(catalog.whatsapp, '2348059998888', "the page's WhatsApp hand-off is this business's own number");
});

test("publishing points the page's own purchase buttons to the Skyfly checkout (not the old WhatsApp number)", async () => {
  const p = await newPage('Checkout', 'checkout_whatsapp');
  const res = await publish(p);
  assert.equal(res.status, 302, res.text.slice(0, 300));
  const { rows: [lp] } = await pool.query('SELECT status, published_version_id FROM landing_pages WHERE id = $1', [p.pageId]);
  assert.equal(lp.status, 'active');
  const { rows: [v] } = await pool.query('SELECT id, entry_path FROM page_versions WHERE id = $1', [lp.published_version_id]);
  const html = (await readFile(pool, v.id, v.entry_path)).data.toString('utf8');
  assert.match(html, /<a[^>]*data-skyfly-buy[^>]*>Order on WhatsApp<\/a>/, 'the button opens the Skyfly order form');
  assert.doesNotMatch(html, /<a[^>]*\shref="https:\/\/wa\.me\/2348000000000/, 'no button still goes to the old number');
});
