// Runs a background job on one server instance at a time (a Postgres advisory lock), so adding web
// instances never copies an order to a sheet twice or sends an email twice. With one instance it
// always runs. Returns null when another instance is already running the job.
export const JOB_LOCKS = { sheets: 7311001, email: 7311002 };

export async function singleRunner(pool, lockId, fn) {
  const client = await pool.connect();
  try {
    const { rows: [r] } = await client.query('SELECT pg_try_advisory_lock($1) AS ok', [lockId]);
    if (!r.ok) return null;
    try { return await fn(); } finally { await client.query('SELECT pg_advisory_unlock($1)', [lockId]).catch(() => {}); }
  } finally {
    client.release();
  }
}
