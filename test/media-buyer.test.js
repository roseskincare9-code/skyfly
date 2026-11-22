// AI Media Buyer (Cloudy), against stand-in Meta Marketing API and Anthropic API servers:
// onboarding, each business's OWN Meta ad account (verified, stored encrypted, never shown), live numbers,
// the AI conversation built only from that business's data, audits / briefs / campaign drafts, draft-first
// approval (a PAUSED campaign shell; nothing activated, no ad set or budget), creative library with AI
// review, roles, and isolation between two businesses (including what is sent to the AI).
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { setup, resetDatabase, csrfToken, signUp, openClientSignup } from './helpers.js';
import { hashPassword } from '../src/lib/passwords.js';

// ---------- stand-in Meta Marketing API: token "tokA…" sees act_111 only; "tokB…" act_222 only.
const meta = { calls: [], created: [] };
// Token "tokA" (business A's) may use two ad accounts; "tokB" only its own.
const ACCOUNTS = { tokA: ['111111111', '333333333'], tokB: ['222222222'] };
const NAMES = { 111111111: 'Alpha Ads', 333333333: 'Alpha Abuja Ads', 222222222: 'Beta Ads' };
const insights = (spend, purchases, value) => ({ spend: String(spend), impressions: '10000', clicks: '200', ctr: '2', cpc: '50', cpm: '1000', frequency: '1.4',
  actions: purchases ? [{ action_type: 'purchase', value: String(purchases) }] : [], action_values: value ? [{ action_type: 'purchase', value: String(value) }] : [] });
const metaServer = createServer(async (req, res) => {
  let raw = ''; for await (const c of req) raw += c;
  const u = new URL(req.url, 'http://x'); const token = u.searchParams.get('access_token') ?? ''; const p = u.pathname.replace(/^\/v\d+\.\d+/, '');
  meta.calls.push({ method: req.method, path: p, token: token.slice(0, 4), level: u.searchParams.get('level'), body: raw ? JSON.parse(raw) : null });
  const send = (o, s = 200) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  const allowed = ACCOUNTS[token.slice(0, 4)];
  if (!allowed) return send({ error: { message: 'Invalid OAuth access token.', code: 190 } }, 401);
  const m = /^\/act_(\d+)(\/[a-z_]+)?$/.exec(p);
  const act = m ? m[1] : allowed[0];
  if (m && !allowed.includes(m[1])) return send({ error: { message: '(#200) Ad account owner has NOT grant ads_management or ads_read permission', code: 200 } }, 403);
  if (m && !m[2]) return send({ id: `act_${act}`, name: NAMES[act], currency: 'NGN', account_status: 1 });
  if (m?.[2] === '/promote_pages') return send({ data: [{ id: `page${act}`, name: `Page ${act}` }] });
  if (m?.[2] === '/adspixels') return send({ data: [{ id: `px${act}`, name: `Pixel ${act}` }] });
  if (m?.[2] === '/campaigns' && req.method === 'GET') return send({ data: [{ id: 'c1', name: 'Winner campaign', status: 'ACTIVE', effective_status: 'ACTIVE', objective: 'OUTCOME_SALES', daily_budget: '500000' }, { id: 'c2', name: 'Waste campaign', status: 'ACTIVE', effective_status: 'ACTIVE', objective: 'OUTCOME_SALES', daily_budget: '300000' }] });
  if (m?.[2] === '/campaigns' && req.method === 'POST') { const id = `9${meta.created.length + 1}`; meta.created.push({ id, act, ...JSON.parse(raw) }); return send({ id }); }
  if (m?.[2] === '/insights') {
    const level = u.searchParams.get('level');
    if (level === 'campaign') return send({ data: [{ campaign_id: 'c1', campaign_name: 'Winner campaign', ...insights(30000, 6, 180000) }, { campaign_id: 'c2', campaign_name: 'Waste campaign', ...insights(20000, 0, 0) }] });
    if (level === 'adset') return send({ data: [{ adset_id: 's1', adset_name: 'Lagos women 25-45', campaign_name: 'Winner campaign', ...insights(30000, 6, 180000) }] });
    if (level === 'ad') return send({ data: [{ ad_id: 'a1', ad_name: 'UGC video 1', campaign_name: 'Winner campaign', ...insights(30000, 6, 180000) }] });
    return send({ data: [insights(50000, 6, 180000)] });
  }
  const made = meta.created.find((x) => `/${x.id}` === p);
  if (made) return send({ id: made.id, name: made.name, status: made.status, effective_status: made.status, objective: made.objective });
  send({ error: { message: 'not mocked' } }, 404);
});
// ---------- stand-in Anthropic Messages API: records every request; answers per task.
const ai = { requests: [] };
const aiServer = createServer(async (req, res) => {
  let raw = ''; for await (const c of req) raw += c;
  const body = JSON.parse(raw); ai.requests.push({ key: req.headers['x-api-key'], body });
  const last = JSON.stringify(body.messages.at(-1).content);
  let text = 'Your Winner campaign has 6 purchases at NGN 5,000 each; the Waste campaign spent NGN 20,000 with no purchases: pause it and move budget.';
  if (last.includes('write 3 briefs')) text = '```json\n{"items":[{"title":"Before/after glow","objective":"Purchases","audience":"Women 25-45 Lagos","angle":"Visible results","hook":"7 days, one serum","format":"video","duration":"20s","script":"…","scenes":["Close-up","Apply","Result"],"voiceover":"…","caption":"…","headline":"Glow in 7 days","cta":"Shop now","notes":""}]}\n```';
  if (last.includes('ONE campaign draft')) text = '```json\n{"name":"Glow serum sales test","objective":"OUTCOME_SALES","daily_budget":5000,"locations":"Lagos","audience":"Women 25-45","placements":"Advantage+","creatives":"UGC video 1","primary_text":"…","headline":"Glow in 7 days","cta":"SHOP_NOW","landing_page":"/p/glow/","reasoning":"…","test_plan":"…"}\n```';
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ id: 'msg', type: 'message', role: 'assistant', content: [{ type: 'text', text }] }));
});
await Promise.all([new Promise((r) => metaServer.listen(0, r)), new Promise((r) => aiServer.listen(0, r))]);

