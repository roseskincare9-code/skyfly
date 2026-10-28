// Fair sharing of the database between businesses for public traffic (pages, tracking, catalog,
// "Tag loaded" reports, orders). Each lane allows a business at most `perKey` requests at a time
// and all businesses together at most `total`, so one busy business can never take every database
// connection: other businesses' visitors, the dashboard and the background workers keep theirs.
// Requests over the limit wait in a short queue per business (bounded in length and time); when a
// slot frees up, businesses take turns (round robin), so a long queue of one business never delays
// another business's next request. A request that cannot get a slot in time gets "busy, try again".
export class BusyError extends Error {
  constructor(reason) { super(`busy: ${reason}`); this.reason = reason; }
}

export function createLane({ name, perKey, total, maxQueue, maxWaitMs, onEvent = () => {} }) {
  const active = new Map(); // key -> running requests
  const queues = new Map(); // key -> [{ resolve, reject, timer }]
  let running = 0;
  let rr = []; // round-robin order of keys with waiting requests

  const canRun = (key) => running < total && (active.get(key) ?? 0) < perKey;
  function start(key) {
    running += 1;
    active.set(key, (active.get(key) ?? 0) + 1);
  }
  function release(key) {
    running -= 1;
    const n = (active.get(key) ?? 1) - 1;
    if (n) active.set(key, n); else active.delete(key);
    // Next waiting request, taking businesses in turn.
    for (let i = 0; i < rr.length && running < total; ) {
      const k = rr[i];
      const q = queues.get(k);
      if (!q?.length) { rr.splice(i, 1); queues.delete(k); continue; }
      if (!canRun(k)) { i += 1; continue; }
      const next = q.shift();
      clearTimeout(next.timer);
      start(k);
      // Move this business to the back of the line.
      rr.splice(i, 1);
      if (q.length) rr.push(k); else queues.delete(k);
      next.resolve();
    }
  }
  function acquire(key) {
    if (canRun(key) && !queues.get(key)?.length) { start(key); return Promise.resolve(); }
    const q = queues.get(key) ?? [];
    if (q.length >= maxQueue) { onEvent('rejected', key, 'queue full'); return Promise.reject(new BusyError('queue full')); }
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, timer: null };
      entry.timer = setTimeout(() => {
        const i = q.indexOf(entry);
        if (i !== -1) q.splice(i, 1);
        onEvent('rejected', key, 'waited too long');
        reject(new BusyError('waited too long'));
      }, maxWaitMs);
      entry.timer.unref?.();
      q.push(entry);
      if (!queues.has(key)) { queues.set(key, q); rr.push(key); }
      onEvent('queued', key);
    });
  }
  return {
    name,
    limits: { perKey, total, maxQueue, maxWaitMs },
    async run(key, fn) {
      await acquire(key);
      try { return await fn(); } finally { release(key); }
    },
    // Express: holds a slot from now until the response is handed over (or the visitor left).
    // Returns the function that gives the slot back early; it is safe to call more than once.
    async enter(key, res) {
      await acquire(key);
      let done = false;
      const leave = () => { if (!done) { done = true; release(key); } };
      res.once('finish', leave);
      res.once('close', leave);
      return leave;
    },
    snapshot() {
      return {
        running, waiting: [...queues.values()].reduce((s, q) => s + q.length, 0),
        busiest: [...active.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5),
      };
    },
  };
}
