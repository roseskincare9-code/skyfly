// Gives the automated live tests a fresh sign-in for the restricted live-test account
// (see ensureE2eAccount in src/services/setup.js), without anyone's own password:
//   node scripts/e2e-login.mjs enable   → new random password; its hash is set on the Render service
//                                         (SKYFLY_E2E_PASSWORD_HASH), the service is redeployed and,
//                                         once live, the password is handed to later workflow steps
//                                         as a masked variable (never printed, never stored).
//   node scripts/e2e-login.mjs disable  → clears the hash. The server itself disables each sign-in
//                                         20 minutes after first seeing it (ending its sessions), and
//                                         never accepts the same one again (see ensureE2eAccount).
// Needs RENDER_API_KEY (already a repository secret, used by the other live checks).
import { randomBytes } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { hashPassword } from '../src/lib/passwords.js';
import { E2E_EMAIL } from '../src/services/setup.js';

const API = 'https://api.render.com/v1';
const KEY = 'SKYFLY_E2E_PASSWORD_HASH';
async function render(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${API}${path}`, {
    method, headers: { Authorization: `Bearer ${process.env.RENDER_API_KEY}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Render API ${method} ${path.replace(/\/env-vars\/.*/, '/env-vars/…')} → HTTP ${res.status}`);
  return text ? JSON.parse(text) : null;
}
async function findService() {
  for (const o of (await render('/owners?limit=20')).map((x) => x.owner ?? x)) {
    const svc = (await render(`/services?ownerId=${encodeURIComponent(o.id)}&limit=100`)).map((x) => x.service ?? x)
      .find((x) => x.name === 'skyfly' || x.repo?.endsWith('/skyfly'));
    if (svc) return svc;
  }
  throw new Error('Skyfly service not found');
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!process.env.RENDER_API_KEY) throw new Error('RENDER_API_KEY is not set');
const mode = process.argv[2];
const svc = await findService();
if (mode === 'disable') {
  await render(`/services/${svc.id}/env-vars/${KEY}`, { method: 'PUT', body: { value: 'disabled' } });
  console.log('Live-test sign-in setting cleared. The server disables this run\'s sign-in 20 minutes after it started, and never accepts it again.');
} else if (mode === 'enable') {
  const password = randomBytes(24).toString('base64url');
  console.log(`::add-mask::${password}`);
  await render(`/services/${svc.id}/env-vars/${KEY}`, { method: 'PUT', body: { value: await hashPassword(password) } });
  const deploy = await render(`/services/${svc.id}/deploys`, { method: 'POST', body: { clearCache: 'do_not_clear' } });
  const id = (deploy.deploy ?? deploy).id;
  console.log(`Redeploying so the new setting is used (deploy ${id})…`);
  let status = '';
  for (let i = 0; i < 90 && !['live', 'build_failed', 'update_failed', 'canceled', 'deactivated'].includes(status); i += 1) {
    await sleep(10000);
    const d = await render(`/services/${svc.id}/deploys/${id}`);
    status = (d.deploy ?? d).status;
  }
  if (status !== 'live') throw new Error(`Deploy ended as "${status || 'timeout'}"`);
  await sleep(20000); // start-up tasks (incl. the account setup) finish after the deploy turns live
  if (process.env.GITHUB_ENV) appendFileSync(process.env.GITHUB_ENV, `SKYFLY_OWNER_EMAIL=${E2E_EMAIL}\nSKYFLY_OWNER_PASSWORD=${password}\n`);
  console.log(`Deploy live; the tests sign in as ${E2E_EMAIL} (test businesses only).`);
} else {
  throw new Error('Usage: node scripts/e2e-login.mjs enable|disable');
}
