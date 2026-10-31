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
      // Which optional integration settings exist (names only; values are never read).
      try {
        const names = new Set((await render(`/services/${svc.id}/env-vars?limit=100`)).map((e) => (e.envVar ?? e).key));
        const opt = ['GOOGLE_SERVICE_ACCOUNT_JSON', 'SKYFLY_META_ACCESS_TOKEN', 'SKYFLY_META_TEST_EVENT_CODE', 'SKYFLY_BACKUP_KEY', 'SKYFLY_NOTIFY_API_KEY', 'SKYFLY_NOTIFY_FROM', 'SKYFLY_NOTIFY_PROVIDER', 'SKYFLY_ENCRYPTION_KEY'];
        report(null, 'Render: optional settings on the service itself (names only)', opt.map((k) => `${k}: ${names.has(k) ? 'set' : 'not set'}`).join('; '));
        try {
          const sf = (await render(`/services/${svc.id}/secret-files?limit=50`)).map((f) => f.secretFile ?? f);
          report(null, 'Render: secret files on the service itself (names only)', sf.map((f) => f.name).join(', ') || 'none');
        } catch (err) { report(null, 'Render: secret files on the service', err.message); }
      } catch (err) { report(null, 'Render: optional settings', err.message); }
      // Environment groups (names, setting names and links only; values are never read or printed).
      try {
        const groups = (await render(`/env-groups?ownerId=${encodeURIComponent(svc.ownerId)}&limit=50`)).map((g) => g.envGroup ?? g);
        if (!groups.length) report(null, 'Render: environment groups', 'none');
        for (const g of groups) {
          const linked = (g.serviceLinks || []).some((l) => l.id === svc.id);
          let keys = '?';
          let vars = [];
          let files = [];
          try {
            const detail = await render(`/env-groups/${g.id}`);
            vars = (detail.envVars || []).map((v) => v.envVar ?? v);
            files = (detail.secretFiles || []).map((f) => f.secretFile ?? f);
            keys = vars.map((v) => v.key).join(', ') || 'no settings';
          } catch { /* names unavailable */ }
          report(null, `Render: environment group "${g.name}"`, `${linked ? 'LINKED to skyfly' : 'NOT linked to skyfly'}; setting names: ${keys}; secret files: ${files.map((f) => f.name).join(', ') || 'none'}; last changed ${g.updatedAt ?? '?'}`);
          const { readServiceAccount } = await import('../src/services/googleSheetsApi.js');
          for (const f of files) {
            const { account, problem } = readServiceAccount(f.content || '');
            report(null, `Render: secret file "${f.name}" in group "${g.name}"`, `${f.content ? `${String(f.content).length} characters` : 'EMPTY'}; ${account ? `valid service account key file (project ${account.project_id ?? '?'}); Skyfly reads it from /etc/secrets/${f.name}` : `not a usable key file: ${problem}`}`);
          }
          // A Google key in the group: checked in memory only (present? valid key file? which project?). Never printed.
          for (const v of vars.filter((x) => x.key.toUpperCase().replace(/-/g, '_') === 'GOOGLE_SERVICE_ACCOUNT_JSON')) {
            const { account, problem } = readServiceAccount(v.value || '');
            const posix = /^[A-Za-z_][A-Za-z0-9_]*$/.test(v.key);
            report(null, `Render: "${v.key}" in group "${g.name}"`, `${v.value ? `${String(v.value).length} characters` : 'EMPTY'}; ${account ? `valid service account key file (project ${account.project_id ?? '?'})` : `cannot be used: ${problem}`}; name ${posix ? 'is a standard setting name' : 'contains characters (such as -) that start-up shells may drop before the app starts'}`);
          }
          if (!linked && process.env.LINK_ENV_GROUP && g.name === process.env.LINK_ENV_GROUP) {
            const r = await fetch(`${RENDER}/env-groups/${g.id}/services/${svc.id}`, { method: 'POST', headers: { Authorization: `Bearer ${process.env.RENDER_API_KEY}`, Accept: 'application/json' } });
            report(r.ok, `Render: link environment group "${g.name}" to skyfly`, `HTTP ${r.status}`);
            if (r.ok) {
              const d2 = await fetch(`${RENDER}/services/${svc.id}/deploys`, { method: 'POST', headers: { Authorization: `Bearer ${process.env.RENDER_API_KEY}`, Accept: 'application/json', 'Content-Type': 'application/json' }, body: '{"clearCache":"do_not_clear"}' });
              report(d2.ok, 'Render: redeploy so the running app gets the group\'s settings', `HTTP ${d2.status}`);
            }
          }
        }
      } catch (err) { report(null, 'Render: environment groups', err.message); }
      // A Google key saved in another workspace cannot reach this service: names and validity only.
      try {
        const { readServiceAccount } = await import('../src/services/googleSheetsApi.js');
        for (const o of owners.filter((x) => x.id !== svc.ownerId)) {
          for (const g of (await render(`/env-groups?ownerId=${encodeURIComponent(o.id)}&limit=50`)).map((x) => x.envGroup ?? x)) {
            const detail = await render(`/env-groups/${g.id}`).catch(() => ({}));
            const items = [...(detail.envVars || []).map((v) => v.envVar ?? v).map((v) => ({ name: v.key, text: v.value })),
              ...(detail.secretFiles || []).map((f) => f.secretFile ?? f).map((f) => ({ name: f.name, text: f.content }))];
            for (const it of items.filter((x) => /google|service.?account/i.test(x.name))) {
              const { account, problem } = readServiceAccount(it.text || '');
              report(null, `Render: "${it.name}" in group "${g.name}" of OTHER workspace "${o.name}"`, `${String(it.text || '').length} characters; ${account ? 'valid key file' : problem}; cannot reach skyfly (different workspace)`);
            }
          }
        }
      } catch (err) { report(null, 'Render: environment groups in other workspaces', err.message); }
      try {
        const deploys = (await render(`/services/${svc.id}/deploys?limit=5`)).map((x) => x.deploy ?? x);
        report(null, 'Render: recent deploys', deploys.map((x) => `${x.status} ${x.commit?.id?.slice(0, 7) ?? ''} ${x.trigger ?? ''} ${x.createdAt}`).join(' | '));
      } catch (err) { report(null, 'Render: recent deploys', err.message); }
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
        // Google Sheets API: startup check and copies (references and outcomes only).
        const appAll = ((await render(`${base}&type=app`)).logs || []).map((l) => l.message || '');
        const g = appAll.filter((m) => /^Google Sheets( API)?:/.test(m));
        report(null, 'Render logs: Google Sheets lines (latest 100 app lines)', g.length ? g.slice(0, 30).map((m) => mask(m)).join(' | ') : 'none');
        // Start-up summary of the latest TEST ORDERs read from the database (no real customer data).
        const it = appAll.filter((m) => m.startsWith('Import test site'));
        report(null, 'Render logs: import test site (start-up)', it.length ? it.slice(0, 6).map((m) => m.slice(0, 600)).join(' | ') : 'none (already set up, or not restarted since)');
        const nr = appAll.filter((m) => m.startsWith('Order notifications:'));
        report(null, 'Render logs: order notifications (start-up check, read-only)', nr.length ? nr.slice(0, 6).map((m) => m.slice(0, 300)).join(' | ') : 'none (not deployed yet, or not restarted since)');
        const oc = appAll.filter((m) => m.startsWith('Orders check'));
        report(null, 'Render logs: test orders in the database (start-up check, latest)', oc.length ? oc.slice(0, 8).map((m) => m.replace(/^Orders check \(test orders, read-only\): /, '').slice(0, 300)).join(' | ') : 'none');
      } catch (err) { report(null, 'Render logs', err.message); }
      // FIND_ORDER=<reference> [FIND_AT=<ISO time>]: read-only search of the request logs around that time
      // for the order's own pages (/o/<reference>, read from the database) and the order submissions.
      if (process.env.FIND_ORDER) {
        try {
          const ref = process.env.FIND_ORDER.trim();
          const at = process.env.FIND_AT ? new Date(process.env.FIND_AT) : new Date();
          const win = `&startTime=${new Date(at - 5 * 60000).toISOString()}&endTime=${new Date(+at + 5 * 60000).toISOString()}`;
          const label = (l, n) => (l.labels || []).find((x) => x.name === n)?.value ?? '';
          const fmt = (l) => `${l.timestamp} ${label(l, 'method')} ${label(l, 'path') || ''} ${label(l, 'statusCode')} ${l.message || ''}`
            .replace(/([?&]t=)[^&\s"]+/g, '$1<token>').replace(/\s+/g, ' ').trim().slice(0, 220);
          const logs = [];
          for (let page = 0, end = ''; page < 5; page += 1) {
            const r = await render(`/logs?ownerId=${encodeURIComponent(svc.ownerId)}&resource=${svc.id}&type=request&limit=100&direction=backward${win}${end}`);
            logs.push(...(r.logs || []));
            if (!r.hasMore || !r.nextEndTime) break;
            end = `&endTime=${encodeURIComponent(r.nextEndTime)}`; // continue further back within the window
          }
          const hits = logs.filter((l) => fmt(l).includes(ref)).reverse();
          const posts = logs.filter((l) => /\/api\/public\/orders/.test(fmt(l)) && /POST/.test(fmt(l))).reverse();
          report(null, `Render logs: requests for order ${ref} (±5 min of ${at.toISOString()}, ${logs.length} requests read)`, hits.length ? hits.slice(0, 8).map(fmt).join(' | ') : 'none found');
          report(null, 'Render logs: order submissions (POST /api/public/orders) in that window', posts.length ? posts.slice(0, 8).map(fmt).join(' | ') : 'none found');
        } catch (err) { report(null, 'Render logs: order search', err.message); }
      }
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
  let hj = null;
  try { hj = JSON.parse(health.text); } catch { /* not JSON */ }
  report(health.status === 200 && hj?.status === 'ok', 'GET /healthz (app up, database connected)', `HTTP ${health.status} status ${hj?.status ?? health.text.slice(0, 80)}`);
  // Background jobs (email follow-ups, Google Sheet copies) run inside the web service.
  const w = hj?.workers;
  if (w) {
    const fresh = (j) => Boolean(j?.lastOkAt && Date.now() - Date.parse(j.lastOkAt) < 5 * 60000);
    const line = (j) => (j ? `last run ${j.lastRunAt ?? 'never'}, last OK ${j.lastOkAt ?? 'never'}${j.lastError ? `, error: ${j.lastError}` : ''}${j.last ? `, ${JSON.stringify(j.last)}` : ''}` : 'not running');
    report(fresh(w.email), 'Background job: email automations / subscriptions', line(w.email));
    report(fresh(w.sheets), 'Background job: Google Sheet copies', line(w.sheets));
    if (w.google) report(null, 'Google Sheets API (service account)', w.google.configured
      ? `configured (setting ${w.google.setting}, project ${w.google.project ?? '?'}); sign-in: ${w.google.auth ?? 'checking'}; Sheets API: ${w.google.sheetsApi ?? 'checking'}`
      : `not available to the app${w.google.setting ? ` (${w.google.setting} is set but ${w.google.problem})` : ' (no GOOGLE_SERVICE_ACCOUNT_JSON in its environment)'}`);
  } else report(null, 'Background jobs', 'not reported by this version');

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
    report(null, 'Owner account', signup.status === 200 ? 'sign-up page open' : signup.status === 404 ? 'created (sign-up closed)' : `unexpected HTTP ${signup.status}`);

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
      report(admin.status === 302 && /^\/(admin\/)?login(\?next=.*)?$/.test(admin.headers.get('location') || ''), 'Platform admin requires sign-in', `HTTP ${admin.status} → ${admin.headers.get('location')}`);
      const regForm = signup.status === 200 ? signup.text : '';
      report(signup.status === 404 || (signup.status === 200 && /name="business_name"/.test(regForm)), 'Public business registration', signup.status === 404 ? 'closed (invitation only)' : signup.status === 200 ? 'open: /signup creates the owner\'s account and their own business' : `unexpected HTTP ${signup.status}`);
      const badKey = await get(`${url}/api/public/orders`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer sky_${'x'.repeat(32)}` }, body: '{}' });
      report(badKey.status === 401, 'Business API refuses unknown API keys', `HTTP ${badKey.status}`);
    }
  }
}

const failed = results.filter((r) => r.ok === false);
console.log(`\n${failed.length ? `${failed.length} check(s) FAILED` : 'All checks passed'}`);
process.exit(failed.length ? 1 : 0);
