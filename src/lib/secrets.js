// AES-256-GCM encryption for third-party access tokens stored in the database.
// The key lives only in the SKYFLY_ENCRYPTION_KEY environment variable.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export function parseKey(text) {
  if (!text) return null;
  const key = Buffer.from(text, 'base64');
  if (key.length !== 32) throw new Error('SKYFLY_ENCRYPTION_KEY must be 32 bytes, base64-encoded');
  return key;
}

export function encrypt(key, plaintext) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), data.toString('base64url')].join('.');
}

export function decrypt(key, stored) {
  const [version, iv, tag, data] = String(stored).split('.');
  if (version !== 'v1') throw new Error('Unknown secret format');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
}
