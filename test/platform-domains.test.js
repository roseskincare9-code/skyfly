// Skyfly's own domain (e.g. getskyfly.com): registry check (RDAP), verified vs entered-by-you facts,
// renewal detection, 30/14/7-day reminders sent once, the Platform admin page, and the Render
// address staying usable when the dashboard moves to the custom domain.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { setup, resetDatabase, csrfToken, signUp, makeConfig } from './helpers.js';
import { createApp } from '../src/app.js';
import { rdapLookup, domainSummary, refreshDomain, remindDomains, normalizeRegistrarUrl } from '../src/services/platformDomains.js';

const { pool, app } = setup();
const realFetch = globalThis.fetch;
let registry = {}; // domain -> RDAP JSON (missing = 404)
const emails = [];
const DAY = 864e5;
const rdapJson = (expires) => ({
  objectClassName: 'domain', ldhName: 'GETSKYFLY.COM', status: ['client transfer prohibited'],
  events: [{ eventAction: 'registration', eventDate: '2026-10-30T10:00:00Z' }, { eventAction: 'expiration', eventDate: expires }],
  entities: [{ roles: ['registrar'], vcardArray: ['vcard', [['version', {}, 'text', '4.0'], ['fn', {}, 'text', 'Example Registrar, Inc.']]] }],
});
const fakeFetch = async (url, opts = {}) => {
  const u = String(url);
  const m = u.match(/^https:\/\/rdap\.verisign\.com\/com\/v1\/domain\/(.+)$/);
  if (m) return registry[m[1]] ? new Response(JSON.stringify(registry[m[1]]), { status: 200 }) : new Response('{}', { status: 404 });
  if (u.startsWith('https://api.resend.com/')) { emails.push(JSON.parse(opts.body)); return new Response('{"id":"x"}', { status: 200 }); }
  throw new Error(`unexpected fetch ${u}`);
};
const inDays = (n) => new Date(Date.now() + n * DAY + 3600e3).toISOString();
let admin;

before(async () => {
  globalThis.fetch = fakeFetch;
  await resetDatabase(pool);
  admin = await signUp(app, { email: 'owner@skyfly.test' });
});
after(async () => { globalThis.fetch = realFetch; await pool.end(); });

describe('registry check', () => {
  test('reads registrar, expiry and status; a domain the registry does not know is "not registered"', async () => {
    registry['getskyfly.com'] = rdapJson('2027-10-30T10:00:00Z');
    const r = await rdapLookup('getskyfly.com');
    assert.deepEqual([r.registered, r.registrar, r.expiresAt, r.statuses], [true, 'Example Registrar, Inc.', '2027-10-30T10:00:00Z', ['client transfer prohibited']]);
    assert.deepEqual(await rdapLookup('not-bought-yet.com'), { registered: false, statuses: [] });
  });

  test('registrar links must be https and carry no sign-in details', () => {
    assert.equal(normalizeRegistrarUrl('https://dash.example.com/domains/getskyfly.com').value, 'https://dash.example.com/domains/getskyfly.com');
    assert.ok(normalizeRegistrarUrl('http://example.com').error);
    assert.ok(normalizeRegistrarUrl('https://user:pass@example.com').error);
    assert.ok(normalizeRegistrarUrl('javascript:alert(1)').error);
  });

  test('a later registry expiry date counts as a verified renewal; auto-renew stays "entered by you"', async () => {
    registry['renew.com'] = rdapJson(inDays(20));
    const { rows: [d] } = await pool.query("INSERT INTO platform_domains (domain, manual_auto_renew, manual_auto_renew_confirmed_on) VALUES ('renew.com', true, '2026-10-29') RETURNING id");
    await refreshDomain(pool, d.id);
    let row = (await pool.query('SELECT * FROM platform_domains WHERE id = $1', [d.id])).rows[0];
    let s = domainSummary(row);
    assert.equal(s.source, 'verified');
    assert.equal(s.level, 'watch');
    assert.ok(s.facts.some((f) => f.kind === 'manual' && /Auto-renew is on/.test(f.text)), 'auto-renew is labelled as entered by you');
    assert.ok(!s.facts.some((f) => /Renewal confirmed/.test(f.text)));

    registry['renew.com'] = rdapJson(inDays(385));
    assert.equal((await refreshDomain(pool, d.id)).renewed, true);
    row = (await pool.query('SELECT * FROM platform_domains WHERE id = $1', [d.id])).rows[0];
    s = domainSummary(row);
    assert.equal(s.level, 'ok');
    assert.ok(s.facts.some((f) => f.kind === 'verified' && /Renewal confirmed/.test(f.text)));
  });

  test('without a registry answer the typed-in date is used and labelled as such', () => {
    const s = domainSummary({ registered: null, manual_expires_on: new Date(Date.now() + 5 * DAY).toISOString().slice(0, 10), registry_statuses: [], rdap_checked_at: new Date(), rdap_error: 'the registry answered HTTP 503' });
    assert.equal(s.source, 'manual');
    assert.equal(s.level, 'act');
    assert.ok(s.facts.some((f) => f.kind === 'error'));
  });
});

