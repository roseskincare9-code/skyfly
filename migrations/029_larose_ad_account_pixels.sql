-- Larose Skincare Nigeria: Meta pixels of the owner's other ad accounts (requested 2026-10-23), added to
-- its additional pixels next to the main pixel and "Pixel New". Public pixel IDs only (no tokens).
-- A pixel the business already uses is left as it is (one row per business and pixel ID); nothing is
-- removed or changed, and no other business is touched.
INSERT INTO additional_pixels (business_id, provider, name, pixel_id)
SELECT b.id, 'meta', v.name, v.pixel_id
  FROM businesses b,
       (VALUES ('Skyfly', '1105657388903531'), ('Skindrips', '1653102723149813'),
               ('Skindrip', '1130654146607839'), ('Moon fly', '4389240701387003')) AS v(name, pixel_id)
 WHERE b.slug = 'larose-nigeria'
   AND NOT EXISTS (SELECT 1 FROM pixel_settings ps WHERE ps.business_id = b.id AND ps.provider = 'meta' AND ps.pixel_id = v.pixel_id)
ON CONFLICT (business_id, provider, pixel_id) DO NOTHING;
