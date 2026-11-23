// Facebook Login (the official Meta OAuth flow) for the AI Media Buyer: the business owner signs in with
// Facebook, grants the advertising permissions, and picks which of the ad accounts THEY can access to connect
// to THIS Skyfly business. Needs Skyfly's own Meta app (META_APP_ID + META_APP_SECRET on the server); without
// it the System User token form keeps working and the button explains what is missing.
//   start:    a one-time state (hashed, 10 minutes) tied to the signed-in user AND the business → Meta's dialog
//   callback: the state is used once by the same user, who must still be a member of that business; the code is
//             exchanged server-side for a long-lived token (~60 days); Meta's granted permissions and the ad
//             accounts it lists for that person are kept, encrypted, for 30 minutes in a grant of that business
//   connect:  only accounts Meta listed in that grant, for that business and that user, are connected; each one
//             is re-verified with Meta exactly like a pasted token. The grant is then deleted.
// Tokens are never logged, returned to the browser or stored unencrypted.
import { createHash, randomBytes } from 'node:crypto';
import { encrypt, decrypt } from '../lib/secrets.js';
import { MetaError, connectAccount } from './metaAds.js';

export const LOGIN_SCOPES = ['ads_management', 'ads_read', 'business_management', 'pages_show_list', 'pages_read_engagement', 'pages_manage_ads'];
const STATE_MINUTES = 10;
const GRANT_MINUTES = 30;
const MAX_ACCOUNTS = 500;
const hashState = (s) => createHash('sha256').update(String(s)).digest('hex');

export const metaLoginReady = (config) => Boolean(config.metaLogin?.appId && config.metaLogin?.appSecret && config.publicBaseUrl && config.encryptionKey);
export function metaLoginMissing(config) {
  return [
    ...(config.metaLogin?.appId ? [] : ['META_APP_ID']),
    ...(config.metaLogin?.appSecret ? [] : ['META_APP_SECRET']),
    ...(config.encryptionKey ? [] : ['SKYFLY_ENCRYPTION_KEY']),
    ...(config.publicBaseUrl ? [] : ['PUBLIC_BASE_URL']),
  ];
}
// The one address registered in the Meta app ("Valid OAuth Redirect URIs"). Not business-specific: the business
// comes from the stored state, never from the URL.
export const redirectUri = (config) => `${String(config.publicBaseUrl).replace(/\/$/, '')}/meta/oauth/callback`;
const version = (config) => (String(config.metaGraphBase).match(/\/(v\d+\.\d+)/) ?? [null, 'v26.0'])[1];

