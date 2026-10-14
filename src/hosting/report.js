// Inspects an uploaded page and explains, in plain words, what will and won't
// work once hosted: missing files, external form/checkout providers, existing
// pixels, and whether the order form is connected to Skyfly. Never edits files.
import path from 'node:path';
import { isHtml, extensionOf } from './files.js';

const PROVIDERS = [
  { re: /sheetdb\.io/i, name: 'SheetDB (Google Sheets)', kind: 'form',
    advice: 'Orders go to your Google Sheet, not to Skyfly. Connect the form to Skyfly (see the guide); you can keep SheetDB as a backup copy.' },
  { re: /formspree\.io/i, name: 'Formspree', kind: 'form', advice: 'Submissions go to Formspree. Connect the form to Skyfly to see orders in the dashboard.' },
  { re: /formsubmit\.co/i, name: 'FormSubmit', kind: 'form', advice: 'Submissions are emailed by FormSubmit. Connect the form to Skyfly to store orders.' },
  { re: /getform\.io/i, name: 'Getform', kind: 'form', advice: 'Submissions go to Getform. Connect the form to Skyfly to store orders.' },
  { re: /docs\.google\.com\/forms/i, name: 'Google Forms', kind: 'form', advice: 'Responses go to Google Forms. Connect the form to Skyfly to store orders.' },
  { re: /script\.google(usercontent)?\.com/i, name: 'Google Apps Script', kind: 'form', advice: 'Submissions go to a Google Apps Script. Connect the form to Skyfly, or have the script forward orders with a Skyfly API key.' },
  { re: /hooks\.zapier\.com/i, name: 'Zapier webhook', kind: 'form', advice: 'Submissions go to Zapier. Add a Zapier step that sends orders to Skyfly with an API key, or connect the form directly.' },
  { re: /hook\.[a-z0-9]+\.make\.com/i, name: 'Make.com webhook', kind: 'form', advice: 'Submissions go to Make.com. Add a step that sends orders to Skyfly with an API key, or connect the form directly.' },
  { re: /list-manage\.com/i, name: 'Mailchimp', kind: 'form', advice: 'This form adds people to a Mailchimp list. It does not create orders.' },
  { re: /typeform\.com|jotform\.com|tally\.so/i, name: 'Embedded form service (Typeform/Jotform/Tally)', kind: 'form', advice: 'The embedded form submits to that service. Use its webhook with a Skyfly API key to store orders.' },
  { re: /data-netlify|netlify-honeypot/i, name: 'Netlify Forms', kind: 'form', advice: 'Netlify Forms only work on Netlify hosting and will NOT work on Skyfly. Connect the form to Skyfly.' },
  { re: /js\.paystack\.co|paystack\.com/i, name: 'Paystack', kind: 'checkout', advice: 'Paystack checkout keeps working in the browser. Skyfly does not yet receive Paystack payments automatically: mark orders Paid after checking Paystack.' },
  { re: /checkout\.flutterwave\.com|flutterwave\.com\/pay/i, name: 'Flutterwave', kind: 'checkout', advice: 'Flutterwave checkout keeps working. Mark orders Paid in Skyfly after confirming payment in Flutterwave.' },
  { re: /js\.stripe\.com|checkout\.stripe\.com|buy\.stripe\.com/i, name: 'Stripe', kind: 'checkout', advice: 'Stripe checkout keeps working. Mark orders Paid in Skyfly after confirming payment in Stripe.' },
  { re: /selar\.(co|com)|paypal\.com\/(sdk|cgi-bin)|paypal\.me/i, name: 'External checkout (Selar/PayPal)', kind: 'checkout', advice: 'Customers pay on the external checkout. Mark orders Paid in Skyfly after confirming payment there.' },
  { re: /wa\.me\/|api\.whatsapp\.com\/send/i, name: 'WhatsApp links', kind: 'contact', advice: 'WhatsApp buttons keep working, but chats are not orders. Only form submissions saved by Skyfly appear in the dashboard.' },
];

const REF_ATTR = /\b(?:src|href|poster|data-src)\s*=\s*["']([^"']+)["']/gi;
const SRCSET = /\bsrcset\s*=\s*["']([^"']+)["']/gi;
const CSS_URL = /url\(\s*["']?([^"')]+)["']?\s*\)/gi;
const CSS_IMPORT = /@import\s+["']([^"']+)["']/gi;