describe('reminders', () => {
  before(() => pool.query('DELETE FROM platform_domains'));

  test('30, 14 and 7 days before expiry, each once; recorded as not emailed while no sender is set up', async () => {
    registry['remind.com'] = rdapJson(inDays(25));
    const { rows: [d] } = await pool.query("INSERT INTO platform_domains (domain) VALUES ('remind.com') RETURNING id");
    await refreshDomain(pool, d.id);
    const noSender = makeConfig();
    let r = await remindDomains(pool, noSender);
    assert.deepEqual(r.map((x) => [x.daysBefore, x.status]), [[30, 'not_sent']]);
    assert.match(r[0].detail, /No Skyfly email sender/);
    assert.equal((await remindDomains(pool, noSender)).length, 0, 'never twice for the same reminder');

    const withSender = makeConfig({ notifyEmail: { provider: 'resend', apiKey: 'test-key', fromEmail: 'alerts@skyfly.test', fromName: 'Skyfly' } });
    r = await remindDomains(pool, withSender, { now: new Date(Date.now() + 12 * DAY) });
    assert.deepEqual(r.map((x) => [x.daysBefore, x.status]), [[14, 'sent']]);
    assert.equal(emails.length, 1);
    assert.deepEqual(emails[0].to, ['owner@skyfly.test']);
    assert.match(emails[0].subject, /remind\.com expires in 13 days/);
    assert.match(emails[0].text, /read from the domain registry/);

    r = await remindDomains(pool, withSender, { now: new Date(Date.now() + 19 * DAY) });
    assert.deepEqual(r.map((x) => x.daysBefore), [7]);
    assert.equal((await remindDomains(pool, withSender, { now: new Date(Date.now() + 20 * DAY) })).length, 0);
  });

  test('a domain that is not registered gets no expiry reminders', async () => {
    const { rows: [d] } = await pool.query("INSERT INTO platform_domains (domain) VALUES ('not-bought-yet.com') RETURNING id");
    await refreshDomain(pool, d.id);
    assert.equal((await remindDomains(pool, makeConfig())).filter((x) => x.domain === 'not-bought-yet.com').length, 0);
  });
});

