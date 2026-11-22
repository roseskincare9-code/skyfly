// Campaign plans and builds for the AI Media Buyer.
//
//   1. PLAN: an analysis engine (ChatGPT, or Claude if ChatGPT is off) writes a complete campaign plan for THIS
//      business from its profile, products, pages, creative library, connection health and results. Skyfly
//      validates it locally (objective vs pixel, destination, budgets, creatives, text lengths).
//   2. BUILD (after the owner approves the plan): campaign → ad sets → images → creatives → ads, created in the
//      business's own ad account, ALL PAUSED (nothing can spend). Each step records Meta's ID; a retry resumes
//      from the first unfinished step, and a step whose outcome is unknown (timeout, server error) is first
//      reconciled by its unique tag, so nothing is created twice. Every created object is read back from Meta.
//   3. LAUNCH (separate, explicit authorisation of the exact daily budget): ads, ad sets, then the campaign are
//      set to ACTIVE; Meta's resulting delivery status is read back and shown as Meta reports it (for example
//      PENDING_REVIEW). The authorised amount becomes the business's approved daily spending limit.
import { buildAccess, connectionHealth, performance, MetaError } from './metaAds.js';
import { AnalystError, SECURITY_RULES, ENGINES, runEngines, wrapData, selectedAccount, latestAnalysis } from './analyst.js';

export class BuildError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

// ---------- Plan schema (strict) and instructions
const str = { type: 'string' }; const int = { type: 'integer' }; const bool = { type: 'boolean' };
const obj = (props) => ({ type: 'object', additionalProperties: false, required: Object.keys(props), properties: props });
const arr = (items) => ({ type: 'array', items });
export const CTAS = ['SHOP_NOW', 'ORDER_NOW', 'BUY_NOW', 'LEARN_MORE', 'SIGN_UP', 'CONTACT_US', 'GET_OFFER'];
export const PLAN_SCHEMA = obj({
  name: str, objective: { type: 'string', enum: ['OUTCOME_SALES', 'OUTCOME_LEADS', 'OUTCOME_TRAFFIC'] }, conversion_event: { type: 'string', enum: ['PURCHASE', 'LEAD', 'NONE'] },
  rationale: str, why_this_structure: str, destination_url: str, duration_days: int, testing_strategy: str, optimization_strategy: str,
  ad_sets: arr(obj({
    name: str, audience_hypothesis: str, daily_budget: { type: 'number' }, country: str, cities: arr(str), age_min: int, age_max: int,
    gender: { type: 'string', enum: ['all', 'women', 'men'] }, advantage_audience: bool,
    ads: arr(obj({ name: str, angle: str, creative_id: str, creative_brief: str, primary_text: str, headline: str, description: str, call_to_action: { type: 'string', enum: CTAS } })),
  })),
});
export const PLAN_INSTRUCTIONS = `You are the media buyer inside Skyfly, building ONE Meta campaign plan for ONE business from the data provided.
- Base every choice on this business's data: products and prices, target markets, customer, goals, budget, landing pages, creative library, connection health (pixels, Page, Instagram) and past results (if any). Do not reuse a generic template; explain in rationale and why_this_structure why this structure fits THIS business.
- Objective: OUTCOME_SALES with conversion_event PURCHASE only if the account has a pixel (connection.pixels); otherwise OUTCOME_TRAFFIC with conversion_event NONE (and say tracking must be fixed). OUTCOME_LEADS with LEAD only for lead businesses with a pixel.
- Budget: the sum of ad set daily_budget must not exceed the business's daily budget (profile.daily_budget) and must respect approved_daily_limit when set. Use the account currency. Prefer 1 ad set (2 only if the budget allows a real test); 2 to 3 ads per ad set.
- Targeting: country as a 2-letter code; cities only where the business delivers; ages and gender only when the product requires it. advantage_audience true lets Meta widen the audience (recommended for small budgets) — then use age_min 18 and age_max 65.
- destination_url must be one of the business's own pages (skyfly_landing_pages url or profile.website), https.
- creative_id: the id of an IMAGE from creative_library that fits the angle; "" if no suitable image exists (then describe the needed image in creative_brief).
- Copy: primary_text (under 600 characters), headline (under 40), description (under 30), using real products and prices from the data. No invented testimonials, guarantees, discounts or medical claims; cosmetic products only claim appearance.
- duration_days: the test length before deciding (usually 7). testing_strategy: what is tested and how a winner is chosen. optimization_strategy: what to change after the test, with numbers.
- This is a plan: nothing is created until the owner approves the build, and nothing spends until the owner authorises the launch.
${SECURITY_RULES}`;

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
export const validPlanShape = (p) => conforms(p, PLAN_SCHEMA);

