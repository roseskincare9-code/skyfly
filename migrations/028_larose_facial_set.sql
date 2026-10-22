-- Larose Skincare Nigeria: the Facial Set as the optional add-on at checkout (owner's request,
-- 2026-10-22): ₦17,000 as an add-on (₦25,000 shown crossed out). It is a product of Larose only, not
-- one of the page's packages. It becomes the add-on of Larose's pages only where none is set yet.
INSERT INTO products (business_id, code, name, price_minor, compare_at_price_minor, description, sort_order, active)
SELECT id, 'facial-set', 'Facial Set', 1700000, 2500000,
       'Facial Detox Toner, Baby Face Whitening Soap and All Clear Face Cream', 50, true
  FROM businesses WHERE slug = 'larose-nigeria'
ON CONFLICT (business_id, code) DO NOTHING;

UPDATE landing_pages lp
   SET upsell_product_id = p.id,
       upsell_headline = 'LaRose Complete Facial Set',
       upsell_text = 'Facial Detox Toner, Baby Face Whitening Soap and All Clear Face Cream, at a special price when added to this order.'
  FROM products p JOIN businesses b ON b.id = p.business_id
 WHERE b.slug = 'larose-nigeria' AND p.code = 'facial-set' AND lp.business_id = b.id
   AND lp.slug IN ('larosenigeria', 'larose-skincare') AND lp.upsell_product_id IS NULL;