const encryptionKey = randomBytes(32);
const { pool, app: expressApp } = setup({
  metaGraphBase: `http://127.0.0.1:${metaServer.address().port}/v26.0`, encryptionKey,
  cloudy: { apiKey: 'sk-ant-test', model: 'claude-sonnet-5-5', apiBase: `http://127.0.0.1:${aiServer.address().port}` },
});
const off = setup({ allowedOrigins: [] });
const app = expressApp.listen(0);
let ownerA; let ownerB; let staffA; let A; let B;
const TOK_A = `tokA${'a'.repeat(40)}`; const TOK_B = `tokB${'b'.repeat(40)}`;
const post = async (agent, path, form = {}) => { const _csrf = await csrfToken(agent, `/businesses/${path.match(/\/businesses\/(\d+)/)[1]}/subscription`); return agent.post(path).type('form').send({ _csrf, ...form }); };
const mb = (biz) => `/businesses/${biz}/media-buyer`;

before(async () => {
  await resetDatabase(pool);
  await signUp(app, { name: 'Founder', email: 'founder@skyfly.test' });
  await openClientSignup(pool);
  ownerA = await signUp(app, { name: 'Owner A', email: 'a@alpha.test', business: 'Alpha Glow' });
  ownerB = await signUp(app, { name: 'Owner B', email: 'b@beta.test', business: 'Beta Bakes' });
  [A, B] = await Promise.all(['Alpha Glow', 'Beta Bakes'].map(async (n) => (await pool.query('SELECT id FROM businesses WHERE name = $1', [n])).rows[0].id));
  const { rows: [s] } = await pool.query("INSERT INTO users (email, password_hash, name, email_verified_at) VALUES ('staff@alpha.test', $1, 'Staff', now()) RETURNING id", [await hashPassword('correct-horse-battery')]);
  await pool.query("INSERT INTO business_members (business_id, user_id, role) VALUES ($1, $2, 'staff')", [A, s.id]);
  staffA = request.agent(app); const c = await csrfToken(staffA, '/login');
  await staffA.post('/login').type('form').send({ _csrf: c, email: 'staff@alpha.test', password: 'correct-horse-battery' }).expect(302);
});
after(async () => { app.close(); metaServer.close(); aiServer.close(); await pool.end(); await off.pool.end(); });

