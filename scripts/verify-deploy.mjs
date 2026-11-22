// Temporary branch only: names-only view of the skyfly service's environment, and what the RUNNING app
// itself reported at start-up about the registration keys. No values are printed.
const api = async (p) => { const r = await fetch(`https://api.render.com/v1${p}`, { headers: { Authorization: `Bearer ${process.env.RENDER_API_KEY}`, Accept: 'application/json' } }); if (!r.ok) throw new Error(`${p.split('?')[0]} HTTP ${r.status}`); return r.json(); };
let svc = null; let owner = null;
for (const o of (await api('/owners?limit=20')).map((x) => x.owner ?? x)) { const f = (await api(`/services?ownerId=${o.id}&limit=100`)).map((x) => x.service ?? x).find((s) => s.name === 'skyfly'); if (f && !svc) { svc = f; owner = o; } }
console.log(`SERVICE skyfly id ${svc.id} in workspace "${owner.name}"; URL ${svc.serviceDetails?.url}; custom domains: ${(await api(`/services/${svc.id}/custom-domains?limit=20`).catch(() => [])).map((d) => (d.customDomain ?? d).name).join(', ')}`);
const vars = (await api(`/services/${svc.id}/env-vars?limit=100`)).map((e) => e.envVar ?? e);
console.log(`ENV ${vars.length} variables readable by this Render API key (names, value length only): ${vars.map((v) => `${v.key}(${String(v.value ?? '').length})`).sort().join(', ')}`);

const REQUIRED = ['ALLOWED_ORIGINS', 'ALLOW_SIGNUP', 'DATABASE_SSL', 'DATABASE_URL', 'NODE_ENV', 'NODE_VERSION', 'PUBLIC_BASE_URL', 'SESSION_SECRET', 'SKYFLY_BACKUP_KEY', 'SKYFLY_E2E_PASSWORD_HASH', 'SKYFLY_ENCRYPTION_KEY', 'SKYFLY_META_TEST_EVENT_CODE', 'RESEND_API_KEY', 'CLOUDFLARE_API_TOKEN', 'PAYSTACK_SECRET_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY'];
const ALT = ['TURNSTILE_SITE_KEY', 'TURNSTILE_SECRET_KEY', 'SKYFLY_NOTIFY_EMAIL', 'SKYFLY_NOTIFY_FROM', 'OPENAI_MODEL', 'ANTHROPIC_MODEL', 'META_APP_ID', 'META_APP_SECRET', 'SKYFLY_META_APP_ID', 'SKYFLY_META_APP_SECRET'];
console.log(`ALTERNATIVES present: ${ALT.filter((k) => vars.some((v) => v.key === k)).join(', ') || 'none'}`);
const have = new Set(vars.map((v) => v.key));
console.log(`MISSING ${REQUIRED.filter((k) => !have.has(k)).join(', ') || 'none'} (of ${REQUIRED.length} expected)`);

