// Migration 058: Larose's "skincare" Meta pixel (1395209215400304) is also assigned to the
// Skyfly-hosted Larose page (larose-skincare), keeping its GitHub Pages assignment. Each pixel loads
// once per page, nothing else about the pixel or any other pixel/business changes, running it again
// changes nothing, and a pixel already on "All pages" is left as it is.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setup, resetDatabase, addTrackingPixel } from './helpers.js';
import { browserConfig } from '../src/services/pixels.js';

const M034 = readFileSync(new URL('../migrations/034_larose_skincare_pixel.sql', import.meta.url), 'utf8');
const M058 = readFileSync(new URL('../migrations/058_larose_skincare_pixel_hosted_page.sql', import.meta.url), 'utf8');
const SKINCARE = '1395209215400304';
const MAIN = '1357015185691765';
const MASS = '1798662434594348';
const { pool, config } = setup({});
let larose; let other; let github; let hosted; let otherPage; let thirdLarosePage;

const pixelsOn = async (pageId) => {
  const { rows: [p] } = await pool.query('SELECT id, business_id, slug FROM landing_pages WHERE id = $1', [pageId]);
  return (await browserConfig(pool, p, config)).pixels.map((x) => x.id);
};
const snapshot = async () => (await pool.query(
  `SELECT tp.business_id, tp.name, tp.pixel_id, tp.enabled, tp.all_pages, tp.events, tp.access_token_enc, tp.server_purchase,
          ARRAY(SELECT landing_page_id::int FROM tracking_pixel_pages pp WHERE pp.tracking_pixel_id = tp.id ORDER BY 1) AS pages
     FROM tracking_pixels tp ORDER BY tp.id`)).rows;

before(async () => {
  await resetDatabase(pool);
  const { rows: [u] } = await pool.query("INSERT INTO users (email, password_hash, name) VALUES ('owner@larose.test', 'x', 'Owner') RETURNING id");
  larose = (await pool.query("INSERT INTO businesses (owner_id, name, slug, currency) VALUES ($1, 'Larose Natural Skincare Nigeria', 'larose-nigeria', 'NGN') RETURNING id", [u.id])).rows[0].id;
  other = (await pool.query("INSERT INTO businesses (owner_id, name, slug, currency) VALUES ($1, 'Other', 'other-shop', 'NGN') RETURNING id", [u.id])).rows[0].id;
  github = (await pool.query("INSERT INTO landing_pages (business_id, slug, name, url, status) VALUES ($1, 'larosenigeria', 'Larose Nigeria (GitHub Pages)', 'https://roseskincare9-code.github.io/Larosenigeria/', 'active') RETURNING id", [larose])).rows[0].id;
  hosted = (await pool.query("INSERT INTO landing_pages (business_id, slug, name, status) VALUES ($1, 'larose-skincare', 'Larose Skincare (Skyfly-hosted)', 'active') RETURNING id", [larose])).rows[0].id;
  thirdLarosePage = (await pool.query("INSERT INTO landing_pages (business_id, slug, name, status) VALUES ($1, 'larose-uk', 'Larose UK', 'active') RETURNING id", [larose])).rows[0].id;
  otherPage = (await pool.query("INSERT INTO landing_pages (business_id, slug, name, status) VALUES ($1, 'other-page', 'Other page', 'active') RETURNING id", [other])).rows[0].id;
  // As in production: the main pixel with a server token on every page, the owner's Mass pixel on
  // every page, and "skincare" from migration 034 on the GitHub Pages page only.
  await addTrackingPixel(pool, larose, { pixelId: MAIN, name: 'Main Meta pixel', serverPurchase: true, tokenEnc: 'enc:main-token', events: ['PageView', 'InitiateCheckout', 'Lead', 'Purchase'] });
  await addTrackingPixel(pool, larose, { pixelId: MASS, name: 'Mass', allPages: true });
  await pool.query(M034);
  // Another business with the same pixel ID must not be touched.
  await addTrackingPixel(pool, other, { pixelId: SKINCARE, name: 'skincare (other)', allPages: false });
});
after(() => pool.end());

test('before 058: "skincare" loads on the GitHub Pages page but not on the Skyfly-hosted page', async () => {
  assert.deepEqual(await pixelsOn(github), [MAIN, MASS, SKINCARE]);
  assert.deepEqual(await pixelsOn(hosted), [MAIN, MASS]);
});

test('058 adds the hosted page and keeps the GitHub Pages assignment; nothing else changes', async () => {
  const before = await snapshot();
  await pool.query(M058);
  await pool.query(M058);
  const now = await snapshot();
  assert.equal(now.length, before.length, 'no tracking ID added or removed');
  for (let i = 0; i < now.length; i++) {
    const isLaroseSkincare = now[i].business_id === Number(larose) && now[i].pixel_id === SKINCARE;
    if (!isLaroseSkincare) { assert.deepEqual(now[i], before[i], `${now[i].name} untouched`); continue; }
    const { pages, ...rest } = now[i]; const { pages: was, ...restWas } = before[i];
    assert.deepEqual(rest, restWas, 'events, enabled, token and "all pages" unchanged');
    assert.deepEqual(was, [Number(github)]);
    assert.deepEqual(pages, [Number(github), Number(hosted)].sort((a, b) => a - b));
  }
});

test('after 058: each pixel loads once on both Larose pages; other pages are unchanged', async () => {
  assert.deepEqual(await pixelsOn(github), [MAIN, MASS, SKINCARE]);
  assert.deepEqual(await pixelsOn(hosted), [MAIN, MASS, SKINCARE]);
  const hostedIds = await pixelsOn(hosted);
  assert.equal(new Set(hostedIds).size, hostedIds.length, 'no pixel listed twice');
  assert.deepEqual(await pixelsOn(thirdLarosePage), [MAIN, MASS], 'another Larose page does not get "skincare"');
  assert.deepEqual(await pixelsOn(otherPage), [], 'another business keeps its own (unassigned) pixel off');
});

test('every event of "skincare" stays enabled for the hosted page (PageView to Purchase)', async () => {
  const { rows: [p] } = await pool.query('SELECT id, business_id, slug FROM landing_pages WHERE id = $1', [hosted]);
  const s = (await browserConfig(pool, p, config)).pixels.find((x) => x.id === SKINCARE);
  assert.deepEqual(s.events, ['PageView', 'ViewContent', 'InitiateCheckout', 'Lead', 'Purchase']);
});

test('a "skincare" pixel the owner set to All pages is left as it is', async () => {
  await pool.query('DELETE FROM tracking_pixels WHERE business_id = $1 AND pixel_id = $2', [larose, SKINCARE]);
  await addTrackingPixel(pool, larose, { pixelId: SKINCARE, name: 'skincare', allPages: true });
  const before = await snapshot();
  await pool.query(M058);
  assert.deepEqual(await snapshot(), before);
  assert.deepEqual(await pixelsOn(hosted), [MAIN, MASS, SKINCARE]);
});
