// Copies ONE key from a GitHub Actions secret to the Skyfly Render service, without anyone seeing it:
// the owner saves the key in GitHub (Settings → Secrets and variables → Actions; the value is write-only and
// masked in every log), then runs the "Set a Skyfly server key" workflow. This script:
//   - accepts only a fixed list of names, and only the Skyfly service (srv-db8dgdhsrm7s73e959qg, never AIVORA);
//   - checks the key with its provider first (status code only) and changes nothing if the provider rejects it;
//   - sets that ONE variable (PUT …/env-vars/<NAME>: every other variable and setting stays as it is);
//   - redeploys and waits until the new deploy is live.
// It never prints, writes or returns the value: only its name, length and status codes.
const API = 'https://api.render.com/v1';
const SERVICE_ID = 'srv-db8dgdhsrm7s73e959qg';
const ALLOWED = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'META_APP_ID', 'META_APP_SECRET', 'RESEND_API_KEY', 'CLOUDFLARE_API_TOKEN'];
const NAME = String(process.env.SECRET_NAME ?? '');
const VALUE = String(process.env.SECRET_VALUE ?? '').trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function render(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${API}${path}`, {
    method, headers: { Authorization: `Bearer ${process.env.RENDER_API_KEY}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Render API ${method} ${path.replace(/\/env-vars\/.*/, '/env-vars/…')} → HTTP ${res.status}`);
  return text ? JSON.parse(text) : null;
}

// Provider check, status only. Returns null when the provider has no simple key check.
async function providerCheck(name, value) {
  const get = async (url, headers) => (await fetch(url, { headers, signal: AbortSignal.timeout(20000) })).status;
  if (name === 'OPENAI_API_KEY') return { provider: 'OpenAI', status: await get('https://api.openai.com/v1/models', { Authorization: `Bearer ${value}` }) };
  if (name === 'ANTHROPIC_API_KEY') return { provider: 'Anthropic', status: await get('https://api.anthropic.com/v1/models', { 'x-api-key': value, 'anthropic-version': '2023-06-01' }) };
  if (name === 'RESEND_API_KEY') return { provider: 'Resend', status: await get('https://api.resend.com/domains', { Authorization: `Bearer ${value}` }) };
  if (name === 'CLOUDFLARE_API_TOKEN') return { provider: 'Cloudflare', status: await get('https://api.cloudflare.com/client/v4/user/tokens/verify', { Authorization: `Bearer ${value}` }) };
  return null;
}

if (!process.env.RENDER_API_KEY) throw new Error('RENDER_API_KEY is not set (repository secret)');
if (!ALLOWED.includes(NAME)) throw new Error(`Not an allowed name: ${NAME || '(empty)'}`);
if (!VALUE) {
  console.log(`MISSING: there is no GitHub Actions secret named ${NAME} (Settings → Secrets and variables → Actions → New repository secret; the name must be exactly ${NAME}). Nothing was changed.`);
  process.exit(1);
}
if (/\s/.test(VALUE)) throw new Error(`${NAME} contains spaces or line breaks; save it again without them. Nothing was changed.`);
if (NAME === 'OPENAI_API_KEY' && !/^sk-[A-Za-z0-9_-]{20,}$/.test(VALUE)) throw new Error('OPENAI_API_KEY does not look like an OpenAI key (it starts with "sk-"). Nothing was changed.');
console.log(`Secret ${NAME}: present, ${VALUE.length} characters (value never printed).`);

const check = await providerCheck(NAME, VALUE);
if (check) {
  console.log(`${check.provider} key check: HTTP ${check.status}`);
  if (check.status === 401 || check.status === 403) throw new Error(`${check.provider} rejected the key (HTTP ${check.status}). Nothing was changed on Render.`);
  if (check.status >= 400) console.log(`Note: ${check.provider} answered ${check.status}; the key is set anyway (it was not rejected as invalid).`);
}

const svc = await render(`/services/${SERVICE_ID}`);
if ((svc.name ?? svc.service?.name) !== 'skyfly') throw new Error('The target service is not the Skyfly service. Nothing was changed.');
const before = (await render(`/services/${SERVICE_ID}/env-vars?limit=100`)).map((e) => (e.envVar ?? e).key);
await render(`/services/${SERVICE_ID}/env-vars/${NAME}`, { method: 'PUT', body: { value: VALUE } });
const after = (await render(`/services/${SERVICE_ID}/env-vars?limit=100`)).map((e) => (e.envVar ?? e).key);
const lost = before.filter((k) => !after.includes(k));
console.log(`Render: ${NAME} ${before.includes(NAME) ? 'updated' : 'added'} on the skyfly service; variables before ${before.length}, after ${after.length}${lost.length ? `; MISSING NOW: ${lost.join(', ')}` : '; all others kept'}.`);

const deploy = await render(`/services/${SERVICE_ID}/deploys`, { method: 'POST', body: { clearCache: 'do_not_clear' } });
const id = (deploy.deploy ?? deploy).id;
console.log(`Redeploying (deploy ${id})…`);
let status = '';
for (let i = 0; i < 90 && !['live', 'build_failed', 'update_failed', 'canceled', 'deactivated'].includes(status); i += 1) {
  await sleep(10000);
  const d = await render(`/services/${SERVICE_ID}/deploys/${id}`);
  status = (d.deploy ?? d).status;
}
console.log(`Deploy ${id}: ${status || 'still running after 15 minutes'}`);
if (status !== 'live') process.exit(1);
