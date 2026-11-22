// ChatGPT, the AI Media Buyer's performance analyst (OpenAI Responses API, structured output).
//
// Roles inside the Media Buyer (one recommendation system, not two):
//   - ChatGPT (this file): performance analysis and optimisation recommendations from the business's own
//     Meta data: what works, what fails, what to change and why. It also owns audits / reports when on.
//   - Cloudy (cloudy.js): the conversation (Ask), creative briefs, campaign drafts and creative review. It
//     reads the latest ChatGPT analysis as context so the two never contradict each other.
//
// Safety: every call is built ONLY from the selected business's own data (loaded here by business ID and
// one of ITS ad accounts). Only aggregated advertising metrics are sent: no customer names, emails, phones
// or addresses. Skyfly computes every metric itself; the AI's answer is validated against a schema and
// each figure it quotes is checked against the data. Nothing here changes Meta: recommendations that would
// change a campaign go to Skyfly's approval workflow, and an approved recommendation is not executed by
// Skyfly. Monitoring is rule-based (no AI cost) and only creates alerts.
import { analysisData, listConnections, MetaError } from './metaAds.js';

export class AnalystError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
export const analystReady = (config) => Boolean(config.analyst?.apiKey);

// ---------- Rule-based signals (deterministic; used by the analysis and by monitoring)
export const DEFAULT_THRESHOLDS = { cpa_threshold: null, no_conversion_spend: null, ctr_drop_pct: 30, frequency_max: 3.5 };
const MIN = { impressions: 1000, purchases: 3 }; // below this a single entity's result is not conclusive
const pct = (a, b) => (a == null || b == null || !b ? null : Math.round(((a - b) / b) * 1000) / 10);

