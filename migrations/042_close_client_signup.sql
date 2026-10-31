-- Public business registration back to "by invitation only", as the platform owner asked, until Super
-- Admin access and business isolation have passed production tests. Reopen in Platform admin →
-- Platform settings → New clients.
UPDATE platform_settings SET value = '"invite_only"', updated_at = now() WHERE key = 'client_signup';
