// Temporary (branch only): READ-ONLY scan of the skyfly service's application logs (last 48 h) for errors.
// Prints error lines grouped by message (numbers and references masked), never request bodies or secrets.
const api = async (p) => { const r = await fetch(`https://api.render.com/v1${p}`, { headers: { Authorization: `Bearer ${process.env.RENDER_API_KEY}`, Accept: 'application/json' } }); if (!r.ok) throw new Error(`${p.split('?')[0]} HTTP ${r.status}`); return r.json(); };
const SVC = 'srv-db8dgdhsrm7s73e959qg';
const owner = (await api('/owners?limit=20')).map((x) => x.owner ?? x).find((o) => o.name === 'skyfly');
const lines = [];
for (let page = 0, end = ''; page < 80; page += 1) {
  const r = await api(`/logs?ownerId=${owner.id}&resource=${SVC}&limit=100&direction=backward${end}&startTime=${encodeURIComponent(new Date(Date.now() - 48 * 36e5).toISOString())}`);
  lines.push(...(r.logs || [])); if (!r.hasMore || !r.nextEndTime) break; end = `&endTime=${encodeURIComponent(r.nextEndTime)}`;
  await new Promise((s) => setTimeout(s, 400));
}
console.log(`SCAN ${lines.length} log lines, ${lines.at(-1)?.timestamp ?? '-'} → ${lines[0]?.timestamp ?? '-'}`);
const bad = lines.filter((l) => /error|exception|unhandled|failed|ECONN|timeout|5\d\d /i.test(l.message || '') && !/Sheet evidence|SAME CUSTOMER|NOT_FOUND_IN_SHEET/.test(l.message));
const groups = new Map();
for (const l of bad) {
  const key = String(l.message).replace(/[A-Z]{2}-[A-Z0-9]{7}/g, 'REF').replace(/\d+/g, '#').replace(/\s+/g, ' ').slice(0, 200);
  const g = groups.get(key) ?? { n: 0, last: l.timestamp }; g.n += 1; groups.set(key, g);
}
for (const [k, g] of [...groups].sort((a, b) => b[1].n - a[1].n).slice(0, 40)) console.log(`ERR x${g.n} last ${g.last.slice(0, 16)} ${k}`);
