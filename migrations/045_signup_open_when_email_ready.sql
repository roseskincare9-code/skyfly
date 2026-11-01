-- The platform owner wants public business registration (1 Nov 2026). Platform setting → open.
-- In production registration still only opens while Skyfly's email sender is configured
-- (config.requireEmailForSignup; src/routes/auth.js), so every new account confirms its email first.
-- Until SKYFLY_NOTIFY_* is set on Render, /signup stays closed. Switch back any time in Platform settings.
UPDATE platform_settings SET value = '"open"', updated_at = now() WHERE key = 'client_signup';
