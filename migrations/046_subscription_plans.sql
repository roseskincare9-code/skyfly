-- Skyfly's subscription plans (owner decision, 3 Nov 2026): Business Pro ₦199,000/month and Agency VIP
-- ₦399,000/month. Additive: a nullable plan per business, set by the Super Admin. Existing businesses keep
-- NULL (no plan chosen yet); nothing else changes. Each business sees only its own plan.
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS plan TEXT CHECK (plan IN ('business_pro', 'agency_vip'));
