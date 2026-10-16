-- Central Google Sheets: each business keeps its spreadsheet connections in one place.
-- New landing pages use the business's default sheet; a page may override it.
-- Composite foreign keys (business_id, id) make it impossible to point a page, a
-- business or an order at another business's spreadsheet.
CREATE TABLE sheet_connections (
  id BIGSERIAL PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'sheetdb' CHECK (provider IN ('sheetdb')),
  api_url_enc TEXT NOT NULL,           -- the SheetDB API URL, encrypted (it lets anyone write rows)
  api_url_hash TEXT NOT NULL,          -- to refuse the same sheet twice
  api_hint TEXT NOT NULL,              -- last characters, for display
  sheet_tab TEXT,                      -- tab (worksheet) name; NULL = the first tab
  spreadsheet_url TEXT,                -- Google Sheets link for "Open spreadsheet"
  check_status TEXT NOT NULL DEFAULT 'unchecked' CHECK (check_status IN ('unchecked', 'ok', 'needs_columns', 'error')),
  check_detail TEXT,
  sheet_columns JSONB,
  checked_at TIMESTAMPTZ,
  auto_setup_at TIMESTAMPTZ,           -- when Skyfly tried to add the column row to an empty sheet itself
  last_success_at TIMESTAMPTZ,
  last_error TEXT,
  last_error_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, id)
);
CREATE UNIQUE INDEX sheet_connections_unique_target ON sheet_connections (business_id, api_url_hash, coalesce(sheet_tab, ''));

ALTER TABLE businesses ADD COLUMN default_sheet_connection_id BIGINT;
ALTER TABLE businesses ADD CONSTRAINT businesses_default_sheet_fk
  FOREIGN KEY (id, default_sheet_connection_id) REFERENCES sheet_connections (business_id, id);

ALTER TABLE landing_pages ADD COLUMN sheet_connection_id BIGINT;
ALTER TABLE landing_pages ADD CONSTRAINT landing_pages_sheet_fk
  FOREIGN KEY (business_id, sheet_connection_id) REFERENCES sheet_connections (business_id, id);

-- The sheet an order is (or was) copied to.
ALTER TABLE orders ADD COLUMN sheet_connection_id BIGINT;
ALTER TABLE orders ADD CONSTRAINT orders_sheet_fk
  FOREIGN KEY (business_id, sheet_connection_id) REFERENCES sheet_connections (business_id, id);
CREATE INDEX orders_sheet_connection_idx ON orders (sheet_connection_id) WHERE sheet_connection_id IS NOT NULL;
-- businesses.sheet_backup_url is moved into sheet_connections (encrypted) by the app on start.
