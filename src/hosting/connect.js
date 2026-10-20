// Shared steps for page versions: a new version from an existing one (only changed files
// get new content), and connecting a version's checkout to Skyfly (used by the dashboard's
// "Connect checkout automatically", by publishing, and by the import test site).
import { createHash } from 'node:crypto';
import { readFile, saveVersion } from './storage.js';
import { analyzeFiles } from './report.js';
import { detectCheckout, connectCheckout } from './adapter.js';
import { businessCatalogue } from './validate.js';

// v: { id, entry_path, page_id }. replaced: Map(path → Buffer) of other files that changed.
export async function deriveVersion(pool, v, entryHtml, replaced, sourceName, userId) {
  const { rows: files } = await pool.query('SELECT path, content_type, size, sha256 FROM page_files WHERE version_id = $1 ORDER BY path', [v.id]);
  const newFiles = [];
  for (const f of files) {
    let data = null;
    if (f.path === v.entry_path) data = Buffer.from(entryHtml);
    else if (replaced.has(f.path)) data = replaced.get(f.path);
    else if (/\.(html?|css|m?js)$/i.test(f.path)) data = (await readFile(pool, v.id, f.path)).data;
    const sha256 = data ? createHash('sha256').update(data).digest('hex') : f.sha256;
    newFiles.push({ path: f.path, contentType: f.content_type, size: data ? data.length : f.size, sha256, data });
  }
  const upload = {
    sourceName: sourceName.slice(0, 200), entryPath: v.entry_path, files: newFiles,
    totalBytes: newFiles.reduce((n, f) => n + f.size, 0), report: analyzeFiles(newFiles.filter((f) => f.data), v.entry_path),
  };
  return saveVersion(pool, { pageId: v.page_id, userId, upload });
}

// What still needs the owner's answer before a version can be connected without asking:
// products found on the page that were not matched confidently, and missing order-form fields.
export function needsAnswers(detected) {
  const products = detected.candidates.filter((c) => c.match?.confidence !== 'high');
  const fields = detected.forms.filter((f) => f.isOrder && !f.connected && f.missing.length);
  return { products, fields, any: products.length > 0 || fields.length > 0 };
}

// Connects a version's checkout as a new version and connects the products it orders to the page.
// mapping: the owner's answers (see adapter.connectCheckout). Returns null when nothing changed.
export async function connectVersion(pool, { page, version, userId, mapping = {}, onlyIfConfident = false }) {
  const html = (await readFile(pool, version.id, version.entry_path)).data.toString('utf8');
  const catalogue = await businessCatalogue(pool, page.business_id);
  if (onlyIfConfident && needsAnswers(detectCheckout(html, catalogue)).any) return { versionId: null, changes: [], needsAnswers: true };
  const { html: updated, changes } = connectCheckout(html, { slug: page.slug, catalogue, mapping });
  if (updated === html) return null;
  const versionId = await deriveVersion(pool, { id: version.id, entry_path: version.entry_path, page_id: page.id }, updated, new Map(),
    `Checkout connected (from ${version.source_name ?? 'version ' + version.id})`, userId);
  const codes = [...new Set([...updated.matchAll(/data-product="([^"]+)"/g)].map((m) => m[1]))];
  if (codes.length) {
    await pool.query(
      `INSERT INTO landing_page_products (landing_page_id, product_id) SELECT $1, id FROM products WHERE business_id = $2 AND code = ANY($3::text[])
       ON CONFLICT DO NOTHING`, [page.id, page.business_id, codes]);
  }
  return { versionId, changes };
}
