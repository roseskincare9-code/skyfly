-- Client contact details for onboarding (all optional; existing businesses are unchanged).
ALTER TABLE businesses
  ADD COLUMN contact_name TEXT CHECK (length(contact_name) <= 120),
  ADD COLUMN contact_phone TEXT CHECK (length(contact_phone) <= 40),
  ADD COLUMN contact_email TEXT CHECK (length(contact_email) <= 200),
  ADD COLUMN website TEXT CHECK (length(website) <= 300);
