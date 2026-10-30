// Team members of one business: invite by email (a one-time link), change roles, remove.
import { Router } from 'express';
import { asyncHandler } from '../lib/http.js';
import { audit } from '../lib/audit.js';
import { createHash } from 'node:crypto';
import { ROLES, ROLE_LABELS, createInvite, hashToken } from '../services/tenancy.js';
import { sendEmail } from '../services/emailProviders.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Always an invitation link that the person accepts while signed in with that email: nobody is added to a
// business without agreeing, and the answer is the same whether or not the email has a Skyfly account.
// Someone already in the business keeps their role (change it under Team instead).
export async function inviteOrAdd(pool, req, config, { businessId, email, role }) {
  const { rows: [member] } = await pool.query(
    'SELECT m.role FROM business_members m JOIN users u ON u.id = m.user_id WHERE m.business_id = $1 AND u.email = $2', [businessId, email]);
  if (member) return { alreadyMember: member.role };
  const token = await createInvite(pool, { businessId, email, role, createdBy: req.session.userId });
  const link = `${config.publicBaseUrl || `${req.protocol}://${req.get('host')}`}/invite/${token}`;
  // With Skyfly's email sender set up, the link goes only to the invited mailbox and is never shown here,
  // so accepting it proves the person controls that email address (email verification).
  const sender = config.notifyEmail;
  if (sender?.apiKey && sender.fromEmail) {
    const { rows: [b] } = await pool.query('SELECT name FROM businesses WHERE id = $1', [businessId]);
    try {
      await sendEmail({ provider: sender.provider, apiKey: sender.apiKey, baseOverride: config.emailApiBase || null }, {
        to: email, fromEmail: sender.fromEmail, fromName: sender.fromName || 'Skyfly', replyTo: null, headers: {},
        idempotencyKey: `invite:${createHash('sha256').update(token).digest('hex').slice(0, 32)}`,
        subject: `You're invited to ${b.name} on Skyfly`,
        text: `You were invited to join ${b.name} on Skyfly as ${ROLE_LABELS[role]}.\n\nOpen this link to accept (it works once, for 14 days):\n\n${link}\n\nIf you weren't expecting this, ignore this email.`,
        html: `<p>You were invited to join <strong>${esc(b.name)}</strong> on Skyfly as ${esc(ROLE_LABELS[role])}.</p><p><a href="${esc(link)}">Accept the invitation</a> (works once, for 14 days).</p><p>If you weren't expecting this, ignore this email.</p>`,
      });
    } catch (err) {
      // Not sent: the link was never shown anywhere, so it is cancelled.
      await pool.query('UPDATE business_invites SET revoked_at = now() WHERE token_hash = $1', [hashToken(token)]);
      await audit(pool, req, { action: 'team.invite_email_failed', businessId, details: { email, role } });
      return { error: `The invitation email to ${email} could not be sent (${String(err.message).slice(0, 120)}). Nothing was created; try again.` };
    }
    await audit(pool, req, { action: 'team.invited', businessId, details: { email, role, emailed: true } });
    return { emailed: true };
  }
  await audit(pool, req, { action: 'team.invited', businessId, details: { email, role, emailed: false } });
  return { link };
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
    if (result.alreadyMember) return render(req, res, { error: `${f.email} is already in this business as ${ROLE_LABELS[result.alreadyMember]}. Change their role under Team.`, status: 409 });
    if (result.error) return render(req, res, { error: result.error, status: 502 });
    if (result.emailed) return render(req, res, { notice: `Invitation emailed to ${f.email} (valid 14 days). Only the person with that mailbox can accept it.` });
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