describe('Platform admin → Domains', () => {
  before(() => pool.query('DELETE FROM platform_domains'));

  test('adding a domain checks the registry; details entered by the owner are labelled; the registrar button opens the registrar', async () => {
    registry['getskyfly.com'] = rdapJson(inDays(20));
    let _csrf = await csrfToken(admin, '/admin/domains');
    await admin.post('/admin/domains').type('form').send({ _csrf, domain: 'https://GetSkyfly.com/' }).expect(302);
    const { rows: [d] } = await pool.query("SELECT id, registered FROM platform_domains WHERE domain = 'getskyfly.com'");
    assert.equal(d.registered, true);

    _csrf = await csrfToken(admin, '/admin/domains');
    const bad = await admin.post(`/admin/domains/${d.id}`).type('form').send({ _csrf, registrar_url: 'http://registrar.example' });
    assert.equal(bad.status, 400);
    _csrf = await csrfToken(admin, '/admin/domains');
    await admin.post(`/admin/domains/${d.id}`).type('form').send({ _csrf, registrar_name: 'Example Registrar', registrar_url: 'https://registrar.example/domains/getskyfly.com', manual_auto_renew: 'on', manual_auto_renew_confirmed_on: '2026-10-29' }).expect(302);

    const page = await admin.get('/admin/domains').expect(200);
    assert.match(page.text, /data-domain-level="watch"/);
    assert.match(page.text, /href="https:\/\/registrar\.example\/domains\/getskyfly\.com" target="_blank" rel="noopener noreferrer">Open registrar/);
    assert.match(page.text, /data-fact="verified"[^]*Registered with Example Registrar, Inc\./);
    assert.match(page.text, /data-fact="manual"[^]*Auto-renew is on at the registrar \(you last checked on 2026-10-29\)/);
    assert.match(page.text, /Reminder emails<\/dt><dd>Not possible yet/);

    const home = await admin.get('/admin').expect(200);
    assert.match(home.text, /data-domain-alert[^>]*><strong>getskyfly\.com:<\/strong> Expires in 20 days \([\d-]+, verified from the registry\)/);
  });

  test('only platform admins can open or change it', async () => {
    const other = await signUp(app, { email: 'client@shop.test' });
    const res = await other.get('/admin/domains');
    assert.notEqual(res.status, 200);
  });
});

describe('moving the dashboard to the custom domain', () => {
  const moved = createApp({ pool, config: makeConfig({ publicBaseUrl: 'https://getskyfly.com', dashboardAliases: ['skyfly-gybf.onrender.com'], renderHost: 'skyfly-gybf.onrender.com' }) });

  test('the new domain and the old Render address both serve the dashboard', async () => {
    for (const host of ['getskyfly.com', 'skyfly-gybf.onrender.com']) {
      const res = await request(moved).get('/login').set('Host', host);
      assert.equal(res.status, 200, host);
      assert.match(res.text, /name="_csrf"/, host);
    }
  });

  test('www goes to the main address', async () => {
    const res = await request(moved).get('/login?x=1').set('Host', 'www.getskyfly.com').expect(301);
    assert.equal(res.headers.location, 'https://getskyfly.com/login?x=1');
  });

  test("a business cannot claim Skyfly's own domain for its landing page", async () => {
    const owner = request.agent(moved);
    const host = (r) => r.set('Host', 'getskyfly.com');
    // Sign in as the platform owner on the new domain and try every form of the platform's domain.
    let _csrf = (await host(owner.get('/login'))).text.match(/name="_csrf" value="([^"]+)"/)[1];
    await host(owner.post('/login')).type('form').send({ _csrf, email: 'owner@skyfly.test', password: 'correct-horse-battery' }).expect(302);
    _csrf = (await host(owner.get('/'))).text.match(/name="_csrf" value="([^"]+)"/)[1];
    await host(owner.post('/businesses')).type('form').send({ _csrf, name: 'Domain Shop' }).expect(302);
    const { rows: [b] } = await pool.query("SELECT id FROM businesses WHERE name = 'Domain Shop'");
    const { rows: [lp] } = await pool.query("INSERT INTO landing_pages (business_id, name, slug, status) VALUES ($1, 'P', 'domain-shop-p', 'draft') RETURNING id", [b.id]);
    for (const domain of ['getskyfly.com', 'www.getskyfly.com', 'shop.getskyfly.com']) {
      _csrf = (await host(owner.get(`/businesses/${b.id}/landing-pages/${lp.id}`))).text.match(/name="_csrf" value="([^"]+)"/)[1];
      const res = await host(owner.post(`/businesses/${b.id}/landing-pages/${lp.id}/domain`)).type('form').send({ _csrf, domain });
      assert.equal(res.status, 400, domain);
    }
    _csrf = (await host(owner.get(`/businesses/${b.id}/landing-pages/${lp.id}`))).text.match(/name="_csrf" value="([^"]+)"/)[1];
    await host(owner.post(`/businesses/${b.id}/landing-pages/${lp.id}/domain`)).type('form').send({ _csrf, domain: 'shop.domainshop.com' }).expect(302);
  });
});