export function signals(d, th = DEFAULT_THRESHOLDS) {
  const out = [];
  const t = d.totals ?? {};
  const add = (s) => out.push(s);
  const accountCpa = t.cpa;
  const enough = (m) => m && m.impressions >= MIN.impressions;
  if ((t.purchases ?? 0) < MIN.purchases || (t.impressions ?? 0) < MIN.impressions) {
    add({ kind: 'insufficient_data', severity: 'low', level: 'account', id: d.account.id, name: d.account.name,
      message: `Only ${t.purchases ?? 0} purchase(s) and ${t.impressions ?? 0} impressions in this period: too little data to judge campaigns reliably.`,
      suggestion: 'Let campaigns run longer or widen the date range before making big changes.', metrics: { purchases: t.purchases ?? 0, impressions: t.impressions ?? 0 }, evidence: 'observed_pattern' });
  }
  const noConvLimit = th.no_conversion_spend ?? (th.cpa_threshold ? th.cpa_threshold * 2 : accountCpa ? accountCpa * 2 : null);
  for (const c of d.campaigns ?? []) {
    const m = c.metrics; const p = c.previous;
    if (!m) continue;
    const base = { level: 'campaign', id: c.id, name: c.name };
    if (noConvLimit && m.spend >= noConvLimit && !m.purchases && !m.leads) {
      add({ ...base, kind: 'spend_no_conversions', severity: 'high', message: `${c.name} spent ${m.spend} with no purchases or leads (limit ${noConvLimit}).`,
        suggestion: 'Review it: check the creative, audience and landing page; consider pausing or reducing its budget (needs your approval).', metrics: { spend: m.spend, purchases: 0, limit: noConvLimit }, evidence: enough(m) ? 'statistical' : 'observed_pattern' });
    }
    if (th.cpa_threshold && m.cpa != null && m.cpa > th.cpa_threshold) {
      add({ ...base, kind: 'cpa_above_threshold', severity: m.purchases >= MIN.purchases ? 'high' : 'medium', message: `${c.name}: cost per purchase ${m.cpa} is above your limit of ${th.cpa_threshold} (${m.purchases} purchase(s)).`,
        suggestion: 'Compare its ads and audiences with your better campaigns before shifting budget.', metrics: { cpa: m.cpa, threshold: th.cpa_threshold, purchases: m.purchases }, evidence: m.purchases >= MIN.purchases ? 'statistical' : 'observed_pattern' });
    }
    if (p && m.link_ctr != null && p.link_ctr && m.impressions >= MIN.impressions && p.impressions >= MIN.impressions) {
      const change = pct(m.link_ctr, p.link_ctr);
      if (change != null && change <= -th.ctr_drop_pct) {
        add({ ...base, kind: 'ctr_decline', severity: 'medium', message: `${c.name}: link CTR fell ${Math.abs(change)}% (${p.link_ctr}% → ${m.link_ctr}%) versus the previous period.`,
          suggestion: 'Possible creative fatigue: prepare fresh creatives or hooks to test.', metrics: { link_ctr: m.link_ctr, previous_link_ctr: p.link_ctr, change_pct: change }, evidence: 'statistical' });
      }
    }
    if (p && m.cpa != null && p.cpa != null && m.purchases >= MIN.purchases && p.purchases >= MIN.purchases) {
      const change = pct(m.cpa, p.cpa);
      if (change >= 30) add({ ...base, kind: 'performance_deterioration', severity: 'medium', message: `${c.name}: cost per purchase rose ${change}% (${p.cpa} → ${m.cpa}).`,
        suggestion: 'Check frequency, creative fatigue and recent edits before increasing spend.', metrics: { cpa: m.cpa, previous_cpa: p.cpa, change_pct: change }, evidence: 'statistical' });
    }
    if (accountCpa && m.cpa != null && m.purchases >= MIN.purchases && m.cpa <= accountCpa * 0.7) {
      add({ ...base, kind: 'opportunity', severity: 'opportunity', message: `${c.name}: ${m.purchases} purchases at ${m.cpa} each, below the account average of ${accountCpa}.`,
        suggestion: 'A candidate for a gradual budget increase (needs your approval); watch CPA as spend grows.', metrics: { cpa: m.cpa, account_cpa: accountCpa, purchases: m.purchases }, evidence: 'statistical' });
    }
  }
  for (const s of d.adsets ?? []) {
    const m = s.metrics;
    if (m && m.frequency >= th.frequency_max && m.impressions >= MIN.impressions) {
      add({ kind: 'high_frequency', severity: 'medium', level: 'adset', id: s.id, name: s.name, message: `${s.name}: frequency ${m.frequency} (people see the ads ${m.frequency} times on average).`,
        suggestion: 'Risk of creative fatigue: refresh creatives or widen the audience.', metrics: { frequency: m.frequency, threshold: th.frequency_max }, evidence: 'observed_pattern' });
    }
  }
  if ((t.link_clicks ?? 0) >= 100 && !t.landing_page_views) {
    add({ kind: 'tracking', severity: 'medium', level: 'account', id: d.account.id, name: d.account.name, message: `${t.link_clicks} link clicks but no landing page views recorded: the pixel may not be firing on the landing page.`,
      suggestion: 'Check the pixel on the landing page (Tracking & Pixels).', metrics: { link_clicks: t.link_clicks, landing_page_views: 0 }, evidence: 'probable_cause' });
  }
  if (d.pixel) {
    const last = d.pixel.last_fired_time ? new Date(d.pixel.last_fired_time) : null;
    if (!last || Date.now() - last.getTime() > 24 * 3600000) {
      add({ kind: 'tracking', severity: 'high', level: 'account', id: d.account.id, name: d.account.name, message: `The pixel ${d.pixel.id} has ${last ? `not fired since ${last.toISOString()}` : 'no recorded activity'}.`,
        suggestion: 'Purchases may be missing from Meta: check the pixel before judging campaigns.', metrics: { pixel: d.pixel.id }, evidence: 'observed_pattern' });
    }
  }
  const so = d.skyfly_orders;
  if (so && so.orders >= MIN.purchases && (t.purchases ?? 0) >= 0) {
    const diff = pct(t.purchases ?? 0, so.orders);
    if (diff != null && Math.abs(diff) >= 50) {
      add({ kind: 'tracking', severity: 'low', level: 'account', id: d.account.id, name: d.account.name, message: `Meta reports ${t.purchases ?? 0} purchase(s); Skyfly recorded ${so.orders} real order(s) in the same dates.`,
        suggestion: 'Some difference is normal (attribution, other channels, cash-on-delivery); a large gap can mean missing or duplicated purchase events.', metrics: { meta_purchases: t.purchases ?? 0, skyfly_orders: so.orders }, evidence: 'observed_pattern' });
    }
  }
  return out;
}

