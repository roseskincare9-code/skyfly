// Batched Meta ad rollout control (max 10 ads pending in Meta at once).
//   node src/scripts/meta-rollout.mjs <plan.json> status
//   node src/scripts/meta-rollout.mjs <plan.json> next [size]        release the next batch (refused while one is open)
//   node src/scripts/meta-rollout.mjs <plan.json> submitted "<ad name>" <meta ad id>
//   node src/scripts/meta-rollout.mjs <plan.json> in_review "<ad name>"
//   node src/scripts/meta-rollout.mjs <plan.json> accepted "<ad name>"
//   node src/scripts/meta-rollout.mjs <plan.json> rejected "<ad name>" "<Meta's reason>"
// Never talks to Meta and never publishes: it decides what may be created next and records results.
import { loadPlan, savePlan, status, openNextBatch, record } from '../services/rolloutBatches.js';

const [file, cmd, ...args] = process.argv.slice(2);
if (!file || !cmd) { console.error('usage: meta-rollout.mjs <plan.json> status|next|submitted|in_review|accepted|rejected …'); process.exit(2); }
try {
  const plan = loadPlan(file);
  if (cmd === 'status') {
    console.log(JSON.stringify(status(plan), null, 2));
    for (const a of plan.ads.filter((x) => x.batch && x.batch === status(plan).current_batch)) console.log(`  batch ${a.batch}: ${a.name} — ${a.state}${a.ad_id ? ` (${a.ad_id})` : ''}`);
  } else if (cmd === 'next') {
    const { batch, ads } = openNextBatch(plan, args[0] ? Number(args[0]) : undefined);
    savePlan(file, plan);
    console.log(`Batch ${batch} released (${ads.length} ads):`);
    for (const a of ads) console.log(`  ${a.name}  ad set ${a.adset_id}  creative ${a.creative_id}`);
  } else if (['submitted', 'in_review', 'accepted', 'rejected'].includes(cmd)) {
    const [name, extra] = args;
    const ad = record(plan, name, cmd, cmd === 'submitted' ? { adId: extra } : cmd === 'rejected' ? { reason: extra } : {});
    savePlan(file, plan);
    console.log(`${ad.name}: ${ad.state}`);
  } else throw new Error(`Unknown command ${cmd}`);
} catch (err) { console.error(`Refused: ${err.message}`); process.exit(1); }
