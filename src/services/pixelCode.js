// Reads a Meta or TikTok base code pasted by the owner and returns its Pixel ID.
// The pasted code is NEVER stored or run: Skyfly only takes the ID out of it and
// loads the official script itself, so a page can never get the pixel twice.
// Anything that is not the platform's own base code is rejected.

const MAX_LENGTH = 20000;

const RULES = {
  meta: {
    name: 'Meta Pixel',
    required: [/fbevents\.js/, /fbq\s*\(/],
    hosts: ['connect.facebook.net', 'www.facebook.com', 'facebook.com'],
    ids: [/fbq\s*\(\s*['"]init['"]\s*,\s*['"](\d{10,20})['"]/g, /facebook\.com\/tr\?id=(\d{10,20})/g],
    missing: 'Paste the whole "Meta Pixel Code" from Meta Events Manager (it starts with <!-- Meta Pixel Code --> and contains fbq(\'init\', \'…\')).',
  },
  tiktok: {
    name: 'TikTok Pixel',
    required: [/analytics\.tiktok\.com/, /ttq\.load\s*\(/],
    hosts: ['analytics.tiktok.com'],
    ids: [/ttq\.load\s*\(\s*['"]([A-Za-z0-9]{10,40})['"]/g],
    missing: 'Paste the whole TikTok Pixel base code from TikTok Events Manager (it contains ttq.load(\'…\')).',
  },
};

// Things the official base codes never contain.
const FORBIDDEN = [
  [/\beval\s*\(/i, 'eval()'],
  [/\bnew\s+Function\b|\bFunction\s*\(/, 'Function()'],
  [/document\s*\.\s*(write|cookie|domain)\b/i, 'document.write/cookie'],
  [/\b(localStorage|sessionStorage|indexedDB)\b/, 'browser storage access'],
  [/\b(fetch|XMLHttpRequest|sendBeacon|WebSocket|importScripts)\b/, 'network calls'],
  [/\bimport\s*\(/, 'import()'],
  [/\b(atob|btoa|unescape|fromCharCode)\b/, 'encoded code'],
  [/\\x[0-9a-f]{2}|\\u[0-9a-f]{4}/i, 'encoded code'],
  [/<\s*(iframe|object|embed|form|input|link|meta|style|base)\b/i, 'HTML other than the pixel code'],
  [/<\s*script[^>]*\bsrc\s*=/i, 'an external <script src>'],
  [/javascript\s*:/i, 'javascript: links'],
  [/\son[a-z]+\s*=/i, 'HTML event handlers'],
  [/\b(window|top|parent|self)\s*\.\s*location\b|\blocation\s*\.\s*(href|replace|assign)\b/, 'page redirects'],
];

export function parsePixelCode(provider, code) {
  const rule = RULES[provider];
  if (!rule) return { error: 'Unknown platform.' };
  const text = String(code ?? '').trim();
  if (!text) return { error: `Paste your ${rule.name} code first.` };
  if (text.length > MAX_LENGTH) return { error: 'That is much longer than a pixel base code. Paste only the base code.' };

  const other = provider === 'meta' ? RULES.tiktok : RULES.meta;
  if (other.required.every((re) => re.test(text)) && !rule.required.every((re) => re.test(text))) {
    return { error: `This looks like ${other.name} code. Paste it in the ${other.name} box instead.` };
  }
  if (!rule.required.every((re) => re.test(text))) return { error: rule.missing };

  for (const [re, what] of FORBIDDEN) {
    if (re.test(text)) return { error: `This code contains ${what}, which the official ${rule.name} code never has. For your safety it was not saved.` };
  }
  for (const m of text.matchAll(/(?:https?:)?\/\/([a-z0-9.-]+)/gi)) {
    const host = m[1].toLowerCase();
    if (!rule.hosts.includes(host)) return { error: `This code loads something from ${host}, which is not part of the official ${rule.name} code. It was not saved.` };
  }

  const ids = new Set();
  for (const re of rule.ids) for (const m of text.matchAll(re)) ids.add(provider === 'tiktok' ? m[1].toUpperCase() : m[1]);
  if (ids.size === 0) return { error: `No Pixel ID was found in this code. ${rule.missing}` };
  if (ids.size > 1) return { error: `This code contains ${ids.size} different pixels (${[...ids].join(', ')}). Add one pixel per platform.` };
  return { pixelId: [...ids][0] };
}
