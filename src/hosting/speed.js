// Speed changes applied to hosted HTML as it is served (the stored files are not changed):
// - the first image is fetched with high priority; the others load lazily as they scroll in;
// - images get their aspect ratio reserved (no layout shift) and WebP sizes via srcset when
//   optimized copies exist (the original stays as the fallback src);
// - the page's own CSS, JS and images get "?v=<version>" so browsers can cache them for a
//   year: a new published version has a new number, so changes still show at once.
import path from 'node:path';
import { resolveAsset } from './images.js';

const attr = (tag, name) => {
  const m = tag.match(new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
  return m ? (m[1] ?? m[2] ?? m[3]) : null;
};
const hasAttr = (tag, name) => new RegExp(`\\s${name}(\\s*=|\\s|/?>)`, 'i').test(tag);
const addAttrs = (tag, extra) => tag.replace(/\s*(\/?)>$/, (m, slash) => `${extra}${slash ? ' /' : ''}>`);
const isLocal = (url) => url && !/^([a-z][a-z0-9+.-]*:|\/\/|#|\/|\{)/i.test(url) && !url.includes('?');

export function versioned(url, versionId) {
  if (!isLocal(url)) return url;
  const [p, hash] = url.split('#');
  return `${p}?v=${versionId}${hash !== undefined ? `#${hash}` : ''}`;
}

export function optimizeHtml(html, { meta = null, filePath = 'index.html', versionId }) {
  const dir = path.posix.dirname(filePath);
  let index = 0;
  let out = html.replace(/<img\b[^>]*>/gi, (tag) => {
    const first = index === 0;
    index += 1;
    const src = attr(tag, 'src');
    let extra = '';
    // Images embedded in the page (data: URIs) are already downloaded with it: lazy loading saves
    // nothing and leaves images in hidden or unscrolled parts blank, so they load as written.
    const embedded = /^\s*data:/i.test(src || '');
    if (!embedded && !hasAttr(tag, 'loading') && !hasAttr(tag, 'fetchpriority')) extra += first ? ' fetchpriority="high"' : ' loading="lazy"';
    if (!first && !hasAttr(tag, 'decoding')) extra += ' decoding="async"';
    const info = meta && meta[resolveAsset(filePath, src)];
    if (info) {
      if (!hasAttr(tag, 'width') && !hasAttr(tag, 'height') && !/aspect-ratio/i.test(attr(tag, 'style') || '')) {
        const style = attr(tag, 'style');
        const ratio = `aspect-ratio:${info.w}/${info.h}`;
        if (style !== null) tag = tag.replace(/(\sstyle\s*=\s*)(["'])([^"']*)\2/i, (m, a, q, v) => `${a}${q}${v.replace(/;?\s*$/, ';')}${ratio}${q}`);
        else extra += ` style="${ratio}"`;
      }
      if (info.variants?.length && !hasAttr(tag, 'srcset')) {
        const set = info.variants.map((v) => `${versioned(path.posix.relative(dir, v.path) || v.path, versionId)} ${v.w}w`).join(', ');
        extra += ` srcset="${set}"${hasAttr(tag, 'sizes') ? '' : ' sizes="100vw"'}`;
      }
    }
    if (src && isLocal(src)) tag = tag.replace(/(\ssrc\s*=\s*)(["']?)([^"'\s>]+)\2/i, (m, a, q, v) => `${a}${q}${versioned(v, versionId)}${q}`);
    return extra ? addAttrs(tag, extra) : tag;
  });
  // The page's own stylesheets and scripts: long-cacheable, versioned URLs.
  out = out.replace(/<(link|script)\b[^>]*>/gi, (tag) => {
    if (/^<link/i.test(tag) && !/rel\s*=\s*["']?(stylesheet|preload|icon|modulepreload)/i.test(tag)) return tag;
    return tag.replace(/(\s(?:href|src)\s*=\s*)(["']?)([^"'\s>]+)\2/i, (m, a, q, v) => `${a}${q}${versioned(v, versionId)}${q}`);
  });
  return out;
}

// url(...) references inside a versioned CSS file get the same version.
export function optimizeCss(css, versionId) {
  return css.replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/gi, (m, q, url) => `url(${q}${versioned(url.trim(), versionId)}${q})`);
}
