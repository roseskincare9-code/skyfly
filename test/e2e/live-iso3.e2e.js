// Live three-business isolation check on production with SEPARATE, non-admin accounts (no shared
// administrator): a Staff member of Larose, a Staff member of the 3-in-1 business, and the Owner of a new
// labelled test business. Each signs in in its own session and must:
//   - land in its own business only, and see no other business's name in its business list;
//   - get "not found" for every section of the other two businesses (GET), and have every write
//     (POST) into them refused with nothing changed;
//   - get "not found" for the Super Admin area.
// Reads nothing it prints: only HTTP statuses and whether another business's name appears.
//   SKYFLY_URL=https://getskyfly.com SKYFLY_OWNER_PASSWORD=<this run's password> node test/e2e/live-iso3.e2e.js
import { E2E_LAROSE, E2E_3IN1, E2E_NEWBIZ, E2E_NEW_BUSINESS } from '../../src/services/setup.js';

const SKYFLY = (process.env.SKYFLY_URL || '').replace(/\/+$/, '');
const PASSWORD = process.env.SKYFLY_OWNER_PASSWORD;
if (!SKYFLY || !PASSWORD) { console.log('BLOCKED  needs SKYFLY_URL and this run\'s live-test password'); process.exit(2); }
let failed = 0;
const step = async (name, fn) => {
  try { const info = await fn(); console.log(`PASS  ${name}${info ? ` — ${info}` : ''}`); }
  catch (err) { failed += 1; console.log(`FAIL  ${name} — ${String(err.message).split('\n')[0].slice(0, 400)}`); }
};
const ok = (c, m) => { if (!c) throw new Error(m); };

class Session {
  constructor() { this.jar = new Map(); }
  cookie() { return [...this.jar].map(([k, v]) => `${k}=${v}`).join('; '); }
  keep(res) { for (const c of res.headers.getSetCookie?.() ?? []) { const [kv] = c.split(';'); const i = kv.indexOf('='); this.jar.set(kv.slice(0, i), kv.slice(i + 1)); } }
  async req(method, path, form = null) {
    const headers = { cookie: this.cookie() };
    let body;
    if (form) { headers['content-type'] = 'application/x-www-form-urlencoded'; body = new URLSearchParams(form).toString(); }
    const res = await fetch(`${SKYFLY}${path}`, { method, headers, body, redirect: 'manual', signal: AbortSignal.timeout(60000) });
    this.keep(res);
    return { status: res.status, location: res.headers.get('location') || '', text: await res.text() };
  }
  get(p) { return this.req('GET', p); }
  async csrf(path) { const r = await this.get(path); return r.text.match(/name="_csrf" value="([^"]+)"/)?.[1] ?? null; }
}

const NAMES = { larose: 'Larose Natural Skincare Nigeria', threeInOne: '3 in 1 Exfoliating package', newbiz: E2E_NEW_BUSINESS.name };
const people = [
  { key: 'larose', label: 'Larose staff', email: E2E_LAROSE },
  { key: 'threeInOne', label: '3-in-1 staff', email: E2E_3IN1 },
  { key: 'newbiz', label: 'new business owner', email: E2E_NEWBIZ },
];
const SECTIONS = ['', '/activity', '/orders', '/customers', '/products', '/landing-pages', '/analytics', '/pixels', '/integrations', '/settings', '/team', '/subscription', '/email', '/email-contacts', '/checkouts', '/google-sheets', '/api-keys', '/payments', '/orders/export.csv', '/customers/export.csv'];
const WRITES = [['/products', { name: 'Isolation probe', price: '1000', code: 'iso-probe' }], ['/settings', { name: 'Isolation probe' }], ['/team/invite', { email: 'e2e-iso-probe@skyfly.invalid', role: 'owner' }], ['/landing-pages/template', { name: 'Isolation probe' }], ['/pixels', { platform: 'meta', name: 'probe', pixel_id: '1234567890123456' }]];