// ---------- Local validation (before any build)
export async function planContext(pool, businessId) {
  const [{ rows: images }, { rows: [p] }, { rows: pages }] = await Promise.all([
    pool.query("SELECT id, kind, name, mime, size_bytes, notes, ai_review FROM ad_creatives WHERE business_id = $1 AND mime ~ '^image/(png|jpeg)$' ORDER BY id DESC LIMIT 40", [businessId]),
    pool.query('SELECT * FROM ad_profiles WHERE business_id = $1', [businessId]),
    pool.query("SELECT name, slug, url, status FROM landing_pages WHERE business_id = $1 AND status = 'active' ORDER BY id DESC LIMIT 10", [businessId]),
  ]);
  return { images, profile: p ?? {}, pages };
}
export function validatePlan(plan, { images, profile, pages, health, publicBaseUrl }) {
  const errors = []; const warnings = [];
  const pixel = Array.isArray(health?.pixels) ? health.pixels[0] : null;
  if (plan.objective === 'OUTCOME_SALES' && (plan.conversion_event !== 'PURCHASE' || !pixel)) errors.push(pixel ? 'A sales campaign must optimise for PURCHASE.' : 'This ad account has no pixel, so a sales campaign cannot optimise for purchases: connect a pixel or choose Traffic.');
  if (plan.objective === 'OUTCOME_LEADS' && (plan.conversion_event !== 'LEAD' || !pixel)) errors.push('A leads campaign needs a pixel and the LEAD event.');
  if (!Array.isArray(health?.pages) || !health.pages.length) errors.push('No Facebook Page is available to this ad account (needed for every ad).');
  if (health?.account && health.account.status_code !== 1) errors.push(`The ad account is ${health.account.status}.`);
  let url;
  try { url = new URL(plan.destination_url); } catch { /* checked below */ }
  if (!url || url.protocol !== 'https:') errors.push('The destination must be a full https:// address.');
  else {
    const own = [profile.website, ...pages.map((x) => x.url ?? `${publicBaseUrl ?? ''}/p/${x.slug}/`)].filter(Boolean).map((u) => { try { return new URL(u).host; } catch { return null; } });
    if (own.length && !own.includes(url.host)) warnings.push(`The destination (${url.host}) is not one of this business's known pages.`);
  }
  if (!plan.ad_sets.length || plan.ad_sets.length > 5) errors.push('A plan needs 1 to 5 ad sets.');
  const total = plan.ad_sets.reduce((s, x) => s + x.daily_budget, 0);
  const imageIds = new Set(images.map((i) => String(i.id)));
  plan.ad_sets.forEach((s, i) => {
    const n = `Ad set ${i + 1}`;
    if (!(s.daily_budget > 0)) errors.push(`${n}: set a daily budget.`);
    if (!/^[A-Z]{2}$/.test(s.country)) errors.push(`${n}: country must be a 2-letter code (e.g. NG).`);
    if (s.age_min < 18 || s.age_max > 65 || s.age_min > s.age_max) errors.push(`${n}: ages must be between 18 and 65.`);
    if (!s.ads.length || s.ads.length > 6) errors.push(`${n}: 1 to 6 ads.`);
    s.ads.forEach((a, j) => {
      const m = `${n}, ad ${j + 1}`;
      if (!imageIds.has(String(a.creative_id))) errors.push(`${m}: choose an image from the Creative Library (PNG or JPG)${a.creative_brief ? `; needed: ${a.creative_brief.slice(0, 120)}` : ''}.`);
      if (!a.primary_text.trim() || a.primary_text.length > 2000) errors.push(`${m}: primary text is required (under 2,000 characters).`);
      if (!a.headline.trim() || a.headline.length > 255) errors.push(`${m}: a headline is required (under 255 characters).`);
    });
  });
  const budget = profile.daily_budget_minor ? Number(profile.daily_budget_minor) / 100 : null;
  if (budget && total > budget) warnings.push(`The plan's daily budget (${total}) is above the business's stated daily budget (${budget}).`);
  if (pixel && !pixel.last_fired_time) warnings.push(`The pixel ${pixel.id} has no recorded activity: check it fires on the destination page.`);
  return { errors, warnings, total_daily_budget: Math.round(total * 100) / 100 };
}