describe('onboarding and Meta connection', () => {
  test('the owner saves a short advertising profile', async () => {
    const r = await post(ownerA, `${mb(A)}/profile`, { industry: 'Skincare', website: 'https://alpha.test', offer: 'Glow serum', locations: 'Lagos', audience: 'Women 25-45', goals: 'Purchases', daily_budget: '10,000', brand_voice: 'Warm' });
    assert.equal(r.headers.location, `${mb(A)}?tab=settings&done=profile`);
    const { rows: [p] } = await pool.query('SELECT industry, daily_budget_minor FROM ad_profiles WHERE business_id = $1', [A]);
    assert.deepEqual([p.industry, Number(p.daily_budget_minor)], ['Skincare', 1000000]);
  });

  test('a bad token or another business\'s ad account is refused and nothing is stored', async () => {
    assert.equal((await post(ownerA, `${mb(A)}/connect`, { ad_account_id: 'act_111111111', token: `bad0${'x'.repeat(40)}` })).status, 400);
    const r = await post(ownerA, `${mb(A)}/connect`, { ad_account_id: '222222222', token: TOK_A });
    assert.equal(r.status, 400);
    assert.match(r.text, /permission/);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM ad_connections')).rows[0].n, 0);
  });

  test('each business connects ITS OWN account: verified with Meta, Page and pixel found, token encrypted and never shown', async () => {
    assert.equal((await post(ownerA, `${mb(A)}/connect`, { ad_account_id: 'act_111111111', token: TOK_A })).headers.location, `${mb(A)}?tab=settings&done=connected`);
    assert.equal((await post(ownerB, `${mb(B)}/connect`, { ad_account_id: '222222222', token: TOK_B })).status, 302);
    const { rows } = await pool.query('SELECT business_id, ad_account_id, page_id, pixel_id, token_enc, token_hint, status FROM ad_connections ORDER BY business_id');
    assert.deepEqual(rows.map((r) => [Number(r.business_id), r.ad_account_id, r.page_id, r.pixel_id, r.status]), [[Number(A), '111111111', 'page111111111', 'px111111111', 'verified'], [Number(B), '222222222', 'page222222222', 'px222222222', 'verified']]);
    for (const r of rows) { assert.ok(r.token_enc.startsWith('v1.') && !r.token_enc.includes('tok')); }
    const page = await ownerA.get(`${mb(A)}?tab=settings`).expect(200);
    assert.match(page.text, /Verified with Meta/);
    assert.ok(!page.text.includes(TOK_A) && !page.text.includes(TOK_A.slice(0, 20)), 'token not shown');
  });
});

