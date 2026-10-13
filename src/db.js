import pg from 'pg';

// Return BIGINT/COUNT as JS numbers; all Skyfly amounts fit well within 2^53.
pg.types.setTypeParser(20, (v) => Number(v));

export function createPool(databaseUrl, ssl) {
  return new pg.Pool({
    connectionString: databaseUrl,
    // Hosted Postgres (Render external URL, Supabase) requires TLS.
    ssl: ssl ? { rejectUnauthorized: false } : false,
    max: 10,
  });
}
