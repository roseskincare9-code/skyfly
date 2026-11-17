// Temporary branch only: app log lines of the running deploy (start-up, errors), no secrets.
const api = async (p) => { const r = await fetch(`https://api.render.com/v1${p}`, { headers: { Authorization: `Bearer ${process.env.RENDER_API_KEY}`, Accept: 'application/json' } }); if (!r.ok) throw new Error(`${p.split('?')[0]} HTTP ${r.status}`); return r.json(); };
let svc = null; let owner = null;
for (const o of (await api('/owners?limit=20')).map((x) => x.owner ?? x)) { const f = (await api(`/services?ownerId=${o.id}&limit=100`)).map((x) => x.service ?? x).find((s) => s.name === 'skyfly'); if (f && !svc) { svc = f; owner = o.id; } }
const deploys = (await api(`/services/${svc.id}/deploys?limit=8`)).map((d) => d.deploy ?? d);
for (const d of deploys) console.log(`DEPLOY ${d.status} ${d.commit?.id?.slice(0, 7)} ${d.trigger} created ${d.createdAt} finished ${d.finishedAt}`);
const lines = [];
for (let page = 0, end = ''; page < 10; page += 1) {
  const r = await api(`/logs?ownerId=${owner}&resource=${svc.id}&limit=100&direction=backward${end}`);
  lines.push(...(r.logs || [])); if (!r.hasMore || !r.nextEndTime) break; end = `&endTime=${encodeURIComponent(r.nextEndTime)}`;
}
console.log(`LOGS ${lines.length} lines, ${lines.at(-1)?.timestamp} → ${lines[0]?.timestamp}`);
const re = /listening|Self-activation|Public registration|Launch checks|error|Error|EADDRINUSE|crash|exited|Killed|out of memory|ECONN|unhandled|Live-test account|==> /;
for (const l of lines.filter((x) => re.test(x.message || '')).reverse().slice(-40)) console.log(`LOG ${l.timestamp.slice(0, 19)} ${String(l.message).replace(/\s+/g, ' ').slice(0, 220)}`);
