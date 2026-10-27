// Migration 034: Larose's "skincare" Meta pixel (1395209215400304) is added as its own tracking ID,
// assigned to the Larose landing page only, next to the pixels it already has (unchanged). Running
// it again changes nothing, an ID the business already has is left as it is, and no other
// business is touched.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setup, resetDatabase, addTrackingPixel } from './helpers.js';
import { browserConfig } from '../src/services/pixels.js';

const MIGRATION = readFileSync(new URL('../migrations/034_larose_skincare_pixel.sql', import.meta.url), 'utf8');
const SKINCARE = '1395209215400304';
const MAIN = '1357015185691765';
const { pool, config } = setup({});
let larose; let other; let page; let hosted;

const pixelsOn = async (pageId) => {
  const { rows: [p] } = await pool.query('SELECT id, business_id, slug FROM landing_pages WHERE id = $1', [pageId]);
  return (await browserConfig(pool, p, config)).pixels.map((x) => x.id);
};
const rows = async (biz) => (await pool.query(
  `SELECT name, pixel_id, enabled, all_pages, events, access_token_enc, server_purchase,
          ARRAY(SELECT landing_page_id FROM tracking_pixel_pages pp WHERE pp.tracking_pixel_id = tp.id ORDER BY 1) AS pages
     FROM tracking_pixels tp WHERE business_id = $1 ORDER BY id`, [biz])).rows;

before(async () => {
  await resetDatabase(pool);
  const { rows: [u] } = await pool.query("INSERT INTO users (email, password_hash, name) VALUES ('owner@larose.test', 'x', 'Owner') RETURNING id");
  larose = (await pool.query("INSERT INTO businesses (owner_id, name, slug, currency) VALUES ($1, 'Larose Natural Skincare Nigeria', 'larose-nigeria', 'NGN') RETURNING id", [u.id])).rows[0].id;
  other = (await pool.query("INSERT INTO businesses (owner_id, name, slug, currency) VALUES ($1, 'Other', 'other-shop', 'NGN') RETURNING id", [u.id])).rows[0].id;
  page = (await pool.query("INSERT INTO landing_pages (business_id, slug, name, url, status) VALUES ($1, 'larosenigeria', 'Larose Nigeria (GitHub Pages)', 'https://roseskincare9-code.github.io/Larosenigeria/', 'active') RETURNING id", [larose])).rows[0].id;
  hosted = (await pool.query("INSERT INTO landing_pages (business_id, slug, name, status) VALUES ($1, 'larose-skincare', 'Larose (Skyfly)', 'active') RETURNING id", [larose])).rows[0].id;
  await pool.query("INSERT INTO landing_pages (business_id, slug, name, status) VALUES ($1, 'other-page', 'Other page', 'active')", [other]);
  // As in production: the main pixel (with a server token and settings) on every page.
  await addTrackingPixel(pool, larose, { pixelId: MAIN, name: 'Main Meta pixel', serverPurchase: true, tokenEnc: 'enc:main-token', events: ['PageView', 'InitiateCheckout', 'Lead', 'Purchase'] });
});
after(() => pool.end());

test('adds "skincare" once, on the Larose page with every event; the main pixel and its settings are unchanged', async () => {
  const before = await rows(larose);
  await pool.query(MIGRATION);
  await pool.query(MIGRATION);
  const now = await rows(larose);
  assert.deepEqual(now[0], before[0], 'main pixel untouched (token, events, pages)');
  assert.equal(now.length, 2);
  assert.deepEqual(
    { ...now[1], pages: now[1].pages.map(Number) },
    { name: 'skincare', pixel_id: SKINCARE, enabled: true, all_pages: false, events: ['PageView', 'ViewContent', 'InitiateCheckout', 'Lead', 'Purchase'], access_token_enc: null, server_purchase: false, pages: [Number(page)] },
  );
  assert.deepEqual(await rows(other), [], 'another business is untouched');
});

test('both pixels load on the Larose page, each once; the other Larose page keeps only the main pixel', async () => {
  assert.deepEqual(await pixelsOn(page), [MAIN, SKINCARE]);
  assert.deepEqual(await pixelsOn(hosted), [MAIN]);
});

test('an ID the business already has is left as it is', async () => {
  await pool.query('DELETE FROM tracking_pixels WHERE business_id = $1 AND pixel_id = $2', [larose, SKINCARE]);
  await addTrackingPixel(pool, larose, { pixelId: SKINCARE, name: 'Set up by the owner', allPages: true, events: ['PageView'], enabled: false });
  const before = await rows(larose);
  await pool.query(MIGRATION);
  assert.deepEqual(await rows(larose), before);
});
