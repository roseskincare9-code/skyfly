// Temporary (branch only): names-only check of the AI / Meta keys on the skyfly service. No values printed.
const api = async (p) => { const r = await fetch(`https://api.render.com/v1${p}`, { headers: { Authorization: `Bearer ${process.env.RENDER_API_KEY}`, Accept: 'application/json' } }); if (!r.ok) throw new Error(`${p.split('?')[0]} HTTP ${r.status}`); return r.json(); };
const vars = (await api('/services/srv-db8dgdhsrm7s73e959qg/env-vars?limit=100')).map((e) => e.envVar ?? e);
for (const k of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'META_APP_ID', 'META_APP_SECRET', 'RESEND_API_KEY', 'CLOUDFLARE_API_TOKEN']) console.log(`KEY ${k}: ${vars.some((v) => v.key === k && String(v.value ?? '').trim()) ? 'present' : 'ABSENT'}`);
