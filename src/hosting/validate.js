// Server-side checks before a page version is published, and the shared publish step.
// Each check is PASS, WARNING (publishing is allowed; something to know or improve) or
// BLOCKED (publishing is refused: customers could not order, or orders would fail).
// Google Sheets and pixels are optional: they never block publishing.
import { parse } from 'parse5';
import { readFile } from './storage.js';
import { detectCheckout } from './adapter.js';
import { subscriptionState } from '../services/tenancy.js';

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,59}$/;
// Names the SDK reads when a field is not marked by the adapter (keep in step with src/sdk/skyfly.js).
const SDK_NAMES = { name: ['name', 'full_name', 'fullname'], phone: ['phone', 'tel', 'whatsapp'], address: ['address', 'delivery_address'] };
const attr = (node, name) => node.attrs?.find((a) => a.name === name)?.value;
function walk(node, visit) {
  if (visit(node) === false) return;
  for (const child of node.content?.childNodes ?? node.childNodes ?? []) walk(child, visit);
}

export async function pageCatalogue(pool, page) {
  const { rows } = await pool.query(
    `SELECT p.id, p.code, p.name, p.price_minor::bigint AS price_minor, p.active, p.options FROM products p
       JOIN landing_page_products lpp ON lpp.product_id = p.id WHERE lpp.landing_page_id = $1 AND p.business_id = $2 ORDER BY p.sort_order, p.id`,
    [page.id, page.business_id]);
  return rows.map((r) => ({ id: r.id, code: r.code, name: r.name, price: Number(r.price_minor) / 100, active: r.active, options: r.options ?? [] }));
}
export async function businessCatalogue(pool, businessId) {
  const { rows } = await pool.query('SELECT id, code, name, price_minor::bigint AS price_minor, options FROM products WHERE business_id = $1 AND active ORDER BY sort_order, id', [businessId]);
  return rows.map((r) => ({ id: r.id, code: r.code, name: r.name, price: Number(r.price_minor) / 100, options: r.options ?? [] }));
}

// What the connected parts of the page will send: product codes and prices, and each form's fields.
function connectedParts(html) {
  const doc = parse(html);
  const forms = [];
  const codes = [];
  let dropIn = false;
  walk(doc, (n) => {
    if (!n.tagName) return true;
    if (n.attrs.some((a) => a.name === 'data-skyfly-checkout')) dropIn = true;
    if (n.tagName === 'form' && n.attrs.some((a) => a.name === 'data-skyfly-form')) {
      const f = { key: attr(n, 'data-skyfly-form'), fields: new Set(), names: new Set(), options: [], product: attr(n, 'data-product') || null, hasSelect: false, choices: [] };
      walk(n, (c) => {
        if (!c.tagName) return true;
        if (c.tagName === 'select' && attr(c, 'data-skyfly-option')) {
          const choice = { name: attr(c, 'data-skyfly-option'), entries: [] };
          walk(c, (o) => {
            if (o.tagName !== 'option') return true;
            const label = (o.childNodes ?? []).map((t) => t.value ?? '').join('').trim();
            choice.entries.push({ label, value: attr(o, 'data-option-value') ?? null, placeholder: !attr(o, 'value') && !attr(o, 'data-option-value') || /^[-—–\s]*(select|choose|pick)\b/i.test(label) });
            return false;
          });
          f.choices.push(choice);
        }
        if (attr(c, 'data-skyfly-field')) f.fields.add(attr(c, 'data-skyfly-field'));
        if (attr(c, 'name')) f.names.add(attr(c, 'name'));
        if (c.tagName === 'select' && (attr(c, 'data-skyfly-field') === 'product' || attr(c, 'name') === 'product')) {
          f.hasSelect = true;
          walk(c, (o) => {
            if (o.tagName !== 'option') return true;
            const label = (o.childNodes ?? []).map((t) => t.value ?? '').join('').trim();
            const placeholder = !attr(o, 'value') || /^[-—–\s]*(select|choose|pick)\b/i.test(label);
            f.options.push({ label, code: attr(o, 'data-product') || null, price: attr(o, 'data-price') ?? null, placeholder });
            return false;
          });
        }
        return true;
      });
      forms.push(f);
    }
    if (attr(n, 'data-product') && n.tagName !== 'option') codes.push({ code: attr(n, 'data-product'), price: attr(n, 'data-price') ?? null, where: n.tagName === 'form' ? 'form' : 'button' });
    return true;
  });
  return { forms, codes, dropIn };
}

