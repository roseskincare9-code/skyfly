-- Infrastructure inventory: the services Skyfly runs on, as verified on 3 Nov 2026 (Render API, domain
-- registry). Entered once; anything already recorded under the same name is left alone. Prices that are not
-- known exactly are left empty for the Super Admin to fill in. No credentials. Additive only.
INSERT INTO infra_services (name, provider, category, plan, price_minor, currency, billing_frequency, expires_on, auto_renew, manage_url, payment_status, notes)
SELECT v.name, v.provider, v.category, v.plan, v.price_minor, v.currency, v.billing_frequency, v.expires_on::date, v.auto_renew, v.manage_url, v.payment_status, v.notes
  FROM (VALUES
    ('Skyfly web service', 'Render', 'hosting', 'Free', 0::bigint, 'USD', 'free', NULL, NULL::boolean, 'https://dashboard.render.com', 'free',
     'Service "skyfly" (Frankfurt). Free instances sleep after 15 idle minutes. Recommended: Starter before public launch (owner approval).'),
    ('Skyfly database (skyfly-db)', 'Render', 'database', 'Free', 0::bigint, 'USD', 'free', '2026-11-14', NULL::boolean, 'https://dashboard.render.com', 'free',
     'PostgreSQL 16, Frankfurt. FREE PLAN EXPIRES 2026-11-14 13:40 UTC. Upgrade in place to Basic-256mb before then (owner approval). See docs/database-continuity.md.'),
    ('getskyfly.com domain', 'Cloudflare Registrar', 'domain', 'Domain registration', NULL::bigint, 'USD', 'yearly', '2027-10-30', NULL::boolean, 'https://dash.cloudflare.com', 'paid',
     'Registered 2026-10-30, expiry 2027-10-30 read from the registry. Enter the yearly price and confirm auto-renew.'),
    ('Code, CI and encrypted backups', 'GitHub', 'other', 'Free (public repository)', 0::bigint, 'USD', 'free', NULL, NULL::boolean, 'https://github.com/settings/billing', 'free',
     'Repository roseskincare9-code/skyfly; Actions run tests, live checks and daily encrypted backups (kept 30 days).'),
    ('Google Sheets API', 'Google Cloud', 'other', 'Free usage', 0::bigint, 'USD', 'free', NULL, NULL::boolean, 'https://console.cloud.google.com/billing', 'free',
     'Service account of project skyfly-sheets, used to copy orders to a business''s spreadsheet.'),
    ('Transactional email', 'Resend', 'email', 'Not set up yet', NULL::bigint, 'USD', 'monthly', NULL, NULL::boolean, 'https://resend.com/settings/billing', 'unknown',
     'NOT CONFIGURED: needed for verification and password-reset emails (SKYFLY_NOTIFY_* on Render). Free tier to start.'),
    ('Bot protection (Turnstile)', 'Cloudflare', 'security', 'Not set up yet', 0::bigint, 'USD', 'free', NULL, NULL::boolean, 'https://dash.cloudflare.com/?to=/:account/turnstile', 'free',
     'NOT CONFIGURED: needed for public registration (TURNSTILE_SITE_KEY, TURNSTILE_SECRET_KEY on Render).')
  ) AS v(name, provider, category, plan, price_minor, currency, billing_frequency, expires_on, auto_renew, manage_url, payment_status, notes)
 WHERE NOT EXISTS (SELECT 1 FROM infra_services s WHERE lower(s.name) = lower(v.name));

-- The platform's own domain in Domains, so its registry expiry is read automatically (every 12 hours).
INSERT INTO platform_domains (domain, registrar_name, registrar_url, notes)
VALUES ('getskyfly.com', 'Cloudflare', 'https://dash.cloudflare.com', 'Skyfly''s main domain. Expiry is read from the registry.')
ON CONFLICT (domain) DO NOTHING;
