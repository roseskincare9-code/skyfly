// Live check of Skyfly's public entry points (sign-in, sign-up, Super Admin, password recovery,
// invitations) on the Render address and on the official domain, plus the domain's connection to the
// Render service (registry, DNS, Render custom domains, HTTPS). Read-only, except:
//   --add     adds the official domain (and Render's automatic www redirect) to the skyfly web service
//   --verify  asks Render to re-check the domain's DNS now
//   --switch  makes https://<domain> Skyfly's main address (PUBLIC_BASE_URL) and redeploys, ONLY when Render
//             shows both names verified and https://<domain>/healthz answers as Skyfly. The Render address
//             keeps working (it stays a dashboard address). Undo: delete PUBLIC_BASE_URL in Render.
// Never changes DNS, never changes the app's settings.
//   RENDER_API_KEY=… node scripts/access-check.mjs [--add | --verify]
import { promises as dns } from 'node:dns';
import { rdapLookup } from '../src/services/platformDomains.js';

const DOMAIN = (process.env.PLATFORM_DOMAIN_CHECK || 'getskyfly.com').toLowerCase();
const RENDER_URL = 'https://skyfly-gybf.onrender.com';
const RENDER = 'https://api.render.com/v1';
const mode = process.argv.includes('--add') ? 'add' : process.argv.includes('--verify') ? 'verify' : process.argv.includes('--switch') ? 'switch' : 'status';
const api = async (path, opts = {}) => {
  const res = await fetch(`${RENDER}${path}`, { ...opts, headers: { Authorization: `Bearer ${process.env.RENDER_API_KEY}`, Accept: 'application/json', 'Content-Type': 'application/json', ...(opts.headers || {}) }, signal: AbortSignal.timeout(30000) });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, json, text: text.slice(0, 400) };
};
const line = (k, v) => console.log(`${k.padEnd(40)} ${v}`);
let failures = 0;
const check = (ok, k, v) => { if (!ok) failures += 1; line(`${ok ? 'PASS' : 'FAIL'}  ${k}`, v); };

// ---- entry points
async function get(base, path) {
  const res = await fetch(`${base}${path}`, { redirect: 'manual', signal: AbortSignal.timeout(90000) });
  return { status: res.status, location: res.headers.get('location'), body: res.status === 200 || res.status >= 400 ? await res.text() : '' };
}
async function routes(base) {
  console.log(`\n== Entry points on ${base}`);
  const h = await get(base, '/healthz');
  check(h.status === 200 && /"status":"ok"/.test(h.body), 'GET /healthz', `HTTP ${h.status}`);
  const login = await get(base, '/login');
  check(login.status === 200 && /action="\/login"/.test(login.body) && /name="password"/.test(login.body), 'Business owner login  /login', `HTTP ${login.status}${/href="\/forgot-password"/.test(login.body) ? ', has "Forgot your password?"' : ''}${/href="\/signup"/.test(login.body) ? ', links to sign-up' : ', no sign-up link (sign-up closed)'}`);
  const home = await get(base, '/');
  check(home.status === 302 && /\/login$/.test(home.location || ''), 'Dashboard  / (signed out)', `HTTP ${home.status} → ${home.location}`);
  const biz = await get(base, '/businesses/1');
  check(biz.status === 302 && /\/login$/.test(biz.location || ''), 'A business dashboard  /businesses/1 (signed out)', `HTTP ${biz.status} → ${biz.location}`);
  const signup = await get(base, '/signup');
  line(`INFO  New owner sign-up  /signup`, signup.status === 200 ? 'HTTP 200: open (anyone can create an account and a trial business)' : `HTTP ${signup.status}: closed — ${(signup.body.match(/<p[^>]*>([^<]{5,120})<\/p>/) || [])[1] ?? ''}`);
  const forgot = await get(base, '/forgot-password');
  check(forgot.status === 200 && /action="\/forgot-password"/.test(forgot.body), 'Password recovery  /forgot-password', `HTTP ${forgot.status}`);
  const reset = await get(base, '/reset-password/not-a-real-link-0000000000000000000000000000');
  check(reset.status === 404, 'Reset link (invalid one refused)  /reset-password/<token>', `HTTP ${reset.status}`);
  const invite = await get(base, '/invite/not-a-real-invitation-token-000');
  check(invite.status === 410 && /not valid/.test(invite.body), 'Invitation (invalid one refused)  /invite/<token>', `HTTP ${invite.status}`);
  const adminLogin = await get(base, '/admin/login');
  check(adminLogin.status === 200 && /data-admin-login/.test(adminLogin.body), 'Super Admin sign-in  /admin/login', `HTTP ${adminLogin.status}`);
  const admin = await get(base, '/admin');
  check(admin.status === 302 && /^\/admin\/login\?next=/.test(admin.location || ''), 'Super Admin dashboard  /admin (signed out)', `HTTP ${admin.status} → ${admin.location}`);
}

