-- When SheetDB answers "request limit exceeded" (429), copies to that sheet pause until this time.
ALTER TABLE sheet_connections ADD COLUMN quota_until TIMESTAMPTZ;