async function call(config, path, params) {
  const url = new URL(`${config.metaGraphBase}/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  const res = await fetch(url, { signal: AbortSignal.timeout(25000) });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || j.error) {
    const e = j.error ?? {};
    throw new MetaError(`Meta: ${String(e.message ?? `HTTP ${res.status}`).slice(0, 220)}${e.code ? ` (code ${e.code})` : ''}`, res.status >= 500 ? 502 : 400);
  }
  return j;
}

export async function startLogin(pool, config, { businessId, userId }) {
  if (!metaLoginReady(config)) throw new MetaError(`Facebook Login is not set up on the server yet (missing ${metaLoginMissing(config).join(', ')}). Use the System User token form below meanwhile.`, 409);
  const state = randomBytes(24).toString('base64url');
  await pool.query('DELETE FROM meta_oauth_states WHERE expires_at < now() - interval \'1 day\'');
  await pool.query(
    `INSERT INTO meta_oauth_states (state_hash, business_id, user_id, expires_at) VALUES ($1, $2, $3, now() + make_interval(mins => $4))`,
    [hashState(state), businessId, userId, STATE_MINUTES]);
  const url = new URL(`${config.metaDialogBase ?? 'https://www.facebook.com'}/${version(config)}/dialog/oauth`);
  url.searchParams.set('client_id', config.metaLogin.appId);
  url.searchParams.set('redirect_uri', redirectUri(config));
  url.searchParams.set('state', state);
  url.searchParams.set('response_type', 'code');
  if (config.metaLogin.configId) url.searchParams.set('config_id', config.metaLogin.configId); // Facebook Login for Business
  else url.searchParams.set('scope', LOGIN_SCOPES.join(','));
  url.searchParams.set('auth_type', 'rerequest'); // asks again for permissions declined last time
  return url.toString();
}

// The business this login belongs to, used once and only by the same signed-in user. Null when unknown,
// expired, already used, or started by someone else.
export async function useLoginState(pool, { state, userId }) {
  if (typeof state !== 'string' || state.length < 20 || state.length > 100 || !userId) return null;
  const { rows: [s] } = await pool.query(
    `UPDATE meta_oauth_states SET used_at = now() WHERE state_hash = $1 AND user_id = $2 AND used_at IS NULL AND expires_at > now() RETURNING business_id`,
    [hashState(state), userId]);
  return s?.business_id ?? null;
}

// Exchanges the code (server-side, with the app secret) and stores a grant for the business. Returns its id.
export async function finishLogin(pool, config, { businessId, userId, code }) {
  if (!metaLoginReady(config)) throw new MetaError('Facebook Login is not set up on the server.', 409);
  if (typeof code !== 'string' || !code || code.length > 2000) throw new MetaError('Meta did not return an authorisation code. Try again.');
  const { appId, appSecret } = config.metaLogin;
  const short = await call(config, 'oauth/access_token', { client_id: appId, client_secret: appSecret, redirect_uri: redirectUri(config), code });
  // Long-lived user token (about 60 days). If Meta refuses the exchange, the short-lived one is used.
  const long = await call(config, 'oauth/access_token', { grant_type: 'fb_exchange_token', client_id: appId, client_secret: appSecret, fb_exchange_token: short.access_token }).catch(() => short);
  const token = long.access_token;
  const expiresIn = Number(long.expires_in);
  const me = await call(config, 'me', { fields: 'name', access_token: token }).catch(() => ({}));
  const perms = (await call(config, 'me/permissions', { access_token: token }).catch(() => ({ data: [] }))).data ?? [];
  const granted = perms.filter((p) => p.status === 'granted').map((p) => p.permission);
  const declined = perms.filter((p) => p.status !== 'granted').map((p) => p.permission);
  const { accounts, truncated } = await discoverAccounts(config, token);
  return storeGrant(pool, config, { businessId, userId, token, tokenExpiresAt: Number.isFinite(expiresIn) && expiresIn > 0 ? new Date(Date.now() + expiresIn * 1000) : null, meName: me.name ?? null, granted, declined, accounts, truncated });
}

// Meta's account_status codes, and whether Skyfly may connect the account. Disabled and closed accounts are
// listed (so the owner sees them) but cannot be connected: Meta delivers nothing there.
export const ACCOUNT_STATUS = { 1: 'Active', 2: 'Disabled by Meta', 3: 'Unsettled (payment due)', 7: 'Pending risk review', 8: 'Pending settlement', 9: 'In grace period', 100: 'Pending closure', 101: 'Closed', 201: 'Active', 202: 'Closed' };
const NOT_CONNECTABLE = new Set([2, 100, 101, 202]);
// This person's role in the account, from Meta's user_tasks: MANAGE (admin), ADVERTISE, ANALYZE (read-only), DRAFT.
export function accessOf(tasks) {
  const t = new Set((tasks ?? []).map(String));
  if (t.has('MANAGE')) return { level: 'admin', canBuild: true };
  if (t.has('ADVERTISE')) return { level: 'advertiser', canBuild: true };
  if (t.has('ANALYZE')) return { level: 'analyst (read-only)', canBuild: false };
  if (t.has('DRAFT')) return { level: 'draft only', canBuild: false };
  return { level: tasks == null ? 'not reported' : 'none', canBuild: tasks == null ? null : false };
}

// Every ad account this person can use, across all their business portfolios and personal accounts, following
// Meta's pagination to the end (up to MAX_ACCOUNTS; if Meta has more, the result says so instead of hiding it).
export async function discoverAccounts(config, token) {
  const accounts = []; let truncated = false;
  let next = { path: 'me/adaccounts', params: { fields: 'account_id,name,currency,account_status,disable_reason,user_tasks,business{id,name}', limit: 100, access_token: token } };
  while (next) {
    const page = await call(config, next.path, next.params);
    for (const a of page.data ?? []) {
      const id = String(a.account_id ?? a.id ?? '').replace(/^act_/, '');
      if (!/^\d{5,20}$/.test(id) || accounts.some((x) => x.id === id)) continue;
      if (accounts.length >= MAX_ACCOUNTS) { truncated = true; break; }
      const status = a.account_status ?? null; const access = accessOf(a.user_tasks);
      accounts.push({
        id, name: a.name ?? null, currency: a.currency ?? null, status, status_label: ACCOUNT_STATUS[status] ?? (status == null ? 'not reported' : `status ${status}`),
        business: a.business?.name ?? null, business_id: a.business?.id ?? null, access: access.level, can_build: access.canBuild,
        connectable: status == null || !NOT_CONNECTABLE.has(Number(status)),
      });
    }
    if (truncated) break;
    const after = page.paging?.cursors?.after;
    next = page.paging?.next && after ? { path: 'me/adaccounts', params: { ...next.params, after } } : null;
  }
  return { accounts, truncated };
}

async function storeGrant(pool, config, { businessId, userId, token, tokenExpiresAt, meName, granted, declined, accounts, truncated }) {
  await pool.query('DELETE FROM meta_oauth_grants WHERE (business_id = $1 AND user_id = $2) OR expires_at < now()', [businessId, userId]);
  const { rows: [g] } = await pool.query(
    `INSERT INTO meta_oauth_grants (business_id, user_id, token_enc, token_expires_at, meta_user_name, granted, declined, accounts, truncated, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now() + make_interval(mins => $10)) RETURNING id`,
    [businessId, userId, encrypt(config.encryptionKey, token), tokenExpiresAt, meName, granted, declined, JSON.stringify(accounts), Boolean(truncated), GRANT_MINUTES]);
  return g.id;
}

// Re-reads the account list with the Facebook Login token this business already holds (no new sign-in),
// e.g. after the owner was given access to more ad accounts in Meta. Only a still-valid, unexpired token from
// this business's own connections is used; otherwise the owner signs in with Facebook again.
export async function refreshDiscovery(pool, config, { businessId, userId }) {
  if (!config.encryptionKey) throw new MetaError('Tokens cannot be read until SKYFLY_ENCRYPTION_KEY is set on the server.', 409);
  const { rows: [c] } = await pool.query(
    `SELECT token_enc, token_expires_at FROM ad_connections WHERE business_id = $1 AND connected_via = 'facebook_login' AND status = 'verified'
        AND (token_expires_at IS NULL OR token_expires_at > now()) ORDER BY updated_at DESC LIMIT 1`, [businessId]);
  if (!c) throw new MetaError('No working Facebook Login connection to refresh from. Click "Connect with Facebook" to sign in again.', 409);
  const token = decrypt(config.encryptionKey, c.token_enc);
  const perms = (await call(config, 'me/permissions', { access_token: token }).catch((err) => { if (/code 190/.test(err.message)) throw new MetaError('Meta no longer accepts the saved sign-in (it expired or was removed). Click "Connect with Facebook" to sign in again.', 401); return { data: [] }; })).data ?? [];
  const me = await call(config, 'me', { fields: 'name', access_token: token }).catch(() => ({}));
  const { accounts, truncated } = await discoverAccounts(config, token);
  return storeGrant(pool, config, { businessId, userId, token, tokenExpiresAt: c.token_expires_at, meName: me.name ?? null,
    granted: perms.filter((p) => p.status === 'granted').map((p) => p.permission), declined: perms.filter((p) => p.status !== 'granted').map((p) => p.permission), accounts, truncated });
}

// The pending grant of THIS business and user (without the token), or null.
export async function pendingGrant(pool, { businessId, userId }) {
  const { rows: [g] } = await pool.query(
    `SELECT id, meta_user_name, granted, declined, accounts, truncated, token_expires_at, expires_at FROM meta_oauth_grants
      WHERE business_id = $1 AND user_id = $2 AND expires_at > now() ORDER BY id DESC LIMIT 1`, [businessId, userId]);
  return g ?? null;
}

// Connects the chosen accounts (only ones Meta listed in this business's grant). Returns one result per account.
export async function connectFromGrant(pool, config, { businessId, userId, grantId, accountIds }) {
  const { rows: [g] } = await pool.query(
    'SELECT * FROM meta_oauth_grants WHERE id = $1 AND business_id = $2 AND user_id = $3 AND expires_at > now()', [grantId, businessId, userId]);
  if (!g) throw new MetaError('This Facebook sign-in has expired. Click "Connect with Facebook" again.', 410);
  const listed = new Map((g.accounts ?? []).map((a) => [a.id, a]));
  const wanted = [...new Set((Array.isArray(accountIds) ? accountIds : [accountIds]).map((a) => String(a ?? '').replace(/^act_/, '')).filter(Boolean))];
  if (!wanted.length) throw new MetaError('Tick at least one ad account to connect.');
  if (wanted.some((a) => !listed.has(a))) throw new MetaError('That ad account was not in the list Meta returned for your Facebook sign-in.', 400);
  const token = decrypt(config.encryptionKey, g.token_enc);
  const results = [];
  for (const id of wanted) {
    // Disabled or closed in Meta: reported, not connected (Meta delivers nothing there). Checked without calling Meta.
    if (listed.get(id).connectable === false) { results.push({ id, name: listed.get(id).name, ok: false, error: `the account is ${String(listed.get(id).status_label).toLowerCase()} in Meta, so it cannot be connected` }); continue; }
    try {
      await connectAccount(pool, config, { businessId, userId, token, adAccountId: id });
      await pool.query("UPDATE ad_connections SET connected_via = 'facebook_login', token_expires_at = $3 WHERE business_id = $1 AND ad_account_id = $2", [businessId, id, g.token_expires_at]);
      results.push({ id, name: listed.get(id).name, ok: true });
    } catch (err) {
      if (!(err instanceof MetaError)) throw err;
      results.push({ id, name: listed.get(id).name, ok: false, error: err.message });
    }
  }
  if (results.some((r) => r.ok)) await pool.query('DELETE FROM meta_oauth_grants WHERE id = $1', [g.id]);
  return { results, granted: g.granted, declined: g.declined };
}

export async function cancelGrant(pool, { businessId, userId }) {
  await pool.query('DELETE FROM meta_oauth_grants WHERE business_id = $1 AND user_id = $2', [businessId, userId]);
}
