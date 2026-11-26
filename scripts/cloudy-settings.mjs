// Which server settings the AI Media Buyer (Cloudy) depends on are present on the live skyfly service.
// Read-only. Prints only whether each setting exists; never prints a secret's value. Non-secret values
// (model names, the public address, Meta's public app ID, the sign-up mode) are printed as they are.
//   RENDER_API_KEY=… node scripts/cloudy-settings.mjs
const API = 'https://api.render.com/v1';
async function render(p) {
  const res = await fetch(`${API}${p}`, { headers: { Authorization: `Bearer ${process.env.RENDER_API_KEY}`, Accept: 'application/json' }, signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`Render API ${p.replace(/env-vars.*/, 'env-vars')} → HTTP ${res.status}`);
  return res.json();
}
if (!process.env.RENDER_API_KEY) throw new Error('RENDER_API_KEY is not set');
let svc = null;
for (const o of (await render('/owners?limit=20')).map((x) => x.owner ?? x)) {
  svc = (await render(`/services?ownerId=${encodeURIComponent(o.id)}&limit=100`)).map((x) => x.service ?? x).find((x) => x.name === 'skyfly' || x.repo?.endsWith('/skyfly'));
  if (svc) break;
}
if (!svc) throw new Error('Skyfly service not found');
const vars = {};
let cursor = '';
for (let i = 0; i < 10; i += 1) {
  const page = await render(`/services/${svc.id}/env-vars?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
  for (const x of page) vars[(x.envVar ?? x).key] = String((x.envVar ?? x).value ?? '');
  if (page.length < 100) break;
  cursor = page.at(-1).cursor;
}
const SECRET = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'META_APP_SECRET', 'SKYFLY_ENCRYPTION_KEY', 'RESEND_API_KEY', 'CLOUDFLARE_API_TOKEN', 'TURNSTILE_SECRET_KEY'];
const PLAIN = ['META_APP_ID', 'META_LOGIN_CONFIG_ID', 'PUBLIC_BASE_URL', 'CLOUDY_MODEL', 'CLAUDE_ANALYSIS_MODEL', 'OPENAI_MODEL', 'OPENAI_REASONING_EFFORT', 'OPENAI_DAILY_ANALYSES', 'META_GRAPH_BASE', 'ALLOW_SIGNUP'];
console.log(`Service: ${svc.name} (${svc.serviceDetails?.url ?? svc.id})`);
for (const k of SECRET) console.log(`${(vars[k] ? 'SET' : 'MISSING').padEnd(8)} ${k}${vars[k] ? ` (length ${vars[k].length})` : ''}`);
for (const k of PLAIN) console.log(`${(vars[k] ? 'SET' : 'unset').padEnd(8)} ${k}${vars[k] ? ` = ${vars[k]}` : ' (default used)'}`);
