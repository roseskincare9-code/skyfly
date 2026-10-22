-- Larose Skincare Nigeria: prices confirmed by the owner (2026-10-22) for the first three packages.
-- Package 1 – Starter Glow Soap ₦23,500 → ₦26,500; Package 2 – Starter Glow Combo ₦33,000 → ₦36,500;
-- Package 3 – Power Glow ₦51,500 → ₦58,000. Only a package still at its old price is changed (a price
-- the owner already set in Products is kept). Packages 4 and 5, other businesses and past orders
-- (which keep the price they were placed at) are not touched.
UPDATE products p SET price_minor = v.new_minor, updated_at = now()
  FROM (VALUES ('package-1', 2350000, 2650000), ('package-2', 3300000, 3650000), ('package-3', 5150000, 5800000)) AS v(code, old_minor, new_minor),
       businesses b
 WHERE b.slug = 'larose-nigeria' AND p.business_id = b.id AND p.code = v.code AND p.price_minor = v.old_minor;
