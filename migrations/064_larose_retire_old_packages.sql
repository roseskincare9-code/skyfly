-- Larose Skincare Nigeria: retire the old packages (package-1 … package-5) now that both Larose pages sell
-- the six Halfcast packages (migration 062; Larosenigeria PR #9 is live). The products are switched off,
-- not deleted: past orders keep their items, names and prices, and the owner can switch one back on in
-- Products. Switched-off products drop out of the page catalog and new orders for them are refused.
-- Other businesses, and every other Larose product, are not touched.
UPDATE products p
   SET active = false
  FROM businesses b
 WHERE b.id = p.business_id AND b.slug = 'larose-nigeria'
   AND p.code IN ('package-1', 'package-2', 'package-3', 'package-4', 'package-5')
   AND p.active;
