-- Optimized image variants (WebP, several widths) generated for a page version's images,
-- and each image's size. Used when serving the page; the original files are unchanged.
ALTER TABLE page_versions ADD COLUMN image_meta JSONB;

-- Spreadsheet connections can also use the business's own Google Apps Script (no SheetDB).
ALTER TABLE sheet_connections DROP CONSTRAINT sheet_connections_provider_check;
ALTER TABLE sheet_connections ADD CONSTRAINT sheet_connections_provider_check CHECK (provider IN ('sheetdb', 'apps_script'));
