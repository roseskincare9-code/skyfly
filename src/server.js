import { loadConfig } from './config.js';
import { createPool } from './db.js';
import { createApp } from './app.js';
import { ensureLaroseForOwner } from './services/setup.js';

const config = loadConfig();
const pool = createPool(config.databaseUrl, config.databaseSsl);
const app = createApp({ pool, config });

const server = app.listen(config.port, () => {
  console.log(`Skyfly listening on port ${config.port} (${config.env})`);
  ensureLaroseForOwner(pool, config).catch((err) => console.error('Automatic Larose setup failed:', err.message));
});

function shutdown() {
  server.close(() => pool.end().then(() => process.exit(0)));
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