export async function validateVersion(pool, config, page, versionId) {
  const checks = [];
  const add = (key, label, status, message, repair = null) => checks.push({ key, label, status, message, repair });
  const { rows: [version] } = await pool.query('SELECT id, entry_path, report FROM page_versions WHERE id = $1 AND landing_page_id = $2', [versionId, page.id]);
  const entry = version ? await readFile(pool, version.id, version.entry_path) : null;
  const html = entry ? entry.data.toString('utf8') : '';

  // 1. The page renders.
  const visible = html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  if (!entry) add('render', 'Page renders', 'BLOCKED', 'This version has no main HTML file.', 'Upload the page again (a .html file, or a .zip with index.html).');
  else if (visible.length < 20 && !/<img\b/i.test(html)) add('render', 'Page renders', 'BLOCKED', 'The page is empty.', 'Upload the page again.');
  else add('render', 'Page renders', 'PASS', `${version.entry_path}, ${Math.round(entry.data.length / 1024)} KB`);
  if (version?.report?.missingCount) add('files', 'Page files', 'WARNING', `${version.report.missingCount} file(s) the page refers to are missing and will show as broken.`, 'Upload a .zip with the page and all its files.');

  // 2. The business may take orders.
  const { rows: [b] } = await pool.query(
    "SELECT slug, whatsapp_number, subscription_status, subscription_expires_on::text, (now() AT TIME ZONE timezone)::date::text AS local_today FROM businesses WHERE id = $1", [page.business_id]);
  const sub = subscriptionState(b);
  if (!sub.open) add('business', 'Business account', 'BLOCKED', `This business's account is ${sub.reason}: its pages can't take orders.`, 'Renew the subscription (platform admin).');
  else add('business', 'Business account', 'PASS', `Orders are saved under this business only (${b.slug}).`);

  // 3. The public address.
  const base = config.pagesBaseUrl ? `${config.pagesBaseUrl}/${page.slug}/` : config.publicBaseUrl ? `${config.publicBaseUrl}/p/${page.slug}/` : null;
  if (!base || !SLUG_RE.test(page.slug)) add('route', 'Public address', 'BLOCKED', 'This page has no valid public address.', 'Set a form key of letters, numbers and dashes.');
  else add('route', 'Public address', 'PASS', `${base} (stays the same when you edit and publish new versions)`);

  // 4. Products and prices.
  const catalogue = await pageCatalogue(pool, page);
  const sellable = catalogue.filter((p) => p.active && p.price > 0);
  const byCode = new Map(sellable.map((p) => [p.code, p]));
  if (!sellable.length) add('products', 'Products', 'BLOCKED', 'No products are connected to this page, so nothing can be ordered.', 'Step 2: connect the products this page sells.');
  else add('products', 'Products', 'PASS', sellable.map((p) => `${p.name} (${p.price.toLocaleString('en-NG')})`).join(', '));

  // 5. The purchase is connected to Skyfly's order API.
  const parts = connectedParts(html);
  const detected = detectCheckout(html, sellable);
  const unconnectedOrderForms = detected.forms.filter((f) => f.isOrder && !f.connected);
  if (parts.forms.length || parts.dropIn) {
    add('checkout', 'Checkout connected', 'PASS', [parts.dropIn ? 'Skyfly checkout' : null, parts.forms.length ? `${parts.forms.length} order form(s) saving to Skyfly` : null].filter(Boolean).join(' + '));
  } else if (detected.customApi) {
    add('checkout', 'Checkout connected', 'WARNING', "The page's own code sends orders to Skyfly's order API. Skyfly can't check that code's fields: place one test order after publishing.");
  } else {
    add('checkout', 'Checkout connected', 'BLOCKED', unconnectedOrderForms.length
      ? `The page has an order form, but it is not connected to Skyfly${unconnectedOrderForms[0].sendsTo ? ` (it sends orders to ${unconnectedOrderForms[0].sendsTo})` : ''}. Orders would not be saved.`
      : 'The page has no order form connected to Skyfly. Orders would not be saved.', 'Step 3: "Connect checkout automatically".');
  }
  if (unconnectedOrderForms.length && (parts.forms.length || parts.dropIn)) {
    add('forms', 'Other forms', 'WARNING', `${unconnectedOrderForms.length} other order form(s) are not connected and would not save orders.`, 'Step 3: "Connect checkout automatically".');
  }

  // 6. Every product the page can send exists on the page, at Skyfly's price.
  const problems = [];
  for (const f of parts.forms) {
    if (f.hasSelect) {
      for (const o of f.options.filter((x) => !x.placeholder)) {
        if (!o.code) problems.push(`"${o.label}" is not matched to a product`);
        else if (!byCode.has(o.code)) problems.push(`"${o.label}" is matched to "${o.code}", which is not a product on this page`);
        else if (o.price !== null && Number(o.price) !== byCode.get(o.code).price) problems.push(`"${o.label}" shows ${o.price} but Skyfly's price is ${byCode.get(o.code).price}`);
      }
    } else if (!f.product) {
      problems.push('an order form does not say which product it orders');
    }
  }
  // Product options (size, colour…): every choice on the page must be one of the product's own,
  // and every choice a product needs must be on the page.
  const same = (a, b) => String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
  for (const f of parts.forms) {
    const codes = f.hasSelect ? f.options.filter((o) => o.code).map((o) => o.code) : [f.product].filter(Boolean);
    for (const p of codes.map((c) => byCode.get(c)).filter(Boolean)) {
      for (const g of (p.options ?? []).filter((x) => x.values.length > 1)) {
        if (!f.choices.some((ch) => same(ch.name, g.name))) problems.push(`the page has no ${g.name} choice for ${p.name}`);
      }
      for (const ch of f.choices) {
        const g = (p.options ?? []).find((x) => same(x.name, ch.name));
        if (!g) { problems.push(`"${ch.name}" is not an option of ${p.name} (add it under Products)`); continue; }
        for (const e of ch.entries.filter((x) => !x.placeholder)) {
          if (!e.value || !g.values.some((v) => same(v.label, e.value))) problems.push(`"${e.label}" is not one of ${p.name}'s ${g.name} values`);
        }
      }
    }
  }
  for (const c of parts.codes) {
    if (!byCode.has(c.code)) problems.push(`a ${c.where} orders "${c.code}", which is not a product on this page`);
    else if (c.price !== null && Number(c.price) !== byCode.get(c.code).price) problems.push(`a ${c.where} shows ${c.price} for ${c.code}, Skyfly's price is ${byCode.get(c.code).price}`);
  }
  if (problems.length) add('mapping', 'Product mapping', 'BLOCKED', `Orders would be refused: ${problems.slice(0, 4).join('; ')}.`, 'Step 3: match each product, then connect again (prices come from Skyfly).');
  else if (parts.forms.length || parts.codes.length) add('mapping', 'Product mapping', 'PASS', 'Every product on the page is a Skyfly product at its Skyfly price.');

  // 7. Required checkout fields.
  const missing = [];
  for (const f of parts.forms) {
    for (const [k, names] of Object.entries(SDK_NAMES)) if (!f.fields.has(k) && !names.some((n) => f.names.has(n))) missing.push(k);
  }
  if (missing.length) add('fields', 'Checkout fields', 'BLOCKED', `The order form has no ${[...new Set(missing)].join(', ')} field.`, 'Step 3: match the form fields (name, phone, delivery address), or use the Skyfly checkout.');
  else if (parts.forms.length || parts.dropIn) add('fields', 'Checkout fields', 'PASS', 'Name, phone and delivery address are collected; Skyfly checks them again when saving.');

  // 8. Purchase buttons that still leave the page.
  const leaving = detected.buttons.filter((x) => x.goesTo !== 'the order section');
  if (leaving.length) add('buttons', 'Purchase buttons', 'WARNING', `${leaving.length} purchase button(s) still go to ${[...new Set(leaving.map((x) => x.goesTo))].join(' / ')} instead of the order form: those chats are not orders.`, 'Step 3: "Connect checkout automatically" points them to the order form.');
  else if (detected.buttons.length || parts.codes.some((c) => c.where === 'button')) add('buttons', 'Purchase buttons', 'PASS', 'Purchase buttons open the Skyfly order form.');

  // 9. Thank-you page.
  const number = b.whatsapp_number || (b.slug === 'larose-nigeria' ? '+2349049206695' : null);
  add('thanks', 'Thank-you page', 'PASS', `Shown only after Skyfly saves the order, with the order reference and summary${number ? ` and a WhatsApp button (${number})` : ''}.`);
  if (!number) add('whatsapp', 'WhatsApp support button', 'WARNING', 'No WhatsApp number is set, so the thank-you page has no WhatsApp button (optional).', 'Settings → WhatsApp number.');

  // 10. Optional integrations (never block publishing).
  const { rows: px } = await pool.query(
    `SELECT platform FROM tracking_pixels tp WHERE tp.business_id = $1 AND tp.enabled
        AND (tp.all_pages OR EXISTS (SELECT 1 FROM tracking_pixel_pages pp WHERE pp.tracking_pixel_id = tp.id AND pp.landing_page_id = $2))`, [page.business_id, page.id]);
  const names = { meta: 'Meta', tiktok: 'TikTok', x: 'X' };
  add('pixels', 'Pixels (optional)', 'PASS', px.length ? `${px.length} tracking ID(s) on this page (${[...new Set(px.map((p) => names[p.platform]))].join(', ')}); Purchase fires only after a saved order.` : 'None assigned to this page (optional; Tracking & Pixels).');
  const { rows: [sheet] } = await pool.query(
    'SELECT sc.name FROM landing_pages lp JOIN businesses b ON b.id = lp.business_id JOIN sheet_connections sc ON sc.id = coalesce(lp.sheet_connection_id, b.default_sheet_connection_id) AND sc.business_id = lp.business_id WHERE lp.id = $1', [page.id]);
  add('sheets', 'Google Sheets (optional)', 'PASS', sheet ? `Orders are copied to "${sheet.name}" after they are saved, following this business's settings.` : 'Not set up (optional): orders are kept in Skyfly.');

  return { checks, blocked: checks.some((c) => c.status === 'BLOCKED'), versionId: version?.id ?? null };
}

