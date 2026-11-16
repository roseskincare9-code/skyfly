// Public registration switches itself on from the two keys saved on the Skyfly service (Render →
// skyfly → Environment): RESEND_API_KEY and CLOUDFLARE_API_TOKEN. No GitHub run and no copying of
// derived settings by hand. At start-up, for whatever is not already configured:
//   - Cloudflare Turnstile: finds or creates the "Skyfly signup" widget for getskyfly.com and reads its
//     site key and secret from Cloudflare (held in memory only; never stored or logged);
//   - Resend: finds or adds the sending domain getskyfly.com, adds only MISSING DNS records for it in the
//     getskyfly.com Cloudflare zone (nothing is changed or deleted), asks Resend to verify it, and uses it
//     as Skyfly's sender (no-reply@getskyfly.com) once Resend reports it verified (checked again in the
//     background until then).
// Registration then still opens only after Skyfly's own launch checks pass (a real test send and
// Cloudflare's check of the Turnstile secret). Email verification and the bot check are never skipped.
// Settings saved by hand (TURNSTILE_*, SKYFLY_NOTIFY_*) always win.
export const DOMAIN = 'getskyfly.com';
export const WIDGET = 'Skyfly signup';

async function call(base, token, path, { method = 'GET', body } = {}) {
  const res = await fetch(`${base}${path}`, {
    method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  if (!res.ok) throw new Error(`${method} ${path.split('?')[0]}: HTTP ${res.status} ${(json?.errors?.[0]?.message || json?.message || '').toString().slice(0, 160)}`);
  return json;
}

export async function selfActivate(config, { env = process.env, api = {}, log = console, pollMs = 5 * 60e3, maxPolls = 576, onChange = () => {} } = {}) {
  const CF = String(env.CLOUDFLARE_API_TOKEN ?? '').trim();
  const RS = String(env.RESEND_API_KEY ?? '').trim();
  const base = { cf: api.cf ?? 'https://api.cloudflare.com/client/v4', rs: api.rs ?? 'https://api.resend.com' };
  const cf = (p, o) => call(base.cf, CF, p, o).then((j) => j.result);
  const rs = (p, o) => call(base.rs, RS, p, o);
  const out = { turnstile: config.turnstile ? 'configured' : 'missing', email: config.notifyEmail ? 'configured' : 'missing' };
  if (config.turnstile && config.notifyEmail) return out;
  const hosts = [...new Set([DOMAIN, 'skyfly-gybf.onrender.com', ...(config.publicBaseUrl ? [new URL(config.publicBaseUrl).hostname] : [])])];

  let zone = null;
  if (CF) {
    try {
      zone = (await cf(`/zones?name=${DOMAIN}`))?.[0] ?? null;
      if (!zone) log.error(`Self-activation: the Cloudflare token cannot see the ${DOMAIN} zone (it needs Zone Read, DNS Edit and Turnstile Edit).`);
    } catch (err) { log.error(`Self-activation: Cloudflare: ${err.message}`); }
  }

  // ---- Turnstile
  if (!config.turnstile && zone) {
    try {
      const acct = zone.account.id;
      let widget = (await cf(`/accounts/${acct}/challenges/widgets?per_page=50`)).find((w) => w.name === WIDGET);
      if (!widget) widget = await cf(`/accounts/${acct}/challenges/widgets`, { method: 'POST', body: { name: WIDGET, mode: 'managed', domains: hosts } });
      else if (hosts.some((h) => !widget.domains.includes(h))) {
        await cf(`/accounts/${acct}/challenges/widgets/${widget.sitekey}`, { method: 'PUT', body: { name: WIDGET, mode: widget.mode, domains: [...new Set([...widget.domains, ...hosts])] } });
      }
      const secret = widget.secret ?? (await cf(`/accounts/${acct}/challenges/widgets/${widget.sitekey}`)).secret;
      if (widget.sitekey && secret) {
        config.turnstile = { siteKey: widget.sitekey, secretKey: secret };
        out.turnstile = 'activated';
        log.log(`Self-activation: Turnstile widget "${WIDGET}" in use (domains ${hosts.join(', ')}).`);
      }
    } catch (err) { out.turnstile = `failed: ${err.message}`; log.error(`Self-activation: Turnstile: ${err.message}`); }
  } else if (!config.turnstile) out.turnstile = CF ? 'failed: zone not visible' : 'no CLOUDFLARE_API_TOKEN';

  // ---- Resend sender
  if (!config.notifyEmail && RS) {
    const useSender = () => {
      config.notifyEmail = { provider: 'resend', apiKey: RS, fromEmail: `no-reply@${DOMAIN}`, fromName: 'Skyfly' };
      log.log(`Self-activation: email sender no-reply@${DOMAIN} (Resend, domain verified) in use.`);
    };
    try {
      let domain = (await rs('/domains')).data?.find((d) => d.name === DOMAIN);
      if (!domain) domain = await rs('/domains', { method: 'POST', body: { name: DOMAIN, region: 'eu-west-1' } });
      domain = await rs(`/domains/${domain.id}`);
      if (zone && domain.status !== 'verified') {
        const existing = await cf(`/zones/${zone.id}/dns_records?per_page=500`);
        for (const r of domain.records ?? []) {
          const name = !r.name || r.name === '@' || r.name === DOMAIN ? DOMAIN : r.name.endsWith(`.${DOMAIN}`) ? r.name : `${r.name}.${DOMAIN}`;
          const content = String(r.value).replace(/^"|"$/g, '');
          const same = (e) => e.type === r.type && e.name === name;
          if (existing.some((e) => same(e) && String(e.content).replace(/^"|"$/g, '').replace(/\.$/, '') === content.replace(/\.$/, ''))) continue;
          if (existing.some((e) => same(e) && r.type !== 'TXT' && r.type !== 'MX')) { log.error(`Self-activation: DNS ${r.type} ${name} exists with another value; not changed.`); continue; }
          await cf(`/zones/${zone.id}/dns_records`, { method: 'POST', body: { type: r.type, name, content, ttl: 1, proxied: false, ...(r.type === 'MX' ? { priority: Number(r.priority ?? 10) } : {}), comment: 'Resend (Skyfly email)' } });
          log.log(`Self-activation: added DNS ${r.type} ${name} for Resend.`);
        }
      }
      if (domain.status === 'verified') { useSender(); out.email = 'activated'; } else {
        await rs(`/domains/${domain.id}/verify`, { method: 'POST' }).catch(() => {});
        out.email = `waiting for Resend to verify ${DOMAIN} (${domain.status})`;
        log.log(`Self-activation: ${out.email}; checking again every ${Math.round(pollMs / 60e3)} min.`);
        let n = 0;
        const t = setInterval(async () => {
          n += 1;
          try {
            const d = await rs(`/domains/${domain.id}`);
            if (d.status === 'verified' && !config.notifyEmail) { clearInterval(t); useSender(); await onChange(); }
            else if (n >= maxPolls || d.status === 'failed') { clearInterval(t); log.error(`Self-activation: Resend domain ${DOMAIN} is ${d.status}; email sender not switched on.`); }
          } catch (err) { log.error(`Self-activation: Resend check: ${err.message}`); }
        }, pollMs);
        t.unref?.();
        out.timer = t;
      }
    } catch (err) { out.email = `failed: ${err.message}`; log.error(`Self-activation: Resend: ${err.message}`); }
  } else if (!config.notifyEmail) out.email = 'no RESEND_API_KEY';
  return out;
}
