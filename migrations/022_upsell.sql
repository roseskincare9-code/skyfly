-- Optional upsell (order bump) per landing page: one of the business's products, offered with an
-- "Add" button at checkout and priced by Skyfly like any other item. Existing rows are unchanged.
ALTER TABLE landing_pages
  ADD COLUMN upsell_product_id bigint REFERENCES products(id) ON DELETE SET NULL,
  ADD COLUMN upsell_headline text,
  ADD COLUMN upsell_text text;
ALTER TABLE order_items ADD COLUMN is_upsell boolean NOT NULL DEFAULT false;
