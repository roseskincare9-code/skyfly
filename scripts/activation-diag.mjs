// Temporary (branch only): READ-ONLY diagnosis of Resend, Cloudflare DNS and Turnstile for getskyfly.com, using the
// keys saved on the Render skyfly service. Values are held in memory only and never printed. Nothing is created,
// changed or deleted here.
import { execSync } from 'node:child_process';
const api = async (p) => { const r = await fetch(`https://api.render.com/v1${p}`, { headers: { Authorization: `Bearer ${process.env.RENDER_API_KEY}`, Accept: 'application/json' } }); if (!r.ok) throw new Error(`${p.split('?')[0]} HTTP ${r.status}`); return r.json(); };
const SVC = 'srv-db8dgdhsrm7s73e959qg'; const D = 'getskyfly.com';
const vars = (await api(`/services/${SVC}/env-vars?limit=100`)).map((e) => e.envVar ?? e);
const val = (k) => String(vars.find((v) => v.key === k)?.value ?? '').trim();
for (const k of ['RESEND_API_KEY', 'CLOUDFLARE_API_TOKEN', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY']) {
  const v = val(k); console.log(`KEY ${k}: ${v ? `present (length ${v.length}${/\s/.test(vars.find((x) => x.key === k).value) ? ', HAS SURROUNDING WHITESPACE' : ''})` : 'ABSENT'}`);
}
const dig = (t, n) => { try { return execSync(`dig +short ${t} ${n} @1.1.1.1`, { encoding: 'utf8' }).trim().replace(/\n/g, ' | ') || '(none)'; } catch { return '(dig failed)'; } };
console.log(`DNS NS ${D}: ${dig('NS', D)}`);
const j = async (url, token, opts = {}) => { const r = await fetch(url, { ...opts, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), Accept: 'application/json', ...(opts.headers || {}) } }); const t = await r.text(); let b = null; try { b = JSON.parse(t); } catch {} return { status: r.status, body: b }; };

