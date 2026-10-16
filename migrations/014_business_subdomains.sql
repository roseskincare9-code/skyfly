-- Business subdomains on the platform's own domain (e.g. glow.<PLATFORM_DOMAIN>), where a
-- business's published landing pages are served. Inactive until PLATFORM_DOMAIN is set and
-- the domain's DNS points at Skyfly; a value here alone does not make anything live.
ALTER TABLE businesses ADD COLUMN subdomain TEXT
  CHECK (subdomain ~ '^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$');
CREATE UNIQUE INDEX businesses_subdomain_key ON businesses (subdomain) WHERE subdomain IS NOT NULL;
ALTER TABLE businesses ADD COLUMN subdomain_checked_at TIMESTAMPTZ;
ALTER TABLE businesses ADD COLUMN subdomain_status TEXT;