// ---------- 1. Plan
export async function generatePlan(pool, config, { businessId, userId, adAccountId = null, engine = null, note = '' }) {
  const e = engine ?? (ENGINES.chatgpt.ready(config) ? 'chatgpt' : ENGINES.claude.ready(config) ? 'claude' : null);
  if (!e || !ENGINES[e]?.ready(config)) throw new AnalystError('No AI engine is switched on yet (OPENAI_API_KEY or ANTHROPIC_API_KEY).', 409);
  const acct = await selectedAccount(pool, businessId, adAccountId);
  const health = await connectionHealth(pool, config, businessId, acct.ad_account_id);
  if (!health.ok) throw new AnalystError(`Meta did not answer: ${health.error}`, 409);
  const ctx = await planContext(pool, businessId);
  const [{ rows: products }, perf, latest] = await Promise.all([
    pool.query('SELECT name, price_minor FROM products WHERE business_id = $1 ORDER BY id LIMIT 30', [businessId]),
    performance(pool, config, businessId, 'last_30d', acct.ad_account_id),
    latestAnalysis(pool, businessId, acct.ad_account_id),
  ]);
  const p = ctx.profile;
  const data = {
    account: { id: acct.ad_account_id, currency: health.account?.currency, timezone: health.account?.timezone },
    connection: { pixels: health.pixels, pages: Array.isArray(health.pages) ? health.pages.map((x) => ({ name: x.name, instagram: Boolean(x.instagram) })) : [], problems: health.problems },
    profile: Object.fromEntries(Object.entries(p).filter(([k, v]) => v != null && !['business_id', 'updated_at', 'approval_mode', 'daily_budget_minor', 'approved_daily_limit_minor'].includes(k))),
    daily_budget: p.daily_budget_minor ? Number(p.daily_budget_minor) / 100 : null,
    approved_daily_limit: p.approved_daily_limit_minor ? Number(p.approved_daily_limit_minor) / 100 : null,
    products: products.map((x) => ({ name: x.name, price: Number(x.price_minor) / 100 })),
    skyfly_landing_pages: ctx.pages.map((x) => ({ name: x.name, url: x.url ?? `${config.publicBaseUrl ?? ''}/p/${x.slug}/` })),
    creative_library: ctx.images.map((i) => ({ id: String(i.id), kind: i.kind, name: i.name, notes: i.notes, review: i.ai_review?.slice(0, 300) ?? null })),
    last_30_days: perf.connected && !perf.error ? { totals: perf.totals, campaigns: perf.campaigns.slice(0, 20).map((c) => ({ name: c.name, status: c.status, objective: c.objective, stats: c.stats ?? null })) } : null,
    latest_analysis: latest ? { summary: latest.result.summary, priority_actions: latest.result.priority_actions } : null,
    owner_note: String(note ?? '').slice(0, 500) || null,
  };
  const answers = await runEngines(config, [e], { instructions: PLAN_INSTRUCTIONS, input: wrapData('Write the campaign plan for this business.', data), schema: PLAN_SCHEMA, name: 'campaign_plan' }, validPlanShape);
  const x = answers[e];
  if (x.status !== 'ok') throw new AnalystError(x.error, x.httpStatus);
  const plan = x.json;
  const check = validatePlan(plan, { ...ctx, health, publicBaseUrl: config.publicBaseUrl });
  const body = { format: 'plan', plan, check, engine: e, model: x.model, usage: x.usage ?? null };
  const { rows: [item] } = await pool.query(
    "INSERT INTO ad_items (business_id, kind, title, body, status, data_basis, created_by, ad_account_id) VALUES ($1, 'campaign_draft', $2, $3, 'proposed', $4, $5, $6) RETURNING id",
    [businessId, `Campaign plan: ${String(plan.name).slice(0, 150)}`, JSON.stringify(body), `${ENGINES[e].label} plan from Meta data read ${health.checked_at}`, userId ?? null, acct.ad_account_id]);
  return item.id;
}

