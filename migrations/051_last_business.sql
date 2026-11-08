-- The workspace a member last opened, so signing in again (or opening "/") returns to it instead of
-- showing every business on the account. Only a convenience: access is still checked against
-- business_members on every request. Additive only.
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_business_id BIGINT REFERENCES businesses(id) ON DELETE SET NULL;