// Publishes a version (same address; the page's business never changes).
export async function publishVersion(pool, page, versionId) {
  await pool.query(
    `UPDATE landing_pages SET status = 'active', updated_at = now(), live_status = NULL, live_checked_at = NULL,
            order_connected_at = CASE WHEN published_version_id IS DISTINCT FROM $1 THEN NULL ELSE order_connected_at END,
            order_connected_reference = CASE WHEN published_version_id IS DISTINCT FROM $1 THEN NULL ELSE order_connected_reference END,
            published_version_id = $1
      WHERE id = $2 AND business_id = $3`,
    [versionId, page.id, page.business_id],
  );
}

// Opens the page's public address like a visitor would and records the result.
// The dashboard only calls an address "live" after this check passed.
export async function checkLive(pool, config, page, { fetchImpl = globalThis.fetch } = {}) {
  const url = config.pagesBaseUrl ? `${config.pagesBaseUrl}/${page.slug}/` : `${config.publicBaseUrl}/p/${page.slug}/`;
  let status;
  try {
    const res = await fetchImpl(url, { redirect: 'follow', signal: AbortSignal.timeout(20000), headers: { 'User-Agent': 'Skyfly live check' } });
    const body = await res.text();
    status = res.status === 200 && /\/sdk\/skyfly\.js/.test(body) ? `ok: HTTP 200, page and Skyfly checkout script served` : `failed: HTTP ${res.status}`;
  } catch (err) {
    status = `failed: ${String(err.cause?.code || err.name || err.message).slice(0, 80)}`;
  }
  await pool.query('UPDATE landing_pages SET live_status = $1, live_checked_at = now() WHERE id = $2', [status, page.id]);
  return status;
}
