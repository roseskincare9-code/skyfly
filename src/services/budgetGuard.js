// Budget safeguards (AI Media Buyer). READ-ONLY towards Meta: this module never pauses, edits or spends.
// It records the daily budget the owner approved for each campaign / ad set, compares it with what Meta
// shows on every check, writes an append-only audit log of every change, raises alerts, and reports
// budget versus actual spend across ALL of the business's connected ad accounts.
//
// About "caps": a Meta daily budget is not a hard daily cap. Meta's pacing may spend up to 75% more than
// the daily budget on a single day while keeping the weekly average within 7x the daily budget. So this
// module alerts on overspend; it does not promise that spend stays under the budget.
import { listConnections, withAccount } from './metaAds.js';

export const META_DAILY_OVERDELIVERY = 0.75;
const minorOf = (v) => (v == null || v === '' ? null : Math.round(Number(v)));
const digits = (v) => /^\d{1,30}$/.test(String(v ?? ''));

async function alert(pool, { businessId, act, kind, severity, level, id, name, message, suggestion, metrics, dedupe }) {
  const { rowCount } = await pool.query(
    `INSERT INTO ad_alerts (business_id, ad_account_id, kind, severity, entity_level, entity_id, entity_name, message, suggestion, metrics, dedupe_key)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) ON CONFLICT (business_id, dedupe_key) DO NOTHING`,
    [businessId, act, kind, severity, level, id, name, message, suggestion, JSON.stringify(metrics ?? {}), dedupe]);
  return rowCount;
}
const logEvent = (db, e) => db.query(
  `INSERT INTO ad_budget_events (business_id, ad_account_id, entity_level, entity_id, entity_name, event, old_budget_minor, new_budget_minor, approved_budget_minor, source, actor, details)
   VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
  [e.businessId, e.act, e.level ?? null, e.id, e.name ?? null, e.event, e.old ?? null, e.next ?? null, e.approved ?? null, e.source, e.actor ?? null, JSON.stringify(e.details ?? {})]);

// The owner approves (records) the daily budget for one campaign or ad set of one of THEIR accounts.
export async function approveBudget(pool, { businessId, userId = null, adAccountId, level, entityId, name = null, dailyBudgetMinor, note = null, source = 'owner' }) {
  const act = String(adAccountId ?? '').replace(/^act_/, '');
  if (!/^\d{5,20}$/.test(act) || !digits(entityId) || !['campaign', 'adset'].includes(level)) throw new Error('Invalid budget approval.');
  const minor = minorOf(dailyBudgetMinor);
  if (!Number.isFinite(minor) || minor <= 0) throw new Error('The approved daily budget must be a positive amount.');
  const { rows: [owned] } = await pool.query('SELECT 1 FROM ad_connections WHERE business_id = $1 AND ad_account_id = $2', [businessId, act]);
  if (!owned) throw new Error('That ad account is not connected to this business.');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [prev] } = await client.query('SELECT approved_daily_budget_minor FROM ad_budget_register WHERE business_id = $1 AND ad_account_id = $2 AND entity_id = $3 FOR UPDATE', [businessId, act, String(entityId)]);
    await client.query(
      `INSERT INTO ad_budget_register (business_id, ad_account_id, entity_level, entity_id, entity_name, approved_daily_budget_minor, approved_by, approved_at, note)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now(), $8)
       ON CONFLICT (business_id, ad_account_id, entity_id) DO UPDATE SET entity_level = EXCLUDED.entity_level, entity_name = COALESCE(EXCLUDED.entity_name, ad_budget_register.entity_name),
         approved_daily_budget_minor = EXCLUDED.approved_daily_budget_minor, approved_by = EXCLUDED.approved_by, approved_at = now(), note = EXCLUDED.note`,
      [businessId, act, level, String(entityId), name, minor, userId, note]);
    await logEvent(client, { businessId, act, level, id: String(entityId), name, event: source === 'skyfly_action' ? 'changed_by_skyfly' : 'approved', old: prev?.approved_daily_budget_minor ?? null, next: minor, approved: minor, source, actor: userId, details: note ? { note } : {} });
    await client.query('COMMIT');
  } catch (err) { await client.query('ROLLBACK').catch(() => {}); throw err; } finally { client.release(); }
  return { approved: minor };
}

// Live objects with a daily budget in one account (campaigns with CBO, ad sets with their own budget).
async function liveBudgets(acc) {
  const fields = 'id,name,effective_status,daily_budget,lifetime_budget';
  const list = async (edge) => {
    const r = await acc.get(`${acc.act}/${edge}`, { fields, limit: '300', filtering: [{ field: 'effective_status', operator: 'IN', value: ['ACTIVE'] }] });
    return r.data ?? [];
  };
  const [campaigns, adsets] = await Promise.all([list('campaigns'), list('adsets')]);
  return [
    ...campaigns.filter((c) => c.daily_budget).map((c) => ({ level: 'campaign', id: String(c.id), name: c.name, budget: Number(c.daily_budget) })),
    ...adsets.filter((s) => s.daily_budget).map((s) => ({ level: 'adset', id: String(s.id), name: s.name, budget: Number(s.daily_budget) })),
  ];
}
// Spend per campaign per day (account currency, converted to minor units), for the last `days` days.
async function dailySpend(acc, days = 2) {
  const r = await acc.get(`${acc.act}/insights`, { level: 'campaign', date_preset: days <= 2 ? 'last_3d' : 'last_7d', time_increment: '1', fields: 'campaign_id,campaign_name,spend', limit: '500' });
  return (r.data ?? []).map((x) => ({ id: String(x.campaign_id), name: x.campaign_name, day: x.date_start, spend: Math.round(Number(x.spend ?? 0) * 100) }));
}

// One check of every connected, verified account of the business: budget drift, overspend, combined exposure.
export async function checkBudgets(pool, config, businessId, { now = new Date() } = {}) {
  const { rows: [m] } = await pool.query('SELECT overspend_pct, combined_daily_limit_minor FROM ad_monitor_settings WHERE business_id = $1', [businessId]);
  const overPct = m?.overspend_pct ?? 25;
  const accounts = (await listConnections(pool, businessId)).filter((a) => a.status === 'verified');
  const day = now.toISOString().slice(0, 10);
  const out = { accounts: 0, objects: 0, alerts: 0, events: 0, nominal_daily_minor: 0, possible_daily_max_minor: 0, spend_by_day: {}, errors: [] };
  for (const a of accounts) {
    let acc; let live; let spend;
    try {
      acc = await withAccount(pool, config, businessId, a.ad_account_id);
      [live, spend] = await Promise.all([liveBudgets(acc), dailySpend(acc)]);
    } catch (err) { out.errors.push({ ad_account_id: a.ad_account_id, error: String(err.message).slice(0, 200) }); continue; }
    out.accounts += 1;
    const act = a.ad_account_id;
    const { rows: reg } = await pool.query('SELECT * FROM ad_budget_register WHERE business_id = $1 AND ad_account_id = $2', [businessId, act]);
    const byId = new Map(reg.map((r) => [r.entity_id, r]));
    for (const o of live) {
      out.objects += 1;
      out.nominal_daily_minor += o.budget;
      const r = byId.get(o.id);
      const metrics = { daily_budget: o.budget / 100, approved: r ? Number(r.approved_daily_budget_minor) / 100 : null };
      if (!r) {
        const { rowCount } = await pool.query(
          `SELECT 1 FROM ad_budget_events WHERE business_id = $1 AND ad_account_id = $2 AND entity_id = $3 AND event = 'unregistered_budget' AND new_budget_minor = $4 LIMIT 1`, [businessId, act, o.id, o.budget]);
        if (!rowCount) { await logEvent(pool, { businessId, act, level: o.level, id: o.id, name: o.name, event: 'unregistered_budget', next: o.budget, source: 'meta_check' }); out.events += 1; }
        out.alerts += await alert(pool, { businessId, act, kind: 'budget_unapproved', severity: 'medium', level: o.level, id: o.id, name: o.name,
          message: `${o.name}: running with a daily budget of ${o.budget / 100} that has no approved budget recorded in Skyfly.`,
          suggestion: 'Record the approved budget (Budget safeguards) so any later change is detected, or pause it in Ads Manager if it should not be running.', metrics, dedupe: `${act}:budget_unapproved:${o.id}:${o.budget}` });
        continue;
      }
      const approved = Number(r.approved_daily_budget_minor);
      const lastSeen = r.last_seen_budget_minor == null ? null : Number(r.last_seen_budget_minor);
      if (o.budget !== approved && lastSeen !== o.budget) {
        await logEvent(pool, { businessId, act, level: o.level, id: o.id, name: o.name, event: 'changed_outside_skyfly', old: lastSeen ?? approved, next: o.budget, approved, source: 'meta_check' });
        out.events += 1;
      } else if (o.budget === approved && lastSeen != null && lastSeen !== approved) {
        await logEvent(pool, { businessId, act, level: o.level, id: o.id, name: o.name, event: 'back_to_approved', old: lastSeen, next: o.budget, approved, source: 'meta_check' });
        out.events += 1;
      }
      if (o.budget !== approved) {
        out.alerts += await alert(pool, { businessId, act, kind: 'budget_changed', severity: 'high', level: o.level, id: o.id, name: o.name,
          message: `${o.name}: daily budget in Meta is ${o.budget / 100}, but the approved budget is ${approved / 100}. Skyfly did not make this change.`,
          suggestion: 'Check the Meta activity log for who changed it. Approve the new amount in Skyfly, or set it back in Ads Manager. Skyfly does not change it on its own.', metrics, dedupe: `${act}:budget_changed:${o.id}:${o.budget}` });
      }
      await pool.query('UPDATE ad_budget_register SET last_seen_budget_minor = $4, last_seen_at = now(), entity_name = $5 WHERE business_id = $1 AND ad_account_id = $2 AND entity_id = $3', [businessId, act, o.id, o.budget, o.name]);
    }
    // Budget versus actual spend per campaign and day (campaign budgets only; ad-set budgets are summed by campaign in Meta).
    const budgetOf = new Map(live.filter((o) => o.level === 'campaign').map((o) => [o.id, o.budget]));
    for (const s of spend) {
      const budget = budgetOf.get(s.id) ?? null;
      const approved = byId.get(s.id) ? Number(byId.get(s.id).approved_daily_budget_minor) : null;
      out.spend_by_day[s.day] = (out.spend_by_day[s.day] ?? 0) + s.spend;
      await pool.query(
        `INSERT INTO ad_spend_daily (business_id, ad_account_id, entity_id, entity_name, day, spend_minor, budget_minor, approved_budget_minor, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
         ON CONFLICT (business_id, ad_account_id, entity_id, day) DO UPDATE SET spend_minor = EXCLUDED.spend_minor, entity_name = EXCLUDED.entity_name,
           budget_minor = COALESCE(EXCLUDED.budget_minor, ad_spend_daily.budget_minor), approved_budget_minor = EXCLUDED.approved_budget_minor, updated_at = now()`,
        [businessId, act, s.id, s.name, s.day, s.spend, budget, approved]);
      const ref = approved ?? budget;
      if (ref && s.spend > ref * (1 + overPct / 100)) {
        out.alerts += await alert(pool, { businessId, act, kind: 'daily_overspend', severity: 'high', level: 'campaign', id: s.id, name: s.name,
          message: `${s.name}: spent ${s.spend / 100} on ${s.day} against a daily budget of ${ref / 100} (${Math.round((s.spend / ref - 1) * 100)}% over).`,
          suggestion: 'Meta can spend up to 75% over the daily budget on one day and balances it across the week. If this repeats, lower the budget or use a campaign spending limit in Ads Manager.',
          metrics: { spend: s.spend / 100, budget: ref / 100, day: s.day }, dedupe: `${act}:daily_overspend:${s.id}:${s.day}` });
      }
    }
  }
  out.possible_daily_max_minor = Math.round(out.nominal_daily_minor * (1 + META_DAILY_OVERDELIVERY));
  const limit = m?.combined_daily_limit_minor ? Number(m.combined_daily_limit_minor) : null;
  if (limit && out.accounts) {
    const anyAct = accounts[0].ad_account_id;
    if (out.nominal_daily_minor > limit) {
      out.alerts += await alert(pool, { businessId, act: anyAct, kind: 'combined_budget_over_limit', severity: 'high', level: 'account', id: null, name: 'All ad accounts',
        message: `Active daily budgets across ${out.accounts} ad account(s) total ${out.nominal_daily_minor / 100}, above your limit of ${limit / 100} (Meta may spend up to ${out.possible_daily_max_minor / 100} on a single day).`,
        suggestion: 'Review which campaigns are active; pause or lower budgets in Ads Manager or approve a Skyfly action.', metrics: { nominal: out.nominal_daily_minor / 100, limit: limit / 100 }, dedupe: `all:combined_budget:${day}` });
    }
    for (const [d, total] of Object.entries(out.spend_by_day)) {
      if (total > limit) {
        out.alerts += await alert(pool, { businessId, act: anyAct, kind: 'combined_spend_over_limit', severity: 'high', level: 'account', id: null, name: 'All ad accounts',
          message: `Actual spend across all connected ad accounts on ${d} was ${total / 100}, above your daily limit of ${limit / 100}.`,
          suggestion: 'See Budget safeguards for the campaigns that spent it.', metrics: { spend: total / 100, limit: limit / 100, day: d }, dedupe: `all:combined_spend:${d}` });
      }
    }
  }
  return out;
}

// Budget vs actual for one day across all accounts of the business (for the dashboard / report).
export async function budgetReport(pool, businessId, day) {
  const { rows } = await pool.query(
    `SELECT ad_account_id, entity_id, entity_name, day, spend_minor, budget_minor, approved_budget_minor FROM ad_spend_daily
     WHERE business_id = $1 AND day = $2 ORDER BY spend_minor DESC`, [businessId, day]);
  const total = rows.reduce((s, r) => s + Number(r.spend_minor), 0);
  return { day, rows, total_spend_minor: total };
}
export async function budgetEvents(pool, businessId, limit = 50) {
  const { rows } = await pool.query('SELECT * FROM ad_budget_events WHERE business_id = $1 ORDER BY id DESC LIMIT $2', [businessId, limit]);
  return rows;
}