// ---------- What ChatGPT receives and must return
const EVIDENCE = ['statistical', 'observed_pattern', 'probable_cause', 'speculation'];
const LEVELS = ['account', 'campaign', 'adset', 'ad'];
export const ACTIONS = ['keep_running', 'monitor', 'pause', 'reduce_budget', 'increase_budget', 'test_audience', 'test_creative', 'change_hook', 'improve_copy',
  'improve_landing_page', 'change_offer', 'adjust_structure', 'consolidate', 'avoid_duplication', 'run_controlled_test', 'fix_tracking'];
// Actions that would change something in Meta: only ever proposed for the owner's approval.
export const META_CHANGING = new Set(['pause', 'reduce_budget', 'increase_budget', 'adjust_structure', 'consolidate']);
const CATEGORIES = ['campaign', 'creative', 'budget', 'audience', 'testing', 'tracking', 'landing_page', 'offer', 'structure'];
const metric = { type: 'object', additionalProperties: false, required: ['name', 'value'], properties: { name: { type: 'string' }, value: { type: 'string' } } };
const finding = {
  type: 'object', additionalProperties: false, required: ['entity_level', 'entity_id', 'entity_name', 'observation', 'metrics', 'evidence'],
  properties: { entity_level: { type: 'string', enum: LEVELS }, entity_id: { type: 'string' }, entity_name: { type: 'string' }, observation: { type: 'string' },
    metrics: { type: 'array', items: metric }, evidence: { type: 'string', enum: EVIDENCE } },
};
const rec = {
  type: 'object', additionalProperties: false,
  required: ['priority', 'category', 'action', 'entity_level', 'entity_id', 'entity_name', 'observed', 'supporting_metrics', 'why_it_matters', 'recommended_action', 'expected_objective', 'confidence', 'risks', 'needs_more_data', 'evidence'],
  properties: {
    priority: { type: 'integer' }, category: { type: 'string', enum: CATEGORIES }, action: { type: 'string', enum: ACTIONS },
    entity_level: { type: 'string', enum: LEVELS }, entity_id: { type: 'string' }, entity_name: { type: 'string' },
    observed: { type: 'string' }, supporting_metrics: { type: 'array', items: metric }, why_it_matters: { type: 'string' }, recommended_action: { type: 'string' },
    expected_objective: { type: 'string' }, confidence: { type: 'string', enum: ['high', 'medium', 'low'] }, risks: { type: 'string' },
    needs_more_data: { type: 'boolean' }, evidence: { type: 'string', enum: EVIDENCE },
  },
};
const list = (items) => ({ type: 'array', items });
export const SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['summary', 'data_quality', 'working', 'not_working', 'campaigns_needing_attention', 'winning_ads', 'weak_ads', 'tracking_concerns', 'recommendations', 'priority_actions'],
  properties: {
    summary: { type: 'string' },
    data_quality: { type: 'object', additionalProperties: false, required: ['sufficiency', 'notes'], properties: { sufficiency: { type: 'string', enum: ['sufficient', 'limited', 'insufficient'] }, notes: list({ type: 'string' }) } },
    working: list(finding), not_working: list(finding), campaigns_needing_attention: list(finding), winning_ads: list(finding), weak_ads: list(finding), tracking_concerns: list(finding),
    recommendations: list(rec), priority_actions: list({ type: 'string' }),
  },
};

