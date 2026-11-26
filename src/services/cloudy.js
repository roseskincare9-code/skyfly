// Cloudy, Skyfly's AI media buyer. Each call is built ONLY from the selected business's own data (its
// advertising profile, its own Meta account's live numbers, its creative library and its own conversation),
// loaded by business ID here, so one business's data can never reach another business's answer.
// Cloudy recommends and drafts; it never spends money, activates anything or changes live campaigns.
import { performance, listConnections } from './metaAds.js';
import { analystReady, latestAnalysis } from './analyst.js';

export class CloudyError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
// Cloudy answers with Claude (ANTHROPIC_API_KEY) when it is set, otherwise with ChatGPT (OPENAI_API_KEY, the
// same OpenAI settings as the analysis engine). Either key alone switches Cloudy on; with neither it is off.
export const cloudyProvider = (config) => (config.cloudy?.apiKey ? 'claude' : config.analyst?.apiKey ? 'chatgpt' : null);
export const cloudyReady = (config) => Boolean(cloudyProvider(config));
const OFF = 'Cloudy is not switched on yet: the server has no AI key (OPENAI_API_KEY or ANTHROPIC_API_KEY).';
// Network failures and timeouts become an honest Cloudy error (nothing is saved), never a crash page.
const reach = (provider, err) => new CloudyError(err?.name === 'TimeoutError' || err?.name === 'AbortError'
  ? `${provider} took too long to answer; nothing was saved. Try again.` : `Cloudy could not reach ${provider}; nothing was saved. Try again.`, 504);

export const OPERATING_RULES = `You are Cloudy, the AI media buyer inside Skyfly, working for ONE business (described below).
Operating rules:
- Use ONLY the data provided in this message. Never invent metrics, results, benchmarks, testimonials or account details. If data is missing (for example no Meta account connected, no purchases tracked, ROAS unavailable), say so plainly and say what is needed.
- Quote numbers exactly as given, with the account currency. Say which period they cover.
- Work on the SELECTED ad account only (selected_ad_account). Other connected accounts are listed by name only; never mix their data or suggest actions on them unless the owner switches accounts.
- Draft-first: you recommend and prepare drafts. You never claim anything is live, launched, paused or changed: only Meta's own status shown in the data counts. When asked what was done, answer from skyfly_record_of_changes_in_meta exactly as recorded (outcome failed or refused means it did NOT happen; give the recorded error). You cannot execute anything from this chat: changes are made only by the owner approving them in Skyfly (Approvals). Activation, budget increases and account-wide changes always need the business owner's approval in Skyfly.
- Never recommend spending above the business's stated daily budget without flagging it as a proposal for approval.
- Be practical and specific: what to keep, cut, test or create next, and why, in plain language for a busy business owner.
- If latest_performance_analysis is present, it is this business's primary performance analysis (by Skyfly's analysis engines): build on it and do not contradict it unless you point to specific figures in the data.
- Consider spend, results/purchases, CPA, ROAS (only if purchase value exists), CPM, CTR, CPC, frequency, creative fatigue, audience and location, landing page and tracking (pixel) quality.`;

