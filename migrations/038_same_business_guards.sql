-- Database-level tenant guard: a record may only point at records of its own business (an order at its
-- own business's landing page, an order line at its own business's product, a pixel at its own pages,
-- and so on). The application already checks this on every request; these triggers make the database
-- refuse a cross-business link even if a future code change forgets to. They check new and changed
-- links only; existing rows are left exactly as they are (nothing is rewritten or deleted).
-- (Sheet connections and email automation steps already have composite foreign keys for the same rule.)
CREATE OR REPLACE FUNCTION skyfly_same_business() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  ref_col text := TG_ARGV[0];          -- the column pointing at another record
  parent text := TG_ARGV[1];           -- the table it points at (has business_id)
  anchor_col text := NULLIF(TG_ARGV[2], '');   -- for tables without business_id: the column that leads to
  anchor_table text := NULLIF(TG_ARGV[3], ''); -- the row's own business (e.g. order_items.order_id -> orders)
  r jsonb := to_jsonb(NEW);
  mine bigint;
  theirs bigint;
BEGIN
  IF r->>ref_col IS NULL THEN RETURN NEW; END IF;
  IF anchor_table IS NULL THEN
    mine := (r->>'business_id')::bigint;
  ELSE
    EXECUTE format('SELECT business_id FROM %I WHERE id = $1', anchor_table) INTO mine USING (r->>anchor_col)::bigint;
  END IF;
  EXECUTE format('SELECT business_id FROM %I WHERE id = $1', parent) INTO theirs USING (r->>ref_col)::bigint;
  IF mine IS DISTINCT FROM theirs THEN
    RAISE EXCEPTION 'cross-business reference refused: %.% points to a % record of another business', TG_TABLE_NAME, ref_col, parent
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;

-- A published version must be one of the page's own versions.
CREATE OR REPLACE FUNCTION skyfly_own_published_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.published_version_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM page_versions v WHERE v.id = NEW.published_version_id AND v.landing_page_id = NEW.id) THEN
    RAISE EXCEPTION 'cross-page reference refused: landing page % cannot publish a version of another page', NEW.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;

DO $$
DECLARE
  g text[];
  guards text[][] := ARRAY[
    -- table, column, parent table, anchor column, anchor table
    ARRAY['orders', 'landing_page_id', 'landing_pages', '', ''],
    ARRAY['order_items', 'product_id', 'products', 'order_id', 'orders'],
    ARRAY['landing_pages', 'upsell_product_id', 'products', '', ''],
    ARRAY['landing_page_products', 'product_id', 'products', 'landing_page_id', 'landing_pages'],
    ARRAY['tracking_pixel_pages', 'landing_page_id', 'landing_pages', 'tracking_pixel_id', 'tracking_pixels'],
    ARRAY['pixel_settings', 'landing_page_id', 'landing_pages', '', ''],
    ARRAY['checkout_sessions', 'landing_page_id', 'landing_pages', '', ''],
    ARRAY['checkout_sessions', 'order_id', 'orders', '', ''],
    ARRAY['sheet_recoveries', 'order_id', 'orders', '', ''],
    ARRAY['email_messages', 'order_id', 'orders', '', ''],
    ARRAY['email_messages', 'contact_id', 'email_contacts', '', ''],
    ARRAY['email_messages', 'template_id', 'email_templates', '', ''],
    ARRAY['email_messages', 'automation_id', 'email_automations', '', ''],
    ARRAY['email_messages', 'step_id', 'email_automation_steps', '', '']
  ];
BEGIN
  FOREACH g SLICE 1 IN ARRAY guards LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', 'same_business_' || g[2], g[1]);
    EXECUTE format('CREATE TRIGGER %I BEFORE INSERT OR UPDATE OF %I ON %I FOR EACH ROW EXECUTE FUNCTION skyfly_same_business(%L, %L, %L, %L)',
      'same_business_' || g[2], g[2], g[1], g[2], g[3], g[4], g[5]);
  END LOOP;
END $$;

DROP TRIGGER IF EXISTS own_published_version ON landing_pages;
CREATE TRIGGER own_published_version BEFORE INSERT OR UPDATE OF published_version_id ON landing_pages
  FOR EACH ROW EXECUTE FUNCTION skyfly_own_published_version();
