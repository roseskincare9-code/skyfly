// Budget safeguards (AI Media Buyer), against a stand-in Meta Marketing API (no real accounts, nothing
// published or spent): approved-budget register, detection of budget changes Skyfly did not make, the
// append-only audit log, overspend alerts, budget vs actual across two ad accounts, the combined daily
// limit, isolation between businesses, and the guarantee that a check never writes to Meta.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { setup, resetDatabase, csrfToken, signUp, openClientSignup } from './helpers.js';
import { approveBudget, checkBudgets, budgetReport, budgetEvents, META_DAILY_OVERDELIVERY } from '../src/services/budgetGuard.js';

const today = new Date().toISOString().slice(0, 10);
const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
// Live state per account; tests mutate it to simulate changes made in Ads Manager.
const state = {
  '111111111': { campaigns: [{ id: '601', name: 'Ibadan web sales', daily_budget: '600000' }, { id: '602', name: 'Old default', daily_budget: '497500' }],
    adsets: [{ id: '611', name: 'ABO set', daily_budget: '150000' }],
    spend: [{ campaign_id: '601', campaign_name: 'Ibadan web sales', date_start: yesterday, spend: '7200' }, { campaign_id: '602', campaign_name: 'Old default', date_start: yesterday, spend: '7237.3' }] },
  '333333333': { campaigns: [{ id: '901', name: 'PH web sales', daily_budget: '600000' }], adsets: [],
    spend: [{ campaign_id: '901', campaign_name: 'PH web sales', date_start: yesterday, spend: '5800' }] },
  '222222222': { campaigns: [{ id: '701', name: 'Beta bakery', daily_budget: '300000' }], adsets: [], spend: [] },
};
const meta = { calls: [] };
const ACCOUNTS = { tokA: ['111111111', '333333333'], tokB: ['222222222'] };
const metaServer = createServer((req, res) => {
  const u = new URL(req.url, 'http://x'); const token = (u.searchParams.get('access_token') ?? '').slice(0, 4); const p = u.pathname.replace(/^\/v\d+\.\d+/, '');
  meta.calls.push({ method: req.method, path: p, token });
  const send = (o, s = 200) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (req.method !== 'GET') return send({ error: { message: 'writes are not allowed in this test' } }, 405);
  const allowed = ACCOUNTS[token];
  if (!allowed) return send({ error: { message: 'Invalid OAuth access token.', code: 190 } }, 401);
  if (/^\/px\d+$/.test(p)) return send({ id: p.slice(1), last_fired_time: new Date().toISOString() });
  const m = /^\/act_(\d+)(\/[a-z_]+)?$/.exec(p);
  if (!m || !allowed.includes(m[1])) return send({ error: { message: '(#200) no permission', code: 200 } }, 403);
  const s = state[m[1]];
  if (!m[2]) return send({ id: `act_${m[1]}`, name: `Account ${m[1]}`, currency: 'NGN', account_status: 1, timezone_name: 'Africa/Lagos' });
  if (m[2] === '/promote_pages') return send({ data: [{ id: `page${m[1]}`, name: 'Page' }] });
  if (m[2] === '/adspixels') return send({ data: [{ id: `px${m[1]}`, name: 'Pixel' }] });
  if (m[2] === '/campaigns') return send({ data: s.campaigns.map((c) => ({ ...c, effective_status: 'ACTIVE' })) });
  if (m[2] === '/adsets') return send({ data: s.adsets.map((c) => ({ ...c, effective_status: 'ACTIVE' })) });
  if (m[2] === '/insights') return send({ data: s.spend.map((r) => ({ ...r, date_stop: r.date_start })) });
  if (m[2] === '/ads') return send({ data: [] });
  send({ error: { message: 'not mocked' } }, 404);
});
await new Promise((r) => metaServer.listen(0, r));
const encryptionKey = randomBytes(32);
const { pool, app: expressApp, config } = setup({ metaGraphBase: `http://127.0.0.1:${metaServer.address().port}/v26.0`, encryptionKey });
const app = expressApp.listen(0);
const TOK = (t) => `${t}${'z'.repeat(40)}`;
const post = async (agent, path, form = {}) => { const _csrf = await csrfToken(agent, `/businesses/${path.match(/\/businesses\/(\d+)/)[1]}/subscription`); return agent.post(path).type('form').send({ _csrf, ...form }); };
const mb = (biz) => `/businesses/${biz}/media-buyer`;
let ownerA; let ownerB; let A; let B; let ownerAUser;

