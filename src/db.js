import pg from 'pg';

// Return BIGINT/COUNT as JS numbers; all Skyfly amounts fit well within 2^53.
pg.types.setTypeParser(20, (v) => Number(v));
// DATE columns stay calendar dates ('2026-11-30'), never shifted by the server's time zone.
pg.types.setTypeParser(1082, (v) => v);

export function createPool(databaseUrl, ssl) {
  return new pg.Pool({
    connectionString: databaseUrl,
    // Hosted Postgres (Render external URL, Supabase) requires TLS.
    ssl: ssl ? { rejectUnauthorized: false } : false,
    max: 10,
  });
}
