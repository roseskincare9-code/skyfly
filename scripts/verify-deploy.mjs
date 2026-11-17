// Temporary branch only: availability probe of getskyfly.com from outside (DNS, TLS, HTTP), no secrets.
import { promises as dns } from 'node:dns';
import tls from 'node:tls';
const hosts = ['getskyfly.com', 'www.getskyfly.com', 'skyfly-gybf.onrender.com'];
for (const h of hosts) {
  for (const t of ['A', 'AAAA', 'CNAME']) {
    try { console.log(`DNS ${h} ${t}: ${(await dns.resolve(h, t)).join(', ')}`); } catch (e) { console.log(`DNS ${h} ${t}: ${e.code}`); }
  }
  try { console.log(`DNS ${h} NS: ${(await dns.resolveNs(h.split('.').slice(-2).join('.'))).join(', ')}`); } catch (e) { console.log(`DNS ${h} NS: ${e.code}`); }
  await new Promise((done) => {
    const s = tls.connect({ host: h, port: 443, servername: h, timeout: 15000 }, () => {
      const c = s.getPeerCertificate();
      console.log(`TLS ${h}: ${s.authorized ? 'valid' : `NOT valid (${s.authorizationError})`}; issuer ${c.issuer?.O ?? '?'} / ${c.issuer?.CN ?? '?'}; subject ${c.subject?.CN}; SAN ${String(c.subjectaltname).slice(0, 120)}; expires ${c.valid_to}`);
      s.end(); done();
    });
    s.on('error', (e) => { console.log(`TLS ${h}: ERROR ${e.code ?? ''} ${e.message}`); done(); });
    s.on('timeout', () => { console.log(`TLS ${h}: TIMEOUT`); s.destroy(); done(); });
  });
}
const urls = ['https://getskyfly.com/', 'https://getskyfly.com/login', 'https://getskyfly.com/signup', 'https://getskyfly.com/admin/login', 'https://getskyfly.com/healthz', 'https://www.getskyfly.com/', 'http://getskyfly.com/', 'https://skyfly-gybf.onrender.com/healthz', 'https://skyfly-gybf.onrender.com/login'];
for (let round = 1; round <= 3; round += 1) {
  for (const u of urls) {
    const t0 = Date.now();
    try {
      const r = await fetch(u, { redirect: 'manual', signal: AbortSignal.timeout(30000) });
      const body = await r.text();
      console.log(`HTTP round ${round} ${u} → ${r.status} ${r.headers.get('location') ? `→ ${r.headers.get('location')} ` : ''}(${Date.now() - t0} ms; server ${r.headers.get('server')}; cf-ray ${r.headers.get('cf-ray') ?? '-'}; title "${(body.match(/<title>([^<]*)/)?.[1] ?? '').slice(0, 60)}")`);
    } catch (e) { console.log(`HTTP round ${round} ${u} → ERROR ${e.cause?.code ?? ''} ${e.cause?.message ?? e.message} (${Date.now() - t0} ms)`); }
  }
  if (round < 3) await new Promise((r) => setTimeout(r, 20000));
}
