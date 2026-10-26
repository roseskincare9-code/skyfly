// Full logical backup of Skyfly's data as one JSON file, and restore into an EMPTY database.
// The free Render database has no automatic backups, so the platform owner downloads this
// file from Platform admin → System status. Restoring never overwrites: it refuses to run
// on a database that already holds businesses.

// Parents before children. Columns in LATE are inserted as NULL and filled in at the end,
// because they point "forward" (circular references).
export const TABLE_ORDER = [
  'users', 'businesses', 'platform_settings', 'business_members', 'business_invites', 'api_keys', 'products',
  'landing_pages', 'landing_page_products', 'page_blobs', 'page_versions', 'page_files', 'pixel_settings', 'additional_pixels',
  'sheet_connections', 'orders', 'order_items', 'order_status_history', 'conversion_events', 'sheet_recoveries',
  'email_settings', 'email_contacts', 'email_templates', 'email_automations', 'email_automation_steps', 'email_messages',
  'audit_log',
];
export const SKIPPED_TABLES = ['user_sessions', 'schema_migrations', 'password_resets']; // sign-ins, migration bookkeeping and one-time reset links are not data
const LATE = { businesses: ['default_sheet_connection_id'], landing_pages: ['published_version_id'] };

async function columnsOf(db, table) {
  const { rows } = await db.query(
    `SELECT column_name, udt_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`, [table]);
  return rows;
}

const encode = (v, type) => {
  if (v === null || v === undefined) return null;
  if (type === 'bytea') return { $b64: Buffer.from(v).toString('base64') };
  if (v instanceof Date) return v.toISOString();
  return v;
};
const decode = (v, type) => {
  if (v === null || v === undefined) return null;
  if (type === 'bytea') return Buffer.from(v.$b64, 'base64');
  if (type === 'json' || type === 'jsonb') return JSON.stringify(v);
  return v;
};

// Writes the backup as JSON through write(chunk), one table at a time.
export async function exportBackup(db, write) {
  const { rows: [meta] } = await db.query(
    `SELECT now() AS at, (SELECT string_agg(name, ',' ORDER BY name) FROM schema_migrations) AS migrations`);
  write(`{"format":"skyfly-backup-v1","createdAt":${JSON.stringify(meta.at.toISOString())},"migrations":${JSON.stringify(meta.migrations.split(','))},"tables":{`);
  const counts = {};
  for (const [i, table] of TABLE_ORDER.entries()) {
    const cols = await columnsOf(db, table);
    const { rows } = await db.query(`SELECT * FROM ${table} ORDER BY 1`);
    counts[table] = rows.length;
    write(`${i ? ',' : ''}${JSON.stringify(table)}:{"columns":${JSON.stringify(cols.map((c) => c.column_name))},"rows":[`);
    rows.forEach((r, j) => write(`${j ? ',' : ''}${JSON.stringify(cols.map((c) => encode(r[c.column_name], c.udt_name)))}`));
    write(']}');
  }
  write('}}');
  return counts;
}

// Every data table must be covered, so a new migration can't silently leave data out of backups.
export async function uncoveredTables(db) {
  const { rows } = await db.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'");
  return rows.map((r) => r.table_name).filter((t) => !TABLE_ORDER.includes(t) && !SKIPPED_TABLES.includes(t));
}

// Restores into a database that has the schema (migrations applied) but no businesses.
export async function restoreBackup(pool, backup) {
  if (backup?.format !== 'skyfly-backup-v1') throw new Error('Not a Skyfly backup file.');
  const client = await pool.connect();
  const counts = {};
  try {
    await client.query('BEGIN');
    const { rows: [{ n }] } = await client.query('SELECT count(*)::int AS n FROM businesses');
    if (n > 0) throw new Error('The target database already has businesses. Restore only into a new, empty database.');
    for (const table of TABLE_ORDER) {
      const data = backup.tables[table];
      if (!data) continue;
      const types = Object.fromEntries((await columnsOf(client, table)).map((c) => [c.column_name, c.udt_name]));
      const cols = data.columns.filter((c) => c in types);
      const late = LATE[table] ?? [];
      if (table === 'platform_settings') await client.query('DELETE FROM platform_settings');
      for (const row of data.rows) {
        const values = cols.map((c) => (late.includes(c) ? null : decode(row[data.columns.indexOf(c)], types[c])));
        await client.query(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`, values);
      }
      counts[table] = data.rows.length;
    }
    for (const [table, lateCols] of Object.entries(LATE)) {
      const data = backup.tables[table];
      if (!data) continue;
      const idIdx = data.columns.indexOf('id');
      for (const row of data.rows) {
        for (const c of lateCols) {
          const v = row[data.columns.indexOf(c)];
          if (v !== null && v !== undefined) await client.query(`UPDATE ${table} SET ${c} = $2 WHERE id = $1`, [row[idIdx], v]);
        }
      }
    }
    // Continue numbering after the restored ids.
    const { rows: seqs } = await client.query(
      `SELECT c.relname AS tbl, a.attname AS col, pg_get_serial_sequence(c.relname::text, a.attname) AS seq
         FROM pg_class c JOIN pg_attribute a ON a.attrelid = c.oid JOIN pg_namespace ns ON ns.oid = c.relnamespace
        WHERE ns.nspname = 'public' AND c.relkind = 'r' AND pg_get_serial_sequence(c.relname::text, a.attname) IS NOT NULL`);
    for (const s of seqs) {
      await client.query(`SELECT setval($1, GREATEST((SELECT coalesce(max(${s.col}), 0) FROM ${s.tbl}), 1), (SELECT count(*) > 0 FROM ${s.tbl}))`, [s.seq]);
    }
    await client.query('COMMIT');
    return counts;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