export const INSTRUCTIONS = `You are the performance analyst inside Skyfly's AI Media Buyer: an experienced performance-marketing strategist analysing ONE business's own Meta ad account.
Rules:
- Use ONLY the JSON data provided. Every metric was computed by Skyfly from Meta's numbers. Never invent metrics, results, revenue, benchmarks or history. If something is missing (no purchases tracked, no purchase value so no ROAS, no previous-period data, no product attribution), say so.
- Quote figures exactly as given, with the account currency, and say which dates they cover. Reference entities by the exact id and name in the data (entity_id must be an id from the data; use the ad account id for account-level points).
- Small samples: an entity with fewer than 3 purchases or under 1,000 impressions is NOT enough to call it failing or winning. Say "insufficient data" and set needs_more_data = true rather than recommending pause or budget changes on it.
- Label each point's evidence: statistical (enough volume), observed_pattern, probable_cause, or speculation. Be honest about uncertainty, but be decisive where the numbers are clear.
- No generic advice ("improve your ads"). Each recommendation: what was observed, the supporting figures, why it matters, the specific action, the expected objective, confidence, risks, and whether more data is needed.
- Budget recommendations must respect the business's stated daily budget (profile.daily_budget) when given; changes should be gradual (about 20% at a time).
- You only recommend. Pausing, budget changes and structural changes are proposals the owner must approve in Skyfly; never say anything has been changed.
- signals are rule-based checks Skyfly already ran on this data: confirm, refine or explain them; do not contradict them without pointing to data.
- Product: Meta does not attribute purchases to products. skyfly_orders shows Skyfly's own orders by product for the same dates (real orders only); use it for product context only, never as ad attribution.
- If partial_day is true, today's data is incomplete. If truncated is true, the account is very large: only the highest-spend ads and ad sets are included.
- Plain, practical language for a busy business owner. 3 to 10 recommendations, most important first. priority_actions: 3 to 6 short imperative lines in order.`;

// The business's own context (no customer data): profile, products, real-order totals by product.
async function businessContext(pool, businessId, w, productId) {
  const [{ rows: [p] }, { rows: products }, { rows: orders }] = await Promise.all([
    pool.query('SELECT offer, prices, locations, audience, goals, daily_budget_minor FROM ad_profiles WHERE business_id = $1', [businessId]),
    pool.query('SELECT id, name, price_minor FROM products WHERE business_id = $1 ORDER BY id LIMIT 50', [businessId]),
    pool.query(`SELECT i.product_id, i.product_name, count(DISTINCT o.id)::int AS orders, sum(i.quantity)::int AS units, sum(i.line_total_minor)::bigint AS revenue_minor
                  FROM orders o JOIN order_items i ON i.order_id = o.id
                 WHERE o.business_id = $1 AND NOT o.is_test AND o.status NOT IN ('cancelled', 'returned')
                   AND o.created_at::date BETWEEN $2::date AND $3::date
                 GROUP BY 1, 2 ORDER BY 3 DESC LIMIT 30`, [businessId, w.since, w.until]),
  ]);
  const { rows: [tot] } = await pool.query(`SELECT count(*)::int AS orders, coalesce(sum(total_minor), 0)::bigint AS revenue_minor FROM orders
    WHERE business_id = $1 AND NOT is_test AND status NOT IN ('cancelled', 'returned') AND created_at::date BETWEEN $2::date AND $3::date`, [businessId, w.since, w.until]);
  const focus = productId ? products.find((x) => String(x.id) === String(productId)) : null;
  if (productId && !focus) throw new AnalystError('That product is not in this business.', 404);
  return {
    profile: p ? { offer: p.offer, prices: p.prices, locations: p.locations, audience: p.audience, goals: p.goals, daily_budget: p.daily_budget_minor == null ? null : Number(p.daily_budget_minor) / 100 } : null,
    products: products.map((x) => ({ id: String(x.id), name: x.name, price: Number(x.price_minor) / 100 })),
    focus_product: focus ? { id: String(focus.id), name: focus.name } : null,
    skyfly_orders: { orders: tot.orders, revenue: Number(tot.revenue_minor) / 100, note: 'Real (non-test) Skyfly orders, all channels, same dates (UTC).',
      by_product: orders.map((o) => ({ product_id: o.product_id ? String(o.product_id) : null, product: o.product_name, orders: o.orders, units: o.units, revenue: Number(o.revenue_minor) / 100 })) },
  };
}

