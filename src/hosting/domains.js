import { promises as dns } from 'node:dns';

// Render's documented A record for apex (root) custom domains.
export const RENDER_APEX_IP = '216.24.57.1';

export function normalizeDomain(input) {
  let d = String(input ?? '').trim().toLowerCase();
  d = d.replace(/^https?:\/\//, '').replace(/[/?#].*$/, '').replace(/\.$/, '');
  if (!d) return '';
  if (d.length > 253 || !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(d)) return null;
  return d;
}

// Checks whether the domain's DNS points at this Render service. Render must
// also have the domain added (it issues the HTTPS certificate).
export async function checkDomain(domain, targetHost) {
  try {
    const cnames = await dns.resolveCname(domain).catch(() => []);
    if (cnames.some((c) => c.toLowerCase().replace(/\.$/, '') === targetHost)) return { ok: true, message: `CNAME points to ${targetHost}` };
    const a = await dns.resolve4(domain).catch(() => []);
    if (a.includes(RENDER_APEX_IP)) return { ok: true, message: `A record points to Render (${RENDER_APEX_IP})` };
    if (cnames.length) return { ok: false, message: `CNAME points to ${cnames.join(', ')}, not ${targetHost}` };
    if (a.length) return { ok: false, message: `A record points to ${a.join(', ')}, not ${RENDER_APEX_IP}` };
    return { ok: false, message: 'No DNS record found yet (changes can take up to a few hours).' };
  } catch (err) {
    return { ok: false, message: `DNS lookup failed: ${err.code || err.message}` };
  }
}
