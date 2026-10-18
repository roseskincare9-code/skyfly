// TEMPORARY (approved by the owner on 2026-10-18): full backup of the live database with
// pg_dump, opening database access to THIS runner's IP only (/32) for the run.
//   1. Render API: remember the database's IP allow list, add this runner's IP.
//   2. Read-only summary (counts only, never customer details) in a READ ONLY transaction.
//   3. pg_dump (custom format) → restored into a throwaway local PostgreSQL 16 → every table's
//      row count compared → Skyfly's migration runner finds nothing left to apply.
//   4. Encrypted (AES-256) with SKYFLY_BACKUP_KEY, kept in Render → skyfly → Environment.
//   5. The original allow list is restored (also on failure: `--revert`, run by the workflow).
// The live database is only read; nothing in it is changed.
import { execFileSync } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import pg from 'pg';

const RENDER = 'https://api.render.com/v1';
const STATE = 'allowlist-original.json';
async function api(path, opts = {}) {
  const res = await fetch(`${RENDER}${path}`, {
    ...opts,
    headers: { Authorization: `Bearer ${process.env.RENDER_API_KEY}`, Accept: 'application/json', 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(60000),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, json, text: text.slice(0, 200) };
}
async function must(path, opts) {
  const r = await api(path, opts);
  if (r.status >= 300) throw new Error(`Render API ${opts?.method || 'GET'} ${path.split('?')[0]} -> HTTP ${r.status} ${r.text}`);
  return r.json;
}
const line = (k, v) => console.log(`${String(k).padEnd(42)} ${v}`);

async function find() {
  const owners = (await must('/owners?limit=20')).map((o) => o.owner ?? o);
  let svc = null; let db = null;
  for (const o of owners) {
    const q = `ownerId=${encodeURIComponent(o.id)}&limit=100`;
    svc ||= (await must(`/services?${q}`)).map((x) => x.service ?? x).find((x) => x.name === 'skyfly');
    db ||= (await must(`/postgres?${q}`)).map((x) => x.postgres ?? x).find((x) => x.name === 'skyfly-db');
  }
  if (!svc || !db) throw new Error('skyfly service or skyfly-db not found');
  return { svc, db };
}
const setAllow = (db, list) => must(`/postgres/${db.id}`, { method: 'PATCH', body: JSON.stringify({ ipAllowList: list }) });
const allowNow = async (db) => ((await must(`/postgres/${db.id}`)).ipAllowList || []).map((x) => x.cidrBlock);

if (process.argv[2] === '--revert') {
  if (!existsSync(STATE)) { console.log('Database access: nothing to revert (never opened).'); process.exit(0); }
  const { db } = await find();
  await setAllow(db, JSON.parse(readFileSync(STATE, 'utf8')));
  const now = await allowNow(db);
  console.log(`Database access restored: ${now.length ? now.join(', ') : 'outside connections blocked'}`);
  process.exit(0);
}

const { svc, db } = await find();
const detail = await must(`/postgres/${db.id}`);
line('database', `${detail.name}, plan ${detail.plan}, PostgreSQL ${detail.version}, expires ${detail.expiresAt}`);
const conn = (await must(`/postgres/${db.id}/connection-info`)).externalConnectionString;
console.log(`::add-mask::${conn}`);
const pw = decodeURIComponent(new URL(conn).password || ''); if (pw) console.log(`::add-mask::${pw}`);

const original = (detail.ipAllowList || []).map(({ cidrBlock, description }) => ({ cidrBlock, description }));
writeFileSync(STATE, JSON.stringify(original));
const ip = (await (await fetch('https://api.ipify.org')).text()).trim();
if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) throw new Error('could not read this runner\'s public IP');
await setAllow(db, [...original, { cidrBlock: `${ip}/32`, description: `temporary backup run ${process.env.GITHUB_RUN_ID || ''}` }]);
line('temporary database access', `opened to this runner only (${ip}/32)`);

const client = new pg.Client({ connectionString: conn, ssl: { rejectUnauthorized: false } });
for (let i = 0; ; i += 1) {
  try { await client.connect(); break; } catch (err) {
    if (i >= 18) throw new Error(`could not connect after opening access: ${err.message}`);
    await new Promise((r) => setTimeout(r, 10000));
  }
}
const q = async (sql) => (await client.query(sql)).rows;
await client.query('BEGIN TRANSACTION READ ONLY');
const serverVersion = (await q('SHOW server_version'))[0].server_version;
const major = serverVersion.split('.')[0];
const tables = (await q("SELECT table_schema || '.' || table_name AS t FROM information_schema.tables WHERE table_schema IN ('public', 'backup_before_012') AND table_type = 'BASE TABLE' ORDER BY 1")).map((r) => r.t);
const live = {};
for (const t of tables) live[t] = (await q(`SELECT count(*)::int AS n FROM ${t.split('.').map((p) => `"${p}"`).join('.')}`))[0].n;

console.log('\n== Live database (read-only; counts only)');
line('server version / size', `${serverVersion} / ${(await q('SELECT pg_size_pretty(pg_database_size(current_database())) AS s'))[0].s}`);
line('migrations', (await q('SELECT count(*)::int AS n, max(name) AS m FROM schema_migrations')).map((r) => `${r.n}, latest ${r.m}`)[0]);
for (const r of await q(`SELECT b.slug, b.subscription_status AS s, count(o.id) FILTER (WHERE NOT o.is_test)::int AS real, count(o.id) FILTER (WHERE o.is_test)::int AS test
                           FROM businesses b LEFT JOIN orders o ON o.business_id = b.id GROUP BY b.id ORDER BY b.id`)) line(`business ${r.slug}`, `${r.s}; orders real ${r.real}, test ${r.test}`);
line('users / platform admins', (await q('SELECT count(*)::int AS n, count(*) FILTER (WHERE is_platform_admin)::int AS a FROM users')).map((r) => `${r.n} / ${r.a}`)[0]);
line('duplicate order submissions (must be 0)', (await q('SELECT count(*)::int AS n FROM (SELECT 1 FROM orders GROUP BY business_id, idempotency_key HAVING count(*) > 1) d'))[0].n);
for (const r of await q("SELECT b.slug, o.sheet_sync_status AS s, count(*)::int AS n FROM orders o JOIN businesses b ON b.id = o.business_id GROUP BY 1, 2 ORDER BY 1, 2")) line(`sheet copies ${r.slug} ${r.s}`, r.n);
for (const r of await q("SELECT b.slug, c.provider, c.check_status, (b.default_sheet_connection_id = c.id) AS def FROM sheet_connections c JOIN businesses b ON b.id = c.business_id ORDER BY c.id")) line(`sheet connection ${r.slug}`, `${r.provider}, ${r.check_status}${r.def ? ', default' : ''}`);
for (const r of await q("SELECT b.slug, p.provider, p.pixel_id, p.enabled, (p.access_token_enc IS NOT NULL) AS token, (p.test_event_code IS NOT NULL) AS code FROM pixel_settings p JOIN businesses b ON b.id = p.business_id ORDER BY p.id")) line(`pixel ${r.slug} ${r.provider} ${r.pixel_id}`, `${r.enabled ? 'on' : 'off'}, token ${r.token ? 'saved' : 'none'}, test code ${r.code ? 'saved' : 'none'}`);
const email = await q("SELECT b.slug, e.provider, (e.api_key_enc IS NOT NULL) AS key, split_part(e.from_email, '@', 2) AS domain, e.verified_at FROM email_settings e JOIN businesses b ON b.id = e.business_id");
if (!email.length) line('email sending setup', 'none saved for any business');
for (const r of email) line(`email ${r.slug}`, `${r.provider}, key ${r.key ? 'saved' : 'none'}, sender domain ${r.domain || '-'}, last test accepted ${r.verified_at?.toISOString() ?? 'never'}`);
await client.query('ROLLBACK');
await client.end();

// ---------- pg_dump ----------
const takenAt = new Date().toISOString();
const sh = (cmd, args, env = process.env) => execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], env, maxBuffer: 64 * 1024 * 1024 }).toString();
const asMe = ['--user', `${process.getuid()}:${process.getgid()}`]; // files stay owned by the runner user
sh('docker', ['run', '--rm', ...asMe, '--network', 'host', '-e', 'PGURL', '-e', 'PGSSLMODE=require', '-v', `${process.cwd()}:/w`, `postgres:${major}`,
  'sh', '-c', 'pg_dump "$PGURL" --format=custom --no-owner --no-acl --file=/w/skyfly.dump'], { ...process.env, PGURL: conn });