async function context(pool, config, businessId) {
  const [{ rows: [b] }, { rows: [p] }, { rows: creatives }] = await Promise.all([
    pool.query('SELECT name, currency, website FROM businesses WHERE id = $1', [businessId]),
    pool.query('SELECT * FROM ad_profiles WHERE business_id = $1', [businessId]),
    pool.query('SELECT id, kind, name, mime, size_bytes, notes, ai_review FROM ad_creatives WHERE business_id = $1 ORDER BY id DESC LIMIT 40', [businessId]),
  ]);
  const { rows: products } = await pool.query('SELECT name, price_minor FROM products WHERE business_id = $1 AND active IS NOT FALSE ORDER BY sort_order NULLS LAST, id LIMIT 30', [businessId]).catch(() => ({ rows: [] }));
  const { rows: pages } = await pool.query("SELECT name, slug, status FROM landing_pages WHERE business_id = $1 AND status <> 'archived' ORDER BY id DESC LIMIT 10", [businessId]);
  // The business's SELECTED ad account is the one Cloudy works on (read once, used for every call below).
  const accounts = await listConnections(pool, businessId);
  const sel = accounts.find((a) => a.selected) ?? accounts[0] ?? null;
  // An account that is connected but whose token Meta no longer accepts (revoked, expired, password changed) is
  // described as such, so Cloudy tells the owner to RECONNECT it rather than to "connect a Meta account".
  const expired = sel?.token_expires_at && new Date(sel.token_expires_at) <= new Date();
  const perf = !sel ? { connected: false }
    : sel.status !== 'verified' || expired ? { connected: true, error: `Ad account act_${sel.ad_account_id} is connected but needs to be reconnected (${expired ? 'its Facebook Login access expired' : sel.last_error || 'Meta no longer accepts its token'}); no advertising data can be read until the owner reconnects it in Advertising Settings.` }
      : await performance(pool, config, businessId, 'last_7d', sel.ad_account_id);
  const today = perf.connected && !perf.error ? await performance(pool, config, businessId, 'today', sel.ad_account_id) : null;
  const latest = sel ? await latestAnalysis(pool, businessId, sel.ad_account_id) : null;
  // What Skyfly actually did in Meta for this business (builds, launches, approved actions) with the outcome
  // Skyfly verified by reading Meta back: Cloudy reports these as recorded, never as it imagines them.
  const [{ rows: builds }, { rows: actions }] = await Promise.all([
    pool.query(`SELECT b.status, b.ad_account_id, b.daily_budget_minor, b.error, b.launched_at, b.updated_at, b.steps, b.launch_result, i.title
      FROM ad_builds b JOIN ad_items i ON i.id = b.ad_item_id WHERE b.business_id = $1 ORDER BY b.id DESC LIMIT 5`, [businessId]),
    pool.query(`SELECT operation, object_level, object_id, ad_account_id, outcome, error, before_state, after_state, created_at
      FROM ad_action_log WHERE business_id = $1 ORDER BY id DESC LIMIT 10`, [businessId]),
  ]);
  const campaignOf = (b) => (b.launch_result?.after ?? []).find((x) => x.key === 'campaign') ?? null;
  return {
    skyfly_record_of_changes_in_meta: {
      note: 'Only these changes were made through Skyfly, with the outcome Skyfly verified in Meta. Anything not listed was not done by Skyfly.',
      campaign_builds: builds.map((b) => ({ plan: b.title, ad_account: b.ad_account_id, status: b.status, daily_budget: Number(b.daily_budget_minor) / 100,
        campaign_id: b.steps?.find?.((s) => s.key === 'campaign')?.meta_id ?? null, meta_status_after_launch: campaignOf(b) ? `${campaignOf(b).status}/${campaignOf(b).effective_status}` : null,
        launched_at: b.launched_at, error: b.error ?? null, updated_at: b.updated_at })),
      approved_actions: actions.map((a) => ({ operation: a.operation, level: a.object_level, object_id: a.object_id, ad_account: a.ad_account_id, outcome: a.outcome,
        error: a.error ?? null, before: a.before_state, after: a.after_state, at: a.created_at })),
    },
    ...(latest ? { latest_performance_analysis: { engine: latest.engine, dates: `${latest.scope.since} to ${latest.scope.until}`, data_fetched_at: latest.data_fetched_at, summary: latest.result.summary, priority_actions: latest.result.priority_actions } } : {}),
    business: { name: b.name, currency: b.currency, website: p?.website ?? b.website ?? null },
    profile: p ? Object.fromEntries(Object.entries(p).filter(([k, v]) => v != null && !['business_id', 'updated_at'].includes(k))) : 'not filled in yet',
    skyfly_products: products.map((x) => ({ name: x.name, price: Number(x.price_minor) / 100 })),
    skyfly_landing_pages: pages.map((x) => ({ name: x.name, url: `${config.publicBaseUrl ?? ''}/p/${x.slug}/`, status: x.status })),
    creative_library: creatives.map((c) => ({ id: c.id, kind: c.kind, name: c.name, notes: c.notes, review: c.ai_review?.slice(0, 400) ?? null })),
    selected_ad_account: sel ? { id: sel.ad_account_id, name: sel.ad_account_name, currency: sel.currency, facebook_page: sel.page_name, pixel: sel.pixel_id } : null,
    other_connected_ad_accounts: accounts.filter((a) => a !== sel).map((a) => ({ id: a.ad_account_id, name: a.ad_account_name })),
    meta_ads: perf.connected ? (perf.error ? { connected: true, error: perf.error } : { last_7_days: perf, today: today?.error ? { error: today.error } : today?.totals }) : 'No Meta ad account connected: no advertising data is available.',
  };
}

