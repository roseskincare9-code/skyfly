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
