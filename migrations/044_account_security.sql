-- Account security (1 Nov 2026). Additive only: no existing row changes except one platform setting.
-- 1. Terms and privacy acceptance at registration: when and which version. Existing accounts stay NULL
--    (they never ticked the box; nothing is assumed for them).
-- 2. Disabling an account (Super Admin), reversible: who, when and why. NULL = active (every account now).
-- 3. Sign-in, registration and password-reset attempts per account/address (only a hash of the email or
--    IP is stored), for per-account limits. Rows older than a day are removed by the app.
-- 4. Public registration back to "by invitation only" until email verification works in production
--    (the owner's instruction). It cannot be reopened in production without an email sender.
ALTER TABLE users ADD COLUMN IF NOT EXISTS terms_accepted_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS terms_version TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS disabled_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS disabled_reason TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS disabled_by BIGINT REFERENCES users(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS auth_attempts (
  id BIGSERIAL PRIMARY KEY,
  kind TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS auth_attempts_lookup_idx ON auth_attempts (kind, key_hash, created_at);

UPDATE platform_settings SET value = '"invite_only"', updated_at = now() WHERE key = 'client_signup';
