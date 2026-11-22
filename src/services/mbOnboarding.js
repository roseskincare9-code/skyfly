// Conversational onboarding for the AI Media Buyer, and the automatic workflow it starts.
//
// The owner talks to the media buyer; each answer is turned (by ChatGPT, or Claude if ChatGPT is off) into
// updates to the business's advertising profile. Skyfly itself decides what is still missing (from the profile,
// the products and pages it already has, and the Meta connection), so nothing already known is asked again,
// and the conversation is saved so the owner can come back to it. Without an AI key the same profile is
// filled in with the form in Advertising Settings.
//
// When the profile is complete and a Meta ad account is connected, Skyfly runs the business analysis and then
// writes the campaign plan on its own (connection health → analysis → plan). The plan waits for the owner's
// approval before anything is created in Meta.
import { listConnections, connectionHealth } from './metaAds.js';
import { AnalystError, ENGINES, runEngines, SECURITY_RULES, analyze } from './analyst.js';
import { generatePlan } from './builder.js';

export const FIELDS = {
  industry: 'Business category', business_location: 'Where the business is based', locations: 'Target markets (cities / countries)', offer: 'Products or services',
  prices: 'Prices', audience: 'Target customer', customer_profile: 'Customer profile and buying reasons', goals: 'Advertising goal (sales, leads, messages...)',
  daily_budget: 'Daily advertising budget', website: 'Website or landing page', social_accounts: 'Social accounts (Facebook Page, Instagram)',
  fulfilment: 'Delivery / fulfilment', payment_methods: 'How customers pay (cash on delivery, transfer, card...)', constraints: 'Anything to avoid or respect',
  brand_voice: 'Brand voice',
};
const REQUIRED = ['industry', 'business_location', 'locations', 'offer', 'prices', 'audience', 'goals', 'daily_budget', 'website', 'fulfilment', 'payment_methods'];
const TEXT_FIELDS = Object.keys(FIELDS).filter((k) => k !== 'daily_budget');

export async function onboardingState(pool, businessId) {
  const [{ rows: [p] }, { rows: [o] }, { rows: [prod] }, { rows: [page] }, accounts] = await Promise.all([
    pool.query('SELECT * FROM ad_profiles WHERE business_id = $1', [businessId]),
    pool.query('SELECT * FROM ad_onboarding WHERE business_id = $1', [businessId]),
    pool.query('SELECT count(*)::int AS n FROM products WHERE business_id = $1 AND price_minor > 0', [businessId]),
    pool.query("SELECT count(*)::int AS n FROM landing_pages WHERE business_id = $1 AND status = 'active'", [businessId]),
    listConnections(pool, businessId),
  ]);
  const profile = p ?? {};
  const have = (k) => {
    if (k === 'daily_budget') return profile.daily_budget_minor != null;
    if (k === 'prices') return Boolean(profile.prices) || prod.n > 0;
    if (k === 'website') return Boolean(profile.website) || page.n > 0;
    return Boolean(profile[k] && String(profile[k]).trim());
  };
  const missing = REQUIRED.filter((k) => !have(k));
  const connected = accounts.find((a) => a.selected && a.status === 'verified') ?? accounts.find((a) => a.status === 'verified') ?? null;
  return { profile, onboarding: o ?? { auto_status: 'idle' }, missing, complete: !missing.length, connected, products: prod.n, pages: page.n };
}

const ONBOARD_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['reply', 'updates'],
  properties: {
    reply: { type: 'string' },
    updates: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['field', 'value'], properties: { field: { type: 'string', enum: Object.keys(FIELDS) }, value: { type: 'string' } } } },
  },
};
const ONBOARD_INSTRUCTIONS = `You are Skyfly's AI media buyer, onboarding ONE business conversationally (a busy owner, often on a phone).
- From the owner's latest message, extract any profile facts into updates (field + value, in the owner's own words; daily_budget as a plain number in the business currency, e.g. "15000"). Only facts the owner actually stated; never guess.
- Then reply briefly: acknowledge what you understood, and ask for the next 1 or 2 MISSING items only (listed in still_missing, most important first). Never ask again for something already in the profile or covered by products / pages already in Skyfly.
- If nothing is missing, say the profile is complete and that Skyfly will now analyse the business and prepare a campaign plan for approval (after the Meta ad account is connected, if it is not yet).
- Plain, friendly, under 90 words. No marketing advice yet.
${SECURITY_RULES}`;

export function engineFor(config) {
  return ENGINES.chatgpt.ready(config) ? 'chatgpt' : ENGINES.claude.ready(config) ? 'claude' : null;
}

async function applyUpdates(pool, businessId, updates) {
  const set = {};
  for (const u of updates) {
    if (!FIELDS[u.field] || !String(u.value).trim()) continue;
    if (u.field === 'daily_budget') {
      const n = Number(String(u.value).replace(/[^\d.]/g, ''));
      if (Number.isFinite(n) && n > 0) set.daily_budget_minor = Math.round(n * 100);
    } else set[u.field] = String(u.value).trim().slice(0, 2000);
  }
  const keys = Object.keys(set);
  if (!keys.length) return keys;
  await pool.query(
    `INSERT INTO ad_profiles (business_id, ${keys.join(', ')}, updated_at) VALUES ($1, ${keys.map((_, i) => `$${i + 2}`).join(', ')}, now())
     ON CONFLICT (business_id) DO UPDATE SET ${keys.map((k) => `${k} = EXCLUDED.${k}`).join(', ')}, updated_at = now()`,
    [businessId, ...keys.map((k) => set[k])]);
  return keys;
}

