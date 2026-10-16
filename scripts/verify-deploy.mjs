// Read-only check of a deployed Skyfly service. Creates no orders or accounts.
// Usage: node scripts/verify-deploy.mjs [url]
// With RENDER_API_KEY set, also reads the service URL, deploy status and database
// status from the Render API (the key is never printed).
const RENDER = 'https://api.render.com/v1';
const LAROSE_ORIGIN = 'https://roseskincare9-code.github.io';
const results = [];
const report = (ok, name, detail = '') => {
  results.push({ ok, name, detail });
  console.log(`${ok === true ? 'PASS' : ok === false ? 'FAIL' : 'INFO'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

async function get(url, opts = {}) {
  try {
    const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(60000), ...opts });
    return { status: res.status, headers: res.headers, text: await res.text() };
  } catch (err) {
    return { status: 0, headers: new Headers(), text: String(err.cause?.code || err.message) };
  }
}

async function render(path) {
  const res = await get(`${RENDER}${path}`, { headers: { Authorization: `Bearer ${process.env.RENDER_API_KEY}`, Accept: 'application/json' } });
  if (res.status !== 200) throw new Error(`Render API ${path} -> HTTP ${res.status}`);
  return JSON.parse(res.text);
}

let url = (process.argv[2] || '').replace(/\/+$/, '');
// skyfly.onrender.com belongs to an unrelated Java app on another Render account (verified 2026-10-15).
if (/^https?:\/\/skyfly\.onrender\.com$/i.test(url)) {
  report(false, 'Service URL', 'skyfly.onrender.com is NOT this project (another account\'s Java app); not checking it');
  url = '';
}

if (process.env.RENDER_API_KEY) {
  // Read-only. Every query is made per workspace, because a Blueprint may live in any of them.
  try {
    const owners = (await render('/owners?limit=20')).map((o) => o.owner ?? o);
    report(null, 'Render: workspaces searched for Skyfly resources', String(owners.length));
    let svc = null;
    let db = null;
    for (const o of owners) {
      const q = `ownerId=${encodeURIComponent(o.id)}&limit=100`;
      const services = (await render(`/services?${q}`)).map((x) => x.service ?? x);
      const dbs = (await render(`/postgres?${q}`)).map((x) => x.postgres ?? x);
      let blueprints = [];
      try { blueprints = (await render(`/blueprints?${q}`)).map((x) => x.blueprint ?? x); } catch { /* not available */ }
      // Isolation: only Skyfly resources are reported; other projects' resources are never listed.
      const mineHere = (x) => /skyfly/i.test(`${x.name} ${x.repo || ''}`);
      report(null, `Workspace "${o.name}"`, `Skyfly services: ${services.filter(mineHere).map((x) => `${x.name} (${x.type})`).join(', ') || 'none'}; Skyfly databases: ${dbs.filter(mineHere).map((x) => `${x.name} [${x.status}]`).join(', ') || 'none'}; Skyfly blueprints: ${blueprints.filter(mineHere).map((b) => `${b.name} [${b.status}]`).join(', ') || 'none'}`);
      for (const b of blueprints.filter((x) => /skyfly/i.test(`${x.name} ${x.repo}`))) {
        try {
          const syncs = (await render(`/blueprints/${b.id}/syncs?limit=3`)).map((x) => x.sync ?? x);
          report(null, `  Blueprint ${b.name} syncs`, syncs.map((x) => JSON.stringify(x).slice(0, 300)).join(' | ') || 'none');
        } catch (err) { report(null, `  Blueprint ${b.name} syncs`, err.message); }
      }
      svc ||= services.find((x) => x.name === 'skyfly' || x.repo?.endsWith('/skyfly'));
      db ||= dbs.find((x) => x.name === 'skyfly-db');
    }
    report(Boolean(svc), 'Render: skyfly web service exists', svc ? `${svc.name} (${svc.type}${svc.suspended === 'suspended' ? ', SUSPENDED' : ''})` : 'not found in any workspace');
    if (svc) {
      const renderUrl = svc.serviceDetails?.url;
      report(Boolean(renderUrl), 'Render: service URL', renderUrl || 'not assigned');
      if (renderUrl && !url) url = renderUrl.replace(/\/+$/, '');
      const deploys = (await render(`/services/${svc.id}/deploys?limit=3`)).map((d) => d.deploy ?? d);
      const d = deploys[0];
      report(d?.status === 'live', 'Render: latest deploy', d ? `${d.status} (commit ${d.commit?.id?.slice(0, 7) || '?'}, ${d.finishedAt || d.createdAt})` : 'no deploys');
      if (d && d.status !== 'live') {
        try {
          const logs = await render(`/logs?ownerId=${encodeURIComponent(svc.ownerId)}&resource=${svc.id}&limit=60&direction=backward`);
          const lines = (logs.logs || []).map((l) => l.message).filter(Boolean).reverse();
          console.log('\n--- last service log lines ---\n' + lines.join('\n') + '\n---');
        } catch (err) { report(null, 'Render: logs', err.message); }
      }
      // Read-only: did "Set up Larose" (or anything else) fail recently? Only short, masked lines are shown.
      try {
        const mask = (t) => String(t).replace(/[^\s@]+@[^\s@]+/g, '<email>').slice(0, 200);
        const base = `/logs?ownerId=${encodeURIComponent(svc.ownerId)}&resource=${svc.id}&limit=100&direction=backward`;
        const req = ((await render(`${base}&type=request`)).logs || []).map((l) => l.message || '');
        const setup = req.filter((m) => m.includes('/setup/larose'));
        const failed = req.filter((m) => /\s5\d\d\b|"statusCode":\s*5\d\d|status[=:]\s*5\d\d/.test(m));
        report(null, 'Render logs: "Set up Larose" requests (latest 100 requests)', setup.length ? setup.slice(0, 5).map(mask).join(' | ') : 'none');
        report(null, 'Render logs: server errors (HTTP 5xx, latest 100 requests)', failed.length ? failed.slice(0, 5).map(mask).join(' | ') : 'none');
        const app = ((await render(`${base}&type=app`)).logs || []).map((l) => l.message || '').filter((m) => /error/i.test(m));
        report(null, 'Render logs: recent app errors', app.length ? app.slice(0, 5).map((m) => mask(m.split('\n')[0])).join(' | ') : 'none');
      } catch (err) { report(null, 'Render logs', err.message); }
    }
    report(db ? db.status === 'available' : false, 'Render: skyfly-db database', db ? `${db.status}, plan ${db.plan}, region ${db.region}` : 'not found in any workspace');
  } catch (err) {
    report(false, 'Render API', err.message);
  }
} else {
  report(null, 'Render API', 'RENDER_API_KEY not set; checking the given URL only');
}

if (!url) {
  report(false, 'Service URL', 'none given and none found via the Render API');
} else {
  console.log(`\nChecking ${url}\n`);
  const health = await get(`${url}/healthz`);
  report(health.status === 200 && health.text.trim() === '{"status":"ok"}', 'GET /healthz (app up, database connected)', `HTTP ${health.status} ${health.text.slice(0, 80)}`);

  const sdk = await get(`${url}/sdk/skyfly.js`);
  const login = await get(`${url}/login`);
  const isSkyfly = sdk.status === 200 && sdk.text.includes('Skyfly page SDK') && login.text.includes('Log in to Skyfly');
  report(isSkyfly, 'This address runs Skyfly (SDK banner + login page)', `sdk HTTP ${sdk.status}, login HTTP ${login.status}`);
  if (isSkyfly) report(null, 'Dashboard design', login.text.includes('class="auth-brand"') ? 'beauty redesign (sidebar layout) is live' : 'previous design');

  if (isSkyfly) {
    report(/max-age=\d+/.test(login.headers.get('strict-transport-security') || ''), 'Security header: HSTS');
    report(/default-src 'self'/.test(login.headers.get('content-security-policy') || ''), 'Security header: CSP');
    const cookie = login.headers.get('set-cookie') || '';
    report(/HttpOnly/i.test(cookie) && /Secure/i.test(cookie), 'Session cookie HttpOnly + Secure');

    const signup = await get(`${url}/signup`);
    report(null, 'Owner account', signup.status === 200 ? 'NOT created yet (sign-up is open for the first account)' : signup.status === 404 ? 'created (sign-up closed)' : `unexpected HTTP ${signup.status}`);

    const tracking = await get(`${url}/api/public/pages/larosenigeria/tracking`);
    report(null, 'Larose setup', tracking.status === 200 ? 'done (larosenigeria page registered and active)' : tracking.status === 404 ? 'NOT done yet (click "Set up Larose" on the dashboard)' : `unexpected HTTP ${tracking.status}`);

    const opt = { method: 'OPTIONS', headers: { 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' } };
    const good = await get(`${url}/api/public/orders`, { ...opt, headers: { ...opt.headers, Origin: LAROSE_ORIGIN } });
    report(good.status === 204 && good.headers.get('access-control-allow-origin') === LAROSE_ORIGIN, 'CORS: Larose website may submit orders', `HTTP ${good.status}`);
    const bad = await get(`${url}/api/public/orders`, { ...opt, headers: { ...opt.headers, Origin: 'https://example.invalid' } });
    report(bad.status === 403, 'CORS: other websites refused', `HTTP ${bad.status}`);
    const anon = await get(`${url}/api/public/orders`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    report(anon.status === 401, 'Order API refuses requests with no website or API key', `HTTP ${anon.status}`);

    // Client workspaces release (read-only checks; nothing is created).
    const unsub = await get(`${url}/u/${'0'.repeat(64)}`);
    const workspacesLive = unsub.status === 404 && unsub.text.includes('unsubscribe link is not valid');
    report(null, 'Client workspaces / email automations release', workspacesLive ? 'live' : 'not deployed yet');
    if (workspacesLive) {
      const admin = await get(`${url}/admin`);
      report(admin.status === 302 && /\/login$/.test(admin.headers.get('location') || ''), 'Platform admin requires sign-in', `HTTP ${admin.status} → ${admin.headers.get('location')}`);
      report(signup.status === 404, 'Client sign-up closed (invitation only)', `HTTP ${signup.status}`);
      const badKey = await get(`${url}/api/public/orders`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer sky_${'x'.repeat(32)}` }, body: '{}' });
      report(badKey.status === 401, 'Business API refuses unknown API keys', `HTTP ${badKey.status}`);
    }
  }
}

const failed = results.filter((r) => r.ok === false);
console.log(`\n${failed.length ? `${failed.length} check(s) FAILED` : 'All checks passed'}`);
process.exit(failed.length ? 1 : 0);
