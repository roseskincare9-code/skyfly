// ChatGPT performance analyst inside the AI Media Buyer, against stand-in Meta Marketing API, OpenAI
// Responses API and Anthropic servers (no real accounts, nothing published or spent):
// metrics computed by Skyfly, current vs previous period, date ranges, campaign and product scope, the
// structured answer (schema, grounding of every figure and entity), every failure path (bad key, rate
// limit, quota, timeout, server error, malformed / off-schema answer, refusal, cut-off), empty and
// low-data accounts, business and ad-account isolation, minimal data sent (no customer details), the
// key kept server-side, the approval boundary (nothing written to Meta), monitoring alerts, and the
// split of roles with Cloudy (no duplicate analysis).
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { setup, resetDatabase, csrfToken, signUp, openClientSignup } from './helpers.js';
import { windows, metricsOf, ANALYSIS_PERIODS } from '../src/services/metaAds.js';
import { signals, validResult, ground, runAdMonitoring, SCHEMA } from '../src/services/analyst.js';

const OPENAI_KEY = `sk-proj-${'k'.repeat(40)}`;
// ---------- stand-in Meta: tokA → act_111111111 + act_333333333, tokB → act_222222222, tokE → act_444444444 (empty)
const meta = { calls: [] };
const ACCOUNTS = { tokA: ['111111111', '333333333'], tokB: ['222222222'], tokE: ['444444444'] };
const ins = ({ spend, impressions, linkClicks, purchases = 0, value = 0, lpv = 0, frequency = 1.5, reach }) => ({
  spend: String(spend), impressions: String(impressions), reach: String(reach ?? Math.round(impressions / frequency)), frequency: String(frequency),
  clicks: String(linkClicks + 10), inline_link_clicks: String(linkClicks), ctr: String(((linkClicks + 10) / impressions) * 100),
  cpc: String(spend / (linkClicks + 10)), cpm: String((spend / impressions) * 1000),
  actions: [...(purchases ? [{ action_type: 'purchase', value: String(purchases) }] : []), ...(lpv ? [{ action_type: 'landing_page_view', value: String(lpv) }] : []), { action_type: 'link_click', value: String(linkClicks) }],
  action_values: value ? [{ action_type: 'purchase', value: String(value) }] : [],
});
// Account A (act_111111111): Winner (efficient), Waste (spends, no purchases, CTR down), New test (tiny).
const A_NOW = {
  c1: { campaign_id: '601', campaign_name: 'Winner campaign', ...ins({ spend: 18000, impressions: 20000, linkClicks: 400, purchases: 6, value: 54000, lpv: 300 }) },
  c2: { campaign_id: '602', campaign_name: 'Waste campaign', ...ins({ spend: 42000, impressions: 30000, linkClicks: 150, lpv: 120, frequency: 4.2 }) },
  c3: { campaign_id: '603', campaign_name: 'New test', ...ins({ spend: 500, impressions: 300, linkClicks: 4 }) },
};
const A_PREV = {
  c1: { campaign_id: '601', campaign_name: 'Winner campaign', ...ins({ spend: 15000, impressions: 18000, linkClicks: 420, purchases: 5, value: 45000, lpv: 310 }) },
  c2: { campaign_id: '602', campaign_name: 'Waste campaign', ...ins({ spend: 10000, impressions: 12000, linkClicks: 240, purchases: 1, value: 9000, lpv: 200 }) },
};
const sum = (rows) => {
  const t = { spend: 0, impressions: 0, linkClicks: 0, purchases: 0, value: 0, lpv: 0 };
  for (const r of rows) {
    t.spend += Number(r.spend); t.impressions += Number(r.impressions); t.linkClicks += Number(r.inline_link_clicks);
    t.purchases += Number(r.actions.find((a) => a.action_type === 'purchase')?.value ?? 0); t.value += Number(r.action_values[0]?.value ?? 0);
    t.lpv += Number(r.actions.find((a) => a.action_type === 'landing_page_view')?.value ?? 0);
  }
  return ins({ ...t, frequency: 2 });
};
const metaServer = createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x'); const token = (u.searchParams.get('access_token') ?? '').slice(0, 4); const p = u.pathname.replace(/^\/v\d+\.\d+/, '');
  const tr = u.searchParams.get('time_range') ? JSON.parse(u.searchParams.get('time_range')) : null;
  const filt = u.searchParams.get('filtering') ? JSON.parse(u.searchParams.get('filtering')) : null;
  meta.calls.push({ method: req.method, path: p, token, level: u.searchParams.get('level'), time_range: tr, filtering: filt });
  const send = (o, s = 200) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (req.method !== 'GET') return send({ error: { message: 'writes are not allowed in this test' } }, 405);
  const allowed = ACCOUNTS[token];
  if (!allowed) return send({ error: { message: 'Invalid OAuth access token.', code: 190 } }, 401);
  if (/^\/px\d+$/.test(p)) return send({ id: p.slice(1), last_fired_time: new Date(Date.now() - 3600000).toISOString(), is_unavailable: false });
  const m = /^\/act_(\d+)(\/[a-z_]+)?$/.exec(p);
  if (!m || !allowed.includes(m[1])) return send({ error: { message: '(#200) no permission', code: 200 } }, 403);
  const act = m[1];
  if (!m[2]) return send({ id: `act_${act}`, name: `Account ${act}`, currency: 'NGN', account_status: 1, timezone_name: 'Africa/Lagos' });
  if (m[2] === '/promote_pages') return send({ data: [{ id: `page${act}`, name: `Page ${act}` }] });
  if (m[2] === '/adspixels') return send({ data: [{ id: `px${act}`, name: `Pixel ${act}` }] });
  const only = filt?.[0]?.value ?? null;
  const keep = (rows, key = 'campaign_id') => (only ? rows.filter((r) => only.includes(r[key] ?? r.id)) : rows);
  if (act === '444444444') return send({ data: [] });
  if (act === '222222222') {
    const b = { campaign_id: '701', campaign_name: 'Beta bakery campaign', ...ins({ spend: 9000, impressions: 8000, linkClicks: 100, purchases: 3, value: 15000 }) };
    if (m[2] === '/campaigns') return send({ data: [{ id: '701', name: 'Beta bakery campaign', effective_status: 'ACTIVE', objective: 'OUTCOME_SALES', daily_budget: '300000' }] });
    if (m[2] === '/adsets' || m[2] === '/ads') return send({ data: [] });
    if (m[2] === '/insights') return send({ data: [u.searchParams.get('level') ? b : sum([b])] });
  }
  if (act === '333333333') {
    if (m[2] === '/insights') return send({ data: [] });
    return send({ data: m[2] === '/campaigns' ? [{ id: '901', name: 'Abuja launch', effective_status: 'PAUSED', objective: 'OUTCOME_SALES' }] : [] });
  }
  // The previous window of any preset (computed the same way the app does); custom ranges get current data.
  const current = !tr || !ANALYSIS_PERIODS.some((pp) => { const w = windows({ period: pp }, 'Africa/Lagos').previous; return w.since === tr.since && w.until === tr.until; });
  if (m[2] === '/campaigns') {
    return send({ data: keep([{ id: '601', name: 'Winner campaign', effective_status: 'ACTIVE', objective: 'OUTCOME_SALES', daily_budget: '500000' },
      { id: '602', name: 'Waste campaign', effective_status: 'ACTIVE', objective: 'OUTCOME_SALES', daily_budget: '600000' },
      { id: '603', name: 'New test', effective_status: 'ACTIVE', objective: 'OUTCOME_SALES', daily_budget: '100000' }]) });
  }
  if (m[2] === '/adsets') {
    return send({ data: keep([{ id: '611', name: 'Lagos women 25-45', campaign_id: '601', effective_status: 'ACTIVE', optimization_goal: 'OFFSITE_CONVERSIONS', targeting: { age_min: 25, age_max: 45, genders: [2], geo_locations: { cities: [{ key: '1', name: 'Lagos' }] } } },
      { id: '612', name: 'Broad Nigeria', campaign_id: '602', effective_status: 'ACTIVE', optimization_goal: 'OFFSITE_CONVERSIONS', targeting: { geo_locations: { countries: ['NG'] } } }]) });
  }
  if (m[2] === '/ads') {
    return send({ data: keep([{ id: '621', name: 'UGC video 1', adset_id: '611', campaign_id: '601', effective_status: 'ACTIVE', creative: { title: 'Glow in 7 days', body: 'Real results', object_type: 'VIDEO', call_to_action_type: 'SHOP_NOW' } },
      { id: '622', name: 'Static banner', adset_id: '612', campaign_id: '602', effective_status: 'ACTIVE', creative: { title: 'Sale', body: 'Buy now', object_type: 'SHARE' } }]) });
  }
  if (m[2] === '/insights') {
    const level = u.searchParams.get('level');
    const set = current ? A_NOW : A_PREV;
    const camps = keep(Object.values(set));
    if (level === 'campaign') return send({ data: camps });
    if (level === 'adset') return send({ data: keep([{ ...A_NOW.c1, adset_id: '611', adset_name: 'Lagos women 25-45', frequency: '1.8' }, { ...A_NOW.c2, adset_id: '612', adset_name: 'Broad Nigeria', frequency: '4.2' }]) });
    if (level === 'ad') return send({ data: keep([{ ...A_NOW.c1, adset_id: '611', ad_id: '621', ad_name: 'UGC video 1' }, { ...A_NOW.c2, adset_id: '612', ad_id: '622', ad_name: 'Static banner' }]) });
    return send({ data: [sum(camps)] });
  }
  send({ error: { message: 'not mocked' } }, 404);
});

