// The signup activation script against mock Cloudflare, Resend and Render APIs: a dry run changes
// nothing; applying creates the Turnstile widget, adds only missing DNS records, waits for Resend to
// verify the domain, sets the six Render settings on the skyfly service only, redeploys, and never
// prints a key or secret.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';

function mock() {
  const calls = []; const env = {}; let polls = 0; let widget = null;
  const dns = [{ type: 'MX', name: 'getskyfly.com', content: 'route1.mx.cloudflare.net' }];
  const server = createServer(async (req, res) => {
    let body = ''; for await (const c of req) body += c;
    const j = body ? JSON.parse(body) : null; const u = new URL(req.url, 'http://x'); const p = u.pathname;
    calls.push(`${req.method} ${p}`);
    const send = (o, s = 200) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    const cf = (result) => send({ success: true, result });
    if (p === '/cf/zones') return cf([{ id: 'z1', status: 'active', account: { id: 'a1', name: 'Skyfly' } }]);
    if (p === '/cf/accounts/a1/challenges/widgets' && req.method === 'GET') return cf(widget ? [widget] : []);
    if (p === '/cf/accounts/a1/challenges/widgets' && req.method === 'POST') { widget = { ...j, sitekey: '0xSITEKEY', secret: '0xTURNSTILE_SECRET_VALUE' }; return cf(widget); }
    if (p === '/cf/accounts/a1/challenges/widgets/0xSITEKEY' && req.method === 'GET') return cf(widget);
    if (p === '/cf/zones/z1/dns_records' && req.method === 'GET') return cf(dns);
    if (p === '/cf/zones/z1/dns_records' && req.method === 'POST') { dns.push(j); return cf(j); }
    if (p === '/rs/domains' && req.method === 'GET') return send({ data: [] });
    if (p === '/rs/domains' && req.method === 'POST') return send({ id: 'd1', name: j.name, status: 'not_started' });
    if (p === '/rs/domains/d1/verify') return send({ id: 'd1' });
    if (p === '/rs/domains/d1') { polls += 1; return send({ id: 'd1', status: polls > 3 ? 'verified' : 'pending', records: [
      { record: 'SPF', type: 'MX', name: 'send', value: 'feedback-smtp.eu-west-1.amazonses.com', priority: 10 },
      { record: 'SPF', type: 'TXT', name: 'send', value: '"v=spf1 include:amazonses.com ~all"' },
      { record: 'DKIM', type: 'TXT', name: 'resend._domainkey', value: 'p=MIGfMA0' }] }); }
    if (p === '/rn/owners') return send([{ owner: { id: 'o1' } }]);
    if (p === '/rn/services') return send([{ service: { id: 'srv-skyfly', name: 'skyfly' } }, { service: { id: 'srv-other', name: 'skyfly-other' } }]);
    if (p === '/rn/services/srv-skyfly/env-vars' && req.method === 'GET') return send(Object.keys(env).map((key) => ({ envVar: { key } })));
    const m = /^\/rn\/services\/(srv-[\w-]+)\/env-vars\/(\w+)$/.exec(p);
    if (m && req.method === 'PUT') { env[`${m[1]}:${m[2]}`] = j.value; return send({ key: m[2] }); }
    if (p === '/rn/services/srv-skyfly/deploys') return send({ id: 'dep-1' }, 201);
    send({ message: 'not mocked' }, 404);
  });
  return { server, calls, env, dns };
}
const run = (base, apply) => new Promise((resolve) => execFile('node', ['scripts/activate-signup.mjs'], { env: { ...process.env, ACTIVATE_TEST_API: base, APPLY: apply ? '1' : '', CLOUDFLARE_API_TOKEN: 'cf-token-value', RESEND_API_KEY: 're_resend_key_value', RENDER_API_KEY: 'rnd_render_key_value', GITHUB_ACTIONS: '' } }, (err, stdout, stderr) => resolve({ code: err?.code ?? 0, out: stdout + stderr })));

test('dry run changes nothing; apply sets everything on the skyfly service only, never printing secrets', async () => {
  const m = mock(); await new Promise((r) => m.server.listen(0, r)); const base = `http://127.0.0.1:${m.server.address().port}`;
  try {
    const dry = await run(base, false);
    assert.equal(dry.code, 0, dry.out);
    assert.match(dry.out, /Dry run only/);
    assert.ok(!m.calls.some((c) => !c.startsWith('GET')), `dry run wrote: ${m.calls.filter((c) => !c.startsWith('GET'))}`);
    const real = await run(base, true);
    assert.equal(real.code, 0, real.out);
    assert.match(real.out, /DONE {2}All six settings/);
    assert.deepEqual(m.env, {
      'srv-skyfly:TURNSTILE_SITE_KEY': '0xSITEKEY', 'srv-skyfly:TURNSTILE_SECRET_KEY': '0xTURNSTILE_SECRET_VALUE',
      'srv-skyfly:SKYFLY_NOTIFY_PROVIDER': 'resend', 'srv-skyfly:SKYFLY_NOTIFY_API_KEY': 're_resend_key_value',
      'srv-skyfly:SKYFLY_NOTIFY_FROM': 'no-reply@getskyfly.com', 'srv-skyfly:SKYFLY_NOTIFY_FROM_NAME': 'Skyfly' });
    // DNS: the three Resend records added; the existing root MX untouched.
    assert.deepEqual(m.dns.map((d) => `${d.type} ${d.name}`), ['MX getskyfly.com', 'MX send.getskyfly.com', 'TXT send.getskyfly.com', 'TXT resend._domainkey.getskyfly.com']);
    assert.ok(m.calls.includes('POST /rn/services/srv-skyfly/deploys'));
    for (const secret of ['0xTURNSTILE_SECRET_VALUE', 're_resend_key_value', 'cf-token-value', 'rnd_render_key_value']) assert.ok(!(dry.out + real.out).includes(secret), `printed ${secret}`);
    // Second run: nothing duplicated.
    const again = await run(base, true);
    assert.equal(again.code, 0, again.out);
    assert.equal(m.dns.length, 4);
    assert.match(again.out, /Turnstile widget "Skyfly signup" exists/);
  } finally { m.server.close(); }
});

test('missing secrets: blocked, nothing changed', async () => {
  const r = await new Promise((resolve) => execFile('node', ['scripts/activate-signup.mjs'], { env: { PATH: process.env.PATH } }, (err, stdout) => resolve({ code: err?.code, out: stdout })));
  assert.equal(r.code, 2);
  assert.match(r.out, /BLOCKED {2}Missing repository secret\(s\): CLOUDFLARE_API_TOKEN, RESEND_API_KEY, RENDER_API_KEY/);
});
