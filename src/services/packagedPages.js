// Installs landing pages supplied by a business owner and shipped with Skyfly (landing-pages/install/<name>/:
// manifest.json + the page's files) into exactly the business named in the manifest, through Skyfly's own
// import, version, server checks and publish steps.
//
// Safety: the business must match BOTH the manifest's ID and its address name (slug); nothing happens if
// the page already exists (an owner's later changes are never overwritten); existing products are never
// changed (only missing ones are added); no other business is touched. Every step is logged and audited.
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { importFiles } from '../hosting/importer.js';
import { saveVersion } from '../hosting/storage.js';
import { deriveVersion } from '../hosting/connect.js';
import { validateVersion, publishVersion } from '../hosting/validate.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../landing-pages/install');
const P = 'Packaged page:';

function listFiles(dir, base = dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return listFiles(full, base);
    return name === 'manifest.json' ? [] : [{ path: path.relative(base, full).split(path.sep).join('/'), data: readFileSync(full) }];
  });
}

// The connection markers (version 2): each exact text must occur once in the original page.
export function applyConnect(html, edits) {
  let out = html;
  for (const e of edits) {
    const n = out.split(e.find).length - 1;
    if (n !== 1) throw new Error(`connection step not applied: "${e.find.slice(0, 60)}" found ${n} times`);
    out = out.replace(e.find, e.replace);
  }
  return out;
}

