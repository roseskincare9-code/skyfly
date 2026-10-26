// Client onboarding checklist for the platform owner: each step is read from what is actually set up
// and verified for that business (never from a field merely being filled in), with where to do it.
import { subscriptionState } from './tenancy.js';

export async function setupChecklist(pool, b) {
  const one = async (sql) => (await pool.query(sql, [b.id])).rows[0];
  const pixel = await one(`SELECT
      (SELECT count(*)::int FROM pixel_settings WHERE business_id = $1 AND enabled AND pixel_id IS NOT NULL) +
      (SELECT count(*)::int FROM additional_pixels WHERE business_id = $1 AND enabled) AS n,
      (SELECT count(*)::int FROM pixel_settings WHERE business_id = $1 AND server_verified_at IS NOT NULL) +
      (SELECT count(*)::int FROM additional_pixels WHERE business_id = $1 AND server_verified_at IS NOT NULL) AS verified`);
  const sheet = await one(`SELECT sc.name, sc.check_status, sc.check_detail FROM businesses bb
      JOIN sheet_connections sc ON sc.id = bb.default_sheet_connection_id AND sc.business_id = bb.id WHERE bb.id = $1`);
  const page = await one(`SELECT count(*) FILTER (WHERE status = 'active' AND published_version_id IS NOT NULL)::int AS published,
      count(*) FILTER (WHERE live_status LIKE 'ok%')::int AS live FROM landing_pages WHERE business_id = $1`);
  const products = await one('SELECT count(*)::int AS n FROM products WHERE business_id = $1 AND active');
  const test = await one(`SELECT reference, sheet_sync_status FROM orders WHERE business_id = $1 AND is_test ORDER BY id DESC LIMIT 1`);
  const sub = subscriptionState(b);
  const base = `/businesses/${b.id}`;
  return [
    { key: 'details', label: 'Business and contact details', done: Boolean(b.name && b.contact_name && (b.contact_phone || b.contact_email)),
      detail: b.contact_name ? [b.contact_name, b.contact_phone, b.contact_email].filter(Boolean).join(' · ') : 'Add the client contact below.', href: null },
    { key: 'notify', label: 'Order notification email', done: Boolean(b.notify_email && b.notify_enabled && b.notify_verified_at),
      detail: !b.notify_email ? 'Not set' : b.notify_verified_at ? `${b.notify_email} (verified)` : `${b.notify_email} (not verified yet)`, href: `${base}/settings` },
    { key: 'products', label: 'Products and prices', done: products.n > 0, detail: `${products.n} active`, href: `${base}/products` },
    { key: 'pixel', label: 'Meta Pixel', done: pixel.n > 0,
      detail: pixel.n ? `${pixel.n} pixel(s) on the pages${pixel.verified ? `, ${pixel.verified} accepted a server test event` : '; check them in Meta Events Manager → Test events'}` : 'Not set', href: `${base}/pixels` },
    { key: 'sheet', label: 'Google Sheet for orders', done: sheet?.check_status === 'ok',
      detail: sheet ? `${sheet.name}: ${sheet.check_status === 'ok' ? 'connected and checked' : (sheet.check_detail || sheet.check_status || 'not checked yet')}` : 'Not connected (optional)', href: `${base}/google-sheets` },
    { key: 'page', label: 'Landing page imported and published', done: page.live > 0,
      detail: page.live ? `${page.live} page(s) live` : page.published ? 'Published, live check not passed yet' : 'No published page yet', href: `${base}/landing-pages` },
    { key: 'test', label: 'Test order placed (name starting "TEST ORDER")', done: Boolean(test),
      detail: test ? `${test.reference} saved (test orders never count as sales or go to the Sheet)` : 'Place one through the published page', href: `${base}/orders` },
    { key: 'subscription', label: 'Subscription active', done: sub.open,
      detail: sub.open ? `${b.subscription_status}${b.subscription_expires_on ? `, until ${String(b.subscription_expires_on instanceof Date ? b.subscription_expires_on.toISOString().slice(0, 10) : b.subscription_expires_on)}` : ''}` : 'Expired or locked', href: null },
  ];
}
