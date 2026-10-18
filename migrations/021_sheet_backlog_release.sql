-- Orders placed before a Google Sheets API connection was made are held until the owner has
-- compared them with the spreadsheet and released them (set when released). Existing rows are unchanged.
ALTER TABLE sheet_connections ADD COLUMN backlog_released_at timestamptz;
