-- Result of Skyfly's own check that a published page's public address answers (never shown as live without it).
ALTER TABLE landing_pages
  ADD COLUMN live_status TEXT,
  ADD COLUMN live_checked_at TIMESTAMPTZ;
