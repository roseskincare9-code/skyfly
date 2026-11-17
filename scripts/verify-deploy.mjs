// Temporary branch only: names-only view of the skyfly service's environment, and what the RUNNING app
// itself reported at start-up about the registration keys. No values are printed.
const api = async (p) => { const r = await fetch(`https://api.render.com/v1${p}`, { headers: { Authorization: `Bearer ${process.env.RENDER_API_KEY}`, Accept: 'application/json' } }); if (!r.ok) throw new Error(`${p.split('?')[0]} HTTP ${r.status}`); return r.json(); };
let svc = null; let owner = null;
for (const o of (await api('/owners?limit=20')).map((x) => x.owner ?? x)) { const f = (await api(`/services?ownerId=${o.id}&limit=100`)).map((x) => x.service ?? x).find((s) => s.name === 'skyfly'); if (f && !svc) { svc = f; owner = o; } }
console.log(`SERVICE skyfly id ${svc.id} in workspace "${owner.name}"; URL ${svc.serviceDetails?.url}; custom domains: ${(await api(`/services/${svc.id}/custom-domains?limit=20`).catch(() => [])).map((d) => (d.customDomain ?? d).name).join(', ')}`);
const vars = (await api(`/services/${svc.id}/env-vars?limit=100`)).map((e) => e.envVar ?? e);
console.log(`ENV ${vars.length} variables readable by this Render API key (names, value length only): ${vars.map((v) => `${v.key}(${String(v.value ?? '').length})`).sort().join(', ')}`);
const near = vars.filter((v) => /resend|cloudflare|paystack|turnstile|notify|api_?key|token|secret/i.test(v.key)).map((v) => JSON.stringify(v.key));
console.log(`ENV names that look like keys (exact spelling in quotes): ${near.join(', ') || 'none'}`);
for (const g of (await api(`/env-groups?ownerId=${owner.id}&limit=50`).catch(() => [])).map((x) => x.envGroup ?? x)) {
  const full = await api(`/env-groups/${g.id}`).catch(() => ({}));
  console.log(`GROUP "${g.name}" linked to [${(full.serviceLinks ?? []).map((l) => l.name ?? l.id).join(', ')}]: ${(full.envVars ?? []).map((e) => e.key).join(', ')}`);
}
const lines = [];
for (let page = 0, end = ''; page < 6; page += 1) { const r = await api(`/logs?ownerId=${owner.id}&resource=${svc.id}&limit=100&direction=backward${end}`); lines.push(...(r.logs || [])); if (!r.hasMore || !r.nextEndTime) break; end = `&endTime=${encodeURIComponent(r.nextEndTime)}`; }
for (const l of lines.filter((x) => /Self-activation|Public registration|Skyfly listening|ScaleForge Business Hub/.test(x.message || '')).slice(0, 6)) console.log(`APP ${l.timestamp.slice(0, 19)} ${String(l.message).slice(0, 260)}`);