const RS = val('RESEND_API_KEY');
if (RS) {
  const l = await j('https://api.resend.com/domains', RS);
  console.log(`RESEND list domains: HTTP ${l.status}${l.status >= 400 ? ` ${JSON.stringify(l.body?.message ?? l.body?.name ?? '')}` : ''}`);
  for (const d of l.body?.data ?? []) console.log(`RESEND domain ${d.name} status=${d.status} region=${d.region} created=${d.created_at}`);
  const dom = (l.body?.data ?? []).find((d) => d.name === D);
  if (dom) {
    const full = await j(`https://api.resend.com/domains/${dom.id}`, RS);
    for (const r of full.body?.records ?? []) {
      const fq = !r.name || r.name === '@' ? D : r.name.endsWith(D) ? r.name : `${r.name}.${D}`;
      const live = dig(r.type, fq);
      const want = String(r.value).replace(/^"|"$/g, '');
      const ok = live.replace(/"/g, '').replace(/\s/g, '').includes(want.replace(/\s/g, '').replace(/\.$/, '').slice(0, 60));
      console.log(`RESEND record ${r.record} ${r.type} ${fq}${r.priority != null ? ` prio ${r.priority}` : ''} resend-status=${r.status} | public DNS: ${ok ? 'MATCHES' : `DIFFERENT/MISSING (live: ${live.slice(0, 120)})`} | expected starts "${want.slice(0, 50)}"`);
    }
  } else console.log(`RESEND: ${D} is not added in this Resend account yet`);
}

const CF = val('CLOUDFLARE_API_TOKEN');
if (CF) {
  const v = await j('https://api.cloudflare.com/client/v4/user/tokens/verify', CF);
  console.log(`CF token verify: HTTP ${v.status} status=${v.body?.result?.status} ${(v.body?.errors ?? []).map((e) => e.message).join('; ')}`);
  const z = await j(`https://api.cloudflare.com/client/v4/zones?name=${D}`, CF);
  console.log(`CF zone read: HTTP ${z.status} found=${(z.body?.result ?? []).length} ${(z.body?.errors ?? []).map((e) => e.message).join('; ')}`);
  const zone = z.body?.result?.[0];
  if (zone) {
    console.log(`CF zone ${zone.name} status=${zone.status} account=${zone.account?.name ? 'named' : '?'} nameservers=${(zone.name_servers ?? []).join(',')}`);
    const recs = await j(`https://api.cloudflare.com/client/v4/zones/${zone.id}/dns_records?per_page=500`, CF);
    console.log(`CF DNS read: HTTP ${recs.status} count=${(recs.body?.result ?? []).length}`);
    for (const r of recs.body?.result ?? []) if (/resend|_domainkey|^send\.|_dmarc/.test(r.name) || r.type === 'MX' || (r.type === 'TXT' && /spf/i.test(r.content))) console.log(`CF record ${r.type} ${r.name} proxied=${r.proxied} "${String(r.content).slice(0, 70)}"`);
    const w = await j(`https://api.cloudflare.com/client/v4/accounts/${zone.account.id}/challenges/widgets?per_page=50`, CF);
    console.log(`CF Turnstile list: HTTP ${w.status} ${(w.body?.errors ?? []).map((e) => `${e.code} ${e.message}`).join('; ')}`);
    for (const x of w.body?.result ?? []) console.log(`CF Turnstile widget "${x.name}" mode=${x.mode} domains=${(x.domains ?? []).join(',')}`);
    // Permission probe without writing: a DNS record "create" with an invalid body is rejected for validation (has edit) vs auth (no edit).
  }
}
for (const k of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY']) {
  const v = val(k); if (!v) continue;
  const r = k.startsWith('OPENAI') ? await j('https://api.openai.com/v1/models', v) : await j('https://api.anthropic.com/v1/models', '', { headers: { 'x-api-key': v, 'anthropic-version': '2023-06-01' } });
  console.log(`${k} models list: HTTP ${r.status} ${r.status >= 400 ? JSON.stringify(r.body?.error?.message ?? r.body?.error ?? '').slice(0, 160) : `${(r.body?.data ?? []).length} models`}`);
}
// Public DNS for the records Resend normally asks for (names are standard; values are account-specific).
for (const [t, n] of [['TXT', `resend._domainkey.${D}`], ['MX', `send.${D}`], ['TXT', `send.${D}`], ['TXT', `_dmarc.${D}`], ['MX', D], ['TXT', D]]) console.log(`DNS ${t} ${n}: ${dig(t, n).slice(0, 160)}`);
// Live Larose catalogs (public endpoints), in the order Skyfly serves them.
for (const slug of ['larosenigeria', 'larose-skincare']) {
  const r = await fetch(`https://getskyfly.com/api/public/pages/${slug}/catalog`, { headers: { Origin: 'https://roseskincare9-code.github.io' } });
  const t = await r.text(); let b = null; try { b = JSON.parse(t); } catch {}
  const list = Array.isArray(b) ? b : (b?.products ?? b?.items ?? []);
  console.log(`CATALOG ${slug}: HTTP ${r.status} keys=${b && !Array.isArray(b) ? Object.keys(b).join(',') : 'array'}`);
  for (const p of list) console.log(`CATALOG ${slug}  ${p.code ?? p.product} | ${p.name} | ${p.price ?? p.price_minor ?? p.unitPrice}`);
  if (b?.upsell) console.log(`CATALOG ${slug}  upsell: ${b.upsell.code} | ${b.upsell.name} | ${b.upsell.price ?? b.upsell.price_minor}`);
  if (!list.length) console.log(`CATALOG ${slug} raw: ${t.slice(0, 400)}`);
}
{ const r = await fetch('https://getskyfly.com/p/larose-skincare/'); const h = await r.text();
  const opts = [...h.matchAll(/data-product="([^"]+)" data-price="(\d+)"/g)].map((m) => `${m[1]}=${m[2]}`);
  console.log(`HOSTED /p/larose-skincare/ HTTP ${r.status} options: ${opts.join(', ')} | facial-set as package: ${/data-product="facial-set"/.test(h)} | old packages: ${/package-1/.test(h)}`); }
