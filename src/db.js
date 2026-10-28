import pg from 'pg';

// Return BIGINT/COUNT as JS numbers; all Skyfly amounts fit well within 2^53.
pg.types.setTypeParser(20, (v) => Number(v));
// DATE columns stay calendar dates ('2026-11-30'), never shifted by the server's time zone.
pg.types.setTypeParser(1082, (v) => v);

// The web server passes { max, statementTimeoutMs }: a stuck query is stopped instead of holding a
// connection, and a request waits at most 10 s for a free connection. Migrations and scripts use
// the defaults (no time limit: a migration may legitimately take long).
export function createPool(databaseUrl, ssl, { max = 10, statementTimeoutMs = 0 } = {}) {
  return new pg.Pool({
    connectionString: databaseUrl,
    // Hosted Postgres (Render external URL, Supabase) requires TLS.
    ssl: ssl ? { rejectUnauthorized: false } : false,
    max,
    ...(statementTimeoutMs ? {
      statement_timeout: statementTimeoutMs,
      idle_in_transaction_session_timeout: 60000,
      connectionTimeoutMillis: 10000,
    } : {}),
  });
}
