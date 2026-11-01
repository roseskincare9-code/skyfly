// Prints the latest "Sheet evidence" report from the Skyfly service's own logs (Render API, read-only).
// The app writes the report at start-up (src/services/sheetEvidence.js): waiting orders compared with
// every row of the business's Google spreadsheet by Skyfly ID, phone, time and name; customer details
// masked (first initial, last 4 phone digits). This script only reads logs.
//
//   RENDER_API_KEY=… node scripts/sheet-evidence.mjs
const RENDER = 'https://api.render.com/v1';
async function render(path) {
  const res = await fetch(`${RENDER}${path}`, { headers: { Authorization: `Bearer ${process.env.RENDER_API_KEY}`, Accept: 'application/json' } });
  if (res.status !== 200) throw new Error(`Render API ${path.split('?')[0]} -> HTTP ${res.status}`);
  return res.json();
}
if (!process.env.RENDER_API_KEY) throw new Error('Set RENDER_API_KEY');
let svc = null;
for (const o of (await render('/owners?limit=20')).map((x) => x.owner ?? x)) {
  const services = (await render(`/services?ownerId=${encodeURIComponent(o.id)}&limit=100`)).map((x) => x.service ?? x);
  svc ||= services.find((x) => x.name === 'skyfly');
}
if (!svc) throw new Error('skyfly service not found');
const hours = Number(process.env.HOURS || 12);
const start = new Date(Date.now() - hours * 3600000).toISOString();
const logs = [];
for (let page = 0, end = ''; page < 20; page += 1) {
  const r = await render(`/logs?ownerId=${encodeURIComponent(svc.ownerId)}&resource=${svc.id}&type=app&text=${encodeURIComponent('Sheet evidence')}&limit=100&direction=backward&startTime=${start}${end}`);
  logs.push(...(r.logs || []));
  if (!r.hasMore || !r.nextEndTime) break;
  end = `&endTime=${encodeURIComponent(r.nextEndTime)}`;
}
const lines = logs.map((l) => ({ at: l.timestamp, m: String(l.message || '') })).filter((l) => l.m.includes('Sheet evidence')).sort((a, b) => a.at.localeCompare(b.at));
const lastHeader = lines.map((l) => / tabs \(/.test(l.m)).lastIndexOf(true);
const run = lastHeader >= 0 ? lines.slice(lastHeader) : lines;
console.log(`${lines.length} evidence lines in the last ${hours} h; latest report (${run.length} lines) from ${run[0]?.at ?? '—'}:\n`);
for (const l of run) console.log(l.m.replace(/^.*?Sheet evidence \(read-only\) /, ''));
if (!run.length) console.log('No report yet: it is written at start-up for each Google connection whose waiting orders are held.');
