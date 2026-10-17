import { loadConfig } from './config.js';
import { createPool } from './db.js';
import { createApp } from './app.js';
import { ensureLaroseForOwner, ensureDemoSite } from './services/setup.js';
import { optimizePublished } from './hosting/images.js';
import { startSheetWorker } from './services/sheets.js';
import { startEmailWorker } from './services/emailAutomation.js';

const config = loadConfig();
const pool = createPool(config.databaseUrl, config.databaseSsl);
// Copies orders to each business's Google Sheet. Only in production (or SHEET_SYNC=on), so local
// test servers never write to a real sheet.
const sheets = config.isProduction || process.env.SHEET_SYNC === 'on' ? startSheetWorker(pool, { key: config.encryptionKey }) : { kick() {}, stop() {} };
// Subscription expiry, email contacts, automation planning and sending (every minute).
// Only in production (or EMAIL_WORKER=on), so local servers never email anyone.
const jobs = config.isProduction || process.env.EMAIL_WORKER === 'on' ? startEmailWorker(pool, config) : { kick() {}, stop() {} };
const app = createApp({
  pool, config, onOrderSaved: (id) => { sheets.kick(id); jobs.kick(); },
  workers: { email: jobs.status ?? null, sheets: sheets.status ?? null, startedAt: new Date().toISOString() },
});

const server = app.listen(config.port, () => {
  console.log(`Skyfly listening on port ${config.port} (${config.env})`);
  ensureLaroseForOwner(pool, config).catch((err) => console.error('Automatic Larose setup failed:', err.message))
    .then(() => ensureDemoSite(pool, config)).catch((err) => console.error('Demo site setup failed:', err.message))
    // WebP sizes for published pages that do not have them yet (e.g. published before this feature).
    .then(() => optimizePublished(pool));
});

function shutdown() {
  sheets.stop();
  jobs.stop();
  server.close(() => pool.end().then(() => process.exit(0)));
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
