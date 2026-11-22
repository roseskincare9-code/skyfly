-- Larose Skincare Nigeria: new product line-up and prices (owner's instruction, 2026-11-22).
--   500g African Soap ₦20,500 (primary offer) · 500g + Oil ₦30,500 · 1 Litre ₦26,500 · 1 Litre + Oil ₦36,500
--   2 Litres ₦44,500 · 2 Litres + Oil ₦54,500 · Upscale Facial Set ₦17,000
-- New product codes, so the page that is live now (package-1 … package-5) keeps taking orders until the
-- new page is published; past orders keep the products and prices they were placed at. A product the
-- owner already created with one of these codes is left as it is. The old packages are not
-- deactivated here: do that in Products once the new page is live.
INSERT INTO products (business_id, code, name, price_minor, description, sort_order, active)
SELECT b.id, v.code, v.name, v.price_minor, v.description, v.sort_order, true
  FROM businesses b,
       (VALUES ('soap-500g',     '500g African Soap',              2050000, 'Starter size: 500g Larose African Soap (Halfcast herbal soap).', 1),
               ('soap-500g-oil', '500g African Soap + Oil',        3050000, '500g African Soap + Fruit Essence Skin Glowing Oil.', 2),
               ('soap-1l',       '1 Litre African Soap',           2650000, '1 Litre Larose African Soap (Halfcast herbal soap).', 3),
               ('soap-1l-oil',   '1 Litre African Soap + Oil',     3650000, '1 Litre African Soap + Fruit Essence Skin Glowing Oil.', 4),
               ('soap-2l',       '2 Litres African Soap',          4450000, '2 Litres Larose African Soap (Halfcast herbal soap).', 5),
               ('soap-2l-oil',   '2 Litres African Soap + Oil',    5450000, '2 Litres African Soap + Fruit Essence Skin Glowing Oil.', 6))
         AS v(code, name, price_minor, description, sort_order)
 WHERE b.slug = 'larose-nigeria'
ON CONFLICT (business_id, code) DO NOTHING;

-- The Upscale Facial Set is ₦17,000 (already its add-on price). It can now also be ordered on its own.
INSERT INTO products (business_id, code, name, price_minor, description, sort_order, active)
SELECT id, 'facial-set', 'Facial Set', 1700000, 'Facial Detox Toner, Baby Face Whitening Soap and All Clear Face Cream', 50, true
  FROM businesses WHERE slug = 'larose-nigeria'
ON CONFLICT (business_id, code) DO NOTHING;

-- On both Larose pages (GitHub Pages larosenigeria and the Skyfly-hosted copy).
INSERT INTO landing_page_products (landing_page_id, product_id)
SELECT lp.id, p.id
  FROM landing_pages lp
  JOIN businesses b ON b.id = lp.business_id AND b.slug = 'larose-nigeria'
  JOIN products p ON p.business_id = b.id
 WHERE lp.slug IN ('larosenigeria', 'larose-skincare')
   AND p.code IN ('soap-500g', 'soap-500g-oil', 'soap-1l', 'soap-1l-oil', 'soap-2l', 'soap-2l-oil', 'facial-set')
ON CONFLICT DO NOTHING;

-- The Media Buyer's prices and offer (used for its WhatsApp sales scripts and ad copy).
UPDATE ad_profiles ap
   SET prices = '500g African Soap ₦20,500; 500g Soap + Oil ₦30,500; 1 Litre Soap ₦26,500; 1 Litre Soap + Oil ₦36,500; 2 Litres Soap ₦44,500; 2 Litres Soap + Oil ₦54,500; Upscale Facial Set ₦17,000',
       offer = '500g African Soap starter package for ₦20,500 (main advertised offer). Free delivery anywhere in Nigeria within our regular delivery coverage; for remote locations, villages or areas outside our normal delivery jurisdiction an additional ₦3,000 may apply, confirmed by our receptionist before dispatch. Pay on delivery.',
       updated_at = now()
  FROM businesses b
 WHERE b.id = ap.business_id AND b.slug = 'larose-nigeria';
