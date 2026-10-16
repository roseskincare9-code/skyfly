-- New orders are copied to the Google Sheet a few minutes after they are saved, so a row
-- the landing page writes itself is found first and never doubled.
ALTER TABLE orders ALTER COLUMN sheet_sync_next_at SET DEFAULT now() + interval '3 minutes';
