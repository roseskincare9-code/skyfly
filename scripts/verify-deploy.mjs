// Temporary branch only: reachability of getskyfly.com from several countries (check-host.net public nodes).
const CH = 'https://check-host.net';
const j = async (p) => (await fetch(`${CH}${p}`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(30000) })).json();
const nodes = (await j('/nodes/hosts')).nodes;
const pick = Object.entries(nodes).filter(([, n]) => ['ng', 'gh', 'za', 'ke', 'eg', 'ma', 'gb', 'de', 'fr', 'nl', 'us', 'in'].includes(String(n.location?.[0]).toLowerCase()));
console.log(`NODES ${pick.map(([k, n]) => `${k}=${n.location.slice(0, 3).join('/')}`).join('; ')}`);
const names = Object.fromEntries(pick.map(([k, n]) => [k, n.location.slice(1, 3).join(', ')]));
for (const [kind, target] of [['http', 'https://getskyfly.com/login'], ['http', 'https://skyfly-gybf.onrender.com/login'], ['tcp', 'getskyfly.com:443']]) {
  const q = new URLSearchParams({ host: target }); pick.forEach(([k]) => q.append('node', k));
  const start = await j(`/check-${kind}?${q}`);
  let res = {};
  for (let i = 0; i < 12; i += 1) { await new Promise((r) => setTimeout(r, 5000)); res = await j(`/check-result/${start.request_id}`); if (Object.values(res).every((v) => v !== null)) break; }
  for (const [k, v] of Object.entries(res)) {
    const r = Array.isArray(v) ? v[0] : v;
    const txt = r == null ? 'no answer yet' : kind === 'http' ? (Array.isArray(r) ? `ok=${r[0]} ${r[1]}s ${r[2]} ${r[3] ?? ''}` : JSON.stringify(r)) : (r.error ? `ERROR ${r.error}` : `connected ${r.time}s to ${r.address}`);
    console.log(`REACH ${kind} ${target} from ${names[k] ?? k}: ${String(txt).slice(0, 160)}`);
  }
}
