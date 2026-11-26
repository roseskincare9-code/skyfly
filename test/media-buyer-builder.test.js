// AI Media Buyer onboarding and campaign builds, against a stand-in Meta Marketing API that keeps object state
// and a stand-in OpenAI: connection health (permissions, Page, Instagram, pixel, account status), the
// conversational onboarding (saved, resumable, asks only what is missing) and the automatic analysis → plan
// workflow it starts, plan validation and editing, the full build (campaign → ad set → image → creative → ad)
// ALL PAUSED with read-back, resuming without duplicates (after a refusal and after a lost reply), launch only
// with the exact authorised daily budget, the approved spending limit, scheduled AI reviews, and isolation.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { setup, resetDatabase, csrfToken, signUp, openClientSignup } from './helpers.js';
import { startAutoWorkflow } from '../src/services/mbOnboarding.js';
import { runAdMonitoring } from '../src/services/analyst.js';

const OPENAI_KEY = `sk-proj-${'b'.repeat(40)}`;
// ---------- stand-in Meta (state)
const meta = { calls: [], objects: {}, seq: 1000, failNext: {}, loseNext: {}, accountStatus: 1, permissions: { ads_read: 'granted', ads_management: 'granted', pages_show_list: 'granted' } };
const metaServer = createServer(async (req, res) => {
  let raw = ''; for await (const c of req) raw += c;
  const u = new URL(req.url, 'http://x'); const token = (u.searchParams.get('access_token') ?? '').slice(0, 4); const p = u.pathname.replace(/^\/v\d+\.\d+/, '');
  const body = raw ? JSON.parse(raw) : null;
  meta.calls.push({ method: req.method, path: p, token, body, filtering: u.searchParams.get('filtering') });
  const send = (o, s = 200) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  const allowed = { tokA: '111111111', tokB: '222222222' }[token];
  if (!allowed) return send({ error: { message: 'Invalid OAuth access token.', code: 190 } }, 401);
  if (p === '/me/permissions') return send({ data: Object.entries(meta.permissions).map(([permission, status]) => ({ permission, status })) });
  if (p === '/search') return send({ data: u.searchParams.get('q') === 'Atlantis' ? [] : [{ key: `city-${u.searchParams.get('q')}`, name: u.searchParams.get('q'), type: 'city', country_code: u.searchParams.get('country_code') }] });
  const obj = /^\/(\d+)$/.exec(p);
  if (obj) {
    const o = meta.objects[obj[1]];
    if (!o || o.account !== allowed) return send({ error: { message: 'Unsupported get request', code: 100 } }, 400);
    if (req.method === 'POST' && meta.failStatus === o.edge) { delete meta.failStatus; return send({ error: { message: 'Ad set is not ready', code: 100 } }, 400); }
    if (req.method === 'POST') { o.status = body.status; o.effective_status = body.status === 'ACTIVE' ? 'PENDING_REVIEW' : body.status; return send({ success: true }); }
    return send({ id: o.id, name: o.name, status: o.status, effective_status: o.effective_status });
  }
  const m = /^\/act_(\d+)(\/[a-z_]+)?$/.exec(p);
  if (!m || m[1] !== allowed) return send({ error: { message: '(#200) no permission', code: 200 } }, 403);
  const act = m[1]; const edge = m[2]?.slice(1);
  if (!edge) return send({ id: `act_${act}`, name: `Account ${act}`, currency: 'NGN', account_status: meta.accountStatus, disable_reason: 0, timezone_name: 'Africa/Lagos' });
  if (edge === 'promote_pages') return send({ data: [{ id: `page${act}`, name: 'Glow Page', instagram_business_account: { id: `ig${act}`, username: 'glowng' } }] });
  if (edge === 'adspixels') return send({ data: [{ id: `px${act}`, name: 'Glow pixel', last_fired_time: new Date().toISOString() }] });
  if (edge === 'insights') return send({ data: [] });
  if (req.method === 'POST' && ['campaigns', 'adsets', 'adimages', 'adcreatives', 'ads'].includes(edge)) {
    if (meta.failNext[edge]) { delete meta.failNext[edge]; return send({ error: { message: 'Invalid parameter', error_user_msg: 'The link is not valid', code: 100 } }, 400); }
    if (edge === 'adimages') return send({ images: { bytes: { hash: `hash${body.bytes.length}` } } });
    const id = String(meta.seq++);
    meta.objects[id] = { id, edge, account: act, name: body.name, status: body.status ?? null, effective_status: body.status ?? null, body };
    if (meta.loseNext[edge]) { delete meta.loseNext[edge]; return send({ error: { message: 'Service temporarily unavailable', code: 2 } }, 500); } // created, but the reply is lost
    return send({ id });
  }
  if (req.method === 'GET' && ['campaigns', 'adsets', 'ads', 'adcreatives'].includes(edge)) {
    return send({ data: Object.values(meta.objects).filter((o) => o.edge === edge && o.account === act).map((o) => ({ id: o.id, name: o.name, effective_status: o.effective_status })) });
  }
  send({ error: { message: `not mocked ${p}` } }, 404);
});
const posts = (edge) => meta.calls.filter((c) => c.method === 'POST' && c.path.endsWith(`/${edge}`));

