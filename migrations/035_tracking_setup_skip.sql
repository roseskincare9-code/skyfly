-- Onboarding: the owner chose "Skip for now" on the Overview's "Connect your Meta Pixel" step (it
-- can still be done at any time under Tracking & Pixels). A new, empty column; nothing else changes.
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS tracking_setup_skipped_at TIMESTAMPTZ;
