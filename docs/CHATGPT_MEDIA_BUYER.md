# ChatGPT performance analyst (AI Media Buyer)

ChatGPT is the AI Media Buyer's performance analyst. It reads a business's own Meta ad account data and
explains what is working, what is failing, what to change and why. It lives in the existing AI Media Buyer
(**Performance Analysis** tab of each business); there is no separate dashboard.

## Who does what

| | ChatGPT (OpenAI) | Cloudy (Anthropic) |
|---|---|---|
| Performance analysis, audits, reports, optimisation recommendations | **Yes** (when `OPENAI_API_KEY` is set) | Only while ChatGPT is off |
| Ask (conversation), creative briefs, campaign drafts, creative review | No | Yes |

Cloudy reads the latest ChatGPT analysis for the same ad account, so the two do not contradict each other.
When ChatGPT is on, Cloudy's audit / recommendations / report buttons are replaced by **Analyze my
campaigns**, so the same analysis is never paid for twice.

## Activation (one step)

On the Render service **skyfly** → *Environment*, add:

| Name | Value | Required |
|---|---|---|
| `OPENAI_API_KEY` | An OpenAI API key (platform.openai.com → API keys) | **yes** |
| `OPENAI_MODEL` | Model name, default `gpt-5`; change it to upgrade without a new release | no |
| `OPENAI_REASONING_EFFORT` | `minimal`, `low`, `medium` (default) or `high` | no |
| `OPENAI_TIMEOUT_MS` | Default `120000` | no |
| `OPENAI_DAILY_ANALYSES` | Analyses per business per 24 hours, default `30` | no |

Save and deploy. The key stays on the server: it is never sent to the browser or stored in the database.
The deploy check (`Verify deployment` workflow) reports whether `OPENAI_API_KEY` is set (name only).

## What one analysis does

1. Reads fresh data from Meta (GET requests only) for the selected business's chosen ad account: campaigns,
   ad sets (with a targeting summary), ads (with creative text), insights at each level for the date range and
   for the equal period before it, and when the pixel last fired.
2. Skyfly computes every metric itself: spend, impressions, reach, frequency, clicks, link CTR, CPC, CPM,
   purchases, CPA, ROAS (only when purchase value is tracked), conversion rate, landing-page conversion rate.
3. Runs rule-based checks (spend without conversions, CPA over the limit, CTR decline, CPA rising, frequency,
   tracking gaps, opportunities, too little data).
4. Adds the business profile, products and Skyfly's real-order totals by product for the same dates.
   **No customer names, emails, phones or addresses are sent.**
5. Sends this to the OpenAI Responses API with a strict JSON schema (`store: false`).
6. Checks the answer: right shape; every campaign, ad set or ad it mentions must exist in the data (otherwise
   removed); every figure it quotes must match the data (otherwise flagged on screen).
7. Shows the report with the date and time the data was fetched; analyses older than 6 hours are labelled
   as not current.

Scope: ad account, date range (presets or custom, up to 90 days), one campaign, product focus (Meta does not
attribute purchases to products, so this adds Skyfly's own order totals for context only).

## Safety

- Nothing is changed in Meta by an analysis, a recommendation or monitoring.
- A recommendation that would change a campaign (pause, budget, structure) can be sent to **Approvals**.
  Approving it records the owner's decision; Skyfly does not carry it out. The owner applies it in Ads
  Manager and runs a new analysis to verify. Campaign drafts (Cloudy) are still created only as **PAUSED**.
- Each analysis is limited to the business's own data and one of its own ad accounts. One analysis per
  business per minute; a daily cap per business.

## Monitoring

Off by default. In the Performance Analysis tab the owner sets thresholds (CPA limit, spend without
conversions, CTR drop %, frequency) and an interval (6, 12 or 24 hours). The background worker checks the
selected ad account's last 7 days and raises alerts (once per kind, item and day). Monitoring is rule-based
(no AI cost) and never pauses, edits or spends.

## Failures

Invalid key, rate limit (retried once), quota exhausted, timeout, server error (retried once), refusal,
cut-off answer and malformed or off-schema answers each give a clear message. The failed run is listed
with its reason, and nothing is saved as a result or changed in Meta.