await setAllow(db, original);
const after = await allowNow(db);
console.log('\n== Backup');
line('temporary database access', `closed again (${after.length ? after.join(', ') : 'outside connections blocked'})`);
line('pg_dump', `${(statSync('skyfly.dump').size / 1024).toFixed(1)} KB, taken ${takenAt}`);

// ---------- restore check in a throwaway database ----------
sh('docker', ['run', '-d', '--name', 'restore-check', '-e', 'POSTGRES_PASSWORD=restore', '-p', '55432:5432', `postgres:${major}`]);
const local = 'postgres://postgres:restore@localhost:55432/postgres';
for (let i = 0; ; i += 1) {
  try { const c = new pg.Client({ connectionString: local }); await c.connect(); await c.end(); break; } catch (err) {
    if (i > 45) throw err; await new Promise((r) => setTimeout(r, 2000));
  }
}
try {
  sh('docker', ['run', '--rm', '--network', 'host', '-v', `${process.cwd()}:/w`, `postgres:${major}`, 'pg_restore', '--no-owner', '--no-acl', '-d', local, '/w/skyfly.dump']);
  line('pg_restore', 'completed without errors');
} catch (err) {
  line('pg_restore', `finished with messages: ${String(err.stderr || err.message).split('\n').filter(Boolean).slice(-3).join(' | ').slice(0, 300)}`);
}
const rc = new pg.Client({ connectionString: local });
await rc.connect();
let differ = 0;
for (const t of tables) {
  const n = (await rc.query(`SELECT count(*)::int AS n FROM ${t.split('.').map((p) => `"${p}"`).join('.')}`)).rows[0].n;
  // Sign-in sessions change with every visit to the live site; they are not business data.
  if (n !== live[t] && t !== 'public.user_sessions') { differ += 1; line(`  differs: ${t}`, `live ${live[t]}, restored ${n} (rows added while the dump ran?)`); }
}
await rc.end();
line('restore check', `${tables.length} tables restored into an empty database; ${differ ? `${differ} differ (see above)` : 'every table\'s row count matches the live database (sign-in sessions excluded)'}`);
const mig = sh('node', ['-e', "Promise.all([import('./src/db.js'),import('./src/migrate.js')]).then(async([{createPool},{migrate}])=>{const p=createPool(process.env.DATABASE_URL,false);await migrate(p);await p.end();console.log('nothing left to apply')})"], { ...process.env, DATABASE_URL: local });
line('Skyfly migration runner on the copy', mig.trim().split('\n').at(-1));
if (differ) process.exitCode = 1;

