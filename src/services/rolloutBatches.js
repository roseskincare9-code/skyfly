// Batched Meta ad rollouts: the plan for a rollout (every planned ad with its city, audience, ad set and
// creative) lives in a JSON file in rollouts/, and ads go to Meta Ads Manager at most 10 at a time.
// A new batch is only released when every ad of the previous batch has a final review result
// (accepted or rejected). Nothing here talks to Meta or publishes anything: the plan file is the
// source of truth that whoever creates the ads in Meta (Claude through the Meta Ads connector, or a
// person in Ads Manager) must go through, and every change is checked before it is written.
import { readFileSync, writeFileSync, renameSync } from 'node:fs';

export const MAX_BATCH = 10;
export const STATES = ['planned', 'in_batch', 'submitted', 'in_review', 'accepted', 'rejected', 'live_before_plan'];
const FINAL = new Set(['accepted', 'rejected', 'live_before_plan']);
const PENDING = new Set(['in_batch', 'submitted', 'in_review']);

export function loadPlan(path) { return validatePlan(JSON.parse(readFileSync(path, 'utf8'))); }

export function savePlan(path, plan) {
  validatePlan(plan);
  writeFileSync(`${path}.tmp`, `${JSON.stringify(plan, null, 2)}\n`);
  renameSync(`${path}.tmp`, path);
}

export function validatePlan(plan) {
  if (!plan || !Array.isArray(plan.ads)) throw new Error('Plan has no ads list');
  const names = new Set();
  for (const ad of plan.ads) {
    for (const k of ['name', 'city', 'audience', 'adset_id', 'creative_id', 'state']) if (!ad[k]) throw new Error(`Ad ${ad.name ?? '?'} is missing ${k}`);
    if (!STATES.includes(ad.state)) throw new Error(`Ad ${ad.name} has unknown state ${ad.state}`);
    if (names.has(ad.name)) throw new Error(`Duplicate ad name ${ad.name}`);
    names.add(ad.name);
    if (!new RegExp(`-${ad.city}-${ad.audience} \\| `).test(ad.name)) throw new Error(`Ad ${ad.name} does not follow the naming convention for ${ad.city}/${ad.audience}`);
  }
  const pending = plan.ads.filter((a) => PENDING.has(a.state));
  const batches = new Set(pending.map((a) => a.batch));
  if (batches.size > 1) throw new Error(`More than one batch is open: ${[...batches].join(', ')}`);
  if (pending.length > MAX_BATCH) throw new Error(`${pending.length} ads are pending in Meta; the limit is ${MAX_BATCH}`);
  return plan;
}

export function status(plan) {
  const count = (s) => plan.ads.filter((a) => a.state === s).length;
  const open = plan.ads.filter((a) => PENDING.has(a.state));
  return {
    total: plan.ads.length,
    current_batch: open.length ? open[0].batch : null,
    in_current_batch: open.length,
    submitted: count('submitted') + count('in_review'),
    awaiting_review: count('in_review') + count('submitted'),
    accepted: count('accepted') + count('live_before_plan'),
    rejected: count('rejected'),
    remaining: count('planned'),
    next_batch_ready: open.length === 0 && count('planned') > 0,
  };
}

// Releases the next batch (up to MAX_BATCH planned ads, in plan order). Refuses while any ad of an
// earlier batch has no final review result.
export function openNextBatch(plan, size = MAX_BATCH) {
  if (size < 1 || size > MAX_BATCH) throw new Error(`Batch size must be 1 to ${MAX_BATCH}`);
  const open = plan.ads.filter((a) => PENDING.has(a.state));
  if (open.length) throw new Error(`Batch ${open[0].batch} is not confirmed yet: ${open.map((a) => `${a.name} (${a.state})`).join(', ')}`);
  const next = plan.ads.filter((a) => a.state === 'planned').slice(0, size);
  if (!next.length) throw new Error('Nothing left to roll out');
  const batch = Math.max(0, ...plan.ads.map((a) => a.batch ?? 0)) + 1;
  for (const ad of next) { ad.state = 'in_batch'; ad.batch = batch; }
  plan.log = [...(plan.log ?? []), { at: new Date().toISOString(), event: 'batch_opened', batch, ads: next.map((a) => a.name) }];
  return { batch, ads: next };
}

// Records what happened to one ad of the open batch: submitted (created in Meta, with its ad id),
// in_review, accepted or rejected (with Meta's reason).
export function record(plan, name, state, { adId, reason } = {}) {
  const ad = plan.ads.find((a) => a.name === name);
  if (!ad) throw new Error(`No planned ad called ${name}`);
  if (!PENDING.has(ad.state)) throw new Error(`${name} is not in the open batch (state ${ad.state})`);
  const order = { in_batch: 0, submitted: 1, in_review: 2, accepted: 3, rejected: 3 };
  if (!(state in order) || state === 'in_batch') throw new Error(`Cannot record state ${state}`);
  if (order[state] < order[ad.state]) throw new Error(`${name} is already ${ad.state}`);
  if (state === 'submitted' && !adId) throw new Error('A submitted ad needs its Meta ad id');
  if (state === 'rejected' && !reason) throw new Error("A rejected ad needs Meta's reason");
  ad.state = state;
  if (adId) ad.ad_id = String(adId);
  if (reason) ad.reject_reason = reason;
  plan.log = [...(plan.log ?? []), { at: new Date().toISOString(), event: state, ad: name, ad_id: ad.ad_id ?? null, reason: reason ?? null }];
  return ad;
}

export function isFinal(ad) { return FINAL.has(ad.state); }
