-- Email verification for accounts. Existing accounts (created by the platform owner, by invitation, or
-- the owner's own) are treated as verified from their creation date, so nobody is locked out. New
-- self-registered accounts verify by a one-time emailed link when Skyfly's email sender is set up.
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ;
UPDATE users SET email_verified_at = created_at WHERE email_verified_at IS NULL;

CREATE TABLE IF NOT EXISTS email_verifications (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS email_verifications_user_idx ON email_verifications (user_id);
