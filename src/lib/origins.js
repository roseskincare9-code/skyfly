// Which websites may submit browser orders for a landing page: the page's own
// URL, its Skyfly-hosted address and custom domain, plus any global extras.
export function originOf(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.origin : null;
  } catch {
    return null;
  }
}

export function originsForPage(page, config) {
  const origins = new Set(config.allowedOrigins);
  const own = page.url && originOf(page.url);
  if (own) origins.add(own);
  if (page.hosted && config.pagesBaseUrl) origins.add(originOf(config.pagesBaseUrl));
  if (page.custom_domain) origins.add(`https://${page.custom_domain}`);
  // Hosted pages are also served on the business's subdomain (when the platform domain is set).
  if (page.hosted && page.business_subdomain && config.platformDomain) origins.add(`https://${page.business_subdomain}.${config.platformDomain}`);
  return origins;
}

// Union of every registered page's origins, used to answer CORS preflights
// (which carry no body, so the landing page is not yet known). Cached briefly.
let cache = { at: 0, origins: new Set() };
export async function allKnownOrigins(pool, config) {
  if (Date.now() - cache.at < 30_000) return cache.origins;
  const { rows } = await pool.query(
    `SELECT lp.url, lp.custom_domain, (lp.published_version_id IS NOT NULL) AS hosted, b.subdomain AS business_subdomain
       FROM landing_pages lp JOIN businesses b ON b.id = lp.business_id WHERE lp.status <> 'archived'`,
  );
  const origins = new Set(config.allowedOrigins);
  for (const row of rows) for (const o of originsForPage(row, config)) origins.add(o);
  cache = { at: Date.now(), origins };
  return origins;
}

export function clearOriginCache() {
  cache = { at: 0, origins: new Set() };
}