describe('dashboard, Cloudy and approvals', () => {
  test('the overview shows this account\'s live numbers (spend, results, CPA, ROAS) and flags spend without results', async () => {
    meta.calls.length = 0;
    await ownerB.get(mb(B)).expect(200);
    const r = await ownerA.get(mb(A)).expect(200);
    assert.match(r.text, /NGN 50,000/); assert.match(r.text, /3\.6×/); assert.match(r.text, /Waste campaign/);
    const camp = await ownerA.get(`${mb(A)}?tab=campaigns`).expect(200);
    assert.match(camp.text, /UGC video 1/); assert.match(camp.text, /Lagos women 25-45/);
    assert.ok(meta.calls.filter((c) => c.path.startsWith('/act_')).every((c) => (c.path.includes('111111111') ? c.token === 'tokA' : c.token === 'tokB')), 'each account read with its own business\'s token');
  });

  test('a question to Cloudy is answered from THIS business\'s data only, and saved for this business only', async () => {
    ai.requests.length = 0;
    const r = await post(ownerA, `${mb(A)}/ask`, { question: 'What is wasting my budget?' });
    assert.equal(r.status, 200);
    assert.match(r.text, /Waste campaign spent NGN 20,000/);
    const sent = JSON.stringify(ai.requests[0].body);
    assert.match(sent, /Alpha Glow/); assert.match(sent, /Skincare/); assert.match(sent, /111111111/);
    assert.doesNotMatch(sent, /Beta Bakes|222222222|tokA|tokB/);
    assert.match(ai.requests[0].body.system, /Never invent metrics/);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM ad_messages WHERE business_id = $1', [A])).rows[0].n, 2);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM ad_messages WHERE business_id = $1', [B])).rows[0].n, 0);
    assert.doesNotMatch((await ownerB.get(mb(B))).text, /Waste campaign spent NGN 20,000/);
  });

  test('creative briefs (hook, script, scenes, CTA) are saved for this business; audits and reports are done in Performance Analysis (no duplicate AI)', async () => {
    const r = await post(ownerA, `${mb(A)}/generate/briefs`);
    assert.match(r.headers.location, new RegExp(`^${mb(A)}/items/\\d+$`));
    const page = await ownerA.get(r.headers.location).expect(200);
    assert.match(page.text, /7 days, one serum/); assert.match(page.text, /Close-up/); assert.match(page.text, /Shop now/);
    const n = (await pool.query('SELECT count(*)::int AS n FROM ad_items WHERE business_id = $1', [A])).rows[0].n;
    for (const task of ['audit', 'report_weekly']) {
      const x = await post(ownerA, `${mb(A)}/generate/${task}`);
      assert.equal(x.status, 409); assert.match(x.text, /Performance Analysis tab/);
    }
    const { rows } = await pool.query('SELECT kind, data_basis FROM ad_items WHERE business_id = $1 ORDER BY id', [A]);
    assert.equal(rows.length, n); assert.deepEqual(rows.map((x) => x.kind), ['brief']);
    assert.match(rows[0].data_basis, /Meta account 111111111/);
  });

  test('draft-first: a campaign draft waits for approval; approving creates a PAUSED shell in the business\'s own account only', async () => {
    const r = await post(ownerA, `${mb(A)}/generate/campaign_draft`);
    const itemUrl = r.headers.location;
    assert.equal(meta.created.length, 0, 'nothing created before approval');
    const approvals = await ownerA.get(`${mb(A)}?tab=approvals`).expect(200);
    assert.match(approvals.text, /Campaign draft: Glow serum sales test/);
    // Staff cannot open the media buyer, let alone approve.
    assert.equal((await staffA.get(itemUrl)).status, 403);
    assert.equal((await post(staffA, `${itemUrl}/approve`)).status, 403);
    // Another business cannot approve it.
    const _csrf = await csrfToken(ownerB, `/businesses/${B}/subscription`);
    assert.equal((await ownerB.post(`${itemUrl}/approve`).type('form').send({ _csrf })).status, 404);
    assert.equal(meta.created.length, 0);
    const ok = await post(ownerA, `${itemUrl}/approve`);
    assert.equal(ok.headers.location, `${itemUrl}?done=approved`);
    assert.equal(meta.created.length, 1);
    assert.deepEqual([meta.created[0].act, meta.created[0].status, meta.created[0].objective], ['111111111', 'PAUSED', 'OUTCOME_SALES']);
    assert.ok(!meta.calls.some((c) => /adsets|\/ads$/.test(c.path) && c.method === 'POST'), 'no ad set or ad created');
    const page = await ownerA.get(itemUrl).expect(200);
    assert.match(page.text, /Meta reports its status as <strong>PAUSED/);
    // Approving again does nothing more.
    await post(ownerA, `${itemUrl}/approve`);
    assert.equal(meta.created.length, 1);
  });

  test('rejecting a draft changes nothing in Meta', async () => {
    const r = await post(ownerA, `${mb(A)}/generate/campaign_draft`);
    await post(ownerA, `${r.headers.location}/reject`);
    assert.equal(meta.created.length, 1);
    assert.equal((await pool.query("SELECT status FROM ad_items WHERE business_id = $1 ORDER BY id DESC LIMIT 1", [A])).rows[0].status, 'rejected');
  });
});

