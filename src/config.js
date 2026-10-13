// Reads and validates Skyfly's environment. Fails fast with a clear message
// so a misconfigured deploy never starts half-working.

const env = process.env.NODE_ENV || 'development';
const isProduction = env === 'production';

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
  const sessionSecret = required('SESSION_SECRET');
  if (isProduction && sessionSecret.length < 32) {
    throw new Error('SESSION_SECRET must be at least 32 characters in production');
  }
  const publicBaseUrl = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  if (isProduction && !publicBaseUrl) {
    throw new Error('PUBLIC_BASE_URL is required in production (e.g. https://skyfly.onrender.com)');
  }

  return {
    env,
    isProduction,
    port: Number(process.env.PORT) || 3000,
    databaseUrl: required('DATABASE_URL'),
    databaseSsl: process.env.DATABASE_SSL ? process.env.DATABASE_SSL === 'true' : isProduction,
    sessionSecret,
    allowSignup: process.env.ALLOW_SIGNUP === 'true',
    // Websites allowed to submit orders from the browser, e.g. https://roseskincare9-code.github.io
    allowedOrigins: list('ALLOWED_ORIGINS'),
    publicBaseUrl,
    orderRateLimit: Number(process.env.ORDER_RATE_LIMIT) || 20,
  };
}
