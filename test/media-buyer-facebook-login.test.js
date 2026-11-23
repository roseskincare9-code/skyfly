// Facebook Login (official Meta OAuth) for the AI Media Buyer, against a stand-in Graph API: the start
// (owner only, one-time hashed state, fixed redirect address, advertising scopes), the callback (same user, once,
// still the business's owner; code exchanged server-side with the app secret for a long-lived token; permissions
// and paginated ad accounts read), the account picker (only accounts Meta listed, only for that business and
// that user), several accounts at once, refusals, cancellation, reconnection, and business isolation.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import request from 'supertest';
import { setup, resetDatabase, csrfToken, signUp, openClientSignup } from './helpers.js';

const SECRET = 'app-secret-for-tests';
const TOKEN = `EAAlong${'x'.repeat(60)}`;
const SHORT = `EAAshort${'y'.repeat(60)}`;
const meta = { calls: [], adaccounts: null };
const metaServer = createServer((req, res) => {
  const u = new URL(req.url, 'http://x'); const p = u.pathname.replace(/^\/v\d+\.\d+/, ''); const q = Object.fromEntries(u.searchParams);
  meta.calls.push({ path: p, q: { ...q, access_token: q.access_token ? 'present' : undefined, client_secret: q.client_secret ? 'present' : undefined } });
  const send = (o, s = 200) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (p === '/oauth/access_token') {
    if (q.client_id !== '1234567890' || q.client_secret !== SECRET) return send({ error: { message: 'Error validating client secret.', code: 1 } }, 400);
    if (q.grant_type === 'fb_exchange_token') return q.fb_exchange_token === SHORT ? send({ access_token: TOKEN, token_type: 'bearer', expires_in: 5184000 }) : send({ error: { message: 'bad token', code: 190 } }, 400);
    if (q.code !== 'good-code') return send({ error: { message: 'This authorization code has expired.', code: 100 } }, 400);
    if (!q.redirect_uri.endsWith('/meta/oauth/callback')) return send({ error: { message: 'redirect_uri mismatch', code: 100 } }, 400);
    return send({ access_token: SHORT, token_type: 'bearer', expires_in: 3600 });
  }
  if (q.access_token !== TOKEN) return send({ error: { message: 'Invalid OAuth access token.', code: 190 } }, 401);
  if (p === '/me') return send({ id: '42', name: 'Ada Owner' });
  if (p === '/me/permissions') return send({ data: ['ads_read', 'ads_management', 'business_management', 'pages_show_list'].map((permission) => ({ permission, status: 'granted' })).concat([{ permission: 'pages_manage_ads', status: 'declined' }]) });
  if (p === '/me/adaccounts') {
    if (meta.adaccounts) return send({ data: meta.adaccounts });
    if (meta.many) { // N accounts in pages of 7, across two portfolios, as Meta paginates
      const start = Number(q.after ?? 0); const end = Math.min(start + 7, meta.many);
      const data = Array.from({ length: end - start }, (_, i) => { const n = start + i; return { account_id: String(300000000 + n), name: `Lara Account ${n + 1}`, currency: 'NGN', account_status: 1, user_tasks: ['ADVERTISE'], business: { id: n % 2 ? '71' : '72', name: n % 2 ? 'Lara Brands' : 'Lara Markets' } }; });
      return send({ data, paging: end < meta.many ? { cursors: { after: String(end) }, next: 'https://graph.facebook.com/next' } : { cursors: {} } });
    }
    // Two pages, as Meta paginates.
    if (!q.after) return send({ data: [{ id: 'act_111111111', account_id: '111111111', name: 'Glow Main', currency: 'NGN', account_status: 1, user_tasks: ['MANAGE', 'ADVERTISE', 'ANALYZE'], business: { id: '9', name: 'Glow BM' } }, { account_id: '555555555', name: 'Locked Out', currency: 'NGN', account_status: 1 }], paging: { cursors: { after: 'CUR' }, next: 'https://graph.facebook.com/next' } });
    return send({ data: [{ account_id: '999999999', name: 'Glow Second', currency: 'USD', account_status: 1, user_tasks: ['ANALYZE'] }, { account_id: '777777777', name: 'Old Closed', currency: 'NGN', account_status: 101, user_tasks: ['MANAGE'] }], paging: { cursors: { before: 'CUR' } } });
  }
  const m = /^\/act_(\d+)(\/[a-z_]+)?$/.exec(p);
  if (m && (['111111111', '999999999'].includes(m[1]) || (meta.okAccounts ?? []).includes(m[1]))) {
    if (!m[2]) return send({ id: `act_${m[1]}`, name: m[1] === '111111111' ? 'Glow Main' : 'Glow Second', currency: 'NGN', account_status: 1 });
    if (m[2] === '/promote_pages') return send({ data: [{ id: 'page1', name: 'Glow Page' }] });
    if (m[2] === '/adspixels') return send({ data: [{ id: 'px1', name: 'Glow pixel' }] });
    return send({ data: [] });
  }
  if (m) return send({ error: { message: '(#200) Ad account owner has NOT grant ads_management or ads_read permission', code: 200 } }, 403);
  send({ data: [] });
});
await new Promise((r) => metaServer.listen(0, r));