await fetch(`${SKYFLY}/healthz`, { signal: AbortSignal.timeout(90000) }).catch(() => {});
for (const p of people) {
  p.s = new Session();
  await step(`${p.label} (${p.email}) signs in and lands in its own business`, async () => {
    const c = await p.s.csrf('/login');
    const r = await p.s.req('POST', '/login', { _csrf: c, email: p.email, password: PASSWORD });
    ok(r.status === 302, `sign-in HTTP ${r.status}`);
    const home = await p.s.get('/');
    const m = home.location.match(/\/businesses\/(\d+)/);
    ok(m, `"/" did not open a business (HTTP ${home.status} → ${home.location || 'no redirect'})`);
    p.business = Number(m[1]);
    const own = await p.s.get(`/businesses/${p.business}`);
    ok(own.status === 200 && own.text.includes(NAMES[p.key]), `own workspace HTTP ${own.status}`);
    return `business #${p.business} "${NAMES[p.key]}"`;
  });
}
if (people.some((p) => !p.business)) { console.log('\nSetup failed: not every account reached its business.'); process.exit(1); }
ok(new Set(people.map((p) => p.business)).size === 3, 'the three accounts are not in three different businesses');

// Permitted operations work inside one's own business, within the role: staff (Larose, 3-in-1) may work
// on orders and customers only; the owner of the new business may open every section.
const STAFF_OK = ['', '/orders', '/customers', '/checkouts', '/subscription'];
const STAFF_NO = ['/products', '/landing-pages', '/analytics', '/settings', '/team', '/payments', '/pixels', '/integrations', '/api-keys', '/email', '/google-sheets'];
for (const p of people) {
  const owner = p.key === 'newbiz';
  await step(`${p.label}: permitted sections of its own business #${p.business} open (${owner ? 'Owner: all' : 'Staff: orders and customers only'})`, async () => {
    const bad = [];
    for (const sct of owner ? [...STAFF_OK, ...STAFF_NO] : STAFF_OK) { const r = await p.s.get(`/businesses/${p.business}${sct}`); if (r.status !== 200) bad.push(`${sct || '/'}: HTTP ${r.status}`); }
    ok(!bad.length, bad.join('; '));
    return `${owner ? STAFF_OK.length + STAFF_NO.length : STAFF_OK.length} sections → 200`;
  });
  if (!owner) await step(`${p.label}: sections beyond the Staff role are refused in its own business`, async () => {
    const bad = [];
    for (const sct of STAFF_NO) { const r = await p.s.get(`/businesses/${p.business}${sct}`); if (r.status !== 403) bad.push(`${sct}: HTTP ${r.status}`); }
    const c = await p.s.csrf(`/businesses/${p.business}`);
    const w = await p.s.req('POST', `/businesses/${p.business}/team/invite`, { _csrf: c, email: 'e2e-iso-probe@skyfly.invalid', role: 'owner' });
    if (w.status !== 403) bad.push(`POST /team/invite: HTTP ${w.status}`);
    ok(!bad.length, bad.join('; '));
    return `${STAFF_NO.length} sections → 403; inviting an owner → 403`;
  });
}

