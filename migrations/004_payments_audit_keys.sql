-- Order statuses: Pending, Confirmed/Approved, Processing, Dispatched, Delivered, Cancelled, Returned.
ALTER TABLE orders DROP CONSTRAINT orders_status_check;
UPDATE orders SET status = 'pending' WHERE status IN ('new', 'pending_confirmation');
ALTER TABLE orders ALTER COLUMN status SET DEFAULT 'pending';
ALTER TABLE orders ADD CONSTRAINT orders_status_check CHECK (status IN (
  'pending', 'confirmed', 'processing', 'dispatched', 'delivered', 'cancelled', 'returned'));

-- Payment is tracked separately from fulfilment.
ALTER TABLE orders
  ADD COLUMN payment_status TEXT NOT NULL DEFAULT 'unpaid'
    CHECK (payment_status IN ('unpaid', 'pending', 'paid', 'failed', 'refunded')),
  ADD COLUMN source TEXT NOT NULL DEFAULT 'web' CHECK (source IN ('web', 'api', 'manual'));

CREATE INDEX orders_business_payment_idx ON orders (business_id, payment_status);

UPDATE order_status_history SET to_status = 'pending' WHERE to_status IN ('new', 'pending_confirmation');
UPDATE order_status_history SET from_status = 'pending' WHERE from_status IN ('new', 'pending_confirmation');
ALTER TABLE order_status_history
  ADD COLUMN kind TEXT NOT NULL DEFAULT 'fulfillment' CHECK (kind IN ('fulfillment', 'payment'));

-- Secret keys for server-to-server order submission. Only a SHA-256 hash is stored.
CREATE TABLE api_keys (
  id BIGSERIAL PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  key_prefix TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ
);

CREATE INDEX api_keys_business_id_idx ON api_keys (business_id);

CREATE TABLE audit_log (
  id BIGSERIAL PRIMARY KEY,
  business_id BIGINT REFERENCES businesses(id) ON DELETE CASCADE,
  user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT,
  details JSONB,
  ip TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX audit_log_business_created_idx ON audit_log (business_id, created_at DESC);

-- Hosting fields (used by landing page hosting; the versions table follows in 005).
ALTER TABLE landing_pages
  ADD COLUMN custom_domain TEXT UNIQUE CHECK (custom_domain IS NULL OR custom_domain ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'),
  ADD COLUMN published_version_id BIGINT;
