-- Budget safeguards for the AI Media Buyer (read-only towards Meta: nothing here changes a campaign).
--   * ad_budget_register: the daily budget the owner APPROVED for each campaign / ad set (minor units).
--   * ad_budget_events:   append-only audit log of every approval, every budget change Skyfly made after an
--                         approval, and every change detected in Meta that Skyfly did not make.
--   * ad_spend_daily:     one row per object and day: actual spend next to the budget that was in force,
--                         across every connected ad account of the business (so totals can be aggregated).
-- Meta may spend more than the daily budget on a given day (its pacing allows up to 75% over on one day while
-- keeping the weekly average within 7x the daily budget), so overspend is reported, never "capped" here.

CREATE TABLE ad_budget_register (
  id BIGSERIAL PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  ad_account_id TEXT NOT NULL CHECK (ad_account_id ~ '^[0-9]{5,20}$'),
  entity_level TEXT NOT NULL CHECK (entity_level IN ('campaign', 'adset')),
  entity_id TEXT NOT NULL CHECK (entity_id ~ '^[0-9]{1,30}$'),
  entity_name TEXT,
  approved_daily_budget_minor BIGINT NOT NULL CHECK (approved_daily_budget_minor > 0),
  approved_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  approved_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  note TEXT,
  last_seen_budget_minor BIGINT,
  last_seen_at TIMESTAMPTZ,
  UNIQUE (business_id, ad_account_id, entity_id)
);
CREATE INDEX ad_budget_register_business ON ad_budget_register (business_id);

CREATE TABLE ad_budget_events (
  id BIGSERIAL PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  ad_account_id TEXT NOT NULL CHECK (ad_account_id ~ '^[0-9]{5,20}$'),
  entity_level TEXT, entity_id TEXT NOT NULL, entity_name TEXT,
  event TEXT NOT NULL CHECK (event IN ('approved', 'changed_by_skyfly', 'changed_outside_skyfly', 'unregistered_budget', 'back_to_approved')),
  old_budget_minor BIGINT,
  new_budget_minor BIGINT,
  approved_budget_minor BIGINT,
  source TEXT NOT NULL CHECK (source IN ('owner', 'skyfly_action', 'meta_check')),
  actor BIGINT REFERENCES users(id) ON DELETE SET NULL,
  details JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ad_budget_events_business ON ad_budget_events (business_id, created_at DESC);

-- The audit log cannot be edited or deleted row by row (only removed with the whole business).
CREATE FUNCTION ad_budget_events_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'ad_budget_events is append-only';
END $$;
CREATE TRIGGER ad_budget_events_no_update BEFORE UPDATE ON ad_budget_events FOR EACH ROW EXECUTE FUNCTION ad_budget_events_append_only();
CREATE TRIGGER ad_budget_events_no_delete BEFORE DELETE ON ad_budget_events FOR EACH ROW
  WHEN (pg_trigger_depth() = 0) EXECUTE FUNCTION ad_budget_events_append_only();

CREATE TABLE ad_spend_daily (
  business_id BIGINT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  ad_account_id TEXT NOT NULL CHECK (ad_account_id ~ '^[0-9]{5,20}$'),
  entity_id TEXT NOT NULL,
  entity_name TEXT,
  day DATE NOT NULL,
  spend_minor BIGINT NOT NULL DEFAULT 0,
  budget_minor BIGINT,
  approved_budget_minor BIGINT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, ad_account_id, entity_id, day)
);

-- Thresholds for the safeguard alerts (owner-editable; defaults are conservative).
ALTER TABLE ad_monitor_settings
  ADD COLUMN overspend_pct INT NOT NULL DEFAULT 25 CHECK (overspend_pct BETWEEN 5 AND 200),
  ADD COLUMN combined_daily_limit_minor BIGINT CHECK (combined_daily_limit_minor IS NULL OR combined_daily_limit_minor > 0);
