-- Tracking & Pixels: any number of tracking IDs per business and platform (Meta, TikTok, X), each
-- with its own name, events, landing pages and settings. Replaces the single "main pixel" per
-- platform (pixel_settings: one per business, or one per page) and the business-wide "additional
-- pixels" as the source Skyfly reads. Those two tables are kept unchanged (nothing is deleted);
-- their rows are copied here with the same behaviour on every page.
CREATE TABLE tracking_pixels (
  id BIGSERIAL PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  platform TEXT NOT NULL CHECK (platform IN ('meta', 'tiktok', 'x')),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  pixel_id TEXT NOT NULL CHECK (pixel_id ~ '^[A-Za-z0-9]{3,40}$'),
  enabled BOOLEAN NOT NULL DEFAULT true,
  -- true: every landing page of the business, including pages added later. false: only the pages in
  -- tracking_pixel_pages (chosen by the owner).
  all_pages BOOLEAN NOT NULL DEFAULT false,
  -- Skyfly's events this ID receives (each platform gets its own event names, see services/pixels.js).
  events TEXT[] NOT NULL DEFAULT ARRAY['PageView', 'ViewContent', 'InitiateCheckout', 'Lead', 'Purchase']
    CHECK (events <@ ARRAY['PageView', 'ViewContent', 'InitiateCheckout', 'Lead', 'Purchase']),
  -- Platform settings: X event IDs per Skyfly event ({"Purchase": "abc12", …}); TikTok's purchase event name.
  settings JSONB NOT NULL DEFAULT '{}',
  install_method TEXT NOT NULL DEFAULT 'id' CHECK (install_method IN ('id', 'code')),
  -- Server-side Purchase (Meta Conversions API / TikTok Events API): token AES-256-GCM encrypted,
  -- write-only (never shown again, never sent to the browser).
  server_purchase BOOLEAN NOT NULL DEFAULT false,
  access_token_enc TEXT,
  test_event_code TEXT CHECK (test_event_code IS NULL OR test_event_code ~ '^[A-Za-z0-9_-]{3,40}$'),
  -- Statuses, each from real evidence:
  browser_seen_at TIMESTAMPTZ,      -- the platform's script loaded with this ID on a live page (reported by the page)
  browser_seen_page TEXT,
  browser_verified_at TIMESTAMPTZ,  -- the owner confirmed events in the platform's own test tool
  browser_verified_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  test_event_at TIMESTAMPTZ,        -- the platform accepted a server test event from Skyfly
  server_verified_at TIMESTAMPTZ,   -- the platform accepted a server event (test or real) from Skyfly
  -- Where a row came from when it was copied from the old tables ("pixel_settings:12"), so the copy runs once.
  legacy_ref TEXT UNIQUE,
  created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  updated_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, platform, pixel_id)
);
CREATE INDEX tracking_pixels_business_idx ON tracking_pixels (business_id, platform);

-- The landing pages a tracking ID is assigned to (when it is not on all pages). Both rows belong to
-- the same business (checked when saving; see routes/pixels.js).
CREATE TABLE tracking_pixel_pages (
  tracking_pixel_id BIGINT NOT NULL REFERENCES tracking_pixels(id) ON DELETE CASCADE,
  landing_page_id BIGINT NOT NULL REFERENCES landing_pages(id) ON DELETE CASCADE,
  PRIMARY KEY (tracking_pixel_id, landing_page_id)
);
CREATE INDEX tracking_pixel_pages_page_idx ON tracking_pixel_pages (landing_page_id);

-- 1. Business-wide main pixels (pixel_settings without a page). On all pages, unless some page had
--    its own pixel for that platform (which replaced the main one there): then on every other page.
INSERT INTO tracking_pixels (business_id, platform, name, pixel_id, enabled, all_pages, events, install_method,
                             server_purchase, access_token_enc, test_event_code, server_verified_at, browser_verified_at,
                             browser_verified_by, legacy_ref, updated_by, updated_at)
