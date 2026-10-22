-- More pixels per business, each with its own name (e.g. "Pixel New"), next to the business's main
-- pixel (pixel_settings, unchanged). Used on every page of the business. Tokens are encrypted.
CREATE TABLE additional_pixels (
  id BIGSERIAL PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('meta', 'tiktok')),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  pixel_id TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT true,
  events TEXT[] NOT NULL DEFAULT ARRAY['PageView', 'ViewContent', 'InitiateCheckout', 'Lead', 'Purchase']
    CHECK (events <@ ARRAY['PageView', 'ViewContent', 'InitiateCheckout', 'Lead', 'Purchase']),
  server_purchase BOOLEAN NOT NULL DEFAULT false,
  access_token_enc TEXT,
  test_event_code TEXT,
  server_verified_at TIMESTAMPTZ,
  updated_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, provider, pixel_id)
);

-- Server-side events are once per order, pixel and event (two Meta pixels each get their Purchase).
ALTER TABLE conversion_events DROP CONSTRAINT conversion_events_order_id_provider_event_name_key;
ALTER TABLE conversion_events ADD CONSTRAINT conversion_events_order_pixel_event_key UNIQUE (order_id, provider, pixel_id, event_name);

-- Larose Skincare Nigeria: "Pixel New" (requested by the owner, 2026-10-22), next to its main pixel.
INSERT INTO additional_pixels (business_id, provider, name, pixel_id)
SELECT id, 'meta', 'Pixel New', '1087347357386553' FROM businesses WHERE slug = 'larose-nigeria'
ON CONFLICT DO NOTHING;
