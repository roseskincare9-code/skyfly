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

export function loadConfig() {
  const sessionSecret = required('SESSION_SECRET');
  if (isProduction && sessionSecret.length < 32) {
    throw new Error('SESSION_SECRET must be at least 32 characters in production');
  }

  return {
    env,
    isProduction,
    port: Number(process.env.PORT) || 3000,
    databaseUrl: required('DATABASE_URL'),
    sessionSecret,
    allowSignup: process.env.ALLOW_SIGNUP === 'true',
  };
}
