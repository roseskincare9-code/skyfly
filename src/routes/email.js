// Email Automations (one place for templates, automation sequences, sending history and the
// business's sending setup) and Email Contacts (consent and unsubscribe status).
import { Router } from 'express';
import { asyncHandler } from '../lib/http.js';
import { audit } from '../lib/audit.js';
import { toCsv } from '../lib/csv.js';
import { encrypt } from '../lib/secrets.js';
import { PROVIDERS, PLACEHOLDERS, unknownPlaceholders, renderEmail } from '../services/emailProviders.js';
import { ANCHORS, SAMPLE_VALUES, orderValues, retryMessages, sendTestEmail, cancelIneligible } from '../services/emailAutomation.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const id = (v) => (/^\d+$/.test(String(v ?? '')) ? String(v) : null);

// Starting points the owner edits. Processing emails never say an order has shipped or arrived.
const PRESETS = {
  processing: {
    name: 'Order still processing', kind: 'processing', anchor: 'processing_since',
    steps: [
      { delay: 1, purpose: 'operational', name: 'Processing — day 1', subject: 'Your order {{order_reference}} is being prepared',
        body: 'Hi {{first_name}},\n\nThank you for your order with {{business_name}}. Your order ({{order_items}}) is being processed.\n\nWe will contact you as soon as it is ready for delivery. If you have a question, just reply to this email.\n\n{{business_name}}' },
      { delay: 2, purpose: 'operational', name: 'Processing — day 2', subject: 'An update on your order {{order_reference}}',
        body: 'Hi {{first_name}},\n\nA quick update: your order {{order_reference}} is still being processed. We have not forgotten you.\n\nWe will contact you as soon as it is ready for delivery.\n\n{{business_name}}' },
      { delay: 3, purpose: 'operational', name: 'Processing — day 3', subject: 'Your order {{order_reference}} is still in progress',
        body: 'Hi {{first_name}},\n\nThank you for your patience. Your order {{order_reference}} ({{order_total}}) is still being processed. If anything has changed on your side (address or phone number), please reply to this email.\n\n{{business_name}}' },
    ],
  },
  post_purchase: {
    name: 'Post-purchase follow-up', kind: 'post_purchase', anchor: 'delivered_date',
    steps: [
      { delay: 7, purpose: 'operational', name: 'After purchase — how to use', subject: 'Getting the best from your {{order_items}}',
        body: 'Hi {{first_name}},\n\nHere are a few tips to get the best results from your order:\n\n• Use it as directed on the pack.\n• Be consistent: results build over time.\n\nAny questions? Just reply to this email.\n\n{{business_name}}' },
      { delay: 10, purpose: 'operational', name: 'After purchase — check-in', subject: 'How are you finding your order, {{first_name}}?',
        body: 'Hi {{first_name}},\n\nIt has been a little while since your order {{order_reference}}. How are you finding it? Reply and let us know: we read every message.\n\n{{business_name}}' },
      { delay: 30, purpose: 'marketing', name: 'After purchase — reorder offer', subject: 'A thank-you from {{business_name}}',
        body: 'Hi {{first_name}},\n\nThank you for being a customer. If you would like to order again, reply to this email and we will look after you.\n\n{{business_name}}' },
    ],
  },
};

