// Tracking & Pixels statuses come from evidence only: Saved -> Installed (a published page reported the
// script loaded) -> Receiving events (the platform accepted an event) / Verification failed (refused).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setup, resetDatabase, csrfToken, signUp, addTrackingPixel } from './helpers.js';
import { trackingStatus } from '../src/services/pixels.js';

const { pool, app } = setup({ allowedOrigins: [] });
let owner; let biz;
const statusOf = async () => {
  const res = await owner.get(`/businesses/${biz}/pixels?platform=meta`).expect(200);
  return res.text.match(/data-status="(\w+)"[^>]*>\s*<span[^>]*>([^<]+)<\/span>\s*<span[^>]*>([^<]+)<\/span>/).slice(1, 4);
};

before(async () => {
  await resetDatabase(pool);
  owner = await signUp(app, { email: 'owner@status.test' });
  const _csrf = await csrfToken(owner, '/');
  await owner.post('/businesses').type('form').send({ _csrf, name: 'Status Shop' }).expect(302);
  biz = (await pool.query("SELECT id FROM businesses WHERE name = 'Status Shop'")).rows[0].id;
});
after(() => pool.end());

test('saving an ID never shows Installed or Verified; each status needs its own evidence', async () => {
  const p = await addTrackingPixel(pool, biz, { pixelId: '123456789012345', allPages: true });
  let [key, label, detail] = await statusOf();
  assert.deepEqual([key, label], ['saved', 'Saved']);
  assert.match(detail, /none of its pages is published yet/);
  assert.doesNotMatch((await owner.get(`/businesses/${biz}/pixels?platform=meta`)).text, /Verified|Receiving events<\/span>/);

  const { rows: [lp] } = await pool.query("INSERT INTO landing_pages (business_id, name, slug, status, url) VALUES ($1, 'Live', 'status-live', 'active', 'https://shop.example/') RETURNING id", [biz]);
  [key, , detail] = await statusOf();
  assert.equal(key, 'saved');
  assert.match(detail, /waiting for the first visit/);

  await pool.query('UPDATE tracking_pixels SET browser_seen_at = now(), browser_seen_page = $2 WHERE id = $1', [p.id, lp.id]);
  [key, label] = await statusOf();
  assert.deepEqual([key, label], ['installed', 'Installed']);

  await pool.query("UPDATE tracking_pixels SET verification_failed_at = now(), verification_error = 'Invalid OAuth access token' WHERE id = $1", [p.id]);
  [key, label, detail] = await statusOf();
  assert.deepEqual([key, label], ['failed', 'Verification failed']);
  assert.match(detail, /Invalid OAuth access token/);

  await pool.query('UPDATE tracking_pixels SET test_event_at = now(), server_verified_at = now(), verification_failed_at = NULL WHERE id = $1', [p.id]);
  [key, label] = await statusOf();
  assert.deepEqual([key, label], ['receiving', 'Receiving events']);
});

test('the reasons for "Saved" are specific; a later failure wins over an older success', () => {
  const base = { enabled: true, all_pages: true, page_count: 0, live_pages: 1 };
  assert.match(trackingStatus({ ...base, enabled: false }).detail, /switched off/);
  assert.match(trackingStatus({ ...base, all_pages: false }).detail, /not assigned/);
  const older = new Date(Date.now() - 60000); const newer = new Date();
  assert.equal(trackingStatus({ ...base, server_verified_at: older, verification_failed_at: newer, verification_error: 'x' }).key, 'failed');
  assert.equal(trackingStatus({ ...base, server_verified_at: newer, verification_failed_at: older }).key, 'receiving');
  assert.equal(trackingStatus({ ...base, browser_verified_at: newer }).detail.includes('You confirmed'), true);
});
