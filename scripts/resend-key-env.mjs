// For the live signup workflow: masks the value in the Actions log (::add-mask::), then writes
// RESEND_API_KEY to $GITHUB_ENV for the next step, taken from the Skyfly service's own Render setting SKYFLY_NOTIFY_API_KEY.
// Prints nothing usable when the setting is missing.
const RENDER = 'https://api.render.com/v1';
const render = async (path) => {
  const r = await fetch(`${RENDER}${path}`, { headers: { Authorization: `Bearer ${process.env.RENDER_API_KEY}`, Accept: 'application/json' } });
  if (r.status !== 200) throw new Error(`Render API ${path.split('?')[0]} -> HTTP ${r.status}`);
  return r.json();
};
let svc = null;
for (const o of (await render('/owners?limit=20')).map((x) => x.owner ?? x)) {
  svc ||= (await render(`/services?ownerId=${encodeURIComponent(o.id)}&limit=100`)).map((x) => x.service ?? x).find((x) => x.name === 'skyfly');
}
if (!svc) throw new Error('skyfly service not found');
const vars = (await render(`/services/${svc.id}/env-vars?limit=100`)).map((x) => x.envVar ?? x);
const key = vars.find((v) => v.key === 'SKYFLY_NOTIFY_API_KEY')?.value;
if (!key) { console.error('SKYFLY_NOTIFY_API_KEY is not set on the skyfly service'); process.exit(0); }
process.stderr.write('Resend key found on the service (masked).\n');
console.log(`::add-mask::${key}`); // to the step log first, so the value never appears
const { appendFileSync } = await import('node:fs');
if (process.env.GITHUB_ENV) appendFileSync(process.env.GITHUB_ENV, `RESEND_API_KEY=${key}\n`);
