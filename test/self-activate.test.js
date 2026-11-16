// Public registration switches itself on from RESEND_API_KEY + CLOUDFLARE_API_TOKEN on the Skyfly
// service (no GitHub run): against stand-in Cloudflare and Resend APIs, start-up finds or creates the
// Turnstile widget, adds only missing DNS records, uses the sender only once Resend verifies the domain,
// never logs a key; with the launch checks passing, /signup then shows the real form (bot check and email
// confirmation still required). Without the keys nothing happens.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import request from 'supertest';
import { selfActivate } from '../src/services/selfActivate.js';
import { runLaunchChecks } from '../src/services/launchChecks.js';
import { setup, resetDatabase, openClientSignup } from './helpers.js';

function mockApis({ verifiedAfter = 0, widgetExists = false } = {}) {
  const calls = []; let polls = 0; const sent = [];
  let widget = widgetExists ? { name: 'Skyfly signup', sitekey: '0xSITE', mode: 'managed', domains: ['getskyfly.com'] } : null;
  const dns = [{ type: 'MX', name: 'getskyfly.com', content: 'route1.mx.cloudflare.net' }];
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const c of req) raw += c;
    let j = null; try { j = raw ? JSON.parse(raw) : null; } catch { /* form body */ } const p = new URL(req.url, 'http://x').pathname;
    calls.push(`${req.method} ${p} ${req.headers.authorization}`);
    const send = (o, s = 200) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    const cf = (result) => send({ success: true, result });
    if (p === '/cf/zones') return cf([{ id: 'z1', account: { id: 'a1' } }]);
    if (p === '/cf/accounts/a1/challenges/widgets' && req.method === 'GET') return cf(widget ? [widget] : []);
    if (p === '/cf/accounts/a1/challenges/widgets' && req.method === 'POST') { widget = { ...j, sitekey: '0xSITE', secret: '0xSECRET_VALUE' }; return cf(widget); }
    if (p === '/cf/accounts/a1/challenges/widgets/0xSITE' && req.method === 'PUT') { widget = { ...widget, ...j }; return cf(widget); }
    if (p === '/cf/accounts/a1/challenges/widgets/0xSITE') return cf({ ...widget, secret: '0xSECRET_VALUE' });
    if (p === '/cf/zones/z1/dns_records' && req.method === 'GET') return cf(dns);
    if (p === '/cf/zones/z1/dns_records' && req.method === 'POST') { dns.push(j); return cf(j); }
    if (p === '/rs/domains' && req.method === 'GET') return send({ data: [] });
    if (p === '/rs/domains' && req.method === 'POST') return send({ id: 'd1', name: j.name, status: 'not_started' });
    if (p === '/rs/domains/d1/verify') return send({ id: 'd1' });
    if (p === '/rs/domains/d1') { polls += 1; return send({ id: 'd1', status: polls > verifiedAfter ? 'verified' : 'pending', records: [
      { record: 'SPF', type: 'MX', name: 'send', value: 'feedback-smtp.eu-west-1.amazonses.com', priority: 10 },
      { record: 'DKIM', type: 'TXT', name: 'resend._domainkey', value: 'p=MIGf' }] }); }
    if (p === '/rs/emails') { sent.push(j); return send({ id: 'e1' }); }
    if (p === '/siteverify') return send({ success: false, 'error-codes': ['invalid-input-response'] });
    send({ message: 'not mocked' }, 404);
  });
  return { server, calls, dns, sent, get widget() { return widget; } };
}
const listen = async (m) => { await new Promise((r) => m.server.listen(0, r)); return `http://127.0.0.1:${m.server.address().port}`; };
const env = { RESEND_API_KEY: 're_test_value_123', CLOUDFLARE_API_TOKEN: 'cf_token_value_456' };
const quiet = () => { const lines = []; return { lines, log: (...a) => lines.push(a.join(' ')), error: (...a) => lines.push(a.join(' ')) }; };

const { pool, config, app } = setup({ requireEmailForSignup: true, requireCaptchaForSignup: true, requireLaunchChecks: true, notifyEmail: null, turnstile: null });
after(() => pool.end());

test('without the two keys nothing is called and nothing is switched on', async () => {
  const c = { turnstile: null, notifyEmail: null };
  const r = await selfActivate(c, { env: {}, api: { cf: 'http://127.0.0.1:9/cf', rs: 'http://127.0.0.1:9/rs' }, log: quiet() });
  assert.deepEqual([r.turnstile, r.email, c.turnstile, c.notifyEmail], ['no CLOUDFLARE_API_TOKEN', 'no RESEND_API_KEY', null, null]);
});

