// Cloudy, Skyfly's AI media buyer. Each call is built ONLY from the selected business's own data (its
// advertising profile, its own Meta account's live numbers, its creative library and its own conversation),
// loaded by business ID here, so one business's data can never reach another business's answer.
// Cloudy recommends and drafts; it never spends money, activates anything or changes live campaigns.
import { performance, listConnections } from './metaAds.js';
import { analystReady, latestAnalysis } from './analyst.js';

export class CloudyError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
export const cloudyReady = (config) => Boolean(config.cloudy?.apiKey);

export const OPERATING_RULES = `You are Cloudy, the AI media buyer inside Skyfly, working for ONE business (described below).
Operating rules:
- Use ONLY the data provided in this message. Never invent metrics, results, benchmarks, testimonials or account details. If data is missing (for example no Meta account connected, no purchases tracked, ROAS unavailable), say so plainly and say what is needed.
- Quote numbers exactly as given, with the account currency. Say which period they cover.
- Work on the SELECTED ad account only (selected_ad_account). Other connected accounts are listed by name only; never mix their data or suggest actions on them unless the owner switches accounts.
- Draft-first: you recommend and prepare drafts. You never claim anything is live, launched, paused or changed: only Meta's own status shown in the data counts. Activation, budget increases and account-wide changes always need the business owner's approval in Skyfly.
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
  const perf = sel ? await performance(pool, config, businessId, 'last_7d', sel.ad_account_id) : { connected: false };
  const today = perf.connected && !perf.error ? await performance(pool, config, businessId, 'today', sel.ad_account_id) : null;
  const latest = sel ? await latestAnalysis(pool, businessId, sel.ad_account_id) : null;
  return {
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
  if (!cloudyReady(config)) throw new CloudyError('Cloudy is not switched on yet: ANTHROPIC_API_KEY is not set on the server.', 409);
  const res = await fetch(`${config.cloudy.apiBase}/v1/messages`, {
    method: 'POST', signal: AbortSignal.timeout(120000),
    headers: { 'content-type': 'application/json', 'x-api-key': config.cloudy.apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: config.cloudy.model, max_tokens: maxTokens, system, messages }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new CloudyError(`Cloudy could not answer (${j.error?.message ?? `HTTP ${res.status}`})`.slice(0, 240), 502);
  return (j.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n').trim();
}
const systemFor = (ctx) => `${OPERATING_RULES}\n\nBUSINESS DATA (JSON, this business only):\n${JSON.stringify(ctx).slice(0, 60000)}`;
const jsonFrom = (text) => {
  const m = text.match(/```(?:json)?\s*([\s\S]*?)```/) ?? [null, text];
  try { return JSON.parse(m[1]); } catch { return null; }
};

// The conversation panel: the question, answered from this business's data, saved for this business only.
export async function ask(pool, config, { businessId, userId, question }) {
  if (!cloudyReady(config)) throw new CloudyError('Cloudy is not switched on yet: ANTHROPIC_API_KEY is not set on the server.', 409);
  const q = String(question ?? '').trim().slice(0, 2000);
  if (!q) throw new CloudyError('Type a question for Cloudy.');
  const ctx = await context(pool, config, businessId);
  const { rows: history } = await pool.query('SELECT role, content FROM ad_messages WHERE business_id = $1 ORDER BY id DESC LIMIT 10', [businessId]);
  const messages = [...history.reverse().map((m) => ({ role: m.role, content: m.content })), { role: 'user', content: q }];
  const answer = await callClaude(config, { system: systemFor(ctx), messages });
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
  if (!cloudyReady(config)) throw new CloudyError('Cloudy is not switched on yet: ANTHROPIC_API_KEY is not set on the server.', 409);
  const t = TASKS[task];
  if (!t) throw new CloudyError('Unknown task.', 404);
  if (!cloudyHandles(config, task)) throw new CloudyError('Performance analysis is done in the Performance Analysis tab (Analyze with ChatGPT or Claude).', 409);
  const ctx = await context(pool, config, businessId);
  const text = await callClaude(config, { system: systemFor(ctx), messages: [{ role: 'user', content: `${t.prompt}${note ? `\nOwner's note: ${String(note).slice(0, 500)}` : ''}` }], maxTokens: 4000 });
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
  if (!cloudyReady(config)) throw new CloudyError('Cloudy is not switched on yet: ANTHROPIC_API_KEY is not set on the server.', 409);
  const { rows: [c] } = await pool.query('SELECT id, kind, name, mime, data, notes FROM ad_creatives WHERE id = $1 AND business_id = $2', [creativeId, businessId]);
  if (!c) throw new CloudyError('Creative not found.', 404);
  const ctx = await context(pool, config, businessId);
  const isImage = /^image\/(png|jpeg|webp|gif)$/.test(c.mime) && c.data.length <= 5 * 1024 * 1024;
  const content = [
    ...(isImage ? [{ type: 'image', source: { type: 'base64', media_type: c.mime, data: c.data.toString('base64') } }] : []),
    { type: 'text', text: `Review this ${c.kind} from the creative library: "${c.name}"${c.notes ? ` (owner's notes: ${c.notes})` : ''}.${isImage ? '' : ' You cannot see the file itself (only its name and notes): say so, and give a checklist for the owner to judge it.'} Say whether and how to use it in ads (which audience, placement, hook, caption, headline, CTA), and what to change. Keep it under 250 words.` },
  ];
  const text = await callClaude(config, { system: systemFor(ctx), messages: [{ role: 'user', content }], maxTokens: 1200 });
  await pool.query('UPDATE ad_creatives SET ai_review = $3, ai_reviewed_at = now() WHERE id = $1 AND business_id = $2', [creativeId, businessId, text]);
  return text;
}
