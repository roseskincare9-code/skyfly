// A new business connects its Meta Pixel from the dashboard, as a non-technical owner would: the
// Overview offers the step (or "Skip for now"), the form explains browser vs server-side tracking,
// saving the ID with its pages starts browser tracking there at once (no code, no redeploy), and a
// second Pixel runs next to the first. Staff do not see the step; another business cannot reach it.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { setup, resetDatabase, csrfToken, signUp, openClientSignup } from './helpers.js';
import { clearOriginCache } from '../src/lib/origins.js';

const { pool, app } = setup({ allowSignup: true, signupFirstOnly: false });
let owner; let biz; let page; let other; let otherBiz;
const PIXEL_A = '2100000000000001';
const PIXEL_B = '2100000000000002';

async function createBusiness(agent, name) {
  const _csrf = await csrfToken(agent, '/');
  await agent.post('/businesses').type('form').send({ _csrf, name }).expect(302);
  return (await pool.query('SELECT id FROM businesses WHERE name = $1', [name])).rows[0].id;
}
async function connect(fields, agent = owner, b = biz) {
  const _csrf = await csrfToken(agent, `/businesses/${b}/pixels/new?platform=meta`);
  return agent.post(`/businesses/${b}/pixels`).type('form').send({ _csrf, platform: 'meta', enabled: 'on', events: ['PageView', 'ViewContent', 'InitiateCheckout', 'Lead', 'Purchase'], ...fields });
}
const tracking = async () => (await request(app).get('/api/public/pages/glow-shop-page/tracking').expect(200)).body.pixels.map((p) => p.id);

before(async () => {
  await resetDatabase(pool);
  await signUp(app, { email: 'platform@skyfly.test' }); // the first account is the platform owner
  await openClientSignup(pool);
  owner = await signUp(app, { email: 'owner@glow.test' });
  biz = await createBusiness(owner, 'Glow Shop');
  page = (await pool.query(
    "INSERT INTO landing_pages (business_id, slug, name, url, status) VALUES ($1, 'glow-shop-page', 'Glow page', 'https://glow.example/', 'active') RETURNING id", [biz])).rows[0].id;
  other = await signUp(app, { email: 'owner@other.test' });
  otherBiz = await createBusiness(other, 'Other Shop');
  clearOriginCache();
});
after(() => pool.end());

describe('connecting a Meta Pixel from the dashboard', () => {
  test('the Overview of a new business offers "Connect Meta Pixel" (optional) with "Skip for now"', async () => {
    const home = await owner.get(`/businesses/${biz}`).expect(200);
    assert.match(home.text, /data-pixel-step/);
    assert.match(home.text, new RegExp(`href="/businesses/${biz}/pixels/new\\?platform=meta">Connect Meta Pixel`));
    assert.match(home.text, /Skip for now/);
  });

  test('the form explains that the Pixel ID is enough for browser tracking and server-side is optional', async () => {
    const form = await owner.get(`/businesses/${biz}/pixels/new?platform=meta`).expect(200);
    assert.match(form.text, /<h1>Connect a Meta Pixel<\/h1>/);
    assert.match(form.text, /data-how-it-works[\s\S]*Pixel ID and your pages are all you need[\s\S]*no website code, no redeploy[\s\S]*Server-side tracking \(optional\)/);
    assert.match(form.text, /Save and start tracking/);
    assert.match(form.text, /Glow page/, 'the business\'s pages are offered');
  });

  test('a Pixel with no page is refused with a clear message; nothing is saved', async () => {
    const res = await connect({ name: 'Main', pixel_id: PIXEL_A });
    assert.equal(res.status, 400);
    assert.match(res.text, /Choose where this tracking ID runs/);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM tracking_pixels WHERE business_id = $1', [biz])).rows[0].n, 0);
  });

  test('saving the ID with its page starts browser tracking there at once, and it stays after a refresh', async () => {
    const res = await connect({ name: 'Main', pixel_id: PIXEL_A, pages: [String(page)] });
    assert.equal(res.status, 302, res.text.slice(0, 300));
    const list = await owner.get(`/businesses/${biz}/pixels?platform=meta`).expect(200);
    assert.match(list.text, new RegExp(`data-pixel="${PIXEL_A}" data-enabled="true"`));
    assert.deepEqual(await tracking(), [PIXEL_A]);
    const home = await owner.get(`/businesses/${biz}`).expect(200);
    assert.doesNotMatch(home.text, /data-pixel-step/, 'the step is done');
  });

  test('a second Pixel runs next to the first; neither replaces the other', async () => {
    assert.equal((await connect({ name: 'Second ad account', pixel_id: PIXEL_B, all_pages: 'on' })).status, 302);
    assert.deepEqual(await tracking(), [PIXEL_A, PIXEL_B]);
  });

  test('staff do not see the step or the section; another business cannot reach these Pixels', async () => {
    const staff = await signUp(app, { email: 'staff@glow.test' });
    await pool.query("INSERT INTO business_members (business_id, user_id, role) SELECT $1, id, 'staff' FROM users WHERE email = 'staff@glow.test'", [biz]);
    await pool.query('DELETE FROM tracking_pixels WHERE business_id = $1', [biz]);
    assert.doesNotMatch((await staff.get(`/businesses/${biz}`).expect(200)).text, /data-pixel-step/);
    await staff.get(`/businesses/${biz}/pixels`).expect(403);
    await other.get(`/businesses/${biz}/pixels`).expect(404);
    const _csrf = await csrfToken(other, `/businesses/${otherBiz}`);
    await other.post(`/businesses/${biz}/pixels/skip-setup`).type('form').send({ _csrf }).expect(404);
  });
});

describe('skipping the step', () => {
  test('"Skip for now" hides the step for that business only, is logged, and Tracking & Pixels still works', async () => {
    const _csrf = await csrfToken(other, `/businesses/${otherBiz}`);
    const res = await other.post(`/businesses/${otherBiz}/pixels/skip-setup`).type('form').send({ _csrf });
    assert.equal(res.status, 302);
    assert.equal(res.headers.location, `/businesses/${otherBiz}`);
    assert.doesNotMatch((await other.get(`/businesses/${otherBiz}`).expect(200)).text, /data-pixel-step/);
    assert.match((await owner.get(`/businesses/${biz}`).expect(200)).text, /data-pixel-step/, 'Glow Shop (no Pixel now, not skipped) still sees it');
    const { rows } = await pool.query("SELECT business_id FROM audit_log WHERE action = 'tracking.setup_skipped'");
    assert.deepEqual(rows.map((r) => Number(r.business_id)), [Number(otherBiz)]);
    assert.equal((await connect({ name: 'Later', pixel_id: PIXEL_A, all_pages: 'on' }, other, otherBiz)).status, 302);
  });
});
