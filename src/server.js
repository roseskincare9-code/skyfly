import { loadConfig } from './config.js';
import { createPool } from './db.js';
import { createApp } from './app.js';
import { testOrderSummary } from './services/orders.js';
import { notificationReadiness } from './services/orderNotifications.js';
import { ensureLaroseForOwner, ensureDemoSite, ensureDemoUpsell, ensureLaroseHostedPage, ensureImportTestSite, ensureE2eAccount } from './services/setup.js';
import { optimizePublished } from './hosting/images.js';
import { startSheetWorker, recheckGoogleConnections, compareHeldGoogleConnections } from './services/sheets.js';
import { startEmailWorker } from './services/emailAutomation.js';
import { googleStatus, useServiceAccount, googleSelfCheck } from './services/googleSheetsApi.js';
import { storedGoogleKey } from './services/googleKey.js';

const config = loadConfig();
const pool = createPool(config.databaseUrl, config.databaseSsl, { max: config.dbPoolMax, statementTimeoutMs: config.dbStatementTimeoutMs });
// Copies orders to each business's Google Sheet. Only in production (or SHEET_SYNC=on), so local
// test servers never write to a real sheet.
const sheets = config.isProduction || process.env.SHEET_SYNC === 'on' ? startSheetWorker(pool, { key: config.encryptionKey }) : { kick() {}, stop() {} };
// Subscription expiry, email contacts, automation planning and sending (every minute).
// Only in production (or EMAIL_WORKER=on), so local servers never email anyone.
const jobs = config.isProduction || process.env.EMAIL_WORKER === 'on' ? startEmailWorker(pool, config) : { kick() {}, stop() {} };
// Google Sheets API (service account): yes/no results only, shown on /healthz. Never the key.
const google = Object.assign(googleStatus, { configured: false, setting: config.google.setting, problem: config.google.problem });
const app = createApp({
  pool, config, onOrderSaved: (id) => { sheets.kick(id); jobs.kick(); },
  workers: { email: jobs.status ?? null, sheets: sheets.status ?? null, google, startedAt: new Date().toISOString() },
});
// A key file uploaded in Platform admin is used first; otherwise the server setting.
(async () => {
  const stored = await storedGoogleKey(pool, config.encryptionKey).catch(() => null);
  if (stored && !stored.account) console.error(`Google Sheets API: the key file uploaded in Platform admin cannot be used: ${stored.problem}`);
  let r;
  if (stored?.account) r = await useServiceAccount(stored.account, 'key file uploaded in Platform admin');
  else if (config.google.serviceAccount) r = await useServiceAccount(config.google.serviceAccount, config.google.setting);
  else {
    if (config.google.setting) console.error(`Google Sheets API: ${config.google.setting} is set but cannot be used: ${config.google.problem}`);
    return;
  }
  console.log(`Google Sheets API: ${r.setting}; service account of project ${r.project}; sign-in ${r.auth}; Sheets API ${r.sheetsApi}`);
  // A spreadsheet saved while the key was not usable is checked now, read-only (same condition as the copy worker).
  if (r.auth === 'ok' && (config.isProduction || process.env.SHEET_SYNC === 'on')) {
    await recheckGoogleConnections(pool, config.encryptionKey);
    await compareHeldGoogleConnections(pool, config.encryptionKey);
  }
})().catch((err) => { google.auth = `check failed: ${err.message}`; });

// While sign-in or the Sheets API is not working yet (e.g. the API was just enabled in Google
// Cloud), check again every 5 minutes; once it works, saved spreadsheets are checked and their
// waiting orders compared (read-only). Nothing is copied by this.
const googleRetry = setInterval(async () => {
  if (!googleStatus.configured || (googleStatus.auth === 'ok' && googleStatus.sheetsApi === 'enabled')) return;
  try {
    Object.assign(googleStatus, await googleSelfCheck());
    console.log(`Google Sheets API: checked again; sign-in ${googleStatus.auth}; Sheets API ${googleStatus.sheetsApi}`);
    if (googleStatus.auth === 'ok' && googleStatus.sheetsApi === 'enabled' && (config.isProduction || process.env.SHEET_SYNC === 'on')) {
      await recheckGoogleConnections(pool, config.encryptionKey);
      await compareHeldGoogleConnections(pool, config.encryptionKey);
    }
  } catch (err) { console.error('Google Sheets API re-check failed:', err.message); }
}, 5 * 60 * 1000);
googleRetry.unref();

const server = app.listen(config.port, () => {
  console.log(`Skyfly listening on port ${config.port} (${config.env})`);
  ensureLaroseForOwner(pool, config).catch((err) => console.error('Automatic Larose setup failed:', err.message))
    .then(() => ensureDemoSite(pool, config)).then(() => (config.demoSite ? ensureDemoUpsell(pool) : null)).catch((err) => console.error('Demo site setup failed:', err.message))
    .then(() => ensureLaroseHostedPage(pool, config)).catch((err) => console.error('Larose hosted page setup failed:', err.message))
    .then(() => ensureImportTestSite(pool, config)).catch((err) => console.error('Import test site setup failed:', err.message))
    .then(() => ensureE2eAccount(pool)).catch((err) => console.error('Live-test account setup failed:', err.message))
    // WebP sizes for published pages that do not have them yet (e.g. published before this feature).
    .then(() => optimizePublished(pool))
    .then(() => testOrderSummary(pool, 8)).then((lines) => lines.forEach((l) => console.log(l))).catch((err) => console.error('Orders check failed:', err.message));
  notificationReadiness(pool, config).then((lines) => lines.forEach((l) => console.log(l))).catch((err) => console.error('Order notifications check failed:', err.message));
});

function shutdown() {
  sheets.stop();
  jobs.stop();
  server.close(() => pool.end().then(() => process.exit(0)));
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