// ---------- stand-in OpenAI Responses API
const openai = { mode: 'ok', requests: [], failuresLeft: 0 };
const dataOf = (input) => JSON.parse(input.slice(input.indexOf('<campaign_data>\n') + 16, input.lastIndexOf('\n</campaign_data>')));
function goodAnswer(d) {
  const c = Object.fromEntries(d.campaigns.map((x) => [x.name, x]));
  const w = c['Winner campaign']; const waste = c['Waste campaign'];
  const f = (x, obs, metrics, ev = 'statistical') => ({ entity_level: 'campaign', entity_id: x.id, entity_name: x.name, observation: obs, metrics, evidence: ev });
  const rec = (x, action, category, metrics, extra = {}) => ({ priority: 1, category, action, entity_level: 'campaign', entity_id: x.id, entity_name: x.name, observed: `${x.name} result`,
    supporting_metrics: metrics, why_it_matters: 'Budget efficiency', recommended_action: `${action} on ${x.name}`, expected_objective: 'Lower blended CPA', confidence: 'medium', risks: 'Small sample', needs_more_data: false, evidence: 'statistical', ...extra });
  if (!w) return { summary: 'Only limited data.', data_quality: { sufficiency: 'insufficient', notes: ['No campaigns with spend'] }, working: [], not_working: [], campaigns_needing_attention: [], winning_ads: [], weak_ads: [], tracking_concerns: [], recommendations: [], priority_actions: ['Wait for more data'] };
  return {
    summary: `Winner campaign spent NGN ${w.metrics.spend} for ${w.metrics.purchases} purchases (CPA NGN ${w.metrics.cpa}); Waste campaign spent NGN ${waste?.metrics?.spend} with no purchases.`,
    data_quality: { sufficiency: 'limited', notes: ['New test has too little data'] },
    working: [f(w, 'Efficient purchases', [{ name: 'CPA', value: `NGN ${w.metrics.cpa}` }, { name: 'Purchases', value: String(w.metrics.purchases) }])],
    not_working: waste ? [f(waste, 'Spend without purchases', [{ name: 'Spend', value: `NGN ${waste.metrics.spend.toLocaleString('en-US')}` }])] : [],
    campaigns_needing_attention: waste ? [f(waste, 'Review', [{ name: 'Frequency', value: String(waste.metrics.frequency) }])] : [],
    winning_ads: [{ entity_level: 'ad', entity_id: '621', entity_name: 'UGC video 1', observation: 'Best ad', metrics: [{ name: 'CPA', value: `${w.metrics.cpa}` }], evidence: 'statistical' }],
    weak_ads: [], tracking_concerns: [],
    recommendations: [
      ...(waste ? [rec(waste, 'pause', 'budget', [{ name: 'Spend', value: `NGN ${waste.metrics.spend}` }, { name: 'Purchases', value: '0' }])] : []),
      rec(w, 'increase_budget', 'budget', [{ name: 'CPA', value: `NGN ${w.metrics.cpa}` }], { priority: 2 }),
      rec(w, 'test_creative', 'creative', [{ name: 'Link CTR', value: `${w.metrics.link_ctr}%` }], { priority: 3 }),
      rec(w, 'test_audience', 'audience', [], { priority: 4, needs_more_data: true, confidence: 'low', evidence: 'speculation' }),
      rec(w, 'run_controlled_test', 'testing', [], { priority: 5 }),
    ],
    priority_actions: ['Review Waste campaign', 'Scale Winner campaign gradually'],
  };
}
const respond = (res, status, obj, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(obj)); };
const out = (o) => ({ id: 'resp', status: 'completed', output: [{ type: 'reasoning', summary: [] }, { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: typeof o === 'string' ? o : JSON.stringify(o) }] }] });
const openaiServer = createServer(async (req, res) => {
  let raw = ''; for await (const c of req) raw += c;
  const body = JSON.parse(raw); openai.requests.push({ auth: req.headers.authorization, path: req.url, body });
  const d = dataOf(body.input);
  if (openai.failuresLeft > 0) { openai.failuresLeft -= 1; return respond(res, openai.failStatus, { error: { message: 'temporary', code: openai.failCode ?? null } }); }
  switch (openai.mode) {
    case 'invalid_key': return respond(res, 401, { error: { message: 'Incorrect API key provided: sk-proj-****', code: 'invalid_api_key' } });
    case 'rate_limit': return respond(res, 429, { error: { message: 'Rate limit reached', code: 'rate_limit_exceeded' } }, { 'retry-after': '0' });
    case 'quota': return respond(res, 429, { error: { message: 'You exceeded your current quota', code: 'insufficient_quota' } });
    case 'timeout': await new Promise((r) => setTimeout(r, 800)); return respond(res, 200, out(goodAnswer(d)));
    case 'malformed': return respond(res, 200, out('Here is my analysis: everything is fine!'));
    case 'off_schema': { const g = goodAnswer(d); delete g.priority_actions; g.extra = 1; return respond(res, 200, out(g)); }
    case 'refusal': return respond(res, 200, { status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'I cannot help' }] }] });
    case 'incomplete': return respond(res, 200, { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [] });
    case 'invented': {
      const g = goodAnswer(d);
      g.recommendations.push({ ...g.recommendations[0], entity_id: '999999', entity_name: 'Ghost campaign', priority: 1 });
      g.working[0].metrics = [{ name: 'CPA', value: 'NGN 1,234.56' }];
      return respond(res, 200, out(g));
    }
    default: return respond(res, 200, out(goodAnswer(d)));
  }
});
// ---------- stand-in Anthropic (Cloudy)
const ai = { requests: [] };
const aiServer = createServer(async (req, res) => {
  let raw = ''; for await (const c of req) raw += c;
  ai.requests.push(JSON.parse(raw));
  respond(res, 200, { content: [{ type: 'text', text: '```json\n{"items":[{"title":"Brief"}]}\n```' }] });
});
await Promise.all([metaServer, openaiServer, aiServer].map((s) => new Promise((r) => s.listen(0, r))));