// One turn of the onboarding conversation.
export async function onboardingTurn(pool, config, { businessId, userId, message }) {
  const engine = engineFor(config);
  if (!engine) throw new AnalystError('The AI conversation needs OPENAI_API_KEY or ANTHROPIC_API_KEY on the server. Meanwhile, fill in the profile under Advertising Settings.', 409);
  const text = String(message ?? '').trim().slice(0, 2000);
  if (!text) throw new AnalystError('Type a message.');
  const before = await onboardingState(pool, businessId);
  const { rows: history } = await pool.query("SELECT role, content FROM ad_messages WHERE business_id = $1 AND topic = 'onboarding' ORDER BY id DESC LIMIT 16", [businessId]);
  const { rows: [b] } = await pool.query('SELECT name, currency FROM businesses WHERE id = $1', [businessId]);
  const data = {
    business: { name: b.name, currency: b.currency },
    profile: Object.fromEntries(Object.entries(before.profile).filter(([k, v]) => v != null && (FIELDS[k] || k === 'daily_budget_minor'))),
    already_in_skyfly: { products_with_prices: before.products, published_pages: before.pages, meta_ad_account_connected: Boolean(before.connected) },
    still_missing: before.missing.map((k) => FIELDS[k]),
    conversation_so_far: history.reverse(),
    owner_message: text,
  };
  const answers = await runEngines(config, [engine], { instructions: ONBOARD_INSTRUCTIONS, input: wrapOnboarding(data), schema: ONBOARD_SCHEMA, name: 'onboarding_turn' },
    (r) => r && typeof r.reply === 'string' && Array.isArray(r.updates));
  const x = answers[engine];
  if (x.status !== 'ok') throw new AnalystError(x.error, x.httpStatus);
  const saved = await applyUpdates(pool, businessId, x.json.updates);
  await pool.query("INSERT INTO ad_messages (business_id, user_id, role, content, topic) VALUES ($1, $2, 'user', $3, 'onboarding'), ($1, NULL, 'assistant', $4, 'onboarding')", [businessId, userId, text, x.json.reply.slice(0, 4000)]);
  const after = await onboardingState(pool, businessId);
  const started = after.complete ? await completeOnboarding(pool, config, businessId, userId) : false;
  return { reply: x.json.reply, saved, missing: after.missing, complete: after.complete, started };
}
const wrapOnboarding = (data) => `Onboarding turn.\n\n<campaign_data>\n${JSON.stringify(data).replace(/<\/?campaign_data/gi, (m) => m.replace('<', '&lt;'))}\n</campaign_data>`;

// Marks onboarding complete (once) and starts the automatic workflow in the background.
export async function completeOnboarding(pool, config, businessId, userId) {
  const { rowCount } = await pool.query(
    `INSERT INTO ad_onboarding (business_id, completed_at, updated_at) VALUES ($1, now(), now())
     ON CONFLICT (business_id) DO UPDATE SET completed_at = now(), updated_at = now() WHERE ad_onboarding.completed_at IS NULL`, [businessId]);
  if (!rowCount) return false;
  startAutoWorkflow(pool, config, businessId, userId);
  return true;
}

// Runs connection health → analysis → plan in the background (one run at a time per business).
const running = new Set();
export function startAutoWorkflow(pool, config, businessId, userId) {
  if (running.has(String(businessId))) return null;
  running.add(String(businessId));
  const p = runAutoWorkflow(pool, config, businessId, userId).catch(async (err) => {
    await pool.query("UPDATE ad_onboarding SET auto_status = 'failed', auto_detail = $2, updated_at = now() WHERE business_id = $1", [businessId, String(err.message).slice(0, 400)]).catch(() => {});
  }).finally(() => running.delete(String(businessId)));
  startAutoWorkflow.last = p; // for tests
  return p;
}
async function runAutoWorkflow(pool, config, businessId, userId) {
  const mark = (status, detail, extra = {}) => pool.query(
    `INSERT INTO ad_onboarding (business_id, auto_status, auto_detail, analysis_id, plan_item_id, updated_at) VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (business_id) DO UPDATE SET auto_status = $2, auto_detail = $3, analysis_id = coalesce($4, ad_onboarding.analysis_id), plan_item_id = coalesce($5, ad_onboarding.plan_item_id), updated_at = now()`,
    [businessId, status, detail, extra.analysis ?? null, extra.plan ?? null]);
  const st = await onboardingState(pool, businessId);
  if (!st.complete) return mark('waiting', `Profile not complete: ${st.missing.map((k) => FIELDS[k]).join(', ')}.`);
  if (!st.connected) return mark('waiting', 'Connect the Meta ad account (Advertising Settings) and Skyfly will continue automatically.');
  const engine = engineFor(config);
  if (!engine) return mark('waiting', 'Waiting for an AI key on the server (OPENAI_API_KEY or ANTHROPIC_API_KEY).');
  await mark('running', 'Checking the Meta connection…');
  const health = await connectionHealth(pool, config, businessId, st.connected.ad_account_id);
  if (!health.ok) return mark('failed', `Meta did not answer: ${health.error}`);
  await mark('running', `Analysing the business and the ad account with ${ENGINES[engine].label}…`);
  let analysisId = null;
  try {
    analysisId = await analyze(pool, config, { businessId, userId, engine, adAccountId: st.connected.ad_account_id, period: 'last_30d' });
  } catch (err) {
    if (!(err instanceof AnalystError)) throw err;
    await mark('running', `The analysis could not run (${err.message}); preparing the plan from the profile…`);
  }
  await mark('running', 'Preparing the campaign plan…', { analysis: analysisId });
  const planId = await generatePlan(pool, config, { businessId, userId, adAccountId: st.connected.ad_account_id, engine });
  return mark('done', 'Analysis and campaign plan ready for your review.', { analysis: analysisId, plan: planId });
}

export { REQUIRED, TEXT_FIELDS };
