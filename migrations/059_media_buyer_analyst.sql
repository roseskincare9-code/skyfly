-- ChatGPT performance analysis inside the AI Media Buyer (each business's own Meta ad account), plus
-- rule-based campaign monitoring. Analysis and monitoring only READ Meta; nothing here changes campaigns,
-- budgets or ads. Every row belongs to one business.

-- One on-demand (or monitoring) analysis: the scope asked for, the metrics Skyfly computed from Meta (no
-- customer data), the rule-based signals, and ChatGPT's structured answer.
CREATE TABLE ad_analyses (
  id BIGSERIAL PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  ad_account_id TEXT NOT NULL CHECK (ad_account_id ~ '^[0-9]{5,20}$'),
  scope JSONB NOT NULL DEFAULT '{}',
  data JSONB NOT NULL DEFAULT '{}',
  data_fetched_at TIMESTAMPTZ,
  result JSONB,
  model TEXT,
  status TEXT NOT NULL CHECK (status IN ('ok', 'failed')),
  error TEXT,
  created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ad_analyses_business ON ad_analyses (business_id, created_at DESC);

-- Monitoring settings per business (off until the owner switches it on). Thresholds in the ad account's
-- currency, in minor units (kobo / cents).
CREATE TABLE ad_monitor_settings (
  business_id BIGINT PRIMARY KEY REFERENCES businesses(id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT false,
  cpa_threshold_minor BIGINT CHECK (cpa_threshold_minor IS NULL OR cpa_threshold_minor > 0),
  no_conversion_spend_minor BIGINT CHECK (no_conversion_spend_minor IS NULL OR no_conversion_spend_minor > 0),
  ctr_drop_pct INT NOT NULL DEFAULT 30 CHECK (ctr_drop_pct BETWEEN 5 AND 90),
  frequency_max NUMERIC(4, 1) NOT NULL DEFAULT 3.5 CHECK (frequency_max BETWEEN 1 AND 20),
  interval_hours INT NOT NULL DEFAULT 24 CHECK (interval_hours IN (6, 12, 24)),
  last_run_at TIMESTAMPTZ,
  last_error TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Alerts found by monitoring (read-only findings with a suggested next step). One per kind, entity and day.
CREATE TABLE ad_alerts (
  id BIGSERIAL PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  ad_account_id TEXT NOT NULL CHECK (ad_account_id ~ '^[0-9]{5,20}$'),
  kind TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('high', 'medium', 'low', 'opportunity')),
  entity_level TEXT, entity_id TEXT, entity_name TEXT,
  message TEXT NOT NULL,
  suggestion TEXT,
  metrics JSONB NOT NULL DEFAULT '{}',
  dedupe_key TEXT NOT NULL,
  dismissed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, dedupe_key)
);
CREATE INDEX ad_alerts_business ON ad_alerts (business_id, created_at DESC);
