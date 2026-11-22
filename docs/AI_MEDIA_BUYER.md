# AI Media Buyer: ChatGPT, Claude, actions and the WhatsApp Conversion Audit

Everything lives in each business's existing **AI Media Buyer** (no separate dashboard).

## Who does what

| | Needs | Does |
|---|---|---|
| **ChatGPT** (OpenAI) | `OPENAI_API_KEY` | Performance Analysis (primary), WhatsApp Conversion Audit (primary) |
| **Claude** (Anthropic) | `ANTHROPIC_API_KEY` | Performance Analysis (independently), WhatsApp audit second opinion |
| **Cloudy** assistant (Anthropic) | `ANTHROPIC_API_KEY` | Ask, creative briefs, campaign drafts, creative review |
| **Skyfly** | — | Reads Meta, computes every metric, rule-based checks, monitoring, consolidation, approvals, execution, verification, logs |

ChatGPT and Claude are independent: each works with only its own key. **Compare** sends the identical
request to both, shows both answers, then Skyfly's own consolidation (no third AI call): where they agree
(same kind of action on the same campaign / ad set / ad; the lower confidence is kept), where they point in
opposite directions (shown side by side, never merged), and what only one suggests. Audits, recommendations
and reports are done in the Performance Analysis tab only (Cloudy no longer duplicates them); Cloudy reads
the latest analysis so its answers build on it.

## Settings (Render → skyfly → Environment)

| Name | Default | |
|---|---|---|
| `OPENAI_API_KEY` | — | activates ChatGPT |
| `OPENAI_MODEL` | `gpt-5` | change to upgrade without a release |
| `OPENAI_REASONING_EFFORT` | `medium` | `minimal`, `low`, `medium`, `high` |
| `OPENAI_TIMEOUT_MS` / `ANTHROPIC_TIMEOUT_MS` | `120000` | |
| `OPENAI_DAILY_ANALYSES` | `30` | AI analyses per business per 24 h (a comparison counts as 2) |
| `ANTHROPIC_API_KEY` | — | activates Claude analysis and Cloudy |
| `CLAUDE_ANALYSIS_MODEL` | `CLOUDY_MODEL` or `claude-sonnet-5-5` | Claude's analysis model |

Keys stay on the server: never sent to the browser or stored in the database. Token usage per engine is
recorded per analysis and shown (30 days) in the Performance Analysis tab.

## Data and safety

- Analyses read Meta with GET requests only, for the business's own ad account (checked on the server; an
  account ID from the browser must be one of that business's connected accounts).
- Only aggregated advertising metrics, the business profile, products and order totals are sent. No customer
  names, emails, phone numbers, addresses or message text.
- Prompt injection: campaign names, ad copy, product names and notes are wrapped in `<campaign_data>` as
  untrusted data (a closing tag inside them is neutralised) and both engines are told never to follow
  instructions found there. Nothing an AI writes can execute anything: every change needs an approval.
- Answers must match a strict schema; anything about a campaign / ad set / ad not in the data is removed, and
  figures not found in the data are flagged on screen.
- One analysis per business per minute and a daily cap. Every run (including failures) is kept with its
  reason.

## Actions (ANALYZE → RECOMMEND → REVIEW → APPROVAL → EXECUTION → VERIFICATION → LOG)

From a recommendation, **Prepare this change in Meta** reads the campaign or ad set from Meta (it must belong
to the business's ad account) and creates one action showing: business, ad account, object, current
configuration, proposed configuration, current and proposed budget, expected consequences, AI reasoning and
risks. Supported: **pause** a campaign / ad set, and set its **daily budget** (±50% at most per change; not for
lifetime or campaign-level budgets set elsewhere).

On approval Skyfly claims that one action atomically (it cannot run twice), re-reads the object, and applies
nothing if Meta's state changed since preparation. It then writes the single change, reads the object back,
marks it executed only if Meta shows the change, and logs before / requested / after / outcome in the
action log (Approvals → Action center). Skyfly never activates, publishes, deletes, or changes targeting.
Writing needs the connected token to have `ads_management`.

## WhatsApp Conversion Audit

Tab **WhatsApp Conversion Audit**:

- Meta, for 7, 14 and 30 days (labelled): messaging campaigns' spend, impressions, clicks, conversations
  started, new contacts, customers sending 2+ / 3+ / 5+ messages (5+ shown as "not reported" when Meta omits
  it), blocks, purchases reported to Meta, optimisation goal, destination, audience, placements, ad copy; and
  website campaigns' cost per purchase for comparison.
- Skyfly checks: optimisation goal (conversations vs purchases), conversation depth, pre-filled keyword in the
  ad, price in the ad, cities in the ad vs cities targeted, Advantage+ audience, placement shares, purchases
  not reported to Meta, hand-entered orders. Each is labelled confirmed / likely / observed / not measurable.
- **Lead log** (CSV import, up to 5,000 rows): `lead_id` or `phone` (hashed with the business ID, never
  stored), `first_message_at`, `first_response_at`, `stage` (messaged, responded, engaged, price_sent,
  order_intent, ordered, paid, delivered, repeat, lost), optional `furthest_stage`, `agent`, `follow_ups`,
  `lost_reason`, `campaign`, `order_value`. Other columns (names, messages) are ignored. Gives response
  times, unanswered leads, follow-ups, stage drop-offs, lost reasons, per-agent figures (10+ leads only).
- ChatGPT investigates (Claude can give a second opinion): verdict, diagnosis (confirmed vs hypothesis),
  strategy, a test plan (budget, structure, creatives, opening message, success / stop-loss / scaling) and a
  WhatsApp sales system (opening, qualification, price, objections, COD, follow-ups, recovery, repeat).
- **Prepare a campaign draft from this plan** → Approvals → created in Meta as PAUSED only after approval.

## Monitoring

Off by default; thresholds and interval in the Performance Analysis tab. Rule-based (no AI cost), alerts only.

## Connecting ad accounts with Facebook Login

Owners can connect in two ways: **Connect with Facebook** (the official Meta OAuth flow) or a **System User token** pasted in Advertising Settings.

Facebook Login is switched on by Skyfly's own Meta app. One-time setup by the Skyfly team:

1. At developers.facebook.com, create an app of type **Business** and add the **Facebook Login for Business** product. In **Valid OAuth Redirect URIs**, add exactly `https://getskyfly.com/meta/oauth/callback`. Optionally, create a login configuration with the permissions below and note its ID.
2. On Render, open the **skyfly** service, then Environment, and set:
   - `META_APP_ID`
   - `META_APP_SECRET`
   - optionally `META_LOGIN_CONFIG_ID`
3. Permissions Skyfly requests:
   - `ads_management`
   - `ads_read`
   - `business_management`
   - `pages_show_list`
   - `pages_read_engagement`
   - `pages_manage_ads`
4. Access levels:
   - **Development mode:** only people with a role on the app can sign in, which is enough to test with your own accounts.
   - **Other businesses' accounts:** Meta requires **Business Verification** and **App Review** with **Advanced Access** for these permissions. Business owners outside your business cannot use the button until Meta approves them.
5. Leave "Require App Secret" off. Skyfly exchanges the code server-side with the secret and does not send an `appsecret_proof`.

How the flow is protected:
- The flow is started by the business owner only, never by a Super Admin visiting.
- The state is single-use, valid for 10 minutes, stored hashed, and bound to that user and business.
- The code is exchanged server-side for a long-lived token, which lasts about 60 days. Settings shows when it expires; reconnecting refreshes it.
- The token stays encrypted.
- Only accounts that Meta lists for that person can be connected, and only to that business.
