-- Larose Skincare Nigeria: the "skincare" Meta pixel (1395209215400304, migration 034) is also assigned
-- to the Skyfly-hosted Larose page (larose-skincare, /p/larose-skincare/), requested by the owner on
-- 2026-11-21. Migration 034 assigned it to the GitHub Pages page (larosenigeria) only, and the hosted
-- page was created later without it, so that page never loaded this pixel. The existing GitHub Pages
-- assignment is kept. Nothing else changes: not the pixel's events, enabled state, token or other
-- pages, and no other tracking ID or business. A pixel the owner set to "All pages" is left as it is
-- (it already covers the hosted page). Running it again changes nothing.
INSERT INTO tracking_pixel_pages (tracking_pixel_id, landing_page_id)
SELECT tp.id, lp.id
  FROM tracking_pixels tp
  JOIN businesses b ON b.id = tp.business_id AND b.slug = 'larose-nigeria'
  JOIN landing_pages lp ON lp.business_id = b.id AND lp.slug = 'larose-skincare'
 WHERE tp.platform = 'meta' AND tp.pixel_id = '1395209215400304' AND NOT tp.all_pages
ON CONFLICT DO NOTHING;
