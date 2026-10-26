// Registers the Larose Nigeria business, its 5 packages and the existing
// GitHub Pages landing page for an existing Skyfly owner account.
// Safe to re-run: existing rows are left as they are (prices are not overwritten).
//
//   npm run seed:larose -- owner@example.com
import { loadConfig } from '../config.js';
import { createPool } from '../db.js';

export const LAROSE_PACKAGES = [
  { code: 'package-1', name: 'Package 1 – Starter Glow Soap (1kg Soap)', price: 26500 },
  { code: 'package-2', name: 'Package 2 – Starter Glow Combo', price: 36500 },
  { code: 'package-3', name: 'Package 3 – Power Glow', price: 58000 },
  { code: 'package-4', name: 'Package 4 – Total Revive Full', price: 93500 },
  { code: 'package-5', name: 'Package 5 – Total Transformation VIP Luxury (5kg Soap)', price: 202000 },
];

export const LAROSE_PIXEL_NEW_ID = '1087347357386553';
export const LAROSE_META_PIXEL_ID = '1357015185691765';
// Pixels of the owner's other Meta ad accounts (migration 029), loaded by Skyfly next to the two above.
export const LAROSE_AD_ACCOUNT_PIXELS = [
  { name: 'Skyfly', id: '1105657388903531' },
  { name: 'Skindrips', id: '1653102723149813' },
  { name: 'Skindrip', id: '1130654146607839' },
  { name: 'Moon fly', id: '4389240701387003' },
];

export async function seedLarose(pool, ownerEmail) {
  const owner = await pool.query('SELECT id FROM users WHERE email = $1', [ownerEmail.trim().toLowerCase()]);
  if (!owner.rows[0]) throw new Error(`No Skyfly user with email ${ownerEmail}. Sign up first.`);
  const ownerId = owner.rows[0].id;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO businesses (owner_id, name, slug, currency, whatsapp_number, order_prefix, sheet_backup_url, subscription_status)
       VALUES ($1, 'Larose Natural Skincare Nigeria', 'larose-nigeria', 'NGN', '+2349049206695', 'LR', 'https://sheetdb.io/api/v1/m111fq96ve953', 'internal')
       ON CONFLICT (slug) DO NOTHING`,
      [ownerId],
    );
    const biz = await client.query("SELECT id, owner_id FROM businesses WHERE slug = 'larose-nigeria'");
    if (biz.rows[0].owner_id !== ownerId) throw new Error('The larose-nigeria business belongs to a different user.');
    const businessId = biz.rows[0].id;
    await client.query("INSERT INTO business_members (business_id, user_id, role) VALUES ($1, $2, 'owner') ON CONFLICT DO NOTHING", [businessId, ownerId]);

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
    // Larose's tracking IDs (public Meta Pixel IDs, on all of its pages): the pixel already on the live
    // page, "Pixel New" and the pixels of the owner's other ad accounts. Access tokens are added by the
    // owner under Tracking & Pixels.
    for (const p of [{ name: 'Main Meta pixel', id: LAROSE_META_PIXEL_ID }, { name: 'Pixel New', id: LAROSE_PIXEL_NEW_ID }, ...LAROSE_AD_ACCOUNT_PIXELS]) {
      await client.query(
        `INSERT INTO tracking_pixels (business_id, platform, name, pixel_id, enabled, all_pages)
         VALUES ($1, 'meta', $2, $3, true, true) ON CONFLICT (business_id, platform, pixel_id) DO NOTHING`,
        [businessId, p.name, p.id],
      );
    }
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
