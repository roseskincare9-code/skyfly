// AI Media Buyer action layer: an AI recommendation becomes ONE specific, prepared change, shown in full, and
// is applied in Meta only after the owner approves exactly that change:
//   retrieve current state → prepare (current vs proposed, reasoning, risks) → approval → re-check the state
//   → execute → read the object back from Meta to verify → log the outcome.
// Supported changes: pause a campaign or ad set, and set the daily budget of a campaign or ad set (at most
// ±50% of the current budget per change). Skyfly never activates, publishes, deletes, changes targeting or
// creates spend on its own; an approval applies only to the one change it shows and cannot be reused.
import { withAccount, MetaError } from './metaAds.js';

export class ActionError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
export const OPERATIONS = { pause: 'Pause', set_daily_budget: 'Change daily budget' };
const LEVELS = ['campaign', 'adset'];
const STATE_FIELDS = 'id,name,account_id,status,effective_status,daily_budget,lifetime_budget';
const toMeta = (err) => (err instanceof MetaError ? new ActionError(err.message, err.status === 404 ? 404 : 409) : err);
const stateOf = (o) => ({ status: o.status ?? null, effective_status: o.effective_status ?? null, daily_budget: o.daily_budget != null ? Number(o.daily_budget) : null, lifetime_budget: o.lifetime_budget != null ? Number(o.lifetime_budget) : null });

// Reads the object and checks Meta says it belongs to this business's ad account.
async function readOwned(acc, objectId) {
  if (!/^\d{1,30}$/.test(String(objectId))) throw new ActionError('Unknown campaign or ad set.', 404);
  const o = await acc.get(String(objectId), { fields: STATE_FIELDS });
  if (String(o.account_id ?? '').replace(/^act_/, '') !== acc.connection.ad_account_id) throw new ActionError('That campaign or ad set is not in this business\'s ad account.', 404);
  return o;
}

export async function prepareAction(pool, config, { businessId, userId, adAccountId, op, level, objectId, proposedBudget = null, reasoning = '', risks = '', expected = '', source = null, link = {} }) {
  if (!OPERATIONS[op]) throw new ActionError('Unknown action.', 404);
  if (!LEVELS.includes(level)) throw new ActionError('Actions can be prepared for a campaign or an ad set only.', 400);
  let acc; let o;
  try { acc = await withAccount(pool, config, businessId, adAccountId); o = await readOwned(acc, objectId); } catch (err) { throw toMeta(err); }
  const current = stateOf(o);
  let proposed;
  if (op === 'pause') {
    if (current.status === 'PAUSED') throw new ActionError(`${o.name} is already paused in Meta. Nothing to prepare.`, 409);
    proposed = { status: 'PAUSED' };
  } else {
    if (!current.daily_budget) throw new ActionError(`${o.name} has no daily budget at the ${level === 'adset' ? 'ad set' : 'campaign'} level (it uses a lifetime budget or a budget set elsewhere). Skyfly only changes daily budgets.`, 409);
    const minor = Math.round(Number(String(proposedBudget ?? '').replace(/,/g, '')) * 100);
    if (!Number.isFinite(minor) || minor <= 0) throw new ActionError('Enter the proposed daily budget.', 400);
    if (minor === current.daily_budget) throw new ActionError('The proposed budget is the same as the current one.', 400);
    if (minor < current.daily_budget * 0.5 || minor > current.daily_budget * 1.5) throw new ActionError(`Change the budget by at most 50% at a time (current ${current.daily_budget / 100}). Large jumps reset Meta's learning and are hard to undo.`, 400);
    proposed = { daily_budget: minor };
  }
  const body = {
    op, level, object_id: String(o.id), object_name: o.name, current, proposed,
    reasoning: String(reasoning).slice(0, 2000), risks: String(risks).slice(0, 1500), expected: String(expected).slice(0, 1000),
    consequences: op === 'pause' ? `${o.name} stops delivering as soon as Meta applies the change; spend on it stops. You can switch it back on in Ads Manager.`
      : `The ${level === 'adset' ? 'ad set' : 'campaign'}'s daily budget changes from ${current.daily_budget / 100} to ${proposed.daily_budget / 100} (${proposed.daily_budget > current.daily_budget ? '+' : ''}${Math.round(((proposed.daily_budget - current.daily_budget) / current.daily_budget) * 100)}%). Daily spend can move by that amount; Meta may re-enter learning.`,
    source, prepared_at: new Date().toISOString(),
    ...(link.analysis_id ? { analysis_id: String(link.analysis_id), rec_index: String(link.rec_index) } : {}),
  };
  const title = `${OPERATIONS[op]}: ${o.name}`.slice(0, 200);
  const { rows: [item] } = await pool.query(
    "INSERT INTO ad_items (business_id, kind, title, body, status, data_basis, created_by, ad_account_id) VALUES ($1, 'action', $2, $3, 'proposed', $4, $5, $6) RETURNING id",
    [businessId, title, JSON.stringify(body), `Read from Meta at ${body.prepared_at}`, userId ?? null, acc.connection.ad_account_id]);
  return item.id;
}

