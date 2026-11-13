-- Paid plans (Business Pro, Agency VIP) through Paystack (NGN). Additive only; existing subscriptions are
-- not changed. A payment activates or extends a plan only from Paystack's own verification (server-side
-- transaction lookup) or a webhook whose HMAC-SHA512 signature was verified; each payment applies once.
CREATE TABLE IF NOT EXISTS subscription_payments (
  id BIGSERIAL PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  plan TEXT NOT NULL,
  amount_minor BIGINT NOT NULL CHECK (amount_minor > 0),
  currency TEXT NOT NULL DEFAULT 'NGN',
  provider TEXT NOT NULL DEFAULT 'paystack',
  mode TEXT NOT NULL CHECK (mode IN ('test', 'live')),
  reference TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('pending', 'success', 'failed', 'abandoned')),
  period_start DATE,
  period_end DATE,
  gateway_status TEXT,
  channel TEXT,
  failure_reason TEXT,
  paid_at TIMESTAMPTZ,
  created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS subscription_payments_business_idx ON subscription_payments (business_id, id DESC);
CREATE INDEX IF NOT EXISTS subscription_payments_pending_idx ON subscription_payments (status, created_at) WHERE status = 'pending';

-- Expiry alerts for the Super Admin: one per business, step (14/7/3 days before, the day itself) and expiry date.
CREATE TABLE IF NOT EXISTS subscription_reminders (
  id BIGSERIAL PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  threshold TEXT NOT NULL CHECK (threshold IN ('14d', '7d', '3d', '0d')),
  expires_on DATE NOT NULL,
  status TEXT NOT NULL,
  detail TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, threshold, expires_on)
);
