// Shared-platform protection for public traffic (Platform admin → Capacity shows its effect):
// - lanes: a business's public requests share the database fairly with every other business
//   (pages/tracking/catalog/"Tag loaded" in the "read" lane, orders in their own "order" lane, so
//   browsing can never crowd out checkouts);
// - caches: data that thousands of visitors ask for (which page a slug is, its tracking IDs, its
//   catalog, its rendered HTML) is read from the database once per cache period, not per visitor;
//   any change saved in the dashboard clears them, so owners see their changes at once;
// - measurements of response times, errors, "busy" answers, connections, CPU and memory.
import { createLane, BusyError } from '../lib/fairness.js';
import { createMetrics } from '../lib/metrics.js';
import { ttlCache } from '../lib/ttlCache.js';

// Defaults (also in src/config.js, where each can be changed with an environment variable).
export const FAIRNESS_DEFAULTS = {
  readPerBusiness: 4, readTotal: 10, readQueue: 200, readWaitMs: 5000,
  orderPerBusiness: 3, orderTotal: 6, orderQueue: 100, orderWaitMs: 15000,
};

export function createLoadControl({ pool, config }) {
  const f = { ...FAIRNESS_DEFAULTS, ...config.fairness };
  const metrics = createMetrics();
  const lanes = {
    read: createLane({ name: 'read', perKey: f.readPerBusiness, total: f.readTotal, maxQueue: f.readQueue, maxWaitMs: f.readWaitMs }),
    order: createLane({ name: 'order', perKey: f.orderPerBusiness, total: f.orderTotal, maxQueue: f.orderQueue, maxWaitMs: f.orderWaitMs }),
  };
  const ttl = config.publicCacheMs ?? 0;
  const caches = {
    businessOfSlug: ttlCache({ ttlMs: ttl, max: 20000 }),
    page: ttlCache({ ttlMs: ttl, max: 20000 }),
    tracking: ttlCache({ ttlMs: ttl, max: 20000 }),
    catalog: ttlCache({ ttlMs: ttl, max: 20000 }),
    html: ttlCache({ ttlMs: ttl, max: 2000 }),
  };
  // "Tag loaded" reports already recorded (the database only updates a pixel every 10 minutes).
  const seen = new Map();

  async function businessOfSlug(slug) {
    const s = String(slug ?? '').toLowerCase().slice(0, 80);
    if (!s) return 'unknown';
    return caches.businessOfSlug.get(s, async () => {
      const { rows: [p] } = await pool.query('SELECT business_id FROM landing_pages WHERE slug = $1', [s]);
      return p ? String(p.business_id) : 'unknown';
    });
  }

  // Takes a slot in the lane for this business; the slot is given back as soon as the response is
  // handed to the network (a slow phone downloading an image never holds a database slot).
  async function enter(lane, business, kind, res) {
    const started = performance.now();
    const key = String(business ?? 'unknown');
    res.once('finish', () => metrics.request(key, kind, performance.now() - started, res.statusCode));
    let leave;
    try {
      leave = await lanes[lane].enter(key, res);
    } catch (err) {
      if (!(err instanceof BusyError)) throw err;
      res.set('Retry-After', '2').set('Cache-Control', 'no-store');
      if (kind === 'page' || kind === 'asset') res.status(503).type('text/plain').send('This page is very busy right now. Please try again in a moment.');
      else res.status(503).json({ ok: false, error: 'BUSY', message: 'We are very busy right now. Please try again in a moment.' });
      return false;
    }
    const end = res.end;
    res.end = function endAndRelease(...args) {
      leave();
      return end.apply(this, args);
    };
    return true;
  }

  // Express middleware for the public API: the business is found from the page named in the request.
  function guard(lane, kind, slugOf) {
    return async (req, res, next) => {
      if (req.method === 'OPTIONS') return next();
      try {
        const business = await businessOfSlug(slugOf(req));
        if (await enter(lane, business, kind, res)) next();
      } catch (err) { next(err); }
    };
  }

  function alreadySeen(pageSlug, pixels) {
    if (!(ttl > 0)) return false;
    const key = `${pageSlug}|${(Array.isArray(pixels) ? pixels : []).map((p) => `${p?.provider}:${p?.id}`).sort().join(',')}`;
    const at = seen.get(key);
    if (at && Date.now() - at < 10 * 60 * 1000) return true;
    seen.set(key, Date.now());
    while (seen.size > 20000) seen.delete(seen.keys().next().value);
    return false;
  }

  function clearCaches() {
    for (const c of Object.values(caches)) c.clear();
    seen.clear();
  }

  const sampler = setInterval(() => metrics.sample(pool), 5000);
  sampler.unref();

  return {
    metrics, lanes, caches, enter, guard, businessOfSlug, alreadySeen, clearCaches,
    stop() { clearInterval(sampler); },
    status() {
      return {
        lanes: Object.fromEntries(Object.entries(lanes).map(([k, l]) => [k, { ...l.limits, ...l.snapshot() }])),
        pool: { max: config.dbPoolMax, open: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount },
        cacheSeconds: ttl / 1000,
      };
    },
  };
}
