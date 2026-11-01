// Live business-isolation audit against the deployed service. Creates its own two test businesses
// through public registration (Business A and Business B, "(test)", @skyfly.invalid addresses) and a
// staff member of A (by A's invitation), gives A one of each record type through the dashboard, then:
//   1. signed out: every workspace route of A (GET and POST) — sign-in required, nothing of A shown;
//   2. B inside A's workspace: every route (GET and POST) — 404, nothing of A shown;
//   3. B in its own workspace with A's record IDs in the URL: every ID route (GET and POST);
//   4. tampered requests: business_id in forms, B's API key on A's page, role / admin fields;
//   5. search, exports, analytics and activity as B; 6. the Super Admin area as A, B and A's staff;
//   7. A's staff member outside their role and in B; 8. files: drafts, previews, order links;
//   9. A's records unchanged and still visible to A.
// Route lists are read from the route files, so new routes are swept automatically. Uses only made-up
// test data; creates one test order (marked test) in A. Prints no secrets.
//
//   SKYFLY_URL=https://getskyfly.com node test/e2e/live-isolation.e2e.js
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

const SKYFLY = (process.env.SKYFLY_URL || '').replace(/\/+$/, '');
if (!/^https:\/\/[a-z0-9-]+\.onrender\.com$|^https:\/\/getskyfly\.com$|^http:\/\/localhost:\d+$/.test(SKYFLY)) throw new Error('Set SKYFLY_URL');
const RUN = String(process.env.GITHUB_RUN_ID || Date.now()).slice(-8);
const PASSWORD = `Iso-${randomBytes(9).toString('base64url')}`;
const TAG = { A: `Alpha${RUN}`, B: `Beta${RUN}` };

let failed = 0; let passed = 0;
const stats = { requests: 0, crossTenant: 0, blocked: 0, leaks: 0, unauth: 0 };
async function step(name, fn) {
  try { const info = await fn(); passed += 1; console.log(`PASS  ${name}${info ? ` — ${info}` : ''}`); }
  catch (err) { failed += 1; console.log(`FAIL  ${name} — ${String(err.message).split('\n')[0].slice(0, 600)}`); }
}
const assert = (c, m) => { if (!c) throw new Error(m); };

// A browser-like session: cookies, CSRF token, no automatic redirects.
class Session {
  constructor() { this.cookies = new Map(); }
  async req(method, path, { form = null, body = null, headers = {} } = {}) {
    const h = { ...headers, cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ') };
    let payload;
    if (form) { h['content-type'] = 'application/x-www-form-urlencoded'; payload = new URLSearchParams(Object.entries(form).flatMap(([k, v]) => (Array.isArray(v) ? v.map((x) => [k, x]) : [[k, String(v)]]))).toString(); }
    if (body) payload = body;
    stats.requests += 1;
    for (let attempt = 0; ; attempt += 1) {
      try {
        const res = await fetch(SKYFLY + path, { method, headers: h, body: payload, redirect: 'manual' });
        for (const c of res.headers.getSetCookie?.() ?? []) { const [kv] = c.split(';'); const i = kv.indexOf('='); this.cookies.set(kv.slice(0, i), kv.slice(i + 1)); }
        const text = await res.text();
        if (res.status === 429 && attempt < 3) { await new Promise((r) => setTimeout(r, 20000)); continue; }
        return { status: res.status, location: res.headers.get('location') || '', text, type: res.headers.get('content-type') || '' };
      } catch (err) { if (attempt >= 2) throw err; await new Promise((r) => setTimeout(r, 3000)); }
    }
  }
  get(path) { return this.req('GET', path); }
  async csrf(path = '/login') {
    const r = await this.get(path);
    const m = r.text.match(/name="_csrf" value="([^"]+)"/);
    if (m) this.token = m[1];
    if (!this.token) throw new Error(`no CSRF token on ${path} (HTTP ${r.status})`);
    return this.token;
  }
  async post(path, form = {}, csrfFrom = null) {
    if (csrfFrom || !this.token) await this.csrf(csrfFrom || '/login');
    return this.req('POST', path, { form: { _csrf: this.token, ...form } });
  }
}