// The owner may edit the plan before building (budgets, destination, copy, images). Re-validated each time.
export async function updatePlan(pool, config, { businessId, itemId, changes }) {
  const { rows: [item] } = await pool.query("SELECT * FROM ad_items WHERE id = $1 AND business_id = $2 AND kind = 'campaign_draft' AND status = 'proposed'", [itemId, businessId]);
  if (!item || item.body?.format !== 'plan') throw new BuildError('This plan can no longer be edited.', 404);
  const plan = structuredClone(item.body.plan);
  if (typeof changes.destination_url === 'string' && changes.destination_url.trim()) plan.destination_url = changes.destination_url.trim().slice(0, 500);
  plan.ad_sets.forEach((s, i) => {
    const b = Number(String(changes[`budget_${i}`] ?? '').replace(/,/g, ''));
    if (Number.isFinite(b) && b > 0) s.daily_budget = Math.round(b * 100) / 100;
    s.ads.forEach((a, j) => {
      for (const k of ['primary_text', 'headline', 'description', 'creative_id']) {
        const v = changes[`${k}_${i}_${j}`];
        if (typeof v === 'string') a[k] = v.trim().slice(0, k === 'primary_text' ? 2000 : 255);
      }
    });
  });
  const health = (await pool.query('SELECT health FROM ad_connections WHERE business_id = $1 AND ad_account_id = $2', [businessId, item.ad_account_id])).rows[0]?.health ?? null;
  const check = validatePlan(plan, { ...(await planContext(pool, businessId)), health, publicBaseUrl: config.publicBaseUrl });
  await pool.query('UPDATE ad_items SET body = $3 WHERE id = $1 AND business_id = $2', [itemId, businessId, JSON.stringify({ ...item.body, plan, check, edited_at: new Date().toISOString() })]);
  return check;
}

// ---------- 2. Build (all PAUSED)
const minor = (v) => String(Math.round(Number(v) * 100));
const OPT = { OUTCOME_SALES: 'OFFSITE_CONVERSIONS', OUTCOME_LEADS: 'OFFSITE_CONVERSIONS', OUTCOME_TRAFFIC: 'LANDING_PAGE_VIEWS' };
const uncertain = (err) => !(err instanceof MetaError) || err.status >= 500;
function stepsFor(plan) {
  const s = [{ key: 'campaign', label: `Campaign "${plan.name}"` }];
  const imgs = [...new Set(plan.ad_sets.flatMap((x) => x.ads.map((a) => String(a.creative_id))))];
  imgs.forEach((id) => s.push({ key: `image:${id}`, label: `Image #${id}` }));
  plan.ad_sets.forEach((x, i) => {
    s.push({ key: `adset:${i}`, label: `Ad set "${x.name}"` });
    x.ads.forEach((a, j) => { s.push({ key: `creative:${i}:${j}`, label: `Creative for "${a.name}"` }); s.push({ key: `ad:${i}:${j}`, label: `Ad "${a.name}"` }); });
  });
  return s.map((x) => ({ ...x, status: 'pending', meta_id: null, error: null }));
}