test('settings saved by hand win: nothing is looked up', async () => {
  const c = { turnstile: { siteKey: 'a', secretKey: 'b' }, notifyEmail: { apiKey: 'x', fromEmail: 'y' } };
  const r = await selfActivate(c, { env, api: { cf: 'http://127.0.0.1:9/cf', rs: 'http://127.0.0.1:9/rs' }, log: quiet() });
  assert.deepEqual([r.turnstile, r.email], ['configured', 'configured']);
});

test('creates the Turnstile widget, adds only missing DNS records, uses the verified sender; keys never logged', async () => {
  const m = mockApis(); const base = await listen(m);
  try {
    const c = { turnstile: null, notifyEmail: null, publicBaseUrl: 'https://getskyfly.com' }; const q = quiet();
    const r = await selfActivate(c, { env, api: { cf: `${base}/cf`, rs: `${base}/rs` }, log: q });
    assert.deepEqual([r.turnstile, r.email], ['activated', 'activated']);
    assert.deepEqual(c.turnstile, { siteKey: '0xSITE', secretKey: '0xSECRET_VALUE' });
    assert.deepEqual(c.notifyEmail, { provider: 'resend', apiKey: 're_test_value_123', fromEmail: 'no-reply@getskyfly.com', fromName: 'Skyfly' });
    assert.deepEqual(m.widget.domains, ['getskyfly.com', 'skyfly-gybf.onrender.com']);
    // Domain already verified on first look: no DNS written; the existing root MX untouched.
    assert.deepEqual(m.dns.map((d) => `${d.type} ${d.name}`), ['MX getskyfly.com']);
    assert.ok(m.calls.filter((x) => x.includes('/cf/')).every((x) => x.endsWith('Bearer cf_token_value_456')));
    assert.ok(m.calls.filter((x) => x.includes('/rs/')).every((x) => x.endsWith('Bearer re_test_value_123')));
    for (const secret of ['re_test_value_123', 'cf_token_value_456', '0xSECRET_VALUE']) assert.ok(!q.lines.join('\n').includes(secret), `${secret} logged`);
  } finally { m.server.close(); }
});

test('an unverified domain: DNS records added, sender switched on only once Resend verifies it', async () => {
  const m = mockApis({ verifiedAfter: 2, widgetExists: true }); const base = await listen(m);
  try {
    const c = { turnstile: null, notifyEmail: null }; let changed = 0;
    const r = await selfActivate(c, { env, api: { cf: `${base}/cf`, rs: `${base}/rs` }, log: quiet(), pollMs: 20, onChange: () => { changed += 1; } });
    assert.match(r.email, /waiting for Resend/);
    assert.equal(c.notifyEmail, null);
    assert.equal(c.turnstile.secretKey, '0xSECRET_VALUE');
    assert.deepEqual(m.dns.map((d) => `${d.type} ${d.name}`), ['MX getskyfly.com', 'MX send.getskyfly.com', 'TXT resend._domainkey.getskyfly.com']);
    for (let i = 0; i < 50 && !c.notifyEmail; i += 1) await new Promise((x) => setTimeout(x, 20));
    clearInterval(r.timer);
    assert.equal(c.notifyEmail?.fromEmail, 'no-reply@getskyfly.com');
    assert.equal(changed, 1);
  } finally { m.server.close(); }
});

test('production-style gate: /signup stays closed without the keys, opens with the real form once activated and checks pass', async () => {
  await resetDatabase(pool);
  await pool.query("INSERT INTO users (email, password_hash, name, is_platform_admin) VALUES ('owner@skyfly.test', 'x', 'Owner', true)");
  await openClientSignup(pool);
  config.signupFirstOnly = true;
  const closed = await request(app).get('/signup');
  assert.equal(closed.status, 404);
  assert.match(closed.text, /opens soon/i);
  const m = mockApis(); const base = await listen(m);
  try {
    await selfActivate(config, { env, api: { cf: `${base}/cf`, rs: `${base}/rs` }, log: quiet() });
    Object.assign(config, { emailApiBase: `${base}/rs`, turnstileVerifyUrl: `${base}/siteverify` });
    await runLaunchChecks(pool, config, quiet());
    const open = await request(app).get('/signup');
    assert.equal(open.status, 200, open.text.slice(0, 300));
    for (const f of ['name', 'business_name', 'email', 'password', 'confirm', 'accept_terms']) assert.match(open.text, new RegExp(`name="${f}"`));
    assert.match(open.text, /0xSITE/); // the Turnstile widget is on the form
    assert.doesNotMatch(open.text, /0xSECRET_VALUE/);
    assert.equal(m.sent.length, 1); // the real test send of the launch check
  } finally { m.server.close(); }
});