const encryptionKey = randomBytes(32);
const graph = `http://127.0.0.1:${metaServer.address().port}/v26.0`;
const on = setup({ metaGraphBase: graph, encryptionKey, publicBaseUrl: 'https://getskyfly.test', metaLogin: { appId: '1234567890', appSecret: SECRET, configId: null } });
const off = setup({ metaGraphBase: graph, encryptionKey, publicBaseUrl: 'https://getskyfly.test', metaLogin: null });
const { pool } = on;
let founder; let ownerA; let ownerB; let A; let B;
const mb = (biz) => `/businesses/${biz}/media-buyer`;
const post = async (agent, path, form = {}) => { const _csrf = await csrfToken(agent, `/businesses/${path.match(/\/businesses\/(\d+)/)[1]}/subscription`); return agent.post(path).type('form').send({ _csrf, ...form }); };
const expect = async (p, code) => { const r = await p; assert.equal(r.status, code, r.text?.slice(0, 400)); return r; };
const start = async (agent, biz) => { const r = await expect(post(agent, `${mb(biz)}/connect/facebook`), 303); return new URL(r.headers.location); };
const hash = (s) => createHash('sha256').update(s).digest('hex');

before(async () => {
  await resetDatabase(pool);
  founder = await signUp(on.app, { name: 'Founder', email: 'founder@skyfly.test' });
  await openClientSignup(pool);
  ownerA = await signUp(on.app, { name: 'Owner A', email: 'a@glow.test', business: 'Glow Lagos' });
  ownerB = await signUp(on.app, { name: 'Owner B', email: 'b@other.test', business: 'Other Shop' });
  [A, B] = await Promise.all(['Glow Lagos', 'Other Shop'].map(async (n) => (await pool.query('SELECT id FROM businesses WHERE name = $1', [n])).rows[0].id));
});
after(async () => { metaServer.close(); await pool.end(); await off.pool.end(); });

test('without Skyfly\'s Meta app on the server: the button is disabled and says exactly what is missing', async () => {
  const agent = request.agent(off.app);
  const _csrf = await csrfToken(agent, '/login');
  await agent.post('/login').type('form').send({ _csrf, email: 'a@glow.test', password: 'correct-horse-battery' }).expect(302);
  const page = await agent.get(`${mb(A)}?tab=settings`).expect(200);
  assert.match(page.text, /<button[^>]*disabled data-fb-start/);
  assert.match(page.text, /META_APP_ID, META_APP_SECRET/);
  const r = await expect(post(agent, `${mb(A)}/connect/facebook`), 409);
  assert.match(r.text, /Facebook Login is not set up on the server yet/);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM meta_oauth_states')).rows[0].n, 0);
});