export function emailRoutes({ pool, config }) {
  const router = Router({ mergeParams: true });
  const key = config.encryptionKey ?? null;

  const getSettings = async (businessId) => (await pool.query('SELECT * FROM email_settings WHERE business_id = $1', [businessId])).rows[0] ?? null;
  const ready = (s) => Boolean(s?.api_key_enc && s.from_email);

  // ---------- Hub: automations, templates, history, setup
  router.get('/', asyncHandler(async (req, res) => {
    const b = req.business.id;
    const filter = ['queued', 'sent', 'failed', 'skipped', 'cancelled'].includes(req.query.status) ? req.query.status : '';
    const [{ rows: automations }, { rows: templates }, { rows: messages }, { rows: counts }, settings] = await Promise.all([
      pool.query(
        `SELECT a.*, (SELECT json_agg(json_build_object('delay', s.delay_days, 'purpose', s.purpose, 'template', t.name) ORDER BY s.delay_days, s.id)
                        FROM email_automation_steps s JOIN email_templates t ON t.id = s.template_id WHERE s.automation_id = a.id AND s.removed_at IS NULL) AS steps,
                (SELECT count(*)::int FROM email_messages m WHERE m.automation_id = a.id AND m.status = 'sent') AS sent,
                (SELECT count(*)::int FROM email_messages m WHERE m.automation_id = a.id AND m.status = 'queued') AS queued
           FROM email_automations a WHERE a.business_id = $1 ORDER BY a.status = 'stopped', a.id`, [b]),
      pool.query(`SELECT t.*, (SELECT count(*)::int FROM email_automation_steps s WHERE s.template_id = t.id AND s.removed_at IS NULL) AS used
                    FROM email_templates t WHERE t.business_id = $1 ORDER BY t.name`, [b]),
      pool.query(
        `SELECT m.*, o.reference, a.name AS automation_name FROM email_messages m LEFT JOIN orders o ON o.id = m.order_id
           LEFT JOIN email_automations a ON a.id = m.automation_id
          WHERE m.business_id = $1 ${filter ? 'AND m.status = $2' : ''} ORDER BY coalesce(m.sent_at, m.scheduled_for) DESC, m.id DESC LIMIT 100`,
        filter ? [b, filter] : [b]),
      pool.query('SELECT status, count(*)::int AS n FROM email_messages WHERE business_id = $1 GROUP BY status', [b]),
      getSettings(b),
    ]);
    const notice = {
      created: 'Automation created as a draft. Check the messages, then Activate.', settings: 'Sending setup saved.', test: 'Test email accepted by the provider.',
      retry: 'Queued again. It is sent within a minute if the order is still eligible.', template: 'Template saved.', status: 'Automation updated.',
    }[req.query.done] ?? null;
    res.set('Cache-Control', 'no-store');
    res.render('email', {
      active: 'email', automations, templates, messages, counts: Object.fromEntries(counts.map((c) => [c.status, c.n])), filter,
      settings, ready: ready(settings), encryptionReady: Boolean(key), PROVIDERS, ANCHORS, notice, error: req.query.error ?? null, tab: req.query.tab || 'automations',
    });
  }));

  // ---------- Sending setup (business's own provider account)
  router.post('/settings', asyncHandler(async (req, res) => {
    const provider = Object.hasOwn(PROVIDERS, req.body.provider) ? req.body.provider : null;
    const apiKey = String(req.body.api_key ?? '').trim();
    const fromEmail = String(req.body.from_email ?? '').trim().toLowerCase();
    const fromName = String(req.body.from_name ?? '').trim().slice(0, 100) || null;
    const replyTo = String(req.body.reply_to ?? '').trim().toLowerCase() || null;
    const postal = String(req.body.postal_address ?? '').trim().slice(0, 300) || null;
    const errors = [];
    if (!provider) errors.push('Choose a provider.');
    if (apiKey && provider && !PROVIDERS[provider].keyRe.test(apiKey)) errors.push(`That does not look like a ${PROVIDERS[provider].label} API key (${PROVIDERS[provider].keyHelp}).`);
    if (apiKey && !key) errors.push('API keys can\'t be stored until SKYFLY_ENCRYPTION_KEY is set on the server.');
    if (!EMAIL_RE.test(fromEmail)) errors.push('Enter the sender email address (on a domain verified with your provider).');
    if (replyTo && !EMAIL_RE.test(replyTo)) errors.push('Reply-to must be an email address.');
    if (errors.length) return res.redirect(`${res.locals.base}/email?tab=setup&error=${encodeURIComponent(errors.join(' '))}`);
    const existing = await getSettings(req.business.id);
    const providerChanged = existing && existing.provider !== provider;
    if (!apiKey && (!existing?.api_key_enc || providerChanged)) return res.redirect(`${res.locals.base}/email?tab=setup&error=${encodeURIComponent('Enter the provider API key.')}`);
    await pool.query(
      `INSERT INTO email_settings (business_id, provider, api_key_enc, api_key_hint, from_email, from_name, reply_to, postal_address, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
       ON CONFLICT (business_id) DO UPDATE SET provider = EXCLUDED.provider,
         api_key_enc = coalesce(EXCLUDED.api_key_enc, email_settings.api_key_enc), api_key_hint = coalesce(EXCLUDED.api_key_hint, email_settings.api_key_hint),
         from_email = EXCLUDED.from_email, from_name = EXCLUDED.from_name, reply_to = EXCLUDED.reply_to, postal_address = EXCLUDED.postal_address,
         verified_at = CASE WHEN EXCLUDED.api_key_enc IS NOT NULL OR email_settings.from_email <> EXCLUDED.from_email THEN NULL ELSE email_settings.verified_at END,
         updated_at = now()`,
      [req.business.id, provider, apiKey ? encrypt(key, apiKey) : null, apiKey ? `…${apiKey.slice(-4)}` : null, fromEmail, fromName, replyTo, postal]);
    await audit(pool, req, { action: 'email.settings_updated', businessId: req.business.id, details: { provider, fromEmail, keyChanged: Boolean(apiKey) } });
    res.redirect(`${res.locals.base}/email?tab=setup&done=settings`);
  }));

  router.post('/settings/test', asyncHandler(async (req, res) => {
    const to = String(req.body.to ?? '').trim().toLowerCase();
    if (!EMAIL_RE.test(to)) return res.redirect(`${res.locals.base}/email?tab=setup&error=${encodeURIComponent('Enter the address to send the test to.')}`);
    try {
      await sendTestEmail(pool, config, { business: req.business, template: null, to });
    } catch (err) {
      return res.redirect(`${res.locals.base}/email?tab=setup&error=${encodeURIComponent(err.message)}`);
    }
    await audit(pool, req, { action: 'email.test_sent', businessId: req.business.id, details: { to } });
    res.redirect(`${res.locals.base}/email?tab=setup&done=test`);
  }));

  // ---------- Templates
  function readTemplate(body) {
    const name = String(body.name ?? '').trim().slice(0, 120);
    const subject = String(body.subject ?? '').trim().slice(0, 200);
    const text = String(body.body ?? '').replace(/\r\n/g, '\n').trim().slice(0, 20000);
    const errors = [];
    if (!name) errors.push('Give the template a name.');
    if (!subject) errors.push('Write a subject line.');
    if (!text) errors.push('Write the message.');
    const unknown = [...new Set([...unknownPlaceholders(subject), ...unknownPlaceholders(text)])];
    if (unknown.length) errors.push(`Unknown placeholder${unknown.length > 1 ? 's' : ''}: ${unknown.map((u) => `{{${u}}}`).join(', ')}.`);
    return { name, subject, body: text, errors };
  }

  async function renderTemplate(req, res, template, { error = null, notice = null, status = 200 } = {}) {
    const settings = await getSettings(req.business.id);
    const { rows: recent } = await pool.query(
      'SELECT id, reference, customer_name FROM orders WHERE business_id = $1 AND email IS NOT NULL ORDER BY id DESC LIMIT 10', [req.business.id]);
    let values = SAMPLE_VALUES(req.business);
    const previewOrder = id(req.query.order);
    if (previewOrder) {
      const { rows: [o] } = await pool.query('SELECT * FROM orders WHERE id = $1 AND business_id = $2', [previewOrder, req.business.id]);
      if (o) values = await orderValues(pool, o, req.business);
    }
    const preview = template.subject && template.body
      ? renderEmail({ template, values, business: req.business, settings: settings ?? {}, unsubscribeUrl: `${config.publicBaseUrl}/u/preview`, purpose: 'marketing' }) : null;
    res.set('Cache-Control', 'no-store');
    res.status(status).render('email-template', { active: 'email', template, preview, recent, previewOrder, error, notice, PLACEHOLDERS, ready: ready(settings) });
  }

  const loadTemplate = async (req) => {
    if (!id(req.params.templateId)) return null;
    return (await pool.query('SELECT * FROM email_templates WHERE id = $1 AND business_id = $2', [req.params.templateId, req.business.id])).rows[0] ?? null;
  };

  router.get('/templates/new', asyncHandler((req, res) => renderTemplate(req, res, { name: '', subject: '', body: '' })));
  router.post('/templates', asyncHandler(async (req, res) => {
    const t = readTemplate(req.body);
    if (t.errors.length) return renderTemplate(req, res, t, { error: t.errors.join(' '), status: 400 });
    const { rows: [row] } = await pool.query('INSERT INTO email_templates (business_id, name, subject, body) VALUES ($1, $2, $3, $4) RETURNING id', [req.business.id, t.name, t.subject, t.body]);
    await audit(pool, req, { action: 'email.template_created', businessId: req.business.id, entityId: row.id });
    res.redirect(`${res.locals.base}/email/templates/${row.id}?done=1`);
  }));
  router.get('/templates/:templateId', asyncHandler(async (req, res) => {
    const t = await loadTemplate(req);
    if (!t) return res.status(404).render('error', { message: 'Template not found.' });
    await renderTemplate(req, res, t, { notice: req.query.done ? 'Saved.' : req.query.test ? 'Test email accepted by the provider.' : null, error: req.query.error ?? null });
  }));
  router.post('/templates/:templateId', asyncHandler(async (req, res) => {
    const existing = await loadTemplate(req);
    if (!existing) return res.status(404).render('error', { message: 'Template not found.' });
    const t = readTemplate(req.body);
    if (t.errors.length) return renderTemplate(req, res, { ...existing, ...t }, { error: t.errors.join(' '), status: 400 });
    await pool.query('UPDATE email_templates SET name = $3, subject = $4, body = $5, updated_at = now() WHERE id = $1 AND business_id = $2', [existing.id, req.business.id, t.name, t.subject, t.body]);
    await audit(pool, req, { action: 'email.template_updated', businessId: req.business.id, entityId: existing.id });
    res.redirect(`${res.locals.base}/email/templates/${existing.id}?done=1`);
  }));
  router.post('/templates/:templateId/duplicate', asyncHandler(async (req, res) => {
    const t = await loadTemplate(req);
    if (!t) return res.status(404).render('error', { message: 'Template not found.' });
    const { rows: [row] } = await pool.query('INSERT INTO email_templates (business_id, name, subject, body) VALUES ($1, $2, $3, $4) RETURNING id', [req.business.id, `${t.name} (copy)`.slice(0, 120), t.subject, t.body]);
    res.redirect(`${res.locals.base}/email/templates/${row.id}`);
  }));
  router.post('/templates/:templateId/delete', asyncHandler(async (req, res) => {
    const t = await loadTemplate(req);
    if (!t) return res.status(404).render('error', { message: 'Template not found.' });
    const { rows: [u] } = await pool.query('SELECT count(*)::int AS n FROM email_automation_steps WHERE template_id = $1', [t.id]);
    if (u.n) return res.redirect(`${res.locals.base}/email/templates/${t.id}?error=${encodeURIComponent('This template is used by an automation step (or its history). Remove it from the automation first, or keep it.')}`);
    await pool.query('DELETE FROM email_templates WHERE id = $1 AND business_id = $2', [t.id, req.business.id]);
    res.redirect(`${res.locals.base}/email?tab=templates`);
  }));
  router.post('/templates/:templateId/test', asyncHandler(async (req, res) => {
    const t = await loadTemplate(req);
    if (!t) return res.status(404).render('error', { message: 'Template not found.' });
    const to = String(req.body.to ?? '').trim().toLowerCase();
    if (!EMAIL_RE.test(to)) return res.redirect(`${res.locals.base}/email/templates/${t.id}?error=${encodeURIComponent('Enter the address to send the test to (your own, not a customer\'s).')}`);
    try {
      await sendTestEmail(pool, config, { business: req.business, template: t, to, orderId: id(req.body.order) });
    } catch (err) {
      return res.redirect(`${res.locals.base}/email/templates/${t.id}?error=${encodeURIComponent(err.message)}`);
    }
    await audit(pool, req, { action: 'email.test_sent', businessId: req.business.id, entityId: t.id, details: { to } });
    res.redirect(`${res.locals.base}/email/templates/${t.id}?test=1`);
  }));

  // ---------- Automations
  const loadAutomation = async (req) => {
    if (!id(req.params.automationId)) return null;
    return (await pool.query('SELECT * FROM email_automations WHERE id = $1 AND business_id = $2', [req.params.automationId, req.business.id])).rows[0] ?? null;
  };

  router.post('/automations', asyncHandler(async (req, res) => {
    const preset = PRESETS[req.body.preset];
    if (!preset) return res.redirect(`${res.locals.base}/email?error=${encodeURIComponent('Choose an automation type.')}`);
    const client = await pool.connect();
    let automationId;
    try {
      await client.query('BEGIN');
      ({ rows: [{ id: automationId }] } = await client.query(
        'INSERT INTO email_automations (business_id, name, kind, anchor) VALUES ($1, $2, $3, $4) RETURNING id', [req.business.id, preset.name, preset.kind, preset.anchor]));
      for (const s of preset.steps) {
        const { rows: [t] } = await client.query('INSERT INTO email_templates (business_id, name, subject, body) VALUES ($1, $2, $3, $4) RETURNING id', [req.business.id, s.name, s.subject, s.body]);
        await client.query('INSERT INTO email_automation_steps (business_id, automation_id, template_id, delay_days, purpose) VALUES ($1, $2, $3, $4, $5)', [req.business.id, automationId, t.id, s.delay, s.purpose]);
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    await audit(pool, req, { action: 'email.automation_created', businessId: req.business.id, entityId: automationId, details: { kind: preset.kind } });
    res.redirect(`${res.locals.base}/email/automations/${automationId}?done=created`);
  }));

  async function renderAutomation(req, res, a, { error = null, notice = null, status = 200 } = {}) {
    const [{ rows: steps }, { rows: templates }, { rows: history }, settings] = await Promise.all([
      pool.query(`SELECT s.*, t.name AS template_name, t.subject,
                         (SELECT count(*)::int FROM email_messages m WHERE m.step_id = s.id AND m.status = 'sent') AS sent,
                         (SELECT count(*)::int FROM email_messages m WHERE m.step_id = s.id AND m.status = 'queued') AS queued
                    FROM email_automation_steps s JOIN email_templates t ON t.id = s.template_id
                   WHERE s.automation_id = $1 AND s.business_id = $2 AND s.removed_at IS NULL ORDER BY s.delay_days, s.id`, [a.id, req.business.id]),
      pool.query('SELECT id, name FROM email_templates WHERE business_id = $1 ORDER BY name', [req.business.id]),
      pool.query(`SELECT m.*, o.reference FROM email_messages m LEFT JOIN orders o ON o.id = m.order_id
                   WHERE m.automation_id = $1 AND m.business_id = $2 ORDER BY coalesce(m.sent_at, m.scheduled_for) DESC LIMIT 50`, [a.id, req.business.id]),
      getSettings(req.business.id),
    ]);
    res.set('Cache-Control', 'no-store');
    res.status(status).render('email-automation', { active: 'email', a, steps, templates, history, error, notice, ANCHORS, ready: ready(settings) });
  }

  router.get('/automations/:automationId', asyncHandler(async (req, res) => {
    const a = await loadAutomation(req);
    if (!a) return res.status(404).render('error', { message: 'Automation not found.' });
    const notice = { created: 'Automation created as a draft with starter messages. Edit the messages, then Activate.', saved: 'Saved.', status: 'Status changed.' }[req.query.done] ?? null;
    await renderAutomation(req, res, a, { notice, error: req.query.error ?? null });
  }));

  router.post('/automations/:automationId', asyncHandler(async (req, res) => {
    const a = await loadAutomation(req);
    if (!a) return res.status(404).render('error', { message: 'Automation not found.' });
    const name = String(req.body.name ?? '').trim().slice(0, 120);
    const anchor = a.kind === 'processing' ? 'processing_since' : (['order_date', 'delivered_date'].includes(req.body.anchor) ? req.body.anchor : a.anchor);
    if (!name) return renderAutomation(req, res, a, { error: 'Give the automation a name.', status: 400 });
    await pool.query('UPDATE email_automations SET name = $3, anchor = $4, updated_at = now() WHERE id = $1 AND business_id = $2', [a.id, req.business.id, name, anchor]);
    res.redirect(`${res.locals.base}/email/automations/${a.id}?done=saved`);
  }));

  function readStep(body, kind) {
    const delay = Number(body.delay_days);
    const hour = Number(body.send_hour ?? 10);
    const purpose = kind === 'processing' ? 'operational' : (body.purpose === 'marketing' ? 'marketing' : 'operational');
    const errors = [];
    if (!Number.isInteger(delay) || delay < 0 || delay > 365) errors.push('Days must be a whole number from 0 to 365.');
    if (!Number.isInteger(hour) || hour < 0 || hour > 23) errors.push('Send hour must be 0–23.');
    return { delay, hour, purpose, templateId: id(body.template_id), errors };
  }

  router.post('/automations/:automationId/steps', asyncHandler(async (req, res) => {
    const a = await loadAutomation(req);
    if (!a) return res.status(404).render('error', { message: 'Automation not found.' });
    if (a.status === 'stopped') return renderAutomation(req, res, a, { error: 'This automation is stopped. Duplicate it to make a new one.', status: 400 });
    const s = readStep(req.body, a.kind);
    if (!s.templateId) s.errors.push('Choose a message template.');
    if (s.errors.length) return renderAutomation(req, res, a, { error: s.errors.join(' '), status: 400 });
    try {
      await pool.query('INSERT INTO email_automation_steps (business_id, automation_id, template_id, delay_days, send_hour, purpose) VALUES ($1, $2, $3, $4, $5, $6)',
        [req.business.id, a.id, s.templateId, s.delay, s.hour, s.purpose]);
    } catch (err) {
      if (err.code === '23503') return renderAutomation(req, res, a, { error: 'Choose one of this business\'s templates.', status: 400 });
      throw err;
    }
    await audit(pool, req, { action: 'email.step_added', businessId: req.business.id, entityId: a.id, details: { delay: s.delay, purpose: s.purpose } });
    res.redirect(`${res.locals.base}/email/automations/${a.id}?done=saved`);
  }));

  router.post('/automations/:automationId/steps/:stepId', asyncHandler(async (req, res) => {
    const a = await loadAutomation(req);
    if (!a || !id(req.params.stepId)) return res.status(404).render('error', { message: 'Automation not found.' });
    if (req.body.remove === '1') {
      await pool.query('UPDATE email_automation_steps SET removed_at = now() WHERE id = $1 AND automation_id = $2 AND business_id = $3', [req.params.stepId, a.id, req.business.id]);
      await cancelIneligible(pool);
      await audit(pool, req, { action: 'email.step_removed', businessId: req.business.id, entityId: a.id });
      return res.redirect(`${res.locals.base}/email/automations/${a.id}?done=saved`);
    }
    const s = readStep(req.body, a.kind);
    if (s.errors.length) return renderAutomation(req, res, a, { error: s.errors.join(' '), status: 400 });
    try {
      await pool.query(
        `UPDATE email_automation_steps SET delay_days = $4, send_hour = $5, purpose = $6, template_id = coalesce($7, template_id)
          WHERE id = $1 AND automation_id = $2 AND business_id = $3 AND removed_at IS NULL`,
        [req.params.stepId, a.id, req.business.id, s.delay, s.hour, s.purpose, s.templateId]);
    } catch (err) {
      if (err.code === '23503') return renderAutomation(req, res, a, { error: 'Choose one of this business\'s templates.', status: 400 });
      throw err;
    }
    // Emails already queued keep their time; new ones use the new timing.
    res.redirect(`${res.locals.base}/email/automations/${a.id}?done=saved`);
  }));

  router.post('/automations/:automationId/status', asyncHandler(async (req, res) => {
    const a = await loadAutomation(req);
    if (!a) return res.status(404).render('error', { message: 'Automation not found.' });
    const action = req.body.action;
    const settings = await getSettings(req.business.id);
    const { rows: [{ n: stepCount }] } = await pool.query('SELECT count(*)::int AS n FROM email_automation_steps WHERE automation_id = $1 AND removed_at IS NULL', [a.id]);
    const next = { activate: 'active', pause: 'paused', resume: 'active', stop: 'stopped' }[action];
    if (!next || a.status === 'stopped') return renderAutomation(req, res, a, { error: 'This change is not possible. A stopped automation can be duplicated.', status: 400 });
    if (next === 'active' && !ready(settings)) return renderAutomation(req, res, a, { error: 'Set up email sending first (Email Automations → Sending setup).', status: 400 });
    if (next === 'active' && !stepCount) return renderAutomation(req, res, a, { error: 'Add at least one message step first.', status: 400 });
    // Activation time is kept from the first activation: orders before it never get emails.
    await pool.query(
      `UPDATE email_automations SET status = $3, activated_at = CASE WHEN $3 = 'active' THEN coalesce(activated_at, now()) ELSE activated_at END, updated_at = now()
        WHERE id = $1 AND business_id = $2`, [a.id, req.business.id, next]);
    if (next === 'stopped') await cancelIneligible(pool);
    await audit(pool, req, { action: `email.automation_${action}`, businessId: req.business.id, entityId: a.id });
    res.redirect(`${res.locals.base}/email/automations/${a.id}?done=status`);
  }));

  router.post('/automations/:automationId/duplicate', asyncHandler(async (req, res) => {
    const a = await loadAutomation(req);
    if (!a) return res.status(404).render('error', { message: 'Automation not found.' });
    const { rows: [copy] } = await pool.query(
      'INSERT INTO email_automations (business_id, name, kind, anchor) VALUES ($1, $2, $3, $4) RETURNING id', [req.business.id, `${a.name} (copy)`.slice(0, 120), a.kind, a.anchor]);
    await pool.query(
      `INSERT INTO email_automation_steps (business_id, automation_id, template_id, delay_days, send_hour, purpose)
       SELECT business_id, $2, template_id, delay_days, send_hour, purpose FROM email_automation_steps WHERE automation_id = $1 AND removed_at IS NULL ORDER BY id`, [a.id, copy.id]);
    await audit(pool, req, { action: 'email.automation_duplicated', businessId: req.business.id, entityId: copy.id, details: { from: a.id } });
    res.redirect(`${res.locals.base}/email/automations/${copy.id}?done=saved`);
  }));

  // ---------- History: retry failed sends (never duplicates: only failed, unconfirmed ones)
  router.post('/messages/retry', asyncHandler(async (req, res) => {
    const n = await retryMessages(pool, req.business.id, { messageId: id(req.body.message_id), includeUnknown: req.body.confirm_unknown === 'on' });
    await audit(pool, req, { action: 'email.retry', businessId: req.business.id, details: { messages: n } });
    res.redirect(`${res.locals.base}/email?tab=history&done=retry`);
  }));

  return router;
}

// ---------- Email Contacts
export function emailContactRoutes({ pool }) {
  const router = Router({ mergeParams: true });

  router.get('/', asyncHandler(async (req, res) => {
    const q = String(req.query.q ?? '').trim().slice(0, 100);
    const filter = ['consent', 'no_consent', 'unsubscribed', 'suppressed'].includes(req.query.filter) ? req.query.filter : '';
    const params = [req.business.id];
    const where = ['business_id = $1'];
    if (q) { params.push(`%${q.replace(/[\\%_]/g, '\\$&')}%`); where.push(`(email ILIKE $${params.length} OR name ILIKE $${params.length})`); }
    if (filter === 'consent') where.push('marketing_consent AND unsubscribed_at IS NULL AND suppressed_at IS NULL');
    if (filter === 'no_consent') where.push('NOT marketing_consent AND unsubscribed_at IS NULL');
    if (filter === 'unsubscribed') where.push('unsubscribed_at IS NOT NULL');
    if (filter === 'suppressed') where.push('suppressed_at IS NOT NULL');
    const [{ rows: contacts }, { rows: [stats] }] = await Promise.all([
      pool.query(`SELECT * FROM email_contacts WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT 200`, params),
      pool.query(`SELECT count(*)::int AS total, count(*) FILTER (WHERE marketing_consent AND unsubscribed_at IS NULL AND suppressed_at IS NULL)::int AS consent,
                         count(*) FILTER (WHERE unsubscribed_at IS NOT NULL)::int AS unsubscribed, count(*) FILTER (WHERE suppressed_at IS NOT NULL)::int AS suppressed
                    FROM email_contacts WHERE business_id = $1`, [req.business.id]),
    ]);
    res.set('Cache-Control', 'no-store');
    res.render('email-contacts', { active: 'contacts', contacts, stats, q, filter, error: req.query.error ?? null, notice: req.query.done ? 'Saved.' : null });
  }));

  router.post('/', asyncHandler(async (req, res) => {
    const email = String(req.body.email ?? '').trim().toLowerCase();
    const name = String(req.body.name ?? '').trim().slice(0, 120) || null;
    const consent = req.body.marketing_consent === 'on';
    const consentSource = String(req.body.consent_source ?? '').trim().slice(0, 200);
    if (!EMAIL_RE.test(email) || email.length > 200) return res.redirect(`${res.locals.base}/email-contacts?error=${encodeURIComponent('Enter a valid email address.')}`);
    if (consent && !consentSource) return res.redirect(`${res.locals.base}/email-contacts?error=${encodeURIComponent('Say how this person agreed to marketing emails (e.g. "signed up in shop, 12 Oct").')}`);
    const { rowCount } = await pool.query(
      `INSERT INTO email_contacts (business_id, email, name, source, marketing_consent, consent_at, consent_source)
       VALUES ($1, $2, $3, 'manual', $4, CASE WHEN $4 THEN now() END, $5) ON CONFLICT (business_id, email) DO NOTHING`,
      [req.business.id, email, name, consent, consent ? consentSource : null]);
    if (!rowCount) return res.redirect(`${res.locals.base}/email-contacts?error=${encodeURIComponent('That email is already a contact.')}`);
    await audit(pool, req, { action: 'contact.added', businessId: req.business.id, details: { consent } });
    res.redirect(`${res.locals.base}/email-contacts?done=1`);
  }));

  router.post('/:contactId', asyncHandler(async (req, res) => {
    if (!id(req.params.contactId)) return res.status(404).render('error', { message: 'Contact not found.' });
    const action = req.body.action;
    const note = String(req.body.consent_source ?? '').trim().slice(0, 200);
    const sql = {
      consent: [`marketing_consent = true, consent_at = now(), consent_source = $3, unsubscribed_at = NULL`, true],
      withdraw: ['marketing_consent = false', false],
      unsubscribe: ['unsubscribed_at = coalesce(unsubscribed_at, now()), marketing_consent = false', false],
      suppress: ["suppressed_at = coalesce(suppressed_at, now()), suppressed_reason = coalesce(nullif($3, ''), 'Blocked by the business')", true],
      unsuppress: ['suppressed_at = NULL, suppressed_reason = NULL', false],
    }[action];
    if (!sql) return res.redirect(`${res.locals.base}/email-contacts`);
    if (action === 'consent' && !note) return res.redirect(`${res.locals.base}/email-contacts?error=${encodeURIComponent('Record how the person gave consent (e.g. "asked by WhatsApp, 12 Oct").')}`);
    const { rowCount } = await pool.query(`UPDATE email_contacts SET ${sql[0]}, updated_at = now() WHERE id = $1 AND business_id = $2`,
      sql[1] ? [req.params.contactId, req.business.id, note] : [req.params.contactId, req.business.id]);
    if (!rowCount) return res.status(404).render('error', { message: 'Contact not found.' });
    await audit(pool, req, { action: `contact.${action}`, businessId: req.business.id, entityId: req.params.contactId });
    res.redirect(`${res.locals.base}/email-contacts?done=1`);
  }));

  router.get('/export.csv', asyncHandler(async (req, res) => {
    const { rows } = await pool.query('SELECT * FROM email_contacts WHERE business_id = $1 ORDER BY created_at', [req.business.id]);
    await audit(pool, req, { action: 'contacts.exported', businessId: req.business.id, details: { rows: rows.length } });
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', 'attachment; filename="email-contacts.csv"');
    res.set('Cache-Control', 'no-store');
    res.send(`﻿${toCsv(['Email', 'Name', 'Phone', 'Source', 'Marketing consent', 'Consent recorded', 'Consent source', 'Unsubscribed', 'Suppressed', 'Added'],
      rows.map((c) => [c.email, c.name, c.phone, c.source, c.marketing_consent ? 'yes' : 'no', c.consent_at?.toISOString(), c.consent_source,
        c.unsubscribed_at?.toISOString(), c.suppressed_at ? `${c.suppressed_at.toISOString()} ${c.suppressed_reason ?? ''}` : '', c.created_at.toISOString()]))}`);
  }));

  return router;
}
