// Temporary branch only: names-only view of the skyfly service's environment, and what the RUNNING app
// itself reported at start-up about the registration keys. No values are printed.
const api = async (p, o = {}) => { const r = await fetch(`https://api.render.com/v1${p}`, { method: o.method || 'GET', headers: { Authorization: `Bearer ${process.env.RENDER_API_KEY}`, Accept: 'application/json', ...(o.body ? { 'Content-Type': 'application/json' } : {}) }, body: o.body ? JSON.stringify(o.body) : undefined }); if (!r.ok) throw new Error(`${p.split('?')[0]} HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`); return r.json(); };
let svc = null; let owner = null;
for (const o of (await api('/owners?limit=20')).map((x) => x.owner ?? x)) { const f = (await api(`/services?ownerId=${o.id}&limit=100`)).map((x) => x.service ?? x).find((s) => s.name === 'skyfly'); if (f && !svc) { svc = f; owner = o; } }
console.log(`SERVICE skyfly id ${svc.id} in workspace "${owner.name}"; URL ${svc.serviceDetails?.url}; custom domains: ${(await api(`/services/${svc.id}/custom-domains?limit=20`).catch(() => [])).map((d) => (d.customDomain ?? d).name).join(', ')}`);
const vars = (await api(`/services/${svc.id}/env-vars?limit=100`)).map((e) => e.envVar ?? e);
console.log(`ENV ${vars.length} variables readable by this Render API key (names, value length only): ${vars.map((v) => `${v.key}(${String(v.value ?? '').length})`).sort().join(', ')}`);

