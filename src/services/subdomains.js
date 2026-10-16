// Business subdomains: <subdomain>.<PLATFORM_DOMAIN> serves that business's published
// landing pages (and only theirs). Nothing is live until PLATFORM_DOMAIN is set and DNS
// for the domain points at Skyfly; the dashboard says which step is missing.
import { checkDomain } from '../hosting/domains.js';

export const RESERVED_SUBDOMAINS = new Set([
  'app', 'www', 'api', 'admin', 'dashboard', 'pages', 'page', 'mail', 'email', 'smtp', 'imap', 'webmail', 'ftp', 'cdn', 'static', 'assets',
  'help', 'support', 'status', 'billing', 'pay', 'payments', 'docs', 'blog', 'skyfly', 'scaleforge', 'login', 'auth', 'account', 'accounts',
  'secure', 'test', 'staging', 'dev', 'demo', 'ns1', 'ns2', 'mx', 'autodiscover', 'u', 'o',
]);
const SUB_RE = /^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$/;

export function normalizeSubdomain(input, config) {
  const s = String(input ?? '').trim().toLowerCase();
  if (!s) return { value: null };
  if (!SUB_RE.test(s) || s.includes('--')) return { error: 'Use 1–32 lowercase letters, numbers and single hyphens (not at the start or end).' };
  const taken = [config.dashboardHost, config.pagesHost].filter(Boolean)
    .filter((h) => config.platformDomain && h.endsWith(`.${config.platformDomain}`)).map((h) => h.slice(0, -(config.platformDomain.length + 1)));
  if (RESERVED_SUBDOMAINS.has(s) || taken.includes(s)) return { error: `"${s}" is reserved. Choose another name.` };
  return { value: s };
}

export const subdomainHost = (b, config) => (config.platformDomain && b.subdomain ? `${b.subdomain}.${config.platformDomain}` : null);

// Business whose subdomain this host is, or null.
export function subdomainOf(host, config) {
  if (!config.platformDomain) return null;
  const suffix = `.${config.platformDomain}`;
  if (!host.endsWith(suffix)) return null;
  const label = host.slice(0, -suffix.length);
  return SUB_RE.test(label) ? label : null;
}

// What is actually live for a business's subdomain, honestly.
export async function subdomainState(b, config, { check = false } = {}) {
  if (!b.subdomain) return { state: 'none', message: 'No subdomain chosen.' };
  if (!config.platformDomain) return { state: 'waiting_domain', message: 'Reserved, not live: the platform domain is not configured yet (PLATFORM_DOMAIN).' };
  const host = subdomainHost(b, config);
  if (!check) return { state: 'unchecked', host, message: `${host}: DNS not checked yet.` };
  const target = config.renderHost || config.dashboardHost;
  const result = await checkDomain(host, target);
  return { state: result.ok ? 'dns_ok' : 'dns_missing', host, message: result.ok ? `${host}: ${result.message}. HTTPS also needs the domain added in Render.` : `${host}: ${result.message}` };
}