const encryptionKey = randomBytes(32);
const analystCfg = { apiKey: OPENAI_KEY, model: 'gpt-test-analyst', reasoningEffort: 'low', apiBase: `http://127.0.0.1:${openaiServer.address().port}`, timeoutMs: 400, dailyLimit: 30 };
const cloudyCfg = { apiKey: 'sk-ant-test', model: 'claude-test', apiBase: `http://127.0.0.1:${aiServer.address().port}` };
const { pool, app: expressApp, config } = setup({ metaGraphBase: `http://127.0.0.1:${metaServer.address().port}/v26.0`, encryptionKey, analyst: analystCfg, cloudy: cloudyCfg });
const noAnalyst = setup({ metaGraphBase: `http://127.0.0.1:${metaServer.address().port}/v26.0`, encryptionKey, cloudy: cloudyCfg });
const app = expressApp.listen(0);
const app2 = noAnalyst.app.listen(0);
let ownerA; let ownerB; let ownerE; let A; let B; let E; let productA; let productB;
const TOK = (t) => `${t}${'z'.repeat(40)}`;
const post = async (agent, path, form = {}) => { const _csrf = await csrfToken(agent, `/businesses/${path.match(/\/businesses\/(\d+)/)[1]}/subscription`); return agent.post(path).type('form').send({ _csrf, ...form }); };
const mb = (biz) => `/businesses/${biz}/media-buyer`;
const unblock = () => pool.query("UPDATE ad_analyses SET created_at = created_at - interval '2 minutes'");
const run = async (agent, biz, form = {}) => { await unblock(); return post(agent, `${mb(biz)}/analysis`, form); };
const lastRequestData = () => dataOf(openai.requests.at(-1).body.input);
const metaWrites = () => meta.calls.filter((c) => c.method !== 'GET');

