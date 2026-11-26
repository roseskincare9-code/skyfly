// Plan validation against Meta's minimum daily budget per ad set (read from the ad account in the health
// check): a plan below it is stopped BEFORE anything is created in Meta. No database needed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePlan } from '../src/services/builder.js';

const health = { pixels: [{ id: '1', last_fired_time: '2026-11-01' }], pages: [{ id: 'p', name: 'Page' }], account: { status_code: 1, currency: 'NGN', min_daily_budget: 1361 } };
const plan = (daily) => ({ objective: 'OUTCOME_SALES', conversion_event: 'PURCHASE', destination_url: 'https://getskyfly.com/p/shop/', ad_sets: [{
  name: 'Lagos', daily_budget: daily, country: 'NG', cities: [], age_min: 18, age_max: 65, gender: 'all', advantage_audience: true,
  ads: [{ name: 'A', creative_id: '7', primary_text: 'Text', headline: 'Head', description: '', call_to_action: 'SHOP_NOW' }] }] });
const ctx = { images: [{ id: 7 }], profile: {}, pages: [{ slug: 'shop' }], health, publicBaseUrl: 'https://getskyfly.com' };

test('an ad set below Meta\'s minimum daily budget is refused before building', () => {
  const r = validatePlan(plan(1000), ctx);
  assert.ok(r.errors.some((e) => /minimum daily budget for this ad account is 1361 NGN \(the plan has 1000\)/.test(e)), r.errors.join(' | '));
});
test('at or above the minimum the plan is valid', () => {
  assert.deepEqual(validatePlan(plan(1361), ctx).errors, []);
  assert.deepEqual(validatePlan(plan(5000), ctx).errors, []);
});
test('when Meta does not report a minimum, no budget error is invented', () => {
  assert.deepEqual(validatePlan(plan(500), { ...ctx, health: { ...health, account: { status_code: 1 } } }).errors, []);
});
