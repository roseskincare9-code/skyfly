-- Online payments (Stripe, PayPal) next to Payment on Delivery. Additive only: existing orders keep
-- payment_method 'cod' and their payment status.
--   * Each business connects ITS OWN Stripe / PayPal account (no shared account). Skyfly stores only the
--     connected account's public identifier: charges are made on the merchant's own account with the
--     platform's credentials (Stripe-Account header / PayPal payee + auth assertion), so no merchant secret
--     is stored at all.
--   * Online checkout is in USD with prices the business sets explicitly in USD (never converted).
--   * An order becomes paid only from a verified server-side confirmation (signed webhook, or Skyfly asking
--     the gateway itself); every gateway event is recorded once (duplicate deliveries change nothing).
ALTER TABLE products ADD COLUMN IF NOT EXISTS usd_price_minor BIGINT CHECK (usd_price_minor IS NULL OR usd_price_minor >= 0);
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS usd_delivery_fee_minor BIGINT NOT NULL DEFAULT 0 CHECK (usd_delivery_fee_minor >= 0);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_method TEXT NOT NULL DEFAULT 'cod';
DO $$ BEGIN
  ALTER TABLE orders ADD CONSTRAINT orders_payment_method_check CHECK (payment_method IN ('cod', 'stripe', 'paypal'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS payment_connections (
  id BIGSERIAL PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('stripe', 'paypal')),
  status TEXT NOT NULL CHECK (status IN ('connected', 'pending', 'disconnected')),
  account_id TEXT,                     -- Stripe acct_…, PayPal merchant ID (public identifiers, not secrets)
  mode TEXT NOT NULL CHECK (mode IN ('test', 'live')),
  enabled BOOLEAN NOT NULL DEFAULT true,
  details JSONB,                       -- non-secret facts from the gateway (charges enabled, email confirmed…)
  connected_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  connected_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, provider)
);

-- Short-lived authorisation requests (Connect Stripe / Connect PayPal): only the hash of the random state.
CREATE TABLE IF NOT EXISTS payment_oauth_states (
  id BIGSERIAL PRIMARY KEY,
  state_hash TEXT NOT NULL UNIQUE,
  business_id BIGINT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('stripe', 'paypal')),
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS payment_transactions (
  id BIGSERIAL PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  order_id BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('stripe', 'paypal')),
  kind TEXT NOT NULL CHECK (kind IN ('payment', 'refund')),
  status TEXT NOT NULL CHECK (status IN ('created', 'pending', 'succeeded', 'failed', 'canceled', 'refunded')),
  amount_minor BIGINT NOT NULL CHECK (amount_minor >= 0),
  currency TEXT NOT NULL,
  account_id TEXT NOT NULL,            -- the business's connected account the money goes to
  provider_ref TEXT NOT NULL,          -- Stripe Checkout Session / PayPal order / refund ID
  provider_payment_id TEXT,            -- Stripe PaymentIntent / PayPal capture ID
  failure_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_ref)
);
CREATE INDEX IF NOT EXISTS payment_transactions_order_idx ON payment_transactions (order_id);
CREATE INDEX IF NOT EXISTS payment_transactions_pending_idx ON payment_transactions (status, created_at) WHERE status IN ('created', 'pending');

-- Every verified gateway event, once (a retried webhook is recognised and changes nothing).
CREATE TABLE IF NOT EXISTS payment_webhook_events (
  id BIGSERIAL PRIMARY KEY,
  provider TEXT NOT NULL,
  event_id TEXT NOT NULL,
  type TEXT NOT NULL,
  order_id BIGINT REFERENCES orders(id) ON DELETE SET NULL,
  outcome TEXT,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider, event_id)
);

-- A transaction always belongs to its order's business (database guard, like migration 038).
CREATE OR REPLACE FUNCTION skyfly_payment_same_business() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM orders WHERE id = NEW.order_id AND business_id = NEW.business_id) THEN
    RAISE EXCEPTION 'payment transaction % does not belong to its order''s business', NEW.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS payment_transactions_same_business ON payment_transactions;
CREATE TRIGGER payment_transactions_same_business BEFORE INSERT OR UPDATE OF order_id, business_id ON payment_transactions
  FOR EACH ROW EXECUTE FUNCTION skyfly_payment_same_business();
