// File rules for uploaded landing pages: which files are allowed, how paths
// are normalised, and what content type each is served with.
import path from 'node:path';

export const LIMITS = {
  uploadBytes: 25 * 1024 * 1024,
  fileBytes: 15 * 1024 * 1024,
  totalBytes: 60 * 1024 * 1024,
  files: 1000,
};

export const CONTENT_TYPES = {
  html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8', js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8',
  json: 'application/json', map: 'application/json', webmanifest: 'application/manifest+json',
  txt: 'text/plain; charset=utf-8', md: 'text/plain; charset=utf-8', xml: 'application/xml',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  avif: 'image/avif', svg: 'image/svg+xml', ico: 'image/x-icon', bmp: 'image/bmp',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf', eot: 'application/vnd.ms-fontobject',
  mp4: 'video/mp4', webm: 'video/webm', ogg: 'audio/ogg', mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4',
  pdf: 'application/pdf',
};

// Junk added by operating systems or editors; skipped silently.
const IGNORED = [/^__MACOSX\//, /(^|\/)\.DS_Store$/, /(^|\/)Thumbs\.db$/, /(^|\/)desktop\.ini$/i];

export function extensionOf(p) {
  return path.posix.extname(p).slice(1).toLowerCase();
}

export function isIgnored(p) {
  return IGNORED.some((re) => re.test(p));
}

// Returns a safe relative path, or null if the name is unsafe.
export function normalizePath(raw) {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 300) return null;
  if (/[\u0000-\u001f\u007f\\]/.test(raw)) return null;
  if (raw.startsWith('/') || /^[a-zA-Z]:/.test(raw)) return null;
  const parts = raw.normalize('NFC').split('/');
  for (const part of parts) {
    if (part === '' || part === '.' || part === '..') return null;
    if (part.startsWith('.') && part !== '.well-known') return null; // hidden files such as .htaccess, .git
  }
  const p = parts.join('/');
  if (p.startsWith('_skyfly/')) return null; // reserved for Skyfly's own files
  return p;
}

export function contentTypeFor(p) {
  return CONTENT_TYPES[extensionOf(p)] ?? null;
}

export function isHtml(p) {
  return ['html', 'htm'].includes(extensionOf(p));
}
