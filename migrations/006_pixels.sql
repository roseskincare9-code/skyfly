-- Pixel settings per business (landing_page_id NULL = default for all pages)
-- or per landing page (overrides the default for that page).
CREATE TABLE pixel_settings (
  id BIGSERIAL PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  landing_page_id BIGINT REFERENCES landing_pages(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('meta', 'tiktok')),
  enabled BOOLEAN NOT NULL DEFAULT false,
  pixel_id TEXT,
  -- Browser events Skyfly fires on the page. Purchase is never fired in the browser.
  events TEXT[] NOT NULL DEFAULT ARRAY['PageView', 'InitiateCheckout', 'Lead'],
  server_purchase BOOLEAN NOT NULL DEFAULT false,
  -- Conversions API / Events API token, AES-256-GCM encrypted. Never shown again after saving.
  access_token_enc TEXT,
  test_event_code TEXT,
  updated_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (events <@ ARRAY['PageView', 'ViewContent', 'InitiateCheckout', 'Lead'])
);

CREATE UNIQUE INDEX pixel_settings_business_default_idx ON pixel_settings (business_id, provider) WHERE landing_page_id IS NULL;
CREATE UNIQUE INDEX pixel_settings_page_idx ON pixel_settings (landing_page_id, provider) WHERE landing_page_id IS NOT NULL;

-- Server-side conversion events. The unique key makes each event send at most once.
CREATE TABLE conversion_events (
  id BIGSERIAL PRIMARY KEY,
  order_id BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  pixel_id TEXT NOT NULL,
  event_name TEXT NOT NULL,
  event_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
  attempts INT NOT NULL DEFAULT 0,
  response_code INT,
  last_error TEXT,
  test_mode BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at TIMESTAMPTZ,
  UNIQUE (order_id, provider, event_name)
);

-- Signals that help ad platforms match a purchase to the original ad click.
ALTER TABLE orders
  ADD COLUMN client_ip TEXT,
  ADD COLUMN user_agent TEXT,
  ADD COLUMN fbp TEXT,
  ADD COLUMN fbc TEXT,
  ADD COLUMN ttp TEXT,
  ADD COLUMN ttclid TEXT;
