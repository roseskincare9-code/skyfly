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

// The web service's plan (instance size) and instance count: what the capacity numbers apply to.
for (const o of owners) {
  const services = ((await api(`/services?ownerId=${encodeURIComponent(o.id)}&limit=100`)).json || []).map((x) => x.service ?? x);
  for (const svc of services.filter((x) => x.name === 'skyfly')) {
    const d = svc.serviceDetails ?? {};
    console.log('== Render web service (skyfly)');
    line('plan', JSON.stringify(d.plan ?? svc.plan ?? 'unknown'));
    line('instances', JSON.stringify(d.numInstances ?? 'unknown'));
    line('region', JSON.stringify(d.region ?? 'unknown'));
    line('suspended', JSON.stringify(svc.suspended ?? 'unknown'));
  }
}

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
  console.log('\n== Landing pages (published = has a public address)');
  for (const r of await one(`SELECT lp.slug, b.slug AS business, lp.status, lp.published_version_id IS NOT NULL AS hosted, lp.test_mode, lp.url IS NOT NULL AS external
                               FROM landing_pages lp JOIN businesses b ON b.id = lp.business_id ORDER BY lp.id`)) {
    const where = r.status === 'active' && r.hosted ? `PUBLISHED at /p/${r.slug}/` : r.hosted ? 'hosted, not published' : r.external ? 'external page (not hosted by Skyfly)' : 'not hosted';
    line(`page: ${r.slug}`, `business ${r.business}; status ${r.status}; ${where}${r.test_mode ? '; test mode' : ''}`);
  }
  // Labelled TEST ORDERs only (never real customers): what the business's Orders page lists for them.
  console.log('\n== Latest TEST ORDERs (as listed in each business\'s Orders page)');
  for (const r of await one(`SELECT o.reference, b.slug AS business, lp.slug AS page, o.status, o.total_minor, o.currency, o.sheet_sync_status, o.created_at,
                                    (SELECT string_agg(i.product_name || ' x' || i.quantity || CASE WHEN i.is_upsell THEN ' (add-on)' ELSE '' END, ', ' ORDER BY i.id)
                                       FROM order_items i WHERE i.order_id = o.id) AS items,
                                    (SELECT count(*)::int FROM orders d WHERE d.business_id = o.business_id AND d.idempotency_key = o.idempotency_key) AS copies
                               FROM orders o JOIN businesses b ON b.id = o.business_id LEFT JOIN landing_pages lp ON lp.id = o.landing_page_id
                              WHERE o.is_test ORDER BY o.id DESC LIMIT 6`)) {
    line(`order: ${r.reference}`, `business ${r.business}; page ${r.page ?? '-'}; ${r.items}; total ${(r.total_minor / 100).toLocaleString('en-NG')} ${r.currency}; status ${r.status}; sheet ${r.sheet_sync_status}; orders for this submission: ${r.copies}; ${r.created_at.toISOString()}`);
  }
  await client.query('ROLLBACK');
} finally {
  await client.end();
}
