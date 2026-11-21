-- A business can connect several Meta ad accounts (each verified with its own token, stored encrypted).
-- One of them is the business's SELECTED account (what the AI Media Buyer pages, Cloudy and new drafts use);
-- every draft records the ad account it was prepared for, and approval only ever uses that account.
-- Backward compatible: an existing connection stays, and becomes the selected one. No data is removed.
ALTER TABLE ad_connections DROP CONSTRAINT ad_connections_pkey;
ALTER TABLE ad_connections ADD COLUMN id BIGSERIAL PRIMARY KEY;
ALTER TABLE ad_connections ADD COLUMN selected BOOLEAN NOT NULL DEFAULT false;
UPDATE ad_connections SET selected = true;
CREATE UNIQUE INDEX ad_connections_business_account ON ad_connections (business_id, ad_account_id);
CREATE UNIQUE INDEX ad_connections_one_selected ON ad_connections (business_id) WHERE selected;

ALTER TABLE ad_items ADD COLUMN ad_account_id TEXT CHECK (ad_account_id IS NULL OR ad_account_id ~ '^[0-9]{5,20}$');
UPDATE ad_items i SET ad_account_id = c.ad_account_id FROM ad_connections c WHERE c.business_id = i.business_id AND i.ad_account_id IS NULL;
