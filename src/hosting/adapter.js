// Universal checkout adapter for imported pages (any HTML: AI-generated, hand-made, exported).
// detectCheckout() reads the page and finds its order forms (and which input is the name,
// phone, address…), its purchase buttons (incl. WhatsApp "order" links and external
// checkouts), and the products and prices it shows, matched to the business's catalogue.
// connectCheckout() then connects them to Skyfly's own order API by adding data-skyfly-*
// attributes at exact source positions: the design, text and scripts stay as they were.
// The Skyfly SDK (added to every hosted page) does the rest: it saves the order with Skyfly
// before any thank-you, and stops the page's own code from sending the order elsewhere.
import { parse } from 'parse5';

const attr = (node, name) => node.attrs?.find((a) => a.name === name)?.value;
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const norm = (s) => String(s ?? '').toLowerCase().replace(/&amp;/g, '&').replace(/[^a-z0-9₦$£€]+/g, ' ').trim();

function walk(node, visit, ancestors = []) {
  if (visit(node, ancestors) === false) return;
  const kids = node.content?.childNodes ?? node.childNodes ?? [];
  for (const child of kids) walk(child, visit, [...ancestors, node]);
}
function textOf(node) {
  let out = '';
  walk(node, (n) => {
    if (['script', 'style', 'noscript', 'template'].includes(n.nodeName)) return false;
    if (n.nodeName === '#text') out += ` ${n.value}`;
    return true;
  });
  return out.replace(/\s+/g, ' ').trim();
}

// Prices as written on pages: ₦23,500 · NGN 23500 · N23,500 · $49.99 · £20 · 23,500 naira
const PRICE = /(?:₦|NGN\s?|\bN(?=\d)|\$|£|€|GH₵|KSh\s?)\s?(\d{1,3}(?:[,\s]\d{3})+|\d+)(?:\.(\d{1,2}))?|(\d{1,3}(?:,\d{3})+|\d{3,})\s?(?:naira|NGN)\b/i;
export function priceIn(text) {
  const m = String(text ?? '').match(PRICE);
  if (!m) return null;
  const whole = (m[1] ?? m[3]).replace(/[,\s]/g, '');
  const value = Number(`${whole}${m[2] ? `.${m[2]}` : ''}`);
  return Number.isFinite(value) && value > 0 ? value : null;
}

// Standard checkout fields, recognised from an input's name, id, type, placeholder, label or aria-label.
const FIELD_RULES = [
  ['email', (c) => c.type === 'email' || /e-?mail/.test(c.hint)],
  ['phone', (c) => c.type === 'tel' || /phone|tel\b|mobile|whatsapp|gsm|contact number|number/.test(c.hint)],
  ['quantity', (c) => /\bqty\b|quantity|how many/.test(c.hint) || (c.type === 'number' && !/price|amount/.test(c.hint))],
  // A product's own choice (size, colour…), not the product itself.
  ['option', (c) => c.tag === 'select' && OPTION_WORDS.test(c.hint) && !/package|bundle|product|plan|kit|offer/.test(c.hint)],
  ['product', (c) => c.tag === 'select' && (c.optionPrices > 0 || /package|product|bundle|plan|item|offer|kit|set/.test(c.hint))],
  ['state', (c) => /\bstate\b|city|region|\blga\b|province|county|town/.test(c.hint)],
  ['address', (c) => /address|street|delivery|location|house|shipping/.test(c.hint)],
  ['notes', (c) => c.tag === 'textarea' || /note|message|comment|instruction|request/.test(c.hint)],
  ['name', (c) => /name|customer|buyer/.test(c.hint) && !/user ?name|company|business|brand/.test(c.hint)],
];
export const FIELD_LABELS = { option: 'Product option (size, colour…)', name: 'Full name', phone: 'Phone number', address: 'Delivery address', state: 'State / city', email: 'Email', notes: 'Notes', quantity: 'Quantity', product: 'Product / package', ignore: 'Not used by Skyfly' };
export const REQUIRED_FIELDS = ['name', 'phone', 'address'];

