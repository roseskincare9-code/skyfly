-- Public business registration (one link for every new business owner): /signup creates the owner's
-- account and their own business (a trial for the platform's trial days). The platform owner can
-- switch back to "by invitation only" at any time in Platform admin → Platform settings.
INSERT INTO platform_settings (key, value, updated_at) VALUES ('client_signup', '"open"', now())
ON CONFLICT (key) DO UPDATE SET value = '"open"', updated_at = now();
