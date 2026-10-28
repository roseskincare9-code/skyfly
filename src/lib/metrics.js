// In-memory measurements for Platform admin → Capacity: response times, errors and "busy" answers
// per business and kind of request, database connection use, event-loop delay, CPU and memory.
// Kept per minute for the last hour (this server instance only; nothing is stored in the database).
import { monitorEventLoopDelay } from 'node:perf_hooks';

const MINUTES = 60;
// Latency buckets (ms): enough to tell p50/p95/p99 apart where it matters.
const BUCKETS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, Infinity];

function emptyMinute(t) { return { t, groups: new Map(), pool: { samples: 0, waitingMax: 0, waitingSum: 0, busyMax: 0, busySum: 0, timeouts: 0 }, loop: { p99Max: 0 }, cpuMs: 0 }; }

export function createMetrics({ now = () => Date.now() } = {}) {
  const minutes = [];
  const minuteOf = (ms) => Math.floor(ms / 60000);
  function current() {
    const t = minuteOf(now());
    let m = minutes[minutes.length - 1];
    if (!m || m.t !== t) {
      m = emptyMinute(t);
      minutes.push(m);
      while (minutes.length > MINUTES) minutes.shift();
    }
    return m;
  }
  function group(m, business, kind) {
    const key = `${business}\u0000${kind}`;
    let g = m.groups.get(key);
    if (!g) { g = { business, kind, n: 0, errors: 0, busy: 0, buckets: new Array(BUCKETS.length).fill(0), sumMs: 0 }; m.groups.set(key, g); }
    return g;
  }

  const loop = monitorEventLoopDelay({ resolution: 20 });
  loop.enable();
  let lastCpu = process.cpuUsage();

  return {
    // One finished public request.
    request(business, kind, ms, status) {
      const g = group(current(), business ?? '-', kind);
      g.n += 1;
      g.sumMs += ms;
      g.buckets[BUCKETS.findIndex((b) => ms <= b)] += 1;
      if (status >= 500 && status !== 503) g.errors += 1;
      if (status === 503) g.busy += 1;
    },
    // Sampled every few seconds by the server.
    sample(pool) {
      const m = current();
      if (pool) {
        const busy = pool.totalCount - pool.idleCount;
        m.pool.samples += 1;
        m.pool.waitingMax = Math.max(m.pool.waitingMax, pool.waitingCount);
        m.pool.waitingSum += pool.waitingCount;
        m.pool.busyMax = Math.max(m.pool.busyMax, busy);
        m.pool.busySum += busy;
      }
      m.loop.p99Max = Math.max(m.loop.p99Max, loop.percentile(99) / 1e6);
      loop.reset();
      const cpu = process.cpuUsage(lastCpu);
      lastCpu = process.cpuUsage();
      m.cpuMs += (cpu.user + cpu.system) / 1000;
    },
    poolTimeout() { current().pool.timeouts += 1; },
    // Totals over the last `windowMinutes`.
    report(windowMinutes = 15) {
      const from = minuteOf(now()) - windowMinutes + 1;
      const recent = minutes.filter((m) => m.t >= from);
      const merged = new Map();
      const pool = { samples: 0, waitingMax: 0, waitingSum: 0, busyMax: 0, busySum: 0, timeouts: 0 };
      let loopP99 = 0; let cpuMs = 0;
      for (const m of recent) {
        for (const g of m.groups.values()) {
          const key = `${g.business}\u0000${g.kind}`;
          const t = merged.get(key) ?? { business: g.business, kind: g.kind, n: 0, errors: 0, busy: 0, buckets: new Array(BUCKETS.length).fill(0), sumMs: 0 };
          t.n += g.n; t.errors += g.errors; t.busy += g.busy; t.sumMs += g.sumMs;
          g.buckets.forEach((c, i) => { t.buckets[i] += c; });
          merged.set(key, t);
        }
        for (const k of Object.keys(pool)) pool[k] = k.endsWith('Max') ? Math.max(pool[k], m.pool[k]) : pool[k] + m.pool[k];
        loopP99 = Math.max(loopP99, m.loop.p99Max);
        cpuMs += m.cpuMs;
      }
      const pct = (buckets, n, p) => {
        if (!n) return null;
        let seen = 0;
        for (let i = 0; i < buckets.length; i += 1) { seen += buckets[i]; if (seen >= n * p) return BUCKETS[i] === Infinity ? '>10000' : BUCKETS[i]; }
        return null;
      };
      const seconds = Math.max(1, (minuteOf(now()) - (recent[0]?.t ?? minuteOf(now()))) * 60 + (now() % 60000) / 1000);
      const rows = [...merged.values()].map((g) => ({
        business: g.business, kind: g.kind, requests: g.n, perMinute: +(g.n / (seconds / 60)).toFixed(1),
        avgMs: Math.round(g.sumMs / g.n), p50: pct(g.buckets, g.n, 0.5), p95: pct(g.buckets, g.n, 0.95), p99: pct(g.buckets, g.n, 0.99),
        errors: g.errors, busy: g.busy,
      })).sort((a, b) => b.requests - a.requests);
      return {
        windowMinutes, seconds: Math.round(seconds), rows,
        pool: { ...pool, waitingAvg: pool.samples ? +(pool.waitingSum / pool.samples).toFixed(2) : 0, busyAvg: pool.samples ? +(pool.busySum / pool.samples).toFixed(2) : 0 },
        eventLoopP99Ms: +loopP99.toFixed(1),
        cpuPercent: +(cpuMs / (seconds * 1000) * 100).toFixed(1),
        memoryMb: Math.round(process.memoryUsage().rss / 1048576),
      };
    },
  };
}