function isExternal(ref) {
  return /^(?:[a-z][a-z0-9+.-]*:|\/\/|#|\{\{|\$\{)/i.test(ref.trim());
}

function referencesIn(file) {
  const text = file.data.toString('utf8');
  const refs = new Set();
  const add = (r) => { if (r && !isExternal(r)) refs.add(r.trim()); };
  if (isHtml(file.path)) {
    for (const m of text.matchAll(REF_ATTR)) add(m[1]);
    for (const m of text.matchAll(SRCSET)) m[1].split(',').forEach((part) => add(part.trim().split(/\s+/)[0]));
    for (const m of text.matchAll(/<style[^>]*>([\s\S]*?)<\/style>|style\s*=\s*"([^"]*)"/gi)) {
      for (const u of (m[1] ?? m[2] ?? '').matchAll(CSS_URL)) add(u[1]);
    }
  } else if (extensionOf(file.path) === 'css') {
    for (const m of text.matchAll(CSS_URL)) add(m[1]);
    for (const m of text.matchAll(CSS_IMPORT)) add(m[1]);
  }
  return [...refs];
}

function pixelsIn(text) {
  const found = [];
  for (const m of text.matchAll(/fbq\(\s*['"]init['"]\s*,\s*['"](\d{6,20})['"]/g)) found.push({ provider: 'meta', id: m[1] });
  if (!found.some((p) => p.provider === 'meta') && /connect\.facebook\.net\/[^"']*fbevents\.js/.test(text)) found.push({ provider: 'meta', id: null });
  for (const m of text.matchAll(/ttq\.load\(\s*['"]([A-Z0-9]{10,40})['"]/g)) found.push({ provider: 'tiktok', id: m[1] });
  for (const m of text.matchAll(/googletagmanager\.com\/gtag\/js\?id=([A-Z0-9-]+)/g)) found.push({ provider: 'google', id: m[1] });
  return found;
}

export function analyzeFiles(files, entryPath, { standalone = false } = {}) {
  const paths = new Set(files.map((f) => f.path));
  const missing = new Set();
  const rootAbsolute = new Set();
  const providers = new Map();
  const pixels = [];
  let connected = false;
  let hasForm = false;

  for (const file of files) {
    if (!isHtml(file.path) && !['css', 'js', 'mjs'].includes(extensionOf(file.path))) continue;
    const text = file.data.toString('utf8');
    for (const ref of referencesIn(file)) {
      const clean = ref.split(/[?#]/)[0];
      if (!clean) continue;
      let decoded;
      try { decoded = decodeURI(clean); } catch { decoded = clean; }
      if (decoded.startsWith('/')) {
        rootAbsolute.add(ref);
        if (!paths.has(decoded.slice(1))) missing.add(decoded.slice(1));
        continue;
      }
      let resolved = path.posix.normalize(path.posix.join(path.posix.dirname(file.path), decoded));
      if (resolved.endsWith('/')) resolved += 'index.html';
      if (resolved.startsWith('..')) { missing.add(ref); continue; }
      if (!paths.has(resolved) && !paths.has(`${resolved}/index.html`)) missing.add(resolved);
    }
    for (const p of PROVIDERS) if (p.re.test(text)) providers.set(p.name, p);
    if (isHtml(file.path)) {
      pixels.push(...pixelsIn(text).map((px) => ({ ...px, file: file.path })));
      if (/<form[\s>]/i.test(text) || /<(input|select|textarea)[\s>]/i.test(text)) hasForm = true;
      if (/data-skyfly-form|\/sdk\/skyfly\.js|\/api\/public\/orders/.test(text)) connected = true;
    }
  }

  const warnings = [];
  if (missing.size) {
    warnings.push(standalone
      ? `This HTML file refers to ${missing.size} local file(s) that were not uploaded. Upload a ZIP with the page and its files, or they will show as broken.`
      : `${missing.size} file(s) referred to by the page are not in the ZIP and will show as broken.`);
  }
  if (rootAbsolute.size) {
    warnings.push('Some paths start with "/" (e.g. /css/style.css). They only work when the page is served on its own custom domain. Use relative paths (css/style.css) to make them work everywhere.');
  }
  if (hasForm && !connected) {
    warnings.push('The page has a form, but it is not connected to Skyfly. Orders will NOT appear in Skyfly until the form is connected (see "Connect your order form").');
  }

  return {
    entryPath,
    missing: [...missing].slice(0, 50),
    missingCount: missing.size,
    rootAbsolute: [...rootAbsolute].slice(0, 20),
    providers: [...providers.values()].map(({ name, kind, advice }) => ({ name, kind, advice })),
    pixels,
    hasForm,
    connected,
    warnings,
  };
}
