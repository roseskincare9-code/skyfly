// Changes the INSTANCE TYPE of the existing Render database "skyfly-db" (same database, same data, same
// connection string). Never creates or deletes a database. Runs only with CONFIRM="upgrade skyfly-db";
// otherwise it only prints the current state (dry run). Requires a payment method on the Render workspace.
//   RENDER_API_KEY=… PLAN=basic_256mb CONFIRM="upgrade skyfly-db" node scripts/db-upgrade.mjs
const RENDER = 'https://api.render.com/v1';
const api = async (path, opts = {}) => {
  const res = await fetch(`${RENDER}${path}`, { ...opts, headers: { Authorization: `Bearer ${process.env.RENDER_API_KEY}`, Accept: 'application/json', 'Content-Type': 'application/json', ...(opts.headers || {}) } });
  const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, json, text: text.slice(0, 500) };
};
const PLAN = String(process.env.PLAN || 'basic_256mb');
if (!/^basic_(256mb|1gb|4gb)$/.test(PLAN)) throw new Error(`Refusing plan "${PLAN}" (allowed: basic_256mb, basic_1gb, basic_4gb)`);
let db = null;
for (const o of ((await api('/owners?limit=20')).json || []).map((x) => x.owner ?? x)) {
  db ||= ((await api(`/postgres?ownerId=${encodeURIComponent(o.id)}&limit=100`)).json || []).map((x) => x.postgres ?? x).find((x) => x.name === 'skyfly-db');
}
if (!db) throw new Error('skyfly-db not found');
const show = async (label) => { const d = (await api(`/postgres/${db.id}`)).json ?? {}; console.log(`${label}: plan ${d.plan}, status ${d.status}, expires ${d.expiresAt ?? 'never'}, disk ${d.diskSizeGB ?? '?'} GB`); return d; };
const before = await show('Before');
if (process.env.CONFIRM !== 'upgrade skyfly-db') { console.log(`Dry run only. To upgrade to ${PLAN}, run again with confirm = "upgrade skyfly-db".`); process.exit(0); }
if (before.plan === PLAN) { console.log(`Already on ${PLAN}; nothing to do.`); process.exit(0); }
const r = await api(`/postgres/${db.id}`, { method: 'PATCH', body: JSON.stringify({ plan: PLAN }) });
console.log(`Render answered HTTP ${r.status}${r.status >= 300 ? `: ${r.text}` : ''}`);
if (r.status >= 300) {
  console.log('Not upgraded. If Render mentions billing or a payment method, add a card at https://dashboard.render.com/billing (workspace "skyfly") and run this again.');
  process.exit(1);
}
for (let i = 0; i < 40; i += 1) {
  await new Promise((res) => setTimeout(res, 15000));
  const d = await show(`After ${(i + 1) * 15}s`);
  if (d.plan === PLAN && d.status === 'available') { console.log('Upgrade complete: same database, now on the paid plan.'); process.exit(0); }
}
console.log('Still changing after 10 minutes: check the Render dashboard; the database keeps its data.');
