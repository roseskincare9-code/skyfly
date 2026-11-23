// Batched Meta rollouts: never more than 10 ads pending in Meta, and no new batch until the previous
// one has a final review result for every ad. Also checks the real boom rollout plan file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { MAX_BATCH, validatePlan, status, openNextBatch, record, loadPlan } from '../src/services/rolloutBatches.js';

const mkPlan = (n) => ({ ads: Array.from({ length: n }, (_, i) => ({ name: `BM-PH-AUD${(i % 5) + 1} | A Where To Buy ${i}`, city: 'PH', audience: `AUD${(i % 5) + 1}`, adset_id: `as${i}`, creative_id: 'c1', state: 'planned' })) });

test('batches hold at most 10 ads and the next one waits for every review result', () => {
  const plan = mkPlan(23);
  const b1 = openNextBatch(plan);
  assert.equal(b1.ads.length, MAX_BATCH); assert.equal(b1.batch, 1);
  assert.throws(() => openNextBatch(plan), /Batch 1 is not confirmed/);
  b1.ads.forEach((a, i) => record(plan, a.name, 'submitted', { adId: `9${i}` }));
  b1.ads.slice(0, 9).forEach((a) => record(plan, a.name, 'accepted'));
  record(plan, b1.ads[9].name, 'in_review');
  assert.throws(() => openNextBatch(plan), /not confirmed/);
  assert.equal(status(plan).next_batch_ready, false);
  record(plan, b1.ads[9].name, 'rejected', { reason: 'Policy' });
  assert.equal(status(plan).next_batch_ready, true);
  assert.equal(openNextBatch(plan).batch, 2);
  assert.throws(() => openNextBatch(plan, 11), /1 to 10/);
});

test('records are checked: ad id on submit, reason on rejection, no going back, only open-batch ads', () => {
  const plan = mkPlan(3);
  const [a] = openNextBatch(plan, 2).ads;
  assert.throws(() => record(plan, a.name, 'submitted'), /Meta ad id/);
  record(plan, a.name, 'submitted', { adId: 1 });
  assert.throws(() => record(plan, a.name, 'rejected'), /reason/);
  record(plan, a.name, 'accepted');
  assert.throws(() => record(plan, a.name, 'in_review'), /not in the open batch/);
  assert.throws(() => record(plan, plan.ads[2].name, 'submitted', { adId: 2 }), /not in the open batch/);
});

test('a plan with more than 10 pending ads, two open batches, or a broken name is refused', () => {
  const p = mkPlan(11); p.ads.forEach((a) => { a.state = 'submitted'; a.batch = 1; });
  assert.throws(() => validatePlan(p), /limit is 10/);
  const q = mkPlan(2); q.ads[0].state = 'in_batch'; q.ads[0].batch = 1; q.ads[1].state = 'in_batch'; q.ads[1].batch = 2;
  assert.throws(() => validatePlan(q), /More than one batch/);
  const r = mkPlan(1); r.ads[0].name = 'random name';
  assert.throws(() => validatePlan(r), /naming convention/);
});

test('the boom rollout plan: 30 ads, 19 live, 11 left; batch 1 is 10 A ads with the right ad sets and creatives', () => {
  const file = new URL('../rollouts/2026-11-boom-web-sales.json', import.meta.url);
  const plan = loadPlan(file);
  assert.equal(plan.ads.length, 30);
  const s = status(plan);
  assert.equal(s.accepted, 19); assert.equal(s.remaining, 11); assert.equal(s.next_batch_ready, true);
  const { ads } = openNextBatch(plan);
  assert.equal(ads.length, 10);
  for (const a of ads) {
    assert.match(a.name, /^BM-(PH|IBD|ABJ)-AUD[2-5] \| A Where To Buy$/);
    assert.equal(a.creative_id, plan.creatives[a.city].A.id);
    assert.equal(a.adset_id, plan.ad_set_ids[a.city][Number(a.audience.slice(3)) - 1]);
  }
});

test('the command line refuses a second batch and leaves the plan unchanged', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rollout-'));
  const file = join(dir, 'plan.json');
  writeFileSync(file, JSON.stringify(mkPlan(12)));
  const cli = new URL('../src/scripts/meta-rollout.mjs', import.meta.url).pathname;
  assert.match(execFileSync('node', [cli, file, 'next']).toString(), /Batch 1 released \(10 ads\)/);
  const before = readFileSync(file, 'utf8');
  assert.throws(() => execFileSync('node', [cli, file, 'next'], { stdio: 'pipe' }), /Batch 1 is not confirmed/);
  assert.equal(readFileSync(file, 'utf8'), before);
});
