// Backup workflow helper: reads SKYFLY_BACKUP_KEY from the Skyfly service's settings on Render (with the
// RENDER_API_KEY secret), masks it in the GitHub log and hands it to the next steps. Prints no value.
import { appendFileSync } from 'node:fs';

const RENDER = 'https://api.render.com/v1';
const api = async (path) => {
  const res = await fetch(`${RENDER}${path}`, { headers: { Authorization: `Bearer ${process.env.RENDER_API_KEY}`, Accept: 'application/json' }, signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`Render API ${path.split('?')[0]}: HTTP ${res.status}`);
  return res.json();
};
if (!process.env.RENDER_API_KEY) { console.log('No RENDER_API_KEY secret: cannot read the backup key.'); process.exit(0); }
let service = null;
for (const o of (await api('/owners?limit=20')).map((x) => x.owner ?? x)) {
  service ||= (await api(`/services?ownerId=${encodeURIComponent(o.id)}&name=skyfly&limit=20`)).map((x) => x.service ?? x).find((s) => s.name === 'skyfly');
}
if (!service) { console.log('Skyfly service not found on Render.'); process.exit(0); }
const key = (await api(`/services/${service.id}/env-vars?limit=100`)).map((e) => e.envVar ?? e).find((e) => e.key === 'SKYFLY_BACKUP_KEY')?.value?.trim();
if (!key) { console.log('SKYFLY_BACKUP_KEY is not set on Render.'); process.exit(0); }
console.log(`::add-mask::${key}`);
if (key.length < 32) { console.log(`SKYFLY_BACKUP_KEY on Render is too short (${key.length} characters; at least 32 needed). Skyfly ignores it.`); process.exit(0); }
appendFileSync(process.env.GITHUB_ENV, `SKYFLY_BACKUP_KEY=${key}\n`);
console.log(`Backup key read from Render (${key.length} characters, not shown).`);
