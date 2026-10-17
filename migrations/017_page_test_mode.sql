-- Test mode for a landing page: every order it takes is saved as a test order
-- (never counted in sales, never sent as a Purchase, never emailed).
ALTER TABLE landing_pages ADD COLUMN test_mode BOOLEAN NOT NULL DEFAULT false;