// Where else could the keys be? Every workspace this Render key sees: services, their env NAMES, env groups.
for (const o of (await api('/owners?limit=20')).map((x) => x.owner ?? x)) {
  console.log(`OWNER "${o.name}" (${o.type ?? ''})`);
  for (const s of (await api(`/services?ownerId=${o.id}&limit=100`)).map((x) => x.service ?? x)) {
    const names = (await api(`/services/${s.id}/env-vars?limit=100`).catch(() => [])).map((e) => (e.envVar ?? e).key);
    const hit = names.filter((k) => /RESEND|CLOUDFLARE|TURNSTILE|OPENAI|ANTHROPIC|PAYSTACK/i.test(k));
    console.log(`  SERVICE ${s.name} (${s.type}, ${s.id}, updated ${s.updatedAt}) env=${names.length} key-like: ${hit.map((k) => JSON.stringify(k)).join(', ') || 'none'}`);
  }
  for (const g of (await api(`/env-groups?ownerId=${o.id}&limit=50`).catch(() => [])).map((x) => x.envGroup ?? x)) {
    const full = await api(`/env-groups/${g.id}`).catch(() => ({}));
    console.log(`  GROUP "${g.name}" linked to [${(full.serviceLinks ?? []).map((l) => l.name ?? l.id).join(', ')}]: ${(full.envVars ?? []).map((e) => JSON.stringify(e.key)).join(', ')}`);
  }
}
const deps = (await api(`/services/${svc.id}/deploys?limit=12`)).map((d) => d.deploy ?? d);
for (const d of deps) console.log(`DEPLOY ${d.createdAt} ${d.status} trigger=${d.trigger} commit=${d.commit?.id?.slice(0, 7) ?? '-'}`);
const ev = await api(`/services/${svc.id}/events?limit=30`).catch((e) => ({ err: e.message }));
if (ev.err) console.log(`EVENTS ${ev.err}`); else for (const e of ev.map((x) => x.event ?? x)) console.log(`EVENT ${e.timestamp} ${e.type} ${JSON.stringify(e.details ?? {}).slice(0, 160)}`);
console.log(`PREVIEWS service previews setting: ${JSON.stringify(svc.serviceDetails?.previews ?? svc.serviceDetails?.pullRequestPreviewsEnabled ?? null)}; environmentId ${svc.environmentId ?? 'none'}`);
const all = (await api(`/services?ownerId=${owner.id}&limit=100`)).map((x) => x.service ?? x);
console.log(`WORKSPACE "${owner.name}" services: ${all.map((s) => `${s.name} (${s.type}, ${s.id})`).join('; ')}`);
const near = vars.filter((v) => /resend|cloudflare|paystack|turnstile|notify|api_?key|token|secret/i.test(v.key)).map((v) => JSON.stringify(v.key));
console.log(`ENV names that look like keys (exact spelling in quotes): ${near.join(', ') || 'none'}`);
for (const g of (await api(`/env-groups?ownerId=${owner.id}&limit=50`).catch(() => [])).map((x) => x.envGroup ?? x)) {
  const full = await api(`/env-groups/${g.id}`).catch(() => ({}));
  console.log(`GROUP "${g.name}" linked to [${(full.serviceLinks ?? []).map((l) => l.name ?? l.id).join(', ')}]: ${(full.envVars ?? []).map((e) => e.key).join(', ')}`);
}
const lines = [];
for (let page = 0, end = ''; page < 30; page += 1) { const r = await api(`/logs?ownerId=${owner.id}&resource=${svc.id}&limit=100&direction=backward${end}`); lines.push(...(r.logs || [])); if (!r.hasMore || !r.nextEndTime) break; end = `&endTime=${encodeURIComponent(r.nextEndTime)}`; }
for (const l of lines.filter((x) => /Applied migration|Migration .* failed|Skyfly listening|Self-activation|Public registration|Meta app|OAuth|Cloudy|engine/i.test(x.message || '')).slice(0, 14)) console.log(`APP ${l.timestamp.slice(0, 19)} ${String(l.message).slice(0, 260)}`);
// The latest tenancy map (read-only, emails masked by the app): businesses, members, Super Admin memberships.
const tm = lines.filter((x) => /Tenancy map/.test(x.message || ''));
const end = tm.findIndex((x) => /Tenancy map \(read-only\): END/.test(x.message)); const begin = tm.findIndex((x, i) => i > end && /Tenancy map \(read-only\): BEGIN/.test(x.message));
for (const l of tm.slice(Math.max(end, 0), begin + 1).reverse()) console.log(`TENANCY ${String(l.message).replace('Tenancy map (read-only): ', '').slice(0, 700)}`);
// Customer and admin URLs on the deployed site (signed out): status, redirect, title and main heading.
for (const p of ['/signup', '/login', '/', '/businesses/1', '/admin/login', '/admin', '/forgot-password', '/reset-password/0000expired0000', '/invite/0000expired0000', '/verify-email']) {
  const r = await fetch(`https://getskyfly.com${p}`, { redirect: 'manual' });
  const html = r.status === 200 ? await r.text() : '';
  const t = (re) => (html.match(re)?.[1] ?? '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().slice(0, 90);
  console.log(`URL https://getskyfly.com${p} -> ${r.status}${r.headers.get('location') ? ` -> ${r.headers.get('location')}` : ''} | title "${t(/<title>([\s\S]*?)<\/title>/)}" | h1 "${t(/<h1[^>]*>([\s\S]*?)<\/h1>/)}"${/opens soon/i.test(html) ? ' | REGISTRATION CLOSED notice' : ''}${/name="password"/.test(html) ? ' | has password form' : ''}`);
}