// Applies ONE approved action. Returns the updated item, or null if it was not waiting for approval.
export async function executeAction(pool, config, { businessId, userId, itemId }) {
  // Claim it atomically: a second click, or a second tab, cannot apply it twice.
  const { rows: [item] } = await pool.query(
    "UPDATE ad_items SET status = 'approved', decided_by = $3, decided_at = now() WHERE id = $1 AND business_id = $2 AND kind = 'action' AND status = 'proposed' RETURNING *",
    [itemId, businessId, userId]);
  if (!item) return null;
  const b = item.body;
  const log = (outcome, before, after, error) => pool.query(
    `INSERT INTO ad_action_log (business_id, ad_item_id, ad_account_id, operation, object_level, object_id, before_state, requested, after_state, outcome, error, approved_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [businessId, item.id, item.ad_account_id, b.op, b.level, b.object_id, before ? JSON.stringify(before) : null, JSON.stringify(b.proposed), after ? JSON.stringify(after) : null, outcome, error, userId]);
  const finish = async (status, result) => {
    await pool.query('UPDATE ad_items SET status = $3, meta_result = $4 WHERE id = $1 AND business_id = $2', [item.id, businessId, status, JSON.stringify(result)]);
    return { ...item, status, meta_result: result };
  };
  let acc; let before;
  try {
    acc = await withAccount(pool, config, businessId, item.ad_account_id);
    before = stateOf(await readOwned(acc, b.object_id));
  } catch (err) {
    const e = toMeta(err);
    await log('refused', null, null, e.message);
    return finish('failed', { error: `Nothing was changed: ${e.message}`, verified: false });
  }
  // The approval covers the state that was shown. If Meta's state changed since, nothing is applied.
  if (before.status !== b.current.status || before.daily_budget !== b.current.daily_budget) {
    const msg = 'Nothing was changed: this campaign or ad set changed in Meta after the action was prepared. Prepare it again to review the current settings.';
    await log('refused', before, null, msg);
    return finish('failed', { error: msg, before, verified: false });
  }
  try {
    await acc.update(b.object_id, b.op === 'pause' ? { status: 'PAUSED' } : { daily_budget: String(b.proposed.daily_budget) });
  } catch (err) {
    const msg = `Meta refused the change: ${err.message}${/permission|\(#(10|200|294)\)/i.test(err.message) ? ' (the connected token needs the ads_management permission)' : ''}`;
    await log('failed', before, null, msg);
    return finish('failed', { error: msg, before, verified: false });
  }
  let after = null;
  try { after = stateOf(await readOwned(acc, b.object_id)); } catch { /* verified below as false */ }
  const verified = Boolean(after) && (b.op === 'pause' ? after.status === 'PAUSED' : after.daily_budget === b.proposed.daily_budget);
  await log(verified ? 'executed' : 'failed', before, after, verified ? null : 'Meta accepted the request but reading the object back did not show the change.');
  return finish(verified ? 'executed' : 'failed', { verified, before, after, ...(verified ? {} : { error: 'Meta accepted the request, but reading it back did not show the change. Check it in Ads Manager.' }) });
}

export async function rejectAction(pool, { businessId, userId, itemId }) {
  const { rowCount } = await pool.query("UPDATE ad_items SET status = 'rejected', decided_by = $3, decided_at = now() WHERE id = $1 AND business_id = $2 AND kind = 'action' AND status = 'proposed'", [itemId, businessId, userId]);
  return rowCount > 0;
}