// ---------- stand-in OpenAI
const ai = { requests: [], planCreative: null };
const dataOf = (input) => JSON.parse(input.slice(input.indexOf('<campaign_data>\n') + 16, input.lastIndexOf('\n</campaign_data>')));
const analysisAnswer = { summary: 'New account: not enough data yet.', data_quality: { sufficiency: 'insufficient', notes: [] }, working: [], not_working: [], campaigns_needing_attention: [], winning_ads: [], weak_ads: [], tracking_concerns: [], recommendations: [], priority_actions: ['Launch a first test'] };
const planOf = (d) => ({
  name: 'Glow serum first test', objective: 'OUTCOME_SALES', conversion_event: 'PURCHASE', rationale: `Sells ${d.products[0]?.name ?? 'the serum'} in Lagos`, why_this_structure: 'One ad set: small budget',
  destination_url: 'https://glow.test/serum', duration_days: 7, testing_strategy: 'Two angles', optimization_strategy: 'Keep the cheaper angle',
  ad_sets: [{ name: 'Lagos women', audience_hypothesis: 'Women who buy skincare online', daily_budget: 8000, country: 'NG', cities: ['Lagos'], age_min: 25, age_max: 45, gender: 'women', advantage_audience: false,
    ads: [{ name: 'Before/after', angle: 'Results', creative_id: ai.planCreative ?? (d.creative_library[0]?.id ?? ''), creative_brief: 'Serum bottle on a vanity', primary_text: 'Glow serum ₦15,000. Lagos delivery.', headline: 'Glow in 7 days', description: 'Pay on delivery', call_to_action: 'SHOP_NOW' }] }],
});
const openaiServer = createServer(async (req, res) => {
  let raw = ''; for await (const c of req) raw += c;
  const body = JSON.parse(raw); ai.requests.push(body);
  const name = body.text.format.name; const d = dataOf(body.input);
  let json;
  if (name === 'onboarding_turn') {
    // Turns "field=value; field=value" into updates; asks for what Skyfly says is still missing.
    const updates = d.owner_message.split(';').map((x) => x.split('=')).filter((x) => x.length === 2).map(([field, value]) => ({ field: field.trim(), value: value.trim() }));
    json = { reply: `Thanks! Still needed: ${d.still_missing.slice(0, 2).join(', ') || 'nothing'}.`, updates };
  } else if (name === 'campaign_plan') json = planOf(d);
  else json = analysisAnswer;
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ status: 'completed', usage: { input_tokens: 10, output_tokens: 10 }, output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(json) }] }] }));
});
await Promise.all([metaServer, openaiServer].map((s) => new Promise((r) => s.listen(0, r))));

const encryptionKey = randomBytes(32);
const base = { metaGraphBase: `http://127.0.0.1:${metaServer.address().port}/v26.0`, encryptionKey };
const { pool, app: expressApp, config } = setup({ ...base, analyst: { apiKey: OPENAI_KEY, model: 'gpt-test', apiBase: `http://127.0.0.1:${openaiServer.address().port}`, timeoutMs: 3000, dailyLimit: 50 } });
const noAi = setup(base);
const app = expressApp.listen(0); const app2 = noAi.app.listen(0);
let ownerA; let ownerB; let A; let B;
const TOK = (t) => `${t}${'z'.repeat(40)}`;
const post = async (agent, path, form = {}) => { const _csrf = await csrfToken(agent, `/businesses/${path.match(/\/businesses\/(\d+)/)[1]}/subscription`); return agent.post(path).type('form').send({ _csrf, ...form }); };
const mb = (biz) => `/businesses/${biz}/media-buyer`;
const idOf = (r) => r.headers.location.split('/').pop().split('?')[0];
const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
const auto = async () => { await startAutoWorkflow.last; };