before(async () => {
  await resetDatabase(pool);
  await signUp(app, { name: 'Founder', email: 'founder@skyfly.test' });
  await openClientSignup(pool);
  ownerA = await signUp(app, { name: 'Owner A', email: 'a@alpha.test', business: 'Alpha Glow' });
  ownerB = await signUp(app, { name: 'Owner B', email: 'b@beta.test', business: 'Beta Bakes' });
  ownerE = await signUp(app, { name: 'Owner E', email: 'e@empty.test', business: 'Empty Ads' });
  [A, B, E] = await Promise.all(['Alpha Glow', 'Beta Bakes', 'Empty Ads'].map(async (n) => (await pool.query('SELECT id FROM businesses WHERE name = $1', [n])).rows[0].id));
  for (const [agent, biz, act, t] of [[ownerA, A, '111111111', 'tokA'], [ownerA, A, '333333333', 'tokA'], [ownerB, B, '222222222', 'tokB'], [ownerE, E, '444444444', 'tokE']]) {
    assert.equal((await post(agent, `${mb(biz)}/connect`, { ad_account_id: act, token: TOK(t) })).status, 302);
  }
  productA = (await pool.query("INSERT INTO products (business_id, code, name, price_minor) VALUES ($1, 'serum', 'Glow serum', 900000) RETURNING id", [A])).rows[0].id;
  productB = (await pool.query("INSERT INTO products (business_id, code, name, price_minor) VALUES ($1, 'bread', 'Beta bread', 200000) RETURNING id", [B])).rows[0].id;
  // A real order with customer details: they must never reach OpenAI (only product totals do).
  const { rows: [o] } = await pool.query(
    `INSERT INTO orders (business_id, reference, access_token, customer_name, phone, email, address, currency, total_minor, idempotency_key, request_fingerprint, source)
     VALUES ($1, 'SKY-A1', 'tok-a-0123456789', 'Adaeze Secretname', '+2348099990000', 'adaeze@secret.test', '9 Hidden Close, Lagos', 'NGN', 900000, 'idem-a-0123456789', 'fp', 'manual') RETURNING id`, [A]);
  await pool.query("INSERT INTO order_items (order_id, product_id, product_code, product_name, quantity, unit_price_minor, line_total_minor) VALUES ($1, $2, 'serum', 'Glow serum', 1, 900000, 900000)", [o.id, productA]);
  await pool.query("UPDATE orders SET created_at = now() - interval '2 days' WHERE id = $1", [o.id]); // inside "last 7 days" (which ends yesterday)
  await post(ownerA, `${mb(A)}/profile`, { offer: 'Glow serum', daily_budget: '20,000', goals: 'Purchases' });
});
after(async () => { app.close(); app2.close(); [metaServer, openaiServer, aiServer].forEach((s) => s.close()); await pool.end(); await noAnalyst.pool.end(); });

describe('metrics and signals computed by Skyfly (not by the AI)', () => {
  test('metrics: CPA, ROAS, link CTR, conversion and landing-page conversion rates; missing values stay empty', () => {
    const m = metricsOf(A_NOW.c1);
    assert.equal(m.cpa, 3000); assert.equal(m.roas, 3); assert.equal(m.link_ctr, 2); assert.equal(m.conversion_rate, 1.5); assert.equal(m.landing_page_conversion_rate, 2);
    const z = metricsOf({});
    assert.equal(z.cpa, null); assert.equal(z.roas, null); assert.equal(z.conversion_rate, null); assert.equal(z.spend, 0);
  });

  test('date windows: presets end yesterday in the account time zone; previous window is the same length; custom ranges are checked', () => {
    const now = new Date('2026-11-22T01:00:00Z'); // 02:00 in Lagos
    assert.deepEqual(windows({ period: 'last_7d' }, 'Africa/Lagos', now).current, { since: '2026-11-15', until: '2026-11-21', days: 7 });
    assert.deepEqual(windows({ period: 'last_7d' }, 'Africa/Lagos', now).previous, { since: '2026-11-08', until: '2026-11-14', days: 7 });
    assert.deepEqual(windows({ period: 'today' }, 'America/Los_Angeles', now).current, { since: '2026-11-21', until: '2026-11-21', days: 1 });
    assert.deepEqual(windows({ since: '2026-11-01', until: '2026-11-10' }, 'UTC', now).previous, { since: '2026-10-22', until: '2026-10-31', days: 10 });
    assert.throws(() => windows({ since: '2026-11-10', until: '2026-11-01' }, 'UTC', now), /valid date range/);
    assert.throws(() => windows({ since: '2026-11-20', until: '2026-11-30' }, 'UTC', now), /future/);
    assert.throws(() => windows({ since: '2026-01-01', until: '2026-11-01' }, 'UTC', now), /90 days/);
  });

  test('signals: spend without conversions, CPA over the limit, CTR decline, frequency, opportunity; small samples are not judged', () => {
    const mk = (id, name, now, prev) => ({ id, name, metrics: metricsOf(now), previous: prev ? metricsOf(prev) : null });
    const d = { account: { id: '111111111', name: 'A' }, totals: metricsOf(sum(Object.values(A_NOW))), campaigns: [mk('601', 'Winner campaign', A_NOW.c1, A_PREV.c1), mk('602', 'Waste campaign', A_NOW.c2, A_PREV.c2), mk('603', 'New test', A_NOW.c3)],
      adsets: [{ id: '612', name: 'Broad Nigeria', metrics: metricsOf({ ...A_NOW.c2, frequency: '4.2' }) }], pixel: null };
    const kinds = (s) => s.map((x) => `${x.kind}:${x.id}`).sort();
    const s = signals(d, { cpa_threshold: 2500, no_conversion_spend: 20000, ctr_drop_pct: 30, frequency_max: 3.5 });
    assert.deepEqual(kinds(s), ['cpa_above_threshold:601', 'ctr_decline:602', 'high_frequency:612', 'opportunity:601', 'spend_no_conversions:602'].sort());
    assert.ok(!kinds(s).some((k) => k.endsWith(':603')), 'the tiny campaign is not flagged');
    // Without a limit, "no conversions" uses 2 × the account CPA (60500 / 6 purchases ≈ 10,083 → limit ≈ 20,167).
    assert.ok(kinds(signals(d, { ctr_drop_pct: 30, frequency_max: 3.5 })).includes('spend_no_conversions:602'));
    const low = signals({ account: { id: '1', name: 'x' }, totals: metricsOf({}), campaigns: [], adsets: [], pixel: null });
    assert.deepEqual(low.map((x) => x.kind), ['insufficient_data']);
  });

  test('schema check: answers with missing or extra fields are rejected', () => {
    const d = { campaigns: [{ id: '601', name: 'Winner campaign', metrics: metricsOf(A_NOW.c1) }, { id: '602', name: 'Waste campaign', metrics: metricsOf(A_NOW.c2) }] };
    const g = goodAnswer(d);
    assert.ok(validResult(g));
    assert.ok(!validResult({ ...g, extra: 1 }));
    const { summary, ...noSummary } = g; void summary;
    assert.ok(!validResult(noSummary));
    assert.ok(!validResult({ ...g, recommendations: [{ ...g.recommendations[0], action: 'delete_everything' }] }));
    assert.equal(SCHEMA.additionalProperties, false);
  });
});

