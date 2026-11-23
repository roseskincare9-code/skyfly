-- AI Media Buyer: connect ad accounts with the official Facebook Login (OAuth), beside the existing
-- System User token form.
--   meta_oauth_states: one-time, 10-minute "state" values (stored hashed) that tie a Facebook Login
--     round trip to the signed-in user AND the business that started it.
--   meta_oauth_grants: the result of one login (encrypted long-lived token + the ad accounts Meta lists
--     for that person), kept 30 minutes so the owner can pick which accounts to connect. Scoped to the
--     business and the user; deleted once used.
CREATE TABLE meta_oauth_states (
  state_hash TEXT PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX meta_oauth_states_business ON meta_oauth_states (business_id);

CREATE TABLE meta_oauth_grants (
  id BIGSERIAL PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_enc TEXT NOT NULL,
  token_expires_at TIMESTAMPTZ,
  meta_user_name TEXT,
  granted TEXT[] NOT NULL DEFAULT '{}',
  declined TEXT[] NOT NULL DEFAULT '{}',
  accounts JSONB NOT NULL DEFAULT '[]',
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX meta_oauth_grants_business ON meta_oauth_grants (business_id, user_id);

ALTER TABLE ad_connections
  ADD COLUMN connected_via TEXT NOT NULL DEFAULT 'token' CHECK (connected_via IN ('token', 'facebook_login')),
  ADD COLUMN token_expires_at TIMESTAMPTZ;
