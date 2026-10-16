// Team members of one business: invite by email (a one-time link), change roles, remove.
import { Router } from 'express';
import { asyncHandler } from '../lib/http.js';
import { audit } from '../lib/audit.js';
import { ROLES, ROLE_LABELS, createInvite } from '../services/tenancy.js';

export async function inviteOrAdd(pool, req, config, { businessId, email, role }) {
  const { rows: [user] } = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
  if (user) {
    await pool.query(
      `INSERT INTO business_members (business_id, user_id, role) VALUES ($1, $2, $3)
       ON CONFLICT (business_id, user_id) DO UPDATE SET role = EXCLUDED.role`, [businessId, user.id, role]);
    await audit(pool, req, { action: 'team.member_added', businessId, entityType: 'user', entityId: user.id, details: { role } });
    return { added: true };
  }
  const token = await createInvite(pool, { businessId, email, role, createdBy: req.session.userId });
  await audit(pool, req, { action: 'team.invited', businessId, details: { email, role } });
  return { link: `${config.publicBaseUrl || `${req.protocol}://${req.get('host')}`}/invite/${token}` };
}

export function readInvite(body) {
  const email = String(body.email ?? '').trim().toLowerCase().slice(0, 200);
  const role = ROLES.includes(body.role) ? body.role : null;
  const errors = [];
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.push('Enter a valid email address.');
  if (!role) errors.push('Choose a role.');
  return { email, role, errors };
}

export function teamRoutes({ pool, config }) {
  const router = Router({ mergeParams: true });

  async function render(req, res, { error = null, notice = null, link = null, status = 200 } = {}) {
    const [{ rows: members }, { rows: invites }] = await Promise.all([
      pool.query(
        `SELECT u.id, u.name, u.email, m.role, m.created_at FROM business_members m JOIN users u ON u.id = m.user_id
          WHERE m.business_id = $1 ORDER BY m.role = 'owner' DESC, m.created_at`, [req.business.id]),
      pool.query(
        `SELECT id, email, role, created_at, expires_at FROM business_invites
          WHERE business_id = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now() ORDER BY id DESC`, [req.business.id]),
    ]);
    res.set('Cache-Control', 'no-store');
    res.status(status).render('team', { active: 'settings', members, invites, error, notice, link, ROLES, ROLE_LABELS });
  }

  router.get('/', asyncHandler((req, res) => render(req, res)));

  router.post('/invite', asyncHandler(async (req, res) => {
    const f = readInvite(req.body);
    if (f.errors.length) return render(req, res, { error: f.errors.join(' '), status: 400 });
    const result = await inviteOrAdd(pool, req, config, { businessId: req.business.id, email: f.email, role: f.role });
    if (result.added) return render(req, res, { notice: `${f.email} already has a Skyfly account and was added as ${ROLE_LABELS[f.role]}.` });
    return render(req, res, { notice: `Invite created for ${f.email}. Send them this link (valid 14 days, shown once):`, link: result.link });
  }));

  async function ownerCount(businessId) {
    const { rows: [r] } = await pool.query("SELECT count(*)::int AS n FROM business_members WHERE business_id = $1 AND role = 'owner'", [businessId]);
    return r.n;
  }

  router.post('/members/:userId/role', asyncHandler(async (req, res) => {
    const role = ROLES.includes(req.body.role) ? req.body.role : null;
    if (!role || !/^\d+$/.test(req.params.userId)) return render(req, res, { error: 'Choose a role.', status: 400 });
    const { rows: [m] } = await pool.query('SELECT role FROM business_members WHERE business_id = $1 AND user_id = $2', [req.business.id, req.params.userId]);
    if (!m) return res.status(404).render('error', { message: 'Member not found.' });
    if (m.role === 'owner' && role !== 'owner' && await ownerCount(req.business.id) < 2) return render(req, res, { error: 'A business needs at least one owner.', status: 400 });
    await pool.query('UPDATE business_members SET role = $3 WHERE business_id = $1 AND user_id = $2', [req.business.id, req.params.userId, role]);
    await audit(pool, req, { action: 'team.role_changed', businessId: req.business.id, entityType: 'user', entityId: req.params.userId, details: { from: m.role, to: role } });
    res.redirect(`${res.locals.base}/team`);
  }));

  router.post('/members/:userId/remove', asyncHandler(async (req, res) => {
    if (!/^\d+$/.test(req.params.userId)) return res.status(404).render('error', { message: 'Member not found.' });
    const { rows: [m] } = await pool.query('SELECT role FROM business_members WHERE business_id = $1 AND user_id = $2', [req.business.id, req.params.userId]);
    if (!m) return res.status(404).render('error', { message: 'Member not found.' });
    if (m.role === 'owner' && await ownerCount(req.business.id) < 2) return render(req, res, { error: 'A business needs at least one owner.', status: 400 });
    await pool.query('DELETE FROM business_members WHERE business_id = $1 AND user_id = $2', [req.business.id, req.params.userId]);
    await audit(pool, req, { action: 'team.member_removed', businessId: req.business.id, entityType: 'user', entityId: req.params.userId });
    res.redirect(`${res.locals.base}/team`);
  }));

  router.post('/invites/:inviteId/revoke', asyncHandler(async (req, res) => {
    if (/^\d+$/.test(req.params.inviteId)) {
      await pool.query('UPDATE business_invites SET revoked_at = now() WHERE id = $1 AND business_id = $2', [req.params.inviteId, req.business.id]);
      await audit(pool, req, { action: 'team.invite_revoked', businessId: req.business.id, entityId: req.params.inviteId });
    }
    res.redirect(`${res.locals.base}/team`);
  }));

  return router;
}
