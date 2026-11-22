// WhatsApp Conversion Audit (inside the AI Media Buyer): from ad impression to paying customer.
//
// Sources, each labelled in the report:
//   - Meta (read-only): messaging campaigns' spend, reach, clicks, conversations started, new contacts,
//     conversation depth (2+/3+/5+ customer messages), blocks, purchases reported to Meta, settings
//     (optimisation goal, destination, audience, placements) and ad copy, for 7, 14 and 30 days.
//   - Skyfly orders (real orders, by source) for the same 30 days.
//   - The WhatsApp lead log the sales team imports (CSV): response times, furthest stage, follow-ups,
//     outcome, agent. No names, phone numbers or message text are stored (a phone number given as the
//     lead ID is hashed with the business ID and discarded).
// Skyfly computes the funnel and rule-based findings itself; ChatGPT (primary) or Claude (second opinion)
// explains them and writes the test plan and sales scripts. Stages without data are shown as "not measured".
import { createHash } from 'node:crypto';
import { withAccount, metricsOf, MetaError } from './metaAds.js';
import { AnalystError, SECURITY_RULES, ENGINES, engineList, runEngines, wrapData, selectedAccount } from './analyst.js';

export const STAGES = ['messaged', 'responded', 'engaged', 'price_sent', 'order_intent', 'ordered', 'paid', 'delivered', 'repeat'];
const STAGE_LABEL = { messaged: 'Customer messaged', responded: 'Business replied', engaged: 'Customer continued the conversation', price_sent: 'Price / offer presented',
  order_intent: 'Order intent', ordered: 'Order created', paid: 'Paid or COD confirmed', delivered: 'Delivered', repeat: 'Repeat customer' };
const MESSAGING_DEST = new Set(['WHATSAPP', 'MESSENGER', 'INSTAGRAM_DIRECT', 'MESSAGING_MESSENGER_WHATSAPP', 'MESSAGING_INSTAGRAM_DIRECT_MESSENGER', 'MESSAGING_INSTAGRAM_DIRECT_MESSENGER_WHATSAPP', 'MESSAGING_INSTAGRAM_DIRECT_WHATSAPP']);
const A = (row, t) => Number((row?.actions ?? []).find((x) => x.action_type === t)?.value ?? 0);
// Null when Meta did not report the action at all (Meta omits some messaging depths for some setups).
const An = (row, t) => { const a = (row?.actions ?? []).find((x) => x.action_type === t); return a ? Number(a.value) : null; };
const CITIES = ['Lagos', 'Abuja', 'Port Harcourt', 'Ibadan', 'Kano', 'Benin', 'Enugu', 'Kaduna', 'Owerri', 'Abeokuta', 'Ikorodu', 'Lekki', 'Ikeja', 'Ogun', 'Warri', 'Uyo', 'Calabar', 'Jos', 'Ilorin', 'Asaba'];
const pctOf = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : null);
const r2 = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 100) / 100);

function messagingMetrics(row) {
  const m = metricsOf(row);
  const conv = A(row, 'onsite_conversion.messaging_conversation_started_7d');
  const msgPurchases = A(row, 'onsite_conversion.purchase');
  return {
    spend: m.spend, impressions: m.impressions, reach: m.reach, frequency: m.frequency, link_clicks: m.link_clicks, ctr: m.ctr, cpm: m.cpm, cpc: m.cpc,
    conversations: conv, new_contacts: A(row, 'onsite_conversion.messaging_first_reply'), total_contacts: A(row, 'onsite_conversion.total_messaging_connection'),
    depth_2: A(row, 'onsite_conversion.messaging_user_depth_2_message_send'), depth_3: A(row, 'onsite_conversion.messaging_user_depth_3_message_send'),
    depth_5: An(row, 'onsite_conversion.messaging_user_depth_5_message_send'), blocks: A(row, 'onsite_conversion.messaging_block'),
    purchases_reported_to_meta: Math.max(m.purchases, msgPurchases), purchase_value: m.purchase_value,
    cost_per_conversation: conv ? r2(m.spend / conv) : null,
  };
}

