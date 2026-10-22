-- Order notifications to the business: one email per order Skyfly saved (website or API orders),
-- to the business's own notification address once its owner has verified it. Recipients are
-- per business; a public request can never choose one.
ALTER TABLE businesses
  ADD COLUMN notify_email TEXT CHECK (notify_email IS NULL OR (notify_email = lower(notify_email) AND length(notify_email) <= 200)),
  ADD COLUMN notify_enabled BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN notify_verified_at TIMESTAMPTZ,
  ADD COLUMN notify_verify_hash TEXT,
  ADD COLUMN notify_verify_sent_at TIMESTAMPTZ,
  ADD COLUMN notify_since TIMESTAMPTZ;           -- orders saved from this moment on are notified (never older ones)

-- What a page's order button does: a WhatsApp conversation only (no order), Skyfly's checkout,
-- or Skyfly's checkout with an optional WhatsApp button after the order is saved (the existing behaviour).
ALTER TABLE landing_pages
  ADD COLUMN order_destination TEXT NOT NULL DEFAULT 'checkout_whatsapp'
    CHECK (order_destination IN ('whatsapp', 'checkout', 'checkout_whatsapp')),
  ADD COLUMN connection_checked_at TIMESTAMPTZ,
  ADD COLUMN connection_check TEXT;

ALTER TABLE email_messages DROP CONSTRAINT email_messages_kind_check;
ALTER TABLE email_messages ADD CONSTRAINT email_messages_kind_check CHECK (kind IN ('automation', 'test', 'order_notification', 'verification'));
CREATE INDEX email_messages_notify_idx ON email_messages (order_id) WHERE kind = 'order_notification';

-- Larose Skincare Nigeria: the owner's notification address (verified by the owner before any email is sent).
UPDATE businesses SET notify_email = 'laroseskincare3@gmail.com', notify_since = now()
 WHERE slug = 'larose-nigeria' AND notify_email IS NULL;
