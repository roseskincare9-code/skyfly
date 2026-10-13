-- Order management: products, landing pages, orders.
-- Money is stored as integer minor units (kobo for NGN) to avoid rounding errors.

ALTER TABLE businesses
  ADD COLUMN whatsapp_number TEXT,
  ADD COLUMN order_prefix TEXT NOT NULL DEFAULT 'SKY' CHECK (order_prefix ~ '^[A-Z]{2,5}$');

CREATE TABLE products (
  id BIGSERIAL PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  code TEXT NOT NULL CHECK (code ~ '^[a-z0-9][a-z0-9-]{0,49}$'),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  price_minor BIGINT NOT NULL CHECK (price_minor >= 0),
  active BOOLEAN NOT NULL DEFAULT true,
  sort_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, code)
);

CREATE TABLE landing_pages (
  id BIGSERIAL PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  -- Public key the landing page sends with each order for attribution.
  slug TEXT NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,59}$'),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  url TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'paused', 'archived')),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX landing_pages_business_id_idx ON landing_pages (business_id);

CREATE TABLE landing_page_products (
  landing_page_id BIGINT NOT NULL REFERENCES landing_pages(id) ON DELETE CASCADE,
  product_id BIGINT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  PRIMARY KEY (landing_page_id, product_id)
);

CREATE TABLE orders (
  id BIGSERIAL PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  landing_page_id BIGINT REFERENCES landing_pages(id) ON DELETE SET NULL,
  reference TEXT NOT NULL UNIQUE,
  -- Secret for the customer's confirmation link, so references cannot be enumerated.
  access_token TEXT NOT NULL,
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 16 AND 100),
  request_fingerprint TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN (
    'new', 'pending_confirmation', 'confirmed', 'processing',
    'dispatched', 'delivered', 'cancelled', 'returned')),
  customer_name TEXT NOT NULL CHECK (length(customer_name) BETWEEN 2 AND 120),
  phone TEXT NOT NULL CHECK (phone ~ '^\+[0-9]{8,15}$'),
  email TEXT CHECK (email IS NULL OR length(email) <= 200),
  address TEXT NOT NULL CHECK (length(address) BETWEEN 5 AND 500),
  state TEXT CHECK (state IS NULL OR length(state) <= 60),
  customer_notes TEXT CHECK (customer_notes IS NULL OR length(customer_notes) <= 1000),
  currency TEXT NOT NULL,
  total_minor BIGINT NOT NULL CHECK (total_minor >= 0),
  source_url TEXT,
  referrer TEXT,
  utm_source TEXT,
  utm_medium TEXT,
  utm_campaign TEXT,
  utm_content TEXT,
  utm_term TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, idempotency_key)
);

CREATE INDEX orders_business_created_idx ON orders (business_id, created_at DESC);
CREATE INDEX orders_business_status_idx ON orders (business_id, status);
CREATE INDEX orders_landing_page_idx ON orders (landing_page_id);

-- Line items snapshot the product name and price at the time of the order.
CREATE TABLE order_items (
  id BIGSERIAL PRIMARY KEY,
  order_id BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id BIGINT REFERENCES products(id) ON DELETE SET NULL,
  product_code TEXT NOT NULL,
  product_name TEXT NOT NULL,
  unit_price_minor BIGINT NOT NULL CHECK (unit_price_minor >= 0),
  quantity INT NOT NULL CHECK (quantity BETWEEN 1 AND 100),
  line_total_minor BIGINT NOT NULL CHECK (line_total_minor = unit_price_minor * quantity)
);

CREATE INDEX order_items_order_id_idx ON order_items (order_id);

CREATE TABLE order_status_history (
  id BIGSERIAL PRIMARY KEY,
  order_id BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  from_status TEXT,
  to_status TEXT NOT NULL,
  note TEXT,
  changed_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX order_status_history_order_id_idx ON order_status_history (order_id);
