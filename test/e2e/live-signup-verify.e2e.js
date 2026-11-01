// Live end-to-end check of public business registration with real email verification, on the deployed
// service. Uses Resend's official test inbox (delivered+<label>@resend.dev: Resend accepts the email and
// stores it, nothing reaches a person), so the real verification email can be read back through the
// Resend API and its link opened. Creates one labelled test business ("Signup Verify <run> (test)"),
// no orders. Prints no secrets and no tokens.
//
//   SKYFLY_URL=https://getskyfly.com RESEND_API_KEY=… node test/e2e/live-signup-verify.e2e.js
const SKYFLY = (process.env.SKYFLY_URL || '').replace(/\/+$/, '');
if (!/^https:\/\/[a-z0-9-]+\.onrender\.com$|^https:\/\/getskyfly\.com$|^http:\/\/localhost:\d+$/.test(SKYFLY)) throw new Error('Set SKYFLY_URL');
const RUN = String(process.env.GITHUB_RUN_ID || Date.now()).slice(-8);
const EMAIL = `delivered+skyfly${RUN}@resend.dev`;
const PASSWORD = `Sv-${Math.random().toString(36).slice(2)}-${RUN}`;
const BUSINESS = `Signup Verify ${RUN} (test)`;
let failed = 0;
const results = {};
async function step(key, name, fn) {
  try { const info = await fn(); results[key] ??= 'PASS'; console.log(`PASS  ${name}${info ? ` — ${info}` : ''}`); return true; }
  catch (err) { failed += 1; results[key] = 'FAIL'; console.log(`FAIL  ${name} — ${String(err.message).slice(0, 400)}`); return false; }
}
const assert = (c, m) => { if (!c) throw new Error(m); };

