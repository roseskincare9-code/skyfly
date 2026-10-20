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
// with this key keeps the owner's own versions (see below).
const IMPORT_NAME = 'Larose page (GitHub Pages copy)';
export async function ensureLaroseHostedPage(pool, config, log = console) {
  if (!config.publicBaseUrl) return null;
  const { rows: [src] } = await pool.query(
    `SELECT lp.id, lp.business_id, b.owner_id FROM landing_pages lp JOIN businesses b ON b.id = lp.business_id
      WHERE lp.slug = 'larosenigeria' AND b.slug = 'larose-nigeria'`);
  if (!src) return null;
  const data = readFileSync(new URL('../import/larose-skincare.html', import.meta.url));
  const files = [{ path: 'index.html', contentType: 'text/html; charset=utf-8', size: data.length, sha256: createHash('sha256').update(data).digest('hex'), data }];
  const upload = () => ({ sourceName: IMPORT_NAME, entryPath: 'index.html', files, totalBytes: data.length, report: analyzeFiles(files, 'index.html') });
  const { rows: [existing] } = await pool.query("SELECT id, business_id, published_version_id FROM landing_pages WHERE slug = 'larose-skincare'");
  if (existing) {
    // Updated only while the newest version is still this automatic import, published, and the
    // bundled copy changed. Once the owner uploads or edits a version, it is never replaced.
    const { rows: [latest] } = await pool.query(
      `SELECT v.id, v.source_name, f.sha256 FROM page_versions v LEFT JOIN page_files f ON f.version_id = v.id AND f.path = 'index.html'
        WHERE v.landing_page_id = $1 ORDER BY v.id DESC LIMIT 1`, [existing.id]);
    if (!latest || latest.source_name !== IMPORT_NAME || String(latest.id) !== String(existing.published_version_id) || latest.sha256 === files[0].sha256) return null;
    const versionId = await saveVersion(pool, { pageId: existing.id, userId: src.owner_id, upload: upload() });
    await pool.query('UPDATE landing_pages SET published_version_id = $1, updated_at = now() WHERE id = $2', [versionId, existing.id]);
    await pool.query(
      "INSERT INTO audit_log (user_id, business_id, action, entity_type, entity_id, details) VALUES ($1, $2, 'page.published', 'landing_page', $3, '{\"automatic\":true,\"updated_from\":\"larosenigeria\"}')",
      [src.owner_id, existing.business_id, String(existing.id)]);
    log.log(`Larose hosted page updated to the current copy of the live page (version ${versionId}).`);
    return existing.id;
  }
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
    upload: upload(),
  });
  await pool.query("UPDATE landing_pages SET published_version_id = $1, status = 'active', updated_at = now() WHERE id = $2", [versionId, page.id]);
  await pool.query(
    "INSERT INTO audit_log (user_id, business_id, action, entity_type, entity_id, details) VALUES ($1, $2, 'page.published', 'landing_page', $3, '{\"automatic\":true,\"imported_from\":\"larosenigeria\"}')",
    [src.owner_id, src.business_id, String(page.id)]);
  log.log(`Larose page imported and published at ${config.publicBaseUrl}/p/larose-skincare/ (Larose business #${src.business_id}).`);
  return page.id;
}