export async function buildPlan(pool, config, { businessId, userId, itemId }) {
  const { rows: [item] } = await pool.query("SELECT * FROM ad_items WHERE id = $1 AND business_id = $2 AND kind = 'campaign_draft'", [itemId, businessId]);
  if (!item || item.body?.format !== 'plan') throw new BuildError('Not found.', 404);
  if (!['proposed', 'approved'].includes(item.status)) throw new BuildError('This plan has already been decided.', 409);
  const plan = item.body.plan;
  const ctx = await planContext(pool, businessId);
  let acc;
  try { acc = await buildAccess(pool, config, businessId, item.ad_account_id); } catch (err) { throw new BuildError(err.message, err.status === 404 ? 404 : 409); }
  const health = await connectionHealth(pool, config, businessId, item.ad_account_id);
  const check = validatePlan(plan, { ...ctx, health, publicBaseUrl: config.publicBaseUrl });
  if (check.errors.length) throw new BuildError(`Fix the plan first: ${check.errors.join(' ')}`, 400);
  // One build per plan. Created (or resumed) under a lock so two clicks cannot run it twice.
  const tag = `sky${item.id}`;
  const { rows: [created] } = await pool.query(
    `INSERT INTO ad_builds (business_id, ad_item_id, ad_account_id, tag, status, steps, daily_budget_minor, created_by) VALUES ($1, $2, $3, $4, 'building', $5, $6, $7)
     ON CONFLICT (business_id, ad_item_id) DO NOTHING RETURNING *`,
    [businessId, item.id, item.ad_account_id, tag, JSON.stringify(stepsFor(plan)), Math.round(check.total_daily_budget * 100), userId]);
  // A failed build is resumed (completed steps are kept); anything else is returned as it is.
  const claimed = created ?? (await pool.query(
    "UPDATE ad_builds SET status = 'building', error = NULL, updated_at = now() WHERE business_id = $1 AND ad_item_id = $2 AND status = 'failed' RETURNING *", [businessId, item.id])).rows[0];
  if (!claimed) return (await pool.query('SELECT * FROM ad_builds WHERE business_id = $1 AND ad_item_id = $2', [businessId, item.id])).rows[0];
  await pool.query("UPDATE ad_items SET status = 'approved', decided_by = $3, decided_at = coalesce(decided_at, now()) WHERE id = $1 AND business_id = $2", [item.id, businessId, userId]);
  const build = claimed;
  const steps = build.steps;
  const save = () => pool.query('UPDATE ad_builds SET steps = $2, updated_at = now() WHERE id = $1', [build.id, JSON.stringify(steps)]);
  const id = (key) => steps.find((s) => s.key === key)?.meta_id;
  const page = health.pages[0];
  const pixel = Array.isArray(health.pixels) ? health.pixels[0] : null;
  // Finds an object this build created earlier (when Meta's answer was lost), by its unique tag.
  const reconcile = async (edge, name) => {
    const r = await acc.get(`${acc.act}/${edge}`, { fields: 'id,name', limit: '200', ...(edge === 'adcreatives' ? {} : { filtering: [{ field: 'name', operator: 'CONTAIN', value: name.slice(-24) }] }) }).catch(() => ({ data: [] }));
    return (r.data ?? []).find((x) => x.name === name)?.id ?? null;
  };
  const run = async (step, edge, name, create) => {
    if (step.status === 'done') return step.meta_id;
    if (step.status === 'unknown' && edge) {
      const found = await reconcile(edge, name);
      if (found) { Object.assign(step, { status: 'done', meta_id: found, error: null, reconciled: true }); await save(); return found; }
    }
    try {
      const r = await create();
      Object.assign(step, { status: 'done', meta_id: r, error: null, done_at: new Date().toISOString() });
      await save();
      return r;
    } catch (err) {
      Object.assign(step, { status: uncertain(err) ? 'unknown' : 'failed', error: String(err.message).slice(0, 400) });
      await save();
      throw err;
    }
  };
  try {
    const cName = `${plan.name} · ${tag}`;
    await run(steps.find((s) => s.key === 'campaign'), 'campaigns', cName, async () => (await acc.create('campaigns', {
      name: cName, objective: plan.objective, status: 'PAUSED', special_ad_categories: [], is_adset_budget_sharing_enabled: false,
    })).id);
    for (const s of steps.filter((x) => x.key.startsWith('image:'))) {
      const cid = s.key.split(':')[1];
      await run(s, null, null, async () => {
        const { rows: [c] } = await pool.query("SELECT name, data FROM ad_creatives WHERE id = $1 AND business_id = $2 AND mime ~ '^image/(png|jpeg)$'", [cid, businessId]);
        if (!c) throw new BuildError(`Image #${cid} is no longer in the creative library.`, 400);
        const r = await acc.create('adimages', { bytes: c.data.toString('base64'), name: `${tag}-${cid}` });
        const hash = Object.values(r.images ?? {})[0]?.hash;
        if (!hash) throw new MetaError('Meta did not return an image hash.', 502);
        return hash;
      });
    }
    for (const [i, x] of plan.ad_sets.entries()) {
      const sName = `${x.name} · ${tag}-s${i}`;
      const cities = [];
      for (const name of x.cities) {
        const g = await acc.geo(name, x.country).catch(() => null);
        if (!g) throw Object.assign(new BuildError(`Meta does not know the city "${name}" in ${x.country}. Edit the plan's cities.`, 400), { step: `adset:${i}` });
        cities.push({ key: g.key, radius: 40, distance_unit: 'kilometer' });
      }
      await run(steps.find((st) => st.key === `adset:${i}`), 'adsets', sName, async () => (await acc.create('adsets', {
        name: sName, campaign_id: id('campaign'), daily_budget: minor(x.daily_budget), billing_event: 'IMPRESSIONS', optimization_goal: OPT[plan.objective],
        bid_strategy: 'LOWEST_COST_WITHOUT_CAP', destination_type: 'WEBSITE', status: 'PAUSED',
        ...(plan.conversion_event !== 'NONE' && pixel ? { promoted_object: { pixel_id: pixel.id, custom_event_type: plan.conversion_event } } : {}),
        targeting: {
          geo_locations: cities.length ? { cities } : { countries: [x.country] },
          ...(x.advantage_audience ? { age_min: Math.min(x.age_min, 25) } : { age_min: x.age_min, age_max: x.age_max, ...(x.gender === 'all' ? {} : { genders: [x.gender === 'men' ? 1 : 2] }) }),
          targeting_automation: { advantage_audience: x.advantage_audience ? 1 : 0 },
        },
      })).id);
      for (const [j, a] of x.ads.entries()) {
        const aName = `${a.name} · ${tag}-a${i}-${j}`;
        const creative = await run(steps.find((st) => st.key === `creative:${i}:${j}`), 'adcreatives', aName, async () => (await acc.create('adcreatives', {
          name: aName,
          object_story_spec: {
            page_id: page.id, ...(page.instagram ? { instagram_user_id: page.instagram.id } : {}),
            link_data: { image_hash: id(`image:${a.creative_id}`), link: plan.destination_url, message: a.primary_text, name: a.headline, description: a.description, call_to_action: { type: a.call_to_action, value: { link: plan.destination_url } } },
          },
        })).id);
        await run(steps.find((st) => st.key === `ad:${i}:${j}`), 'ads', aName, async () => (await acc.create('ads', {
          name: aName, adset_id: id(`adset:${i}`), creative: { creative_id: creative }, status: 'PAUSED',
        })).id);
      }
    }
    // Read every object back: it must exist and be PAUSED.
    const verify = [];
    for (const s of steps.filter((x) => /^(campaign|adset|ad):/.test(`${x.key}:`) && !x.key.startsWith('image'))) {
      const o = await acc.get(String(s.meta_id), { fields: 'id,name,status,effective_status' }).catch((err) => ({ error: err.message }));
      verify.push({ key: s.key, id: s.meta_id, status: o.status ?? null, effective_status: o.effective_status ?? null, error: o.error ?? null });
    }
    const ok = verify.every((v) => v.status === 'PAUSED');
    await pool.query('UPDATE ad_builds SET status = $2, error = $3, launch_result = $4, updated_at = now() WHERE id = $1',
      [build.id, ok ? 'built' : 'failed', ok ? null : 'Reading the objects back from Meta did not confirm them all as PAUSED.', JSON.stringify({ verify })]);
  } catch (err) {
    if (err.step) { const s = steps.find((x) => x.key === err.step); if (s) Object.assign(s, { status: 'failed', error: err.message }); await save(); }
    await pool.query("UPDATE ad_builds SET status = 'failed', error = $2, updated_at = now() WHERE id = $1", [build.id, String(err.message).slice(0, 500)]);
    if (!(err instanceof MetaError) && !(err instanceof BuildError) && !/fetch|network|timeout|abort/i.test(String(err.message))) throw err;
  }
  return (await pool.query('SELECT * FROM ad_builds WHERE id = $1', [build.id])).rows[0];
}

