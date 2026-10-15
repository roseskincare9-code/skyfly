// Registers the Larose Nigeria business, its 5 packages and the existing
// GitHub Pages landing page for an existing Skyfly owner account.
// Safe to re-run: existing rows are left as they are (prices are not overwritten).
//
//   npm run seed:larose -- owner@example.com
import { loadConfig } from '../config.js';
import { createPool } from '../db.js';

export const LAROSE_PACKAGES = [
  { code: 'package-1', name: 'Package 1 – Starter Glow Soap (1kg Soap)', price: 23500 },
  { code: 'package-2', name: 'Package 2 – Starter Glow Combo', price: 33000 },
  { code: 'package-3', name: 'Package 3 – Power Glow', price: 51500 },
  { code: 'package-4', name: 'Package 4 – Total Revive Full', price: 93500 },
  { code: 'package-5', name: 'Package 5 – Total Transformation VIP Luxury (5kg Soap)', price: 202000 },
];

export const LAROSE_META_PIXEL_ID = '1357015185691765';

export async function seedLarose(pool, ownerEmail) {
  const owner = await pool.query('SELECT id FROM users WHERE email = $1', [ownerEmail.trim().toLowerCase()]);
  if (!owner.rows[0]) throw new Error(`No Skyfly user with email ${ownerEmail}. Sign up first.`);
  const ownerId = owner.rows[0].id;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO businesses (owner_id, name, slug, currency, whatsapp_number, order_prefix)
       VALUES ($1, 'Larose Natural Skincare Nigeria', 'larose-nigeria', 'NGN', '+2349049206695', 'LR')
       ON CONFLICT (slug) DO NOTHING`,
      [ownerId],
    );
    const biz = await client.query("SELECT id, owner_id FROM businesses WHERE slug = 'larose-nigeria'");
    if (biz.rows[0].owner_id !== ownerId) throw new Error('The larose-nigeria business belongs to a different user.');
    const businessId = biz.rows[0].id;

    for (const [i, p] of LAROSE_PACKAGES.entries()) {
      await client.query(
        `INSERT INTO products (business_id, code, name, price_minor, sort_order) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (business_id, code) DO NOTHING`,
        [businessId, p.code, p.name, p.price * 100, i + 1],
      );
    }

    await client.query(
      `INSERT INTO landing_pages (business_id, slug, name, url, status)
       VALUES ($1, 'larosenigeria', 'Larose Nigeria (GitHub Pages)', 'https://roseskincare9-code.github.io/Larosenigeria/', 'active')
       ON CONFLICT (slug) DO NOTHING`,
      [businessId],
    );
    await client.query(
      `INSERT INTO landing_page_products (landing_page_id, product_id)
       SELECT lp.id, p.id FROM landing_pages lp JOIN products p ON p.business_id = lp.business_id
        WHERE lp.slug = 'larosenigeria' AND lp.business_id = $1 AND p.code LIKE 'package-%'
       ON CONFLICT DO NOTHING`,
      [businessId],
    );
    // The Meta Pixel already on the live page (public ID). Its access token is added by the owner on the Pixels screen.
    await client.query(
      `INSERT INTO pixel_settings (business_id, provider, enabled, pixel_id, events)
       VALUES ($1, 'meta', true, $2, ARRAY['PageView', 'ViewContent', 'InitiateCheckout', 'Lead'])
       ON CONFLICT (business_id, provider) WHERE landing_page_id IS NULL DO NOTHING`,
      [businessId, LAROSE_META_PIXEL_ID],
    );
    await client.query('COMMIT');
    return businessId;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  const email = process.argv[2];
  if (!email) {
    console.error('Usage: npm run seed:larose -- owner@example.com');
    process.exit(1);
  }
  const config = loadConfig();
  const pool = createPool(config.databaseUrl, config.databaseSsl);
  try {
    const id = await seedLarose(pool, email);
    console.log(`Larose Nigeria is set up as business #${id}.`);
  } finally {
    await pool.end();
  }
}
