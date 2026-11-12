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
const SECTIONS = ['', '/orders', '/customers', '/products', '/landing-pages', '/analytics', '/pixels', '/integrations', '/settings', '/team', '/subscription', '/email', '/email-contacts', '/checkouts', '/google-sheets', '/api-keys', '/payments', '/orders/export.csv', '/customers/export.csv'];
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
console.log(failed ? `\n${failed} check(s) FAILED` : '\nAll three-business isolation checks passed');
process.exit(failed ? 1 : 0);
