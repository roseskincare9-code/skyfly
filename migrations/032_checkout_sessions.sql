-- Checkout sessions (abandoned checkouts): what a customer entered and chose on an order form before
-- submitting it. They are never orders: not counted in sales or revenue, never sent to ad platforms
-- or Google Sheets. Each belongs to one business. No payment details are ever stored (Skyfly takes
-- no card details: orders are paid on delivery or outside Skyfly).
CREATE TABLE checkout_sessions (
  id BIGSERIAL PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  landing_page_id BIGINT REFERENCES landing_pages(id) ON DELETE SET NULL,
  -- Random ID made by the customer's browser; also the resume link's key.
  token TEXT NOT NULL UNIQUE CHECK (token ~ '^[A-Za-z0-9_-]{16,100}$'),
  -- active → abandoned (no activity for the business's set time) → expired (30 days);
  -- completed (ordered while active) / recovered (ordered after being abandoned).
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'abandoned', 'completed', 'recovered', 'expired')),
  step TEXT CHECK (step IN ('started', 'details', 'review')),
  customer_name TEXT CHECK (length(customer_name) <= 120),
  phone TEXT CHECK (length(phone) <= 40),
  email TEXT CHECK (length(email) <= 200),
  address TEXT CHECK (length(address) <= 500),
  state TEXT CHECK (length(state) <= 60),
  notes TEXT CHECK (length(notes) <= 1000),
  marketing_consent BOOLEAN NOT NULL DEFAULT false,
  -- Priced by Skyfly from its catalog (never the browser's prices): [{code, name, quantity, unitPrice, lineTotal, upsell, options}]
  items JSONB NOT NULL DEFAULT '[]',
  currency TEXT,
  subtotal_minor BIGINT NOT NULL DEFAULT 0 CHECK (subtotal_minor >= 0),
  delivery_fee_minor BIGINT NOT NULL DEFAULT 0 CHECK (delivery_fee_minor >= 0),
  total_minor BIGINT NOT NULL DEFAULT 0 CHECK (total_minor >= 0),
  is_test BOOLEAN NOT NULL DEFAULT false,
  source_url TEXT CHECK (length(source_url) <= 1000),
  utm_source TEXT CHECK (length(utm_source) <= 200),
  utm_campaign TEXT CHECK (length(utm_campaign) <= 200),
  -- Updates arrive out of order on bad connections: only a higher sequence number is applied.
  seq INTEGER NOT NULL DEFAULT 0,
  order_id BIGINT REFERENCES orders(id) ON DELETE SET NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_activity_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  abandoned_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  expired_at TIMESTAMPTZ,
  -- Personal details are erased 30 days after the session ends (see services/checkouts.js).
  details_erased_at TIMESTAMPTZ,
  followed_up_at TIMESTAMPTZ,
  follow_up_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX checkout_sessions_business_idx ON checkout_sessions (business_id, status, last_activity_at DESC);
CREATE INDEX checkout_sessions_phone_idx ON checkout_sessions (business_id, phone) WHERE phone IS NOT NULL;
CREATE INDEX checkout_sessions_order_idx ON checkout_sessions (order_id) WHERE order_id IS NOT NULL;

-- How long a checkout may be idle before it counts as abandoned (per business; default one hour).
ALTER TABLE businesses
  ADD COLUMN abandoned_after_minutes INTEGER NOT NULL DEFAULT 60 CHECK (abandoned_after_minutes BETWEEN 10 AND 10080);
