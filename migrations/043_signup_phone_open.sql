-- Public business registration opened by the platform owner (1 Nov 2026): anyone with the link
-- https://getskyfly.com/signup can register a business without an invitation. Registration also asks
-- for the owner's phone number, kept on the owner's account. Existing accounts keep no phone (NULL);
-- nothing else changes. Switch back to "by invitation only" in Platform admin → Platform settings.
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone TEXT;
INSERT INTO platform_settings (key, value, updated_at) VALUES ('client_signup', '"open"', now())
ON CONFLICT (key) DO UPDATE SET value = '"open"', updated_at = now();