export async function installPackagedPage(pool, config, dir, { log = console } = {}) {
  const m = JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  const { rows: [b] } = await pool.query('SELECT id, slug, name, currency, max_landing_pages FROM businesses WHERE id = $1', [m.business.id]);
  if (!b || b.slug !== m.business.slug) {
    log.log(`${P} "${m.page.slug}" skipped: business #${m.business.id} "${m.business.slug}" not found (found ${b ? `"${b.slug}"` : 'none'}). Nothing changed.`);
    return { status: 'skipped_business' };
  }
  const { rows: [existing] } = await pool.query('SELECT id, business_id, status, published_version_id FROM landing_pages WHERE slug = $1', [m.page.slug]);
  if (existing) {
    log.log(`${P} "${m.page.slug}" already exists (page ${existing.id}, business #${existing.business_id}, ${existing.status}${existing.published_version_id ? ', published' : ''}). Nothing changed.`);
    return { status: 'exists', pageId: existing.id };
  }
  // The business's owner is recorded as the person who imported it (as when done in the dashboard).
  const { rows: [owner] } = await pool.query("SELECT user_id FROM business_members WHERE business_id = $1 AND role = 'owner' ORDER BY user_id LIMIT 1", [b.id]);
  const userId = owner?.user_id ?? null;
  const client = await pool.connect();
  let pageId; const ids = {};
  try {
    await client.query('BEGIN');
    const { rows: [n] } = await client.query("SELECT count(*)::int AS n FROM landing_pages WHERE business_id = $1 AND status <> 'archived'", [b.id]);
    if (n.n >= b.max_landing_pages) throw new Error(`the business already has ${n.n} of its ${b.max_landing_pages} landing pages`);
    // NGN for this business, set only while it has no orders yet (an existing business's money is never re-labelled).
    if (m.business.currency && b.currency !== m.business.currency) {
      const { rows: [o] } = await client.query('SELECT count(*)::int AS n FROM orders WHERE business_id = $1', [b.id]);
      if (o.n) throw new Error(`the business's currency is ${b.currency} and it already has orders`);
      await client.query('UPDATE businesses SET currency = $2 WHERE id = $1', [b.id, m.business.currency]);
    }

    for (const p of [...m.products, ...(m.upsell ? [m.upsell] : [])]) {
      const { rows: [row] } = await client.query(
        `INSERT INTO products (business_id, code, name, price_minor, compare_at_price_minor, description, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (business_id, code) DO NOTHING RETURNING id`,
        [b.id, p.code, p.name, Math.round(p.price * 100), p.compareAt ? Math.round(p.compareAt * 100) : null, p.description ?? null, p.sortOrder ?? 0]);
      ids[p.code] = row?.id ?? (await client.query('SELECT id FROM products WHERE business_id = $1 AND code = $2', [b.id, p.code])).rows[0].id;
    }
    ({ rows: [{ id: pageId }] } = await client.query(
      `INSERT INTO landing_pages (business_id, name, slug, url, status, notes, order_destination, upsell_product_id, upsell_headline, upsell_text)
       VALUES ($1, $2, $3, NULL, 'draft', $4, $5, $6, $7, $8) RETURNING id`,
      [b.id, m.page.name, m.page.slug, 'Imported from the owner\'s supplied page (packaged import).', m.page.orderDestination ?? 'checkout',
        m.upsell ? ids[m.upsell.code] : null, m.upsell?.headline ?? null, m.upsell?.text ?? null]));
    for (const p of m.products) await client.query('INSERT INTO landing_page_products (landing_page_id, product_id) VALUES ($1, $2)', [pageId, ids[p.code]]);
    await client.query("INSERT INTO audit_log (business_id, user_id, action, entity_type, entity_id, details) VALUES ($1, $2, 'page.imported', 'landing_page', $3, $4)",
      [b.id, userId, String(pageId), JSON.stringify({ packaged: path.basename(dir), products: Object.keys(ids) })]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    log.log(`${P} "${m.page.slug}" NOT installed in business #${b.id}: ${err.message}. Nothing changed.`);
    return { status: 'failed', error: err.message };
  } finally { client.release(); }

  // Version 1: the original files, exactly as supplied. Version 2: the connection markers only.
  const upload = importFiles(listFiles(dir), `${path.basename(dir)} (owner's original page)`);
  const v1 = await saveVersion(pool, { pageId, userId, upload });
  const original = upload.files.find((f) => f.path === upload.entryPath).data.toString('utf8');
  const v2 = await deriveVersion(pool, { id: v1, entry_path: upload.entryPath, page_id: pageId }, applyConnect(original, m.connect ?? []), new Map(), 'Checkout connected to Skyfly (order form, fields, package, add-on)', userId);
  const { rows: [page] } = await pool.query('SELECT * FROM landing_pages WHERE id = $1', [pageId]);
  const validation = await validateVersion(pool, config, page, v2);
  if (validation.blocked) {
    const why = validation.checks.filter((c) => c.status === 'BLOCKED').map((c) => `${c.label}: ${c.message}`).join(' • ');
    log.log(`${P} "${m.page.slug}" imported into business #${b.id} (page ${pageId}, versions ${v1}/${v2}) but NOT published: ${why}`);
    return { status: 'blocked', pageId, why };
  }
  await publishVersion(pool, page, v2);
  await pool.query("INSERT INTO audit_log (business_id, user_id, action, entity_type, entity_id, details) VALUES ($1, $2, 'page.published', 'landing_page', $3, $4)",
    [b.id, userId, String(pageId), JSON.stringify({ versionId: v2, packaged: true })]);
  const url = config.pagesBaseUrl ? `${config.pagesBaseUrl}/${m.page.slug}/` : `${config.publicBaseUrl}/p/${m.page.slug}/`;
  log.log(`${P} "${m.page.slug}" installed and published in business #${b.id} "${b.name}" (page ${pageId}, original version ${v1}, connected version ${v2}, products ${Object.keys(ids).join(', ')}, ${upload.files.length} files): ${url}`);
  return { status: 'published', pageId, versions: [v1, v2], url };
}

// Start-up: every packaged page, one at a time; a failure is logged and never stops the server.
export async function installPackagedPages(pool, config, opts = {}) {
  if (!existsSync(ROOT)) return [];
  const out = [];
  for (const name of readdirSync(ROOT).sort()) {
    const dir = path.join(ROOT, name);
    if (!existsSync(path.join(dir, 'manifest.json'))) continue;
    out.push(await installPackagedPage(pool, config, dir, opts).catch((err) => { (opts.log ?? console).error(`${P} ${name} failed: ${err.message}`); return { status: 'error', error: err.message }; }));
  }
  return out;
}
