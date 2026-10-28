// One business must not monopolise the shared platform: each business's public traffic gets a fair
// share of the database (a business at its share is asked to "try again"; others are unaffected),
// orders have their own lane and a per-business limit, background work takes businesses in turn,
// public data is cached but any dashboard change shows at once, each business has a landing page
// limit (default 4, set by the platform admin), and Platform admin → Capacity shows the measurements.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import request from 'supertest';
import { setup, resetDatabase, csrfToken, signUp, openClientSignup, addTrackingPixel } from './helpers.js';
import { createLane, BusyError } from '../src/lib/fairness.js';
import { syncDue } from '../src/services/sheets.js';
import { singleRunner } from '../src/lib/singleRunner.js';
import { clearOriginCache } from '../src/lib/origins.js';

const SITE = (i) => `https://shop${i}.example`;
const { pool, app, load } = (() => {
  const s = setup({
    allowSignup: true, signupFirstOnly: false, publicCacheMs: 60000, orderBusinessLimit: 5,
    fairness: { readPerBusiness: 1, readTotal: 2, readQueue: 1, readWaitMs: 300, orderPerBusiness: 1, orderTotal: 2, orderQueue: 5, orderWaitMs: 2000 },
  });
  return { ...s, load: s.load };
})();
let admin; let owner; const biz = []; const pages = [];

async function business(i) {
  const { rows: [u] } = await pool.query("SELECT id FROM users WHERE email = 'owner@shops.test'");
  const { rows: [b] } = await pool.query("INSERT INTO businesses (owner_id, name, slug, currency) VALUES ($1, $2, $3, 'NGN') RETURNING id", [u.id, `Shop ${i}`, `shop-${i}`]);
  await pool.query("INSERT INTO business_members (business_id, user_id, role) VALUES ($1, $2, 'owner')", [b.id, u.id]);
  const { rows: [lp] } = await pool.query("INSERT INTO landing_pages (business_id, slug, name, url, status, order_destination) VALUES ($1, $2, $3, $4, 'active', 'checkout') RETURNING id", [b.id, `shop-${i}-page`, `Page ${i}`, `${SITE(i)}/`]);
  const { rows: [p] } = await pool.query("INSERT INTO products (business_id, code, name, price_minor) VALUES ($1, 'package-1', 'Package 1', 2650000) RETURNING id", [b.id]);
  await pool.query('INSERT INTO landing_page_products (landing_page_id, product_id) VALUES ($1, $2)', [lp.id, p.id]);
  return { id: b.id, page: lp.id, slug: `shop-${i}-page` };
}
const order = (i, n = 0) => request(app).post('/api/public/orders').set('Origin', SITE(i)).set('X-Forwarded-For', `10.0.${i}.${n}`)
  .send({ landingPage: `shop-${i}-page`, idempotencyKey: `fairness-test-${i}-${n}-${Date.now()}`, customer: { name: `Customer ${n}`, phone: '08051234567', address: '1 Test Street, Lagos' }, items: [{ product: 'package-1', quantity: 1 }] });

before(async () => {
  await resetDatabase(pool);
  admin = await signUp(app, { email: 'platform@skyfly.test' });
  await openClientSignup(pool);
  owner = await signUp(app, { email: 'owner@shops.test' });
  for (const i of [1, 2, 3]) biz.push(await business(i));
  pages.push(...biz.map((b) => b.slug));
  clearOriginCache();
});
after(() => { load?.stop(); return pool.end(); });

describe('fair lanes (unit)', () => {
  test('a business gets at most its share; others still run; waiting businesses take turns', async () => {
    const lane = createLane({ name: 't', perKey: 2, total: 3, maxQueue: 10, maxWaitMs: 2000 });
    const order = [];
    let releaseA;
    const hold = new Promise((r) => { releaseA = r; });
    const a = [1, 2, 3, 4].map((n) => lane.run('A', async () => { order.push(`A${n}`); await hold; }));
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(order, ['A1', 'A2'], 'A is held to 2 at a time');
    await lane.run('B', async () => { order.push('B1'); });
    assert.deepEqual(order, ['A1', 'A2', 'B1'], 'B runs at once although A has a queue');
    releaseA();
    await Promise.all(a);
    assert.deepEqual(order, ['A1', 'A2', 'B1', 'A3', 'A4']);
  });

  test('a full queue or a long wait answers "busy" instead of piling up', async () => {
    const lane = createLane({ name: 't', perKey: 1, total: 5, maxQueue: 1, maxWaitMs: 50 });
    let release;
    const running = lane.run('A', () => new Promise((r) => { release = r; }));
    const waiting = lane.run('A', async () => 'late');
    await assert.rejects(lane.run('A', async () => 'x'), (e) => e instanceof BusyError && e.reason === 'queue full');
    await assert.rejects(waiting, (e) => e instanceof BusyError && e.reason === 'waited too long');
    release();
    await running;
    assert.equal(await lane.run('A', async () => 'ok'), 'ok', 'the lane works normally afterwards');
  });
});

