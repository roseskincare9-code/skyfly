// Editing hosted pages in the browser, and sandboxed previews on the dashboard address.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { setup, resetDatabase, csrfToken, signUp } from './helpers.js';
import { seedLarose } from '../src/scripts/seed-larose.js';
import { importUpload } from '../src/hosting/importer.js';
import { saveVersion, readFile } from '../src/hosting/storage.js';
import { previewToken } from '../src/hosting/preview.js';

const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Glow Shop</title>
<meta name="description" content="Natural glow">
<style>:root{--gold:#C9A96E;--dark:#12100E}body{color:var(--dark)}</style></head><body>
<section id="hero"><h1>Finally, skin you love</h1><p>Order today &amp; save</p><img src="img/hero.png" alt="Hero"></section>
<section id="packages"><h2>Packages</h2><select id="pr"><option value="">Choose</option>
<option value="Package 1 – Starter – ₦23,500" data-product="package-1" data-price="23500">Package 1 — ₦23,500</option></select></section>
<section id="faq"><h2>Questions</h2><p>Pay on delivery</p></section>
<script>/* keep me exactly */ var x = "<b>not text</b>";</script></body></html>`;

const { pool, app, config } = setup();
let owner;
let businessId;
let pageId;
let versionId;

async function edit(fields, files = {}, agent = owner, vid = versionId) {
  const path = `/businesses/${businessId}/landing-pages/${pageId}/versions/${vid}/edit`;
  const _csrf = await csrfToken(owner, `/businesses/${businessId}/landing-pages/${pageId}/versions/${versionId}/edit`);
  let r = agent.post(path).field('_csrf', _csrf);
  for (const [k, v] of Object.entries(fields)) r = r.field(k, v);
  for (const [k, [buf, name]] of Object.entries(files)) r = r.attach(k, buf, name);
  return r;
}
const versions = async () => (await pool.query('SELECT id FROM page_versions WHERE landing_page_id = $1 ORDER BY id', [pageId])).rows.map((r) => r.id);
const html = async (vid) => (await readFile(pool, vid, 'index.html')).data.toString('utf8');

before(async () => {
  await resetDatabase(pool);
  owner = await signUp(app, { email: 'owner@larose.test' });
  businessId = await seedLarose(pool, 'owner@larose.test');
  const { rows: [p] } = await pool.query("INSERT INTO landing_pages (business_id, slug, name, status) VALUES ($1, 'glow', 'Glow', 'draft') RETURNING id", [businessId]);
  pageId = p.id;
  // Build the upload as the importer would see a ZIP: index.html + img/hero.png.
  const upload = await importUpload({ buffer: Buffer.from(PAGE), originalname: 'index.html' });
  const img = { path: 'img/hero.png', data: PNG, size: PNG.length, contentType: 'image/png', sha256: (await import('node:crypto')).createHash('sha256').update(PNG).digest('hex') };
  upload.files.push(img);
  upload.totalBytes += PNG.length;
  versionId = await saveVersion(pool, { pageId, userId: null, upload });
});
after(() => pool.end());

describe('page editor', () => {
  test('the editor lists title, description, prices, colours, images, sections and texts', async () => {
    const res = await owner.get(`/businesses/${businessId}/landing-pages/${pageId}/versions/${versionId}/edit`).expect(200);
    for (const s of ['value="Glow Shop"', 'Natural glow', 'name="price_0" value="23500"', 'Skyfly price 23,500', 'value="#C9A96E"', 'img/hero.png', 'Finally, skin you love', 'Order today &amp; save', 'name="position_2"']) {
      assert.ok(res.text.includes(s), `missing ${s}`);
    }
    assert.doesNotMatch(res.text, /keep me exactly|not text/, 'script content is never offered as text');
  });

  test('saving creates a new version with only the edited parts changed; the old version is untouched', async () => {
    const before = await html(versionId);
    const res = await edit({ title: 'Glow Shop Lagos', text_0: "Finally, skin you're proud of", color_0: '#B8860B', section_order_input: '1', position_0: '1', position_1: '2', position_2: '3' });
    assert.equal(res.status, 302, res.text.slice(0, 300));
    const [, v2] = await versions();
    const after = await html(v2);
    assert.equal(await html(versionId), before, 'previous version unchanged');
    assert.match(after, /<title>Glow Shop Lagos<\/title>/);
    assert.match(after, /<h1>Finally, skin you&#39;re proud of<\/h1>|<h1>Finally, skin you're proud of<\/h1>/);
    assert.match(after, /--gold:#B8860B/);
    assert.ok(after.includes('<script>/* keep me exactly */ var x = "<b>not text</b>";</script>'), 'scripts byte-identical');
    assert.ok(after.includes('<p>Order today &amp; save</p>'), 'unedited text byte-identical');
    assert.equal((await readFile(pool, v2, 'img/hero.png')).data.equals(PNG), true, 'image carried over');
    const page = await owner.get(`/businesses/${businessId}/landing-pages/${pageId}?done=edited`).expect(200);
    assert.match(page.text, /saved as a new version/);
  });

  test('prices: the page price changes and, if chosen, the Skyfly product price too', async () => {
    const [, v2] = await versions();
    const _csrf = await csrfToken(owner, `/businesses/${businessId}/landing-pages/${pageId}/versions/${v2}/edit`);
    const res = await owner.post(`/businesses/${businessId}/landing-pages/${pageId}/versions/${v2}/edit`)
      .field('_csrf', _csrf).field('price_0', '24,000').field('update_product_prices', 'on');
    assert.equal(res.status, 302);
    const v3 = (await versions()).at(-1);
    assert.match(await html(v3), /data-product="package-1" data-price="24000"/);
    const { rows: [p] } = await pool.query("SELECT price_minor FROM products WHERE business_id = $1 AND code = 'package-1'", [businessId]);
    assert.equal(Number(p.price_minor), 2400000);
    await pool.query("UPDATE products SET price_minor = 2350000 WHERE business_id = $1 AND code = 'package-1'", [businessId]);
  });

  test('sections can be removed and reordered; images replaced', async () => {
    const res = await edit({ section_order_input: '1', position_0: '2', position_1: '1', position_2: '3', remove_section_2: 'on' }, { image_0: [JPG, 'new.jpg'] });
    assert.equal(res.status, 302, res.text.slice(0, 300));
    const out = await html((await versions()).at(-1));
    assert.ok(out.indexOf('id="packages"') < out.indexOf('id="hero"'), 'packages now first');
    assert.ok(!out.includes('id="faq"'), 'faq removed');
    assert.ok((await readFile(pool, (await versions()).at(-1), 'img/hero.png')).data.equals(JPG), 'image replaced');
  });

  test('invalid input is refused and no version is created', async () => {
    const count = (await versions()).length;
    assert.equal((await edit({ color_0: 'red; background:url(x)' })).status, 400);
    assert.equal((await edit({ text_0: '   ' })).status, 400);
    assert.equal((await edit({}, { image_0: [Buffer.from('<svg onload=alert(1)>'), 'x.png'] })).status, 400);
    assert.equal((await edit({ title: 'Glow Shop' })).status, 400, 'nothing changed');
    assert.equal((await versions()).length, count);
  });

  test('another account cannot open or save the editor', async () => {
    const other = await signUp(app, { email: 'other@shop.test' });
    await other.get(`/businesses/${businessId}/landing-pages/${pageId}/versions/${versionId}/edit`).expect(404);
    await request(app).get(`/businesses/${businessId}/landing-pages/${pageId}/versions/${versionId}/edit`).expect(302);
  });
});

describe('sandboxed preview on the dashboard address', () => {
  test('a signed link shows the page in a sandbox without same-origin access; files load; bad links fail', async () => {
    const token = previewToken(config.sessionSecret, versionId);
    const res = await request(app).get(`/_sandbox/${versionId}/${token}/`).expect(200);
    assert.match(res.headers['content-security-policy'], /^sandbox allow-scripts allow-forms allow-popups allow-modals; frame-ancestors 'self'$/);
    assert.doesNotMatch(res.headers['content-security-policy'], /allow-same-origin/);
    assert.match(res.text, /Finally, skin you love/);
    await request(app).get(`/_sandbox/${versionId}/${token}/img/hero.png`).expect(200).expect('Content-Type', /image\/png/);
    await request(app).get(`/_sandbox/${versionId}/1.bad/`).expect(404);
    await request(app).get(`/_sandbox/${versionId}/${token}/../../etc/passwd`).expect(404);
    const preview = await owner.get(`/businesses/${businessId}/landing-pages/${pageId}/versions/${versionId}/preview`).expect(200);
    assert.match(preview.text, /<iframe title="Phone preview" src="\/_sandbox\//);
  });
});