before(async () => {
  await resetDatabase(pool);
  await signUp(app, { name: 'Founder', email: 'founder@skyfly.test' });
  await openClientSignup(pool);
  ownerA = await signUp(app, { name: 'Owner A', email: 'a@alpha.test', business: 'Alpha Glow' });
  ownerB = await signUp(app, { name: 'Owner B', email: 'b@beta.test', business: 'Beta Bakes' });
  [A, B] = await Promise.all(['Alpha Glow', 'Beta Bakes'].map(async (n) => (await pool.query('SELECT id FROM businesses WHERE name = $1', [n])).rows[0].id));
  for (const [agent, biz, act, t] of [[ownerA, A, '111111111', 'tokA'], [ownerA, A, '333333333', 'tokA'], [ownerB, B, '222222222', 'tokB']]) {
    assert.equal((await post(agent, `${mb(biz)}/connect`, { ad_account_id: act, token: TOK(t) })).status, 302);
  }
  ownerAUser = (await pool.query("SELECT id FROM users WHERE email = 'a@alpha.test'")).rows[0].id;
});
after(async () => { app.close(); metaServer.close(); await pool.end(); });

describe('approved budget register', () => {
  test('the owner records an approved budget through the page; it is audit-logged', async () => {
    const r = await post(ownerA, `${mb(A)}/budgets/approve`, { ad_account_id: '111111111', level: 'campaign', entity_id: '601', name: 'Ibadan web sales', daily_budget: '6,000', note: 'approved Nov 22' });
    assert.equal(r.status, 302);
    const { rows: [reg] } = await pool.query("SELECT * FROM ad_budget_register WHERE business_id = $1 AND entity_id = '601'", [A]);
    assert.equal(Number(reg.approved_daily_budget_minor), 600000);
    const ev = await budgetEvents(pool, A);
    assert.equal(ev[0].event, 'approved'); assert.equal(Number(ev[0].new_budget_minor), 600000); assert.equal(Number(ev[0].actor), ownerAUser);
  });
  test('cannot record a budget for an ad account of another business', async () => {
    await assert.rejects(approveBudget(pool, { businessId: B, adAccountId: '111111111', level: 'campaign', entityId: '601', dailyBudgetMinor: 100 }), /not connected/);
    const r = await post(ownerB, `${mb(B)}/budgets/approve`, { ad_account_id: '111111111', level: 'campaign', entity_id: '601', daily_budget: '1' });
    assert.equal(r.status, 400);
  });
  test('rejects invalid amounts and ids', async () => {
    await assert.rejects(approveBudget(pool, { businessId: A, adAccountId: '111111111', level: 'campaign', entityId: '601', dailyBudgetMinor: 0 }), /positive/);
    await assert.rejects(approveBudget(pool, { businessId: A, adAccountId: '111111111', level: 'campaign', entityId: '60x', dailyBudgetMinor: 100 }), /Invalid/);
  });
  test('the audit log is append-only', async () => {
    await assert.rejects(pool.query('UPDATE ad_budget_events SET new_budget_minor = 1 WHERE business_id = $1', [A]), /append-only/);
    await assert.rejects(pool.query('DELETE FROM ad_budget_events WHERE business_id = $1', [A]), /append-only/);
  });
});