describe('ChatGPT off', () => {
  test('without the OpenAI key: ChatGPT is off and its button disabled; Claude still analyses on its own; Compare needs both', async () => {
    const agent = request.agent(app2);
    const c = await csrfToken(agent, '/login');
    await agent.post('/login').type('form').send({ _csrf: c, email: 'a@alpha.test', password: 'correct-horse-battery' }).expect(302);
    const tab = await agent.get(`${mb(A)}?tab=analysis`).expect(200);
    {
      assert.match(tab.text, /data-analyst-off/);
      assert.match(tab.text, /data-analyze disabled/);
      assert.match(tab.text, /data-compare disabled/);
      assert.doesNotMatch(tab.text, /data-analyze-claude disabled/);
      const r = await agent.post(`${mb(A)}/analysis`).type('form').send({ _csrf: await csrfToken(agent, `/businesses/${A}/subscription`) });
      assert.equal(r.status, 409); assert.match(r.text, /OPENAI_API_KEY is not set/);
      const c = await agent.post(`${mb(A)}/analysis`).type('form').send({ _csrf: await csrfToken(agent, `/businesses/${A}/subscription`), engine: 'compare' });
      assert.equal(c.status, 409); assert.match(c.text, /Comparing needs both engines/);
    }
  });
});

describe('on-demand analysis', () => {
  test('Analyze: fresh Meta data for the SELECTED account, current and previous period, sent to OpenAI with a strict schema; the report renders', async () => {
    meta.calls.length = 0; openai.requests.length = 0; openai.mode = 'ok';
    const r = await run(ownerA, A, { period: 'last_7d' });
    assert.equal(r.status, 302, r.text?.slice(0, 300));
    const id = r.headers.location.split('/').pop();
    // Meta: only GETs, only this business's selected account, with its own token; two windows.
    assert.deepEqual(metaWrites(), []);
    assert.ok(meta.calls.every((c) => !c.path.startsWith('/act_') || c.path.startsWith('/act_111111111')), 'selected account only');
    assert.ok(meta.calls.every((c) => c.token === 'tokA'));
    const ranges = [...new Set(meta.calls.filter((c) => c.time_range).map((c) => JSON.stringify(c.time_range)))];
    assert.equal(ranges.length, 2, 'current and previous period');
    // OpenAI request: server-side key, configured model, strict JSON schema, not stored by OpenAI.
    const q = openai.requests.at(-1);
    assert.equal(q.path, '/v1/responses'); assert.equal(q.auth, `Bearer ${OPENAI_KEY}`);
    assert.equal(q.body.model, 'gpt-test-analyst'); assert.equal(q.body.store, false);
    assert.equal(q.body.text.format.type, 'json_schema'); assert.equal(q.body.text.format.strict, true);
    assert.match(q.body.instructions, /Never invent metrics/);
    assert.match(q.body.instructions, /untrusted content/);
    assert.match(q.body.input, /^Analyse this ad account[\s\S]*<campaign_data>\n[\s\S]*\n<\/campaign_data>$/);
    const d = lastRequestData();
    assert.equal(d.account.id, '111111111');
    assert.deepEqual(d.campaigns.map((c) => c.name), ['Winner campaign', 'Waste campaign', 'New test']);
    assert.equal(d.campaigns[0].metrics.cpa, 3000); assert.equal(d.campaigns[1].previous.purchases, 1);
    assert.ok(d.signals.some((s) => s.kind === 'spend_no_conversions' && s.id === '602'));
    assert.equal(d.business.profile.daily_budget, 20000);
    assert.ok(d.fetched_at);
    // The report.
    const page = await ownerA.get(`${mb(A)}/analysis/${id}`).expect(200);
    for (const s of ['Overall account performance', 'What is working', 'What is not working', 'Campaigns needing attention', 'Winning ads', 'Weak ads', 'Tracking concerns',
      'Priority action list', 'Budget recommendations', 'Creative recommendations', 'Audience recommendations', 'Testing recommendations', 'Data fetched from Meta']) {
      assert.ok(page.text.includes(s), `report shows "${s}"`);
    }
    for (const s of ['Observed', 'Supporting metrics', 'Why it matters', 'Recommended action', 'Expected objective', 'Confidence', 'Risks / limitations', 'More data needed']) assert.ok(page.text.includes(s), s);
    assert.match(page.text, /NGN 60,500/); assert.match(page.text, /act_111111111/);
    assert.match(page.text, /data-needs-approval/, 'pause / budget changes are marked as needing approval');
    assert.doesNotMatch(page.text, /data-ungrounded/, 'every figure matched the data');
    assert.ok(!page.text.includes(OPENAI_KEY));
  });

  test('only minimal, non-personal data is sent: no customer names, phones, emails or addresses; no other business\'s data', async () => {
    const sent = JSON.stringify(openai.requests.map((x) => x.body));
    for (const s of ['Adaeze', '+2348099990000', 'adaeze@secret.test', 'Hidden Close', 'Beta', '222222222', 'Alpha Glow', 'tokA', TOK('tokA')]) assert.ok(!sent.includes(s), `"${s}" not sent`);
    const d = lastRequestData();
    assert.deepEqual(d.business.skyfly_orders.by_product.map((p) => [p.product, p.orders]), [['Glow serum', 1]]);
  });

  test('date range, campaign and product scope', async () => {
    meta.calls.length = 0;
    assert.equal((await run(ownerA, A, { period: 'last_14d', campaign: '601', product: String(productA) })).status, 302);
    const cur = meta.calls.filter((c) => c.level === 'campaign' && c.time_range).map((c) => c.time_range).sort((x, y) => (x.since < y.since ? 1 : -1))[0];
    assert.equal((new Date(cur.until) - new Date(cur.since)) / 86400000 + 1, 14);
    assert.ok(meta.calls.filter((c) => c.path.endsWith('/insights')).every((c) => c.filtering?.[0]?.value?.[0] === '601'), 'campaign filter on every insights read');
    const d = lastRequestData();
    assert.deepEqual(d.campaigns.map((c) => c.id), ['601']);
    assert.equal(d.business.focus_product.name, 'Glow serum');
    assert.equal(d.campaign_filter, '601');
    // Custom range.
    meta.calls.length = 0;
    assert.equal((await run(ownerA, A, { period: 'custom', since: '2026-10-01', until: '2026-10-10' })).status, 302);
    assert.deepEqual(meta.calls.filter((c) => c.level === 'campaign' && c.time_range).map((c) => c.time_range).sort((x, y) => (x.since < y.since ? 1 : -1))[0], { since: '2026-10-01', until: '2026-10-10' });
    const bad = await run(ownerA, A, { period: 'custom', since: '2026-10-10', until: '2026-10-01' });
    assert.equal(bad.status, 409); assert.match(bad.text, /valid date range/);
    // Another business's product is refused.
    const other = await run(ownerA, A, { product: String(productB) });
    assert.equal(other.status, 404); assert.match(other.text, /not in this business/);
  });

  test('account isolation: a chosen account must be this business\'s; switching changes the source; B never sees A\'s analysis', async () => {
    const foreign = await run(ownerA, A, { account: '222222222' });
    assert.equal(foreign.status, 404); assert.match(foreign.text, /not connected to this business/);
    meta.calls.length = 0;
    assert.equal((await run(ownerA, A, { account: '333333333' })).status, 302);
    assert.ok(meta.calls.filter((c) => c.path.startsWith('/act_')).every((c) => c.path.startsWith('/act_333333333')));
    assert.equal(lastRequestData().account.id, '333333333');
    const { rows: [a] } = await pool.query('SELECT id, ad_account_id FROM ad_analyses WHERE business_id = $1 ORDER BY id DESC LIMIT 1', [A]);
    assert.equal(a.ad_account_id, '333333333');
    await ownerB.get(`${mb(B)}/analysis/${a.id}`).expect(404);
    await ownerB.get(`${mb(A)}/analysis/${a.id}`).expect(404);
    // B's own analysis uses only B's account.
    assert.equal((await run(ownerB, B)).status, 302);
    const d = lastRequestData();
    assert.equal(d.account.id, '222222222'); assert.deepEqual(d.campaigns.map((c) => c.name), ['Beta bakery campaign']);
    assert.ok(!JSON.stringify(d).includes('Winner campaign'));
  });

  test('empty account and low data: the analysis runs, flags insufficient data, and invents nothing', async () => {
    assert.equal((await run(ownerE, E)).status, 302);
    const d = lastRequestData();
    assert.deepEqual(d.campaigns, []); assert.equal(d.totals.spend, 0);
    assert.ok(d.signals.some((s) => s.kind === 'insufficient_data'));
    const { rows: [a] } = await pool.query("SELECT result FROM ad_analyses WHERE business_id = $1 AND status = 'ok' ORDER BY id DESC LIMIT 1", [E]);
    assert.equal(a.result.data_quality.sufficiency, 'insufficient'); assert.deepEqual(a.result.recommendations, []);
  });

  test('grounding: points about campaigns not in the data are removed; figures not in the data are flagged', async () => {
    openai.mode = 'invented';
    const r = await run(ownerA, A, { account: '111111111' });
    assert.equal(r.status, 302);
    const id = r.headers.location.split('/').pop();
    const { rows: [a] } = await pool.query('SELECT result FROM ad_analyses WHERE id = $1', [id]);
    assert.ok(!a.result.recommendations.some((x) => x.entity_id === '999999'), 'ghost campaign removed');
    assert.deepEqual(a.result.removed_unverifiable, ['Ghost campaign']);
    assert.equal(a.result.working[0].grounded, false);
    assert.ok(a.result.recommendations.every((x) => x.grounded), 'real figures are grounded');
    const page = await ownerA.get(`${mb(A)}/analysis/${id}`).expect(200);
    assert.match(page.text, /data-ungrounded/); assert.match(page.text, /data-removed/);
    openai.mode = 'ok';
  });

  test('ground(): numbers with thousands separators and currency match; unknown numbers do not', () => {
    const d = { account: { id: '1' }, totals: { spend: 42000 }, previous_totals: {}, campaigns: [{ id: '602', metrics: { spend: 42000, cpa: 3000.5 } }], adsets: [], ads: [], signals: [], window: { days: 7 } };
    const f = (v) => ({ entity_level: 'campaign', entity_id: '602', entity_name: 'W', observation: '', metrics: [{ name: 'x', value: v }], evidence: 'statistical' });
    const base = { summary: '', data_quality: { sufficiency: 'limited', notes: [] }, not_working: [], campaigns_needing_attention: [], winning_ads: [], weak_ads: [], tracking_concerns: [], recommendations: [], priority_actions: [] };
    const g = ground({ ...base, working: [f('NGN 42,000'), f('₦3,000.50 on 2026-11-21'), f('NGN 77,777')] }, d);
    assert.deepEqual(g.working.map((x) => x.grounded), [true, true, false]);
  });
});