describe('one busy business does not slow down the others (public API)', () => {
  test('while shop 1 uses its whole share, its next visitor is asked to try again and shop 2 is served at once', async () => {
    let release;
    const busy = load.lanes.read.run(String(biz[0].id), () => new Promise((r) => { release = r; }));
    const t = Date.now();
    const other = await request(app).get(`/api/public/pages/${pages[1]}/tracking`);
    assert.equal(other.status, 200);
    assert.ok(Date.now() - t < 250, 'shop 2 did not wait for shop 1');
    const blocked = await request(app).get(`/api/public/pages/${pages[0]}/catalog`);
    assert.equal(blocked.status, 503);
    assert.equal(blocked.headers['retry-after'], '2');
    assert.equal(blocked.body.error, 'BUSY');
    release();
    await busy;
    assert.equal((await request(app).get(`/api/public/pages/${pages[0]}/catalog`)).status, 200, 'shop 1 is served again once its share is free');
  });

  test('browsing never blocks checkout: orders have their own lane', async () => {
    const releases = [];
    const held = [0, 1].map((k) => load.lanes.read.run(String(biz[k].id), () => new Promise((r) => releases.push(r))));
    const res = await order(1, 1);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    releases.forEach((r) => r());
    await Promise.all(held);
  });

  test('orders per business are limited (a flood on one page), other businesses keep ordering', async () => {
    for (let n = 2; n <= 5; n += 1) assert.equal((await order(1, n)).status, 201);
    const flooded = await order(1, 6);
    assert.equal(flooded.status, 429);
    assert.equal(flooded.body.error, 'RATE_LIMITED');
    assert.equal((await order(2, 1)).status, 201, 'shop 2 is not affected');
  });
});

describe('caching public data', () => {
  test('repeated visits read the cache; a change saved in the dashboard shows at once', async () => {
    await addTrackingPixel(pool, biz[2].id, { pixelId: '1111111111111111', name: 'One' });
    const ids = async () => (await request(app).get(`/api/public/pages/${pages[2]}/tracking`).expect(200)).body.pixels.map((p) => p.id);
    assert.deepEqual(await ids(), ['1111111111111111']);
    // Changed behind Skyfly's back: the cached answer is kept for its period.
    await pool.query("UPDATE tracking_pixels SET pixel_id = '2222222222222222' WHERE business_id = $1", [biz[2].id]);
    assert.deepEqual(await ids(), ['1111111111111111'], 'served from the cache');
    // Any change saved through the dashboard clears the cache.
    const _csrf = await csrfToken(owner, `/businesses/${biz[2].id}/pixels/new?platform=meta`);
    await owner.post(`/businesses/${biz[2].id}/pixels`).type('form')
      .send({ _csrf, platform: 'meta', name: 'Two', pixel_id: '3333333333333333', enabled: 'on', all_pages: 'on', events: ['PageView'] }).expect(302);
    assert.deepEqual(await ids(), ['2222222222222222', '3333333333333333']);
  });
});

describe('background work takes businesses in turn', () => {
  test('a business with a long backlog does not delay another business\'s sheet copy', async () => {
    await pool.query("UPDATE orders SET sheet_sync_status = 'skipped'");
    // Shop 3's 4 waiting orders are older than shop 2's; oldest-first would take only shop 3's.
    for (let n = 10; n < 14; n += 1) assert.equal((await order(3, n)).status, 201);
    const late = await order(2, 99);
    await pool.query("UPDATE orders SET sheet_sync_status = 'pending', sheet_sync_next_at = now() - interval '1 minute' WHERE business_id = ANY($1)", [[biz[1].id, biz[2].id]]);
    await pool.query("UPDATE orders SET sheet_sync_status = 'skipped' WHERE business_id = $1 AND reference <> $2", [biz[1].id, late.body.reference]);
    await syncDue(pool, { limit: 3 });
    const { rows: [b] } = await pool.query('SELECT sheet_sync_status FROM orders WHERE reference = $1', [late.body.reference]);
    assert.equal(b.sheet_sync_status, 'skipped', 'shop 2\'s newest order was handled in the first batch of 3');
  });
});

