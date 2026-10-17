-- Browser Purchase is now allowed: it fires once per order, only after Skyfly has saved the
-- order (never for test orders), with the order reference as event ID.
ALTER TABLE pixel_settings DROP CONSTRAINT pixel_settings_events_check;
ALTER TABLE pixel_settings ADD CONSTRAINT pixel_settings_events_check
  CHECK (events <@ ARRAY['PageView', 'ViewContent', 'InitiateCheckout', 'Lead', 'Purchase']);

-- Larose's Meta Pixel (ID unchanged) counts a Purchase when Skyfly saves an order.
UPDATE pixel_settings SET events = array_append(events, 'Purchase'), updated_at = now()
 WHERE provider = 'meta' AND pixel_id = '1357015185691765' AND NOT ('Purchase' = ANY(events))
   AND business_id IN (SELECT id FROM businesses WHERE slug = 'larose-nigeria');
