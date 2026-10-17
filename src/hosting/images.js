// Image optimization for hosted pages. For each JPEG/PNG of a version, adds WebP copies at a
// few widths (as extra files of that version under _skyfly/img/) and records each image's size,
// so pages can be served with srcset (smaller files on phones) and reserved space (no layout
// shift). The original files are never changed and stay the fallback.
import { createHash } from 'node:crypto';
import path from 'node:path';
import { readFile } from './storage.js';

const WIDTHS = [480, 828, 1200, 1600];
const MIN_BYTES = 20 * 1024; // small images are left alone
const MAX_PIXELS = 40e6;

let sharp = null;
async function loadSharp() {
  if (sharp === null) {
    try { sharp = (await import('sharp')).default; sharp.concurrency(1); sharp.cache(false); } catch { sharp = false; }
  }
  return sharp;
}

// Generates variants for one version (once). Returns the stored metadata.
export async function optimizeVersion(pool, versionId, log = console) {
  const { rows: [v] } = await pool.query('SELECT id, image_meta FROM page_versions WHERE id = $1', [versionId]);
  if (!v || v.image_meta) return v?.image_meta ?? null;
  const s = await loadSharp();
  if (!s) return null;
  const { rows: files } = await pool.query(
    "SELECT path, size FROM page_files WHERE version_id = $1 AND content_type IN ('image/jpeg', 'image/png') AND path NOT LIKE '_skyfly/%' ORDER BY path", [versionId]);
  const meta = {};
  const added = [];
  for (const f of files) {
    try {
      const { data } = await readFile(pool, versionId, f.path);
      const info = await s(data, { limitInputPixels: MAX_PIXELS }).metadata();
      if (!info.width || !info.height) continue;
      const entry = { w: info.width, h: info.height, variants: [] };
      if (f.size >= MIN_BYTES) {
        const base = createHash('sha1').update(f.path).digest('hex').slice(0, 10);
        const widths = WIDTHS.filter((w) => w < info.width);
        if (info.width <= WIDTHS.at(-1)) widths.push(info.width);
        for (const w of widths) {
          const out = await s(data, { limitInputPixels: MAX_PIXELS }).rotate().resize({ width: w, withoutEnlargement: true }).webp({ quality: 72, effort: 4 }).toBuffer();
          if (out.length >= f.size && w === info.width) continue; // no gain
          const p = `_skyfly/img/${base}-${w}.webp`;
          added.push({ path: p, data: out });
          entry.variants.push({ w, path: p });
        }
      }
      meta[f.path] = entry;
    } catch (err) {
      log.error?.(`Image optimization skipped ${f.path}: ${err.message}`);
    }
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const a of added) {
      const sha = createHash('sha256').update(a.data).digest('hex');
      await client.query('INSERT INTO page_blobs (sha256, size, data) VALUES ($1, $2, $3) ON CONFLICT (sha256) DO NOTHING', [sha, a.data.length, a.data]);
      await client.query(
        "INSERT INTO page_files (version_id, path, content_type, size, sha256) VALUES ($1, $2, 'image/webp', $3, $4) ON CONFLICT DO NOTHING",
        [versionId, a.path, a.data.length, sha]);
    }
    await client.query('UPDATE page_versions SET image_meta = $2 WHERE id = $1 AND image_meta IS NULL', [versionId, JSON.stringify(meta)]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  return meta;
}

// Optimizes every published version that has not been done yet (after a deploy, or a publish).
export async function optimizePublished(pool, log = console) {
  const { rows } = await pool.query(
    `SELECT DISTINCT v.id FROM landing_pages lp JOIN page_versions v ON v.id = lp.published_version_id
      WHERE v.image_meta IS NULL ORDER BY v.id`);
  for (const r of rows) {
    try { await optimizeVersion(pool, r.id, log); } catch (err) { log.error?.(`Image optimization failed for version ${r.id}: ${err.message}`); }
  }
  return rows.length;
}

// Resolves an <img src> (relative to the HTML file) to the version's file path.
export function resolveAsset(htmlPath, src) {
  if (!src || /^([a-z][a-z0-9+.-]*:|\/\/|#|\/)/i.test(src)) return null;
  let decoded;
  try { decoded = decodeURI(src.split(/[?#]/)[0]); } catch { return null; }
  const p = path.posix.normalize(path.posix.join(path.posix.dirname(htmlPath), decoded));
  return p.startsWith('..') ? null : p;
}

// A version's image sizes (cached once known: versions do not change after optimization).
const metaCache = new Map();
export async function imageMeta(pool, versionId) {
  if (!versionId) return null;
  if (metaCache.has(versionId)) return metaCache.get(versionId);
  const { rows: [v] } = await pool.query('SELECT image_meta FROM page_versions WHERE id = $1', [versionId]);
  if (v?.image_meta) {
    if (metaCache.size > 500) metaCache.clear();
    metaCache.set(versionId, v.image_meta);
  }
  return v?.image_meta ?? null;
}
