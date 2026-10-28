// Reads and validates Skyfly's environment. Fails fast with a clear message
// so a misconfigured deploy never starts half-working.
import { readdirSync, readFileSync } from 'node:fs';
import { parseKey } from './lib/secrets.js';
import { readServiceAccount } from './services/googleSheetsApi.js';

function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function list(name) {
  return (process.env[name] || '').split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean);
}

export function loadConfig() {
  const env = process.env.NODE_ENV || 'development';
  const isProduction = env === 'production';
  const sessionSecret = required('SESSION_SECRET');
  if (isProduction && sessionSecret.length < 32) {
    throw new Error('SESSION_SECRET must be at least 32 characters in production');
  }
  // On Render, the service's own address is known automatically, so PUBLIC_BASE_URL
  // is only needed when the dashboard moves to a custom domain.
  const renderUrl = process.env.RENDER_EXTERNAL_HOSTNAME ? `https://${process.env.RENDER_EXTERNAL_HOSTNAME}` : '';
  const publicBaseUrl = (process.env.PUBLIC_BASE_URL || renderUrl).replace(/\/+$/, '');
  if (isProduction && !publicBaseUrl) {
    throw new Error('PUBLIC_BASE_URL is required in production (e.g. https://your-service.onrender.com)');
  }

  const pagesBaseUrl = (process.env.PAGES_BASE_URL || '').replace(/\/+$/, '');
  // The platform's own domain once bought (e.g. skyfly.ng). Business subdomains live under it.
  const platformDomain = (process.env.PLATFORM_DOMAIN || '').trim().toLowerCase().replace(/^\.+|\.+$/g, '') || null;
  if (platformDomain && !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(platformDomain)) throw new Error('PLATFORM_DOMAIN must be a domain name like skyfly.ng');
  const hostOf = (u) => (u ? new URL(u).hostname : null);
  if (pagesBaseUrl && hostOf(pagesBaseUrl) === hostOf(publicBaseUrl)) {
    // Same host would let page scripts read dashboard data. Refuse to start.
    throw new Error('PAGES_BASE_URL must use a different hostname from PUBLIC_BASE_URL');
  }

  return {
    env,
    isProduction,
    port: Number(process.env.PORT) || 3000,
    databaseUrl: required('DATABASE_URL'),
    databaseSsl: process.env.DATABASE_SSL ? process.env.DATABASE_SSL === 'true' : isProduction,
    sessionSecret,
    // "true": anyone may sign up. "first": only while no account exists (creating the owner).
    allowSignup: ['true', 'first'].includes(process.env.ALLOW_SIGNUP),
    signupFirstOnly: process.env.ALLOW_SIGNUP === 'first',
    // Owner-only deployments set up the Larose business automatically (AUTO_SETUP_LAROSE=false turns it off).
    autoSetupLarose: process.env.ALLOW_SIGNUP === 'first' && process.env.AUTO_SETUP_LAROSE !== 'false',
    // After publishing, Skyfly opens the page's public address to confirm it is live (LIVE_CHECK=off disables).
    liveCheck: process.env.LIVE_CHECK ? process.env.LIVE_CHECK === 'on' : isProduction,
    // Labelled test-mode demo site (/p/skyfly-demo/): on in production unless DEMO_SITE=off.
    demoSite: process.env.DEMO_SITE ? process.env.DEMO_SITE === 'on' : isProduction,
    // Websites allowed to submit orders from the browser, e.g. https://roseskincare9-code.github.io
    allowedOrigins: list('ALLOWED_ORIGINS'),
    publicBaseUrl,
    // Where Skyfly-hosted landing pages are served, on a different host from the dashboard.
    pagesBaseUrl,
    platformDomain,
    // Shown on Platform admin → System status (e.g. a free Render database's expiry date).
    databaseExpiresAt: process.env.DATABASE_EXPIRES_AT || null,
    // Lets the backup workflow download /admin/backup.json without anyone's password (long random value only).
    backupKey: String(process.env.SKYFLY_BACKUP_KEY || '').trim().length >= 32 ? String(process.env.SKYFLY_BACKUP_KEY).trim() : null,
    pagesHost: hostOf(pagesBaseUrl),
    dashboardHost: hostOf(publicBaseUrl),
    // Set automatically by Render; the CNAME target for custom domains.
    renderHost: process.env.RENDER_EXTERNAL_HOSTNAME || null,
    // Encrypts pixel access tokens at rest. Without it, server-side Purchase events are unavailable.
    encryptionKey: parseKey(process.env.SKYFLY_ENCRYPTION_KEY),
    // Skyfly's own Meta Pixel ("Skyfly" dataset). Used only on pages of the Skyfly-owned businesses
    // listed here (by slug) that have no Meta pixel of their own; customer businesses never get it.
    // The pixel ID is public. The Conversions API token and test code are optional secrets.
    skyflyPixel: {
      id: process.env.SKYFLY_META_PIXEL_ID ?? '1325736489534601',
      businesses: (process.env.SKYFLY_PIXEL_BUSINESSES ?? 'skyfly-demo').split(',').map((v) => v.trim()).filter(Boolean),
      accessToken: process.env.SKYFLY_META_ACCESS_TOKEN || null,
      testEventCode: process.env.SKYFLY_META_TEST_EVENT_CODE || null,
    },
    // Google Sheets API (service account): its key file's JSON in GOOGLE_SERVICE_ACCOUNT_JSON (server only).
    google: {
      ...(() => {
        // GOOGLE_SERVICE_ACCOUNT_JSON, also when typed with hyphens or other capitals
        // (e.g. "Google-service-account-json" in a Render environment group).
        const norm = (k) => k.toUpperCase().replace(/-/g, '_');
        const name = (process.env.GOOGLE_SERVICE_ACCOUNT_JSON ? 'GOOGLE_SERVICE_ACCOUNT_JSON' : null)
          ?? Object.keys(process.env).find((k) => norm(k) === 'GOOGLE_SERVICE_ACCOUNT_JSON' && process.env[k]) ?? null;
        if (name) {
          const { account, problem } = readServiceAccount(process.env[name]);
          return { serviceAccount: account, setting: name, problem };
        }
        // Or a key file uploaded as a Render "secret file" (mounted in /etc/secrets): the first service account key found.
        // A file whose name mentions Google but holds no usable key is reported, not silently skipped.
        let unusable = null;
        for (const dir of [process.env.SECRET_FILES_DIR || '/etc/secrets']) {
          let files = [];
          try { files = readdirSync(dir); } catch { continue; }
          for (const f of files.sort()) {
            let text = '';
            try { text = readFileSync(`${dir}/${f}`, 'utf8'); } catch { continue; }
            const { account, problem } = readServiceAccount(text);
            if (account) return { serviceAccount: account, setting: `secret file ${f}`, problem: null };
            if (!unusable && /google|service.?account/i.test(f)) unusable = { serviceAccount: null, setting: `secret file ${f}`, problem };
          }
        }
        return unusable ?? { serviceAccount: null, setting: null, problem: 'not set' };
      })(),
      apiBase: process.env.GOOGLE_SHEETS_API_BASE || 'https://sheets.googleapis.com',
      tokenUrl: process.env.GOOGLE_TOKEN_URL || 'https://oauth2.googleapis.com/token',
    },
    metaGraphBase: process.env.META_GRAPH_BASE || 'https://graph.facebook.com/v26.0',
    tiktokApiBase: process.env.TIKTOK_API_BASE || 'https://business-api.tiktok.com/open_api/v1.3',
    // Must match the browser event (the SDK sends CompletePayment) so TikTok deduplicates them.
    tiktokPurchaseEvent: process.env.TIKTOK_PURCHASE_EVENT || 'CompletePayment',
    orderRateLimit: Number(process.env.ORDER_RATE_LIMIT) || 20,
    // Orders per business per 10 minutes from public pages (a flood of fake orders on one page can't
    // fill the database for everyone). Far above real demand: 50,000 visitors a day at 2% is ~7 per
    // 10 minutes on average.
    orderBusinessLimit: Number(process.env.ORDER_BUSINESS_LIMIT) || 1000,
    // Database connections of this server instance, and how long a query may run.
    dbPoolMax: Number(process.env.DB_POOL_MAX) || 20,
    dbStatementTimeoutMs: Number(process.env.DB_STATEMENT_TIMEOUT_MS) || 15000,
    // How long public data many visitors ask for is kept in memory (production: 30 s; changes saved in
    // the dashboard clear it at once). 0 = off (tests and local development, unless set).
    publicCacheMs: process.env.PUBLIC_CACHE_MS !== undefined ? Number(process.env.PUBLIC_CACHE_MS) : (isProduction ? 30000 : 0),
    // Fair share of the database for each business's public traffic (see src/lib/fairness.js).
    fairness: {
      readPerBusiness: Number(process.env.FAIR_READ_PER_BUSINESS) || 4,
      readTotal: Number(process.env.FAIR_READ_TOTAL) || 10,
      readQueue: Number(process.env.FAIR_READ_QUEUE) || 200,
      readWaitMs: Number(process.env.FAIR_READ_WAIT_MS) || 5000,
      orderPerBusiness: Number(process.env.FAIR_ORDER_PER_BUSINESS) || 3,
      orderTotal: Number(process.env.FAIR_ORDER_TOTAL) || 6,
      orderQueue: Number(process.env.FAIR_ORDER_QUEUE) || 100,
      orderWaitMs: Number(process.env.FAIR_ORDER_WAIT_MS) || 15000,
    },
    // Local development only: send emails to a stand-in provider instead of the real one.
    emailApiBase: isProduction ? null : (process.env.EMAIL_API_BASE || null),
    // Skyfly's own sender for order notifications and address verification, used for businesses that
    // have not connected their own email provider (Email → Sending setup). Server-side only.
    notifyEmail: process.env.SKYFLY_NOTIFY_API_KEY && process.env.SKYFLY_NOTIFY_FROM ? {
      provider: process.env.SKYFLY_NOTIFY_PROVIDER || 'resend',
      apiKey: process.env.SKYFLY_NOTIFY_API_KEY,
      fromEmail: process.env.SKYFLY_NOTIFY_FROM,
      fromName: process.env.SKYFLY_NOTIFY_FROM_NAME || 'Skyfly',
    } : null,
  };
}