async function callClaude(config, { system, messages, maxTokens = 2500 }) {
  let res;
  try {
    res = await fetch(`${config.cloudy.apiBase}/v1/messages`, {
      method: 'POST', signal: AbortSignal.timeout(config.cloudy.timeoutMs ?? 120000),
      headers: { 'content-type': 'application/json', 'x-api-key': config.cloudy.apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: config.cloudy.model, max_tokens: maxTokens, system, messages }),
    });
  } catch (err) { throw reach('Claude', err); }
  const j = await res.json().catch(() => ({}));
  if (res.status === 401 || res.status === 403) throw new CloudyError('Anthropic refused the API key (ANTHROPIC_API_KEY is invalid or revoked).', 502);
  if (!res.ok) throw new CloudyError(`Cloudy could not answer (${j.error?.message ?? `HTTP ${res.status}`})`.slice(0, 240), 502);
  return (j.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n').trim();
}

// The same conversation through OpenAI's Responses API (plain text). Claude-style content blocks (text, base64
// image) are converted to OpenAI's input blocks, so Ask, briefs, drafts and image reviews work on either engine.
async function callChatGPT(config, { system, messages, maxTokens = 2500 }) {
  const a = config.analyst;
  const input = messages.map((m) => {
    if (typeof m.content === 'string') return { role: m.role, content: m.content };
    return { role: m.role, content: m.content.map((c) => (c.type === 'image'
      ? { type: 'input_image', image_url: `data:${c.source.media_type};base64,${c.source.data}` }
      : { type: m.role === 'assistant' ? 'output_text' : 'input_text', text: c.text })) };
  });
  let res;
  try {
    res = await fetch(`${a.apiBase}/v1/responses`, {
      method: 'POST', signal: AbortSignal.timeout(a.timeoutMs ?? 120000),
      headers: { 'content-type': 'application/json', authorization: `Bearer ${a.apiKey}` },
      body: JSON.stringify({
        model: a.model, instructions: system, input, store: false, max_output_tokens: Math.max(maxTokens * 4, 8000),
        ...(/^(gpt-5|o\d)/.test(a.model) ? { reasoning: { effort: a.reasoningEffort ?? 'medium' } } : {}),
      }),
    });
  } catch (err) { throw reach('ChatGPT', err); }
  const j = await res.json().catch(() => ({}));
  if (res.status === 401) throw new CloudyError('OpenAI refused the API key (OPENAI_API_KEY is invalid or revoked).', 502);
  if (res.status === 429) throw new CloudyError(/quota/i.test(j.error?.code ?? j.error?.message ?? '') ? 'The OpenAI account has run out of quota or credit.' : 'OpenAI is rate-limiting requests right now; try again in a minute.', 503);
  if (!res.ok) throw new CloudyError(`Cloudy could not answer (${String(j.error?.message ?? `HTTP ${res.status}`).slice(0, 200)})`, 502);
  const parts = (j.output ?? []).flatMap((o) => o.content ?? []);
  if (parts.some((c) => c.type === 'refusal')) throw new CloudyError('ChatGPT declined to answer this.', 502);
  const text = (j.output_text ?? parts.filter((c) => c.type === 'output_text').map((c) => c.text).join('')).trim();
  if (!text) throw new CloudyError(j.status === 'incomplete' ? 'ChatGPT\'s answer was cut short; nothing was saved. Try a shorter question.' : 'ChatGPT returned an empty answer; nothing was saved.', 502);
  return text;
}

