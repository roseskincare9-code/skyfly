// Isolated load test: one high-traffic business (Larose-like) next to many normal businesses, on a
// throwaway database and a local Skyfly server in production mode. Never touches the live site,
// the live database or any Google Sheet (no sheet is connected in the throwaway database).
//
//   node scripts/load-test.mjs [--normal 40] [--normal-rate 0.1] [--heavy 0,10,25,50,100] [--seconds 30]
//
// Each simulated visitor does what a real one does on a published page: the page, its CSS and
// image, the Skyfly script, the page's tracking and catalog, the "Tag loaded" report; 2% place an
// order. Visitors arrive at a fixed rate (open loop), so a slow server builds a backlog the way
// real traffic does. Reports latency (p50/p95/p99), errors, throughput, the server's CPU time per
// visitor and the database work per visitor, separately for the heavy business and the others.
import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { migrate } from '../src/migrate.js';
import { saveVersion } from '../src/hosting/storage.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, def) => { const i = process.argv.indexOf(`--${name}`); return i === -1 ? def : process.argv[i + 1]; };
const NORMAL = Number(arg('normal', 40));
const NORMAL_RATE = Number(arg('normal-rate', 0.1)); // visitors per second, per normal business
const HEAVY = String(arg('heavy', '0,10,25,50,100')).split(',').map(Number);
const SECONDS = Number(arg('seconds', 30));
const ORDER_SHARE = Number(arg('orders', 0.02));
const PORT = 3300;
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN_URL = process.env.LOAD_ADMIN_DATABASE_URL || 'postgres://skyfly:skyfly@localhost:5432/skyfly_test';
const DB_NAME = 'skyfly_load';
const DB_URL = ADMIN_URL.replace(/\/[^/]+$/, `/${DB_NAME}`);
const OUT = arg('out', null);