// ---------- Meta (read-only)
export async function messagingData(pool, config, businessId, adAccountId) {
  const acc = await withAccount(pool, config, businessId, adAccountId);
  const fields = 'campaign_id,campaign_name,spend,impressions,reach,frequency,clicks,inline_link_clicks,ctr,cpc,cpm,actions,action_values';
  const [campaigns, adsets, ads, ...wins] = await Promise.all([
    acc.get(`${acc.act}/campaigns`, { fields: 'id,name,objective,effective_status,daily_budget,lifetime_budget,start_time', limit: '200' }),
    acc.get(`${acc.act}/adsets`, { fields: 'id,name,campaign_id,effective_status,optimization_goal,destination_type,daily_budget,targeting', limit: '300' }),
    acc.get(`${acc.act}/ads`, { fields: 'id,name,campaign_id,adset_id,effective_status,creative{body,title,object_type,call_to_action_type}', limit: '300' }),
    ...['last_7d', 'last_14d', 'last_30d'].map((p) => acc.get(`${acc.act}/insights`, { level: 'campaign', date_preset: p, fields, limit: '200' })),
  ]);
  const byWin = Object.fromEntries(['7d', '14d', '30d'].map((k, i) => [k, Object.fromEntries((wins[i].data ?? []).map((r) => [r.campaign_id, r]))]));
  const sets = adsets.data ?? [];
  const isMessaging = (id) => sets.some((s) => s.campaign_id === id && MESSAGING_DEST.has(s.destination_type)) || A(byWin['30d'][id], 'onsite_conversion.messaging_conversation_started_7d') > 0;
  const camps = (campaigns.data ?? []).filter((c) => byWin['30d'][c.id] || byWin['7d'][c.id]);
  const messagingIds = camps.filter((c) => isMessaging(c.id)).map((c) => c.id);
  const placements = messagingIds.length ? await acc.get(`${acc.act}/insights`, {
    level: 'campaign', date_preset: 'last_30d', breakdowns: 'publisher_platform', fields: 'campaign_id,spend,actions', limit: '500',
    filtering: [{ field: 'campaign.id', operator: 'IN', value: messagingIds }],
  }).catch(() => ({ data: [] })) : { data: [] };
  const platform = {};
  for (const r of placements.data ?? []) {
    const p = (platform[r.publisher_platform] ??= { spend: 0, conversations: 0 });
    p.spend = r2(p.spend + Number(r.spend ?? 0)); p.conversations += A(r, 'onsite_conversion.messaging_conversation_started_7d');
  }
  const targetingOf = (t) => (t ? {
    age: `${t.age_min ?? 18}-${t.age_max ?? 65}`, genders: t.genders?.length ? t.genders.map((g) => (g === 1 ? 'men' : 'women')) : 'all',
    cities: (t.geo_locations?.cities ?? []).map((c) => c.name), regions: (t.geo_locations?.regions ?? []).map((c) => c.name), countries: t.geo_locations?.countries ?? [],
    advantage_audience: t.targeting_automation?.advantage_audience === 1,
  } : null);
  const sum = (ids, win) => {
    const rows = ids.map((id) => byWin[win][id]).filter(Boolean);
    const total = {};
    for (const r of rows) for (const [k, v] of Object.entries(messagingMetrics(r))) if (typeof v === 'number') total[k] = r2((total[k] ?? 0) + v);
    if (total.depth_5 === undefined) total.depth_5 = null; // not reported by Meta
    total.cost_per_conversation = total.conversations ? r2(total.spend / total.conversations) : null;
    total.frequency = null; // not additive across campaigns
    return total;
  };
  const other = camps.filter((c) => !messagingIds.includes(c.id)).map((c) => c.id);
  return {
    fetched_at: new Date().toISOString(), account: { id: acc.connection.ad_account_id, name: acc.connection.ad_account_name, currency: acc.connection.currency },
    windows: Object.fromEntries(['7d', '14d', '30d'].map((w) => [w, sum(messagingIds, w)])),
    campaigns: camps.filter((c) => messagingIds.includes(c.id)).map((c) => ({
      id: c.id, name: c.name, objective: c.objective, status: c.effective_status, daily_budget: c.daily_budget ? Number(c.daily_budget) / 100 : null, start_time: c.start_time,
      windows: Object.fromEntries(['7d', '14d', '30d'].map((w) => [w, byWin[w][c.id] ? messagingMetrics(byWin[w][c.id]) : null])),
      adsets: sets.filter((s) => s.campaign_id === c.id).map((s) => ({ id: s.id, name: s.name, status: s.effective_status, optimization_goal: s.optimization_goal, destination: s.destination_type, targeting: targetingOf(s.targeting) })),
      ads: (ads.data ?? []).filter((a) => a.campaign_id === c.id).slice(0, 10).map((a) => ({ id: a.id, name: a.name, status: a.effective_status, body: a.creative?.body ? String(a.creative.body).slice(0, 1200) : null, title: a.creative?.title ?? null, format: a.creative?.object_type ?? null, cta: a.creative?.call_to_action_type ?? null })),
    })),
    placements_30d: platform,
    website_campaigns_30d: (() => {
      const rows = other.map((id) => byWin['30d'][id]).filter(Boolean).map(metricsOf);
      const spend = r2(rows.reduce((s, x) => s + x.spend, 0)); const purchases = rows.reduce((s, x) => s + x.purchases, 0);
      return { campaigns: rows.length, spend, purchases, cost_per_purchase: purchases ? r2(spend / purchases) : null };
    })(),
  };
}

