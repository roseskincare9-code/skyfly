// Durable storage for hosted page files, in Postgres. Files are content-addressed
// (SHA-256), so re-uploading an unchanged image costs nothing. The storage calls
// are kept in this one module so an S3/R2 backend can replace it later.

const CACHE_LIMIT = 64 * 1024 * 1024;
const cache = new Map(); // sha256 -> Buffer, in insertion (LRU) order
let cached = 0;

function remember(sha, data) {
  if (data.length > CACHE_LIMIT / 8) return;
  cache.set(sha, data);
  cached += data.length;
  for (const [key, value] of cache) {
    if (cached <= CACHE_LIMIT) break;
    cache.delete(key);
    cached -= value.length;
  }
}

export async function saveVersion(pool, { pageId, userId, upload }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const f of upload.files) {
      await client.query(
        'INSERT INTO page_blobs (sha256, size, data) VALUES ($1, $2, $3) ON CONFLICT (sha256) DO NOTHING',
        [f.sha256, f.size, f.data],
      );
    }
    const { rows: [version] } = await client.query(
      `INSERT INTO page_versions (landing_page_id, source_name, entry_path, file_count, total_bytes, report, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [pageId, upload.sourceName, upload.entryPath, upload.files.length, upload.totalBytes, JSON.stringify(upload.report), userId],
    );
    for (const f of upload.files) {
      await client.query(
        'INSERT INTO page_files (version_id, path, content_type, size, sha256) VALUES ($1, $2, $3, $4, $5)',
        [version.id, f.path, f.contentType, f.size, f.sha256],
      );
    }
    await client.query('COMMIT');
    return version.id;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function readFile(pool, versionId, filePath) {
  const { rows: [file] } = await pool.query(
    'SELECT content_type, sha256, size FROM page_files WHERE version_id = $1 AND path = $2',
    [versionId, filePath],
  );
  if (!file) return null;
  let data = cache.get(file.sha256);
  if (data) {
    cache.delete(file.sha256);
    cache.set(file.sha256, data);
  } else {
    const { rows: [blob] } = await pool.query('SELECT data FROM page_blobs WHERE sha256 = $1', [file.sha256]);
    data = blob.data;
    remember(file.sha256, data);
  }
  return { contentType: file.content_type, sha256: file.sha256, data };
}
