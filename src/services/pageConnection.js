// "Test connection" for a landing page hosted elsewhere: can it actually submit orders to Skyfly?
// The page is fetched once (public https only, the same safeguards as importing from an address)
// and checked for what an order needs. Only a real saved order marks the connection verified.
import { fetchPage } from '../hosting/urlImport.js';
import { allKnownOrigins } from '../lib/origins.js';

export async function testPageConnection(pool, config, page) {
  const problems = [];
  if (!page.url) problems.push('Save the page\'s public address first.');
  if (page.status !== 'active') problems.push('Set the page\'s status to active: only active pages take orders.');
  const { rows: [{ n }] } = await pool.query('SELECT count(*)::int AS n FROM landing_page_products WHERE landing_page_id = $1', [page.id]);
  if (page.order_destination !== 'whatsapp' && n === 0) problems.push('Connect at least one product to the page.');
  let found = false;
  if (page.url) {
    const origin = new URL(page.url).origin;
    if (!(await allKnownOrigins(pool, config)).has(origin)) problems.push(`${origin} is not allowed to send orders yet (save the page again).`);
    try {
      const { html } = await fetchPage(page.url, { get: config.urlImportGet });
      const text = html.toString('utf8');
      const host = config.publicBaseUrl ? new URL(config.publicBaseUrl).host : null;
      const callsSkyfly = host ? text.includes(host) : false;
      const key = new RegExp(`["'\\s=]${page.slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["'\\s>]`);
      const usesKey = key.test(text);
      found = callsSkyfly && usesKey;
      if (page.order_destination !== 'whatsapp') {
        if (!callsSkyfly) problems.push(`The page does not load Skyfly (${host}): add the Skyfly checkout code to it.`);
        else if (!usesKey) problems.push(`The page does not send this page's form key "${page.slug}" with its orders.`);
      }
    } catch (err) {
      problems.push(`The page could not be checked: ${err.message}`);
    }
  }
  const result = problems.length ? problems.join(' ') : 'ok';
  await pool.query('UPDATE landing_pages SET connection_check = $2, connection_checked_at = now() WHERE id = $1', [page.id, result]);
  return { ok: !problems.length, found, problems };
}