// ---- routes, read from the route files (as in test/isolation-sweep.test.js)
const routesDir = new URL('../../src/routes/', import.meta.url);
function routesOf(file, { from = 0, to = Infinity } = {}) {
  const src = readFileSync(new URL(file, routesDir), 'utf8').slice(from, to);
  const out = [];
  for (const m of src.matchAll(/router\.(get|post)\((\[[^\]]*\]|'[^']*')/g)) for (const p of m[2].match(/'[^']*'/g)) out.push([m[1], p.slice(1, -1)]);
  return out;
}
function workspaceRoutes() {
  const emailSrc = readFileSync(new URL('email.js', routesDir), 'utf8');
  const split = emailSrc.indexOf('export function emailContactRoutes');
  const groups = [['orders.js', '/orders'], ['checkouts.js', '/checkouts'], ['googleSheets.js', '/google-sheets'], ['products.js', '/products'],
    ['insights.js', ''], ['pageEditor.js', '/landing-pages'], ['landingPages.js', '/landing-pages'], ['settings.js', '/settings'],
    ['apiKeys.js', '/api-keys'], ['pixels.js', '/pixels'], ['team.js', '/team']];
  const list = groups.flatMap(([f, prefix]) => routesOf(f).map(([m, p]) => [m, prefix + (p === '/' ? '' : p), prefix]));
  list.push(...routesOf('email.js', { to: split }).map(([m, p]) => [m, `/email${p === '/' ? '' : p}`, '/email']));
  list.push(...routesOf('email.js', { from: split }).map(([m, p]) => [m, `/email-contacts${p === '/' ? '' : p}`, '/email-contacts']));
  list.push(['get', '', ''], ['get', '/activity', ''], ['get', '/subscription', ''], ['get', '/integrations', ''], ['get', '/sheet-backup', '']);
  return list;
}
const adminRoutes = () => routesOf('admin.js').filter(([, p]) => p.startsWith('/admin') && p !== '/admin/login' && p !== '/admin/logout');
const PLACEHOLDER = 2147480000; // an ID no record has (for record types this run cannot create)
const fill = (path, prefix, ids) => path.replace(/:(\w+)(\([^)]*\))?/g, (_, name, choice) => {
  if (choice) return choice.slice(1, -1).split('|')[0];
  const byId = { '/checkouts': ids.checkout, '/google-sheets': ids.sheet, '/pixels': ids.pixel };
  return String((name === 'id' ? byId[prefix] : ids[name]) ?? PLACEHOLDER);
});

const A = { s: new Session() }; const B = { s: new Session() }; const staff = { s: new Session() }; const anon = new Session();
const markers = () => [TAG.A, `${TAG.A.toLowerCase()}`, `+23480${RUN.slice(-8)}`].filter(Boolean);
const leaks = (text) => markers().filter((m) => String(text ?? '').toLowerCase().includes(m.toLowerCase()));

async function register(who, tag) {
  const s = who.s;
  await s.csrf('/signup');
  const email = `e2e-iso-${tag.toLowerCase()}@skyfly.invalid`;
  // Also tries to become Super Admin through extra form fields (must be ignored).
  const r = await s.post('/signup', { name: `${tag} Owner`, business_name: `Isolation ${tag} (test)`, email, phone: tag === TAG.A ? `+23480${RUN.slice(-8)}` : '+234 800 000 0002',
    password: PASSWORD, confirm: PASSWORD, accept_terms: 'on', is_platform_admin: 'true', role: 'admin', isAdmin: '1' });
  assert(r.status === 302 && /^\/businesses\/\d+$|\/verify-email$/.test(r.location), `registration: HTTP ${r.status} → ${r.location} ${r.text.match(/role="alert">([^<]+)/)?.[1] ?? ''}`);
  assert(!r.location.endsWith('/verify-email'), 'email confirmation required: this run cannot open the emailed link');
  who.business = Number(r.location.match(/(\d+)$/)[1]);
  who.base = `/businesses/${who.business}`;
  who.email = email;
  s.token = null; await s.csrf(who.base);
}
const idFrom = (r, re) => { const m = (r.location + r.text).match(re); return m ? Number(m[1]) : undefined; };

