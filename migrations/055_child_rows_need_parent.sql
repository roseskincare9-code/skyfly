-- Tenancy hardening: an order line or status-history row always belongs to an order (and so to exactly
-- one business). Applied only when no row lacks its order, so this never fails and never changes data;
-- otherwise a notice is logged and the columns stay as they are.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM order_items WHERE order_id IS NULL) THEN
    ALTER TABLE order_items ALTER COLUMN order_id SET NOT NULL;
  ELSE
    RAISE NOTICE 'order_items has rows without an order: order_id left nullable';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM order_status_history WHERE order_id IS NULL) THEN
    ALTER TABLE order_status_history ALTER COLUMN order_id SET NOT NULL;
  ELSE
    RAISE NOTICE 'order_status_history has rows without an order: order_id left nullable';
  END IF;
END $$;