// ---------- 3. Launch (explicit authorisation of the exact daily amount)
export async function launchBuild(pool, config, { businessId, userId, buildId, authorisedDaily, confirmText }) {
  const { rows: [b] } = await pool.query('SELECT b.*, i.body FROM ad_builds b JOIN ad_items i ON i.id = b.ad_item_id WHERE b.id = $1 AND b.business_id = $2', [buildId, businessId]);
  if (!b) throw new BuildError('Not found.', 404);
  if (b.status !== 'built') throw new BuildError(b.status === 'launched' ? 'This campaign was already launched.' : 'Only a completed, verified build can be launched.', 409);
  const daily = Number(b.daily_budget_minor);
  if (String(confirmText ?? '').trim().toUpperCase() !== 'LAUNCH' || Math.round(Number(String(authorisedDaily ?? '').replace(/,/g, '')) * 100) !== daily) {
    throw new BuildError(`To launch, confirm the exact daily budget (${daily / 100}) and type LAUNCH.`, 400);
  }
  const health = await connectionHealth(pool, config, businessId, b.ad_account_id);
  if (!health.ok || health.account?.status_code !== 1) throw new BuildError(`Meta reports the ad account as ${health.account?.status ?? 'unavailable'}${health.error ? ` (${health.error})` : ''}. Nothing was launched.`, 409);
  if (health.capabilities && !health.capabilities.launch) throw new BuildError('The connected token cannot launch (ads_management is missing). Nothing was launched.', 409);
  // Claim it: one launch only.
  const { rowCount } = await pool.query("UPDATE ad_builds SET status = 'launching', launched_by = $3, updated_at = now() WHERE id = $1 AND business_id = $2 AND status = 'built'", [buildId, businessId, userId]);
  if (!rowCount) throw new BuildError('This build is already being launched.', 409);
  let acc;
  try { acc = await buildAccess(pool, config, businessId, b.ad_account_id); } catch (err) { await pool.query("UPDATE ad_builds SET status = 'built' WHERE id = $1", [buildId]); throw new BuildError(err.message, 409); }
  const steps = b.steps;
  const order = [...steps.filter((s) => s.key.startsWith('ad:')), ...steps.filter((s) => s.key.startsWith('adset:')), ...steps.filter((s) => s.key === 'campaign')];
  const results = [];
  let failed = null;
  for (const s of order) {
    try { await acc.setStatus(s.meta_id, 'ACTIVE'); results.push({ key: s.key, id: s.meta_id, requested: 'ACTIVE' }); } catch (err) { failed = `${s.label}: ${err.message}`; results.push({ key: s.key, id: s.meta_id, error: err.message }); break; }
  }
  const after = [];
  for (const s of order) {
    const o = await acc.get(String(s.meta_id), { fields: 'id,status,effective_status' }).catch((err) => ({ error: err.message }));
    after.push({ key: s.key, id: s.meta_id, status: o.status ?? null, effective_status: o.effective_status ?? null, error: o.error ?? null });
  }
  const camp = after.find((x) => x.key === 'campaign');
  // The authorised amount becomes (or raises) the approved daily limit for Skyfly-built campaigns.
  const { rows: [{ launched }] } = await pool.query("SELECT coalesce(sum(daily_budget_minor), 0)::bigint AS launched FROM ad_builds WHERE business_id = $1 AND status = 'launched'", [businessId]);
  if (!failed) await pool.query('UPDATE ad_profiles SET approved_daily_limit_minor = GREATEST(coalesce(approved_daily_limit_minor, 0), $2) WHERE business_id = $1', [businessId, Number(launched) + daily]);
  await pool.query('UPDATE ad_builds SET status = $2, launched_at = CASE WHEN $2 = \'launched\' THEN now() ELSE launched_at END, launch_result = $3, error = $4, updated_at = now() WHERE id = $1',
    [buildId, failed ? 'launch_failed' : 'launched', JSON.stringify({ requested: results, after, authorised_daily_minor: daily, authorised_at: new Date().toISOString() }), failed]);
  if (!failed) await pool.query("UPDATE ad_items SET status = 'executed', meta_result = $3 WHERE id = $1 AND business_id = $2", [b.ad_item_id, businessId, JSON.stringify({ id: camp?.id, status: camp?.status, effective_status: camp?.effective_status })]);
  return { failed, after, campaign: camp };
}
