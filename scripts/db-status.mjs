// Read-only report on the production database: Render plan, creation and expiry dates,
// backups/exports, and row counts (counts only, never customer data). Runs in GitHub
// Actions with RENDER_API_KEY. Connects in a READ ONLY transaction; changes nothing.
import pg from 'pg';

const RENDER = 'https://api.render.com/v1';
const api = async (path) => {
  const res = await fetch(`${RENDER}${path}`, { headers: { Authorization: `Bearer ${process.env.RENDER_API_KEY}`, Accept: 'application/json' }, signal: AbortSignal.timeout(30000) });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, json, text: text.slice(0, 300) };
};
const line = (k, v) => console.log(`${k.padEnd(34)} ${v}`);

const owners = ((await api('/owners?limit=20')).json || []).map((o) => o.owner ?? o);
let db = null;
for (const o of owners) {
  const list = ((await api(`/postgres?ownerId=${encodeURIComponent(o.id)}&limit=100`)).json || []).map((x) => x.postgres ?? x);
  db ||= list.find((x) => x.name === 'skyfly-db');
}
if (!db) { console.log('skyfly-db not found'); process.exit(1); }

const detail = (await api(`/postgres/${db.id}`)).json ?? db;
console.log('== Render database (skyfly-db)');
for (const k of ['name', 'plan', 'status', 'region', 'version', 'createdAt', 'updatedAt', 'expiresAt', 'diskSizeGB', 'highAvailabilityEnabled', 'databaseName', 'suspended', 'role']) {
  if (detail[k] !== undefined) line(k, JSON.stringify(detail[k]));
}
if (Array.isArray(detail.ipAllowList)) line('external access (IP allow list)', detail.ipAllowList.length ? detail.ipAllowList.map((x) => x.cidrBlock).join(', ') : 'none: outside connections are blocked (only the Render service can connect)');
const shown = new Set(['name', 'plan', 'status', 'region', 'version', 'createdAt', 'updatedAt', 'expiresAt', 'diskSizeGB', 'highAvailabilityEnabled', 'databaseName', 'suspended', 'role', 'id', 'owner', 'dashboardUrl', 'ipAllowList', 'databaseUser']);
const other = Object.keys(detail).filter((k) => !shown.has(k));
if (other.length) line('other fields (names only)', other.join(', '));
if (detail.createdAt) {
  const created = new Date(detail.createdAt);
  const days = Math.floor((Date.now() - created) / 864e5);
  line('age', `${days} days`);
  if (detail.plan === 'free' && !detail.expiresAt) line('expiry (free plan rule, computed)', `${new Date(created.getTime() + 30 * 864e5).toISOString()} (30 days after creation)`);
}

console.log('\n== Backups and recovery (Render API)');
for (const [label, path] of [['point-in-time recovery', `/postgres/${db.id}/recovery`], ['exports (logical backups)', `/postgres/${db.id}/export`]]) {
  const r = await api(path);
  line(label, `HTTP ${r.status} ${r.json ? JSON.stringify(r.json).slice(0, 400) : r.text}`);
}

console.log('\n== Data (read-only transaction; counts only)');
const info = await api(`/postgres/${db.id}/connection-info`);
const conn = info.json?.externalConnectionString;
if (!conn) { line('connection info', `HTTP ${info.status} (not available)`); process.exit(0); }
console.log(`::add-mask::${conn}`);
const client = new pg.Client({ connectionString: conn, ssl: { rejectUnauthorized: false } });
try {
  await client.connect();
} catch (err) {
  line('row counts', `not available from outside Render (${err.message}); the database only accepts connections allowed by its IP allow list`);
  process.exit(0);
}
try {
  await client.query('BEGIN TRANSACTION READ ONLY');
  const one = async (sql) => (await client.query(sql)).rows;
  line('database size', (await one('SELECT pg_size_pretty(pg_database_size(current_database())) AS s'))[0].s);
  line('migrations applied', (await one('SELECT string_agg(name, \', \' ORDER BY name) AS m FROM schema_migrations'))[0].m);
  for (const t of ['users', 'businesses', 'business_members', 'products', 'landing_pages', 'orders', 'order_items', 'order_status_history',
    'pixel_settings', 'sheet_connections', 'email_contacts', 'email_automations', 'email_messages', 'audit_log']) {
    try { line(`rows: ${t}`, (await one(`SELECT count(*)::int AS n FROM ${t}`))[0].n); } catch (err) { line(`rows: ${t}`, `n/a (${err.message.slice(0, 60)})`); }
  }
  for (const r of await one(`SELECT b.name, b.subscription_status, count(o.id)::int AS orders,
                                    count(o.id) FILTER (WHERE o.is_test)::int AS test_orders, min(o.created_at)::date AS first, max(o.created_at)::date AS last
                               FROM businesses b LEFT JOIN orders o ON o.business_id = b.id GROUP BY b.id ORDER BY b.id`)) {
    line(`business: ${r.name}`, `${r.subscription_status}; ${r.orders} orders (${r.test_orders} test), ${r.first ?? '-'} .. ${r.last ?? '-'}`);
  }
  for (const r of await one('SELECT sheet_sync_status AS s, count(*)::int AS n FROM orders GROUP BY 1 ORDER BY 1')) line(`sheet copy: ${r.s}`, r.n);
  try {
    for (const r of await one("SELECT table_name FROM information_schema.tables WHERE table_schema = 'backup_before_012' ORDER BY 1")) {
      line(`safety copy: ${r.table_name}`, (await one(`SELECT count(*)::int AS n FROM backup_before_012.${r.table_name}`))[0].n);
    }
  } catch (err) { line('safety copy', err.message.slice(0, 80)); }
  await client.query('ROLLBACK');
} finally {
  await client.end();
}
