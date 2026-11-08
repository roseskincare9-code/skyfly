-- Renewal manager and backup status. Additive only: new columns and tables, plus the database's verified
-- plan (6 Nov 2026, Render API) on the row that still says "Free". No customer data is touched.

-- Payment method status at the provider (never card details: only whether one is on file and usable).
ALTER TABLE infra_services ADD COLUMN IF NOT EXISTS payment_method_status TEXT NOT NULL DEFAULT 'unknown';
DO $$ BEGIN
  ALTER TABLE infra_services ADD CONSTRAINT infra_services_payment_method_check
    CHECK (payment_method_status IN ('on_file', 'missing', 'expired', 'failed', 'not_needed', 'unknown'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Each renewal a Super Admin records, with the evidence (invoice or receipt reference). For a domain, whether
-- the registry already shows the new expiry date is checked separately and never assumed.
CREATE TABLE IF NOT EXISTS infra_service_renewals (
  id BIGSERIAL PRIMARY KEY,
  service_id BIGINT NOT NULL REFERENCES infra_services(id) ON DELETE CASCADE,
  renewed_on DATE NOT NULL,
  previous_date DATE,
  new_date DATE NOT NULL,
  amount_minor BIGINT CHECK (amount_minor IS NULL OR amount_minor >= 0),
  currency TEXT,
  evidence TEXT NOT NULL CHECK (length(evidence) BETWEEN 3 AND 200),
  registry_expires_on DATE,
  created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS infra_service_renewals_service_idx ON infra_service_renewals (service_id, id DESC);

-- Backups and restore tests reported by the GitHub Actions jobs (with the server's backup key). Only
-- times, sizes, checksums and counts: never data.
CREATE TABLE IF NOT EXISTS backup_runs (
  id BIGSERIAL PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('backup', 'restore_test')),
  status TEXT NOT NULL CHECK (status IN ('success', 'failed')),
  run_id TEXT,
  run_url TEXT,
  size_bytes BIGINT,
  sha256 TEXT,
  tables INT,
  total_rows BIGINT,
  detail TEXT,
  notified TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS backup_runs_kind_idx ON backup_runs (kind, id DESC);

-- skyfly-db was upgraded in place to Basic-1gb on 6 Nov 2026 (Render API: plan basic_1gb, available, no
-- expiry; card on file because Render accepted the change). Render bills after use: the first invoice is
-- expected at the start of December, so the date is an estimate to be corrected from the invoice.
UPDATE infra_services
   SET plan = 'Basic-1gb (1 GB storage)', price_minor = 1930, currency = 'USD', billing_frequency = 'monthly',
       expires_on = NULL, next_payment_on = '2026-12-01', payment_status = 'due', payment_method_status = 'on_file',
       manage_url = 'https://dashboard.render.com/billing',
       notes = 'Upgraded in place on 6 Nov 2026: plan basic_1gb, status available, no expiry (Render API). About $19.00 + $0.30 storage a month. Render bills after use; first invoice expected early December (date estimated: correct it from the invoice and record the payment). Payment not yet confirmed by an invoice.',
       updated_at = now()
 WHERE name = 'Skyfly database (skyfly-db)' AND plan = 'Free';

-- The card is on the Render workspace (Render accepted the database upgrade with it).
UPDATE infra_services SET payment_method_status = 'on_file', updated_at = now()
 WHERE name = 'Skyfly web service' AND payment_method_status = 'unknown';
UPDATE infra_services SET payment_method_status = 'not_needed', updated_at = now()
 WHERE billing_frequency = 'free' AND name IN ('Code, CI and encrypted backups', 'Google Sheets API', 'Bot protection (Turnstile)') AND payment_method_status = 'unknown';