describe('several server instances', () => {
  test('a background job runs on one instance at a time; the other skips that turn', async () => {
    let release;
    const first = singleRunner(pool, 99001, () => new Promise((r) => { release = () => r('first'); }));
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(await singleRunner(pool, 99001, async () => 'second'), null, 'skipped while the first runs');
    release();
    assert.equal(await first, 'first');
    assert.equal(await singleRunner(pool, 99001, async () => 'again'), 'again', 'runs once the first has finished');
  });
});

describe('landing page limit', () => {
  test('a business has 4 landing pages by default; the 5th is refused with a clear message', async () => {
    const base = `/businesses/${biz[0].id}/landing-pages`;
    for (let n = 0; n < 3; n += 1) {
      const _csrf = await csrfToken(owner, base);
      await owner.post(`${base}/template`).type('form').send({ _csrf, name: `Extra ${n}` }).expect(302);
    }
    const list = await owner.get(base).expect(200);
    assert.match(list.text, /4 of 4 landing pages used \(limit reached/);
    const _csrf = await csrfToken(owner, base);
    const res = await owner.post(`${base}/template`).type('form').send({ _csrf, name: 'One too many' }).expect(302);
    assert.match(decodeURIComponent(res.headers.location), /up to 4 landing pages\. Archive a page/);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM landing_pages WHERE business_id = $1 AND status <> 'archived'", [biz[0].id])).rows[0].n, 4);
  });

  test('the platform admin raises it (never below the pages in use); the owner cannot', async () => {
    const page = `/admin/businesses/${biz[0].id}`;
    let _csrf = await csrfToken(admin, page);
    const low = await admin.post(`${page}/page-limit`).type('form').send({ _csrf, max_landing_pages: '2' });
    assert.equal(low.status, 400);
    assert.match(low.text, /already has 4 landing pages/);
    _csrf = await csrfToken(admin, page);
    const ok = await admin.post(`${page}/page-limit`).type('form').send({ _csrf, max_landing_pages: '5' }).expect(200);
    assert.match(ok.text, /Landing page limit set to 5/);
    const base = `/businesses/${biz[0].id}/landing-pages`;
    _csrf = await csrfToken(owner, base);
    await owner.post(`${base}/template`).type('form').send({ _csrf, name: 'Fifth' }).expect(302);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM landing_pages WHERE business_id = $1', [biz[0].id])).rows[0].n, 5);
    _csrf = await csrfToken(owner, base);
    await owner.post(`/admin/businesses/${biz[0].id}/page-limit`).type('form').send({ _csrf, max_landing_pages: '50' }).expect(404);
  });

  test('the migration keeps businesses that already have more than 4 pages working', async () => {
    const sql = readFileSync(new URL('../migrations/036_landing_page_limit.sql', import.meta.url), 'utf8');
    await pool.query('UPDATE businesses SET max_landing_pages = 4');
    await pool.query(sql);
    const { rows } = await pool.query('SELECT id, max_landing_pages FROM businesses WHERE id = ANY($1) ORDER BY id', [biz.map((b) => b.id)]);
    assert.deepEqual(rows.map((r) => r.max_landing_pages), [5, 4, 4]);
  });
});

describe('Platform admin → Capacity', () => {
  test('shows traffic per business, connections, queues and advice; only for the platform admin', async () => {
    const page = await admin.get('/admin/capacity').expect(200);
    assert.match(page.text, /Does the platform need more resources\?/);
    assert.match(page.text, /data-capacity-traffic/);
    assert.match(page.text, /Shop 1/);
    const json = (await admin.get('/admin/capacity.json').expect(200)).body;
    const shop1 = json.report.rows.filter((r) => r.name === 'Shop 1');
    assert.ok(shop1.some((r) => r.kind === 'order' && r.requests >= 3));
    assert.ok(shop1.some((r) => r.busy >= 1), 'the "try again" answer is counted');
    assert.equal(typeof json.db.max_connections, 'number');
    assert.ok(json.advice.length >= 1);
    await owner.get('/admin/capacity').expect(404);
  });
});
