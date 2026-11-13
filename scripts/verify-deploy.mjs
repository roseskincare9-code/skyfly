// Temporary branch only: where are RESEND_API_KEY / CLOUDFLARE_API_TOKEN / PAYSTACK_SECRET_KEY saved on Render?
// Names only: values are never read into the output.
const NAMES = ['RESEND_API_KEY', 'CLOUDFLARE_API_TOKEN', 'PAYSTACK_SECRET_KEY', 'SKYFLY_NOTIFY_API_KEY', 'TURNSTILE_SECRET_KEY'];
const api = async (p) => { const r = await fetch(`https://api.render.com/v1${p}`, { headers: { Authorization: `Bearer ${process.env.RENDER_API_KEY}`, Accept: 'application/json' } }); if (!r.ok) throw new Error(`${p.split('?')[0]} HTTP ${r.status}`); return r.json(); };
const has = (keys) => NAMES.map((n) => { const k = keys.find((x) => x.trim().toUpperCase() === n); return k ? (k === n ? `${n}: SET` : `${n}: SET but named "${k}" (spacing/case differs)`) : null; }).filter(Boolean);
for (const o of (await api('/owners?limit=20')).map((x) => x.owner ?? x)) {
  console.log(`Workspace "${o.name}"`);
  for (const s of (await api(`/services?ownerId=${o.id}&limit=100`)).map((x) => x.service ?? x)) {
    const keys = (await api(`/services/${s.id}/env-vars?limit=100`).catch(() => [])).map((e) => (e.envVar ?? e).key);
    const near = keys.filter((k) => /RESEND|CLOUDFLARE|PAYSTACK|TURNSTILE|NOTIFY/i.test(k));
    console.log(`  service "${s.name}" (${s.type}, ${s.suspended ?? ''}): ${has(keys).join('; ') || 'none of the three'}${near.length ? ` | related names: ${near.join(', ')}` : ''}`);
  }
  for (const g of (await api(`/env-groups?ownerId=${o.id}&limit=100`).catch(() => [])).map((x) => x.envGroup ?? x)) {
    const full = await api(`/env-groups/${g.id}`).catch(() => ({}));
    const keys = (full.envVars ?? []).map((e) => e.key);
    console.log(`  env group "${g.name}" (linked to ${(full.serviceLinks ?? g.serviceLinks ?? []).map((l) => l.name ?? l.id).join(', ') || 'nothing'}): ${has(keys).join('; ') || 'none of the three'}`);
  }
}
