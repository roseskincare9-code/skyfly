-- Email contacts and automations per business: the business's own sending provider,
-- contacts with consent and unsubscribe status, owner-written templates, automation
-- sequences (order still processing, post-purchase), and one row per email that will be
-- or was sent. Unique keys make a second send of the same step for the same order impossible.

-- Did the customer tick "send me offers" at checkout (only if the page asks)?
ALTER TABLE orders ADD COLUMN marketing_consent BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE email_settings (
  business_id BIGINT PRIMARY KEY REFERENCES businesses(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('resend', 'brevo', 'sendgrid')),
  api_key_enc TEXT,                 -- encrypted with SKYFLY_ENCRYPTION_KEY, never shown again
  api_key_hint TEXT,
  from_email TEXT,
  from_name TEXT,
  reply_to TEXT,
  postal_address TEXT,              -- shown in the footer of marketing emails
  verified_at TIMESTAMPTZ,          -- last time a test email was accepted by the provider
  last_error TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE email_contacts (
  id BIGSERIAL PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  email TEXT NOT NULL CHECK (email = lower(email) AND length(email) <= 200),
  name TEXT,
  phone TEXT,
  source TEXT NOT NULL DEFAULT 'order' CHECK (source IN ('order', 'manual')),
  marketing_consent BOOLEAN NOT NULL DEFAULT false,
  consent_at TIMESTAMPTZ,
  consent_source TEXT,
  unsubscribed_at TIMESTAMPTZ,      -- no automated emails at all after this
  suppressed_at TIMESTAMPTZ,        -- bounced / complained / blocked by the owner
  suppressed_reason TEXT,
  unsubscribe_token TEXT NOT NULL UNIQUE DEFAULT replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, email),
  UNIQUE (business_id, id)
);

-- Existing customers with an email become contacts (without marketing consent).
INSERT INTO email_contacts (business_id, email, name, phone, source)
SELECT DISTINCT ON (business_id, lower(email)) business_id, lower(email), customer_name, phone, 'order'
  FROM orders WHERE email IS NOT NULL AND NOT is_test
 ORDER BY business_id, lower(email), created_at DESC
ON CONFLICT DO NOTHING;

CREATE TABLE email_templates (
  id BIGSERIAL PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  subject TEXT NOT NULL CHECK (length(subject) BETWEEN 1 AND 200),
  body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 20000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, id)
);

-- kind: processing    = while an order stays in Processing (anchor: when it entered Processing)
--       post_purchase = after the order date or after delivery
CREATE TABLE email_automations (
  id BIGSERIAL PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  kind TEXT NOT NULL CHECK (kind IN ('processing', 'post_purchase')),
  anchor TEXT NOT NULL CHECK (anchor IN ('processing_since', 'order_date', 'delivered_date')),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'paused', 'stopped')),
  activated_at TIMESTAMPTZ,         -- only orders reaching the trigger after this get emails
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, id),
  CHECK ((kind = 'processing') = (anchor = 'processing_since'))
);

-- purpose: operational (about the customer's order or product use) or marketing (offers,
-- needs consent). Steps are never hard-deleted once used, so their send history stays.
CREATE TABLE email_automation_steps (
  id BIGSERIAL PRIMARY KEY,
  business_id BIGINT NOT NULL,
  automation_id BIGINT NOT NULL,
  template_id BIGINT NOT NULL,
  delay_days INT NOT NULL CHECK (delay_days BETWEEN 0 AND 365),
  send_hour INT NOT NULL DEFAULT 10 CHECK (send_hour BETWEEN 0 AND 23),
  purpose TEXT NOT NULL DEFAULT 'operational' CHECK (purpose IN ('operational', 'marketing')),
  removed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, automation_id) REFERENCES email_automations (business_id, id) ON DELETE CASCADE,
  FOREIGN KEY (business_id, template_id) REFERENCES email_templates (business_id, id)
);
CREATE INDEX email_steps_automation_idx ON email_automation_steps (automation_id);

-- One row per email: queued -> sending -> sent / failed; or skipped / cancelled with a reason.
CREATE TABLE email_messages (
  id BIGSERIAL PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('automation', 'test')),
  automation_id BIGINT REFERENCES email_automations(id) ON DELETE SET NULL,
  step_id BIGINT REFERENCES email_automation_steps(id) ON DELETE SET NULL,
  template_id BIGINT REFERENCES email_templates(id) ON DELETE SET NULL,
  order_id BIGINT REFERENCES orders(id) ON DELETE SET NULL,
  contact_id BIGINT REFERENCES email_contacts(id) ON DELETE SET NULL,
  to_email TEXT NOT NULL,
  subject TEXT,
  purpose TEXT NOT NULL DEFAULT 'operational' CHECK (purpose IN ('operational', 'marketing')),
  scheduled_for TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sending', 'sent', 'failed', 'skipped', 'cancelled')),
  reason TEXT,
  outcome_unknown BOOLEAN NOT NULL DEFAULT false,   -- the server stopped while sending
  attempts INT NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ,
  provider TEXT,
  provider_message_id TEXT,
  sent_at TIMESTAMPTZ,
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX email_messages_due_idx ON email_messages (scheduled_for) WHERE status = 'queued';
CREATE INDEX email_messages_business_idx ON email_messages (business_id, created_at DESC);
CREATE INDEX email_messages_order_idx ON email_messages (order_id) WHERE order_id IS NOT NULL;
