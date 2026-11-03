-- Super Admin infrastructure manager: the platform's paid (and free) services, their plans, prices and
-- renewal dates, entered by the Super Admin (never credentials). Renewal reminders are recorded once per
-- service, threshold and due date. Plus account requests (data export / account deletion) from users,
-- handled by a Super Admin. Additive only.
CREATE TABLE IF NOT EXISTS infra_services (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  provider TEXT NOT NULL CHECK (length(provider) BETWEEN 1 AND 80),
  category TEXT NOT NULL DEFAULT 'other',
  plan TEXT,
  price_minor BIGINT CHECK (price_minor IS NULL OR price_minor >= 0),
  currency TEXT NOT NULL DEFAULT 'USD',
  billing_frequency TEXT NOT NULL DEFAULT 'monthly' CHECK (billing_frequency IN ('monthly', 'yearly', 'one_time', 'free', 'usage')),
  last_paid_on DATE,
  next_payment_on DATE,
  expires_on DATE,
  auto_renew BOOLEAN,
  manage_url TEXT,
  payment_status TEXT NOT NULL DEFAULT 'unknown' CHECK (payment_status IN ('paid', 'due', 'overdue', 'failed', 'free', 'unknown')),
  invoice_ref TEXT,
  notes TEXT,
  created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  updated_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS infra_service_reminders (
  id BIGSERIAL PRIMARY KEY,
  service_id BIGINT NOT NULL REFERENCES infra_services(id) ON DELETE CASCADE,
  threshold TEXT NOT NULL,
  due_on DATE NOT NULL,
  status TEXT NOT NULL,
  detail TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (service_id, threshold, due_on)
);
CREATE TABLE IF NOT EXISTS account_requests (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('export', 'deletion')),
  note TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'declined')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  handled_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  handled_at TIMESTAMPTZ,
  response TEXT
);
CREATE INDEX IF NOT EXISTS account_requests_open_idx ON account_requests (status, created_at);
