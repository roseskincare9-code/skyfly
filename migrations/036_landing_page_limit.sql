-- How many landing pages a business may have (archived pages don't count). Default 4; the platform
-- admin changes it per business (Platform admin → business → Landing page limit). A business that
-- already has more pages keeps them: its limit starts at its current number. Nothing is deleted.
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS max_landing_pages INTEGER NOT NULL DEFAULT 4
  CHECK (max_landing_pages BETWEEN 1 AND 1000);
UPDATE businesses b SET max_landing_pages = GREATEST(4, (SELECT count(*)::int FROM landing_pages lp WHERE lp.business_id = b.id AND lp.status <> 'archived'))
 WHERE (SELECT count(*) FROM landing_pages lp WHERE lp.business_id = b.id AND lp.status <> 'archived') > 4;
