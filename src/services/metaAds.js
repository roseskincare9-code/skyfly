// Each business's OWN Meta ad account, through the Marketing API (the same Graph address Skyfly already uses
// for the Conversions API). The access token is the business's (a System User token from its own Business
// Manager, or a user token with ads_read / ads_management): it is verified with Meta, stored encrypted, used
// only server-side for that business, and never shown again. Reads are free; the ONLY write is creating a
// campaign shell with status PAUSED after an approval (no ad set, no ad, no budget: nothing can spend).
import { encrypt, decrypt } from '../lib/secrets.js';

export class MetaError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
const clean = (id) => String(id ?? '').replace(/^act_/, '').trim();

async function graph(config, token, path, { params = {}, method = 'GET', body = null } = {}) {
  const url = new URL(`${config.metaGraphBase}/${path.replace(/^\//, '')}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, typeof v === 'string' ? v : JSON.stringify(v));
  url.searchParams.set('access_token', token);
  const res = await fetch(url, {
    method, signal: AbortSignal.timeout(25000),
    ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || j.error) {
    const e = j.error ?? {};
    // Never echo the token: Meta's messages do not contain it, and the URL is not included.
    throw new MetaError(`Meta: ${String(e.message ?? `HTTP ${res.status}`).slice(0, 220)}${e.code ? ` (code ${e.code})` : ''}`, res.status === 401 || e.code === 190 ? 401 : 502);
  }
  return j;
}

// Checks the token can read THIS ad account, finds its Page and pixel, and stores the connection (encrypted).
export async function connectAccount(pool, config, { businessId, userId, token, adAccountId, pageId = null }) {
  if (!config.encryptionKey) throw new MetaError('Tokens cannot be stored until SKYFLY_ENCRYPTION_KEY is set on the server.', 409);
  const act = clean(adAccountId);
  if (!/^\d{5,20}$/.test(act)) throw new MetaError('Enter the ad account ID (the number after "act_" in Ads Manager).');
  if (!/^[A-Za-z0-9_-]{20,1000}$/.test(String(token ?? '').trim())) throw new MetaError('Paste the access token from your Meta Business Manager.');
  token = String(token).trim();
  const account = await graph(config, token, `act_${act}`, { params: { fields: 'name,currency,account_status' } });
  const pages = await graph(config, token, `act_${act}/promote_pages`, { params: { fields: 'id,name', limit: '25' } }).then((r) => r.data ?? []).catch(() => []);
  const pixels = await graph(config, token, `act_${act}/adspixels`, { params: { fields: 'id,name', limit: '25' } }).then((r) => r.data ?? []).catch(() => []);
  const page = (pageId && pages.find((p) => p.id === String(pageId))) || pages[0] || null;
  const pixel = pixels[0] || null;
  const enc = encrypt(config.encryptionKey, token);
  // Adds the account (or refreshes it if already connected). The first account becomes the selected one.
  await pool.query(
    `INSERT INTO ad_connections (business_id, ad_account_id, ad_account_name, currency, account_status, page_id, page_name, pixel_id, pixel_name,
                                 token_enc, token_hint, status, verified_at, last_error, connected_by, updated_at, selected)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'verified', now(), NULL, $12, now(),
             NOT EXISTS (SELECT 1 FROM ad_connections WHERE business_id = $1 AND selected))
     ON CONFLICT (business_id, ad_account_id) DO UPDATE SET ad_account_name = EXCLUDED.ad_account_name, currency = EXCLUDED.currency,
       account_status = EXCLUDED.account_status, page_id = EXCLUDED.page_id, page_name = EXCLUDED.page_name, pixel_id = EXCLUDED.pixel_id,
       pixel_name = EXCLUDED.pixel_name, token_enc = EXCLUDED.token_enc, token_hint = EXCLUDED.token_hint, status = 'verified', verified_at = now(),
       last_error = NULL, connected_by = EXCLUDED.connected_by, updated_at = now()`,
    [businessId, act, account.name ?? null, account.currency ?? null, account.account_status ?? null, page?.id ?? null, page?.name ?? null,
      pixel?.id ?? null, pixel?.name ?? null, enc, `…${token.slice(-4)}`, userId]);
  return { account: { id: act, name: account.name, currency: account.currency, status: account.account_status }, page, pixel, pages, pixels };
}

// This business's connected ad accounts (never another business's), selected first. Tokens are not returned.
export async function listConnections(pool, businessId) {
  const { rows } = await pool.query(
    `SELECT id, business_id, ad_account_id, ad_account_name, currency, account_status, page_id, page_name, pixel_id, pixel_name, token_hint,
            status, verified_at, last_error, selected, created_at FROM ad_connections WHERE business_id = $1 ORDER BY selected DESC, created_at`, [businessId]);
  return rows;
}

// Makes one of this business's accounts the selected one. False when the account is not this business's.
export async function selectAccount(pool, businessId, adAccountId) {
  const act = clean(adAccountId);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [found] } = await client.query('SELECT id FROM ad_connections WHERE business_id = $1 AND ad_account_id = $2 FOR UPDATE', [businessId, act]);
    if (!found) { await client.query('ROLLBACK'); return false; }
    await client.query('UPDATE ad_connections SET selected = false WHERE business_id = $1 AND selected', [businessId]);
    await client.query('UPDATE ad_connections SET selected = true, updated_at = now() WHERE id = $1', [found.id]);
    await client.query('COMMIT');
    return true;
  } catch (err) { await client.query('ROLLBACK').catch(() => {}); throw err; } finally { client.release(); }
}

// Removes one account and its token (only from this business). If it was selected, the oldest remaining one is selected.
export async function disconnectAccount(pool, businessId, adAccountId) {
  const act = clean(adAccountId);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [gone] } = await client.query('DELETE FROM ad_connections WHERE business_id = $1 AND ad_account_id = $2 RETURNING selected', [businessId, act]);
    if (gone?.selected) {
      await client.query(`UPDATE ad_connections SET selected = true WHERE id = (SELECT id FROM ad_connections WHERE business_id = $1 ORDER BY created_at LIMIT 1)`, [businessId]);
    }
    await client.query('COMMIT');
    return Boolean(gone);
  } catch (err) { await client.query('ROLLBACK').catch(() => {}); throw err; } finally { client.release(); }
}

// One of this business's accounts: the one named, or else the selected one.
export async function connectionFor(pool, businessId, adAccountId = null) {
  const { rows: [c] } = adAccountId
    ? await pool.query('SELECT * FROM ad_connections WHERE business_id = $1 AND ad_account_id = $2', [businessId, clean(adAccountId)])
    : await pool.query('SELECT * FROM ad_connections WHERE business_id = $1 ORDER BY selected DESC, created_at LIMIT 1', [businessId]);
  return c ?? null;
}
const tokenOf = (config, c) => {
  try { if (config.encryptionKey) return decrypt(config.encryptionKey, c.token_enc); } catch { /* unreadable */ }
  throw new MetaError('The stored Meta token cannot be read (the server key changed or is missing): reconnect the ad account.', 409);
};

const PURCHASE = ['purchase', 'offsite_conversion.fb_pixel_purchase', 'omni_purchase'];
const pick = (list, types) => {
  for (const t of types) { const a = (list ?? []).find((x) => x.action_type === t); if (a) return Number(a.value); }
  return 0;
};
function shape(row) {
  const spend = Number(row.spend ?? 0);
  const purchases = pick(row.actions, PURCHASE);
  const value = pick(row.action_values, PURCHASE);
  const results = purchases || pick(row.actions, ['lead', 'onsite_conversion.lead_grouped', 'offsite_conversion.fb_pixel_lead']);
  return {
    // The most specific level first: an ad row also carries its ad set's and campaign's IDs and names.
    id: row.ad_id ?? row.adset_id ?? row.campaign_id, name: row.ad_name ?? row.adset_name ?? row.campaign_name,
    campaign: row.campaign_name ?? null, spend, impressions: Number(row.impressions ?? 0), clicks: Number(row.clicks ?? 0),
    ctr: Number(row.ctr ?? 0), cpc: Number(row.cpc ?? 0), cpm: Number(row.cpm ?? 0), frequency: Number(row.frequency ?? 0),
    purchases, results, purchase_value: value,
    cpa: results ? Math.round((spend / results) * 100) / 100 : null, roas: spend && value ? Math.round((value / spend) * 100) / 100 : null,
  };
}

// The business's live numbers (read-only). period: Meta date preset (today, yesterday, last_7d, last_30d).
export async function performance(pool, config, businessId, period = 'last_7d', adAccountId = null) {
  const c = await connectionFor(pool, businessId, adAccountId);
  if (!c || c.status !== 'verified') return { connected: false };
  let token;
  try { token = tokenOf(config, c); } catch (err) { return { connected: true, error: err.message }; }
  const fields = 'campaign_id,campaign_name,adset_id,adset_name,ad_id,ad_name,spend,impressions,clicks,ctr,cpc,cpm,frequency,actions,action_values';
  try {
    const [campaigns, campaignStats, adsets, ads, total] = await Promise.all([
      graph(config, token, `act_${c.ad_account_id}/campaigns`, { params: { fields: 'id,name,status,effective_status,objective,daily_budget,lifetime_budget', limit: '100' } }),
      graph(config, token, `act_${c.ad_account_id}/insights`, { params: { level: 'campaign', date_preset: period, fields, limit: '100' } }),
      graph(config, token, `act_${c.ad_account_id}/insights`, { params: { level: 'adset', date_preset: period, fields, limit: '100' } }),
      graph(config, token, `act_${c.ad_account_id}/insights`, { params: { level: 'ad', date_preset: period, fields, limit: '100' } }),
      graph(config, token, `act_${c.ad_account_id}/insights`, { params: { date_preset: period, fields: 'spend,impressions,clicks,ctr,cpc,cpm,frequency,actions,action_values' } }),
    ]);
    const stats = Object.fromEntries((campaignStats.data ?? []).map((r) => [r.campaign_id, shape(r)]));
    return {
      connected: true, period, currency: c.currency, account: { id: c.ad_account_id, name: c.ad_account_name },
      totals: shape(total.data?.[0] ?? {}),
      campaigns: (campaigns.data ?? []).map((k) => ({ id: k.id, name: k.name, status: k.effective_status ?? k.status, objective: k.objective,
        daily_budget: k.daily_budget ? Number(k.daily_budget) / 100 : null, ...(stats[k.id] ? { stats: stats[k.id] } : {}) })),
      adsets: (adsets.data ?? []).map(shape), ads: (ads.data ?? []).map(shape),
    };
  } catch (err) {
    if (err.status === 401) await pool.query("UPDATE ad_connections SET status = 'failed', last_error = $2, updated_at = now() WHERE id = $1", [c.id, err.message]);
    return { connected: true, error: err.message };
  }
}

// After approval: a campaign SHELL, status PAUSED (no ad set, no ad, no budget). Meta's own status is read back.
// Only ever in the ad account the draft was prepared for, and only while it is still this business's account.
export async function createPausedCampaign(pool, config, businessId, draft, adAccountId) {
  if (!adAccountId) throw new MetaError('This draft does not say which ad account it is for: prepare a new draft.', 409);
  const c = await connectionFor(pool, businessId, adAccountId);
  if (!c) throw new MetaError(`This draft was prepared for ad account act_${clean(adAccountId)}, which is no longer connected to this business. Nothing was created.`, 409);
  if (c.status !== 'verified') throw new MetaError(`Ad account act_${c.ad_account_id} needs to be reconnected first. Nothing was created.`, 409);
  const token = tokenOf(config, c);
  const objective = ['OUTCOME_SALES', 'OUTCOME_LEADS', 'OUTCOME_TRAFFIC', 'OUTCOME_AWARENESS', 'OUTCOME_ENGAGEMENT'].includes(draft.objective) ? draft.objective : 'OUTCOME_SALES';
  const made = await graph(config, token, `act_${c.ad_account_id}/campaigns`, {
    method: 'POST', body: { name: `[Skyfly draft] ${String(draft.name ?? 'Campaign').slice(0, 180)}`, objective, status: 'PAUSED', special_ad_categories: [], is_adset_budget_sharing_enabled: false },
  });
  const check = await graph(config, token, made.id, { params: { fields: 'id,name,status,effective_status,objective' } });
  return { id: check.id, name: check.name, status: check.status, effective_status: check.effective_status, objective: check.objective, ad_account_id: c.ad_account_id };
}

// ---------- Data for the ChatGPT performance analysis (READ-ONLY: only GET requests to Meta).
// Skyfly computes every metric itself from Meta's raw numbers, so the AI explains figures, never invents them.
const round = (v, d = 2) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d);
const LEAD = ['lead', 'onsite_conversion.lead_grouped', 'offsite_conversion.fb_pixel_lead'];
export function metricsOf(row = {}) {
  const spend = Number(row.spend ?? 0);
  const impressions = Number(row.impressions ?? 0);
  const linkClicks = Number(row.inline_link_clicks ?? pick(row.actions, ['link_click']) ?? 0);
  const purchases = pick(row.actions, PURCHASE);
  const value = pick(row.action_values, PURCHASE);
  const leads = pick(row.actions, LEAD);
  const lpv = pick(row.actions, ['landing_page_view', 'omni_landing_page_view']);
  return {
    spend: round(spend), impressions, reach: Number(row.reach ?? 0), frequency: round(Number(row.frequency ?? 0)),
    clicks: Number(row.clicks ?? 0), link_clicks: linkClicks,
    ctr: round(Number(row.ctr ?? 0)), link_ctr: impressions ? round((linkClicks / impressions) * 100) : null,
    cpc: round(Number(row.cpc ?? 0)), cpm: round(Number(row.cpm ?? 0)),
    landing_page_views: lpv, add_to_cart: pick(row.actions, ['add_to_cart', 'offsite_conversion.fb_pixel_add_to_cart', 'omni_add_to_cart']),
    initiate_checkout: pick(row.actions, ['initiate_checkout', 'offsite_conversion.fb_pixel_initiate_checkout', 'omni_initiated_checkout']),
    purchases, purchase_value: round(value), leads,
    cpa: purchases ? round(spend / purchases) : null, cost_per_lead: leads ? round(spend / leads) : null,
    roas: spend && value ? round(value / spend) : null,
    conversion_rate: linkClicks ? round((purchases / linkClicks) * 100) : null,
    landing_page_conversion_rate: lpv ? round((purchases / lpv) * 100) : null,
  };
}
const ymd = (d, tz) => new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
const addDays = (s, n) => { const d = new Date(`${s}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const DAYS = { today: 1, yesterday: 1, last_7d: 7, last_14d: 14, last_30d: 30 };
export const ANALYSIS_PERIODS = Object.keys(DAYS);
// The requested window and the equal window just before it, as dates in the ad account's time zone.
export function windows({ period = 'last_7d', since = null, until = null }, tz, now = new Date()) {
  const today = ymd(now, tz);
  let s; let u;
  if (since && until) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(since) || !/^\d{4}-\d{2}-\d{2}$/.test(until) || since > until) throw new MetaError('Choose a valid date range (from ≤ to).');
    if (until > today) throw new MetaError('The date range cannot end in the future.');
    if ((new Date(until) - new Date(since)) / 86400000 > 89) throw new MetaError('Choose a date range of at most 90 days.');
    [s, u] = [since, until];
  } else {
    const n = DAYS[period] ?? 7;
    if (period === 'today') [s, u] = [today, today];
    else { u = addDays(today, -1); s = addDays(u, -(n - 1)); } // Meta's last_Nd presets end yesterday
  }
  const len = Math.round((new Date(u) - new Date(s)) / 86400000) + 1;
  return { current: { since: s, until: u, days: len }, previous: { since: addDays(s, -len), until: addDays(s, -1), days: len }, today };
}
function targetingSummary(t) {
  if (!t) return null;
  const geo = t.geo_locations ?? {};
  const names = (l) => (l ?? []).map((x) => x.name ?? x.key ?? x).slice(0, 10);
  return {
    age: t.age_min || t.age_max ? `${t.age_min ?? 18}-${t.age_max ?? 65}` : null,
    genders: t.genders?.length ? t.genders.map((g) => (g === 1 ? 'men' : g === 2 ? 'women' : g)) : 'all',
    countries: geo.countries ?? [], regions: names(geo.regions), cities: names(geo.cities),
    interests: (t.flexible_spec ?? []).flatMap((f) => names(f.interests)).slice(0, 10),
    custom_audiences: (t.custom_audiences ?? []).length, excluded_custom_audiences: (t.excluded_custom_audiences ?? []).length,
    advantage_audience: t.targeting_automation?.advantage_audience === 1 ? true : undefined,
  };
}
// Everything the analysis needs from ONE of this business's ad accounts, for one window (+ the one before).
export async function analysisData(pool, config, businessId, adAccountId, { period = 'last_7d', since = null, until = null, campaignId = null } = {}) {
  const c = await connectionFor(pool, businessId, adAccountId);
  if (!c) throw new MetaError('That ad account is not connected to this business.', 404);
  if (c.status !== 'verified') throw new MetaError(`Ad account act_${c.ad_account_id} needs to be reconnected first.`, 409);
  const token = tokenOf(config, c);
  const act = `act_${c.ad_account_id}`;
  const acct = await graph(config, token, act, { params: { fields: 'name,currency,timezone_name,account_status' } });
  const w = windows({ period, since, until }, acct.timezone_name);
  const camp = campaignId && /^\d{1,30}$/.test(String(campaignId)) ? String(campaignId) : null;
  const filtering = camp ? [{ field: 'campaign.id', operator: 'IN', value: [camp] }] : undefined;
  const fields = 'campaign_id,campaign_name,adset_id,adset_name,ad_id,ad_name,spend,impressions,reach,frequency,clicks,inline_link_clicks,ctr,cpc,cpm,actions,action_values';
  const ins = (level, win) => graph(config, token, `${act}/insights`, { params: { ...(level ? { level } : {}), time_range: { since: win.since, until: win.until }, fields: level ? fields : fields.replace(/^campaign_id,campaign_name,adset_id,adset_name,ad_id,ad_name,/, ''), limit: '200', ...(filtering ? { filtering } : {}) } });
  const list = (edge, f) => graph(config, token, `${act}/${edge}`, { params: { fields: f, limit: '200', ...(filtering ? { filtering } : {}) } });
  const [campaigns, adsets, ads, cNow, cPrev, sNow, aNow, tNow, tPrev] = await Promise.all([
    list('campaigns', 'id,name,status,effective_status,objective,daily_budget,lifetime_budget,bid_strategy,created_time'),
    list('adsets', 'id,name,campaign_id,effective_status,optimization_goal,daily_budget,lifetime_budget,targeting'),
    list('ads', 'id,name,adset_id,campaign_id,effective_status,creative{title,body,object_type,call_to_action_type}'),
    ins('campaign', w.current), ins('campaign', w.previous), ins('adset', w.current), ins('ad', w.current), ins(null, w.current), ins(null, w.previous),
  ]);
  const pixel = c.pixel_id ? await graph(config, token, c.pixel_id, { params: { fields: 'last_fired_time,is_unavailable' } }).catch(() => null) : null;
  const budget = (v) => (v ? Number(v) / 100 : null);
  const by = (res, key) => Object.fromEntries((res.data ?? []).map((r) => [r[key], metricsOf(r)]));
  const [cm, cp, sm, am] = [by(cNow, 'campaign_id'), by(cPrev, 'campaign_id'), by(sNow, 'adset_id'), by(aNow, 'ad_id')];
  const truncated = [campaigns, adsets, ads, cNow, sNow, aNow].some((r) => r.paging?.next);
  return {
    fetched_at: new Date().toISOString(),
    account: { id: c.ad_account_id, name: acct.name ?? c.ad_account_name, currency: acct.currency ?? c.currency, timezone: acct.timezone_name ?? null, status: acct.account_status ?? null },
    window: w.current, previous_window: w.previous, period: since && until ? 'custom' : period, partial_day: w.current.until === w.today,
    campaign_filter: camp,
    totals: metricsOf(tNow.data?.[0]), previous_totals: metricsOf(tPrev.data?.[0]),
    campaigns: (campaigns.data ?? []).map((k) => ({ id: k.id, name: k.name, status: k.effective_status ?? k.status, objective: k.objective ?? null,
      daily_budget: budget(k.daily_budget), lifetime_budget: budget(k.lifetime_budget), bid_strategy: k.bid_strategy ?? null,
      metrics: cm[k.id] ?? null, previous: cp[k.id] ?? null })),
    adsets: (adsets.data ?? []).map((s) => ({ id: s.id, name: s.name, campaign_id: s.campaign_id, status: s.effective_status ?? null, optimization_goal: s.optimization_goal ?? null,
      daily_budget: budget(s.daily_budget), lifetime_budget: budget(s.lifetime_budget), targeting: targetingSummary(s.targeting), metrics: sm[s.id] ?? null })),
    ads: (ads.data ?? []).map((a) => ({ id: a.id, name: a.name, adset_id: a.adset_id, campaign_id: a.campaign_id, status: a.effective_status ?? null,
      creative: a.creative ? { title: a.creative.title ?? null, body: a.creative.body ? String(a.creative.body).slice(0, 400) : null, format: a.creative.object_type ?? null, cta: a.creative.call_to_action_type ?? null } : null,
      metrics: am[a.id] ?? null })),
    pixel: c.pixel_id ? { id: c.pixel_id, last_fired_time: pixel?.last_fired_time ?? null, unavailable: pixel?.is_unavailable ?? null } : null,
    truncated,
  };
}

// Campaign names for the analysis scope picker (one read; empty if Meta is unavailable).
export async function listCampaigns(pool, config, businessId, adAccountId) {
  const c = await connectionFor(pool, businessId, adAccountId);
  if (!c || c.status !== 'verified') return [];
  try {
    const r = await graph(config, tokenOf(config, c), `act_${c.ad_account_id}/campaigns`, { params: { fields: 'id,name,effective_status', limit: '200' } });
    return (r.data ?? []).map((k) => ({ id: k.id, name: k.name, status: k.effective_status }));
  } catch { return []; }
}