async function callModel(config, args) {
  const provider = cloudyProvider(config);
  if (!provider) throw new CloudyError(OFF, 409);
  return provider === 'claude' ? callClaude(config, args) : callChatGPT(config, args);
}
const systemFor = (ctx) => `${OPERATING_RULES}\n\nBUSINESS DATA (JSON, this business only):\n${JSON.stringify(ctx).slice(0, 60000)}`;
const jsonFrom = (text) => {
  const m = text.match(/```(?:json)?\s*([\s\S]*?)```/) ?? [null, text];
  try { return JSON.parse(m[1]); } catch { return null; }
};

// The conversation panel: the question, answered from this business's data, saved for this business only.
export async function ask(pool, config, { businessId, userId, question }) {
  if (!cloudyReady(config)) throw new CloudyError(OFF, 409);
  const q = String(question ?? '').trim().slice(0, 2000);
  if (!q) throw new CloudyError('Type a question for Cloudy.');
  const ctx = await context(pool, config, businessId);
  const { rows: history } = await pool.query("SELECT role, content FROM ad_messages WHERE business_id = $1 AND topic = 'ask' ORDER BY id DESC LIMIT 10", [businessId]);
  const messages = [...history.reverse().map((m) => ({ role: m.role, content: m.content })), { role: 'user', content: q }];
  const answer = await callModel(config, { system: systemFor(ctx), messages });
  await pool.query("INSERT INTO ad_messages (business_id, user_id, role, content) VALUES ($1, $2, 'user', $3), ($1, NULL, 'assistant', $4)", [businessId, userId, q, answer]);
  return answer;
}

const TASKS = {
  audit: { kind: 'audit', title: 'Advertising account audit', prompt: 'Audit this business\'s advertising: account structure, campaign/ad set/ad performance (spend, results, CPA, ROAS if available, CPM, CTR, CPC, frequency), creative winners and losers, wasted spend, audience/location, tracking and landing page. Finish with a prioritised action list. Use markdown headings.' },
  recommendations: { kind: 'recommendation', title: 'Optimisation recommendations', json: true, prompt: 'Give 3 to 6 specific optimisation recommendations. Reply ONLY with JSON in a ```json block: {"items":[{"title":"","why":"","action":"","impact":"","needs_approval":true|false}]}.' },
  briefs: { kind: 'brief', title: 'Creative briefs', json: true, prompt: 'Decide what creative this business needs next and write 3 briefs. Reply ONLY with JSON in a ```json block: {"items":[{"title":"","objective":"","audience":"","angle":"","hook":"","format":"video|image","duration":"","script":"","scenes":[""],"voiceover":"","caption":"","headline":"","cta":"","notes":""}]}. Script, scenes and voiceover are required for video.' },
  campaign_draft: { kind: 'campaign_draft', title: 'Campaign draft', json: true, prompt: 'Prepare ONE campaign draft for approval within the stated daily budget. Reply ONLY with JSON in a ```json block: {"name":"","objective":"OUTCOME_SALES|OUTCOME_LEADS|OUTCOME_TRAFFIC","daily_budget":0,"locations":"","audience":"","placements":"","creatives":"(names from the creative library or briefs)","primary_text":"","headline":"","cta":"","landing_page":"","reasoning":"","test_plan":""}.' },
  report_daily: { kind: 'report', title: 'Daily advertising report', prompt: 'Write today\'s report (use the "today" data and the last 7 days for comparison): total spend, results/purchases, CPA, ROAS if available, best and worst campaigns and ads, creative insights, changes noticed, recommended next actions, new creatives needed. Use markdown.' },
  report_weekly: { kind: 'report', title: 'Weekly advertising report', prompt: 'Write the weekly report for the last 7 days: total spend, results/purchases, CPA, ROAS if available, best and worst campaigns and ads, creative insights, recommended next actions, new creatives needed. Use markdown.' },
};
export const TASK_NAMES = Object.keys(TASKS);
// Performance analysis (audits, recommendations, reports) is done in the Performance Analysis tab by the
// analysis engines (ChatGPT and/or Claude, on the same data), so there is one recommendation system and no
// duplicate AI spend. Cloudy keeps Ask, creative briefs, campaign drafts and creative review.
export const PERFORMANCE_TASKS = ['audit', 'recommendations', 'report_daily', 'report_weekly'];
export const cloudyHandles = (config, task) => !(PERFORMANCE_TASKS.includes(task) && (analystReady(config) || cloudyReady(config)));

