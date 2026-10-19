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

// The full readiness of a custom domain, in order: DNS → HTTPS certificate → the published page
// served by Skyfly. A domain is reported live only when all three are proven, never assumed.
export async function domainReadiness(domain, targetHost, { fetchImpl = fetch, dnsCheck = checkDomain } = {}) {
  const dnsResult = await dnsCheck(domain, targetHost);
  const steps = { dns: dnsResult.ok, https: false, live: false };
  if (!dnsResult.ok) return { ...steps, ok: false, message: `Waiting for DNS: ${dnsResult.message}` };
  let res;
  try {
    res = await fetchImpl(`https://${domain}/`, { redirect: 'follow', signal: AbortSignal.timeout(15000) });
  } catch (err) {
    const cause = String(err?.cause?.code || err?.cause?.message || err?.message || '');
    return { ...steps, ok: false, message: `DNS ✓ (${dnsResult.message}). HTTPS not ready: ${/CERT|SSL|TLS|certificate/i.test(cause) ? 'no valid certificate yet' : `no secure answer (${cause.slice(0, 80) || 'timeout'})`}. Add the domain in Render → skyfly → Settings → Custom Domains; Render issues the certificate (usually within minutes).` };
  }
  steps.https = true;
  const body = await res.text().catch(() => '');
  if (!res.ok || !body.includes('/sdk/skyfly.js')) {
    return { ...steps, ok: false, message: `DNS ✓, HTTPS ✓. Not live yet: the domain answered HTTP ${res.status} without this Skyfly page. Make sure the page is published and the domain is saved on this page.` };
  }
  steps.live = true;
  return { ...steps, ok: true, message: `DNS ✓ (${dnsResult.message}), HTTPS ✓, live ✓: the published page is served on https://${domain}/` };
}