SELECT ps.business_id, ps.provider, CASE ps.provider WHEN 'meta' THEN 'Main Meta pixel' ELSE 'Main TikTok pixel' END,
       CASE ps.provider WHEN 'tiktok' THEN upper(ps.pixel_id) ELSE ps.pixel_id END, ps.enabled,
       NOT EXISTS (SELECT 1 FROM pixel_settings o WHERE o.business_id = ps.business_id AND o.provider = ps.provider AND o.landing_page_id IS NOT NULL),
       ps.events, ps.install_method, ps.server_purchase, ps.access_token_enc, ps.test_event_code, ps.server_verified_at,
       ps.browser_verified_at, ps.browser_verified_by, 'pixel_settings:' || ps.id, ps.updated_by, ps.updated_at
  FROM pixel_settings ps
 WHERE ps.landing_page_id IS NULL AND ps.pixel_id ~ '^[A-Za-z0-9]{3,40}$'
ON CONFLICT DO NOTHING;
INSERT INTO tracking_pixel_pages (tracking_pixel_id, landing_page_id)
SELECT tp.id, lp.id
  FROM tracking_pixels tp
  JOIN pixel_settings ps ON tp.legacy_ref = 'pixel_settings:' || ps.id
  JOIN landing_pages lp ON lp.business_id = tp.business_id
 WHERE ps.landing_page_id IS NULL AND NOT tp.all_pages
   AND NOT EXISTS (SELECT 1 FROM pixel_settings o WHERE o.landing_page_id = lp.id AND o.provider = ps.provider)
ON CONFLICT DO NOTHING;

-- 2. Page-specific pixels: assigned to their page only.
INSERT INTO tracking_pixels (business_id, platform, name, pixel_id, enabled, all_pages, events, install_method,
                             server_purchase, access_token_enc, test_event_code, server_verified_at, browser_verified_at,
                             browser_verified_by, legacy_ref, updated_by, updated_at)
SELECT ps.business_id, ps.provider, left(CASE ps.provider WHEN 'meta' THEN 'Meta pixel' ELSE 'TikTok pixel' END || ' for ' || lp.name, 60),
       CASE ps.provider WHEN 'tiktok' THEN upper(ps.pixel_id) ELSE ps.pixel_id END, ps.enabled, false,
       ps.events, ps.install_method, ps.server_purchase, ps.access_token_enc, ps.test_event_code, ps.server_verified_at,
       ps.browser_verified_at, ps.browser_verified_by, 'pixel_settings:' || ps.id, ps.updated_by, ps.updated_at
  FROM pixel_settings ps JOIN landing_pages lp ON lp.id = ps.landing_page_id
 WHERE ps.pixel_id ~ '^[A-Za-z0-9]{3,40}$'
ON CONFLICT DO NOTHING;
-- The same pixel ID used as a page pixel and elsewhere becomes one tracking ID with both assignments.
INSERT INTO tracking_pixel_pages (tracking_pixel_id, landing_page_id)
SELECT tp.id, ps.landing_page_id
  FROM pixel_settings ps
  JOIN tracking_pixels tp ON tp.business_id = ps.business_id AND tp.platform = ps.provider
                         AND tp.pixel_id = CASE ps.provider WHEN 'tiktok' THEN upper(ps.pixel_id) ELSE ps.pixel_id END
 WHERE ps.landing_page_id IS NOT NULL AND NOT tp.all_pages
ON CONFLICT DO NOTHING;

-- 3. Additional named pixels (e.g. Larose's "Pixel New" and its ad-account pixels): on all pages, as before.
INSERT INTO tracking_pixels (business_id, platform, name, pixel_id, enabled, all_pages, events, server_purchase,
                             access_token_enc, test_event_code, server_verified_at, legacy_ref, updated_by, created_at, updated_at)
SELECT ap.business_id, ap.provider, ap.name, CASE ap.provider WHEN 'tiktok' THEN upper(ap.pixel_id) ELSE ap.pixel_id END,
       ap.enabled, true, ap.events, ap.server_purchase, ap.access_token_enc, ap.test_event_code, ap.server_verified_at,
       'additional_pixels:' || ap.id, ap.updated_by, ap.created_at, ap.updated_at
  FROM additional_pixels ap
 WHERE ap.pixel_id ~ '^[A-Za-z0-9]{3,40}$'
ON CONFLICT DO NOTHING;
