// Client workspaces: who may open a business (members and the platform owner), what each
// role may do, platform settings, and owner-managed subscriptions that lock a client's
// workspace after its expiry date. Data is never deleted when an account expires.
import { createHash, randomBytes } from 'node:crypto';

export const ROLES = ['owner', 'manager', 'staff'];
export const ROLE_LABELS = { owner: 'Owner', manager: 'Manager', staff: 'Staff' };

// What each role may do in a workspace. The platform owner acts as "owner".
const PERMISSIONS = {
  owner: new Set(['orders', 'catalog', 'marketing', 'integrations', 'settings', 'team']),
  manager: new Set(['orders', 'catalog', 'marketing', 'integrations', 'settings']),
  staff: new Set(['orders']),
};
export const can = (role, permission) => Boolean(PERMISSIONS[role]?.has(permission));

export const SUBSCRIPTION_STATUSES = ['internal', 'trial', 'active', 'expired', 'locked'];
export const SUBSCRIPTION_LABELS = { internal: 'Internal (never expires)', trial: 'Trial', active: 'Active', expired: 'Expired', locked: 'Locked' };

// SQL for "today in the business's own time zone", so nobody is locked out early.
const LOCAL_TODAY = '(now() AT TIME ZONE b.timezone)::date';

// Loads a business for a user, if the user may open it. Returns null otherwise.
export async function workspaceAccess(pool, userId, businessId) {
  const { rows: [row] } = await pool.query(
    `SELECT b.*, m.role AS member_role, u.is_platform_admin, ${LOCAL_TODAY}::text AS local_today
       FROM businesses b CROSS JOIN users u
       LEFT JOIN business_members m ON m.business_id = b.id AND m.user_id = u.id
      WHERE b.id = $1 AND u.id = $2 AND (m.user_id IS NOT NULL OR u.is_platform_admin)`,
    [businessId, userId]);
  if (!row) return null;
  return { business: row, role: row.member_role ?? 'owner', isPlatformAdmin: row.is_platform_admin, viaAdmin: !row.member_role };
}

// Whether the client's workspace is open, from the stored status and today's date in the
// business's time zone. An account is usable through its whole expiry day.
export function subscriptionState(b) {
  const status = b.subscription_status;
  if (status === 'internal') return { open: true, status };
  if (status === 'locked') return { open: false, status, reason: 'locked' };
  const past = Boolean(b.subscription_expires_on) && String(b.local_today) > String(b.subscription_expires_on);
  if (status === 'expired' || past) return { open: false, status: 'expired', reason: 'expired', becameExpired: status !== 'expired' };
  return { open: true, status };
}

// Marks every trial/active subscription whose expiry day has passed as expired, and logs it.
export async function expireSubscriptions(pool) {
  const { rows } = await pool.query(
    `UPDATE businesses b SET subscription_status = 'expired', subscription_updated_at = now()
      WHERE subscription_status IN ('trial', 'active') AND subscription_expires_on IS NOT NULL
        AND ${LOCAL_TODAY} > subscription_expires_on
      RETURNING id, subscription_expires_on::text AS expired_on`);
  for (const r of rows) {
    await pool.query(
      "INSERT INTO audit_log (business_id, action, entity_type, entity_id, details) VALUES ($1, 'subscription.expired', 'business', $2, $3)",
      [r.id, String(r.id), JSON.stringify({ expiredOn: r.expired_on, automatic: true })]);
  }
  return rows.length;
}

export async function platformSettings(pool) {
  const { rows } = await pool.query('SELECT key, value FROM platform_settings');
  const s = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return {
    clientSignup: s.client_signup === 'open' ? 'open' : 'invite_only',
    trialDays: Number.isInteger(s.trial_days) ? s.trial_days : 7,
    renewalInstructions: typeof s.renewal_instructions === 'string' ? s.renewal_instructions : '',
  };
}

