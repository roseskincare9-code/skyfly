// Makes sure the owner's Larose business exists, so the live Larose page can take
// orders without a manual setup step. Only when exactly one account exists (the
// owner, with sign-up limited to the first account) and Larose is not set up yet.
// Uses the same idempotent setup as the "Set up Larose" button: never duplicates.
import { seedLarose } from '../scripts/seed-larose.js';

export async function ensureLaroseForOwner(pool, config, log = console) {
  if (!config.autoSetupLarose) return null;
  const { rows: users } = await pool.query('SELECT id, email FROM users ORDER BY id LIMIT 2');
  if (users.length !== 1) return null;
  const { rows: [existing] } = await pool.query("SELECT 1 FROM landing_pages WHERE slug = 'larosenigeria'");
  if (existing) return null;
  const businessId = await seedLarose(pool, users[0].email);
  await pool.query(
    "INSERT INTO audit_log (user_id, business_id, action, details) VALUES ($1, $2, 'business.larose_setup', '{\"automatic\":true}')",
    [users[0].id, businessId],
  );
  log.log(`Larose Natural Skincare Nigeria set up automatically for the owner account (business #${businessId}).`);
  return businessId;
}