describe('failures: clear message, nothing changed in Meta, a failed run recorded, no secret shown', () => {
  const cases = [
    ['invalid_key', 502, /refused the API key/],
    ['rate_limit', 503, /rate-limiting/],
    ['quota', 503, /quota/],
    ['timeout', 504, /took too long/],
    ['malformed', 502, /unexpected format/],
    ['off_schema', 502, /unexpected format/],
    ['refusal', 502, /declined/],
    ['incomplete', 502, /cut short/],
  ];
  for (const [mode, status, msg] of cases) {
    test(mode, async () => {
      openai.mode = mode; meta.calls.length = 0;
      const before = (await pool.query("SELECT count(*)::int AS n FROM ad_analyses WHERE business_id = $1 AND status = 'failed'", [A])).rows[0].n;
      const r = await run(ownerA, A, { account: '111111111' });
      assert.equal(r.status, status); assert.match(r.text, msg);
      assert.ok(!r.text.includes(OPENAI_KEY));
      assert.deepEqual(metaWrites(), []);
      const { rows: [f] } = await pool.query("SELECT count(*)::int AS n FROM ad_analyses WHERE business_id = $1 AND status = 'failed'", [A]);
      assert.equal(f.n, before + 1);
      openai.mode = 'ok';
    });
  }

  test('a temporary server error or rate limit is retried once, then succeeds', async () => {
    for (const s of [500, 429]) {
      openai.failuresLeft = 1; openai.failStatus = s; openai.failCode = null;
      const n = openai.requests.length;
      assert.equal((await run(ownerA, A, { account: '111111111' })).status, 302, `retry after ${s}`);
      assert.equal(openai.requests.length - n, 2);
    }
  });

  test('failed runs show in the list with their reason; the Media Buyer page still works', async () => {
    const tab = await ownerA.get(`${mb(A)}?tab=analysis`).expect(200);
    assert.match(tab.text, /failed/); assert.match(tab.text, /refused the API key/);
    assert.ok(!tab.text.includes(OPENAI_KEY));
  });
});

