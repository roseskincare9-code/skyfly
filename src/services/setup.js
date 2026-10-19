// Makes sure the owner's Larose business exists, so the live Larose page can take
// orders without a manual setup step. Only when exactly one account exists (the
// owner, with sign-up limited to the first account) and Larose is not set up yet.
// Uses the same idempotent setup as the "Set up Larose" button: never duplicates.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { seedLarose } from '../scripts/seed-larose.js';
import { saveVersion } from '../hosting/storage.js';
import { analyzeFiles } from '../hosting/report.js';

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

// A labelled demo site for checking Skyfly's own hosting end to end without touching any real
// business: "Skyfly Demo Shop (test)" with a page published at /p/skyfly-demo/ in test mode
// (its orders are test orders: never counted, never sent to Meta/TikTok, never emailed).
// No pixel or Google Sheet is connected to it. Created once, for the platform owner.
const DEMO_FILES = [['index.html', 'text/html; charset=utf-8'], ['style.css', 'text/css; charset=utf-8'], ['hero.jpg', 'image/jpeg'],
  ['product-1.jpg', 'image/jpeg'], ['product-2.jpg', 'image/jpeg'], ['product-3.jpg', 'image/jpeg']];

export async function ensureDemoSite(pool, config, log = console) {
  if (!config.demoSite) return null;
  const { rows: [admin] } = await pool.query('SELECT id FROM users WHERE is_platform_admin ORDER BY id LIMIT 1');
  if (!admin) return null;
  const { rows: [existing] } = await pool.query("SELECT 1 FROM landing_pages WHERE slug = 'skyfly-demo'");
  if (existing) return null;
  const files = DEMO_FILES.map(([name, contentType]) => {
    const data = readFileSync(new URL(`../demo/${name}`, import.meta.url));
    return { path: name, contentType, size: data.length, sha256: createHash('sha256').update(data).digest('hex'), data };
  });
  const client = await pool.connect();
  let businessId; let pageId;
  try {
    await client.query('BEGIN');
    const { rows: [b] } = await client.query(
      `INSERT INTO businesses (owner_id, name, slug, currency, order_prefix, subscription_status)
       VALUES ($1, 'Skyfly Demo Shop (test)', 'skyfly-demo', 'NGN', 'DM', 'internal') ON CONFLICT (slug) DO NOTHING RETURNING id`, [admin.id]);
    if (!b) { await client.query('ROLLBACK'); return null; }
    businessId = b.id;
    await client.query("INSERT INTO business_members (business_id, user_id, role) VALUES ($1, $2, 'owner')", [businessId, admin.id]);
    const { rows: products } = await client.query(
      `INSERT INTO products (business_id, code, name, price_minor, sort_order) VALUES
         ($1, 'demo-serum', 'Glow Demo Serum', 1250000, 1), ($1, 'demo-duo', 'Glow Demo Duo (serum + cleanser)', 2200000, 2) RETURNING id`, [businessId]);
    ({ rows: [{ id: pageId }] } = await client.query(
      `INSERT INTO landing_pages (business_id, slug, name, status, test_mode, notes)
       VALUES ($1, 'skyfly-demo', 'Skyfly demo page (test)', 'draft', true, 'Created automatically for testing Skyfly hosting. Orders are test orders.') RETURNING id`, [businessId]));
    for (const p of products) await client.query('INSERT INTO landing_page_products (landing_page_id, product_id) VALUES ($1, $2)', [pageId, p.id]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  const versionId = await saveVersion(pool, {
    pageId, userId: admin.id,
    upload: { sourceName: 'Skyfly demo page', entryPath: 'index.html', files, totalBytes: files.reduce((n, f) => n + f.size, 0), report: analyzeFiles(files, 'index.html') },
  });
  await pool.query("UPDATE landing_pages SET published_version_id = $1, status = 'active', updated_at = now() WHERE id = $2", [versionId, pageId]);
  await pool.query(
    "INSERT INTO audit_log (user_id, business_id, action, details) VALUES ($1, $2, 'business.demo_setup', '{\"automatic\":true}')", [admin.id, businessId]);
  log.log(`Skyfly demo site published at /p/skyfly-demo/ (business #${businessId}, test mode).`);
  return businessId;
}

// The demo shop (test business) gets an upsell and a WhatsApp number once, so the full checkout
// (add-on, total, thank-you, WhatsApp hand-off) can be tested live without touching a real business.
export async function ensureDemoUpsell(pool) {
  const { rows: [page] } = await pool.query(
    "SELECT lp.id, lp.business_id, lp.upsell_product_id FROM landing_pages lp WHERE lp.slug = 'skyfly-demo' AND lp.test_mode");
  if (!page || page.upsell_product_id) return false;
  const { rows: [p] } = await pool.query(
    `INSERT INTO products (business_id, code, name, price_minor, sort_order) VALUES ($1, 'demo-addon', 'Glow Demo Travel Size (add-on)', 450000, 9)
     ON CONFLICT DO NOTHING RETURNING id`, [page.business_id]);
  const id = p?.id ?? (await pool.query("SELECT id FROM products WHERE business_id = $1 AND code = 'demo-addon'", [page.business_id])).rows[0]?.id;
  if (!id) return false;
  await pool.query(
    "UPDATE landing_pages SET upsell_product_id = $1, upsell_headline = 'Add a travel-size serum', upsell_text = '15ml travel size (test add-on)' WHERE id = $2",
    [id, page.id]);
  await pool.query("UPDATE businesses SET whatsapp_number = '+2349049206695' WHERE id = $1 AND whatsapp_number IS NULL", [page.business_id]);
  return true;
}

// The live Larose page, also hosted on Skyfly for testing before a custom domain: page
// "larose-skincare" in the Larose business, published at /p/larose-skincare/ with the same
// packages (prices from Skyfly), the business's Meta Pixel and Google Sheet settings. The
// GitHub Pages page (form key "larosenigeria") is not touched. Created once: an existing page
// with this key is never overwritten, so the owner's later edits stay.
export async function ensureLaroseHostedPage(pool, config, log = console) {
  if (!config.publicBaseUrl) return null;
  const { rows: [src] } = await pool.query(
    `SELECT lp.id, lp.business_id, b.owner_id FROM landing_pages lp JOIN businesses b ON b.id = lp.business_id
      WHERE lp.slug = 'larosenigeria' AND b.slug = 'larose-nigeria'`);
  if (!src) return null;
  const { rows: [existing] } = await pool.query("SELECT 1 FROM landing_pages WHERE slug = 'larose-skincare'");
  if (existing) return null;
  const data = readFileSync(new URL('../import/larose-skincare.html', import.meta.url));
  const files = [{ path: 'index.html', contentType: 'text/html; charset=utf-8', size: data.length, sha256: createHash('sha256').update(data).digest('hex'), data }];
  const { rows: [page] } = await pool.query(
    `INSERT INTO landing_pages (business_id, slug, name, status, notes)
     VALUES ($1, 'larose-skincare', 'Larose Skincare (Skyfly-hosted)', 'draft',
             'Imported from the live GitHub Pages page (form key larosenigeria, unchanged). Orders arrive in this business.')
     ON CONFLICT (slug) DO NOTHING RETURNING id`, [src.business_id]);
  if (!page) return null;
  await pool.query(
    'INSERT INTO landing_page_products (landing_page_id, product_id) SELECT $1, product_id FROM landing_page_products WHERE landing_page_id = $2',
    [page.id, src.id]);
  const versionId = await saveVersion(pool, {
    pageId: page.id, userId: src.owner_id,
    upload: { sourceName: 'Larose page (GitHub Pages copy)', entryPath: 'index.html', files, totalBytes: data.length, report: analyzeFiles(files, 'index.html') },
  });
  await pool.query("UPDATE landing_pages SET published_version_id = $1, status = 'active', updated_at = now() WHERE id = $2", [versionId, page.id]);
  await pool.query(
    "INSERT INTO audit_log (user_id, business_id, action, entity_type, entity_id, details) VALUES ($1, $2, 'page.published', 'landing_page', $3, '{\"automatic\":true,\"imported_from\":\"larosenigeria\"}')",
    [src.owner_id, src.business_id, String(page.id)]);
  log.log(`Larose page imported and published at ${config.publicBaseUrl}/p/larose-skincare/ (Larose business #${src.business_id}).`);
  return page.id;
}
