-- Product details shown at checkout, and options with their own price (e.g. Size: 50ml +₦5,000).
-- options: [{"name":"Size","values":[{"label":"30ml","delta_minor":0},{"label":"50ml","delta_minor":500000}]}]
ALTER TABLE products
  ADD COLUMN description TEXT CHECK (description IS NULL OR length(description) <= 500),
  ADD COLUMN compare_at_price_minor BIGINT CHECK (compare_at_price_minor IS NULL OR compare_at_price_minor >= 0),
  ADD COLUMN options JSONB NOT NULL DEFAULT '[]';

-- Delivery fee charged by the business (0 = free), optionally free from an order subtotal.
ALTER TABLE businesses
  ADD COLUMN delivery_fee_minor BIGINT NOT NULL DEFAULT 0 CHECK (delivery_fee_minor >= 0),
  ADD COLUMN free_delivery_from_minor BIGINT CHECK (free_delivery_from_minor IS NULL OR free_delivery_from_minor >= 0);

-- What each order charged for delivery (included in total_minor), and each item's chosen options.
ALTER TABLE orders ADD COLUMN delivery_fee_minor BIGINT NOT NULL DEFAULT 0 CHECK (delivery_fee_minor >= 0);
ALTER TABLE order_items ADD COLUMN options JSONB;