const OPTION_WORDS = /\b(size|sizes|variant|colou?r|shade|scent|flavou?r|volume|style|length|weight|type|option)\b/;
const ORDER_WORDS = /\b(order|buy|shop now|purchase|check ?out|add to (cart|bag)|get (it|yours|mine|now|started)|claim|reserve|pre-?order|i want (it|this|one)|place)\b/i;
const SUPPORT_WORDS = /\b(chat|question|ask|support|help|contact|enquir|inquir|talk to|speak)\b/i;
// Links about an order already placed (on a thank-you message), not purchase buttons.
const AFTER_ORDER_WORDS = /\b(view|track|details|another|receipt|status)\b/i;
const EXTERNAL_CHECKOUT = /selar\.(co|com)|paystack\.(com|shop)|flutterwave\.com\/pay|buy\.stripe\.com|checkout\.stripe\.com|paypal\.(com|me)|gumroad\.com|shopify\.com|jumia\.com|konga\.com|bumpa|flutterwave\.com\/store/i;
const WHATSAPP = /wa\.me\/|api\.whatsapp\.com\/send|whatsapp:\/\//i;


function prefillOf(href) {
  try { return decodeURIComponent((href.match(/[?&]text=([^&]*)/) || [])[1] || '').replace(/\+/g, ' '); } catch { return ''; }
}
// A link or button that starts a purchase: an "Order/Buy…" button, a WhatsApp "order" link or
// an external checkout link. "Chat with us"-style WhatsApp links are support, and stay as they are.
function purchaseKind(node) {
  if (node.attrs.some((a) => a.name === 'data-skyfly-buy')) return null;
  const text = textOf(node);
  const href = attr(node, 'href') || '';
  const onclick = attr(node, 'onclick') || '';
  const wa = WHATSAPP.test(href) || WHATSAPP.test(onclick);
  const external = EXTERNAL_CHECKOUT.test(href) || EXTERNAL_CHECKOUT.test(onclick);
  const orderish = ORDER_WORDS.test(text) || ORDER_WORDS.test(prefillOf(href)) || ORDER_WORDS.test(attr(node, 'aria-label') || '');
  const support = SUPPORT_WORDS.test(text) && !ORDER_WORDS.test(text);
  if (support || AFTER_ORDER_WORDS.test(text)) return null;
  if (external) return 'an external checkout';
  if (orderish && wa) return 'WhatsApp';
  // In-page buttons that already lead to the page's own order section (href="#order") keep working as they are.
  if (/^#[A-Za-z]/.test(href)) return null;
  if (orderish && (node.tagName === 'button' || /^#?$|^javascript:/i.test(href) || /order|checkout|buy/i.test(href))) return 'the order section';
  return null;
}
// Purchase links/buttons outside forms, in document order (with their ancestors).
function purchaseNodes(doc) {
  const out = [];
  walk(doc, (node, ancestors) => {
    if (node.nodeName === 'script' || node.tagName === 'form') return false;
    if ((node.tagName === 'a' || node.tagName === 'button') && purchaseKind(node)) out.push({ node, ancestors, kind: purchaseKind(node) });
    return true;
  });
  return out;
}

function similarity(a, b) {
  const A = new Set(norm(a).split(' ').filter((w) => w.length > 1 && !/^\d+$/.test(w)));
  const B = new Set(norm(b).split(' ').filter((w) => w.length > 1 && !/^\d+$/.test(w)));
  if (!A.size || !B.size) return 0;
  let common = 0;
  for (const w of A) if (B.has(w)) common += 1;
  return common / Math.min(A.size, B.size);
}

// Best catalogue product for a label and/or price. "high" = connect without asking.
export function matchProduct(label, price, catalogue) {
  let best = null;
  for (const p of catalogue) {
    const sim = similarity(label, p.name);
    const priceOk = price !== null && price !== undefined && Math.abs(Number(p.price) - Number(price)) < 0.005;
    const score = sim + (priceOk ? 0.6 : 0);
    if (!best || score > best.score) best = { product: p, score, sim, priceOk };
  }
  if (!best) return null;
  const samePrice = catalogue.filter((p) => price !== null && price !== undefined && Math.abs(Number(p.price) - Number(price)) < 0.005);
  if ((best.sim >= 0.5 && best.priceOk) || (best.sim >= 0.75 && price == null)) return { code: best.product.code, confidence: 'high', reason: best.priceOk ? 'name and price match' : 'name matches' };
  if (best.sim >= 0.5 && !best.priceOk) return { code: best.product.code, confidence: 'check', reason: `name matches, but the page shows ${price} and Skyfly has ${best.product.price}` };
  if (samePrice.length === 1) return { code: samePrice[0].code, confidence: 'check', reason: 'same price' };
  return null;
}

// The nearest heading-like text for an element (a product card's title).
function contextLabel(ancestors, node) {
  for (let i = ancestors.length - 1; i >= Math.max(0, ancestors.length - 5); i -= 1) {
    let label = null;
    walk(ancestors[i], (n) => {
      if (label) return false;
      if (/^h[1-4]$/.test(n.nodeName) || ['strong', 'b'].includes(n.nodeName)) {
        const t = textOf(n);
        if (t && t.length <= 90 && !priceIn(t)) label = t;
      }
      return n !== node;
    });
    if (label) return { label, block: ancestors[i] };
  }
  return { label: null, block: ancestors.at(-1) };
}

export function detectCheckout(html, catalogue = []) {
  const doc = parse(html, { sourceCodeLocationInfo: true });
  const labels = new Map();
  walk(doc, (n) => { if (n.tagName === 'label' && attr(n, 'for')) labels.set(attr(n, 'for'), textOf(n)); return true; });
  const forms = [];
  const buttons = [];
  const prices = [];
  let dropIn = false;
  let customApi = false;

  walk(doc, (node, ancestors) => {
    if (node.nodeName === 'script') {
      const t = (node.childNodes ?? []).map((c) => c.value).join('');
      if (/\/api\/public\/orders/.test(t) || /\/api\/public\/orders/.test(attr(node, 'src') ?? '')) customApi = true;
      return false;
    }
    if (!node.tagName) return true;
    if (node.attrs?.some((a) => a.name === 'data-skyfly-checkout')) dropIn = true;
    if (node.tagName === 'form') {
      const controls = [];
      walk(node, (c, anc) => {
        if (!['input', 'select', 'textarea', 'button'].includes(c.tagName)) return true;
        const type = (attr(c, 'type') || (c.tagName === 'button' ? 'submit' : c.tagName === 'input' ? 'text' : c.tagName)).toLowerCase();
        if (['hidden', 'image', 'reset', 'file', 'checkbox', 'radio', 'range', 'color', 'search', 'password'].includes(type) && c.tagName === 'input') return true;
        const parentLabel = anc.slice().reverse().find((a) => a.tagName === 'label');
        const hint = norm([attr(c, 'name'), attr(c, 'id'), attr(c, 'placeholder'), attr(c, 'aria-label'), labels.get(attr(c, 'id')), parentLabel ? textOf(parentLabel) : ''].filter(Boolean).join(' '));
        const options = c.tagName === 'select' ? (c.childNodes ?? []).flatMap((o) => (o.tagName === 'optgroup' ? o.childNodes : [o])).filter((o) => o.tagName === 'option') : [];
        const ctl = { node: c, tag: c.tagName, type, hint, name: attr(c, 'name') || attr(c, 'id') || '', existing: attr(c, 'data-skyfly-field') || null, options, optionPrices: options.filter((o) => priceIn(textOf(o)) || attr(o, 'data-price')).length };
        if (c.tagName === 'button' || (c.tagName === 'input' && type === 'submit')) {
          if (type === 'submit' || type === 'button') controls.push({ ...ctl, submit: true, label: textOf(c) || attr(c, 'value') || '' });
          return true;
        }
        ctl.field = ctl.existing || FIELD_RULES.find(([, test]) => test(ctl))?.[0] || 'ignore';
        controls.push(ctl);
        return true;
      });
      const inputs = controls.filter((c) => !c.submit);
      const fields = new Set(inputs.map((c) => c.field));
      // An order form asks for a phone number and a name or address (not a newsletter or search box).
      const isOrder = fields.has('phone') && (fields.has('name') || fields.has('address'));
      const action = attr(node, 'action') || '';
      forms.push({
        id: forms.length, node, isOrder, connected: node.attrs.some((a) => a.name === 'data-skyfly-form'),
        action, sendsTo: WHATSAPP.test(action) ? 'WhatsApp' : /^https?:/i.test(action) ? new URL(action).host : (attr(node, 'onsubmit') ? 'its own script' : null),
        inputs, submits: controls.filter((c) => c.submit), productLabel: contextLabel(ancestors, node).label,
      });
      return false; // controls inside the form are handled above
    }
    return true;
  });

  for (const { node, ancestors, kind } of purchaseNodes(doc)) {
    const ctx = contextLabel(ancestors, node);
    buttons.push({ id: buttons.length, node, text: textOf(node).slice(0, 80), goesTo: kind, productLabel: ctx.label, price: priceIn(textOf(ctx.block)) ?? priceIn(prefillOf(attr(node, 'href') || '')) });
  }

  // Prices shown in the page's text (product cards), each with its nearest heading.
  walk(doc, (n, anc) => {
    if (['script', 'style', 'noscript', 'select', 'form'].includes(n.nodeName)) return false;
    if (n.nodeName === '#text' && priceIn(n.value)) {
      const { label } = contextLabel(anc, n);
      if (label && !prices.some((p) => p.label === label)) prices.push({ id: prices.length, label, price: priceIn(n.value) });
    }
    return true;
  });

  // Products the page offers: options of order forms' product lists, priced cards, buy buttons.
  const candidates = [];
  const add = (source, ref, label, price) => {
    if (!label) return;
    const match = matchProduct(label, price, catalogue);
    candidates.push({ key: `${source}:${ref}`, source, label: label.slice(0, 100), price, match });
  };
  for (const f of forms.filter((x) => x.isOrder)) {
    const select = f.inputs.find((c) => c.field === 'product');
    if (select) {
      select.options.forEach((o, i) => {
        const label = textOf(o);
        if (!attr(o, 'value') && !/\d/.test(label)) return; // "— choose —" placeholder
        if (/^[-—–\s]*(select|choose|pick)\b/i.test(label)) return;
        const dp = attr(o, 'data-price');
        add('option', `${f.id}.${i}`, label.replace(PRICE, '').replace(/[·•|–—-]\s*$/, '').trim() || label, dp ? Number(dp) : priceIn(label));
      });
    } else {
      add('form', f.id, f.productLabel || prices[0]?.label, prices.length === 1 ? prices[0].price : null);
    }
  }
  for (const b of buttons) add('button', b.id, b.productLabel, b.price);

  return {
    forms: forms.map(({ node, inputs, submits, ...f }) => ({
      ...f,
      fields: inputs.map((c, i) => ({ index: i, name: c.name, hint: c.hint.slice(0, 60), field: c.field, confident: c.field !== 'ignore' || Boolean(c.existing) })),
      submitLabels: submits.map((s) => s.label),
      jsButton: submits.some((s) => s.type === 'button'),
      missing: f.isOrder ? REQUIRED_FIELDS.filter((r) => !inputs.some((c) => c.field === r)) : [],
    })),
    buttons: buttons.map(({ node, ...b }) => b),
    prices,
    candidates,
    dropIn,
    customApi,
    whatsappOrderButtons: buttons.filter((b) => b.goesTo === 'WhatsApp').length,
    externalCheckoutButtons: buttons.filter((b) => b.goesTo === 'an external checkout').length,
  };
}

// Applies the connection. mapping: { products: { "<candidate key>": "<product code>" | "" },
// fields: { "<form id>.<input index>": "<field>" } } (missing entries use the detected values).
export function connectCheckout(html, { slug, catalogue, mapping = {} }) {
  const doc = parse(html, { sourceCodeLocationInfo: true });
  const detected = detectCheckout(html, catalogue);
  const byCode = new Map(catalogue.map((p) => [p.code, p]));
  const productFor = (key) => {
    const chosen = mapping.products?.[key];
    if (chosen !== undefined) return chosen ? byCode.get(chosen) ?? null : null;
    const c = detected.candidates.find((x) => x.key === key);
    return c?.match?.confidence === 'high' ? byCode.get(c.match.code) ?? null : null;
  };
  const edits = [];
  const changes = [];
  const used = new Set();
  // Adds attributes to a start tag; replaces ones that already exist; renames handlers away.
  function setAttrs(node, set = {}, rename = []) {
    const loc = node.sourceCodeLocation;
    let add = '';
    for (const [name, value] of Object.entries(set)) {
      const existing = loc.attrs?.[name];
      const text = value === true ? name : `${name}="${esc(value)}"`;
      if (existing) edits.push({ start: existing.startOffset, end: existing.endOffset, text });
      else add += ` ${text}`;
    }
    for (const name of rename) {
      const existing = loc.attrs?.[name];
      if (existing && !(set[name] !== undefined)) {
        edits.push({ start: existing.startOffset, end: existing.endOffset, text: `data-skyfly-original-${name}="${esc(attr(node, name))}"` });
      }
    }
    if (add) {
      const at = loc.startTag.startOffset + 1 + node.tagName.length;
      edits.push({ start: at, end: at, text: add });
    }
  }

  let target = null;
  const forms = [];
  walk(doc, (node) => { if (node.nodeName === 'script') return false; if (node.tagName === 'form') forms.push(node); return true; });
  const buttonNodes = purchaseNodes(doc).map((x) => x.node);

  for (const f of detected.forms) {
    if (!f.isOrder || f.connected) continue;
    const node = forms[f.id];
    const inputs = [];
    walk(node, (c) => {
      if (!['input', 'select', 'textarea', 'button'].includes(c.tagName)) return true;
      const type = (attr(c, 'type') || (c.tagName === 'button' ? 'submit' : c.tagName === 'input' ? 'text' : c.tagName)).toLowerCase();
      if (c.tagName === 'button' || (c.tagName === 'input' && type === 'submit')) {
        if (type === 'submit' || type === 'button') setAttrs(c, { 'data-skyfly-submit': true, ...(type === 'button' ? { type: 'submit' } : {}) }, ['onclick']);
        return true;
      }
      if (['hidden', 'image', 'reset', 'file', 'checkbox', 'radio', 'range', 'color', 'search', 'password'].includes(type) && c.tagName === 'input') return true;
      inputs.push(c);
      return true;
    });
    const id = attr(node, 'id') || (used.has('skyfly-order') ? `skyfly-order-${f.id}` : 'skyfly-order');
    used.add(id);
    target = target ?? id;
    let formProduct = null;
    const fieldOf = (fd, i) => mapping.fields?.[`${f.id}.${i}`] ?? fd.field;
    const optionsOf = (sel) => (sel?.childNodes ?? []).flatMap((o) => (o.tagName === 'optgroup' ? o.childNodes : [o])).filter((o) => o.tagName === 'option');
    // The products this form can order: its product list's matches, or the one product it is for.
    const productIndex = f.fields.findIndex((fd, i) => fieldOf(fd, i) === 'product');
    const formProducts = [];
    if (productIndex >= 0) optionsOf(inputs[productIndex]).forEach((o, oi) => { const p = productFor(`option:${f.id}.${oi}`); if (p) formProducts.push(p); });
    else { formProduct = productFor(`form:${f.id}`); if (formProduct) formProducts.push(formProduct); }
    f.fields.forEach((fd, i) => {
      const field = fieldOf(fd, i);
      const c = inputs[i];
      if (!c || field === 'ignore') return;
      const set = { 'data-skyfly-field': field };
      if (field === 'phone' && attr(c, 'required') === undefined) set.required = true;
      if (field === 'option') {
        // Which of the product's options this list chooses (e.g. "Size"), and each entry's value.
        const groups = formProducts.flatMap((p) => p.options ?? []);
        const group = groups.find((g) => fd.hint.includes(norm(g.name))) ?? groups.find((g) => g.values.length > 1) ?? null;
        const word = fd.hint.match(OPTION_WORDS)?.[1] ?? 'option';
        set['data-skyfly-option'] = group?.name ?? word.charAt(0).toUpperCase() + word.slice(1);
        optionsOf(c).forEach((o) => {
          const text = textOf(o);
          const v = group?.values.find((x) => norm(text) === norm(x.label) || norm(text).startsWith(`${norm(x.label)} `));
          if (v) setAttrs(o, { 'data-option-value': v.label });
        });
        changes.push(`"${fd.name || fd.hint}" → ${set['data-skyfly-option']} option${group ? '' : ' (not set up on the product yet)'}`);
      }
      setAttrs(c, set);
      if (field === 'product') {
        optionsOf(c).forEach((o, oi) => {
          const p = productFor(`option:${f.id}.${oi}`);
          if (p) { setAttrs(o, { 'data-product': p.code, 'data-price': String(p.price) }); changes.push(`"${textOf(o).slice(0, 50)}" → ${p.name}`); }
        });
      }
    });
    setAttrs(node, {
      'data-skyfly-form': slug, 'data-skyfly-exclusive': true, ...(attr(node, 'id') ? {} : { id }),
      ...(formProduct ? { 'data-product': formProduct.code, 'data-price': String(formProduct.price) } : {}),
      ...(attr(node, 'action') ? { action: '#' } : {}),
    }, ['onsubmit', 'target', 'method']);
    if (attr(node, 'action')) setAttrs(node, { 'data-skyfly-original-action': attr(node, 'action') });
    changes.push(`Order form ${f.id + 1}${f.sendsTo ? ` (sent to ${f.sendsTo})` : ''} now saves orders in Skyfly${formProduct ? ` for ${formProduct.name}` : ''}`);
  }

  // Purchase buttons go to a form that is already connected, if there is one.
  if (!target) {
    const done = forms.find((n) => n.attrs.some((a) => a.name === 'data-skyfly-form'));
    if (done) target = attr(done, 'id') || null;
  }
  const alreadyConnected = detected.forms.some((f) => f.connected);
  // Without a connectable form, Skyfly's ready-made checkout is added at the end of the page.
  const needsDropIn = !target && !alreadyConnected && !detected.dropIn && !detected.customApi;
  if (!target) target = 'skyfly-order';
  for (const b of detected.buttons) {
    // A page whose own code already sends orders to Skyfly keeps its in-page buttons as they are.
    if (detected.customApi && b.goesTo === 'the order section') continue;
    const node = buttonNodes[b.id];
    if (!node) continue;
    const p = productFor(`button:${b.id}`);
    setAttrs(node, { 'data-skyfly-buy': true, ...(node.tagName === 'a' ? { href: `#${target}` } : {}), ...(p ? { 'data-product': p.code } : {}) }, ['onclick', 'target']);
    if (node.tagName === 'a' && attr(node, 'href')) setAttrs(node, { 'data-skyfly-original-href': attr(node, 'href') });
    changes.push(`"${b.text || 'Button'}" (went to ${b.goesTo}) now opens the Skyfly order form${p ? ` with ${p.name} selected` : ''}`);
  }
  if (needsDropIn) {
    const section = `\n<section id="skyfly-order" style="padding:32px 16px"><div data-skyfly-checkout="${esc(slug)}"></div></section>\n`;
    const end = html.match(/<\/body\s*>/i);
    edits.push({ start: end ? end.index : html.length, end: end ? end.index : html.length, text: section });
    changes.push('Skyfly checkout added at the end of the page (the page had no order form to connect)');
  }

  // Apply from the end so earlier offsets stay valid; merge insertions at the same point in order.
  edits.sort((a, b) => b.start - a.start || b.end - a.end);
  let out = html;
  for (const e of edits) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return { html: out, changes, detected };
}
