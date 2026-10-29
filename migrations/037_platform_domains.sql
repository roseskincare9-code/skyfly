-- The platform's own domains (e.g. getskyfly.com) and their renewal. Two kinds of information are
-- kept apart: what the owner typed in (registrar, expiry date, "auto-renew is on") and what Skyfly
-- read from the public domain registry (RDAP): registered or not, registrar, expiry date, status
-- codes. A renewal counts as verified only when the registry's expiry date moves later.
-- No payment details or registrar passwords are ever stored.
CREATE TABLE IF NOT EXISTS platform_domains (
  id SERIAL PRIMARY KEY,
  domain TEXT NOT NULL UNIQUE,
  -- Entered by the owner
  registrar_name TEXT,
  registrar_url TEXT,
  manual_expires_on DATE,
  manual_auto_renew BOOLEAN,
  manual_auto_renew_confirmed_on DATE,
  notes TEXT,
  -- Read from the registry (RDAP)
  rdap_checked_at TIMESTAMPTZ,
  rdap_error TEXT,
  registered BOOLEAN,
  registry_registrar TEXT,
  registry_expires_at TIMESTAMPTZ,
  registry_statuses TEXT[] NOT NULL DEFAULT '{}',
  previous_expires_at TIMESTAMPTZ,
  renewal_verified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per reminder (30, 14 or 7 days before a given expiry date), so each is sent at most once.
CREATE TABLE IF NOT EXISTS platform_domain_reminders (
  id SERIAL PRIMARY KEY,
  domain_id INTEGER NOT NULL REFERENCES platform_domains(id) ON DELETE CASCADE,
  days_before INTEGER NOT NULL CHECK (days_before IN (30, 14, 7)),
  expires_on DATE NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('sent', 'not_sent')),
  detail TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (domain_id, days_before, expires_on)
);