// ---------- Skyfly data for the same 30 days
async function skyflyData(pool, businessId) {
  const { rows: bySource } = await pool.query(`SELECT source, count(*)::int AS orders, coalesce(sum(total_minor), 0)::bigint AS revenue_minor,
      count(*) FILTER (WHERE status = 'delivered')::int AS delivered, count(*) FILTER (WHERE status IN ('cancelled', 'returned'))::int AS cancelled_or_returned
    FROM orders WHERE business_id = $1 AND NOT is_test AND created_at > now() - interval '30 days' GROUP BY 1 ORDER BY 1`, [businessId]);
  const { rows: utm } = await pool.query(`SELECT lower(utm_source) AS utm_source, count(*)::int AS orders FROM orders
    WHERE business_id = $1 AND NOT is_test AND created_at > now() - interval '30 days' AND utm_source IS NOT NULL GROUP BY 1 ORDER BY 2 DESC LIMIT 10`, [businessId]);
  const [{ rows: products }, { rows: [p] }] = await Promise.all([
    pool.query('SELECT name, price_minor FROM products WHERE business_id = $1 ORDER BY id LIMIT 30', [businessId]),
    pool.query('SELECT offer, prices, locations, audience, customer_profile, goals, daily_budget_minor, brand_voice FROM ad_profiles WHERE business_id = $1', [businessId]),
  ]);
  return {
    orders_by_source: bySource.map((r) => ({ source: r.source, orders: r.orders, revenue: Number(r.revenue_minor) / 100, delivered: r.delivered, cancelled_or_returned: r.cancelled_or_returned })),
    orders_by_utm_source: utm, note: 'Real (non-test) Skyfly orders, last 30 days. "manual" orders were entered by the team (often WhatsApp or phone orders); Skyfly cannot tell which ad they came from.',
    products: products.map((x) => ({ name: x.name, price: Number(x.price_minor) / 100 })),
    profile: p ? { ...p, daily_budget: p.daily_budget_minor == null ? null : Number(p.daily_budget_minor) / 100, daily_budget_minor: undefined } : null,
  };
}

// ---------- The WhatsApp lead log (aggregates only)
const quantile = (arr, q) => { if (!arr.length) return null; const s = [...arr].sort((a, b) => a - b); return Math.round(s[Math.min(s.length - 1, Math.floor(q * s.length))]); };
export async function leadLogSummary(pool, businessId) {
  const { rows } = await pool.query(`SELECT stage, furthest_stage, first_message_at, first_response_at, follow_ups, agent, campaign_ref, lost_reason, order_value_minor
    FROM wa_leads WHERE business_id = $1 AND first_message_at > now() - interval '30 days'`, [businessId]);
  if (!rows.length) return { available: false, leads: 0 };
  const reach = (r) => STAGES.indexOf(r.stage === 'lost' ? (r.furthest_stage ?? 'messaged') : r.stage);
  const reached = Object.fromEntries(STAGES.map((s, i) => [s, rows.filter((r) => reach(r) >= i).length]));
  const mins = rows.filter((r) => r.first_response_at).map((r) => (new Date(r.first_response_at) - new Date(r.first_message_at)) / 60000).filter((m) => m >= 0);
  const notOrdered = rows.filter((r) => reach(r) < STAGES.indexOf('ordered'));
  const count = (list, key) => Object.entries(list.reduce((o, r) => { const k = r[key] || 'not given'; o[k] = (o[k] ?? 0) + 1; return o; }, {})).sort((a, b) => b[1] - a[1]);
  const agents = count(rows, 'agent').filter(([, n]) => n >= 10).map(([agent, n]) => {
    const mine = rows.filter((r) => (r.agent || 'not given') === agent);
    const m = mine.filter((r) => r.first_response_at).map((r) => (new Date(r.first_response_at) - new Date(r.first_message_at)) / 60000);
    return { agent, leads: n, median_response_minutes: quantile(m, 0.5), ordered_pct: pctOf(mine.filter((r) => reach(r) >= STAGES.indexOf('ordered')).length, n) };
  });
  return {
    available: true, leads: rows.length, reached,
    response: { answered: mins.length, unanswered: rows.length - mins.length, median_minutes: quantile(mins, 0.5), p90_minutes: quantile(mins, 0.9),
      within_5_min_pct: pctOf(mins.filter((m) => m <= 5).length, rows.length), within_60_min_pct: pctOf(mins.filter((m) => m <= 60).length, rows.length) },
    follow_up: { not_ordered: notOrdered.length, never_followed_up: notOrdered.filter((r) => !r.follow_ups).length, followed_up_2_plus: notOrdered.filter((r) => r.follow_ups >= 2).length },
    lost_reasons: count(rows.filter((r) => r.stage === 'lost'), 'lost_reason').slice(0, 8).map(([reason, n]) => ({ reason: String(reason).slice(0, 80), leads: n })),
    by_campaign: count(rows, 'campaign_ref').slice(0, 10).map(([campaign, n]) => ({ campaign: String(campaign).slice(0, 80), leads: n, ordered: rows.filter((r) => (r.campaign_ref || 'not given') === campaign && reach(r) >= STAGES.indexOf('ordered')).length })),
    agents_with_10_plus_leads: agents,
    order_value_total: rows.reduce((s, r) => s + Number(r.order_value_minor ?? 0), 0) / 100,
  };
}