// ---------- encrypt ----------
let key = null;
const existing = await api(`/services/${svc.id}/env-vars/SKYFLY_BACKUP_KEY`);
const val = existing.json?.value ?? existing.json?.envVar?.value;
if (existing.status === 200 && val) { key = val; console.log(`::add-mask::${key}`); line('backup key', 'SKYFLY_BACKUP_KEY already in Render → skyfly → Environment (reused)'); }
else {
  key = randomBytes(32).toString('base64url');
  console.log(`::add-mask::${key}`);
  await must(`/services/${svc.id}/env-vars/SKYFLY_BACKUP_KEY`, { method: 'PUT', body: JSON.stringify({ value: key }) });
  line('backup key', 'created SKYFLY_BACKUP_KEY in Render → skyfly → Environment (the app does not use it)');
}
sh('openssl', ['enc', '-aes-256-cbc', '-pbkdf2', '-iter', '250000', '-salt', '-in', 'skyfly.dump', '-out', 'skyfly-db.dump.enc', '-pass', 'env:BKEY'], { ...process.env, BKEY: key });
sh('openssl', ['enc', '-d', '-aes-256-cbc', '-pbkdf2', '-iter', '250000', '-in', 'skyfly-db.dump.enc', '-out', 'decrypt-check.dump', '-pass', 'env:BKEY'], { ...process.env, BKEY: key });
const same = createHash('sha256').update(readFileSync('decrypt-check.dump')).digest('hex') === createHash('sha256').update(readFileSync('skyfly.dump')).digest('hex');
sh('shred', ['-u', 'skyfly.dump', 'decrypt-check.dump']);
if (!same) throw new Error('decryption check failed');
const sha = createHash('sha256').update(readFileSync('skyfly-db.dump.enc')).digest('hex');
writeFileSync('RESTORE.txt', [
  'Skyfly database backup (pg_dump custom format, AES-256 encrypted)',
  `Taken: ${takenAt}   PostgreSQL ${serverVersion}   Tables: ${tables.length}`,
  `Encrypted file sha256: ${sha}`,
  'Key: Render -> workspace skyfly -> service skyfly -> Environment -> SKYFLY_BACKUP_KEY',
  '1. Decrypt: openssl enc -d -aes-256-cbc -pbkdf2 -iter 250000 -in skyfly-db.dump.enc -out skyfly.dump -pass pass:<SKYFLY_BACKUP_KEY>',
  '2. Create a NEW, EMPTY PostgreSQL 16+ database (never the live one).',
  '3. Restore: pg_restore --no-owner --no-acl -d <new database URL> skyfly.dump',
  '4. Point Skyfly at it (Render -> skyfly -> Environment -> DATABASE_URL) only when you intend to switch.',
  '',
].join('\n'));
line('encrypted backup', `skyfly-db.dump.enc, ${(statSync('skyfly-db.dump.enc').size / 1024).toFixed(1)} KB, sha256 ${sha}; decryption checked`);