describe('checks across all ad accounts (read-only)', () => {
  test('first check: unapproved budgets alerted, overspend flagged, budget vs actual stored, nothing written to Meta', async () => {
    await approveBudget(pool, { businessId: A, userId: ownerAUser, adAccountId: '333333333', level: 'campaign', entityId: '901', dailyBudgetMinor: 600000 });
    meta.calls.length = 0;
    const r = await checkBudgets(pool, config, A);
    assert.equal(meta.calls.filter((c) => c.method !== 'GET').length, 0);
    assert.equal(r.accounts, 2);
    assert.equal(r.nominal_daily_minor, 600000 + 497500 + 150000 + 600000);
    assert.equal(r.possible_daily_max_minor, Math.round(r.nominal_daily_minor * (1 + META_DAILY_OVERDELIVERY)));
    const { rows: alerts } = await pool.query('SELECT kind, entity_id FROM ad_alerts WHERE business_id = $1 ORDER BY id', [A]);
    const kinds = alerts.map((a) => `${a.kind}:${a.entity_id}`);
    assert.ok(kinds.includes('budget_unapproved:602')); assert.ok(kinds.includes('budget_unapproved:611'));
    assert.ok(!kinds.includes('budget_unapproved:601')); assert.ok(!kinds.includes('budget_changed:601'));
    assert.ok(kinds.includes('daily_overspend:602'), '7,237 spent on a 4,975 budget is 45% over');
    assert.ok(!kinds.includes('daily_overspend:601'), '7,200 on 6,000 is 20%, under the 25% default');
    const rep = await budgetReport(pool, A, yesterday);
    assert.equal(rep.rows.length, 3); assert.equal(rep.total_spend_minor, 720000 + 723730 + 580000);
    assert.equal(r.spend_by_day[yesterday], 720000 + 723730 + 580000);
  });
  test('a budget changed in Ads Manager is detected once, logged, alerted; back to approved is logged too', async () => {
    state['111111111'].campaigns[0].daily_budget = '1000000';
    await checkBudgets(pool, config, A);
    await checkBudgets(pool, config, A); // second check: no duplicate event or alert
    const ev = (await budgetEvents(pool, A)).filter((e) => e.entity_id === '601' && e.event === 'changed_outside_skyfly');
    assert.equal(ev.length, 1); assert.equal(Number(ev[0].old_budget_minor), 600000); assert.equal(Number(ev[0].new_budget_minor), 1000000);
    const { rows } = await pool.query("SELECT * FROM ad_alerts WHERE business_id = $1 AND kind = 'budget_changed' AND entity_id = '601'", [A]);
    assert.equal(rows.length, 1); assert.equal(rows[0].severity, 'high'); assert.match(rows[0].message, /Skyfly did not make this change/);
    state['111111111'].campaigns[0].daily_budget = '600000';
    await checkBudgets(pool, config, A);
    assert.ok((await budgetEvents(pool, A)).some((e) => e.entity_id === '601' && e.event === 'back_to_approved'));
  });
  test('combined daily limit across accounts raises one alert per day', async () => {
    await pool.query('INSERT INTO ad_monitor_settings (business_id, enabled, combined_daily_limit_minor) VALUES ($1, true, $2) ON CONFLICT (business_id) DO UPDATE SET combined_daily_limit_minor = $2', [A, 1500000]);
    await checkBudgets(pool, config, A); await checkBudgets(pool, config, A);
    const { rows } = await pool.query("SELECT kind FROM ad_alerts WHERE business_id = $1 AND kind LIKE 'combined_%'", [A]);
    assert.deepEqual(rows.map((r) => r.kind).sort(), ['combined_budget_over_limit', 'combined_spend_over_limit']);
  });
  test("another business's check never sees or touches business A's data", async () => {
    await checkBudgets(pool, config, B);
    const { rows } = await pool.query('SELECT DISTINCT ad_account_id FROM ad_spend_daily WHERE business_id = $1', [B]);
    assert.ok(rows.every((r) => r.ad_account_id === '222222222'));
    assert.ok((await budgetEvents(pool, B)).every((e) => e.ad_account_id === '222222222'));
  });
  test('the page shows the register, the report and the audit log', async () => {
    const r = await ownerA.get(`${mb(A)}?tab=analysis`);
    assert.equal(r.status, 200);
    assert.match(r.text, /data-budget-safeguards/); assert.match(r.text, /data-budget-register/); assert.match(r.text, /data-budget-events/);
    assert.match(r.text, /not a hard cap/);
    assert.ok(today);
  });
});
