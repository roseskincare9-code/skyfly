-- Larose Skincare Nigeria: new product line-up and prices (owner's instruction, 2026-11-22).
--   500g Halfcast Super Fort Herbal Soap ₦20,500 (primary offer) · 500g + Oil ₦30,500 · 1 Litre ₦26,500 · 1 Litre + Oil ₦36,500
--   2 Litre ₦44,500 · 2 Litre + Oil ₦54,500; the Facial Set (₦17,000) stays the only add-on
-- New product codes, so the page that is live now (package-1 … package-5) keeps taking orders until the
-- new page is published; past orders keep the products and prices they were placed at. A product the
-- owner already created with one of these codes is left as it is. The old packages are retired
-- by migration 063 (its own pull request), once the new page is live.
INSERT INTO products (business_id, code, name, price_minor, description, sort_order, active)
SELECT b.id, v.code, v.name, v.price_minor, v.description, v.sort_order, true
  FROM businesses b,
       (VALUES ('soap-500g',     '500g Halfcast Super Fort Herbal Soap', 2050000, 'Starter size: 500g Larose Halfcast Super Fort Herbal Soap.', 1),
               ('soap-500g-oil', '500g Halfcast Super Fort Herbal Soap + Fruit Essence Skin Glowing Oil', 3050000, '500g Halfcast Super Fort Herbal Soap + Fruit Essence Skin Glowing Oil.', 2),
               ('soap-1l',       '1 Litre Halfcast Super Fort Herbal Soap', 2650000, '1 Litre Larose Halfcast Super Fort Herbal Soap.', 3),
               ('soap-1l-oil',   '1 Litre Halfcast Super Fort Herbal Soap + Fruit Essence Skin Glowing Oil', 3650000, '1 Litre Halfcast Super Fort Herbal Soap + Fruit Essence Skin Glowing Oil.', 4),
               ('soap-2l',       '2 Litre Halfcast Super Fort Herbal Soap', 4450000, '2 Litre Larose Halfcast Super Fort Herbal Soap.', 5),
               ('soap-2l-oil',   '2 Litre Halfcast Super Fort Herbal Soap + Fruit Essence Skin Glowing Oil', 5450000, '2 Litre Halfcast Super Fort Herbal Soap + Fruit Essence Skin Glowing Oil.', 6))
         AS v(code, name, price_minor, description, sort_order)
 WHERE b.slug = 'larose-nigeria'
ON CONFLICT (business_id, code) DO NOTHING;

-- The Facial Set (₦17,000) stays the one optional add-on: it is the upsell of both Larose pages and is
-- not sold as a package on its own (the page's packages are only the six above).
INSERT INTO products (business_id, code, name, price_minor, compare_at_price_minor, description, sort_order, active)
SELECT id, 'facial-set', 'Facial Set', 1700000, 2500000, 'Facial Detox Toner, Baby Face Whitening Soap and All Clear Face Cream', 50, true
  FROM businesses WHERE slug = 'larose-nigeria'
ON CONFLICT (business_id, code) DO NOTHING;

-- The six packages on both Larose pages (GitHub Pages larosenigeria and the Skyfly-hosted copy).
INSERT INTO landing_page_products (landing_page_id, product_id)
SELECT lp.id, p.id
  FROM landing_pages lp
  JOIN businesses b ON b.id = lp.business_id AND b.slug = 'larose-nigeria'
  JOIN products p ON p.business_id = b.id
 WHERE lp.slug IN ('larosenigeria', 'larose-skincare')
   AND p.code IN ('soap-500g', 'soap-500g-oil', 'soap-1l', 'soap-1l-oil', 'soap-2l', 'soap-2l-oil')
ON CONFLICT DO NOTHING;

UPDATE landing_pages lp
   SET upsell_product_id = p.id, updated_at = now()
  FROM products p JOIN businesses b ON b.id = p.business_id
 WHERE b.slug = 'larose-nigeria' AND p.code = 'facial-set' AND lp.business_id = b.id
   AND lp.slug IN ('larosenigeria', 'larose-skincare');

-- The Media Buyer's prices and offer (used for its WhatsApp sales scripts and ad copy).
UPDATE ad_profiles ap
   SET prices = '500g Halfcast Super Fort Herbal Soap ₦20,500; 500g Soap + Fruit Essence Skin Glowing Oil ₦30,500; 1 Litre Soap ₦26,500; 1 Litre Soap + Oil ₦36,500; 2 Litre Soap ₦44,500; 2 Litre Soap + Oil ₦54,500; optional add-on: Facial Set ₦17,000',
       offer = '500g Halfcast Super Fort Herbal Soap starter package for ₦20,500 (main advertised offer). Free delivery anywhere in Nigeria within our regular delivery coverage; for remote locations, villages or areas outside our normal delivery jurisdiction an additional ₦3,000 may apply, confirmed by our receptionist before dispatch. Pay on delivery.',
       updated_at = now()
  FROM businesses b
 WHERE b.id = ap.business_id AND b.slug = 'larose-nigeria';
