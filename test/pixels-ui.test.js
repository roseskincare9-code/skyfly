import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { setup, resetDatabase, csrfToken, signUp } from './helpers.js';
import { seedLarose, LAROSE_META_PIXEL_ID } from '../src/scripts/seed-larose.js';

const { pool, app } = setup({ encryptionKey: randomBytes(32), allowSignup: true, signupFirstOnly: false });
let owner;
let businessId;
const TOKEN = 'tiktok-secret-token-abcdefghijklmnop';

async function post(path, fields) {
  const _csrf = await csrfToken(owner, `/businesses/${businessId}/pixels`);
  return owner.post(`/businesses/${businessId}/pixels${path}`).type('form').send({ _csrf, ...fields });
}

before(async () => {
  await resetDatabase(pool);
  owner = await signUp(app, { email: 'owner@larose.test' });
});
after(() => pool.end());

describe('finding and managing pixels', () => {
  test('with no business yet, the home page says how to get to Pixels', async () => {
    const home = await owner.get('/').expect(200);
    assert.match(home.text, /Set up Larose/);
    assert.match(home.text, /Orders, Pixels and other settings/);
  });

  test('the home page links straight to each business\'s Pixels page', async () => {
    businessId = await seedLarose(pool, 'owner@larose.test');
    await pool.query('DELETE FROM additional_pixels'); // these tests cover the main pixels only (see additional-pixels.test.js)
    const home = await owner.get('/').expect(200);
    assert.ok(home.text.includes(`href="/businesses/${businessId}/pixels"`));
  });

  test('Meta (pre-filled from the live page) can be edited; TikTok shows an Add button', async () => {
    const page = await owner.get(`/businesses/${businessId}/pixels`).expect(200);
    assert.ok(page.text.includes(`value="${LAROSE_META_PIXEL_ID}"`));
    assert.match(page.text, /Remove Meta pixel/);
    assert.match(page.text, /Add TikTok Pixel/);
    assert.doesNotMatch(page.text, /Remove TikTok pixel/);
  });

  test('adding a TikTok pixel persists after a refresh, and its token is never shown', async () => {
    await post('', {
      provider: 'tiktok', enabled: 'on', pixel_id: 'c4abcdefgh1234567890', events: ['PageView', 'Lead'], access_token: TOKEN,
    }).then((r) => assert.equal(r.status, 302, r.text.slice(0, 300)));
    const page = await owner.get(`/businesses/${businessId}/pixels`).expect(200);
    assert.ok(page.text.includes('value="C4ABCDEFGH1234567890"'));
    assert.match(page.text, /Remove TikTok pixel/);
    assert.ok(!page.text.includes(TOKEN));
    const cfg = await request(app).get('/api/public/pages/larosenigeria/tracking').expect(200);
    assert.deepEqual(cfg.body.pixels.map((p) => p.id), [LAROSE_META_PIXEL_ID, 'C4ABCDEFGH1234567890']);
    assert.ok(!JSON.stringify(cfg.body).includes(TOKEN));
  });

  test('editing an ID is saved; invalid IDs are rejected and nothing changes', async () => {
    assert.equal((await post('', { provider: 'tiktok', enabled: 'on', pixel_id: 'D1NEWPIXEL0000000001', events: ['PageView'] })).status, 302);
    assert.equal((await post('', { provider: 'tiktok', enabled: 'on', pixel_id: 'bad id!' })).status, 400);
    const { rows: [row] } = await pool.query("SELECT pixel_id, events, access_token_enc FROM pixel_settings WHERE provider = 'tiktok'");
    assert.equal(row.pixel_id, 'D1NEWPIXEL0000000001');
    assert.deepEqual(row.events, ['PageView']);
    assert.ok(row.access_token_enc, 'blank token field keeps the saved token');
  });

  test('removing a pixel deletes it and its token; Add appears again', async () => {
    const res = await post('/remove', { provider: 'tiktok' });
    assert.equal(res.status, 302);
    assert.match(res.headers.location, /done=deleted/);
    const { rowCount } = await pool.query("SELECT 1 FROM pixel_settings WHERE provider = 'tiktok'");
    assert.equal(rowCount, 0);
    const page = await owner.get(`/businesses/${businessId}/pixels?done=deleted`).expect(200);
    assert.match(page.text, /Pixel removed\./);
    assert.match(page.text, /Add TikTok Pixel/);
    const cfg = await request(app).get('/api/public/pages/larosenigeria/tracking').expect(200);
    assert.deepEqual(cfg.body.pixels.map((p) => p.provider), ['meta']);
  });

  test('another account cannot see or change these pixels', async () => {
    const other = await signUp(app, { email: 'someone@else.test' });
    await other.get(`/businesses/${businessId}/pixels`).expect(404);
    const _csrf = await csrfToken(other, '/');
    await other.post(`/businesses/${businessId}/pixels/remove`).type('form').send({ _csrf, provider: 'meta' }).expect(404);
    const { rowCount } = await pool.query("SELECT 1 FROM pixel_settings WHERE provider = 'meta'");
    assert.equal(rowCount, 1);
  });

  test('signed out, the Pixels page redirects to login', async () => {
    const res = await request(app).get(`/businesses/${businessId}/pixels`);
    assert.equal(res.status, 302);
    assert.match(res.headers.location, /\/login/);
  });
});