describe('several ad accounts per business', () => {
  test('a second account is added (not replaced); the first stays selected; the list shows both, tokens never shown', async () => {
    assert.equal((await post(ownerA, `${mb(A)}/connect`, { ad_account_id: '333333333', token: TOK_A })).status, 302);
    const { rows } = await pool.query('SELECT ad_account_id, selected FROM ad_connections WHERE business_id = $1 ORDER BY created_at', [A]);
    assert.deepEqual(rows.map((r) => [r.ad_account_id, r.selected]), [['111111111', true], ['333333333', false]]);
    const page = await ownerA.get(`${mb(A)}?tab=settings`).expect(200);
    assert.match(page.text, /Alpha Ads/); assert.match(page.text, /Alpha Abuja Ads/); assert.match(page.text, /data-account-switcher/);
    assert.ok(!page.text.includes(TOK_A.slice(0, 20)));
    // Business B still has only its own account, and cannot see A's.
    const b = await ownerB.get(`${mb(B)}?tab=settings`).expect(200);
    assert.doesNotMatch(b.text, /Alpha|333333333|111111111/);
  });

  test('switching the account: numbers, Cloudy and new drafts all use the selected account only', async () => {
    let r = await post(ownerA, `${mb(A)}/accounts/select`, { account: '333333333', tab: 'overview' });
    assert.equal(r.headers.location, `${mb(A)}?tab=overview&done=selected`);
    meta.calls.length = 0;
    await ownerA.get(mb(A)).expect(200);
    assert.ok(meta.calls.length && meta.calls.every((c) => !c.path.startsWith('/act_') || c.path.startsWith('/act_333333333')), 'only the selected account is read');
    ai.requests.length = 0;
    r = await post(ownerA, `${mb(A)}/generate/campaign_draft`);
    const data = JSON.parse(ai.requests[0].body.system.split('BUSINESS DATA (JSON, this business only):\n')[1]);
    assert.equal(data.selected_ad_account.id, '333333333');
    assert.equal(data.meta_ads.last_7_days.account.id, '333333333');
    assert.deepEqual(data.other_connected_ad_accounts, [{ id: '111111111', name: 'Alpha Ads' }], 'the other account by name only, no numbers');
    const itemId = r.headers.location.split('/').pop();
    assert.equal((await pool.query('SELECT ad_account_id FROM ad_items WHERE id = $1', [itemId])).rows[0].ad_account_id, '333333333');
    // Switch back to the first account: approving the draft still creates it in 333333333 (the account it was made for).
    await post(ownerA, `${mb(A)}/accounts/111111111/select`);
    const before = meta.created.length;
    await post(ownerA, `${mb(A)}/items/${itemId}/approve`);
    assert.equal(meta.created.length, before + 1);
    assert.deepEqual([meta.created.at(-1).act, meta.created.at(-1).status], ['333333333', 'PAUSED']);
    assert.match((await ownerA.get(`${mb(A)}/items/${itemId}`)).text, /act_333333333/);
  });

  test('a draft for an account that was disconnected is refused, nothing is created; only the owner can disconnect', async () => {
    await post(ownerA, `${mb(A)}/accounts/333333333/select`);
    const r = await post(ownerA, `${mb(A)}/generate/campaign_draft`);
    const itemId = r.headers.location.split('/').pop();
    // A manager may use the media buyer but not disconnect accounts.
    const { rows: [m] } = await pool.query("INSERT INTO users (email, password_hash, name, email_verified_at) VALUES ('manager@alpha.test', $1, 'Manager', now()) RETURNING id", [await hashPassword('correct-horse-battery')]);
    await pool.query("INSERT INTO business_members (business_id, user_id, role) VALUES ($1, $2, 'manager')", [A, m.id]);
    const manager = request.agent(app); const c = await csrfToken(manager, '/login');
    await manager.post('/login').type('form').send({ _csrf: c, email: 'manager@alpha.test', password: 'correct-horse-battery' }).expect(302);
    assert.equal((await post(manager, `${mb(A)}/accounts/333333333/disconnect`)).status, 403);
    // Another business cannot select or disconnect A's account.
    assert.equal((await post(ownerB, `${mb(B)}/accounts/333333333/select`)).status, 404);
    const bToken = await csrfToken(ownerB, `/businesses/${B}/subscription`);
    assert.equal((await ownerB.post(`${mb(A)}/accounts/333333333/disconnect`).type('form').send({ _csrf: bToken })).status, 404);
    assert.equal((await post(ownerA, `${mb(A)}/accounts/333333333/disconnect`)).headers.location, `${mb(A)}?tab=settings&done=disconnected`);
    const { rows } = await pool.query('SELECT ad_account_id, selected FROM ad_connections WHERE business_id = $1', [A]);
    assert.deepEqual(rows.map((x) => [x.ad_account_id, x.selected]), [['111111111', true]], 'the remaining account becomes selected');
    const before = meta.created.length;
    const ok = await post(ownerA, `${mb(A)}/items/${itemId}/approve`);
    assert.equal(ok.status, 409);
    assert.match(ok.text, /no longer connected to this business/);
    assert.equal(meta.created.length, before, 'nothing created in the other account');
  });
});