// ---------- OpenAI call (Responses API, strict JSON schema), with clear errors
async function callOpenAI(config, input, { attempt = 1 } = {}) {
  const a = config.analyst;
  let res;
  try {
    res = await fetch(`${a.apiBase}/v1/responses`, {
      method: 'POST', signal: AbortSignal.timeout(a.timeoutMs ?? 120000),
      headers: { 'content-type': 'application/json', authorization: `Bearer ${a.apiKey}` },
      body: JSON.stringify({
        model: a.model, instructions: INSTRUCTIONS, input, store: false, max_output_tokens: 16000,
        ...(/^(gpt-5|o\d)/.test(a.model) ? { reasoning: { effort: a.reasoningEffort ?? 'medium' } } : {}),
        text: { format: { type: 'json_schema', name: 'campaign_analysis', schema: SCHEMA, strict: true } },
      }),
    });
  } catch (err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') throw new AnalystError('ChatGPT took too long to answer. Nothing was changed; try again (a shorter date range or one campaign is faster).', 504);
    throw new AnalystError('ChatGPT could not be reached. Nothing was changed; try again shortly.', 502);
  }
  const j = await res.json().catch(() => ({}));
  if (res.status === 401) throw new AnalystError('OpenAI refused the API key (OPENAI_API_KEY is invalid or revoked).', 502);
  if (res.status === 429) {
    if (attempt < 2 && !/quota/i.test(j.error?.code ?? j.error?.message ?? '')) {
      await new Promise((r) => setTimeout(r, Math.min(Number(res.headers.get('retry-after')) || 2, 5) * 1000));
      return callOpenAI(config, input, { attempt: attempt + 1 });
    }
    throw new AnalystError(/quota/i.test(j.error?.code ?? j.error?.message ?? '') ? 'The OpenAI account has run out of quota or credit.' : 'OpenAI is rate-limiting requests right now; try again in a minute.', 503);
  }
  if (res.status >= 500 && attempt < 2) return callOpenAI(config, input, { attempt: attempt + 1 });
  if (!res.ok) throw new AnalystError(`ChatGPT could not answer (${String(j.error?.message ?? `HTTP ${res.status}`).slice(0, 200)}).`, 502);
  if (j.status === 'incomplete') throw new AnalystError(`ChatGPT's answer was cut short (${j.incomplete_details?.reason ?? 'incomplete'}); try a shorter date range or one campaign.`, 502);
  const parts = (j.output ?? []).flatMap((o) => o.content ?? []);
  const refusal = parts.find((c) => c.type === 'refusal');
  if (refusal) throw new AnalystError('ChatGPT declined to analyse this data.', 502);
  const text = j.output_text ?? parts.filter((c) => c.type === 'output_text').map((c) => c.text).join('');
  try { return JSON.parse(text); } catch { throw new AnalystError('ChatGPT returned an answer in an unexpected format. Nothing was saved; try again.', 502); }
}

// Strict check of the answer's shape (independent of OpenAI's own schema enforcement).
function conforms(v, s) {
  if (s.enum && !s.enum.includes(v)) return false;
  if (s.type === 'string') return typeof v === 'string';
  if (s.type === 'boolean') return typeof v === 'boolean';
  if (s.type === 'integer') return Number.isInteger(v);
  if (s.type === 'array') return Array.isArray(v) && v.every((x) => conforms(x, s.items));
  if (s.type === 'object') return v && typeof v === 'object' && !Array.isArray(v) && s.required.every((k) => k in v) && Object.keys(v).every((k) => s.properties[k] && conforms(v[k], s.properties[k]));
  return false;
}
export const validResult = (r) => conforms(r, SCHEMA);

