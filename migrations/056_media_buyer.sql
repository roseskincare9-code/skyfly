-- AI Media Buyer (Cloudy): per-business advertising profile, the business's OWN Meta ad account
-- connection (token encrypted with SKYFLY_ENCRYPTION_KEY, never sent to the browser), creative library,
-- AI outputs (audits, recommendations, video briefs, campaign drafts, reports) with an approval status,
-- and the business's conversation with Cloudy. Every row belongs to exactly one business.
CREATE TABLE ad_profiles (
  business_id BIGINT PRIMARY KEY REFERENCES businesses(id) ON DELETE CASCADE,
  industry TEXT, website TEXT, offer TEXT, prices TEXT, locations TEXT, audience TEXT, customer_profile TEXT,
  goals TEXT, daily_budget_minor BIGINT CHECK (daily_budget_minor IS NULL OR daily_budget_minor >= 0),
  platforms TEXT, brand_description TEXT, brand_voice TEXT,
  approval_mode TEXT NOT NULL DEFAULT 'draft_first' CHECK (approval_mode IN ('draft_first')),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE ad_connections (
  business_id BIGINT PRIMARY KEY REFERENCES businesses(id) ON DELETE CASCADE,
  provider TEXT NOT NULL DEFAULT 'meta' CHECK (provider = 'meta'),
  ad_account_id TEXT NOT NULL CHECK (ad_account_id ~ '^[0-9]{5,20}$'),
  ad_account_name TEXT, currency TEXT, account_status INT,
  page_id TEXT, page_name TEXT, pixel_id TEXT, pixel_name TEXT,
  token_enc TEXT NOT NULL, token_hint TEXT,
  status TEXT NOT NULL CHECK (status IN ('verified', 'failed')),
  verified_at TIMESTAMPTZ, last_error TEXT,
  connected_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE ad_creatives (
  id BIGSERIAL PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('image', 'video', 'logo', 'document', 'reference')),
  name TEXT NOT NULL, mime TEXT NOT NULL, size_bytes BIGINT NOT NULL, data BYTEA NOT NULL,
  notes TEXT, ai_review TEXT, ai_reviewed_at TIMESTAMPTZ,
  created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ad_creatives_business ON ad_creatives (business_id, created_at DESC);

CREATE TABLE ad_items (
  id BIGSERIAL PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('audit', 'recommendation', 'brief', 'campaign_draft', 'report')),
  title TEXT NOT NULL, body JSONB NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'approved', 'rejected', 'executed', 'failed', 'info')),
  data_basis TEXT, meta_result JSONB,
  created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  decided_by BIGINT REFERENCES users(id) ON DELETE SET NULL, decided_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ad_items_business ON ad_items (business_id, kind, created_at DESC);

CREATE TABLE ad_messages (
  id BIGSERIAL PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ad_messages_business ON ad_messages (business_id, created_at DESC);
