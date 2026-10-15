// Reads and validates Skyfly's environment. Fails fast with a clear message
// so a misconfigured deploy never starts half-working.
import { parseKey } from './lib/secrets.js';

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
    // Websites allowed to submit orders from the browser, e.g. https://roseskincare9-code.github.io
    allowedOrigins: list('ALLOWED_ORIGINS'),
    publicBaseUrl,
    // Where Skyfly-hosted landing pages are served, on a different host from the dashboard.
    pagesBaseUrl,
    pagesHost: hostOf(pagesBaseUrl),
    dashboardHost: hostOf(publicBaseUrl),
    // Set automatically by Render; the CNAME target for custom domains.
    renderHost: process.env.RENDER_EXTERNAL_HOSTNAME || null,
    // Encrypts pixel access tokens at rest. Without it, server-side Purchase events are unavailable.
    encryptionKey: parseKey(process.env.SKYFLY_ENCRYPTION_KEY),
    metaGraphBase: process.env.META_GRAPH_BASE || 'https://graph.facebook.com/v26.0',
    tiktokApiBase: process.env.TIKTOK_API_BASE || 'https://business-api.tiktok.com/open_api/v1.3',
    tiktokPurchaseEvent: process.env.TIKTOK_PURCHASE_EVENT || 'Purchase',
    orderRateLimit: Number(process.env.ORDER_RATE_LIMIT) || 20,
  };
}