test('start: the owner is sent to Meta\'s official dialog with the fixed callback, the advertising scopes and a one-time state', async () => {
  const page = await ownerA.get(`${mb(A)}?tab=settings`).expect(200);
  assert.match(page.text, /<button class="btn" type="submit"  data-fb-start>Connect with Facebook/);
  const url = await start(ownerA, A);
  assert.equal(url.origin, 'https://www.facebook.com');
  assert.equal(url.pathname, '/v26.0/dialog/oauth');
  assert.equal(url.searchParams.get('client_id'), '1234567890');
  assert.equal(url.searchParams.get('redirect_uri'), 'https://getskyfly.test/meta/oauth/callback');
  for (const s of ['ads_management', 'ads_read', 'business_management', 'pages_show_list']) assert.ok(url.searchParams.get('scope').split(',').includes(s), s);
  const state = url.searchParams.get('state');
  const { rows } = await pool.query('SELECT state_hash, business_id FROM meta_oauth_states');
  assert.equal(rows.length, 1); assert.equal(rows[0].state_hash, hash(state)); assert.equal(Number(rows[0].business_id), Number(A)); // stored hashed only
  // The Content Security Policy lets the form send the owner to Meta.
  assert.match(page.headers['content-security-policy'], /form-action[^;]*https:\/\/www\.facebook\.com/);
});

test('callback: another user, a made-up state or a reused state is refused; the owner\'s own completes once', async () => {
  const state = (await start(ownerA, A)).searchParams.get('state');
  // Owner B (signed in, other business) cannot use A's state, and doing so does not burn it.
  await ownerB.get(`/meta/oauth/callback?state=${state}&code=good-code`).expect(400);
  await ownerA.get(`/meta/oauth/callback?state=${'x'.repeat(32)}&code=good-code`).expect(400);
  const anon = await request(on.app).get(`/meta/oauth/callback?state=${state}&code=good-code`); // signed out: refused (sent to sign in or 400)
  assert.ok(anon.status === 400 || (anon.status === 302 && /\/login/.test(anon.headers.location)), `${anon.status} ${anon.headers.location}`);
  const r = await ownerA.get(`/meta/oauth/callback?state=${state}&code=good-code`).expect(302);
  assert.equal(r.headers.location, `${mb(A)}?tab=settings&done=fb_pick#facebook-accounts`);
  await ownerA.get(`/meta/oauth/callback?state=${state}&code=good-code`).expect(400); // used once
  // The code was exchanged server-side with the secret; the short token was swapped for a long-lived one.
  const exch = meta.calls.filter((c) => c.path === '/oauth/access_token');
  assert.equal(exch.at(-2).q.client_secret, 'present'); assert.equal(exch.at(-1).q.grant_type, 'fb_exchange_token');
  const { rows: [g] } = await pool.query('SELECT * FROM meta_oauth_grants WHERE business_id = $1', [A]);
  assert.ok(!g.token_enc.includes(TOKEN) && !g.token_enc.includes('EAA'), 'token stored encrypted');
  assert.deepEqual(g.accounts.map((a) => a.id), ['111111111', '555555555', '999999999', '777777777']); // both pages of results
  assert.ok(g.granted.includes('ads_management')); assert.deepEqual(g.declined, ['pages_manage_ads']);
  assert.ok(new Date(g.token_expires_at) - Date.now() > 50 * 864e5);
  const page = await ownerA.get(`${mb(A)}?tab=settings&done=fb_pick`).expect(200);
  assert.match(page.text, /Signed in with Facebook as Ada Owner/);
  for (const id of ['111111111', '555555555', '999999999', '777777777']) assert.match(page.text, new RegExp(`data-fb-account="${id}"`));
  assert.ok(!page.text.includes(TOKEN));
  // Owner B never sees A's picker.
  assert.doesNotMatch((await ownerB.get(`${mb(B)}?tab=settings`).expect(200)).text, /data-fb-picker/);
});

