-- "Verification failed" for a tracking ID: when the platform refused Skyfly's last test or server event.
-- Cleared again by the next event the platform accepts. Nothing existing changes.
ALTER TABLE tracking_pixels ADD COLUMN IF NOT EXISTS verification_failed_at TIMESTAMPTZ;
ALTER TABLE tracking_pixels ADD COLUMN IF NOT EXISTS verification_error TEXT;