// ---------- Funnel and rule-based findings (Skyfly's own computation)
export function funnelOf(meta, log) {
  const w = meta.windows['30d'];
  const st = [
    { key: 'impressions', label: 'Ad impressions', count: w.impressions ?? 0, source: 'Meta' },
    { key: 'link_clicks', label: 'Ad clicks (link)', count: w.link_clicks ?? 0, source: 'Meta' },
    { key: 'conversations', label: 'WhatsApp conversation started', count: w.conversations ?? 0, source: 'Meta' },
    { key: 'depth_2', label: 'Customer sent 2+ messages', count: w.depth_2 ?? 0, source: 'Meta' },
    { key: 'depth_3', label: 'Customer sent 3+ messages', count: w.depth_3 ?? 0, source: 'Meta' },
    { key: 'depth_5', label: 'Customer sent 5+ messages', count: w.depth_5 ?? null, source: w.depth_5 == null ? 'not reported by Meta' : 'Meta' },
    ...STAGES.slice(1).map((s) => ({ key: s, label: STAGE_LABEL[s], count: log.available ? log.reached[s] : null, source: log.available ? 'WhatsApp lead log' : 'not measured (no lead log imported)' })),
  ];
  let biggest = null;
  for (let i = 1; i < st.length; i++) {
    const prev = st[i - 1]; const cur = st[i];
    cur.rate_from_previous = prev.count && cur.count != null ? pctOf(cur.count, prev.count) : null;
    if (i >= 3 && prev.count >= 20 && cur.count != null && prev.source === cur.source) {
      const lost = 1 - cur.count / prev.count;
      if (!biggest || lost * 100 > biggest.lost_share) biggest = { from: prev.label, to: cur.label, lost_share: Math.round(lost * 1000) / 10, lost: prev.count - cur.count };
    }
  }
  return { stages: st, biggest_measured_drop: biggest };
}

