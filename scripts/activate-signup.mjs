// Activates public registration on Skyfly's own services only (never AIVORA / VYORA):
//   1. Cloudflare Turnstile: finds or creates the "Skyfly signup" widget for getskyfly.com.
//   2. Resend: finds or adds the sending domain getskyfly.com, writes its DNS records into the
//      getskyfly.com zone on Cloudflare (only records that are missing; nothing is deleted or changed),
//      and asks Resend to verify it.
//   3. Render: sets the six settings on the "skyfly" service and redeploys it. The email settings are
//      set only once Resend reports the domain as verified (an unverified sender would fail anyway).
// Skyfly then runs its own launch checks (a real test send, Cloudflare's check of the Turnstile secret)
// and opens registration only when both pass. Nothing here weakens email verification or the bot check.
// Dry run unless APPLY=1. Prints no key or secret.
//   CLOUDFLARE_API_TOKEN=… RESEND_API_KEY=… RENDER_API_KEY=… APPLY=1 node scripts/activate-signup.mjs
const DOMAIN = 'getskyfly.com';
const WIDGET = 'Skyfly signup';
const FROM = `no-reply@${DOMAIN}`;
const APPLY = process.env.APPLY === '1';
const { CLOUDFLARE_API_TOKEN: CF, RESEND_API_KEY: RS, RENDER_API_KEY: RN } = process.env;
const mask = (v) => { if (v && process.env.GITHUB_ACTIONS) console.log(`::add-mask::${v}`); };
[CF, RS, RN].forEach(mask);

const missing = [['CLOUDFLARE_API_TOKEN', CF], ['RESEND_API_KEY', RS], ['RENDER_API_KEY', RN]].filter(([, v]) => !v).map(([k]) => k);
if (missing.length) { console.log(`BLOCKED  Missing repository secret(s): ${missing.join(', ')}. Nothing was changed.`); process.exit(2); }

