import { createHash, randomBytes } from 'node:crypto';

export function newApiKey() {
  const key = `sky_${randomBytes(24).toString('base64url')}`;
  return { key, prefix: key.slice(0, 10), hash: hashApiKey(key) };
}

export function hashApiKey(key) {
  return createHash('sha256').update(key).digest('hex');
}