for (const p of people) {
  const others = people.filter((o) => o !== p);
  await step(`${p.label}: its business list shows only its own business`, async () => {
    const r = await p.s.get('/?all=1');
    const seen = others.filter((o) => r.text.includes(NAMES[o.key])).map((o) => NAMES[o.key]);
    ok(!seen.length, `shows ${seen.join(', ')}`);
    return `HTTP ${r.status}, no other business named`;
  });
  for (const o of others) {
    await step(`${p.label} → ${o.label}'s business #${o.business}: every section refused (${SECTIONS.length} pages)`, async () => {
      const bad = [];
      for (const s of SECTIONS) {
        const r = await p.s.get(`/businesses/${o.business}${s}`);
        if (r.status !== 404 || r.text.includes(NAMES[o.key])) bad.push(`${s || '/'}: HTTP ${r.status}${r.text.includes(NAMES[o.key]) ? ' (name shown)' : ''}`);
      }
      ok(!bad.length, bad.join('; '));
      return 'all 404, name never shown';
    });
    await step(`${p.label} → ${o.label}'s business #${o.business}: writes refused (${WRITES.length} attempts)`, async () => {
      const c = await p.s.csrf(`/businesses/${p.business}`);
      const bad = [];
      for (const [path, form] of WRITES) {
        const r = await p.s.req('POST', `/businesses/${o.business}${path}`, { _csrf: c, ...form });
        if (![403, 404].includes(r.status)) bad.push(`${path}: HTTP ${r.status}`);
      }
      ok(!bad.length, bad.join('; '));
      return 'all refused (403/404)';
    });
  }
  // ScaleForge Business Hub (#21), owned by the Super Admin only: no test account may reach it.
  await step(`${p.label} → ScaleForge Business Hub #21: every section refused (${SECTIONS.length} pages) and writes refused`, async () => {
    const bad = [];
    for (const sct of SECTIONS) { const r = await p.s.get(`/businesses/21${sct}`); if (r.status !== 404 || r.text.includes('ScaleForge Business Hub')) bad.push(`${sct || '/'}: HTTP ${r.status}`); }
    const c = await p.s.csrf(`/businesses/${p.business}`);
    for (const [path, form] of WRITES) { const r = await p.s.req('POST', `/businesses/21${path}`, { _csrf: c, ...form }); if (![403, 404].includes(r.status)) bad.push(`POST ${path}: HTTP ${r.status}`); }
    ok(!bad.length, bad.join('; '));
    return 'all 404 / refused, name never shown';
  });
  await step(`${p.label}: Super Admin area refused`, async () => {
    const bad = [];
    for (const path of ['/admin', '/admin/businesses/new', '/admin/payments', '/admin/system', '/admin/infrastructure', '/admin/backup.json']) {
      const r = await p.s.get(path);
      if (r.status !== 404) bad.push(`${path}: HTTP ${r.status}`);
    }
    ok(!bad.length, bad.join('; '));
    return '/admin and its pages: 404';
  });
}
// Direct API: the new business's own API key cannot place an order on another business's page (the
// labelled test shop "skyfly-demo", business #3, so no real business is ever written to). The key is
// revoked at the end.
{
  const p = people.find((x) => x.key === 'newbiz');
  let key = null; let keyId = null;
  await step('Direct API: business #12\'s own API key cannot place an order on another business\'s page', async () => {
    const c = await p.s.csrf(`/businesses/${p.business}/api-keys`);
    const made = await p.s.req('POST', `/businesses/${p.business}/api-keys`, { _csrf: c, name: 'isolation probe (temporary)' });
    key = made.text.match(/sky_[A-Za-z0-9_-]{20,}/)?.[0];
    keyId = [...made.text.matchAll(/api-keys\/(\d+)\/revoke/g)].map((m) => Number(m[1])).sort((a, b) => b - a)[0];
    ok(made.status === 201 && key, `API key not created (HTTP ${made.status})`);
    const r = await fetch(`${SKYFLY}/api/public/orders`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(30000),
      body: JSON.stringify({ landingPage: 'skyfly-demo', idempotencyKey: `iso-api-probe-${Date.now()}`, customer: { name: 'TEST ORDER isolation probe', phone: '08000000000', address: 'Test only, do not deliver, Ikeja, Lagos' }, items: [{ product: 'serum', quantity: 1 }] }) });
    const body = await r.text();
    ok(r.status >= 400 && r.status < 500 && r.status !== 429, `HTTP ${r.status}: ${body.slice(0, 160)}`);
    return `HTTP ${r.status} ${body.match(/"error":"([A-Z_]+)"/)?.[1] ?? ''}: refused, no order created`;
  });
  if (keyId) await step('Direct API: the probe key is revoked and then refused (401)', async () => {
    const c = await p.s.csrf(`/businesses/${p.business}/api-keys`);
    await p.s.req('POST', `/businesses/${p.business}/api-keys/${keyId}/revoke`, { _csrf: c });
    const r = await fetch(`${SKYFLY}/api/public/orders`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: '{}' });
    ok(r.status === 401, `after revoking: HTTP ${r.status}`);
    return 'revoked key → 401';
  });
}
console.log(failed ? `\n${failed} check(s) FAILED` : '\nAll three-business isolation checks passed');
process.exit(failed ? 1 : 0);
