// Migration 029: Meta pixels of the owner's other ad accounts on Larose's pages, next to the main pixel
// and "Pixel New". Each pixel is listed once (an ID the business already uses is not added again),
// nothing else changes, and the page gets public pixel IDs only.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import request from 'supertest';
import { setup, resetDatabase, signUp } from './helpers.js';
import { seedLarose, LAROSE_META_PIXEL_ID, LAROSE_PIXEL_NEW_ID, LAROSE_AD_ACCOUNT_PIXELS } from '../src/scripts/seed-larose.js';
import { clearOriginCache } from '../src/lib/origins.js';

const MIGRATION = readFileSync(new URL('../migrations/029_larose_ad_account_pixels.sql', import.meta.url), 'utf8');
const NEW_IDS = LAROSE_AD_ACCOUNT_PIXELS.map((p) => p.id);
const { pool, app } = setup({});
let larose; let other;
const rows = async (businessId) => (await pool.query(
  'SELECT name, pixel_id, enabled FROM additional_pixels WHERE business_id = $1 ORDER BY id', [businessId])).rows.map((r) => [r.name, r.pixel_id, r.enabled]);

before(async () => {
  await resetDatabase(pool);
  await signUp(app, { email: 'owner@larose.test' });
  larose = await seedLarose(pool, 'owner@larose.test');
  // As in production before the change: only Pixel New, and one of the IDs already set up by the owner.
  await pool.query('DELETE FROM additional_pixels WHERE pixel_id = ANY($1)', [NEW_IDS]);
  await pool.query("INSERT INTO additional_pixels (business_id, provider, name, pixel_id, enabled) VALUES ($1, 'meta', 'Moon fly (owner)', '4389240701387003', false)", [larose]);
  const { rows: [u] } = await pool.query("INSERT INTO users (email, password_hash, name) VALUES ('other@shop.test', 'x', 'Other') RETURNING id");
  other = (await pool.query("INSERT INTO businesses (owner_id, name, slug, currency) VALUES ($1, 'Other Shop', 'other-shop', 'NGN') RETURNING id", [u.id])).rows[0].id;
  clearOriginCache();
});
after(() => pool.end());

test('the confirmed IDs are the seed pixels for new setups', () => {
  assert.deepEqual(LAROSE_AD_ACCOUNT_PIXELS.map((p) => [p.name, p.id]),
    [['Skyfly', '1105657388903531'], ['Skindrips', '1653102723149813'], ['Skindrip', '1130654146607839'], ['Moon fly', '4389240701387003']]);
});

test('adds the missing pixels to Larose only; an existing row and Pixel New are kept; running again changes nothing', async () => {
  await pool.query(MIGRATION);
  await pool.query(MIGRATION);
  assert.deepEqual(await rows(larose), [
    ['Pixel New', LAROSE_PIXEL_NEW_ID, true],
    ['Moon fly (owner)', '4389240701387003', false],
    ['Skyfly', '1105657388903531', true],
    ['Skindrips', '1653102723149813', true],
    ['Skindrip', '1130654146607839', true],
  ]);
  assert.deepEqual(await rows(other), [], 'another business is untouched');
  const { rows: main } = await pool.query("SELECT pixel_id FROM pixel_settings WHERE business_id = $1 AND provider = 'meta'", [larose]);
  assert.deepEqual(main.map((r) => r.pixel_id), [LAROSE_META_PIXEL_ID], 'the main pixel is unchanged');
});

test('the Larose page gets every enabled pixel once, with the browser events and no token', async () => {
  await pool.query("UPDATE additional_pixels SET enabled = true WHERE pixel_id = '4389240701387003'");
  const res = await request(app).get('/api/public/pages/larosenigeria/tracking').expect(200);
  assert.deepEqual(res.body.pixels.map((p) => p.id), [LAROSE_META_PIXEL_ID, LAROSE_PIXEL_NEW_ID, '4389240701387003', '1105657388903531', '1653102723149813', '1130654146607839']);
  for (const p of res.body.pixels) {
    assert.equal(p.provider, 'meta');
    assert.deepEqual(p.events, ['PageView', 'ViewContent', 'InitiateCheckout', 'Lead', 'Purchase']);
  }
  assert.equal(new Set(res.body.pixels.map((p) => p.id)).size, res.body.pixels.length, 'no pixel listed twice');
  assert.ok(!/token|secret/i.test(JSON.stringify(res.body)));
});

test('a pixel already used as the main pixel is not added a second time', async () => {
  await pool.query('DELETE FROM additional_pixels WHERE business_id = $1 AND pixel_id = ANY($2)', [larose, NEW_IDS]);
  await pool.query("UPDATE pixel_settings SET pixel_id = '1105657388903531' WHERE business_id = $1 AND provider = 'meta'", [larose]);
  await pool.query(MIGRATION);
  const ids = (await rows(larose)).map((r) => r[1]);
  assert.ok(!ids.includes('1105657388903531'));
  assert.ok(['1653102723149813', '1130654146607839', '4389240701387003'].every((id) => ids.includes(id)));
});