// Every entity quoted must exist in this account's data; every number quoted must match the data.
function numbersOf(o, out = []) {
  if (o == null) return out;
  if (typeof o === 'number') out.push(o);
  else if (typeof o === 'object') Object.values(o).forEach((v) => numbersOf(v, out));
  return out;
}
export function ground(result, data) {
  const ents = new Map([[String(data.account.id), data.totals], [`act_${data.account.id}`, data.totals]]);
  for (const c of data.campaigns) ents.set(String(c.id), c);
  for (const s of data.adsets) ents.set(String(s.id), s);
  for (const a of data.ads) ents.set(String(a.id), a);
  const pool = numbersOf([data.totals, data.previous_totals, data.campaigns, data.adsets, data.ads, data.signals, data.business?.skyfly_orders, data.business?.profile, data.business?.products, data.window.days]);
  const known = (n) => pool.some((x) => Math.abs(Math.abs(x) - n) <= Math.max(0.011, Math.abs(x) * 0.01));
  // Numbers quoted in a metric value (dates and times removed; thousands separators allowed; sign ignored).
  const figures = (metrics) => metrics.flatMap((m) => (String(m.value).replace(/\d{4}-\d{2}-\d{2}(T[\d:.]+Z?)?/g, ' ').replace(/(\d),(?=\d{3})/g, '$1').match(/\d+(?:\.\d+)?/g) ?? []).map(Number));
  const check = (x, metricsKey) => {
    const entity = x.entity_level === 'account' ? true : ents.has(String(x.entity_id));
    const nums = figures(x[metricsKey] ?? []);
    return { entity_known: entity, grounded: entity && nums.every(known) };
  };
  const removed = [];
  const keep = (arr, key) => arr.map((x) => ({ ...x, ...check(x, key) })).filter((x) => (x.entity_known ? true : (removed.push(x.entity_name || x.entity_id), false)));
  const out = { ...result };
  for (const k of ['working', 'not_working', 'campaigns_needing_attention', 'winning_ads', 'weak_ads', 'tracking_concerns']) out[k] = keep(result[k], 'metrics');
  out.recommendations = keep(result.recommendations, 'supporting_metrics')
    .map((r) => ({ ...r, priority: Math.min(5, Math.max(1, r.priority)), needs_approval: META_CHANGING.has(r.action) }))
    .sort((a, b) => a.priority - b.priority);
  out.removed_unverifiable = removed;
  return out;
}