describe('spend control, refresh and approval boundary', () => {
  test('one analysis at a time per business, and a daily cap', async () => {
    await unblock();
    assert.equal((await post(ownerA, `${mb(A)}/analysis`, { account: '111111111' })).status, 302);
    const again = await post(ownerA, `${mb(A)}/analysis`, { account: '111111111' });
    assert.equal(again.status, 429); assert.match(again.text, /wait a minute/);
    await unblock();
    const { rows: [{ n }] } = await pool.query("SELECT count(*)::int AS n FROM ad_analyses WHERE business_id = $1 AND created_at > now() - interval '24 hours'", [A]);
    await pool.query(`INSERT INTO ad_analyses (business_id, ad_account_id, status, created_at) SELECT $1, '111111111', 'failed', now() - interval '1 hour' FROM generate_series(1, $2)`, [A, Math.max(0, 30 - n)]);
    const capped = await run(ownerA, A, { account: '111111111' });
    assert.equal(capped.status, 429); assert.match(capped.text, /limit/);
    await pool.query("DELETE FROM ad_analyses WHERE business_id = $1 AND scope = '{}'", [A]);
  });

  test('refresh re-runs the same scope with fresh data', async () => {
    const { rows: [a] } = await pool.query("SELECT id, scope FROM ad_analyses WHERE business_id = $1 AND status = 'ok' ORDER BY id DESC LIMIT 1", [A]);
    const page = await ownerA.get(`${mb(A)}/analysis/${a.id}`).expect(200);
    assert.match(page.text, /data-refresh/);
    meta.calls.length = 0;
    assert.equal((await run(ownerA, A, { account: '111111111', period: 'custom', since: a.scope.since, until: a.scope.until })).status, 302);
    assert.ok(meta.calls.length > 5, 'Meta read again');
    assert.equal(lastRequestData().window.since, a.scope.since);
  });

  test('old data is labelled as stale', async () => {
    const { rows: [a] } = await pool.query("SELECT id FROM ad_analyses WHERE business_id = $1 AND status = 'ok' ORDER BY id DESC LIMIT 1", [A]);
    await pool.query("UPDATE ad_analyses SET data_fetched_at = now() - interval '30 hours' WHERE id = $1", [a.id]);
    const page = await ownerA.get(`${mb(A)}/analysis/${a.id}`).expect(200);
    assert.match(page.text, /30 hours ago\. These are not current numbers/);
  });

  test('ANALYZE → RECOMMEND → REVIEW → APPROVAL: a recommendation goes to Approvals; approving changes nothing in Meta', async () => {
    openai.mode = 'ok';
    const r = await run(ownerA, A, { account: '111111111' });
    const id = r.headers.location.split('/').pop();
    const { rows: [a] } = await pool.query('SELECT result FROM ad_analyses WHERE id = $1', [id]);
    const n = a.result.recommendations.findIndex((x) => x.action === 'pause');
    assert.ok(n >= 0 && a.result.recommendations[n].needs_approval);
    meta.calls.length = 0;
    const p = await post(ownerA, `${mb(A)}/analysis/${id}/recommendations/${n}/propose`);
    assert.equal(p.status, 302);
    const itemId = p.headers.location.split('/').pop();
    const again = await post(ownerA, `${mb(A)}/analysis/${id}/recommendations/${n}/propose`);
    assert.equal(again.headers.location.split('/').pop(), itemId, 'no duplicate approval item');
    const { rows: [item] } = await pool.query('SELECT kind, status, ad_account_id, body FROM ad_items WHERE id = $1', [itemId]);
    assert.deepEqual([item.kind, item.status, item.ad_account_id], ['recommendation', 'proposed', '111111111']);
    const view = await ownerA.get(`${mb(A)}/items/${itemId}`).expect(200);
    assert.match(view.text, /records your decision; nothing changes in Meta/);
    assert.match(view.text, /Supporting metrics/);
    assert.equal((await post(ownerA, `${mb(A)}/items/${itemId}/approve`)).status, 302);
    assert.equal((await pool.query('SELECT status FROM ad_items WHERE id = $1', [itemId])).rows[0].status, 'approved');
    assert.deepEqual(metaWrites(), [], 'no Meta write: no pause, budget change or publish');
    assert.equal(meta.calls.length, 0, 'approving a recommendation does not even call Meta');
    const after = await ownerA.get(`${mb(A)}/items/${itemId}?done=approved`).expect(200);
    assert.match(after.text, /does not change Meta for recommendations/);
  });
});