function session() {
  const jar = new Map();
  const req = async (method, path, form) => {
    const res = await fetch(path.startsWith('http') ? path : SKYFLY + path, { method, redirect: 'manual', headers: { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '), ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) }, body: form ? new URLSearchParams(form).toString() : undefined });
    for (const c of res.headers.getSetCookie?.() ?? []) { const kv = c.split(';')[0]; jar.set(kv.slice(0, kv.indexOf('=')), kv.slice(kv.indexOf('=') + 1)); }
    return { status: res.status, text: await res.text(), location: res.headers.get('location') || '' };
  };
  const csrf = async (p) => (await req('GET', p)).text.match(/name="_csrf" value="([^"]+)"/)?.[1];
  return { req, csrf };
}
const resend = async (path) => {
  const r = await fetch(`https://api.resend.com${path}`, { headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}` } });
  if (r.status !== 200) throw new Error(`Resend API ${path.split('?')[0]} → HTTP ${r.status} ${(await r.text()).slice(0, 160)}`);
  return r.json();
};

const s = session();
let biz = null; let link = null;
try {
  await step('button', 'Sign-in page shows a prominent "Create Your Business Account" button linking to /signup', async () => {
    const r = await s.req('GET', '/login');
    assert(r.status === 200, `/login → ${r.status}`);
    const cta = r.text.match(/data-signup-cta[\s\S]*?<a[^>]*href="([^"]+)"[^>]*>([^<]+)</);
    assert(cta, 'no sign-up button on /login (registration is closed: no email sender configured)');
    assert(cta[1] === '/signup' && /Create Your Business Account/.test(cta[2]), `button "${cta[2]}" → ${cta[1]}`);
    return `"${cta[2].trim()}" → ${SKYFLY}/signup`;
  });
  const open = await step('registration', '/signup is public: Full name, Business name, Email, Phone, Password, Confirm, Terms checkbox', async () => {
    const r = await s.req('GET', '/signup');
    assert(r.status === 200, `/signup → ${r.status} (closed: email sender not configured, see the report)`);
    for (const f of ['name', 'business_name', 'email', 'phone', 'password', 'confirm', 'accept_terms']) assert(new RegExp(`name="${f}"`).test(r.text), `missing ${f}`);
  });
  if (!open) throw new Error('registration closed');

  await step('registration', 'A new owner registers and is sent to "Confirm your email" (no dashboard before confirming)', async () => {
    const _csrf = await s.csrf('/signup');
    const r = await s.req('POST', '/signup', { _csrf, name: 'Signup Verify Owner', business_name: BUSINESS, email: EMAIL, phone: '+234 800 000 0009', password: PASSWORD, confirm: PASSWORD, accept_terms: 'on' });
    assert(r.status === 302, `HTTP ${r.status}: ${r.text.match(/role="alert">([^<]+)/)?.[1] ?? ''}`);
    assert(r.location === '/verify-email', `went to ${r.location}${r.location.includes('failed') ? ' (the verification email could not be sent)' : ''}`);
    const page = await s.req('GET', '/verify-email');
    assert(page.status === 200 && /data-verify-email/.test(page.text), `/verify-email → ${page.status}`);
    const home = await s.req('GET', '/');
    assert(home.location === '/verify-email', `/ before confirming → ${home.status} ${home.location}`);
    const admin = await s.req('GET', '/admin');
    assert(admin.status === 404 || /verify-email/.test(admin.location), `/admin → ${admin.status} ${admin.location}`);
    return `test inbox ${EMAIL.replace(/\+.*@/, '+…@')}; dashboard locked until confirmed`;
  });

  await step('verification', 'The verification email is delivered by Resend and contains a getskyfly.com confirmation link', async () => {
    assert(process.env.RESEND_API_KEY, 'no Resend API key available to read the test inbox');
    for (let i = 0; i < 12 && !link; i += 1) {
      const list = await resend('/emails?limit=50');
      const hit = (list.data || []).find((e) => (e.to || []).includes(EMAIL));
      if (hit) {
        const full = await resend(`/emails/${hit.id}`);
        assert(/Confirm your email/.test(full.subject || ''), `subject "${full.subject}"`);
        link = (`${full.html || ''} ${full.text || ''}`.match(/https?:\/\/[^\s"'<>]+\/verify-email\/[A-Za-z0-9_-]{40,60}/) || [])[0];
        assert(link, 'no confirmation link in the email');
        assert(link.startsWith(`${SKYFLY}/verify-email/`), `link points to ${new URL(link).origin}`);
        return `subject "${full.subject}", from ${full.from}, status ${hit.last_event ?? 'sent'}`;
      }
      await new Promise((r) => setTimeout(r, 5000));
    }
    throw new Error('the email did not appear in Resend within 60 s');
  });

  if (link) await step('verification', 'Opening the link confirms the email and opens the owner\'s own new business', async () => {
    const r = await s.req('GET', new URL(link).pathname);
    assert(r.status === 302, `link → ${r.status}`);
    const home = await s.req('GET', '/');
    assert(/^\/businesses\/\d+$/.test(home.location), `/ after confirming → ${home.location}`);
    biz = Number(home.location.match(/(\d+)$/)[1]);
    const dash = await s.req('GET', home.location);
    assert(dash.status === 200 && dash.text.includes(BUSINESS.replace(' (test)', '')), 'own business not shown');
    assert(!/Larose/i.test(dash.text), 'Larose shown to a new business');
    const again = await s.req('GET', new URL(link).pathname);
    assert(again.status === 410, `a used link → ${again.status}`);
    return `business #${biz}; the same link used again → 410`;
  });

  if (biz) await step('workspace', 'The new owner is Owner of their own business only; every other business and the Super Admin area are refused', async () => {
    const team = await s.req('GET', `/businesses/${biz}/team`);
    assert(team.status === 200 && /Owner/.test(team.text), `team → ${team.status}`);
    const refused = [];
    for (let id = 1; id <= biz + 2; id += 1) {
      if (id === biz) continue;
      for (const p of ['', '/orders', '/customers', '/settings']) {
        const r = await s.req('GET', `/businesses/${id}${p}`);
        assert(r.status === 404, `business ${id}${p} → ${r.status}`);
      }
      refused.push(id);
    }
    for (const p of ['/admin', '/admin/accounts', '/admin/login']) { const r = await s.req('GET', p); assert(r.status === 404, `${p} → ${r.status}`); }
    return `businesses ${refused.join(', ')} × 4 sections → 404; Super Admin area → 404`;
  });

  if (biz) await step('login', 'Sign out, then sign in at /login: straight to the same own dashboard', async () => {
    const _csrf = await s.csrf(`/businesses/${biz}`);
    await s.req('POST', '/logout', { _csrf });
    const t = session();
    const c = await t.csrf('/login');
    const r = await t.req('POST', '/login', { _csrf: c, email: EMAIL, password: PASSWORD });
    assert(r.status === 302, `login → ${r.status}`);
    const home = await t.req('GET', r.location || '/');
    const to = home.location || r.location;
    assert(to === `/businesses/${biz}`, `landed on ${to}`);
    const u = session();
    const wrong = await u.req('POST', '/login', { _csrf: await u.csrf('/login'), email: EMAIL, password: 'wrong-password-x' });
    assert(wrong.status === 401, `wrong password → ${wrong.status}`);
    return `${SKYFLY}/login → /businesses/${biz}`;
  });
} catch (err) {
  if (err.message !== 'registration closed') { failed += 1; console.log(`FAIL  ${err.message}`); }
}
console.log(`\nREPORT  Signup button: ${results.button ?? 'NOT TESTED'} | Public registration: ${results.registration ?? 'NOT TESTED'} | Email verification: ${results.verification ?? 'NOT TESTED'} | Workspace creation: ${results.workspace ?? 'NOT TESTED'} | Login: ${results.login ?? 'NOT TESTED'}`);
console.log(failed ? `${failed} check(s) failed` : `All checks passed (test business "${BUSINESS}" was created; no order)`);
process.exit(failed ? 1 : 0);