test('picker: only accounts Meta listed, only for this business and user; several at once; a refused one is reported', async () => {
  const { rows: [g] } = await pool.query('SELECT id FROM meta_oauth_grants WHERE business_id = $1', [A]);
  // Owner B cannot use A's grant in B's business (it is A's, and B's own grant does not exist).
  const x = await expect(post(ownerB, `${mb(B)}/connect/facebook/accounts`, { grant: g.id, accounts: '111111111' }), 410);
  assert.match(x.text, /expired/);
  // An account Meta did not list is refused (the request cannot pick accounts on its own).
  const y = await expect(post(ownerA, `${mb(A)}/connect/facebook/accounts`, { grant: g.id, accounts: '222222222' }), 400);
  assert.match(y.text, /was not in the list Meta returned/);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM ad_connections')).rows[0].n, 0);
  // Two good accounts and one Meta refuses.
  const r = await expect(post(ownerA, `${mb(A)}/connect/facebook/accounts`, { grant: g.id, accounts: ['111111111', '999999999', '555555555'] }), 400);
  assert.match(r.text, /act_555555555: Meta: \(#200\)/); assert.match(r.text, /the other selected accounts were connected/);
  const { rows } = await pool.query('SELECT business_id, ad_account_id, connected_via, token_enc, token_expires_at, selected FROM ad_connections ORDER BY ad_account_id');
  assert.deepEqual(rows.map((c) => [Number(c.business_id), c.ad_account_id, c.connected_via]), [[Number(A), '111111111', 'facebook_login'], [Number(A), '999999999', 'facebook_login']]);
  assert.ok(rows.every((c) => c.token_expires_at && !c.token_enc.includes('EAA')));
  assert.equal(rows.filter((c) => c.selected).length, 1);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM meta_oauth_grants')).rows[0].n, 0); // used grant deleted
  const settings = await ownerA.get(`${mb(A)}?tab=settings`).expect(200);
  assert.match(settings.text, /Facebook Login · expires in (59|60) days/);
  // Business B sees none of A's accounts.
  const bPage = await ownerB.get(`${mb(B)}?tab=settings`).expect(200);
  assert.doesNotMatch(bPage.text, /111111111|999999999|Glow Main/);
});

test('reconnect refreshes the same account (no duplicate); a cancelled login stores nothing', async () => {
  let state = (await start(ownerA, A)).searchParams.get('state');
  await ownerA.get(`/meta/oauth/callback?state=${state}&error=access_denied&error_reason=user_denied`).expect(302)
    .expect('location', `${mb(A)}?tab=settings&done=fb_cancelled`);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM meta_oauth_grants')).rows[0].n, 0);
  state = (await start(ownerA, A)).searchParams.get('state');
  await ownerA.get(`/meta/oauth/callback?state=${state}&code=good-code`).expect(302);
  const { rows: [g] } = await pool.query('SELECT id FROM meta_oauth_grants WHERE business_id = $1', [A]);
  await expect(post(ownerA, `${mb(A)}/connect/facebook/accounts`, { grant: g.id, accounts: '111111111' }), 302);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM ad_connections WHERE ad_account_id = '111111111'")).rows[0].n, 1);
  // An expired code is reported, nothing stored.
  state = (await start(ownerA, A)).searchParams.get('state');
  const bad = await ownerA.get(`/meta/oauth/callback?state=${state}&code=old-code`).expect(302);
  assert.match(decodeURIComponent(bad.headers.location), /fb_error=Meta: This authorization code has expired/);
});

test('the same Meta account can be connected to two businesses only by each one\'s own owner, and each keeps its own copy', async () => {
  const state = (await start(ownerB, B)).searchParams.get('state');
  await ownerB.get(`/meta/oauth/callback?state=${state}&code=good-code`).expect(302);
  const { rows: [g] } = await pool.query('SELECT id FROM meta_oauth_grants WHERE business_id = $1', [B]);
  // A cannot spend B's grant from A's business.
  await expect(post(ownerA, `${mb(A)}/connect/facebook/accounts`, { grant: g.id, accounts: '111111111' }), 410);
  await expect(post(ownerB, `${mb(B)}/connect/facebook/accounts`, { grant: g.id, accounts: '111111111' }), 302);
  const { rows } = await pool.query("SELECT business_id FROM ad_connections WHERE ad_account_id = '111111111' ORDER BY business_id");
  assert.deepEqual(rows.map((r) => Number(r.business_id)), [Number(A), Number(B)].sort((a, b) => a - b));
  // Disconnecting in B leaves A's untouched.
  await expect(post(ownerB, `${mb(B)}/accounts/111111111/disconnect`), 302);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM ad_connections WHERE ad_account_id = '111111111'")).rows[0].n, 1);
});

test('a Super Admin visiting a client business cannot start Facebook Login for it', async () => {
  const r = await post(founder, `${mb(A)}/connect/facebook`);
  assert.ok([403, 404].includes(r.status), `status ${r.status}`);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM meta_oauth_states WHERE user_id = (SELECT id FROM users WHERE email = $1)', ['founder@skyfly.test'])).rows[0].n, 0);
});

test('the overview says exactly what the automatic analysis is waiting for (no bare "idle")', async () => {
  const page = await ownerB.get(mb(B)).expect(200);
  assert.match(page.text, /Automatic analysis and plan: <strong>waiting<\/strong>/);
  assert.match(page.text, /data-waiting-for> · starts automatically once it has the business profile \(\d+ items? missing\), a connected Meta ad account, an AI key on the Skyfly server/);
});


test('the System User token form still works, and tolerates a pasted "Bearer " prefix, quotes and line breaks', async () => {
  const r0 = await post(ownerB, `${mb(B)}/connect`, { ad_account_id: ' act_999999999 ', token: `Bearer "${TOKEN.slice(0, 30)}\n${TOKEN.slice(30)}"` }); const r = await expect(Promise.resolve(r0), 302);
  assert.match(r.headers.location, /done=connected/);
  const { rows: [c] } = await pool.query("SELECT connected_via, token_expires_at FROM ad_connections WHERE business_id = $1 AND ad_account_id = '999999999'", [B]);
  assert.equal(c.connected_via, 'token'); assert.equal(c.token_expires_at, null);
});

test('a failed connection attempt is shown in Settings with Meta\'s own message until an account connects', async () => {
  await expect(post(ownerB, `${mb(B)}/connect`, { ad_account_id: '555555555', token: TOKEN }), 400);
  const page = await ownerB.get(`${mb(B)}?tab=settings`).expect(200);
  assert.match(page.text, /data-last-connect-failure>Last connection attempt/);
  assert.match(page.text, /does not have access to that ad account/);
  // Business A shows only its own last failure (the expired code earlier), never B's.
  const a = (await ownerA.get(`${mb(A)}?tab=settings`).expect(200)).text;
  assert.match(a, /authorization code has expired/); assert.doesNotMatch(a, /NOT grant/);
});

test('discovery: 17 accounts over 3 pages and 2 portfolios are all listed, with portfolio and access level; nothing truncated', async () => {
  meta.many = 17;
  try {
    const state = (await start(ownerB, B)).searchParams.get('state');
    await ownerB.get(`/meta/oauth/callback?state=${state}&code=good-code`).expect(302);
    const { rows: [g] } = await pool.query('SELECT accounts, truncated FROM meta_oauth_grants WHERE business_id = $1', [B]);
    assert.equal(g.accounts.length, 17); assert.equal(g.truncated, false);
    assert.equal(new Set(g.accounts.map((a) => a.id)).size, 17);
    assert.deepEqual([...new Set(g.accounts.map((a) => a.business))].sort(), ['Lara Brands', 'Lara Markets']);
    assert.ok(g.accounts.every((a) => a.access === 'advertiser' && a.can_build === true && a.connectable === true));
    const page = await ownerB.get(`${mb(B)}?tab=settings`).expect(200);
    assert.match(page.text, /17 ad accounts found across 2 business portfolios/);
    assert.match(page.text, /Portfolio: Lara Brands/); assert.match(page.text, /Your access: advertiser/);
    // Connect 15 at once: all 15 are this business's, none is A's.
    const ids = g.accounts.slice(0, 15).map((a) => a.id);
    const { rows: [gid] } = await pool.query('SELECT id FROM meta_oauth_grants WHERE business_id = $1', [B]);
    meta.okAccounts = ids;
    await expect(post(ownerB, `${mb(B)}/connect/facebook/accounts`, { grant: gid.id, accounts: ids }), 302);
    const { rows } = await pool.query('SELECT business_id, ad_account_id, selected FROM ad_connections WHERE ad_account_id = ANY($1)', [ids]);
    assert.equal(rows.length, 15); assert.ok(rows.every((r) => Number(r.business_id) === Number(B)));
    assert.doesNotMatch((await ownerA.get(`${mb(A)}?tab=settings`).expect(200)).text, /Lara Account/);
  } finally { meta.many = 0; meta.okAccounts = null; }
});

test('discovery: more accounts than Skyfly shows is flagged, never silently cut', async () => {
  meta.many = 505;
  try {
    const state = (await start(ownerB, B)).searchParams.get('state');
    await ownerB.get(`/meta/oauth/callback?state=${state}&code=good-code`).expect(302);
    const { rows: [g] } = await pool.query('SELECT jsonb_array_length(accounts) AS n, truncated FROM meta_oauth_grants WHERE business_id = $1', [B]);
    assert.equal(g.n, 500); assert.equal(g.truncated, true);
    assert.match((await ownerB.get(`${mb(B)}?tab=settings`).expect(200)).text, /data-fb-truncated/);
    await expect(post(ownerB, `${mb(B)}/connect/facebook/cancel`), 302);
  } finally { meta.many = 0; }
});

test('a closed account is shown as restricted and refused; read-only access is labelled; the others still connect', async () => {
  const state = (await start(ownerA, A)).searchParams.get('state');
  await ownerA.get(`/meta/oauth/callback?state=${state}&code=good-code`).expect(302);
  const page = await ownerA.get(`${mb(A)}?tab=settings`).expect(200);
  assert.match(page.text, /data-fb-account="777777777" data-fb-kind="restricted"[\s\S]{0,200}disabled/);
  assert.match(page.text, /Status: Closed/); assert.match(page.text, /Read-only: Skyfly can report but not build campaigns/);
  const { rows: [g] } = await pool.query('SELECT id FROM meta_oauth_grants WHERE business_id = $1', [A]);
  const r = await expect(post(ownerA, `${mb(A)}/connect/facebook/accounts`, { grant: g.id, accounts: ['777777777', '111111111'] }), 400);
  assert.match(r.text, /act_777777777: the account is closed in Meta, so it cannot be connected/);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM ad_connections WHERE ad_account_id = '777777777'")).rows[0].n, 0);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM ad_connections WHERE business_id = $1 AND ad_account_id = '111111111'", [A])).rows[0].n, 1);
});