before(async () => {
  await resetDatabase(pool);
  await signUp(app, { name: 'Founder', email: 'founder@skyfly.test' });
  await openClientSignup(pool);
  ownerA = await signUp(app, { name: 'Owner A', email: 'a@glow.test', business: 'Glow Lagos' });
  ownerB = await signUp(app, { name: 'Owner B', email: 'b@other.test', business: 'Other Shop' });
  [A, B] = await Promise.all(['Glow Lagos', 'Other Shop'].map(async (n) => (await pool.query('SELECT id FROM businesses WHERE name = $1', [n])).rows[0].id));
  await pool.query("INSERT INTO products (business_id, code, name, price_minor) VALUES ($1, 'serum', 'Glow serum', 1500000)", [A]);
});
after(async () => { app.close(); app2.close(); [metaServer, openaiServer].forEach((s) => s.close()); await pool.end(); await noAi.pool.end(); });

describe('onboarding', () => {
  test('without an AI key the overview points to the profile form; the checklist shows what is missing', async () => {
    const agent = request.agent(app2);
    const _csrf = await csrfToken(agent, '/login');
    await agent.post('/login').type('form').send({ _csrf, email: 'a@glow.test', password: 'correct-horse-battery' }).expect(302);
    const page = await agent.get(mb(A)).expect(200);
    assert.match(page.text, /data-getting-started/); assert.match(page.text, /data-onboarding-form-fallback/);
    assert.match(page.text, /missing: Business category/);
    assert.doesNotMatch(page.text, /missing: [^<]*Prices/, 'prices are known from Products');
  });

  test('the conversation saves what the owner says, asks only for what is missing, and is kept separate from Ask', async () => {
    let r = await post(ownerA, `${mb(A)}/onboarding/message`, { message: 'industry=Skincare; business_location=Lekki, Lagos; offer=Glow serum; daily_budget=10,000' });
    assert.match(r.headers.location, /done=onboarding/);
    const { rows: [p] } = await pool.query('SELECT industry, business_location, offer, daily_budget_minor FROM ad_profiles WHERE business_id = $1', [A]);
    assert.deepEqual([p.industry, p.business_location, p.offer, Number(p.daily_budget_minor)], ['Skincare', 'Lekki, Lagos', 'Glow serum', 1000000]);
    const d = dataOf(ai.requests.at(-1).input);
    assert.ok(!d.still_missing.includes('Prices'), 'not asked: products have prices');
    assert.ok(d.still_missing.includes('Business category'), 'missing before this message');
    const page = await ownerA.get(mb(A)).expect(200);
    assert.match(page.text, /Still needed: /);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM ad_messages WHERE business_id = $1 AND topic = 'onboarding'", [A])).rows[0].n, 2);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM ad_messages WHERE business_id = $1 AND topic = 'ask'", [A])).rows[0].n, 0);
    // The next turn only asks for what is still missing.
    r = await post(ownerA, `${mb(A)}/onboarding/message`, { message: 'locations=Lagos; audience=Women 25-45' });
    const d2 = dataOf(ai.requests.at(-1).input);
    assert.ok(!d2.still_missing.includes('Business category'), 'not asked again');
    assert.equal((await pool.query('SELECT locations FROM ad_profiles WHERE business_id = $1', [A])).rows[0].locations, 'Lagos');
  });

  test('completing the profile starts the automatic workflow; without Meta it waits and says why', async () => {
    const r = await post(ownerA, `${mb(A)}/onboarding/message`, { message: 'goals=Online sales; website=https://glow.test; fulfilment=Lagos delivery in 48h; payment_methods=Pay on delivery' });
    assert.match(r.headers.location, /done=onboarded/);
    await auto();
    const { rows: [o] } = await pool.query('SELECT completed_at, auto_status, auto_detail FROM ad_onboarding WHERE business_id = $1', [A]);
    assert.ok(o.completed_at); assert.equal(o.auto_status, 'waiting'); assert.match(o.auto_detail, /Connect the Meta ad account/);
  });

  test('connecting Meta resumes it: health check → analysis → plan, without the owner asking', async () => {
    const _csrf = await csrfToken(ownerA, `${mb(A)}?tab=creatives`);
    await ownerA.post(`${mb(A)}/creatives`).field('_csrf', _csrf).field('kind', 'image').attach('file', png, { filename: 'serum.png', contentType: 'image/png' }).expect(302);
    assert.equal((await post(ownerA, `${mb(A)}/connect`, { ad_account_id: '111111111', token: TOK('tokA') })).status, 302);
    await auto();
    const { rows: [o] } = await pool.query('SELECT auto_status, analysis_id, plan_item_id FROM ad_onboarding WHERE business_id = $1', [A]);
    assert.equal(o.auto_status, 'done'); assert.ok(o.analysis_id); assert.ok(o.plan_item_id);
    const names = ai.requests.map((x) => x.text.format.name);
    assert.ok(names.includes('campaign_analysis') && names.includes('campaign_plan'));
    const { rows: [c] } = await pool.query('SELECT health FROM ad_connections WHERE business_id = $1', [A]);
    assert.equal(c.health.capabilities.build_drafts, true); assert.equal(c.health.capabilities.instagram, true);
    const page = await ownerA.get(mb(A)).expect(200);
    assert.match(page.text, /open the plan/); assert.match(page.text, /data-step-ok="true"/);
    assert.equal(posts('campaigns').length, 0, 'nothing created in Meta without approval');
  });
});

