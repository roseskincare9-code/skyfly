// Read-only start-up report of who belongs to which business (emails masked), so the account/workspace
// relationships in production can be checked without database access. Flags anything unusual: accounts
// in several businesses, businesses without an owner, Super Admins and their memberships, accounts with
// no workspace. Nothing is changed.
import { E2E_EMAIL_LIKE } from './setup.js';

export const maskEmail = (e) => { const [u, d] = String(e ?? '').split('@'); return d ? `${u.slice(0, 2)}…@${d}` : '?'; };

export async function logTenancyMap(pool) {
  const P = 'Tenancy map (read-only):';
  const { rows: businesses } = await pool.query(
    `SELECT b.id, b.slug, b.name, b.subscription_status, b.plan, b.created_at,
            (SELECT count(*)::int FROM orders o WHERE o.business_id = b.id AND NOT o.is_test) AS real_orders,
            (SELECT count(*)::int FROM orders o WHERE o.business_id = b.id AND o.is_test) AS test_orders,
            (SELECT max(o.created_at) FROM orders o WHERE o.business_id = b.id AND NOT o.is_test) AS last_real_order,
            (SELECT count(*)::int FROM products x WHERE x.business_id = b.id) AS products,
            (SELECT count(*)::int FROM landing_pages x WHERE x.business_id = b.id) AS pages,
            (SELECT count(*)::int FROM email_contacts x WHERE x.business_id = b.id) AS contacts,
            (SELECT count(DISTINCT x.phone)::int FROM orders x WHERE x.business_id = b.id AND NOT x.is_test) AS customers,
            (SELECT count(*)::int FROM checkout_sessions x WHERE x.business_id = b.id) AS checkouts,
            (SELECT count(*)::int FROM tracking_pixels x WHERE x.business_id = b.id) AS pixels,
            (SELECT count(*)::int FROM sheet_connections x WHERE x.business_id = b.id) AS sheets,
            (SELECT count(*)::int FROM api_keys x WHERE x.business_id = b.id AND x.revoked_at IS NULL) AS api_keys,
            (SELECT count(*)::int FROM business_invites x WHERE x.business_id = b.id AND x.accepted_at IS NULL AND x.revoked_at IS NULL AND x.expires_at > now()) AS open_invites,
            (SELECT json_agg(json_build_object('email', x.email, 'role', x.role, 'expires', x.expires_at) ORDER BY x.id)
               FROM business_invites x WHERE x.business_id = b.id AND x.accepted_at IS NULL AND x.revoked_at IS NULL AND x.expires_at > now()) AS invites,
            -- How it was made: by a Super Admin in Platform admin (with an owner invitation) or from a dashboard.
            (SELECT a.action FROM audit_log a WHERE a.business_id = b.id AND a.action IN ('admin.business_created', 'business.created', 'auth.signup') ORDER BY a.id LIMIT 1) AS created_via,
            (SELECT u.email FROM audit_log a JOIN users u ON u.id = a.user_id WHERE a.business_id = b.id AND a.action IN ('admin.business_created', 'business.created', 'auth.signup') ORDER BY a.id LIMIT 1) AS created_by,
            coalesce((SELECT json_agg(json_build_object('id', u.id, 'email', u.email, 'role', m.role, 'admin', u.is_platform_admin, 'disabled', u.disabled_at IS NOT NULL) ORDER BY m.role, u.id)
                        FROM business_members m JOIN users u ON u.id = m.user_id WHERE m.business_id = b.id), '[]') AS members
       FROM businesses b ORDER BY b.id`);
  const { rows: users } = await pool.query(
    `SELECT u.id, u.email, u.is_platform_admin AS admin, u.disabled_at IS NOT NULL AS disabled, u.email LIKE $1 AS automated,
            (SELECT count(*)::int FROM business_members m WHERE m.user_id = u.id) AS memberships
       FROM users u ORDER BY u.id`, [E2E_EMAIL_LIKE]);
  const { rows: [size] } = await pool.query('SELECT pg_size_pretty(pg_database_size(current_database())) AS pretty, pg_database_size(current_database()) AS bytes');
  console.log(`${P} DATABASE size ${size.pretty} (${size.bytes} bytes)`);
  console.log(`${P} BEGIN ${businesses.length} businesses, ${users.length} accounts (${users.filter((u) => u.admin).length} Super Admin, ${users.filter((u) => u.automated).length} automated test account)`);
  for (const b of businesses) {
    const m = b.members.map((x) => `${x.role}:${maskEmail(x.email)}#${x.id}${x.admin ? '(SUPER ADMIN)' : ''}${x.disabled ? '(disabled)' : ''}`).join(', ');
    const owners = b.members.filter((x) => x.role === 'owner').length;
    const testBusiness = /\(test\)$/.test(b.name);
    const noOwner = owners ? '' : testBusiness ? ' | no owner (labelled test business: its automated test accounts are disabled after each run)' : ' | WARNING: no owner';
    console.log(`${P} business #${b.id} ${b.slug} "${b.name}" | ${b.subscription_status}${b.plan ? ` ${b.plan}` : ''} | created ${new Date(b.created_at).toISOString().slice(0, 10)} | orders ${b.real_orders} real + ${b.test_orders} test${b.last_real_order ? ` (last real ${new Date(b.last_real_order).toISOString().slice(0, 10)})` : ''} | customers ${b.customers}, contacts ${b.contacts}, products ${b.products}, pages ${b.pages}, checkouts ${b.checkouts}, pixels ${b.pixels}, sheets ${b.sheets}, API keys ${b.api_keys}, open invites ${b.open_invites}${b.invites ? ` (${b.invites.map((i) => `${i.role} ${maskEmail(i.email)} until ${new Date(i.expires).toISOString().slice(0, 10)}`).join(', ')})` : ''} | members: ${m || 'none'}${noOwner}${b.created_via ? ` | created via ${b.created_via === 'admin.business_created' ? 'Platform admin (owner invitation)' : b.created_via === 'auth.signup' ? 'public registration' : 'registration or the dashboard'}${b.created_by ? ` by ${maskEmail(b.created_by)}` : ''}` : ''}`);
  }
  // Orders not marked as test inside labelled test businesses: evidence for the owner (read-only).
  const { rows: odd } = await pool.query(
    `SELECT o.id, o.reference, o.created_at, o.source, o.status, o.payment_status, o.is_test, o.total_minor, o.currency, o.customer_name, b.id AS business_id, b.name AS business,
            (SELECT u.email FROM audit_log a JOIN users u ON u.id = a.user_id WHERE a.entity_id = o.reference AND a.action = 'order.created_manually' ORDER BY a.id LIMIT 1) AS created_by,
            (SELECT string_agg(a.action, ', ' ORDER BY a.id) FROM audit_log a WHERE a.entity_id = o.reference) AS history
       FROM orders o JOIN businesses b ON b.id = o.business_id WHERE b.name LIKE '%(test)' AND NOT o.is_test ORDER BY o.id`);
  for (const o of odd) {
    console.log(`${P} TEST-BUSINESS ORDER not marked test: order id ${o.id} ${o.reference} in business #${o.business_id} "${o.business}" | created ${new Date(o.created_at).toISOString()} | source ${o.source} | ${o.status}/${o.payment_status} | ${o.currency} ${Number(o.total_minor) / 100} | customer first word "${String(o.customer_name).trim().split(/\s+/)[0].slice(0, 30)}" | created by ${o.created_by ? maskEmail(o.created_by) : '?'} | history: ${o.history ?? '—'}`);
  }
  for (const u of users.filter((x) => x.admin)) console.log(`${P} SUPER ADMIN account #${u.id} ${maskEmail(u.email)} — member of ${u.memberships} business(es)${u.disabled ? ' (disabled)' : ''}`);
  for (const u of users.filter((x) => !x.admin && x.memberships > 1)) console.log(`${P} NOTE account #${u.id} ${maskEmail(u.email)}${u.automated ? ' (automated test account)' : ''} belongs to ${u.memberships} businesses`);
  const none = users.filter((x) => !x.admin && x.memberships === 0);
  console.log(`${P} END accounts with no workspace: ${none.length}${none.length ? ` (${none.map((u) => `#${u.id} ${maskEmail(u.email)}${u.disabled ? ' disabled' : ''}`).join(', ')})` : ''}`);
}
