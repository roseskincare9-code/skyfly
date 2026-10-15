// Creates Skyfly's own Render resources (PostgreSQL "skyfly-db" + web service "skyfly")
// in the Render workspace named "skyfly", via the Render API. Mirrors render.yaml.
//
//   node scripts/provision-render.mjs            -> dry run: shows the plan and cost, creates nothing
//   node scripts/provision-render.mjs --apply    -> creates the resources, waits for the deploy
//
// Safety: only touches the "skyfly" workspace; refuses if any Skyfly resource already
// exists (no duplicates); generated secrets and connection strings are never printed.
import { randomBytes } from 'node:crypto';

const API = 'https://api.render.com/v1';
const KEY = process.env.RENDER_API_KEY;
const APPLY = process.argv.includes('--apply');
const WORKSPACE = 'skyfly';
const REPO = 'https://github.com/roseskincare9-code/skyfly';
const PLAN = {
  db: { name: 'skyfly-db', plan: 'basic_256mb', region: 'frankfurt', version: '16', databaseName: 'skyfly', databaseUser: 'skyfly' },
  web: {
    name: 'skyfly', plan: 'starter', region: 'frankfurt', branch: 'main', runtime: 'node',
    buildCommand: 'npm ci --omit=dev', preDeployCommand: 'npm run migrate', startCommand: 'npm start', healthCheckPath: '/healthz',
  },
};

if (!KEY) { console.error('RENDER_API_KEY is not set'); process.exit(1); }

async function api(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${KEY}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60000),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  if (!res.ok) throw new Error(`${method} ${path} -> HTTP ${res.status}: ${(json?.message || text).slice(0, 400)}`);
  return json;
}
const unwrap = (list, k) => (list || []).map((x) => x[k] ?? x);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const owners = unwrap(await api('GET', '/owners?limit=50'), 'owner');
const owner = owners.find((o) => o.name.toLowerCase() === WORKSPACE);
if (!owner) { console.error(`No Render workspace named "${WORKSPACE}" is visible to this key.`); process.exit(1); }
console.log(`Workspace: "${owner.name}"`);

// No duplicates: refuse if any Skyfly resource already exists in any visible workspace.
for (const o of owners) {
  const q = `ownerId=${encodeURIComponent(o.id)}&limit=100`;
  const svcs = unwrap(await api('GET', `/services?${q}`), 'service').filter((s) => s.name === PLAN.web.name || /\/skyfly$/.test(s.repo || ''));
  const dbs = unwrap(await api('GET', `/postgres?${q}`), 'postgres').filter((d) => d.name === PLAN.db.name);
  if (svcs.length || dbs.length) {
    console.log(`Skyfly resources already exist in "${o.name}": ${[...svcs.map((s) => s.name), ...dbs.map((d) => d.name)].join(', ')}. Nothing created.`);
    process.exit(0);
  }
}

console.log(`
Plan (nothing exists yet):
  1. PostgreSQL  ${PLAN.db.name}   plan Basic-256mb, ${PLAN.db.region}, Postgres ${PLAN.db.version}   ~ $6/month + storage
  2. Web service ${PLAN.web.name}      plan Starter, ${PLAN.web.region}, Node, repo ${REPO} (branch ${PLAN.web.branch})   ~ $7/month
     build: ${PLAN.web.buildCommand} | pre-deploy: ${PLAN.web.preDeployCommand} | start: ${PLAN.web.startCommand} | health: ${PLAN.web.healthCheckPath}
     env: NODE_ENV, NODE_VERSION, DATABASE_URL (internal, from skyfly-db), DATABASE_SSL=false,
          SESSION_SECRET + SKYFLY_ENCRYPTION_KEY (random, generated here, never shown),
          ALLOWED_ORIGINS=https://roseskincare9-code.github.io, ALLOW_SIGNUP=first
  Total ~ $13/month (Render list prices; confirm on render.com/pricing).`);

if (!APPLY) { console.log('\nDRY RUN: nothing was created.'); process.exit(0); }

console.log('\nCreating skyfly-db ...');
const db = await api('POST', '/postgres', { ...PLAN.db, ownerId: owner.id, enableHighAvailability: false });
const dbId = (db.postgres ?? db).id;
let status = '';
for (let i = 0; i < 90 && status !== 'available'; i += 1) {
  await sleep(10000);
  status = (await api('GET', `/postgres/${dbId}`)).status;
  console.log(`  skyfly-db: ${status}`);
}
if (status !== 'available') { console.error('skyfly-db did not become available in time; check again later.'); process.exit(1); }
const conn = await api('GET', `/postgres/${dbId}/connection-info`);
if (!conn.internalConnectionString) { console.error('No internal connection string returned.'); process.exit(1); }

console.log('Creating web service skyfly ...');
const svc = await api('POST', '/services', {
  type: 'web_service', name: PLAN.web.name, ownerId: owner.id, repo: REPO, branch: PLAN.web.branch, autoDeploy: 'yes',
  envVars: [
    { key: 'NODE_ENV', value: 'production' },
    { key: 'NODE_VERSION', value: '22' },
    { key: 'DATABASE_URL', value: conn.internalConnectionString },
    { key: 'DATABASE_SSL', value: 'false' },
    { key: 'SESSION_SECRET', value: randomBytes(48).toString('base64url') },
    { key: 'SKYFLY_ENCRYPTION_KEY', value: randomBytes(32).toString('base64') },
    { key: 'ALLOWED_ORIGINS', value: 'https://roseskincare9-code.github.io' },
    { key: 'ALLOW_SIGNUP', value: 'first' },
  ],
  serviceDetails: {
    runtime: PLAN.web.runtime, plan: PLAN.web.plan, region: PLAN.web.region, healthCheckPath: PLAN.web.healthCheckPath,
    preDeployCommand: PLAN.web.preDeployCommand,
    envSpecificDetails: { buildCommand: PLAN.web.buildCommand, startCommand: PLAN.web.startCommand },
  },
});
const service = svc.service ?? svc;
console.log(`  service created: ${service.serviceDetails?.url || '(URL pending)'}`);

let deploy = null;
for (let i = 0; i < 90; i += 1) {
  await sleep(10000);
  deploy = unwrap(await api('GET', `/services/${service.id}/deploys?limit=1`), 'deploy')[0];
  console.log(`  deploy: ${deploy?.status || 'pending'}`);
  if (['live', 'build_failed', 'update_failed', 'pre_deploy_failed', 'canceled', 'deactivated'].includes(deploy?.status)) break;
}
const fresh = await api('GET', `/services/${service.id}`);
console.log(`\nService URL: ${fresh.serviceDetails?.url}`);
console.log(`Deploy status: ${deploy?.status}`);
process.exit(deploy?.status === 'live' ? 0 : 1);