// ---------- Run one analysis for THIS business and one of ITS ad accounts
export async function analyze(pool, config, { businessId, userId, adAccountId = null, period = 'last_7d', since = null, until = null, campaignId = null, productId = null }) {
  if (!analystReady(config)) throw new AnalystError('ChatGPT is not switched on yet: OPENAI_API_KEY is not set on the server.', 409);
  const accounts = await listConnections(pool, businessId);
  const acct = adAccountId ? accounts.find((a) => a.ad_account_id === String(adAccountId).replace(/^act_/, '')) : (accounts.find((a) => a.selected) ?? accounts[0]);
  if (!acct) throw new AnalystError(adAccountId ? 'That ad account is not connected to this business.' : 'Connect a Meta ad account first.', adAccountId ? 404 : 409);
  // Spend control: one analysis at a time per business, and a daily cap.
  const { rows: [recent] } = await pool.query(`SELECT count(*) FILTER (WHERE created_at > now() - interval '45 seconds')::int AS just_now,
                                                      count(*) FILTER (WHERE created_at > now() - interval '24 hours')::int AS today
                                                 FROM ad_analyses WHERE business_id = $1`, [businessId]);
  if (recent.just_now) throw new AnalystError('An analysis was just run for this business; wait a minute before running another.', 429);
  if (recent.today >= (config.analyst.dailyLimit ?? 30)) throw new AnalystError('This business has reached today\'s limit of ChatGPT analyses.', 429);

  let data;
  try {
    data = await analysisData(pool, config, businessId, acct.ad_account_id, { period, since, until, campaignId });
  } catch (err) { if (err instanceof MetaError) throw new AnalystError(err.message, err.status === 404 ? 404 : 409); throw err; }
  data.business = await businessContext(pool, businessId, data.window, productId);
  const { rows: [m] } = await pool.query('SELECT * FROM ad_monitor_settings WHERE business_id = $1', [businessId]);
  data.signals = signals(data, thresholdsOf(m));
  const scope = { period: data.period, since: data.window.since, until: data.window.until, campaign_id: data.campaign_filter, product_id: productId ? String(productId) : null };
  const save = (status, result, error) => pool.query(
    `INSERT INTO ad_analyses (business_id, ad_account_id, scope, data, data_fetched_at, result, model, status, error, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
    [businessId, acct.ad_account_id, JSON.stringify(scope), JSON.stringify(data), data.fetched_at, result ? JSON.stringify(result) : null, config.analyst.model, status, error, userId ?? null]).then((r) => r.rows[0].id);

  // Very large accounts: keep the highest-spend ads and ad sets so the data stays complete JSON.
  for (const [k, n] of [['ads', 100], ['adsets', 100], ['ads', 40], ['adsets', 40]]) {
    if (JSON.stringify(data).length <= 180000) break;
    data[k] = [...data[k]].sort((x, y) => (y.metrics?.spend ?? 0) - (x.metrics?.spend ?? 0)).slice(0, n);
    data.truncated = true;
  }
  const input = `Analyse this ad account for the dates ${data.window.since} to ${data.window.until}${data.campaign_filter ? ` (campaign ${data.campaign_filter} only)` : ''}${data.business.focus_product ? `, with attention to the product "${data.business.focus_product.name}"` : ''}. Data fetched from Meta at ${data.fetched_at}.\n\nDATA (JSON):\n${JSON.stringify(data)}`;
  let result;
  try {
    result = await callOpenAI(config, input);
    if (!validResult(result)) throw new AnalystError('ChatGPT returned an answer in an unexpected format. Nothing was saved; try again.', 502);
  } catch (err) {
    if (!(err instanceof AnalystError)) throw err;
    await save('failed', null, err.message);
    throw err;
  }
  return save('ok', ground(result, data), null);
}

export async function latestAnalysis(pool, businessId, adAccountId) {
  const { rows: [a] } = await pool.query("SELECT id, scope, result, data_fetched_at, created_at FROM ad_analyses WHERE business_id = $1 AND ad_account_id = $2 AND status = 'ok' ORDER BY id DESC LIMIT 1", [businessId, adAccountId]);
  return a ?? null;
}

// ---------- Monitoring (rule-based, no AI cost, never changes Meta): alerts for businesses that switched it on
export const thresholdsOf = (m) => ({
  cpa_threshold: m?.cpa_threshold_minor ? Number(m.cpa_threshold_minor) / 100 : null,
  no_conversion_spend: m?.no_conversion_spend_minor ? Number(m.no_conversion_spend_minor) / 100 : null,
  ctr_drop_pct: m?.ctr_drop_pct ?? DEFAULT_THRESHOLDS.ctr_drop_pct, frequency_max: m ? Number(m.frequency_max) : DEFAULT_THRESHOLDS.frequency_max,
});
export async function monitorBusiness(pool, config, businessId, { now = new Date() } = {}) {
  const { rows: [m] } = await pool.query('SELECT * FROM ad_monitor_settings WHERE business_id = $1', [businessId]);
  const accounts = await listConnections(pool, businessId);
  const acct = accounts.find((a) => a.selected) ?? accounts[0];
  if (!acct || acct.status !== 'verified') return { alerts: 0, skipped: 'no verified ad account' };
  const data = await analysisData(pool, config, businessId, acct.ad_account_id, { period: 'last_7d' });
  const day = now.toISOString().slice(0, 10);
  let made = 0;
  for (const s of signals(data, thresholdsOf(m))) {
    if (s.kind === 'insufficient_data') continue;
    const { rowCount } = await pool.query(
      `INSERT INTO ad_alerts (business_id, ad_account_id, kind, severity, entity_level, entity_id, entity_name, message, suggestion, metrics, dedupe_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) ON CONFLICT (business_id, dedupe_key) DO NOTHING`,
      [businessId, acct.ad_account_id, s.kind, s.severity, s.level, s.id, s.name, s.message, s.suggestion, JSON.stringify(s.metrics), `${acct.ad_account_id}:${s.kind}:${s.id}:${day}`]);
    made += rowCount;
  }
  return { alerts: made };
}
export async function runAdMonitoring(pool, config, { limit = 20 } = {}) {
  const { rows } = await pool.query(`SELECT business_id FROM ad_monitor_settings
    WHERE enabled AND (last_run_at IS NULL OR last_run_at < now() - make_interval(hours => interval_hours)) ORDER BY last_run_at NULLS FIRST LIMIT $1`, [limit]);
  let alerts = 0;
  for (const { business_id: id } of rows) {
    try {
      const r = await monitorBusiness(pool, config, id);
      alerts += r.alerts;
      await pool.query('UPDATE ad_monitor_settings SET last_run_at = now(), last_error = $2 WHERE business_id = $1', [id, r.skipped ?? null]);
    } catch (err) {
      await pool.query('UPDATE ad_monitor_settings SET last_run_at = now(), last_error = $2 WHERE business_id = $1', [id, String(err.message).slice(0, 300)]);
    }
  }
  return { businesses: rows.length, alerts };
}