export async function savePlatformSetting(pool, key, value) {
  await pool.query(
    `INSERT INTO platform_settings (key, value, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [key, JSON.stringify(value)]);
}

// ---- Invites: a random token is shown once (as a link); only its hash is stored.
export const hashToken = (token) => createHash('sha256').update(token).digest('hex');

export async function createInvite(pool, { businessId, email, role, createdBy, days = 14 }) {
  const token = randomBytes(24).toString('base64url');
  // Only the newest link for this business and email works: earlier unused ones are revoked.
  await pool.query(
    'UPDATE business_invites SET revoked_at = now() WHERE business_id = $1 AND email = $2 AND accepted_at IS NULL AND revoked_at IS NULL',
    [businessId, email.toLowerCase()]);
  await pool.query(
    `INSERT INTO business_invites (business_id, email, role, token_hash, created_by, expires_at)
     VALUES ($1, $2, $3, $4, $5, now() + make_interval(days => $6))`,
    [businessId, email.toLowerCase(), role, hashToken(token), createdBy, days]);
  return token;
}

export async function findInvite(pool, token) {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(String(token ?? ''))) return null;
  const { rows: [invite] } = await pool.query(
    `SELECT i.*, b.name AS business_name FROM business_invites i JOIN businesses b ON b.id = i.business_id
      WHERE i.token_hash = $1 AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now()`,
    [hashToken(token)]);
  return invite ?? null;
}

// Why an invitation link does not work (for a clear message), or null when it does.
export async function inviteProblem(pool, token) {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(String(token ?? ''))) return 'invalid';
  const { rows: [i] } = await pool.query(
    'SELECT accepted_at, revoked_at, expires_at <= now() AS expired FROM business_invites WHERE token_hash = $1', [hashToken(token)]);
  if (!i) return 'invalid';
  if (i.accepted_at) return 'used';
  if (i.revoked_at) return 'revoked';
  if (i.expired) return 'expired';
  return null;
}
export const INVITE_PROBLEMS = {
  invalid: 'This invitation link is not valid. Check that the whole link was copied, or ask for a new one.',
  used: 'This invitation has already been used. Sign in to open the business, or ask the business owner for a new invitation.',
  revoked: 'This invitation was cancelled or replaced by a newer one. Use the latest link you were sent, or ask for a new one.',
  expired: 'This invitation has expired. Ask the business owner (or the Skyfly team) for a new one.',
};

// Adds the user to the invite's business (keeps a stronger existing role) and closes the invite, in one
// transaction: the invite is claimed first, so a link can be used once only, even twice at the same time.
// Returns false when the invite was no longer open.
export async function acceptInvite(pool, invite, userId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rowCount } = await client.query(
      `UPDATE business_invites SET accepted_at = now(), accepted_by = $2
        WHERE id = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()`, [invite.id, userId]);
    if (!rowCount) { await client.query('ROLLBACK'); return false; }
    await client.query(
      `INSERT INTO business_members (business_id, user_id, role) VALUES ($1, $2, $3)
       ON CONFLICT (business_id, user_id) DO UPDATE SET role = CASE
         WHEN business_members.role = 'owner' OR EXCLUDED.role = 'owner' THEN 'owner'
         WHEN business_members.role = 'manager' OR EXCLUDED.role = 'manager' THEN 'manager' ELSE 'staff' END`,
      [invite.business_id, userId, invite.role]);
    await client.query('COMMIT');
    return true;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// "Done / to do" for a client's setup, shown on the platform owner's dashboard.
export function setupStatus(b) {
  const steps = [
    ['Products', b.product_count > 0],
    ['Landing page', b.page_count > 0],
    ['First order', b.order_count > 0],
    ['Email sending', Boolean(b.email_ready)],
  ];
  return { done: steps.filter(([, ok]) => ok).length, total: steps.length, missing: steps.filter(([, ok]) => !ok).map(([n]) => n) };
}
