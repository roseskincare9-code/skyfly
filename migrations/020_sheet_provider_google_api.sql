-- Google Sheets API connections (Skyfly's service account; no Apps Script). Existing rows are unchanged.
ALTER TABLE sheet_connections DROP CONSTRAINT sheet_connections_provider_check;
ALTER TABLE sheet_connections ADD CONSTRAINT sheet_connections_provider_check CHECK (provider IN ('sheetdb', 'apps_script', 'google_api'));
