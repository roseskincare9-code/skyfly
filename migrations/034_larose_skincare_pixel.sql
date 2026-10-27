-- Larose Skincare Nigeria: a further Meta pixel, "skincare" (1395209215400304, requested 2026-10-27),
-- as its own tracking ID next to the pixels it already has. Assigned to the Larose landing page
-- (larosenigeria, the page at roseskincare9-code.github.io/Larosenigeria/) with every event. Public
-- pixel ID only (no token). If the business already has this ID it is left as it is; no other
-- tracking ID, page or business is changed.
INSERT INTO tracking_pixels (business_id, platform, name, pixel_id, enabled, all_pages, events)
SELECT b.id, 'meta', 'skincare', '1395209215400304', true, false,
       ARRAY['PageView', 'ViewContent', 'InitiateCheckout', 'Lead', 'Purchase']
  FROM businesses b
 WHERE b.slug = 'larose-nigeria'
ON CONFLICT (business_id, platform, pixel_id) DO NOTHING;

INSERT INTO tracking_pixel_pages (tracking_pixel_id, landing_page_id)
SELECT tp.id, lp.id
  FROM tracking_pixels tp
  JOIN businesses b ON b.id = tp.business_id AND b.slug = 'larose-nigeria'
  JOIN landing_pages lp ON lp.business_id = b.id AND lp.slug = 'larosenigeria'
 WHERE tp.platform = 'meta' AND tp.pixel_id = '1395209215400304' AND tp.name = 'skincare' AND NOT tp.all_pages
ON CONFLICT DO NOTHING;
