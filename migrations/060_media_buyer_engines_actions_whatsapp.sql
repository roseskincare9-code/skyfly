-- AI Media Buyer, second step:
--   1. Two analysis engines (ChatGPT, Claude) and a comparison of both; AI usage recorded per analysis.
--   2. Approved actions (pause, daily budget) executed through the business's own Meta connection, each
--      verified and logged. An action is an ad_items row of kind 'action' with the exact change shown.
--   3. WhatsApp Conversion Audit: a privacy-safe WhatsApp lead log (no names, no phone numbers).
-- All new rows belong to one business.

ALTER TABLE ad_analyses ADD COLUMN kind TEXT NOT NULL DEFAULT 'performance' CHECK (kind IN ('performance', 'whatsapp'));
ALTER TABLE ad_analyses ADD COLUMN engine TEXT NOT NULL DEFAULT 'chatgpt' CHECK (engine IN ('chatgpt', 'claude', 'compare'));
ALTER TABLE ad_analyses ADD COLUMN usage JSONB NOT NULL DEFAULT '{}';

ALTER TABLE ad_items DROP CONSTRAINT ad_items_kind_check;
ALTER TABLE ad_items ADD CONSTRAINT ad_items_kind_check CHECK (kind IN ('audit', 'recommendation', 'brief', 'campaign_draft', 'report', 'action'));

-- Every attempt to change something in Meta after an approval: what was there, what was asked, what Meta
-- reported afterwards, and the outcome.
CREATE TABLE ad_action_log (
  id BIGSERIAL PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  ad_item_id BIGINT REFERENCES ad_items(id) ON DELETE SET NULL,
  ad_account_id TEXT NOT NULL CHECK (ad_account_id ~ '^[0-9]{5,20}$'),
  operation TEXT NOT NULL,
  object_level TEXT NOT NULL,
  object_id TEXT NOT NULL,
  before_state JSONB,
  requested JSONB NOT NULL,
  after_state JSONB,
  outcome TEXT NOT NULL CHECK (outcome IN ('executed', 'failed', 'refused')),
  error TEXT,
  approved_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ad_action_log_business ON ad_action_log (business_id, created_at DESC);

-- WhatsApp sales funnel, as the sales team records it (imported from a CSV or a CRM export). No customer
-- names, phone numbers or message text: only timings, the furthest stage reached and the outcome.
CREATE TABLE wa_leads (
  id BIGSERIAL PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  lead_key TEXT NOT NULL,
  campaign_ref TEXT,
  first_message_at TIMESTAMPTZ NOT NULL,
  first_response_at TIMESTAMPTZ,
  stage TEXT NOT NULL CHECK (stage IN ('messaged', 'responded', 'engaged', 'price_sent', 'order_intent', 'ordered', 'paid', 'delivered', 'repeat', 'lost')),
  furthest_stage TEXT CHECK (furthest_stage IS NULL OR furthest_stage IN ('messaged', 'responded', 'engaged', 'price_sent', 'order_intent', 'ordered', 'paid', 'delivered', 'repeat')),
  lost_reason TEXT,
  agent TEXT,
  follow_ups INT NOT NULL DEFAULT 0 CHECK (follow_ups >= 0),
  order_value_minor BIGINT CHECK (order_value_minor IS NULL OR order_value_minor >= 0),
  imported_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, lead_key)
);
CREATE INDEX wa_leads_business ON wa_leads (business_id, first_message_at DESC);
