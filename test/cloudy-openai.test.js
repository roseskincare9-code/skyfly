// Cloudy (Ask, creative briefs) with ChatGPT when only OPENAI_API_KEY is set, against a stand-in OpenAI
// Responses API: switched on by either key, answers built from THIS business's data only, saved for this
// business only, honest errors (rejected key, timeout) with nothing saved, and no key in any page.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { setup, resetDatabase, csrfToken, signUp, openClientSignup } from './helpers.js';

const KEY = `sk-proj-${'c'.repeat(40)}`;
const ai = { requests: [], mode: 'ok' };
const server = createServer(async (req, res) => {
  let raw = ''; for await (const c of req) raw += c;
  const body = JSON.parse(raw || '{}');
  ai.requests.push({ path: req.url, auth: req.headers.authorization, body });
  const send = (o, s = 200) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (ai.mode === 'badkey') return send({ error: { message: 'Incorrect API key provided' } }, 401);
  if (ai.mode === 'slow') return setTimeout(() => send({ output_text: 'late' }), 3000);
  const asksBriefs = /creative briefs|Decide what creative/.test(JSON.stringify(body.input));
  const text = asksBriefs ? '```json\n{"items":[{"title":"UGC unboxing","objective":"sales","audience":"Lagos women 25-45","angle":"size","hook":"1kg?","format":"video","duration":"15s","script":"...","scenes":["a"],"voiceover":"...","caption":"...","headline":"1KG soap","cta":"ORDER NOW","notes":""}]}\n```'
    : 'Your Halfcast 1kg at ₦26,500 is your main offer. No Meta ad account is connected yet, so I have no ad results to judge.';
  send({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text }] }], usage: { input_tokens: 10, output_tokens: 10 } });
});
await new Promise((r) => server.listen(0, r));

const analyst = { apiKey: KEY, model: 'gpt-test', apiBase: `http://127.0.0.1:${server.address().port}`, timeoutMs: 1000, dailyLimit: 50 };
const encryptionKey = randomBytes(32);
const withOpenAI = setup({ encryptionKey, analyst, cloudy: null });
const noAI = setup({ encryptionKey, analyst: null, cloudy: null });
const { pool } = withOpenAI;
let owner; let other; let A; let B;
const mb = (b) => `/businesses/${b}/media-buyer`;
const post = async (agent, path, form = {}) => { const _csrf = await csrfToken(agent, `/businesses/${path.match(/\/businesses\/(\d+)/)[1]}/subscription`); return agent.post(path).type('form').send({ _csrf, ...form }); };

before(async () => {
  await resetDatabase(pool);
  await signUp(withOpenAI.app, { name: 'Founder', email: 'founder@skyfly.test' });
  await openClientSignup(pool);
  owner = await signUp(withOpenAI.app, { name: 'Ada', email: 'ada@larose.test', business: 'Larose Test' });
  other = await signUp(withOpenAI.app, { name: 'Bo', email: 'bo@other.test', business: 'Other Shop' });
  [A, B] = await Promise.all(['Larose Test', 'Other Shop'].map(async (n) => (await pool.query('SELECT id FROM businesses WHERE name = $1', [n])).rows[0].id));
  await pool.query("INSERT INTO ad_profiles (business_id, offer, prices) VALUES ($1, 'Halfcast Super Fort Herbal Soap 1kg', '1kg ₦26,500'), ($2, 'SECRET-OTHER-OFFER', 'SECRET-OTHER-PRICE')", [A, B]);
});
after(async () => { server.close(); await pool.end(); await noAI.pool.end(); });

test('with only OPENAI_API_KEY, Ask Cloudy is enabled and says it runs on ChatGPT; no Meta account is needed', async () => {
  const page = await owner.get(mb(A)).expect(200);
  assert.match(page.text, /data-cloudy-status>on \(ChatGPT\)/);
  assert.doesNotMatch(page.text, /data-ai-off/);
  assert.match(page.text, /<input name="question" required maxlength="2000"[^>]*style="flex:1;min-width:220px" >/); // not disabled
  assert.ok(!page.text.includes(KEY));
});

test('a real-shaped question goes to OpenAI with THIS business\'s data only; the answer is shown and saved for this business', async () => {
  ai.requests.length = 0;
  const r = await post(owner, `${mb(A)}/ask`, { question: 'What should I advertise first?' });
  assert.equal(r.status, 200, r.text.slice(0, 300));
  assert.match(r.text, /Your Halfcast 1kg at ₦26,500 is your main offer/);
  const q = ai.requests[0];
  assert.equal(q.path, '/v1/responses'); assert.equal(q.auth, `Bearer ${KEY}`); assert.equal(q.body.model, 'gpt-test');
  assert.match(q.body.instructions, /You are Cloudy/); assert.match(q.body.instructions, /Halfcast Super Fort Herbal Soap 1kg/);
  assert.doesNotMatch(q.body.instructions, /SECRET-OTHER/);
  assert.match(q.body.instructions, /No Meta ad account connected/);
  assert.deepEqual(q.body.input.at(-1), { role: 'user', content: 'What should I advertise first?' });
  const { rows } = await pool.query("SELECT business_id, role FROM ad_messages WHERE topic = 'ask' ORDER BY id");
  assert.deepEqual(rows.map((x) => [Number(x.business_id), x.role]), [[Number(A), 'user'], [Number(A), 'assistant']]);
  // The other business sees none of it.
  assert.doesNotMatch((await other.get(mb(B)).expect(200)).text, /main offer|What should I advertise first/);
});

