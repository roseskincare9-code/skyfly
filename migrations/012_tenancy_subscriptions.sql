-- Multi-tenant client workspaces: platform admin, business members with roles, invites,
-- and owner-managed subscriptions. Additive only: no existing row is changed except to
-- fill the new columns.
--
-- Safety copy first. If this release must be undone, see docs/MIGRATIONS.md: the copies
-- below hold every business, order and related row exactly as they were before 012.
CREATE SCHEMA IF NOT EXISTS backup_before_012;
CREATE TABLE IF NOT EXISTS backup_before_012.businesses AS TABLE businesses;
CREATE TABLE IF NOT EXISTS backup_before_012.orders AS TABLE orders;
CREATE TABLE IF NOT EXISTS backup_before_012.order_items AS TABLE order_items;
CREATE TABLE IF NOT EXISTS backup_before_012.order_status_history AS TABLE order_status_history;
CREATE TABLE IF NOT EXISTS backup_before_012.products AS TABLE products;
CREATE TABLE IF NOT EXISTS backup_before_012.landing_pages AS TABLE landing_pages;
CREATE TABLE IF NOT EXISTS backup_before_012.pixel_settings AS TABLE pixel_settings;

-- The platform owner (the first account) administers every client workspace.
ALTER TABLE users ADD COLUMN is_platform_admin BOOLEAN NOT NULL DEFAULT false;
UPDATE users SET is_platform_admin = true WHERE id = (SELECT min(id) FROM users);

-- Who may use a business, and with which role.
--   owner:   everything in the workspace, including team members
--   manager: everything except team members
--   staff:   overview, orders and customers only
CREATE TABLE business_members (
  business_id BIGINT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'manager', 'staff')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, user_id)
);
CREATE INDEX business_members_user_idx ON business_members (user_id);
INSERT INTO business_members (business_id, user_id, role, created_at)
SELECT id, owner_id, 'owner', created_at FROM businesses;

CREATE TABLE business_invites (
  id BIGSERIAL PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'manager', 'staff')),
  token_hash TEXT NOT NULL UNIQUE,
  created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  accepted_at TIMESTAMPTZ,
  accepted_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  revoked_at TIMESTAMPTZ
);
CREATE INDEX business_invites_business_idx ON business_invites (business_id);

-- Subscriptions, managed by the platform owner (no payment gateway: the owner confirms
-- payment and sets the dates). An account is usable through the whole expiry day in the
-- business's own time zone.
--   internal: the platform's own business, never expires
--   trial / active: usable until the expiry date (no date = no expiry)
--   expired: past the expiry date (set automatically)
--   locked: blocked by the platform owner
ALTER TABLE businesses
  ADD COLUMN timezone TEXT NOT NULL DEFAULT 'Africa/Lagos',
  ADD COLUMN subscription_status TEXT NOT NULL DEFAULT 'active'
    CHECK (subscription_status IN ('internal', 'trial', 'active', 'expired', 'locked')),
  ADD COLUMN subscription_price_minor BIGINT CHECK (subscription_price_minor >= 0),
  ADD COLUMN subscription_currency TEXT NOT NULL DEFAULT 'NGN',
  ADD COLUMN subscription_started_on DATE,
  ADD COLUMN subscription_expires_on DATE,
  ADD COLUMN subscription_notes TEXT,
  ADD COLUMN subscription_updated_at TIMESTAMPTZ;
UPDATE businesses SET subscription_status = 'internal' WHERE slug = 'larose-nigeria';

CREATE TABLE platform_settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO platform_settings (key, value) VALUES
  ('client_signup', '"invite_only"'),
  ('trial_days', '7'),
  ('renewal_instructions', '"Your Skyfly subscription has ended. Please contact the Skyfly team to renew. Your orders, customers and settings are kept safe and will be available again as soon as your account is renewed."');
