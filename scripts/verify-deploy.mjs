// Temporary branch only: who reaches Skyfly (Render request logs, last 12 h): per hour, client IP prefixes,
// paths and statuses. IPs shortened to their first two parts. No secrets.
const api = async (p) => { const r = await fetch(`https://api.render.com/v1${p}`, { headers: { Authorization: `Bearer ${process.env.RENDER_API_KEY}`, Accept: 'application/json' } }); if (!r.ok) throw new Error(`${p.split('?')[0]} HTTP ${r.status}`); return r.json(); };
let svc = null;
for (const o of (await api('/owners?limit=20')).map((x) => x.owner ?? x)) svc ||= (await api(`/services?ownerId=${o.id}&limit=100`)).map((x) => x.service ?? x).find((s) => s.name === 'skyfly');
const label = (l, n) => (l.labels || []).find((x) => x.name === n)?.value ?? '';
const start = new Date(Date.now() - 12 * 3600e3).toISOString();
const logs = [];
for (let page = 0, end = ''; page < 40; page += 1) {
  const r = await api(`/logs?ownerId=${svc.ownerId}&resource=${svc.id}&type=request&limit=100&direction=backward&startTime=${encodeURIComponent(start)}${end}`);
  logs.push(...(r.logs || []));
  if (!r.hasMore || !r.nextEndTime) break;
  end = `&endTime=${encodeURIComponent(r.nextEndTime)}`;
}
console.log(`LOGS ${logs.length} requests since ${start}; label names seen: ${[...new Set(logs.flatMap((l) => (l.labels || []).map((x) => x.name)))].join(', ')}`);
const ipOf = (l) => label(l, 'clientIP') || label(l, 'clientIp') || label(l, 'ip') || '';
const byHour = {};
for (const l of logs) {
  const h = l.timestamp.slice(0, 13);
  const ip = ipOf(l).split('.').slice(0, 2).join('.') || '?';
  byHour[h] ??= { n: 0, ips: {}, st: {} };
  byHour[h].n += 1; byHour[h].ips[ip] = (byHour[h].ips[ip] || 0) + 1;
  const s = label(l, 'statusCode'); byHour[h].st[s] = (byHour[h].st[s] || 0) + 1;
}
for (const [h, v] of Object.entries(byHour).sort()) console.log(`HOUR ${h}Z ${v.n} req; status ${JSON.stringify(v.st)}; top client prefixes ${Object.entries(v.ips).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, n]) => `${k}.x.x×${n}`).join(' ')}`);
const people = logs.filter((l) => /Mozilla.*(Android|iPhone)/.test(l.message || '') || /Android|iPhone/.test(label(l, 'userAgent')));
console.log(`PHONES ${people.length} phone-browser requests; latest: ${people.slice(0, 10).map((l) => `${l.timestamp.slice(11, 19)} ${label(l, 'method')} ${label(l, 'path')} ${label(l, 'statusCode')} ${ipOf(l).split('.').slice(0, 2).join('.')}.x.x`).join(' | ')}`);
const orders = logs.filter((l) => /\/api\/public\/orders/.test(label(l, 'path')) && label(l, 'method') === 'POST');
console.log(`ORDERS ${orders.length} order submissions: ${orders.slice(0, 10).map((l) => `${l.timestamp.slice(0, 19)} ${label(l, 'statusCode')} ${ipOf(l).split('.').slice(0, 2).join('.')}.x.x`).join(' | ')}`);
console.log(`SAMPLE ${JSON.stringify(logs[0]?.labels ?? []).slice(0, 600)}`);
