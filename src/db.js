import pg from 'pg';

export function createPool(databaseUrl, isProduction) {
  return new pg.Pool({
    connectionString: databaseUrl,
    // Render's managed Postgres requires TLS on external connections.
    ssl: isProduction ? { rejectUnauthorized: false } : false,
    max: 10,
  });
}
