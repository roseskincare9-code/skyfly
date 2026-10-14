import { createHmac, timingSafeEqual } from 'node:crypto';

// Signed, expiring links let the owner preview an unpublished version on the
// pages host (where the dashboard session cookie is never sent).
const TTL_MS = 60 * 60 * 1000;

function sign(secret, versionId, expires) {
  return createHmac('sha256', secret).update(`preview:${versionId}:${expires}`).digest('base64url').slice(0, 32);
}

export function previewToken(secret, versionId, now = Date.now()) {
  const expires = Math.floor((now + TTL_MS) / 1000);
  return `${expires}.${sign(secret, versionId, expires)}`;
}

export function verifyPreviewToken(secret, versionId, token, now = Date.now()) {
  const [expiresText, sig] = String(token).split('.');
  const expires = Number(expiresText);
  if (!Number.isInteger(expires) || !sig || expires * 1000 < now) return false;
  const expected = Buffer.from(sign(secret, versionId, expires));
  const given = Buffer.from(sig);
  return given.length === expected.length && timingSafeEqual(given, expected);
}
