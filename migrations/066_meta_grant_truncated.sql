-- Facebook Login account discovery: whether Meta listed more ad accounts than Skyfly shows (never silently cut).
ALTER TABLE meta_oauth_grants ADD COLUMN truncated BOOLEAN NOT NULL DEFAULT false;
