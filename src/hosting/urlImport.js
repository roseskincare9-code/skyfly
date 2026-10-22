// Import a landing page from its public address (https only). Only the HTML document is
// fetched; the page's images, styles, scripts and fonts stay at their original addresses
// (relative links are made absolute), so the imported page looks the same once hosted.
// The fetch refuses private, local and reserved network addresses (checked on every
// connection, including redirects), so it cannot be used to reach Skyfly's own network.
import https from 'node:https';
import dns from 'node:dns';
import net from 'node:net';
import { ImportError } from './importer.js';

export const URL_LIMITS = { bytes: 5 * 1024 * 1024, timeoutMs: 15000, redirects: 3 };

// Separate lists: a BlockList also applies IPv4-mapped IPv6 rules (::ffff:0:0/96) to plain IPv4.
const blocked4 = new net.BlockList();
for (const [addr, bits] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]]) {
  blocked4.addSubnet(addr, bits, 'ipv4');
}
const blocked6 = new net.BlockList();
for (const [addr, bits] of [['::', 128], ['::1', 128], ['64:ff9b::', 96], ['100::', 64], ['2001:db8::', 32], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]]) {
  blocked6.addSubnet(addr, bits, 'ipv6');
}
export function isPublicAddress(ip) {
  const kind = net.isIP(ip);
  if (kind === 4) return !blocked4.check(ip, 'ipv4');
  if (kind !== 6) return false;
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i); // an IPv4 address written as IPv6
  if (mapped) return !blocked4.check(mapped[1], 'ipv4');
  if (/^::ffff:/i.test(ip)) return false;
  return !blocked6.check(ip, 'ipv6');
}

// The address to import, or an ImportError saying why it can't be used.
export function checkPageUrl(input) {
  let u;
  try { u = new URL(String(input ?? '').trim()); } catch { throw new ImportError('Enter the page\'s full address, starting with https://'); }
  if (u.protocol !== 'https:') throw new ImportError('Only https:// addresses can be imported.');
  if (u.username || u.password) throw new ImportError('The address must not contain a user name or password.');
  if (u.port && u.port !== '443') throw new ImportError('Only standard https addresses (no port number) can be imported.');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host) ? !isPublicAddress(host) : !/\./.test(host) || /\.(local|internal|localhost)$/i.test(host)) {
    throw new ImportError('That address is not a public website.');
  }
  u.hash = '';
  return u;
}

// DNS lookup that only ever connects to public addresses (so a name can't point at a private one).
export function safeLookup(hostname, options, callback) {
  dns.lookup(hostname, { all: true }, (err, addresses) => {
    if (err) return callback(err);
    const bad = addresses.find((a) => !isPublicAddress(a.address));
    if (bad || !addresses.length) return callback(Object.assign(new Error('not a public address'), { code: 'SKYFLY_PRIVATE' }));
    if (options?.all) return callback(null, addresses);
    return callback(null, addresses[0].address, addresses[0].family);
  });
}

function getOnce(u) {
  return new Promise((resolve, reject) => {
    const req = https.get(u, { lookup: safeLookup, timeout: URL_LIMITS.timeoutMs, headers: { 'User-Agent': 'Skyfly page import', Accept: 'text/html' } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) { res.resume(); return resolve({ redirect: res.headers.location }); }
      if (res.statusCode !== 200) { res.resume(); return reject(new ImportError(`The page answered HTTP ${res.statusCode}.`)); }
      if (!/text\/html|application\/xhtml/i.test(String(res.headers['content-type'] ?? ''))) { res.resume(); return reject(new ImportError('That address is not an HTML page.')); }
      const chunks = []; let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > URL_LIMITS.bytes) { req.destroy(); reject(new ImportError(`The page is larger than ${URL_LIMITS.bytes / 1024 / 1024} MB.`)); } else chunks.push(c);
      });
      res.on('end', () => resolve({ body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new ImportError('The page took too long to answer.')));
    req.on('error', (err) => reject(err instanceof ImportError ? err
      : new ImportError(err.code === 'SKYFLY_PRIVATE' ? 'That address is not a public website.' : 'The page could not be reached. Check the address and try again.')));
  });
}

export async function fetchPage(input, { get = getOnce } = {}) {
  let u = checkPageUrl(input);
  for (let i = 0; i <= URL_LIMITS.redirects; i += 1) {
    const r = await get(u);
    if (!r.redirect) return { html: r.body, finalUrl: u.href };
    u = checkPageUrl(new URL(r.redirect, u).href);
  }
  throw new ImportError('The page redirects too many times.');
}

// Relative asset addresses (src, srcset, poster, <link href>, CSS url()) become absolute, so they
// still load from the original site. In-page links (#order), mailto:, tel: and data: are left alone.
export function absolutizeAssets(html, baseUrl) {
  const abs = (v) => {
    const t = v.trim();
    if (!t || /^(#|data:|blob:|mailto:|tel:|javascript:|about:)/i.test(t)) return v;
    if (t.startsWith('//')) return `https:${t}`;
    try { return new URL(t, baseUrl).href; } catch { return v; }
  };
  return html
    .replace(/(\s(?:src|poster|data-src)\s*=\s*)(["'])(.*?)\2/gi, (m, a, q, v) => `${a}${q}${abs(v)}${q}`)
    .replace(/(\s(?:srcset|data-srcset)\s*=\s*)(["'])(.*?)\2/gi, (m, a, q, v) => `${a}${q}${v.split(',').map((part) => {
      const [url, ...rest] = part.trim().split(/\s+/);
      return [abs(url), ...rest].join(' ');
    }).join(', ')}${q}`)
    .replace(/<link\b[^>]*>/gi, (tag) => tag.replace(/(\shref\s*=\s*)(["'])(.*?)\2/i, (m, a, q, v) => `${a}${q}${abs(v)}${q}`))
    .replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/gi, (m, q, v) => `url(${q}${abs(v)}${q})`);
}

// An upload-shaped file for importUpload, so URL imports get exactly the same checks.
export async function fileFromUrl(input, opts) {
  const { html, finalUrl } = await fetchPage(input, opts);
  const text = absolutizeAssets(html.toString('utf8'), finalUrl);
  return { file: { buffer: Buffer.from(text, 'utf8'), originalname: 'index.html' }, finalUrl };
}
