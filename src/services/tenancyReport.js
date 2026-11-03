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
            coalesce((SELECT json_agg(json_build_object('id', u.id, 'email', u.email, 'role', m.role, 'admin', u.is_platform_admin, 'disabled', u.disabled_at IS NOT NULL) ORDER BY m.role, u.id)
                        FROM business_members m JOIN users u ON u.id = m.user_id WHERE m.business_id = b.id), '[]') AS members
       FROM businesses b ORDER BY b.id`);
  const { rows: users } = await pool.query(
    `SELECT u.id, u.email, u.is_platform_admin AS admin, u.disabled_at IS NOT NULL AS disabled, u.email LIKE $1 AS automated,
            (SELECT count(*)::int FROM business_members m WHERE m.user_id = u.id) AS memberships
       FROM users u ORDER BY u.id`, [E2E_EMAIL_LIKE]);
  console.log(`${P} BEGIN ${businesses.length} businesses, ${users.length} accounts (${users.filter((u) => u.admin).length} Super Admin, ${users.filter((u) => u.automated).length} automated test account)`);
  for (const b of businesses) {
    const m = b.members.map((x) => `${x.role}:${maskEmail(x.email)}#${x.id}${x.admin ? '(SUPER ADMIN)' : ''}${x.disabled ? '(disabled)' : ''}`).join(', ');
    const owners = b.members.filter((x) => x.role === 'owner').length;
    const testBusiness = /\(test\)$/.test(b.name);
    const noOwner = owners ? '' : testBusiness ? ' | no owner (labelled test business: its automated test accounts are disabled after each run)' : ' | WARNING: no owner';
    console.log(`${P} business #${b.id} ${b.slug} "${b.name}" | ${b.subscription_status}${b.plan ? ` ${b.plan}` : ''} | orders ${b.real_orders} real + ${b.test_orders} test | members: ${m || 'none'}${noOwner}`);
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