// One of each record type for a business, through the dashboard.
async function seed(who, tag) {
  const { s, base } = who; const made = [];
  const ok = (name, id) => { if (id) made.push(name); return id; };
  let r = await s.post(`${base}/settings`, { name: `Isolation ${tag} (test)`, whatsapp_number: tag === TAG.A ? `+23480${RUN.slice(-8)}` : '+234 800 000 0002', order_prefix: tag.slice(0, 2).toUpperCase(), currency: 'NGN' });
  if (r.status === 302) made.push('settings+WhatsApp');
  r = await s.post(`${base}/products`, { code: `${tag.toLowerCase()}-cream`, name: `${tag} Cream`, price: '5,000', description: `${tag} secret description` });
  r = await s.get(`${base}/products`);
  who.productId = ok('product', idFrom(r, new RegExp(`products/(\\d+)"[^>]*>(?:(?!</form>)[\\s\\S])*${tag.toLowerCase()}-cream`)) ?? idFrom(r, /action="[^"]*\/products\/(\d+)"/));
  r = await s.post(`${base}/landing-pages`, { name: `${tag} Page`, slug: `${tag.toLowerCase()}-page`, status: 'draft', products: who.productId ?? '', order_destination: 'skyfly' });
  const pageInList = async () => { const t = (await s.get(`${base}/landing-pages`)).text; const k = t.indexOf(`>${tag} Page `); return k < 0 ? undefined : Number((t.slice(k).match(/orders\?page=(\d+)"|landing-pages\/(\d+)"/) || []).slice(1).find(Boolean)) || undefined; };
  who.pageId = ok('landing page', idFrom(r, /landing-pages\/(\d+)/) ?? await pageInList());
  if (!who.pageId) who.pageError = `landing page: HTTP ${r.status} ${r.location} ${(r.text.match(/role="alert">([^<]+)/) || [])[1] ?? ''}`;
  // An active page (takes orders), for the API test: B's key must be refused on it.
  r = await s.post(`${base}/landing-pages`, { name: `${tag} Live`, slug: `${tag.toLowerCase()}-live`, status: 'active', products: who.productId ?? '', order_destination: 'skyfly' });
  who.livePageId = ok('active landing page', idFrom(r, /landing-pages\/(\d+)/) ?? (r.status === 302 ? -1 : undefined));
  // An uploaded page (files + version): HTML with a marker, as a draft.
  const fd = new FormData();
  fd.set('_csrf', s.token); fd.set('name', `${tag} Upload`);
  fd.set('file', new Blob([`<!doctype html><html><head><title>${tag} upload</title></head><body><h1>${tag} private draft</h1><form><input name="name"><button>Order</button></form></body></html>`], { type: 'text/html' }), `${tag.toLowerCase()}-upload.html`);
  r = await s.req('POST', `${base}/landing-pages/upload`, { body: fd });
  who.uploadPageId = idFrom(r, /landing-pages\/(\d+)/);
  if (who.uploadPageId) {
    const detail = await s.get(`${base}/landing-pages/${who.uploadPageId}`);
    who.versionId = ok('page version (uploaded files)', idFrom(detail, /versions\/(\d+)\/edit/) ?? idFrom(detail, /_(?:sandbox|preview)\/(\d+)\//));
    who.previewPath = (detail.text.match(/(\/_(?:sandbox|preview)\/\d+\/[A-Za-z0-9._-]+\/)/) || [])[1];
    who.uploadSlug = (detail.text.match(/\/p\/([a-z0-9-]+)\//) || [])[1] ?? `${tag.toLowerCase()}-upload`;
  }
  r = await s.post(`${base}/pixels`, { platform: 'meta', name: `${tag} Pixel`, pixel_id: `97${RUN.slice(-8)}${tag === TAG.A ? '01' : '02'}`.slice(0, 16), enabled: 'on', all_pages: 'on', events: ['PageView', 'Purchase'] });
  who.pixel = ok('Meta pixel', idFrom(r, /pixels\/(\d+)/) ?? idFrom(await s.get(`${base}/pixels`), /pixels\/(\d+)\/edit/));
  r = await s.post(`${base}/pixels`, { platform: 'tiktok', name: `${tag} TikTok`, pixel_id: `C${RUN}${tag === TAG.A ? 'AAAA' : 'BBBB'}ISO`.toUpperCase().slice(0, 20), enabled: 'on', all_pages: 'on', events: ['PageView'] });
  if (r.status === 302) made.push('TikTok pixel');
  r = await s.post(`${base}/email/templates`, { name: `${tag} Template`, subject: `${tag} subject`, body: 'Hello' });
  who.templateId = ok('email template', idFrom(r, /templates\/(\d+)/));
  r = await s.post(`${base}/email/automations`, { preset: 'post_purchase' });
  who.automationId = ok('email automation', idFrom(r, /automations\/(\d+)/));
  r = await s.post(`${base}/email-contacts`, { name: `${tag} Contact`, email: `${tag.toLowerCase()}-contact@skyfly.invalid`, marketing_consent: 'on', consent_source: 'test' });
  who.contactId = ok('customer contact', idFrom(await s.get(`${base}/email-contacts`), /email-contacts\/(\d+)"/));
  r = await s.post(`${base}/api-keys`, { name: `${tag} Key` });
  who.apiKey = (r.text.match(/\b(sky_[A-Za-z0-9_-]{20,})/) || [])[1];
  who.keyId = ok('API key', idFrom(r, /api-keys\/(\d+)\/revoke/));
  r = await s.post(`${base}/orders/new`, { name: `${tag} Testcustomer`, phone: tag === TAG.A ? `+23480${RUN.slice(-8)}` : '+234 800 000 0002', address: `1 ${tag} Test Street`, state: 'Lagos',
    product_0: who.productId ?? '', quantity_0: 1, price_0: '5,000', status: 'pending', payment_status: 'unpaid' });
  who.orderId = ok('order (marked test)', idFrom(r, /orders\/(\d+)/));
  if (who.orderId) {
    await s.post(`${base}/orders/${who.orderId}/test`, { is_test: '1' });
    const o = await s.get(`${base}/orders/${who.orderId}`);
    who.orderRef = (o.text.match(/\b([A-Z]{2,4}-[A-Z0-9]{6,8})\b/) || [])[1];
  }
  return made;
}

const BODY = (ids) => ({ status: 'cancelled', payment_status: 'paid', name: 'HACKED', role: 'owner', email: 'hacker@skyfly.invalid', price: '1', subject: 'x', body: 'x',
  enabled: 'on', delay_days: '1', template_id: String(ids.templateId ?? ''), version_id: String(ids.versionId ?? ''), product_ids: String(ids.productId ?? ''),
  products: String(ids.productId ?? ''), page_id: String(ids.pageId ?? ''), connection_id: String(ids.sheet ?? ''), business_id: String(ids.business), domain: 'hack.example.com', is_test: '0' });

async function aView() {
  // What A sees of its own records (to compare before/after).
  const parts = [];
  for (const p of ['/products', '/landing-pages', '/pixels', '/email', '/email-contacts', '/api-keys', '/team', '/settings', A.orderId ? `/orders/${A.orderId}` : '/orders']) {
    const r = await A.s.get(A.base + p);
    parts.push(`${p}:${r.status}:${(r.text.replace(/name="_csrf" value="[^"]+"|nonce="[^"]+"|\d{4}-\d\d-\d\dT[\d:.]+Z?|\b\d+ (?:seconds?|minutes?|hours?) ago\b/g, '').match(new RegExp(TAG.A, 'gi')) || []).length}`);
  }
  return parts.join(' ');
}

try {
  await step('Setup: Business A and Business B register through the public /signup (extra "admin" fields sent)', async () => {
    await register(A, TAG.A); await register(B, TAG.B);
    assert(A.business !== B.business, 'same business');
    return `A = business #${A.business}, B = business #${B.business}`;
  });
  if (!A.business || !B.business) throw new Error('setup failed');

  await step('Setup: one of each record type in each business, through the dashboard', async () => {
    const a = await seed(A, TAG.A); const b = await seed(B, TAG.B);
    assert(A.productId && A.pageId && A.orderId && A.pixel, `A is missing core records (made: ${a.join(', ')}; ${A.pageError ?? ''})`);
    return `A: ${a.join(', ')} | B: ${b.length} record types`;
  });

  await step("Setup: A invites a staff member, who joins A as Staff", async () => {
    const r = await A.s.post(`${A.base}/team/invite`, { email: `e2e-iso-staff-${RUN}@skyfly.invalid`, role: 'staff' });
    const link = (r.text.match(/\/invite\/([A-Za-z0-9_-]+)/) || [])[1];
    assert(link, `no invitation link (HTTP ${r.status})`);
    A.inviteId = idFrom(await A.s.get(`${A.base}/team`), /invites\/(\d+)\/revoke/);
    await staff.s.csrf(`/invite/${link}`);
    const j = await staff.s.post(`/invite/${link}`, { name: `${TAG.A} Staff`, password: PASSWORD });
    assert(j.status === 302, `joining: HTTP ${j.status}`);
    const team = await A.s.get(`${A.base}/team`);
    A.userId = idFrom(team, /members\/(\d+)\/role/);
    staff.s.token = null; await staff.s.csrf(`${A.base}/orders`);
    return `staff user #${A.userId ?? '?'} in business #${A.business}`;
  });

  const routes = workspaceRoutes();
  const beforeA = await aView();

  await step(`Signed out: all ${routes.length} workspace routes of A (GET and POST) require sign-in and show nothing of A`, async () => {
    const bad = [];
    for (const [m, p, prefix] of routes) {
      const url = A.base + fill(p, prefix, A);
      const r = m === 'get' ? await anon.get(url) : await anon.req('POST', url, { form: BODY(A) });
      stats.unauth += 1;
      const okStatus = m === 'get' ? r.status === 302 && /\/login/.test(r.location) : [302, 403, 404].includes(r.status) && (r.status !== 302 || /\/login/.test(r.location));
      if (okStatus) stats.blocked += 1;
      if (!okStatus || leaks(r.text).length) bad.push(`${m.toUpperCase()} ${url} → ${r.status} ${r.location}`);
    }
    assert(!bad.length, bad.slice(0, 5).join('; '));
    return `${routes.length} requests: GET → /login, POST → refused`;
  });

  await step(`B inside A's workspace: all ${routes.length} routes (GET and POST, A's real record IDs) → 404, nothing of A shown`, async () => {
    const bad = [];
    for (const [m, p, prefix] of routes) {
      const url = A.base + fill(p, prefix, A);
      const r = m === 'get' ? await B.s.get(url) : await B.s.req('POST', url, { form: { _csrf: B.s.token, ...BODY(A) } });
      stats.crossTenant += 1;
      if (r.status === 404) stats.blocked += 1;
      const l = leaks(r.text);
      if (l.length) stats.leaks += 1;
      if (r.status !== 404 || l.length) bad.push(`${m.toUpperCase()} ${url} → ${r.status}${l.length ? ' LEAK' : ''}`);
    }
    assert(!bad.length, bad.slice(0, 5).join('; '));
    return `${routes.length} requests, all 404`;
  });

  await step("B in its own workspace with A's record IDs in the URL (every ID route, GET and POST): nothing of A shown or changed", async () => {
    const bad = []; let n = 0;
    for (const [m, p, prefix] of routes.filter(([, x]) => x.includes(':'))) {
      const url = B.base + fill(p, prefix, A);
      const r = m === 'get' ? await B.s.get(url) : await B.s.req('POST', url, { form: { _csrf: B.s.token, ...BODY(A) } });
      n += 1; stats.crossTenant += 1;
      const blockedOk = [302, 400, 403, 404, 409].includes(r.status) && !(m === 'post' && r.status === 302 && !/error|not.found/i.test(r.location) && r.location.includes(String(A.business)));
      const l = leaks(r.text);
      if (l.length) stats.leaks += 1;
      if (m === 'get' && r.status === 200) bad.push(`GET ${url} → 200`);
      else if (r.status >= 500) bad.push(`${m.toUpperCase()} ${url} → ${r.status}`);
      else if (l.length) bad.push(`${m.toUpperCase()} ${url} → ${r.status} LEAK ${l.join(',')}`);
      else if (blockedOk) stats.blocked += 1;
    }
    assert(!bad.length, bad.slice(0, 5).join('; '));
    return `${n} ID-based requests with A's IDs: none answered with A's data`;
  });

  await step("Tampered forms: B creates a landing page with business_id = A; B's product IDs → A's page", async () => {
    const before = (await A.s.get(`${A.base}/landing-pages`)).text.match(/Hijack/g)?.length ?? 0;
    const r = await B.s.post(`${B.base}/landing-pages`, { name: `Hijack ${RUN}`, slug: `hijack-${RUN}`, status: 'draft', business_id: String(A.business), products: String(A.productId) });
    const after = (await A.s.get(`${A.base}/landing-pages`)).text.match(/Hijack/g)?.length ?? 0;
    assert(after === before, 'a page appeared in A');
    stats.crossTenant += 1; stats.blocked += 1;
    return `HTTP ${r.status}; A's landing pages unchanged`;
  });

  await step("API: B's API key cannot place an order on A's page, and an unknown key is refused", async () => {
    stats.crossTenant += 1;
    assert(B.apiKey, "B's API key was not shown once after creation");
    assert(A.livePageId, "A's active page was not created");
    const order = { landingPage: `${TAG.A.toLowerCase()}-live`, customer: { name: 'Api Hijack', phone: '+2348000000009', address: '1 Test Street', state: 'Lagos' }, items: [{ product: `${TAG.A.toLowerCase()}-cream`, quantity: 1 }], idempotencyKey: `iso-${RUN}-hijack-0000` };
    const r = await fetch(`${SKYFLY}/api/public/orders`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${B.apiKey}` }, body: JSON.stringify(order) });
    const t = await r.text();
    assert(r.status === 403 && /FORBIDDEN/.test(t) && !/"reference"/.test(t), `B's key on A's active page: HTTP ${r.status} ${t.slice(0, 160)}`);
    stats.blocked += 1;
    const u = await fetch(`${SKYFLY}/api/public/orders`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer sky_000000000000000000000000000000000' }, body: JSON.stringify(order) });
    assert(u.status === 401, `unknown key: HTTP ${u.status}`);
    return `B's key on A's active page → HTTP 403 FORBIDDEN (no order); unknown key → 401`;
  });

  await step('Search, exports, reports and analytics as B: nothing of A', async () => {
    // Queries match both businesses' test records (A's would show its marker); they never contain the marker themselves.
    const paths = ['/orders?q=Testcustomer', '/orders?q=Test+Street', '/orders/export.csv', '/email-contacts?q=contact', '/email-contacts/export.csv', '/google-sheets/export.csv', '/customers?q=Testcustomer', '/analytics', '/activity', '/?days=90', '/checkouts', '/subscription', '/integrations'];
    const bad = [];
    for (const p of paths) {
      const r = await B.s.get(B.base + p);
      stats.crossTenant += 1;
      if (leaks(r.text).length) bad.push(`${p} LEAK`); else stats.blocked += 1;
      if (r.status >= 500) bad.push(`${p} → ${r.status}`);
    }
    assert(!bad.length, bad.join('; '));
    return `${paths.length} views/exports checked`;
  });

  await step(`Super Admin area: A, B and A's staff get 404 on all ${adminRoutes().length} Super Admin routes (GET and POST)`, async () => {
    const bad = [];
    for (const who of [A.s, B.s, staff.s]) for (const [m, p] of adminRoutes()) {
      const url = p.replace(/:(\w+)(\([^)]*\))?/g, (_, n, c) => (c ? c.slice(1, -1).split('|')[0] : String(n === 'id' ? A.business : PLACEHOLDER)));
      const r = m === 'get' ? await who.get(url) : await who.req('POST', url, { form: { _csrf: who.token, email: 'x@skyfly.invalid', password: PASSWORD, client_signup: 'open' } });
      stats.crossTenant += 1;
      if (r.status === 404) stats.blocked += 1; else bad.push(`${m.toUpperCase()} ${url} → ${r.status}`);
    }
    for (const who of [A.s, B.s]) { const r = await who.get('/admin/login'); if (r.status !== 404) bad.push(`/admin/login → ${r.status}`); }
    assert(!bad.length, bad.slice(0, 5).join('; '));
    return `${adminRoutes().length * 3} requests, all 404 (registration with "admin" fields gave no Super Admin)`;
  });

  await step('Role escalation: staff cannot make themself owner, A cannot gain Super Admin through settings or team forms', async () => {
    const bad = [];
    if (A.userId) {
      const r = await staff.s.req('POST', `${A.base}/team/members/${A.userId}/role`, { form: { _csrf: staff.s.token, role: 'owner' } });
      if (r.status !== 403) bad.push(`staff role change → ${r.status}`);
    }
    await A.s.post(`${A.base}/settings`, { name: `Isolation ${TAG.A} (test)`, whatsapp_number: `+23480${RUN.slice(-8)}`, order_prefix: 'AL', currency: 'NGN', is_platform_admin: 'true', role: 'admin' });
    await A.s.post(`${A.base}/team/invite`, { email: `e2e-iso-x-${RUN}@skyfly.invalid`, role: 'admin' });
    if ((await A.s.get('/admin')).status !== 404) bad.push('A reached /admin');
    const team = await A.s.get(`${A.base}/team`);
    if (/e2e-iso-x-/.test(team.text) && />\s*(Admin|Super Admin)\s*</.test(team.text)) bad.push('an "admin" role was accepted');
    stats.crossTenant += 3;
    assert(!bad.length, bad.join('; '));
    stats.blocked += 3;
    return 'staff → 403; /admin still 404 for A';
  });

  await step("Staff of A: only the Orders section of A; owner-only sections 403; Business B 404", async () => {
    const out = [];
    const o = await staff.s.get(`${A.base}/orders`);
    assert(o.status === 200, `orders → ${o.status}`);
    for (const p of ['/settings', '/team', '/api-keys', '/pixels', '/products', '/landing-pages', '/email', '/email-contacts', '/google-sheets']) {
      const r = await staff.s.get(A.base + p); stats.crossTenant += 1;
      if (r.status === 403) stats.blocked += 1; else out.push(`${p} → ${r.status}`);
    }
    for (const p of ['', '/orders', B.orderId ? `/orders/${B.orderId}` : '/orders']) {
      const r = await staff.s.get(B.base + p); stats.crossTenant += 1;
      if (r.status === 404) stats.blocked += 1; else out.push(`B${p} → ${r.status}`);
    }
    assert(!out.length, out.join('; '));
    return 'orders 200; 9 owner sections 403; Business B 404';
  });

  await step('Files and public links: A\'s draft pages, uploaded files, previews and order page are not reachable without their secret', async () => {
    const out = [];
    // The URLs contain A's slug (and 404 pages may repeat it), so look for A's content, not its name.
    const content = (t) => [`${TAG.A} private draft`, `${TAG.A} Cream`, `${TAG.A} Testcustomer`, `${TAG.A} secret description`].filter((m) => String(t).includes(m));
    const refused = (r) => r.status === 404 || (r.status === 302 && /\/login/.test(r.location));
    for (const p of [`/p/${TAG.A.toLowerCase()}-page/`, `/p/${A.uploadSlug}/`, `/p/${A.uploadSlug}/index.html`, `/api/public/pages/${TAG.A.toLowerCase()}-page/catalog`, `/api/public/pages/${A.uploadSlug}/tracking`]) {
      const r = await anon.get(p);
      if (!refused(r) || content(r.text).length) out.push(`${p} → ${r.status}`);
    }
    if (A.versionId) for (const p of [`/_preview/${A.versionId}/0.bad/`, `/_sandbox/${A.versionId}/9999999999.bad/`, `/_preview/${A.versionId}/9999999999.${'0'.repeat(64)}/`]) {
      const r = await anon.get(p);
      if (!refused(r) || content(r.text).length) out.push(`${p} → ${r.status}`);
    }
    if (A.previewPath && B.versionId) {
      const swapped = A.previewPath.replace(/\/(\d+)\//, `/${B.versionId}/`);
      const r = await anon.get(swapped);
      if (!refused(r)) out.push(`A's preview token on B's version → ${r.status}`);
    }
    if (A.orderRef) for (const q of ['', '?t=', '?t=wrong-token-0000']) {
      const r = await anon.get(`/o/${A.orderRef}${q}`);
      if (r.status !== 404 || content(r.text).length) out.push(`/o/<A's order>${q} → ${r.status}`);
    }
    assert(!out.length, out.join('; '));
    return `drafts 404; tampered preview links 404; order page without token 404${A.previewPath ? '' : ' (no preview link shown on this deployment)'}`;
  });

  await step("A's records are unchanged after every attack, and A still sees them (the sweep did not pass because pages were broken)", async () => {
    const after = await aView();
    assert(after === beforeA, `changed:\n before ${beforeA}\n after  ${after}`);
    assert(/\/products:200:[1-9]/.test(after) && /\/orders\/\d+:200:[1-9]/.test(after), `A cannot see its own records: ${after}`);
    return after;
  });
} finally {
  console.log(`\nSUMMARY  requests ${stats.requests}; cross-business attempts ${stats.crossTenant}; signed-out attempts ${stats.unauth}; blocked ${stats.blocked}; responses showing another business's data ${stats.leaks}`);
  console.log(`SUMMARY  test businesses: A #${A.business ?? '?'} "Isolation ${TAG.A} (test)", B #${B.business ?? '?'} "Isolation ${TAG.B} (test)"; staff of A: e2e-iso-staff-${RUN}@skyfly.invalid`);
  console.log(failed ? `\n${failed} check(s) failed, ${passed} passed` : `\nAll ${passed} isolation checks passed`);
}
process.exit(failed ? 1 : 0);