async function call(base, token, path, { method = 'GET', body } = {}) {
  const res = await fetch(`${base}${path}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  if (!res.ok) throw new Error(`${method} ${base.replace(/^https?:\/\//, '')}${path.split('?')[0]} -> HTTP ${res.status}: ${(json?.errors?.[0]?.message || json?.message || text).toString().slice(0, 200)}`);
  return json;
}
// API addresses (overridable only for the automated test, which runs against a local mock).
const API = process.env.ACTIVATE_TEST_API ? { cf: `${process.env.ACTIVATE_TEST_API}/cf`, rs: `${process.env.ACTIVATE_TEST_API}/rs`, rn: `${process.env.ACTIVATE_TEST_API}/rn` } : { cf: 'https://api.cloudflare.com/client/v4', rs: 'https://api.resend.com', rn: 'https://api.render.com/v1' };
const POLL_MS = process.env.ACTIVATE_TEST_API ? 10 : 15000;
const cf = (p, o) => call(API.cf, CF, p, o).then((j) => j.result);
const rs = (p, o) => call(API.rs, RS, p, o);
const rn = (p, o) => call(API.rn, RN, p, o);
const plan = (text) => console.log(`${APPLY ? 'DO  ' : 'PLAN'}  ${text}`);
const ok = (text) => console.log(`OK    ${text}`);

// ---- Cloudflare: account and zone
const zones = await cf(`/zones?name=${DOMAIN}`);
const zone = zones?.[0];
if (!zone) throw new Error(`The Cloudflare token cannot see the zone ${DOMAIN} (needs Zone: Read and DNS: Edit on it).`);
const accountId = zone.account.id;
ok(`Cloudflare zone ${DOMAIN} (status ${zone.status}) in account "${zone.account.name}"`);

// ---- Turnstile widget
const widgets = await cf(`/accounts/${accountId}/challenges/widgets?per_page=50`);
let widget = widgets.find((w) => w.name === WIDGET);
let siteKey = widget?.sitekey ?? null; let secret = null;
if (widget) {
  ok(`Turnstile widget "${WIDGET}" exists (domains: ${widget.domains.join(', ')})`);
  const detail = await cf(`/accounts/${accountId}/challenges/widgets/${widget.sitekey}`);
  secret = detail.secret ?? null;
  const want = [DOMAIN, 'skyfly-gybf.onrender.com'];
  if (want.some((d) => !widget.domains.includes(d))) {
    plan(`add ${want.filter((d) => !widget.domains.includes(d)).join(', ')} to the widget's domains`);
    if (APPLY) await cf(`/accounts/${accountId}/challenges/widgets/${widget.sitekey}`, { method: 'PUT', body: { name: WIDGET, mode: widget.mode, domains: [...new Set([...widget.domains, ...want])] } });
  }
} else {
  plan(`create Turnstile widget "${WIDGET}" (managed) for ${DOMAIN} and skyfly-gybf.onrender.com`);
  if (APPLY) {
    widget = await cf(`/accounts/${accountId}/challenges/widgets`, { method: 'POST', body: { name: WIDGET, mode: 'managed', domains: [DOMAIN, 'skyfly-gybf.onrender.com'] } });
    siteKey = widget.sitekey; secret = widget.secret;
  }
}
mask(secret);
if (APPLY && (!siteKey || !secret)) throw new Error('Turnstile site key or secret not returned by Cloudflare.');

// ---- Resend domain and DNS
let domain = (await rs('/domains')).data?.find((d) => d.name === DOMAIN);
if (!domain) {
  plan(`add the sending domain ${DOMAIN} to Resend (EU region)`);
  if (APPLY) domain = await rs('/domains', { method: 'POST', body: { name: DOMAIN, region: 'eu-west-1' } });
}
let verified = false;
if (domain) {
  domain = await rs(`/domains/${domain.id}`);
  ok(`Resend domain ${DOMAIN}: status ${domain.status}`);
  const existing = await cf(`/zones/${zone.id}/dns_records?per_page=500`);
  for (const r of domain.records ?? []) {
    const name = !r.name || r.name === '@' || r.name === DOMAIN ? DOMAIN : r.name.endsWith(`.${DOMAIN}`) ? r.name : `${r.name}.${DOMAIN}`;
    const content = String(r.value).replace(/^"|"$/g, '');
    const have = existing.find((e) => e.type === r.type && e.name === name && String(e.content).replace(/^"|"$/g, '').replace(/\.$/, '') === content.replace(/\.$/, ''));
    if (have) { ok(`DNS ${r.type} ${name} already present`); continue; }
    const clash = existing.find((e) => e.type === r.type && e.name === name && r.type !== 'TXT' && r.type !== 'MX');
    if (clash) { console.log(`STOP  DNS ${r.type} ${name} exists with a different value; not changed. Fix it by hand in Cloudflare.`); continue; }
    plan(`add DNS ${r.type} ${name}${r.priority != null ? ` (priority ${r.priority})` : ''} for Resend (${r.record})`);
    if (APPLY) await cf(`/zones/${zone.id}/dns_records`, { method: 'POST', body: { type: r.type, name, content, ttl: 1, proxied: false, ...(r.type === 'MX' ? { priority: Number(r.priority ?? 10) } : {}), comment: 'Resend (Skyfly email)' } });
  }
  verified = domain.status === 'verified';
  if (!verified && APPLY) {
    await rs(`/domains/${domain.id}/verify`, { method: 'POST' });
    for (let i = 0; i < 40 && !verified; i += 1) {
      await new Promise((r) => setTimeout(r, POLL_MS));
      const d = await rs(`/domains/${domain.id}`);
      verified = d.status === 'verified';
      if (i % 4 === 3 || verified) console.log(`      Resend domain status after ${(i + 1) * 15}s: ${d.status}`);
      if (d.status === 'failed') break;
    }
  }
}

// ---- Render: the skyfly service only
let service = null;
for (const o of (await rn('/owners?limit=20')).map((x) => x.owner ?? x)) {
  service ||= (await rn(`/services?ownerId=${encodeURIComponent(o.id)}&name=skyfly&limit=20`)).map((x) => x.service ?? x).find((s) => s.name === 'skyfly');
}
if (!service) throw new Error('Render service "skyfly" not found.');
const current = new Set((await rn(`/services/${service.id}/env-vars?limit=100`)).map((e) => (e.envVar ?? e).key));
const settings = [['TURNSTILE_SITE_KEY', siteKey], ['TURNSTILE_SECRET_KEY', secret]];
if (verified || !APPLY) settings.push(['SKYFLY_NOTIFY_PROVIDER', 'resend'], ['SKYFLY_NOTIFY_API_KEY', RS], ['SKYFLY_NOTIFY_FROM', FROM], ['SKYFLY_NOTIFY_FROM_NAME', 'Skyfly']);
for (const [key, value] of settings) {
  plan(`${current.has(key) ? 'update' : 'set'} ${key} on Render service "skyfly"${key.includes('KEY') || key.includes('SECRET') ? ' (value hidden)' : ` = ${value}`}`);
  if (APPLY) await rn(`/services/${service.id}/env-vars/${key}`, { method: 'PUT', body: { value } });
}
if (APPLY && !verified) console.log(`WAIT  Resend has not verified ${DOMAIN} yet (DNS can take a while). Turnstile is set; run this again later to add the email settings.`);
plan('redeploy the skyfly service so the settings take effect');
if (APPLY) { const d = await rn(`/services/${service.id}/deploys`, { method: 'POST', body: {} }); ok(`Deploy started (${d.id ?? d.deploy?.id ?? 'id not returned'})`); }
console.log(APPLY ? (verified ? 'DONE  All six settings are on Render. Skyfly opens registration once its launch checks pass (a few minutes after the deploy).' : 'PARTIAL  See WAIT above.') : 'Dry run only: nothing was changed. Run with confirm "activate signup" to apply.');