export function findings(meta, log, sky) {
  const out = [];
  const w = meta.windows['30d'];
  const add = (area, status, finding, evidence) => out.push({ area, status, finding, evidence });
  const sets = meta.campaigns.flatMap((c) => c.adsets.map((s) => ({ ...s, spend: c.windows['30d']?.spend ?? 0 })));
  const convGoal = meta.campaigns.filter((c) => c.adsets.some((s) => s.optimization_goal === 'CONVERSATIONS'));
  const convSpend = r2(convGoal.reduce((s, c) => s + (c.windows['30d']?.spend ?? 0), 0));
  if (!meta.campaigns.length) { add('tracking', 'confirmed', 'No messaging campaigns with delivery in the last 30 days in this ad account.', { messaging_campaigns: 0 }); return out; }
  if (convSpend) add('optimisation', 'confirmed', `${convGoal.length} messaging campaign(s), ${convSpend} spent in 30 days, optimise for conversations started, not for purchases: Meta looks for people likely to send a message, whether or not they buy.`, { campaigns: convGoal.length, spend_30d: convSpend });
  if (w.conversations) {
    add('ads', 'confirmed', `Conversations cost ${w.cost_per_conversation} each (${w.conversations} conversations, ${w.spend} spent, 30 days).`, { cost_per_conversation: w.cost_per_conversation, conversations: w.conversations, spend: w.spend });
    const one = w.conversations - (w.depth_2 ?? 0);
    add('whatsapp_process', 'confirmed', `${pctOf(one, w.conversations)}% of conversations (${one} of ${w.conversations}) never got past the customer's first message; ${pctOf(w.depth_3, w.conversations)}% reached 3 messages${w.depth_5 == null ? ' (Meta does not report 5+ messages for these campaigns)' : ` and ${pctOf(w.depth_5, w.conversations)}% reached 5`}.`, { conversations: w.conversations, depth_2: w.depth_2, depth_3: w.depth_3, depth_5: w.depth_5 });
  }
  if ((w.purchases_reported_to_meta ?? 0) <= 1 && w.conversations >= 50) add('tracking', 'confirmed', `Only ${w.purchases_reported_to_meta ?? 0} purchase(s) from these conversations were reported back to Meta. Meta cannot see WhatsApp sales unless they are sent to it, so it cannot learn who buys.`, { purchases_reported_to_meta: w.purchases_reported_to_meta ?? 0, conversations: w.conversations });
  const ws = meta.website_campaigns_30d;
  if (ws.purchases && w.conversations) add('ads', 'observed', `For comparison, website-purchase campaigns in the same account: ${ws.spend} spent for ${ws.purchases} tracked purchases (${ws.cost_per_purchase} each).`, ws);
  const bodies = meta.campaigns.flatMap((c) => c.ads.map((a) => a.body).filter(Boolean));
  const keyword = bodies.map((b) => b.match(/send[:\s]*["“'‘]([^"”'’\n]{2,30})["”'’]/i)?.[1]).find(Boolean);
  if (keyword) add('whatsapp_process', 'likely', `The ads ask people to send "${keyword}". A one-message conversation is usually just that keyword; whoever does not get a fast, engaging reply leaves there.`, { prefilled_keyword: keyword });
  const price = bodies.map((b) => b.match(/(₦|NGN)\s?\d[\d,]*/)?.[0]).find(Boolean);
  if (price) add('offer', 'observed', `The ad copy states the price (${price}), so people who message already know it: the conversation has to answer trust, results and delivery, not price.`, { price_in_ad: price });
  const mentioned = [...new Set(bodies.flatMap((b) => CITIES.filter((c) => new RegExp(`\\b${c}\\b`, 'i').test(b))))];
  const targeted = [...new Set(sets.flatMap((s) => [...(s.targeting?.cities ?? []), ...(s.targeting?.regions ?? [])]))];
  const outside = targeted.filter((t) => !mentioned.some((m) => t.toLowerCase().includes(m.toLowerCase())));
  if (mentioned.length && outside.length) add('audience', 'likely', `The ads mention ${mentioned.join(', ')} but the ad sets also target ${outside.slice(0, 6).join(', ')}. People there may message and drop when delivery is unclear.`, { ad_mentions: mentioned.join(', '), also_targeted: outside.slice(0, 6).join(', ') });
  if (sets.some((s) => s.targeting?.advantage_audience)) add('audience', 'observed', 'Advantage+ audience is on in the messaging ad sets, so Meta can go beyond the age, gender and interests you set, towards whoever starts conversations most cheaply.', { advantage_audience: 'on' });
  const tot = Object.values(meta.placements_30d).reduce((s, p) => s + p.spend, 0);
  for (const [pl, p] of Object.entries(meta.placements_30d)) if (tot && ['audience_network', 'messenger', 'threads'].includes(pl) && p.spend / tot >= 0.1) add('placement', 'observed', `${pctOf(p.spend, tot)}% of messaging spend went to ${pl} (${p.conversations} conversations).`, { placement: pl, spend: p.spend, conversations: p.conversations });
  if (!log.available) {
    add('sales_team', 'not_measurable', 'Response time, replies, price presentation, follow-ups and closing cannot be measured: no WhatsApp lead log has been imported into Skyfly.', { lead_log: 'missing' });
  } else {
    const rsp = log.response;
    add('sales_team', 'confirmed', `First replies: median ${rsp.median_minutes} min, 90% within ${rsp.p90_minutes} min; ${rsp.unanswered} of ${log.leads} leads never got a reply; ${rsp.within_5_min_pct}% answered within 5 minutes.`, rsp);
    add('follow_up', 'confirmed', `${log.follow_up.never_followed_up} of ${log.follow_up.not_ordered} leads who did not order were never followed up.`, log.follow_up);
  }
  const manual = sky.orders_by_source.find((x) => x.source === 'manual');
  add('tracking', 'observed', manual ? `${manual.orders} order(s) were entered by hand in Skyfly in 30 days (often WhatsApp or phone orders); Skyfly cannot link them to an ad.` : 'No hand-entered orders in Skyfly in 30 days: WhatsApp sales are not being recorded in Skyfly, so they cannot be matched to ads.', { manual_orders: manual?.orders ?? 0 });
  return out;
}

