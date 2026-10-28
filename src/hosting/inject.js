// Adds the Skyfly SDK and this page's pixel settings to published hosted pages.
// Only validated pixel IDs and event names are written; nothing the owner types
// is inserted as code. Previews are left untouched (no tracking, no test data).
import { browserConfig } from '../services/pixels.js';

function safeJson(value) {
  // Prevents "</script>" or HTML comments inside the JSON from ending the script tag.
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

export async function injectSkyfly(pool, config, html, { page, preview, filePath, load = null }) {
  if (preview || !config.publicBaseUrl) return html;
  const tracking = load ? await load.caches.tracking.get(page.id, () => browserConfig(pool, page, config)) : await browserConfig(pool, page, config);
  const snippet = `<script data-skyfly-config>window.__SKYFLY__=${safeJson({ ...tracking, api: config.publicBaseUrl, file: filePath })};</script>`
    + `<script src="${config.publicBaseUrl}/sdk/skyfly.js" defer></script>`;
  const head = html.match(/<\/head\s*>/i);
  if (head) return html.slice(0, head.index) + snippet + html.slice(head.index);
  const body = html.match(/<body[^>]*>/i);
  if (body) return html.slice(0, body.index + body[0].length) + snippet + html.slice(body.index + body[0].length);
  return snippet + html;
}