// A labelled, isolated test of the universal import on the live service: business "Skyfly Import
// Test (test)" (own products, no pixel, no sheet), whose page is an AI-style page that sends
// orders to WhatsApp. It goes through the same steps as an owner's import (import, match
// products and fields, connect checkout, server checks, publish, live check) and is published
// in test mode at /p/skyfly-import-test/. Created once, for the platform owner.
const IMPORT_TEST = 'skyfly-import-test';
export async function ensureImportTestSite(pool, config, log = console) {
  if (!config.demoSite || !config.publicBaseUrl) return null;
  const { rows: [admin] } = await pool.query('SELECT id FROM users WHERE is_platform_admin ORDER BY id LIMIT 1');
  if (!admin) return null;
  if ((await pool.query('SELECT 1 FROM landing_pages WHERE slug = $1', [IMPORT_TEST])).rows[0]) return null;
  const { detectCheckout, connectCheckout } = await import('../hosting/adapter.js');
  const { validateVersion, publishVersion, checkLive, businessCatalogue } = await import('../hosting/validate.js');
  const { rows: [b] } = await pool.query(
    `INSERT INTO businesses (owner_id, name, slug, currency, order_prefix, subscription_status, whatsapp_number)
     VALUES ($1, 'Skyfly Import Test (test)', $2, 'NGN', 'IT', 'internal', '+2349049206695') ON CONFLICT (slug) DO NOTHING RETURNING id`, [admin.id, IMPORT_TEST]);
  if (!b) return null;
  await pool.query("INSERT INTO business_members (business_id, user_id, role) VALUES ($1, $2, 'owner')", [b.id, admin.id]);
  await pool.query(
    `INSERT INTO products (business_id, code, name, price_minor, sort_order) VALUES
       ($1, 'radiance-serum', 'Radiance Serum', 1500000, 1), ($1, 'glow-duo', 'Glow Duo Set', 2750000, 2)`, [b.id]);
  const { rows: [page] } = await pool.query(
    `INSERT INTO landing_pages (business_id, slug, name, status, test_mode, notes)
     VALUES ($1, $2, 'Import test: AI-generated page', 'draft', true, 'Created automatically to test the universal import on the live service. Orders are test orders.')
     RETURNING *`, [b.id, IMPORT_TEST]);
  const data = readFileSync(new URL('../demo/import-sample/index.html', import.meta.url));
  const file = (buf) => [{ path: 'index.html', contentType: 'text/html; charset=utf-8', size: buf.length, sha256: createHash('sha256').update(buf).digest('hex'), data: buf }];
  const upload = (buf, sourceName) => ({ sourceName, entryPath: 'index.html', files: file(buf), totalBytes: buf.length, report: analyzeFiles(file(buf), 'index.html') });
  await saveVersion(pool, { pageId: page.id, userId: admin.id, upload: upload(data, 'import-sample/index.html') });
  // Automatic matching only (no owner answers): what an owner gets by clicking "Connect checkout automatically".
  const catalogue = await businessCatalogue(pool, b.id);
  const found = detectCheckout(data.toString('utf8'), catalogue);
  const { html, changes } = connectCheckout(data.toString('utf8'), { slug: IMPORT_TEST, catalogue });
  const versionId = await saveVersion(pool, { pageId: page.id, userId: admin.id, upload: upload(Buffer.from(html), 'Checkout connected (from import-sample/index.html)') });
  const codes = [...new Set([...html.matchAll(/data-product="([^"]+)"/g)].map((m) => m[1]))];
  await pool.query(
    'INSERT INTO landing_page_products (landing_page_id, product_id) SELECT $1, id FROM products WHERE business_id = $2 AND code = ANY($3::text[]) ON CONFLICT DO NOTHING', [page.id, b.id, codes]);
  log.log(`Import test site: found ${found.forms.filter((f) => f.isOrder).length} order form(s), ${found.buttons.length} purchase button(s) (${found.whatsappOrderButtons} to WhatsApp), ${found.candidates.filter((c) => c.match?.confidence === 'high').length}/${found.candidates.length} products matched; connected: ${changes.length} change(s).`);
  const validation = await validateVersion(pool, config, page, versionId);
  log.log(`Import test site checks: ${validation.checks.map((c) => `${c.label} ${c.status}`).join('; ')}`);
  if (validation.blocked) return null;
  await publishVersion(pool, page, versionId);
  await pool.query(
    "INSERT INTO audit_log (user_id, business_id, action, entity_type, entity_id, details) VALUES ($1, $2, 'page.published', 'landing_page', $3, '{\"automatic\":true,\"import_test\":true}')",
    [admin.id, b.id, String(page.id)]);
  const live = await checkLive(pool, config, page);
  log.log(`Import test site published at ${config.publicBaseUrl}/p/${IMPORT_TEST}/ (business #${b.id}, test mode); live check: ${live}`);
  return page.id;
}