describe('creative library', () => {
  const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
  test('upload, view (own business only), AI review with the image; another business gets 404', async () => {
    const _csrf = await csrfToken(ownerA, `${mb(A)}?tab=creatives`);
    const up = await ownerA.post(`${mb(A)}/creatives`).field('_csrf', _csrf).field('kind', 'image').field('notes', 'hero shot').attach('file', png, { filename: 'hero.png', contentType: 'image/png' });
    assert.equal(up.headers.location, `${mb(A)}?tab=creatives&done=uploaded`);
    const { rows: [c] } = await pool.query('SELECT id FROM ad_creatives WHERE business_id = $1', [A]);
    const file = await ownerA.get(`${mb(A)}/creatives/${c.id}/file`).expect(200);
    assert.equal(file.headers['content-type'], 'image/png');
    assert.equal((await ownerB.get(`${mb(A)}/creatives/${c.id}/file`)).status, 404);
    assert.equal((await ownerB.get(`${mb(B)}/creatives/${c.id}/file`)).status, 404);
    ai.requests.length = 0;
    await post(ownerA, `${mb(A)}/creatives/${c.id}/review`);
    assert.equal(ai.requests[0].body.messages[0].content[0].type, 'image');
    assert.ok((await pool.query('SELECT ai_review FROM ad_creatives WHERE id = $1', [c.id])).rows[0].ai_review);
  });
  test('a file of an unsupported type is refused', async () => {
    const _csrf = await csrfToken(ownerA, `${mb(A)}?tab=creatives`);
    const r = await ownerA.post(`${mb(A)}/creatives`).field('_csrf', _csrf).attach('file', Buffer.from('MZ'), { filename: 'x.exe', contentType: 'application/x-msdownload' });
    assert.equal(r.status, 400);
  });
});

describe('without the AI key or a connection', () => {
  test('the pages work and say plainly that Cloudy is off; nothing is invented', async () => {
    const { rows: [u] } = await off.pool.query("SELECT 1"); assert.ok(u);
    const offApp = off.app;
    const agent = request.agent(offApp);
    // Reuse the same database: Owner A signs in on a server without the AI key.
    const _csrf = await csrfToken(agent, '/login');
    await agent.post('/login').type('form').send({ _csrf, email: 'a@alpha.test', password: 'correct-horse-battery' }).expect(302);
    const page = await agent.get(mb(A)).expect(200);
    assert.match(page.text, /data-ai-off/);
    const c2 = await csrfToken(agent, mb(A));
    const r = await agent.post(`${mb(A)}/ask`).type('form').send({ _csrf: c2, question: 'How are my ads?' });
    assert.equal(r.status, 409);
    assert.match(r.text, /not switched on/);
  });
});