describe('connection health', () => {
  test('missing ads_management, no pixel or a disabled account are shown as problems; Check with Meta re-reads it', async () => {
    meta.permissions.ads_management = 'declined'; meta.accountStatus = 2;
    assert.equal((await post(ownerA, `${mb(A)}/accounts/111111111/health`)).status, 302);
    const page = await ownerA.get(`${mb(A)}?tab=settings`).expect(200);
    assert.match(page.text, /lacks ads_management/); assert.match(page.text, /The ad account is disabled/);
    meta.permissions.ads_management = 'granted'; meta.accountStatus = 1;
    await post(ownerA, `${mb(A)}/accounts/111111111/health`);
    assert.doesNotMatch((await ownerA.get(`${mb(A)}?tab=settings`)).text, /data-health-problem/);
    assert.equal((await post(ownerB, `${mb(B)}/accounts/111111111/health`)).status, 404);
  });
});

describe('plan → build (PAUSED) → launch', () => {
  let planId; let buildId;
  test('the plan shows objective, structure, budget, audience, copy, image and destination; a missing image blocks the build', async () => {
    ai.planCreative = '999999';
    await pool.query("UPDATE ad_analyses SET created_at = created_at - interval '2 minutes'");
    const r = await post(ownerA, `${mb(A)}/plan`);
    planId = idOf(r);
    const page = await ownerA.get(`${mb(A)}/items/${planId}`).expect(200);
    for (const s of ['Campaign plan', 'OUTCOME_SALES'.replace('OUTCOME_', ''), 'PURCHASE', 'https://glow.test/serum', 'Lagos women', 'Glow in 7 days', 'data-plan-errors', 'choose an image from the Creative Library']) assert.ok(page.text.includes(s), s);
    assert.match(page.text, /data-approve disabled/);
    const refused = await post(ownerA, `${mb(A)}/items/${planId}/approve`);
    assert.equal(refused.status, 400); assert.equal(posts('campaigns').length, 0);
  });

  test('editing the plan (image, budget) re-checks it', async () => {
    const { rows: [img] } = await pool.query('SELECT id FROM ad_creatives WHERE business_id = $1', [A]);
    assert.equal((await post(ownerA, `${mb(A)}/items/${planId}/plan`, { creative_id_0_0: String(img.id), budget_0: '9000' })).status, 302);
    const { rows: [it] } = await pool.query('SELECT body FROM ad_items WHERE id = $1', [planId]);
    assert.deepEqual(it.body.check.errors, []); assert.equal(it.body.plan.ad_sets[0].daily_budget, 9000);
    assert.equal((await post(ownerB, `${mb(B)}/items/${planId}/plan`, { budget_0: '1' })).status, 404);
  });

  test('a refusal from Meta stops the build; retry resumes without creating the campaign again', async () => {
    meta.failNext.adcreatives = true;
    const r = await post(ownerA, `${mb(A)}/items/${planId}/approve`);
    assert.match(r.headers.location, /done=build_failed/);
    const { rows: [b] } = await pool.query('SELECT * FROM ad_builds WHERE ad_item_id = $1', [planId]);
    buildId = b.id;
    assert.equal(b.status, 'failed'); assert.match(b.error, /The link is not valid/);
    assert.equal(b.steps.find((s) => s.key === 'campaign').status, 'done');
    assert.equal(b.steps.find((s) => s.key === 'creative:0:0').status, 'failed');
    assert.match((await ownerA.get(`${mb(A)}/items/${planId}`)).text, /data-retry/);
    assert.equal((await post(ownerA, `${mb(A)}/builds/${buildId}/retry`)).status, 302);
    assert.equal(posts('campaigns').length, 1, 'campaign not created twice');
    assert.equal(posts('adsets').length, 1, 'ad set not created twice');
  });

  test('every object is PAUSED and read back; targeting, budget, pixel event, Page/Instagram and link are as planned', async () => {
    const { rows: [b] } = await pool.query('SELECT * FROM ad_builds WHERE id = $1', [buildId]);
    assert.equal(b.status, 'built');
    assert.ok(b.launch_result.verify.every((v) => v.status === 'PAUSED'));
    const [c] = posts('campaigns'); const [s] = posts('adsets'); const [cr] = posts('adcreatives').slice(-1); const [ad] = posts('ads');
    assert.equal(c.body.status, 'PAUSED'); assert.equal(c.body.objective, 'OUTCOME_SALES');
    assert.equal(s.body.status, 'PAUSED'); assert.equal(s.body.daily_budget, '900000');
    assert.deepEqual(s.body.promoted_object, { pixel_id: 'px111111111', custom_event_type: 'PURCHASE' });
    assert.deepEqual(s.body.targeting.geo_locations.cities.map((x) => x.key), ['city-Lagos']);
    assert.deepEqual(s.body.targeting.genders, [2]);
    assert.equal(cr.body.object_story_spec.page_id, 'page111111111'); assert.equal(cr.body.object_story_spec.instagram_user_id, 'ig111111111');
    assert.equal(cr.body.object_story_spec.link_data.link, 'https://glow.test/serum');
    assert.equal(ad.body.status, 'PAUSED');
    assert.ok(meta.calls.every((x) => x.method !== 'POST' || !x.body?.status || x.body.status === 'PAUSED'), 'nothing activated by the build');
    const page = await ownerA.get(`${mb(A)}/items/${planId}`).expect(200);
    assert.match(page.text, /data-launch-panel/);
  });

  test('a lost reply from Meta (object created, answer lost) is reconciled by its tag: no duplicate', async () => {
    ai.planCreative = null;
    await pool.query("UPDATE ad_analyses SET created_at = created_at - interval '2 minutes'");
    const p2 = idOf(await post(ownerA, `${mb(A)}/plan`));
    meta.loseNext.adsets = true;
    const r = await post(ownerA, `${mb(A)}/items/${p2}/approve`);
    assert.match(r.headers.location, /done=build_failed/);
    const { rows: [b] } = await pool.query('SELECT id, steps FROM ad_builds WHERE ad_item_id = $1', [p2]);
    assert.equal(b.steps.find((s) => s.key === 'adset:0').status, 'unknown');
    const before = posts('adsets').length;
    await post(ownerA, `${mb(A)}/builds/${b.id}/retry`);
    const { rows: [after2] } = await pool.query('SELECT status, steps FROM ad_builds WHERE id = $1', [b.id]);
    assert.equal(after2.status, 'built');
    assert.equal(posts('adsets').length, before, 'the ad set was not created again');
    assert.equal(after2.steps.find((s) => s.key === 'adset:0').reconciled, true);
    await post(ownerA, `${mb(A)}/items/${p2}/reject`);
  });

  test('launch needs the exact daily budget and LAUNCH; another business cannot launch it; Meta\'s real status is shown', async () => {
    let r = await post(ownerA, `${mb(A)}/builds/${buildId}/launch`, { authorised_daily: '5000', confirm: 'LAUNCH' });
    assert.match(r.headers.location, /launch_error=/);
    r = await post(ownerA, `${mb(A)}/builds/${buildId}/launch`, { authorised_daily: '9000', confirm: 'yes' });
    assert.match(r.headers.location, /launch_error=/);
    assert.equal((await post(ownerB, `${mb(B)}/builds/${buildId}/launch`, { authorised_daily: '9000', confirm: 'LAUNCH' })).status, 404);
    meta.accountStatus = 2;
    r = await post(ownerA, `${mb(A)}/builds/${buildId}/launch`, { authorised_daily: '9000', confirm: 'LAUNCH' });
    assert.match(decodeURIComponent(r.headers.location), /disabled/);
    meta.accountStatus = 1;
    assert.ok(!meta.calls.some((x) => x.body?.status === 'ACTIVE'), 'nothing activated so far');
    // Meta refuses part of the launch: the build is launch_failed, the campaign was NOT activated (it goes last),
    // no limit is granted, and the owner can try again with the same authorisation.
    meta.failStatus = 'adsets';
    r = await post(ownerA, `${mb(A)}/builds/${buildId}/launch`, { authorised_daily: '9000', confirm: 'LAUNCH' });
    assert.match(r.headers.location, /done=launch_failed/);
    const failedPage = await ownerA.get(r.headers.location).expect(200);
    assert.match(failedPage.text, /data-launch-panel/); assert.match(failedPage.text, /Try the launch again/);
    assert.ok(!meta.calls.some((x) => x.body?.status === 'ACTIVE' && meta.objects[x.path.slice(1)].edge === 'campaigns'), 'campaign not activated');
    assert.equal((await pool.query('SELECT approved_daily_limit_minor FROM ad_profiles WHERE business_id = $1', [A])).rows[0].approved_daily_limit_minor, null);
    meta.calls.length = 0;
    r = await post(ownerA, `${mb(A)}/builds/${buildId}/launch`, { authorised_daily: '9,000', confirm: 'launch' });
    assert.match(r.headers.location, /done=launched/);
    const activations = meta.calls.filter((x) => x.body?.status === 'ACTIVE').map((x) => meta.objects[x.path.slice(1)].edge);
    assert.deepEqual(activations, ['ads', 'adsets', 'campaigns'], 'ads, then ad sets, then the campaign');
    const page = await ownerA.get(r.headers.location).expect(200);
    assert.match(page.text, /PENDING_REVIEW/); assert.match(page.text, /not delivering yet/);
    assert.equal(Number((await pool.query('SELECT approved_daily_limit_minor FROM ad_profiles WHERE business_id = $1', [A])).rows[0].approved_daily_limit_minor), 900000);
    r = await post(ownerA, `${mb(A)}/builds/${buildId}/launch`, { authorised_daily: '9000', confirm: 'LAUNCH' });
    assert.match(decodeURIComponent(r.headers.location), /already launched/);
    assert.match((await ownerA.get(`${mb(A)}?tab=approvals`)).text, /data-builds/);
  });

  test('another business sees none of it', async () => {
    await ownerB.get(`${mb(B)}/items/${planId}`).expect(404);
    const page = await ownerB.get(`${mb(B)}?tab=approvals`).expect(200);
    assert.doesNotMatch(page.text, /Glow serum first test/);
    assert.equal((await post(ownerB, `${mb(B)}/builds/${buildId}/retry`)).status, 404);
  });
});

describe('continuous media buying', () => {
  test('scheduled AI review runs when due (and not again until the next due date); it only recommends', async () => {
    await post(ownerA, `${mb(A)}/monitoring`, { enabled: 'on', interval_hours: '6' });
    await pool.query("UPDATE ad_monitor_settings SET ai_review_days = 1, ai_engine = 'chatgpt' WHERE business_id = $1", [A]);
    await pool.query("UPDATE ad_analyses SET created_at = created_at - interval '2 minutes'");
    const n = ai.requests.length; const writes = meta.calls.filter((x) => x.method === 'POST').length;
    await runAdMonitoring(pool, config);
    assert.equal(ai.requests.length, n + 1);
    assert.ok((await pool.query('SELECT last_ai_review_at FROM ad_monitor_settings WHERE business_id = $1', [A])).rows[0].last_ai_review_at);
    await pool.query("UPDATE ad_monitor_settings SET last_run_at = now() - interval '7 hours' WHERE business_id = $1", [A]);
    await runAdMonitoring(pool, config);
    assert.equal(ai.requests.length, n + 1, 'not due again');
    assert.equal(meta.calls.filter((x) => x.method === 'POST').length, writes, 'no change made in Meta');
  });
});