// ---------- throwaway database ----------
async function freshDatabase() {
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${DB_NAME}`);
  await admin.end();
  const pool = new pg.Pool({ connectionString: DB_URL, max: 4 });
  await migrate(pool);
  return pool;
}

const file = (p, contentType, data) => ({ path: p, contentType, size: data.length, sha256: createHash('sha256').update(data).digest('hex'), data });
function pageFiles(i) {
  // About the size of a real landing page: ~30 KB HTML, ~8 KB CSS, one ~80 KB image.
  const sections = Array.from({ length: 60 }, (_, k) => `<section><h2>Benefit ${k}</h2><p>${'Glowing skin with natural ingredients. '.repeat(10)}</p></section>`).join('\n');
  const html = Buffer.from(`<!doctype html><html><head><meta charset="utf-8"><title>Shop ${i}</title><link rel="stylesheet" href="style.css"></head><body><img src="hero.jpg" alt="">${sections}<form id="order"><button>Order now</button></form></body></html>`);
  const css = Buffer.from(`${Array.from({ length: 200 }, (_, k) => `.c${k}{margin:${k}px;padding:${k % 9}px;color:#${(k * 4321).toString(16).slice(0, 6).padEnd(6, '0')}}`).join('\n')}`);
  return [file('index.html', 'text/html; charset=utf-8', html), file('style.css', 'text/css; charset=utf-8', css), file('hero.jpg', 'image/jpeg', randomBytes(80_000))];
}

async function seed(pool) {
  const { rows: [u] } = await pool.query("INSERT INTO users (email, password_hash, name) VALUES ('load@skyfly.test', 'x', 'Load') RETURNING id");
  const businesses = [];
  for (let i = 0; i <= NORMAL; i += 1) {
    const heavy = i === 0;
    const slug = heavy ? 'larose-load' : `shop-${i}`;
    const { rows: [b] } = await pool.query(
      "INSERT INTO businesses (owner_id, name, slug, currency) VALUES ($1, $2, $3, 'NGN') RETURNING id", [u.id, heavy ? 'Larose (load test)' : `Shop ${i}`, slug]);
    const { rows: [lp] } = await pool.query(
      "INSERT INTO landing_pages (business_id, slug, name, status, order_destination) VALUES ($1, $2, $3, 'active', 'checkout') RETURNING id", [b.id, `${slug}-page`, `Page ${i}`]);
    for (const [k, price] of [[1, 26500], [2, 36500]]) {
      const { rows: [p] } = await pool.query('INSERT INTO products (business_id, code, name, price_minor, sort_order) VALUES ($1, $2, $3, $4, $5) RETURNING id', [b.id, `package-${k}`, `Package ${k}`, price * 100, k]);
      await pool.query('INSERT INTO landing_page_products (landing_page_id, product_id) VALUES ($1, $2)', [lp.id, p.id]);
    }
    // Larose-like: 7 Meta pixels; others: 2.
    for (let k = 0; k < (heavy ? 7 : 2); k += 1) {
      await pool.query("INSERT INTO tracking_pixels (business_id, platform, name, pixel_id, enabled, all_pages, events) VALUES ($1, 'meta', $2, $3, true, true, ARRAY['PageView','ViewContent','InitiateCheckout','Lead','Purchase'])",
        [b.id, `Pixel ${k}`, String(1000000000000000 + i * 100 + k)]);
    }
    const files = pageFiles(i);
    const versionId = await saveVersion(pool, { pageId: lp.id, userId: u.id, upload: { files, sourceName: 'load.zip', entryPath: 'index.html', totalBytes: files.reduce((s, f) => s + f.size, 0), report: {} } });
    await pool.query('UPDATE landing_pages SET published_version_id = $1 WHERE id = $2', [versionId, lp.id]);
    businesses.push({ heavy, page: `${slug}-page`, pixels: heavy ? 7 : 2 });
  }
  return businesses;
}

// ---------- server ----------
function startServer() {
  const env = {
    ...process.env, NODE_ENV: 'production', PORT: String(PORT), DATABASE_URL: DB_URL, DATABASE_SSL: 'false',
    SESSION_SECRET: 'load-test-session-secret-0123456789abcdef', PUBLIC_BASE_URL: BASE,
    SKYFLY_ENCRYPTION_KEY: randomBytes(32).toString('base64'), LIVE_CHECK: 'off', DEMO_SITE: 'off',
    // Allows a few hundred orders from one simulated IP range without hitting the per-IP limit.
    ORDER_RATE_LIMIT: '100000', SHEET_SYNC: 'off', EMAIL_WORKER: 'off',
  };
  // The server gets one CPU core of its own (Render instances have one or less).
  const child = spawn('taskset', ['-c', '0', process.execPath, 'src/server.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr.on('data', (d) => { if (process.env.LOAD_VERBOSE) process.stderr.write(d); });
  return new Promise((resolve, reject) => {
    child.stdout.on('data', (d) => { if (/listening on port/.test(String(d))) resolve(child); });
    child.on('exit', (code) => reject(new Error(`server exited ${code}`)));
  });
}
const cpuMs = (pid) => {
  try {
    const f = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ');
    return (Number(f[11]) + Number(f[12])) * 10; // utime + stime, in ms (100 ticks/s)
  } catch { return 0; }
};
// Postgres CPU: every postgres process's own CPU time plus that of its finished children.
const postgresCpuMs = () => execFileSync('pgrep', ['-x', 'postgres'], { encoding: 'utf8' }).split('\n').filter(Boolean).reduce((s, pid) => {
  try { const f = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' '); return s + (Number(f[11]) + Number(f[12]) + Number(f[13]) + Number(f[14])) * 10; } catch { return s; }
}, 0);

// ---------- traffic ----------
const stats = new Map(); // `${group}:${kind}` -> { lat: [], errors: {}, n }
function record(group, kind, ms, status) {
  const key = `${group}:${kind}`;
  if (!stats.has(key)) stats.set(key, { lat: [], errors: {}, n: 0 });
  const s = stats.get(key);
  s.n += 1;
  s.lat.push(ms);
  if (!(status >= 200 && status < 400)) s.errors[status] = (s.errors[status] ?? 0) + 1;
}
const TIMEOUT_MS = 20_000; // a visitor gives up after 20 s
async function hit(group, kind, url, opts = {}) {
  const t = performance.now();
  let status = 0;
  try {
    const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(TIMEOUT_MS) });
    await res.arrayBuffer();
    status = res.status;
  } catch (err) { status = err.name === 'TimeoutError' ? 'timeout' : 'network'; }
  record(group, kind, performance.now() - t, status);
  return status;
}
let ipSeq = 1;
async function visitor(b) {
  const group = b.heavy ? 'heavy' : 'normal';
  const ip = `10.${(ipSeq >> 16) & 255}.${(ipSeq >> 8) & 255}.${ipSeq++ & 255}`;
  const h = { 'X-Forwarded-For': ip, 'User-Agent': 'Mozilla/5.0 (load test)' };
  const page = `${BASE}/p/${b.page}/`;
  await hit(group, 'page', page, { headers: h });
  await Promise.all([
    hit(group, 'asset', `${page}style.css`, { headers: h }),
    hit(group, 'asset', `${page}hero.jpg`, { headers: h }),
    hit(group, 'asset', `${BASE}/sdk/skyfly.js`, { headers: h }),
    hit(group, 'api-read', `${BASE}/api/public/pages/${b.page}/tracking`, { headers: h }),
    hit(group, 'api-read', `${BASE}/api/public/pages/${b.page}/catalog`, { headers: h }),
  ]);
  await hit(group, 'beacon', `${BASE}/api/public/pixels-seen`, {
    method: 'POST', headers: { ...h, Origin: 'null', 'Content-Type': 'text/plain' },
    body: JSON.stringify({ page: b.page, pixels: Array.from({ length: b.pixels }, (_, k) => ({ provider: 'meta', id: String(k) })) }),
  });
  if (Math.random() < ORDER_SHARE) {
    await hit(group, 'order', `${BASE}/api/public/orders`, {
      method: 'POST', headers: { ...h, Origin: 'null', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        landingPage: b.page, idempotencyKey: `load-${randomBytes(12).toString('hex')}`,
        customer: { name: 'TEST ORDER load test', phone: '08051234567', address: '1 Load Test Street, Lagos' },
        items: [{ product: 'package-1', quantity: 1 }],
      }),
    });
  }
}

async function phase(businesses, heavyRate, seconds) {
  stats.clear();
  const inflight = new Set();
  let visitors = 0;
  const end = Date.now() + seconds * 1000;
  const groups = [
    ...(heavyRate > 0 ? [{ list: businesses.filter((b) => b.heavy), rate: heavyRate }] : []),
    ...businesses.filter((b) => !b.heavy).map((b) => ({ list: [b], rate: NORMAL_RATE })),
  ];
  const loops = groups.map(async (g) => {
    while (Date.now() < end) {
      await new Promise((r) => setTimeout(r, -Math.log(1 - Math.random()) * 1000 / g.rate)); // Poisson arrivals
      if (Date.now() >= end) break;
      visitors += 1;
      const p = visitor(g.list[0]).finally(() => inflight.delete(p));
      inflight.add(p);
    }
  });
  await Promise.all(loops);
  await Promise.all(inflight); // let the backlog finish (each request gives up after 20 s)
  return visitors;
}

const pct = (arr, p) => { if (!arr.length) return null; const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p / 100 * s.length))]; };
function summary() {
  const out = {};
  for (const [key, s] of stats) {
    const errs = Object.values(s.errors).reduce((a, b) => a + b, 0);
    out[key] = { n: s.n, p50: Math.round(pct(s.lat, 50)), p95: Math.round(pct(s.lat, 95)), p99: Math.round(pct(s.lat, 99)), errorRate: +(errs / s.n * 100).toFixed(2), errors: s.errors };
  }
  return out;
}

// ---------- run ----------
const pool = await freshDatabase();
const businesses = await seed(pool);
console.log(`Seeded ${businesses.length} businesses (1 high-traffic, ${NORMAL} normal), each with a published page.`);
const server = await startServer();
await phase(businesses, 1, 5); // warm-up
const results = [];
for (const rate of HEAVY) {
  const before = { cpu: cpuMs(server.pid), pg: postgresCpuMs(), xact: (await pool.query("SELECT xact_commit + xact_rollback AS n FROM pg_stat_database WHERE datname = $1", [DB_NAME])).rows[0].n };
  const t0 = Date.now();
  const visitors = await phase(businesses, rate, SECONDS);
  const elapsed = (Date.now() - t0) / 1000;
  const after = { cpu: cpuMs(server.pid), pg: postgresCpuMs(), xact: (await pool.query("SELECT xact_commit + xact_rollback AS n FROM pg_stat_database WHERE datname = $1", [DB_NAME])).rows[0].n };
  const r = {
    heavyVisitorsPerSecond: rate, normalVisitorsPerSecond: +(NORMAL * NORMAL_RATE).toFixed(2), visitors, seconds: +elapsed.toFixed(1),
    serverCpuMsPerVisitor: +((after.cpu - before.cpu) / visitors).toFixed(2),
    serverCpuBusy: +((after.cpu - before.cpu) / (elapsed * 1000) * 100).toFixed(1),
    postgresCpuMsPerVisitor: +((after.pg - before.pg) / visitors).toFixed(2),
    dbTransactionsPerVisitor: +((after.xact - before.xact) / visitors).toFixed(1),
    groups: summary(),
  };
  results.push(r);
  const g = r.groups;
  const line = (grp) => ['page', 'api-read', 'order'].map((k) => g[`${grp}:${k}`] ? `${k} p50 ${g[`${grp}:${k}`].p50} / p95 ${g[`${grp}:${k}`].p95} ms, err ${g[`${grp}:${k}`].errorRate}%` : `${k} -`).join('; ');
  console.log(`\nHigh-traffic business ${rate} visitors/s + others ${r.normalVisitorsPerSecond}/s: ${visitors} visitors, server CPU ${r.serverCpuBusy}% of one core (${r.serverCpuMsPerVisitor} ms/visitor), Postgres ${r.postgresCpuMsPerVisitor} ms/visitor, ${r.dbTransactionsPerVisitor} DB transactions/visitor`);
  if (rate > 0) console.log(`  high-traffic: ${line('heavy')}`);
  console.log(`  others:       ${line('normal')}`);
}
server.kill('SIGTERM');
await pool.end();
if (OUT) writeFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), normalBusinesses: NORMAL, normalRate: NORMAL_RATE, orderShare: ORDER_SHARE, results }, null, 2));
process.exit(0);