// ---------- AI: diagnosis, strategy, test plan and sales system
const str = { type: 'string' };
const metric = { type: 'object', additionalProperties: false, required: ['name', 'value'], properties: { name: str, value: str } };
const obj = (props) => ({ type: 'object', additionalProperties: false, required: Object.keys(props), properties: props });
const arr = (items) => ({ type: 'array', items });
export const WA_SCHEMA = obj({
  verdict: obj({ campaigns_working: str, conversation_cost: str, converting_to_customers: str, biggest_leak: str, overall_problem: str }),
  diagnosis: arr(obj({ area: { type: 'string', enum: ['ads', 'audience', 'offer', 'sales_team', 'whatsapp_process', 'follow_up', 'tracking', 'optimisation', 'placement', 'trust', 'delivery', 'other'] }, finding: str, evidence: arr(metric), status: { type: 'string', enum: ['confirmed', 'likely', 'hypothesis', 'not_measurable'] } })),
  strategy: arr(obj({ approach: str, why_supported: str, test_first: { type: 'boolean' } })),
  test_plan: obj({
    objective: str, structure: str, campaigns: { type: 'integer' }, ad_sets: { type: 'integer' }, daily_budget: { type: 'number' }, duration_days: { type: 'integer' }, audience: str,
    creatives: arr(obj({ concept: str, hook: str, primary_text: str, headline: str, opening_message: str })),
    qualification_questions: arr(str), sales_conversation: str, follow_up: str, measurement: str, success_criteria: str, stop_loss: str, scaling_criteria: str,
  }),
  sales_system: obj({
    opening_response: str, product_recommendation_flow: str, qualification: str, price_presentation: str, objection_handling: arr(obj({ objection: str, response: str })),
    trust_building: str, order_confirmation: str, cod_confirmation: str, follow_ups: arr(obj({ timing: str, message: str })), abandoned_conversation_recovery: str,
    abandoned_order_recovery: str, delivery_follow_up: str, repeat_purchase: str,
  }),
  data_gaps: arr(str), tracking_and_integrations: arr(str),
});
export const WA_INSTRUCTIONS = `You are the WhatsApp campaign investigator in Skyfly's AI Media Buyer, working for ONE business. Investigate why WhatsApp messaging ads do or do not turn into paying customers, from ad impression to repeat customer.
Rules:
- Use ONLY the data provided: meta (Meta's numbers for messaging campaigns, 7/14/30 days, labelled windows), funnel and findings (computed by Skyfly), lead_log (the sales team's WhatsApp records, aggregated; may be missing), skyfly (orders, products, profile).
- Never mix reporting windows without naming them. Quote figures with the account currency.
- Separate what the data CONFIRMS from what is LIKELY and what is only a HYPOTHESIS. If a stage is not measured (for example no lead log: response time, follow-ups, closing), say "not measurable" and what data is needed. Never claim the sales team is at fault without lead-log evidence, and never judge individual agents with fewer than 10 leads.
- Do not tell the owner to "change creatives" without saying exactly what and why, tied to the data.
- Strategy: choose only approaches the data supports (direct product, problem-solving, demonstration, offer, bundle, qualification, FAQ, trust-building, retargeting, existing customers...). Mark the one to test first.
- Test plan: financially realistic (1 campaign, 1-2 ad sets, 2-3 creatives unless the data justifies more). daily_budget in the account currency within the business's stated daily budget when given. Include stop-loss and scaling rules in numbers. Recommending a plan is not a live change: everything needs the owner's approval.
- Creatives and scripts: use the actual products, prices and offer in the data. No invented testimonials, results or medical claims; cosmetic products only claim appearance.
- Sales system: concrete messages the team can paste, adapted to the product, the price in the ad and the delivery areas. Include COD confirmation if relevant.
${SECURITY_RULES}`;

