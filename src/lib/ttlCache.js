// A small in-memory cache with a time limit and a size limit (oldest entries go first). Used for
// public data many visitors ask for (a page's tracking IDs, its catalog, which page a slug is), so
// a busy page does not repeat the same database queries for every visitor. Off when ttlMs is 0.
export function ttlCache({ ttlMs, max = 5000 }) {
  const map = new Map();
  return {
    enabled: ttlMs > 0,
    async get(key, load) {
      if (!(ttlMs > 0)) return load();
      const hit = map.get(key);
      if (hit && hit.until > Date.now()) return hit.value;
      // Concurrent misses share one load.
      if (hit?.loading) return hit.loading;
      const loading = load();
      map.set(key, { until: 0, loading });
      try {
        const value = await loading;
        map.delete(key);
        map.set(key, { until: Date.now() + ttlMs, value });
        while (map.size > max) map.delete(map.keys().next().value);
        return value;
      } catch (err) { map.delete(key); throw err; }
    },
    clear() { map.clear(); },
    size() { return map.size; },
  };
}
