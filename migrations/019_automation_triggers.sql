-- More automation triggers:
--   unpaid  = days after the order while it is not marked Paid (stops once Paid, Refunded,
--             Cancelled or Returned). About the order's payment only; not a "non-buyer" label.
--   winback = days after a customer's most recent order, only while they have not ordered again.
ALTER TABLE email_automations DROP CONSTRAINT email_automations_kind_check;
ALTER TABLE email_automations ADD CONSTRAINT email_automations_kind_check CHECK (kind IN ('processing', 'post_purchase', 'unpaid', 'winback'));
ALTER TABLE email_automations DROP CONSTRAINT email_automations_anchor_check;
ALTER TABLE email_automations ADD CONSTRAINT email_automations_anchor_check
  CHECK (anchor IN ('processing_since', 'order_date', 'delivered_date', 'unpaid_since', 'last_order'));
ALTER TABLE email_automations ADD CONSTRAINT email_automations_unpaid_anchor CHECK ((kind = 'unpaid') = (anchor = 'unpaid_since'));
ALTER TABLE email_automations ADD CONSTRAINT email_automations_winback_anchor CHECK ((kind = 'winback') = (anchor = 'last_order'));
