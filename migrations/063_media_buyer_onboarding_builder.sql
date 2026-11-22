-- AI Media Buyer, third step: conversational onboarding, connection health, full campaign builds in Meta
-- (campaign → ad sets → images → creatives → ads, all PAUSED), launch only after explicit authorization,
-- an approved daily spending limit, and scheduled AI reviews. Every row belongs to one business.

-- More of the business profile, gathered by the onboarding conversation.
ALTER TABLE ad_profiles
  ADD COLUMN business_location TEXT, ADD COLUMN fulfilment TEXT, ADD COLUMN payment_methods TEXT,
  ADD COLUMN social_accounts TEXT, ADD COLUMN constraints TEXT,
  -- The most the owner has authorised Skyfly-built campaigns to spend per day in total (minor units).
  ADD COLUMN approved_daily_limit_minor BIGINT CHECK (approved_daily_limit_minor IS NULL OR approved_daily_limit_minor > 0);

-- Where the business is in onboarding, and the automatic analysis → plan workflow it triggers.
CREATE TABLE ad_onboarding (
  business_id BIGINT PRIMARY KEY REFERENCES businesses(id) ON DELETE CASCADE,
  completed_at TIMESTAMPTZ,
  auto_status TEXT NOT NULL DEFAULT 'idle' CHECK (auto_status IN ('idle', 'running', 'done', 'failed', 'waiting')),
  auto_detail TEXT,
  analysis_id BIGINT REFERENCES ad_analyses(id) ON DELETE SET NULL,
  plan_item_id BIGINT REFERENCES ad_items(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Conversations are kept per topic (the Ask panel and the onboarding conversation).
ALTER TABLE ad_messages ADD COLUMN topic TEXT NOT NULL DEFAULT 'ask' CHECK (topic IN ('ask', 'onboarding'));

-- What the connected token can do, as Meta reported it at the last check.
ALTER TABLE ad_connections ADD COLUMN health JSONB, ADD COLUMN health_checked_at TIMESTAMPTZ;

-- One build of a campaign plan in Meta: each step (campaign, ad set, image, creative, ad) with its state and
-- the ID Meta returned, so a retry resumes instead of creating duplicates; then the launch, if authorised.
CREATE TABLE ad_builds (
  id BIGSERIAL PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  ad_item_id BIGINT NOT NULL REFERENCES ad_items(id) ON DELETE CASCADE,
  ad_account_id TEXT NOT NULL CHECK (ad_account_id ~ '^[0-9]{5,20}$'),
  tag TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('building', 'built', 'failed', 'launching', 'launched', 'launch_failed')),
  steps JSONB NOT NULL DEFAULT '[]',
  error TEXT,
  daily_budget_minor BIGINT,
  launched_at TIMESTAMPTZ, launched_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  launch_result JSONB,
  created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, ad_item_id)
);
CREATE INDEX ad_builds_business ON ad_builds (business_id, created_at DESC);

-- Scheduled AI review (in addition to rule-based monitoring): every N days, an analysis by the chosen engine.
ALTER TABLE ad_monitor_settings ADD COLUMN ai_review_days INT CHECK (ai_review_days IS NULL OR ai_review_days IN (1, 3, 7)),
  ADD COLUMN ai_engine TEXT NOT NULL DEFAULT 'chatgpt' CHECK (ai_engine IN ('chatgpt', 'claude')), ADD COLUMN last_ai_review_at TIMESTAMPTZ;