describe('monitoring (alerts only)', () => {
  test('owner saves thresholds; the worker raises alerts for spend without conversions, CTR decline, frequency, opportunity; once per day', async () => {
    assert.equal((await post(ownerA, `${mb(A)}/monitoring`, { enabled: 'on', cpa_threshold: '2,500', no_conversion_spend: '20000', ctr_drop_pct: '30', frequency_max: '3.5', interval_hours: '6' })).headers.location, `${mb(A)}?tab=analysis&done=monitoring`);
    const { rows: [m] } = await pool.query('SELECT enabled, cpa_threshold_minor, no_conversion_spend_minor, interval_hours FROM ad_monitor_settings WHERE business_id = $1', [A]);
    assert.deepEqual([m.enabled, Number(m.cpa_threshold_minor), Number(m.no_conversion_spend_minor), m.interval_hours], [true, 250000, 2000000, 6]);
    await post(ownerA, `${mb(A)}/accounts/select`, { account: '111111111' });
    meta.calls.length = 0; const aiCalls = openai.requests.length;
    const r1 = await runAdMonitoring(pool, config);
    assert.equal(r1.businesses, 1);
    assert.deepEqual(metaWrites(), []); assert.equal(openai.requests.length, aiCalls, 'monitoring costs no AI call');
    const { rows } = await pool.query('SELECT kind, entity_id, severity FROM ad_alerts WHERE business_id = $1 ORDER BY kind, entity_id', [A]);
    const kinds = rows.map((x) => `${x.kind}:${x.entity_id}`);
    for (const k of ['spend_no_conversions:602', 'cpa_above_threshold:601', 'high_frequency:612']) assert.ok(kinds.includes(k), `${k} in ${kinds}`);
    // Not due again yet; and if forced, no duplicates the same day.
    assert.equal((await runAdMonitoring(pool, config)).businesses, 0);
    await pool.query("UPDATE ad_monitor_settings SET last_run_at = now() - interval '7 hours' WHERE business_id = $1", [A]);
    await runAdMonitoring(pool, config);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM ad_alerts WHERE business_id = $1', [A])).rows[0].n, rows.length);
    // Businesses that did not switch it on are not monitored.
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM ad_alerts WHERE business_id <> $1', [A])).rows[0].n, 0);
  });

  test('alerts show in the Analysis tab and on the overview; dismissing removes one; another business cannot dismiss it', async () => {
    const tab = await ownerA.get(`${mb(A)}?tab=analysis`).expect(200);
    assert.match(tab.text, /data-alert="spend_no_conversions"/);
    assert.match((await ownerA.get(mb(A)).expect(200)).text, /monitoring alert\(s\)/);
    const { rows: [al] } = await pool.query('SELECT id FROM ad_alerts WHERE business_id = $1 ORDER BY id LIMIT 1', [A]);
    assert.equal((await post(ownerB, `${mb(B)}/alerts/${al.id}/dismiss`)).status, 404);
    assert.equal((await post(ownerA, `${mb(A)}/alerts/${al.id}/dismiss`)).status, 302);
    assert.ok((await pool.query('SELECT dismissed_at FROM ad_alerts WHERE id = $1', [al.id])).rows[0].dismissed_at);
  });
});

describe('roles: ChatGPT analyses performance, Cloudy creates', () => {
  test('with ChatGPT on, Cloudy\'s audit / recommendations / reports give way to "Analyze my campaigns"; briefs and drafts stay with Cloudy', async () => {
    const over = await ownerA.get(mb(A)).expect(200);
    assert.match(over.text, /data-analyze-link/);
    assert.doesNotMatch(over.text, /data-generate="audit"/); assert.doesNotMatch(over.text, /data-generate="recommendations"/);
    assert.match(over.text, /data-generate="briefs"/); assert.match(over.text, /data-generate="campaign_draft"/);
    const n = ai.requests.length;
    for (const task of ['audit', 'recommendations', 'report_daily', 'report_weekly']) {
      const r = await post(ownerA, `${mb(A)}/generate/${task}`);
      assert.equal(r.status, 409); assert.match(r.text, /Performance Analysis tab/);
    }
    assert.equal(ai.requests.length, n, 'no duplicate AI spend on Cloudy');
    assert.equal((await post(ownerA, `${mb(A)}/generate/briefs`)).status, 302);
  });

  test('Cloudy reads the latest ChatGPT analysis for the same account, so the two never contradict', async () => {
    const sys = ai.requests.at(-1).system;
    assert.match(sys, /latest_performance_analysis/);
    assert.match(sys, /Scale Winner campaign gradually/);
  });
});

describe('security', () => {
  test('the OpenAI key never reaches the browser or the database', async () => {
    for (const path of [mb(A), `${mb(A)}?tab=analysis`, `${mb(A)}?tab=settings`]) assert.ok(!(await ownerA.get(path)).text.includes(OPENAI_KEY.slice(0, 20)));
    const { rows: [{ found }] } = await pool.query('SELECT count(*)::int AS found FROM ad_analyses WHERE data::text LIKE $1 OR result::text LIKE $1 OR coalesce(error, \'\') LIKE $1', [`%${OPENAI_KEY.slice(0, 20)}%`]);
    assert.equal(found, 0);
  });

  test('staff (no marketing permission) cannot run analyses', async () => {
    const { rows: [s] } = await pool.query("INSERT INTO users (email, password_hash, name, email_verified_at) VALUES ('staff2@alpha.test', $1, 'Staff', now()) RETURNING id", [await (await import('../src/lib/passwords.js')).hashPassword('correct-horse-battery')]);
    await pool.query("INSERT INTO business_members (business_id, user_id, role) VALUES ($1, $2, 'staff')", [A, s.id]);
    const staff = request.agent(app); const c = await csrfToken(staff, '/login');
    await staff.post('/login').type('form').send({ _csrf: c, email: 'staff2@alpha.test', password: 'correct-horse-battery' }).expect(302);
    const r = await staff.post(`${mb(A)}/analysis`).type('form').send({ _csrf: await csrfToken(staff, `/businesses/${A}`) });
    assert.ok([403, 404].includes(r.status), `staff got ${r.status}`);
  });
});
