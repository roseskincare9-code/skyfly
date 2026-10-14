-- A page counts as order-connected only once a real submission from it has
-- been saved, not merely because connection code was found in its HTML.
ALTER TABLE landing_pages
  ADD COLUMN order_connected_at TIMESTAMPTZ,
  ADD COLUMN order_connected_reference TEXT;

-- Test orders (e.g. placed to check a form) are kept but excluded from sales
-- figures and never sent to ad platforms as purchases.
ALTER TABLE orders ADD COLUMN is_test BOOLEAN NOT NULL DEFAULT false;

-- "Configured" (ID saved and switched on) is separate from "verified":
-- server_verified_at: the platform accepted a server event from Skyfly.
-- browser_verified_at: the owner confirmed browser events with the platform's tools.
ALTER TABLE pixel_settings
  ADD COLUMN server_verified_at TIMESTAMPTZ,
  ADD COLUMN browser_verified_at TIMESTAMPTZ,
  ADD COLUMN browser_verified_by BIGINT REFERENCES users(id) ON DELETE SET NULL;
