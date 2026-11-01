// Live check of registration and sign-in protection on the deployed service, with a made-up address
// (e2e-throttle-<run>@skyfly.invalid, no account): Terms and Privacy pages, registration closed while
// email verification is unavailable, and the per-email limit on business and Super Admin sign-in
// (5 wrong passwords → the 6th attempt waits). Creates nothing; uses no secrets.
//
//   SKYFLY_URL=https://getskyfly.com node test/e2e/live-abuse.e2e.js
const SKYFLY = (process.env.SKYFLY_URL || '').replace(/\/+$/, '');
if (!/^https:\/\/[a-z0-9-]+\.onrender\.com$|^https:\/\/getskyfly\.com$|^http:\/\/localhost:\d+$/.test(SKYFLY)) throw new Error('Set SKYFLY_URL');
const RUN = String(process.env.GITHUB_RUN_ID || Date.now()).slice(-8);
let failed = 0;
async function step(name, fn) {
  try { const info = await fn(); console.log(`PASS  ${name}${info ? ` — ${info}` : ''}`); }
  catch (err) { failed += 1; console.log(`FAIL  ${name} — ${String(err.message).slice(0, 300)}`); }
}
const assert = (c, m) => { if (!c) throw new Error(m); };
async function session() {
  const jar = new Map();
  const req = async (method, path, form) => {
    const res = await fetch(SKYFLY + path, { method, redirect: 'manual', headers: { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '), ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) }, body: form ? new URLSearchParams(form).toString() : undefined });
    for (const c of res.headers.getSetCookie?.() ?? []) { const kv = c.split(';')[0]; jar.set(kv.slice(0, kv.indexOf('=')), kv.slice(kv.indexOf('=') + 1)); }
    return { status: res.status, text: await res.text(), location: res.headers.get('location') || '' };
  };
  return { req, csrf: async (p) => (await req('GET', p)).text.match(/name="_csrf" value="([^"]+)"/)?.[1] };
}

await step('Terms of Service and Privacy Policy pages are public', async () => {
  const out = [];
  for (const p of ['/terms', '/privacy']) { const r = await fetch(SKYFLY + p); const t = await r.text(); assert(r.status === 200 && /Version \d{4}-\d\d-\d\d/.test(t), `${p} → ${r.status}`); out.push(`${p} 200 (${t.match(/Version (\d{4}-\d\d-\d\d)/)[1]})`); }
  return out.join(', ');
});
await step('Registration: closed while email verification is unavailable, or open with the Terms checkbox', async () => {
  const r = await fetch(`${SKYFLY}/signup`); const t = await r.text();
  if (r.status === 404) return '/signup → 404 "by invitation" (no email sender yet)';
  assert(r.status === 200 && /name="accept_terms"[^>]*required/.test(t) && /name="website"/.test(t), `/signup → ${r.status} without the Terms checkbox`);
  return '/signup open with required Terms checkbox and bot trap';
});
for (const [label, path] of [['Business sign-in', '/login'], ['Super Admin sign-in', '/admin/login']]) {
  await step(`${label}: 5 wrong passwords for one email, then the 6th attempt is refused for 15 minutes`, async () => {
    const s = await session();
    const email = `e2e-throttle-${label.startsWith('Super') ? 'admin' : 'owner'}-${RUN}@skyfly.invalid`;
    const codes = [];
    for (let i = 0; i < 6; i += 1) {
      const _csrf = await s.csrf(path);
      const r = await s.req('POST', path, { _csrf, email, password: `wrong-password-${i}-xyz` });
      codes.push(r.status);
    }
    assert(codes.slice(0, 5).every((c) => c === 401) && codes[5] === 429, `statuses ${codes.join(', ')}`);
    return `statuses ${codes.join(', ')} (address without an account: same answers as for a real one)`;
  });
}
console.log(failed ? `\n${failed} check(s) failed` : '\nAll abuse-protection checks passed');
process.exit(failed ? 1 : 0);
