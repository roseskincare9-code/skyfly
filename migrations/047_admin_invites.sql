-- Separate Super Admin identities: a Super Admin can invite a NEW admin-only account (no business) by a
-- one-time link (only its hash is stored, valid 48 hours). Additive: a new table, nothing else changes.
CREATE TABLE IF NOT EXISTS admin_invites (
  id BIGSERIAL PRIMARY KEY,
  email TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  accepted_at TIMESTAMPTZ,
  accepted_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  revoked_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS admin_invites_email_idx ON admin_invites (lower(email));