// Audit / recommendations / briefs / campaign draft / report, saved as this business's items.
export async function generate(pool, config, { businessId, userId, task, note = '' }) {
  if (!cloudyReady(config)) throw new CloudyError(OFF, 409);
  const t = TASKS[task];
  if (!t) throw new CloudyError('Unknown task.', 404);
  if (!cloudyHandles(config, task)) throw new CloudyError('Performance analysis is done in the Performance Analysis tab (Analyze with ChatGPT or Claude).', 409);
  const ctx = await context(pool, config, businessId);
  const text = await callModel(config, { system: systemFor(ctx), messages: [{ role: 'user', content: `${t.prompt}${note ? `\nOwner's note: ${String(note).slice(0, 500)}` : ''}` }], maxTokens: 4000 });
  const parsed = t.json ? jsonFrom(text) : null;
  const body = parsed ?? { text };
  const basis = typeof ctx.meta_ads === 'string' ? 'No Meta account connected (profile and library only)'
    : ctx.meta_ads.error ? `Meta data unavailable: ${ctx.meta_ads.error}` : `Meta account ${ctx.meta_ads.last_7_days.account.id}, last 7 days and today`;
  const status = t.kind === 'campaign_draft' ? 'proposed' : t.kind === 'recommendation' ? 'proposed' : 'info';
  const title = t.kind === 'campaign_draft' && parsed?.name ? `Campaign draft: ${String(parsed.name).slice(0, 120)}` : t.title;
  const { rows: [item] } = await pool.query(
    'INSERT INTO ad_items (business_id, kind, title, body, status, data_basis, created_by, ad_account_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id',
    [businessId, t.kind, title, JSON.stringify(body), status, basis, userId, ctx.selected_ad_account?.id ?? null]);
  return item.id;
}

// Reviews one uploaded image (vision) or describes how to use a video, for this business only.
export async function reviewCreative(pool, config, { businessId, creativeId }) {
  if (!cloudyReady(config)) throw new CloudyError(OFF, 409);
  const { rows: [c] } = await pool.query('SELECT id, kind, name, mime, data, notes FROM ad_creatives WHERE id = $1 AND business_id = $2', [creativeId, businessId]);
  if (!c) throw new CloudyError('Creative not found.', 404);
  const ctx = await context(pool, config, businessId);
  const isImage = /^image\/(png|jpeg|webp|gif)$/.test(c.mime) && c.data.length <= 5 * 1024 * 1024;
  const content = [
    ...(isImage ? [{ type: 'image', source: { type: 'base64', media_type: c.mime, data: c.data.toString('base64') } }] : []),
    { type: 'text', text: `Review this ${c.kind} from the creative library: "${c.name}"${c.notes ? ` (owner's notes: ${c.notes})` : ''}.${isImage ? '' : ' You cannot see the file itself (only its name and notes): say so, and give a checklist for the owner to judge it.'} Say whether and how to use it in ads (which audience, placement, hook, caption, headline, CTA), and what to change. Keep it under 250 words.` },
  ];
  const text = await callModel(config, { system: systemFor(ctx), messages: [{ role: 'user', content }], maxTokens: 1200 });
  await pool.query('UPDATE ad_creatives SET ai_review = $3, ai_reviewed_at = now() WHERE id = $1 AND business_id = $2', [creativeId, businessId, text]);
  return text;
}
