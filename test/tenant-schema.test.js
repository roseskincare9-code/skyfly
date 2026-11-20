// Database-level tenancy guard: every table is classified. Business-owned tables carry a NOT NULL
// business_id with a foreign key to businesses; child tables reach a business only through a parent row
// (with a foreign key); platform tables hold no business data. A new table fails this test until it is
// classified, so nothing can be added without deciding how it is isolated.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setup, resetDatabase } from './helpers.js';

const BUSINESS_OWNED = ['ad_connections', 'ad_creatives', 'ad_items', 'ad_messages', 'ad_profiles', 'additional_pixels', 'api_keys', 'business_invites', 'business_members', 'checkout_sessions', 'email_automation_steps', 'email_automations',
  'email_contacts', 'email_messages', 'email_settings', 'email_templates', 'landing_pages', 'orders', 'payment_connections', 'payment_oauth_states',
  'payment_transactions', 'pixel_settings', 'products', 'sheet_connections', 'sheet_recoveries', 'subscription_payments', 'subscription_reminders', 'tracking_pixels'];
// child table → [column, parent table]
const CHILDREN = {
  order_items: ['order_id', 'orders'], order_status_history: ['order_id', 'orders'], page_versions: ['landing_page_id', 'landing_pages'],
  page_files: ['version_id', 'page_versions'], landing_page_products: ['landing_page_id', 'landing_pages'], tracking_pixel_pages: ['tracking_pixel_id', 'tracking_pixels'],
  conversion_events: ['order_id', 'orders'], payment_webhook_events: ['order_id', 'orders'],
};
const PLATFORM = ['account_requests', 'admin_invites', 'audit_log', 'auth_attempts', 'backup_runs', 'businesses', 'email_verifications', 'infra_service_reminders',
  'infra_service_renewals', 'infra_services', 'page_blobs', 'password_resets', 'platform_domain_reminders', 'platform_domains', 'platform_settings',
  'schema_migrations', 'user_sessions', 'users'];

const { pool } = setup({});
before(() => resetDatabase(pool));
after(() => pool.end());

// A foreign key on the column to the parent; for business_id, a composite key (business_id, x) to another
// business-owned table also counts: it is stricter (the row's business must equal its parent's business).
const fk = async (table, column, parent) => (await pool.query(
  `SELECT 1 FROM information_schema.table_constraints tc
     JOIN information_schema.key_column_usage k ON k.constraint_name = tc.constraint_name AND k.table_name = tc.table_name
     JOIN information_schema.constraint_column_usage u ON u.constraint_name = tc.constraint_name
    WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public' AND tc.table_name = $1 AND k.column_name = $2 AND (u.table_name = $3 OR ($2 = 'business_id' AND u.table_name = ANY($4)))`,
  [table, column, parent, BUSINESS_OWNED])).rowCount > 0;

test('every table is classified (business-owned, child of a business-owned row, or platform)', async () => {
  const { rows } = await pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'");
  const known = new Set([...BUSINESS_OWNED, ...Object.keys(CHILDREN), ...PLATFORM]);
  assert.deepEqual(rows.map((r) => r.table_name).filter((t) => !known.has(t)).sort(), [], 'unclassified tables');
});

test('business-owned tables: business_id NOT NULL with a foreign key to businesses', async () => {
  for (const t of BUSINESS_OWNED) {
    const { rows: [c] } = await pool.query("SELECT is_nullable FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 AND column_name = 'business_id'", [t]);
    assert.ok(c, `${t}: no business_id`);
    assert.equal(c.is_nullable, 'NO', `${t}: business_id may be empty`);
    assert.ok(await fk(t, 'business_id', 'businesses'), `${t}: business_id has no foreign key`);
  }
});

test('child tables: linked to their business-owned parent by a NOT NULL foreign key', async () => {
  for (const [t, [col, parent]] of Object.entries(CHILDREN)) {
    assert.ok(await fk(t, col, parent), `${t}.${col} → ${parent}: no foreign key`);
    if (t !== 'payment_webhook_events') { // a gateway event may name an order Skyfly does not know
      const { rows: [c] } = await pool.query("SELECT is_nullable FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2", [t, col]);
      assert.equal(c.is_nullable, 'NO', `${t}.${col} may be empty`);
    }
  }
});

test('platform tables hold no business_id except the audit log (which records the business a Super Admin acted on)', async () => {
  const { rows } = await pool.query("SELECT table_name FROM information_schema.columns WHERE column_name = 'business_id' AND table_schema = 'public' AND table_name = ANY($1)", [PLATFORM]);
  assert.deepEqual(rows.map((r) => r.table_name), ['audit_log']);
});
