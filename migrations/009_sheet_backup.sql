-- Google Sheet backup, done by the server (SheetDB API URL per business), with a
-- visible sync status per order and safe retries.
ALTER TABLE businesses ADD COLUMN sheet_backup_url TEXT;
UPDATE businesses SET sheet_backup_url = 'https://sheetdb.io/api/v1/m111fq96ve953'
 WHERE slug = 'larose-nigeria' AND sheet_backup_url IS NULL;

ALTER TABLE orders
  ADD COLUMN sheet_sync_status TEXT NOT NULL DEFAULT 'pending' CHECK (sheet_sync_status IN ('pending', 'synced', 'failed', 'skipped')),
  ADD COLUMN sheet_sync_attempts INT NOT NULL DEFAULT 0,
  ADD COLUMN sheet_sync_error TEXT,
  ADD COLUMN sheet_synced_at TIMESTAMPTZ,
  ADD COLUMN sheet_sync_next_at TIMESTAMPTZ NOT NULL DEFAULT now();
-- Orders that existed before this feature were already copied by the page (or never meant to be).
UPDATE orders SET sheet_sync_status = 'skipped';
CREATE INDEX orders_sheet_sync_due_idx ON orders (sheet_sync_next_at) WHERE sheet_sync_status IN ('pending', 'failed');

-- Google Sheet rows that reached only the Sheet (Skyfly was unreachable) and were added to Skyfly later.
CREATE TABLE sheet_recoveries (
  id BIGSERIAL PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  row_key TEXT NOT NULL,
  order_id BIGINT REFERENCES orders(id) ON DELETE SET NULL,
  recovered_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, row_key)
);