// ---- the official domain
async function domain() {
  console.log(`\n== Domain ${DOMAIN}`);
  try {
    const r = await rdapLookup(DOMAIN);
    line('registry (RDAP)', r.registered ? `registered with ${r.registrar}; expires ${r.expiresAt}; ${r.statuses.join(', ')}` : 'NOT REGISTERED');
  } catch (err) { line('registry (RDAP)', `check failed: ${err.message}`); }
  for (const host of [DOMAIN, `www.${DOMAIN}`]) {
    const out = [];
    for (const [type, fn] of [['NS', dns.resolveNs], ['A', dns.resolve4], ['AAAA', dns.resolve6], ['CNAME', dns.resolveCname]]) {
      if (type === 'NS' && host !== DOMAIN) continue;
      const v = await fn.call(dns, host).catch((e) => (['ENODATA', 'ENOTFOUND'].includes(e.code) ? [] : [`error ${e.code}`]));
      if (v.length) out.push(`${type} ${v.join(', ')}`);
    }
    line(`DNS ${host}`, out.join('; ') || 'no records');
  }
  const owners = ((await api('/owners?limit=20')).json || []).map((o) => o.owner ?? o);
  let svc = null;
  for (const o of owners) {
    const list = ((await api(`/services?ownerId=${encodeURIComponent(o.id)}&limit=100`)).json || []).map((x) => x.service ?? x);
    svc ||= list.find((x) => x.name === 'skyfly' && x.type === 'web_service');
  }
  if (!svc) { check(false, 'Render service skyfly', 'not found'); return; }
  line('Render service', `${svc.name} (${svc.serviceDetails?.url}) plan ${svc.serviceDetails?.plan}`);
  let cds = (await api(`/services/${svc.id}/custom-domains?limit=20`)).json || [];
  cds = cds.map((x) => x.customDomain ?? x);
  if (mode === 'add' && !cds.some((c) => c.name === DOMAIN)) {
    const r = await api(`/services/${svc.id}/custom-domains`, { method: 'POST', body: JSON.stringify({ name: DOMAIN }) });
    line('ADD custom domain', `HTTP ${r.status} ${r.json ? JSON.stringify(r.json).slice(0, 400) : r.text}`);
    cds = ((await api(`/services/${svc.id}/custom-domains?limit=20`)).json || []).map((x) => x.customDomain ?? x);
  }
  if (mode === 'verify') {
    for (const c of cds) {
      const r = await api(`/services/${svc.id}/custom-domains/${encodeURIComponent(c.id)}/verify`, { method: 'POST' });
      line(`VERIFY ${c.name}`, `HTTP ${r.status} ${r.text}`);
    }
    cds = ((await api(`/services/${svc.id}/custom-domains?limit=20`)).json || []).map((x) => x.customDomain ?? x);
  }
  if (!cds.length) line('Render custom domains', 'none');
  for (const c of cds) line(`Render custom domain ${c.name}`, `${c.verificationStatus}; type ${c.domainType}${c.redirectForName ? `; redirects to ${c.redirectForName}` : ''}; added ${c.createdAt}`);
  for (const host of [DOMAIN, `www.${DOMAIN}`]) {
    try {
      const res = await fetch(`https://${host}/healthz`, { redirect: 'manual', signal: AbortSignal.timeout(20000) });
      line(`HTTPS https://${host}/healthz`, `HTTP ${res.status}${res.headers.get('location') ? ` → ${res.headers.get('location')}` : ''}${res.status === 200 ? ` ${(await res.text()).slice(0, 60)}` : ''}`);
    } catch (err) { line(`HTTPS https://${host}/healthz`, `no secure answer (${String(err.cause?.code || err.cause?.message || err.message).slice(0, 90)})`); }
  }
  if (mode === 'switch') {
    const verified = [DOMAIN, `www.${DOMAIN}`].every((n) => cds.some((c) => c.name === n && c.verificationStatus === 'verified'));
    const healthy = await fetch(`https://${DOMAIN}/healthz`, { signal: AbortSignal.timeout(20000) }).then(async (r) => r.ok && /"status":"ok"/.test(await r.text())).catch(() => false);
    if (!verified || !healthy) { check(false, 'SWITCH main address', `not done: Render verified ${verified}, HTTPS answers as Skyfly ${healthy}`); return true; }
    const env = await api(`/services/${svc.id}/env-vars/PUBLIC_BASE_URL`, { method: 'PUT', body: JSON.stringify({ value: `https://${DOMAIN}` }) });
    check(env.status === 200, 'SWITCH set PUBLIC_BASE_URL', `HTTP ${env.status}`);
    if (env.status === 200) {
      const dep = await api(`/services/${svc.id}/deploys`, { method: 'POST', body: JSON.stringify({}) });
      check([200, 201, 202].includes(dep.status), 'SWITCH redeploy', `HTTP ${dep.status} ${dep.json?.id ?? ''}`);
    }
  }
  return true;
}

await routes(RENDER_URL);
await domain();
// The official domain's entry points, once it answers securely as Skyfly.
const live = await fetch(`https://${DOMAIN}/healthz`, { signal: AbortSignal.timeout(20000) }).then((r) => r.ok).catch(() => false);
if (live) await routes(`https://${DOMAIN}`);
else line(`\nINFO  Entry points on https://${DOMAIN}`, 'not checked: the domain does not answer securely as Skyfly yet');
console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks that could run passed');
process.exit(failures ? 1 : 0);