test('refresh: re-reads the account list with the business\'s own saved Facebook sign-in (no new login); never another business\'s', async () => {
  const before = meta.calls.filter((c) => c.path === '/oauth/access_token').length;
  await expect(post(ownerA, `${mb(A)}/connect/facebook/refresh`), 302);
  assert.equal(meta.calls.filter((c) => c.path === '/oauth/access_token').length, before); // no code exchange: no sign-in
  const { rows: [g] } = await pool.query('SELECT accounts FROM meta_oauth_grants WHERE business_id = $1', [A]);
  assert.equal(g.accounts.length, 4);
  assert.match((await ownerA.get(`${mb(A)}?tab=settings`).expect(200)).text, /data-fb-refresh/);
  // A business without a Facebook Login connection cannot refresh (and never borrows another business's token).
  await pool.query("DELETE FROM ad_connections WHERE business_id = $1 AND connected_via = 'facebook_login'", [B]);
  const r = await expect(post(ownerB, `${mb(B)}/connect/facebook/refresh`), 409);
  assert.match(r.text, /No working Facebook Login connection to refresh from/);
  // An expired saved sign-in is not used.
  await pool.query("UPDATE ad_connections SET token_expires_at = now() - interval '1 day' WHERE business_id = $1 AND connected_via = 'facebook_login'", [A]);
  await expect(post(ownerA, `${mb(A)}/connect/facebook/refresh`), 409);
});

test('accounts whose sign-in expired or was rejected by Meta are marked "Needs reconnection" with a reconnect button', async () => {
  const page = await ownerA.get(`${mb(A)}?tab=settings`).expect(200);
  assert.match(page.text, /data-account-status="reconnect">Needs reconnection/);
  assert.match(page.text, /data-reconnect >Reconnect with Facebook/);
  await pool.query("UPDATE ad_connections SET token_expires_at = now() + interval '30 days' WHERE business_id = $1", [A]);
  await pool.query("UPDATE ad_connections SET status = 'failed', last_error = 'Meta: Error validating access token (code 190)' WHERE business_id = $1 AND ad_account_id = '111111111'", [A]);
  const p2 = await ownerA.get(`${mb(A)}?tab=settings`).expect(200);
  assert.match(p2.text, /data-account="111111111"[\s\S]{0,600}Needs reconnection/);
});

