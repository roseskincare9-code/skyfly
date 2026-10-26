// Migration 033: the old pixels (one main pixel per platform, page-specific pixels and additional
// pixels such as Larose's) are copied to tracking_pixels with the same behaviour on every page. The
// old tables are not changed, and running the copy again adds nothing.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setup, resetDatabase } from './helpers.js';
import { LAROSE_META_PIXEL_ID, LAROSE_PIXEL_NEW_ID, LAROSE_AD_ACCOUNT_PIXELS } from '../src/scripts/seed-larose.js';
import { browserConfig } from '../src/services/pixels.js';

// The copy steps only (the tables already exist in the test database).
const SQL = readFileSync(new URL('../migrations/033_tracking_pixels.sql', import.meta.url), 'utf8');
const COPY = SQL.slice(SQL.indexOf('-- 1. Business-wide main pixels'));
const { pool, config } = setup({});
let larose; let shop; let pages;

const config_ = async (pageId) => {
  const { rows: [page] } = await pool.query('SELECT id, business_id, slug FROM landing_pages WHERE id = $1', [pageId]);
  return (await browserConfig(pool, page, config)).pixels.map((p) => `${p.provider}:${p.id}`);
};

before(async () => {
  await resetDatabase(pool);
  const { rows: [u] } = await pool.query("INSERT INTO users (email, password_hash, name) VALUES ('owner@larose.test', 'x', 'Owner') RETURNING id");
  larose = (await pool.query("INSERT INTO businesses (owner_id, name, slug, currency) VALUES ($1, 'Larose', 'larose', 'NGN') RETURNING id", [u.id])).rows[0].id;
  shop = (await pool.query("INSERT INTO businesses (owner_id, name, slug, currency) VALUES ($1, 'Shop', 'shop', 'NGN') RETURNING id", [u.id])).rows[0].id;
  const page = async (biz, slug) => (await pool.query("INSERT INTO landing_pages (business_id, slug, name, status) VALUES ($1, $2, $2, 'active') RETURNING id", [biz, slug])).rows[0].id;
  pages = { larose: await page(larose, 'larosenigeria'), a: await page(shop, 'shop-a'), b: await page(shop, 'shop-b'), c: await page(shop, 'shop-c') };

  // Production-like Larose: the main Meta pixel and five additional Meta pixels (one switched off).
  await pool.query("INSERT INTO pixel_settings (business_id, provider, pixel_id, enabled, events) VALUES ($1, 'meta', $2, true, ARRAY['PageView','ViewContent','InitiateCheckout','Lead','Purchase'])", [larose, LAROSE_META_PIXEL_ID]);
  for (const [name, id, enabled] of [['Pixel New', LAROSE_PIXEL_NEW_ID, true], ...LAROSE_AD_ACCOUNT_PIXELS.map((p) => [p.name, p.id, p.id !== '4389240701387003'])]) {
    await pool.query("INSERT INTO additional_pixels (business_id, provider, name, pixel_id, enabled) VALUES ($1, 'meta', $2, $3, $4)", [larose, name, id, enabled]);
  }
  // Another business: a main Meta + TikTok pixel, page B with its own Meta pixel (which replaced the
  // main one there), page C with its own TikTok pixel that is also used elsewhere.
  await pool.query("INSERT INTO pixel_settings (business_id, provider, pixel_id, enabled, server_purchase, access_token_enc) VALUES ($1, 'meta', '1111111111111111', true, true, 'enc:main')", [shop]);
  await pool.query("INSERT INTO pixel_settings (business_id, provider, pixel_id, enabled) VALUES ($1, 'tiktok', 'c4mainpixel000000001', true)", [shop]);
  await pool.query("INSERT INTO pixel_settings (business_id, landing_page_id, provider, pixel_id, enabled) VALUES ($1, $2, 'meta', '2222222222222222', true)", [shop, pages.b]);
  await pool.query("INSERT INTO pixel_settings (business_id, landing_page_id, provider, pixel_id, enabled) VALUES ($1, $2, 'tiktok', 'C4PAGEPIXEL000000003', false)", [shop, pages.c]);
  await pool.query('DELETE FROM tracking_pixels');
});
after(() => pool.end());

test('copies every old pixel once; running again changes nothing; old tables are kept', async () => {
  const oldCounts = async () => (await pool.query('SELECT (SELECT count(*) FROM pixel_settings)::int AS ps, (SELECT count(*) FROM additional_pixels)::int AS ap')).rows[0];
  const before = await oldCounts();
  await pool.query(COPY);
  const snapshot = async () => (await pool.query(
    `SELECT business_id, platform, name, pixel_id, enabled, all_pages, access_token_enc,
            ARRAY(SELECT landing_page_id FROM tracking_pixel_pages pp WHERE pp.tracking_pixel_id = tp.id ORDER BY 1) AS pages
       FROM tracking_pixels tp ORDER BY id`)).rows;
  const first = await snapshot();
  await pool.query(COPY);
  assert.deepEqual(await snapshot(), first);
  assert.deepEqual(await oldCounts(), before);
});

test('Larose: all six Meta pixels, on all pages, enabled as before', async () => {
  const { rows } = await pool.query('SELECT name, pixel_id, enabled, all_pages FROM tracking_pixels WHERE business_id = $1 ORDER BY id', [larose]);
  assert.deepEqual(rows.map((r) => [r.name, r.pixel_id, r.enabled, r.all_pages]), [
    ['Main Meta pixel', LAROSE_META_PIXEL_ID, true, true],
    ['Pixel New', LAROSE_PIXEL_NEW_ID, true, true],
    ...LAROSE_AD_ACCOUNT_PIXELS.map((p) => [p.name, p.id, p.id !== '4389240701387003', true]),
  ]);
  assert.deepEqual(await config_(pages.larose), [LAROSE_META_PIXEL_ID, LAROSE_PIXEL_NEW_ID, ...LAROSE_AD_ACCOUNT_PIXELS.filter((p) => p.id !== '4389240701387003').map((p) => p.id)].map((id) => `meta:${id}`));
});

test('page-specific pixels keep replacing the main one on their page only; tokens are carried over', async () => {
  assert.deepEqual(await config_(pages.a), ['meta:1111111111111111', 'tiktok:C4MAINPIXEL000000001']);
  assert.deepEqual(await config_(pages.b), ['tiktok:C4MAINPIXEL000000001', 'meta:2222222222222222']);
  assert.deepEqual(await config_(pages.c), ['meta:1111111111111111'], 'page C had its own TikTok pixel, switched off');
  const { rows: [main] } = await pool.query("SELECT all_pages, access_token_enc, server_purchase FROM tracking_pixels WHERE pixel_id = '1111111111111111'");
  assert.deepEqual(main, { all_pages: false, access_token_enc: 'enc:main', server_purchase: true });
  const { rows: names } = await pool.query('SELECT name FROM tracking_pixels WHERE business_id = $1 ORDER BY id', [shop]);
  assert.deepEqual(names.map((r) => r.name), ['Main Meta pixel', 'Main TikTok pixel', 'Meta pixel for shop-b', 'TikTok pixel for shop-c']);
});