const REQUIRED = ['ALLOWED_ORIGINS', 'ALLOW_SIGNUP', 'DATABASE_SSL', 'DATABASE_URL', 'NODE_ENV', 'NODE_VERSION', 'PUBLIC_BASE_URL', 'SESSION_SECRET', 'SKYFLY_BACKUP_KEY', 'SKYFLY_E2E_PASSWORD_HASH', 'SKYFLY_ENCRYPTION_KEY', 'SKYFLY_META_TEST_EVENT_CODE', 'RESEND_API_KEY', 'CLOUDFLARE_API_TOKEN', 'PAYSTACK_SECRET_KEY', 'ANTHROPIC_API_KEY'];
const have = new Set(vars.map((v) => v.key));
console.log(`MISSING ${REQUIRED.filter((k) => !have.has(k)).join(', ') || 'none'} (of ${REQUIRED.length} expected)`);
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
// One-off READ-ONLY job inside Render (the database refuses outside connections). Prints no token.
const CMD = "node --input-type=module -e \"await import('data:text/javascript;base64,Y29uc3QgeyBjcmVhdGVSZXF1aXJlIH0gPSBhd2FpdCBpbXBvcnQoJ25vZGU6bW9kdWxlJyk7CmNvbnN0IHBnID0gY3JlYXRlUmVxdWlyZShwcm9jZXNzLmN3ZCgpICsgJy94LmpzJykoJ3BnJyk7CmNvbnN0IHEgPSBhc3luYyAoYywgdCkgPT4gKGF3YWl0IGMucXVlcnkodCkpLnJvd3M7CmNvbnN0IGMgPSBuZXcgcGcuQ2xpZW50KHsgY29ubmVjdGlvblN0cmluZzogcHJvY2Vzcy5lbnYuREFUQUJBU0VfVVJMLCBzc2w6IHByb2Nlc3MuZW52LkRBVEFCQVNFX1NTTCA9PT0gJ2ZhbHNlJyA/IGZhbHNlIDogeyByZWplY3RVbmF1dGhvcml6ZWQ6IGZhbHNlIH0gfSk7CmF3YWl0IGMuY29ubmVjdCgpOyBhd2FpdCBjLnF1ZXJ5KCdCRUdJTiBUUkFOU0FDVElPTiBSRUFEIE9OTFknKTsKY29uc3Qgb3V0ID0gKGssIHYpID0+IGNvbnNvbGUubG9nKCdNQiAnICsgayArICcgJyArIEpTT04uc3RyaW5naWZ5KHYpKTsKb3V0KCdtaWdyYXRpb25zJywgKGF3YWl0IHEoYywgIlNFTEVDVCBuYW1lIEZST00gc2NoZW1hX21pZ3JhdGlvbnMgV0hFUkUgbmFtZSB+ICdeMDVbNi04XV8nIE9SREVSIEJZIDEiKSkubWFwKChyKSA9PiByLm5hbWUpKTsKZm9yIChjb25zdCB0IG9mIFsnYWRfcHJvZmlsZXMnLCAnYWRfY29ubmVjdGlvbnMnLCAnYWRfY3JlYXRpdmVzJywgJ2FkX2l0ZW1zJywgJ2FkX21lc3NhZ2VzJ10pIG91dCgncm93cyAnICsgdCwgKGF3YWl0IHEoYywgJ1NFTEVDVCBjb3VudCgqKTo6aW50IG4gRlJPTSAnICsgdCkpWzBdLm4pOwpvdXQoJ2Nvbm5lY3Rpb25zJywgYXdhaXQgcShjLCAiU0VMRUNUIGIuc2x1ZywgYy5hZF9hY2NvdW50X2lkLCBjLmFkX2FjY291bnRfbmFtZSwgYy5jdXJyZW5jeSwgYy5hY2NvdW50X3N0YXR1cywgYy5zdGF0dXMsIGMuc2VsZWN0ZWQsIGMudmVyaWZpZWRfYXQsIGMucGFnZV9pZCBJUyBOT1QgTlVMTCBoYXNfcGFnZSwgYy5waXhlbF9pZCBJUyBOT1QgTlVMTCBoYXNfcGl4ZWwsIGxlZnQoY29hbGVzY2UoYy5sYXN0X2Vycm9yLCcnKSwxMDApIGVyciBGUk9NIGFkX2Nvbm5lY3Rpb25zIGMgSk9JTiBidXNpbmVzc2VzIGIgT04gYi5pZCA9IGMuYnVzaW5lc3NfaWQgT1JERVIgQlkgYy5pZCIpKTsKb3V0KCdpdGVtcycsIGF3YWl0IHEoYywgJ1NFTEVDVCBiLnNsdWcsIGkua2luZCwgaS5zdGF0dXMsIGNvdW50KCopOjppbnQgbiwgY291bnQoaS5tZXRhX3Jlc3VsdCk6OmludCB3aXRoX21ldGEgRlJPTSBhZF9pdGVtcyBpIEpPSU4gYnVzaW5lc3NlcyBiIE9OIGIuaWQgPSBpLmJ1c2luZXNzX2lkIEdST1VQIEJZIDEsMiwzIE9SREVSIEJZIDEsMiwzJykpOwpvdXQoJ3Byb2ZpbGVzJywgYXdhaXQgcShjLCAnU0VMRUNUIGIuc2x1ZyBGUk9NIGFkX3Byb2ZpbGVzIHAgSk9JTiBidXNpbmVzc2VzIGIgT04gYi5pZCA9IHAuYnVzaW5lc3NfaWQnKSk7Cm91dCgnYXVkaXQnLCBhd2FpdCBxKGMsICJTRUxFQ1QgYWN0aW9uLCBjb3VudCgqKTo6aW50IG4sIG1heChjcmVhdGVkX2F0KSBsYXN0IEZST00gYXVkaXRfbG9nIFdIRVJFIGFjdGlvbiBMSUtFICdtZWRpYV9idXllci4lJyBHUk9VUCBCWSAxIE9SREVSIEJZIDEiKSk7CmF3YWl0IGMucXVlcnkoJ1JPTExCQUNLJyk7IGF3YWl0IGMuZW5kKCk7Cg==')\"";
const job = await api(`/services/${svc.id}/jobs`, { method: 'POST', body: { startCommand: CMD } }).catch((e) => ({ err: String(e.message) }));
console.log(`JOB create: ${job.err ?? job.id + ' ' + job.status}`);
if (job.id) {
  let st = job;
  for (let i = 0; i < 40 && !['succeeded', 'failed', 'canceled'].includes(st.status); i++) { await new Promise((r) => setTimeout(r, 6000)); st = await api(`/services/${svc.id}/jobs/${job.id}`); }
  console.log(`JOB status: ${st.status} finishedAt=${st.finishedAt ?? '-'}`);
  await new Promise((r) => setTimeout(r, 8000));
  const lg = await api(`/logs?ownerId=${owner.id}&resource=${job.id}&limit=100&direction=forward&startTime=${encodeURIComponent(job.createdAt)}`).catch((e) => ({ logs: [], err: e.message }));
  if (lg.err) console.log(`JOB logs error ${lg.err}`);
  for (const l of lg.logs || []) console.log(`JOBLOG ${String(l.message).slice(0, 900)}`);
}
process.exit(0);
const lines = [];
for (let page = 0, end = ''; page < 6; page += 1) { const r = await api(`/logs?ownerId=${owner.id}&resource=${svc.id}&limit=100&direction=backward${end}`); lines.push(...(r.logs || [])); if (!r.hasMore || !r.nextEndTime) break; end = `&endTime=${encodeURIComponent(r.nextEndTime)}`; }
for (const l of lines.filter((x) => /Self-activation|Public registration|Skyfly listening|ScaleForge Business Hub/.test(x.message || '')).slice(0, 6)) console.log(`APP ${l.timestamp.slice(0, 19)} ${String(l.message).slice(0, 260)}`);