export async function runWhatsAppAudit(pool, config, { businessId, userId, adAccountId = null, engine = 'chatgpt' }) {
  if (engine === 'compare') throw new AnalystError('Choose ChatGPT or Claude for the WhatsApp audit.', 400);
  const list = engineList(config, engine);
  const acct = await selectedAccount(pool, businessId, adAccountId);
  const { rows: [recent] } = await pool.query(`SELECT count(*) FILTER (WHERE created_at > now() - interval '45 seconds')::int AS just_now,
      coalesce(sum(CASE WHEN engine = 'compare' THEN 2 ELSE 1 END) FILTER (WHERE created_at > now() - interval '24 hours'), 0)::int AS today FROM ad_analyses WHERE business_id = $1`, [businessId]);
  if (recent.just_now) throw new AnalystError('An analysis was just run for this business; wait a minute before running another.', 429);
  if (recent.today + 1 > (config.analyst?.dailyLimit ?? 30)) throw new AnalystError('This business has reached today\'s limit of AI analyses.', 429);
  let meta;
  try { meta = await messagingData(pool, config, businessId, acct.ad_account_id); } catch (err) { if (err instanceof MetaError) throw new AnalystError(err.message, err.status === 404 ? 404 : 409); throw err; }
  const [log, sky] = await Promise.all([leadLogSummary(pool, businessId), skyflyData(pool, businessId)]);
  const data = { meta, lead_log: log, skyfly: sky, funnel: funnelOf(meta, log), findings: findings(meta, log, sky) };
  const scope = { period: 'last_30d', windows: ['7d', '14d', '30d'] };
  const answers = await runEngines(config, list, { instructions: WA_INSTRUCTIONS, input: wrapData('Investigate this business\'s WhatsApp messaging campaigns and sales funnel.', data), schema: WA_SCHEMA, name: 'whatsapp_audit' }, (r) => conformsWA(r));
  const x = answers[engine];
  const save = (status, result, error) => pool.query(
    `INSERT INTO ad_analyses (business_id, ad_account_id, kind, engine, scope, data, data_fetched_at, result, model, status, error, usage, created_by)
     VALUES ($1, $2, 'whatsapp', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
    [businessId, acct.ad_account_id, engine, JSON.stringify(scope), JSON.stringify(data), meta.fetched_at, result ? JSON.stringify(result) : null, x.model, status, error, JSON.stringify({ [engine]: x.usage ?? null }), userId ?? null]).then((r) => r.rows[0].id);
  if (x.status !== 'ok') { await save('failed', null, x.error); throw new AnalystError(x.error, x.httpStatus); }
  return save('ok', groundWA(x.json, data), null);
}

// Shape check (same strictness as the performance analysis).
function conforms(v, s) {
  if (s.enum && !s.enum.includes(v)) return false;
  if (s.type === 'string') return typeof v === 'string';
  if (s.type === 'boolean') return typeof v === 'boolean';
  if (s.type === 'integer') return Number.isInteger(v);
  if (s.type === 'number') return typeof v === 'number' && Number.isFinite(v);
  if (s.type === 'array') return Array.isArray(v) && v.every((x) => conforms(x, s.items));
  if (s.type === 'object') return v && typeof v === 'object' && !Array.isArray(v) && s.required.every((k) => k in v) && Object.keys(v).every((k) => s.properties[k] && conforms(v[k], s.properties[k]));
  return false;
}
export const conformsWA = (r) => conforms(r, WA_SCHEMA);
function numbersOf(o, out = []) {
  if (typeof o === 'number') out.push(o);
  else if (o && typeof o === 'object') Object.values(o).forEach((v) => numbersOf(v, out));
  else if (typeof o === 'string') (o.replace(/(\d),(?=\d{3})/g, '$1').match(/\d+(?:\.\d+)?/g) ?? []).forEach((n) => out.push(Number(n)));
  return out;
}
// Each diagnosis point's figures must match the data; others are flagged on screen.
export function groundWA(result, data) {
  const pool = numbersOf(data);
  const known = (n) => pool.some((x) => Math.abs(Math.abs(x) - n) <= Math.max(0.011, Math.abs(x) * 0.01));
  return { ...result, diagnosis: result.diagnosis.map((d) => ({ ...d, grounded: d.evidence.every((m) => (String(m.value).replace(/\d{4}-\d{2}-\d{2}/g, ' ').replace(/(\d),(?=\d{3})/g, '$1').match(/\d+(?:\.\d+)?/g) ?? []).map(Number).every(known)) })) };
}

// ---------- Lead log import (CSV). Accepted columns (header names, any order, case-insensitive):
// lead_id or phone, first_message_at, first_response_at, stage, furthest_stage, agent, follow_ups, lost_reason,
// campaign, order_value. Any other column (names, messages...) is ignored and never stored.
export function parseCsv(text) {
  const rows = []; let row = []; let cell = ''; let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') q = false; else cell += ch; continue; }
    if (ch === '"') q = true;
    else if (ch === ',') { row.push(cell); cell = ''; } else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; } else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim()));
}
const ALIASES = { lead_id: ['lead_id', 'lead', 'id', 'conversation_id'], phone: ['phone', 'phone_number', 'whatsapp', 'number'], first_message_at: ['first_message_at', 'first_message', 'message_time', 'date'],
  first_response_at: ['first_response_at', 'first_reply_at', 'first_response', 'reply_time'], stage: ['stage', 'status'], furthest_stage: ['furthest_stage', 'last_stage_reached'], agent: ['agent', 'sales_agent', 'rep'],
  follow_ups: ['follow_ups', 'followups', 'follow_up_count'], lost_reason: ['lost_reason', 'reason'], campaign: ['campaign', 'campaign_ref', 'ad'], order_value: ['order_value', 'value', 'amount'] };
export async function importLeads(pool, businessId, csvText) {
  const rows = parseCsv(String(csvText ?? ''));
  if (rows.length < 2) throw new AnalystError('The file has no lead rows (a header row and at least one lead are needed).');
  if (rows.length > 5001) throw new AnalystError('At most 5,000 leads per file.');
  const head = rows[0].map((h) => h.trim().toLowerCase().replace(/\s+/g, '_'));
  const col = Object.fromEntries(Object.entries(ALIASES).map(([k, names]) => [k, head.findIndex((h) => names.includes(h))]));
  if (col.first_message_at < 0 || col.stage < 0 || (col.lead_id < 0 && col.phone < 0)) throw new AnalystError('Columns needed: lead_id (or phone), first_message_at and stage.');
  const get = (r, k) => (col[k] >= 0 ? String(r[col[k]] ?? '').trim() : '');
  const date = (v) => { if (!v) return null; const d = new Date(v.includes('T') || /\d{1,2}:\d{2}/.test(v) ? v : `${v}T00:00:00Z`); return Number.isNaN(d.getTime()) ? undefined : d; };
  let saved = 0; const skipped = [];
  for (const [i, r] of rows.slice(1).entries()) {
    const line = i + 2;
    const raw = get(r, 'lead_id') || get(r, 'phone').replace(/\D/g, '');
    const stage = get(r, 'stage').toLowerCase().replace(/[\s-]+/g, '_');
    const first = date(get(r, 'first_message_at')); const reply = date(get(r, 'first_response_at'));
    if (!raw || !first || reply === undefined || ![...STAGES, 'lost'].includes(stage)) { skipped.push(line); continue; }
    const furthest = get(r, 'furthest_stage').toLowerCase().replace(/[\s-]+/g, '_');
    // The lead's key: the given ID, or a one-way hash of the phone number with this business (the number is not kept).
    const key = get(r, 'lead_id') ? `id:${get(r, 'lead_id').slice(0, 80)}` : `ph:${createHash('sha256').update(`${businessId}:${raw}`).digest('hex').slice(0, 32)}`;
    const value = Number(get(r, 'order_value').replace(/[^\d.]/g, ''));
    await pool.query(
      `INSERT INTO wa_leads (business_id, lead_key, campaign_ref, first_message_at, first_response_at, stage, furthest_stage, lost_reason, agent, follow_ups, order_value_minor)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (business_id, lead_key) DO UPDATE SET campaign_ref = EXCLUDED.campaign_ref, first_message_at = EXCLUDED.first_message_at, first_response_at = EXCLUDED.first_response_at,
         stage = EXCLUDED.stage, furthest_stage = EXCLUDED.furthest_stage, lost_reason = EXCLUDED.lost_reason, agent = EXCLUDED.agent, follow_ups = EXCLUDED.follow_ups,
         order_value_minor = EXCLUDED.order_value_minor, imported_at = now()`,
      [businessId, key, get(r, 'campaign').slice(0, 120) || null, first, reply, stage, STAGES.includes(furthest) && furthest !== 'repeat' ? furthest : null,
        get(r, 'lost_reason').slice(0, 120) || null, get(r, 'agent').slice(0, 60) || null, Math.max(0, Number.parseInt(get(r, 'follow_ups'), 10) || 0),
        Number.isFinite(value) && value > 0 ? Math.round(value * 100) : null]);
    saved += 1;
  }
  return { saved, skipped };
}
export { ENGINES, STAGE_LABEL };