test('creative briefs also work on ChatGPT and are saved for this business', async () => {
  const r = await post(owner, `${mb(A)}/generate/briefs`);
  assert.equal(r.status, 302, r.text.slice(0, 300));
  const { rows: [item] } = await pool.query("SELECT business_id, kind, body FROM ad_items WHERE kind = 'brief' ORDER BY id DESC LIMIT 1");
  assert.equal(Number(item.business_id), Number(A)); assert.equal(item.body.items[0].title, 'UGC unboxing');
});

test('a rejected key or a timeout gives an honest error and saves nothing', async () => {
  const before = (await pool.query('SELECT count(*)::int AS n FROM ad_messages')).rows[0].n;
  ai.mode = 'badkey';
  let r = await post(owner, `${mb(A)}/ask`, { question: 'Anything?' });
  assert.equal(r.status, 502); assert.match(r.text, /OpenAI refused the API key \(OPENAI_API_KEY is invalid or revoked\)/);
  ai.mode = 'slow';
  r = await post(owner, `${mb(A)}/ask`, { question: 'Anything?' });
  assert.equal(r.status, 504); assert.match(r.text, /ChatGPT took too long to answer; nothing was saved/);
  ai.mode = 'ok';
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM ad_messages')).rows[0].n, before);
});

test('with no AI key at all, Ask is disabled, says exactly which key the server needs, and the server refuses', async () => {
  const agent = request.agent(noAI.app);
  const _csrf = await csrfToken(agent, '/login');
  await agent.post('/login').type('form').send({ _csrf, email: 'ada@larose.test', password: 'correct-horse-battery' }).expect(302);
  const page = await agent.get(mb(A)).expect(200);
  assert.match(page.text, /data-ai-off>Cloudy's AI answers are not switched on yet: the Skyfly server has no AI key \(OPENAI_API_KEY for ChatGPT, or ANTHROPIC_API_KEY for Claude\)/);
  assert.match(page.text, /data-cloudy-status>off \(OPENAI_API_KEY or ANTHROPIC_API_KEY\)/);
  const r = await post(agent, `${mb(A)}/ask`, { question: 'Hello?' });
  assert.equal(r.status, 409); assert.match(r.text, /Cloudy is not switched on yet: the server has no AI key/);
});

test('an ad account whose token Meta rejected is described to Cloudy as "connected, needs reconnecting", not as "no account"', async () => {
  await pool.query("INSERT INTO ad_connections (business_id, ad_account_id, ad_account_name, token_enc, status, last_error, selected) VALUES ($1, '555666777', 'Larose Ads', 'enc', 'failed', 'Meta: Error validating access token (code 190)', true)", [A]);
  ai.requests.length = 0;
  const r = await post(owner, `${mb(A)}/ask`, { question: 'How are my ads doing?' });
  assert.equal(r.status, 200, r.text.slice(0, 300));
  const sys = ai.requests[0].body.instructions;
  assert.match(sys, /act_555666777 is connected but needs to be reconnected \(Meta: Error validating access token \(code 190\)\)/);
  assert.doesNotMatch(sys, /No Meta ad account connected/);
  await pool.query("UPDATE ad_connections SET status = 'verified', last_error = NULL, token_expires_at = now() - interval '1 day' WHERE business_id = $1", [A]);
  ai.requests.length = 0;
  await post(owner, `${mb(A)}/ask`, { question: 'And now?' });
  assert.match(ai.requests[0].body.instructions, /needs to be reconnected \(its Facebook Login access expired\)/);
  await pool.query('DELETE FROM ad_connections WHERE business_id = $1', [A]);
});

test('Cloudy is given Skyfly\'s verified record of changes (a failed action stays failed), for this business only', async () => {
  await pool.query(`INSERT INTO ad_action_log (business_id, ad_account_id, operation, object_level, object_id, requested, outcome, error)
    VALUES ($1, '555666777', 'pause', 'campaign', '900001', '{"status":"PAUSED"}', 'failed', 'Meta refused the change: (#200) permission'),
           ($2, '444555666', 'pause', 'campaign', '900002', '{"status":"PAUSED"}', 'executed', NULL)`, [A, B]);
  ai.requests.length = 0;
  await post(owner, `${mb(A)}/ask`, { question: 'Did you pause my campaign?' });
  const sys = ai.requests[0].body.instructions;
  assert.match(sys, /answer from skyfly_record_of_changes_in_meta exactly as recorded/);
  assert.match(sys, /"object_id":"900001"[^}]*"outcome":"failed","error":"Meta refused the change: \(#200\) permission"/);
  assert.doesNotMatch(sys, /900002/, 'another business\'s action is never included');
});
