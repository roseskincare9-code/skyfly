#!/usr/bin/env python3
"""Prepares the existing landing pages for import into Skyfly.

    python3 landing-pages/prepare.py            # builds packages/ and dist/

For every page in sources/<slug>/original.html (an untouched copy of the live
page, see source.json) this writes:

  packages/<slug>/index.html            the page, design unchanged
  packages/<slug>/assets/images/...     images that were embedded as base64
  packages/<slug>/skyfly-manifest.json  name, assets, integrations, editable fields
  packages/<slug>/IMPORT.md             how to import and connect it
  dist/<slug>.zip                       what you upload in Skyfly (index.html + assets)

Each step that changes a page fails loudly if the page no longer looks as
expected, so a changed source is never patched blindly.
"""
import base64
import hashlib
import html
import json
import re
import shutil
import sys
import zipfile
from html.parser import HTMLParser
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SOURCES, PACKAGES, DIST = ROOT / 'sources', ROOT / 'packages', ROOT / 'dist'

# The verified Skyfly service (Render API + health checks). Never a guessed address.
SKYFLY_API = 'https://skyfly-gybf.onrender.com'
SHEET_URL = 'https://sheetdb.io/api/v1/m111fq96ve953'
OWNER_WHATSAPP = '09049206695'

PAGES = {
    'larose-nigeria': {
        'name': 'Larose Nigeria – Glow Packages (₦)',
        'kind': 'product-orders',
        'formKey': 'larosenigeria',
        'currency': 'NGN',
        'skyflyBusiness': 'Larose Natural Skincare Nigeria',
        'products': [
            ('package-1', 'Package 1 – Starter Glow Soap (1kg Soap)', 23500),
            ('package-2', 'Package 2 – Starter Glow Combo', 33000),
            ('package-3', 'Package 3 – Power Glow', 51500),
            ('package-4', 'Package 4 – Total Revive Full', 93500),
            ('package-5', 'Package 5 – Total Transformation VIP Luxury (5kg Soap)', 202000),
        ],
    },
    'larose-uk': {
        'name': 'Larose UK – Glow Packages (£)',
        'kind': 'product-orders',
        'formKey': 'larose-uk',
        'currency': 'GBP',
        'skyflyBusiness': 'Larose UK (new business, currency GBP)',
        'products': [
            ('uk-package-1', 'Package 1 – The Starter Glow (1kg Soap + Free Glow Oil)', 75),
            ('uk-package-2', 'Package 2 – The Power Glow (2kg Soap + Free Glow Oil)', 120),
            ('uk-package-3', 'Package 3 – Total Transformation (2kg Soap + Oil + Body Milk + Facial Set)', 220),
        ],
    },
    'scaleforge-nigeria': {'name': 'ScaleForge Nigeria – Done-For-You Sales System', 'kind': 'service-enquiry'},
    'scaleforge-london': {'name': 'ScaleForge London – Elite Digital Sales Systems', 'kind': 'service-enquiry'},
    'ai-skincare-academy': {'name': 'AI Skincare Business Academy', 'kind': 'course-booking'},
}


def replace_once(text, old, new, what):
    n = text.count(old)
    if n != 1:
        sys.exit(f'[{what}] expected exactly one match, found {n}: {old[:90]!r}')
    return text.replace(old, new)


# ---------------------------------------------------------------- images
DATA_URI = re.compile(r'data:image/(png|jpe?g|gif|webp|svg\+xml);base64,([A-Za-z0-9+/=]+)')
EXT = {'png': 'png', 'jpeg': 'jpg', 'jpg': 'jpg', 'gif': 'gif', 'webp': 'webp', 'svg+xml': 'svg'}


def extract_images(text, out_dir):
    """Moves base64 images into assets/images/ (same bytes, same order). Identical images share one file."""
    images, by_hash = [], {}

    def repl(m):
        data = base64.b64decode(m.group(2))
        digest = hashlib.sha256(data).hexdigest()
        if digest not in by_hash:
            name = f'assets/images/image-{len(by_hash) + 1:02d}.{EXT[m.group(1)]}'
            (out_dir / name).parent.mkdir(parents=True, exist_ok=True)
            (out_dir / name).write_bytes(data)
            by_hash[digest] = name
            images.append({'file': name, 'bytes': len(data), 'sha256': digest, 'uses': 0})
        entry = next(i for i in images if i['file'] == by_hash[digest])
        entry['uses'] += 1
        return by_hash[digest]

    return DATA_URI.sub(repl, text), images


# ---------------------------------------------------------------- ordering changes
def whatsapp_order_ctas_to_form(text, labels, what):
    """Order buttons that opened WhatsApp now scroll to the Skyfly order form. Plain
    "chat with us" links, the floating bubble and the footer number stay as contact options."""
    changed = []
    for old_label, new_label in labels.items():
        pattern = re.compile(r'<a\b([^>]*?)href="https://wa\.me/[^"]*"([^>]*)>((?:(?!</a>).)*?)' + re.escape(old_label) + r'((?:(?!</a>).)*?)</a>', re.S)
        matches = list(pattern.finditer(text))
        if len(matches) != 1:
            sys.exit(f'[{what}] expected one WhatsApp order button "{old_label}", found {len(matches)}')
        m = matches[0]
        attrs = (m.group(1) + m.group(2)).replace(' target="_blank"', '').replace(' rel="noopener"', '').replace(' rel="noopener noreferrer"', '')
        inner = re.sub(r'<svg\b[^>]*>\s*<use href="#waico"\s*/>\s*</svg>', '', m.group(3))  # the WhatsApp icon would now mislead
        text = text[:m.start()] + f'<a{attrs}href="#order" onclick="smoothTo(\'order\',event)">{inner}{new_label}{m.group(4)}</a>' + text[m.end():]
        changed.append({'from': f'{old_label} (opened WhatsApp)', 'to': f'{new_label} (scrolls to the order form)'})
    return text, changed


def bubble_is_contact_only(text, what):
    """The floating WhatsApp bubble stays, but as a contact option, not the way to order."""
    text = replace_once(text, 'id="wabub">Order on <span>WhatsApp</span>! 👋', 'id="wabub">Questions? Chat on <span>WhatsApp</span>! 👋', what)
    return text, [{'from': 'Floating bubble "Order on WhatsApp!"', 'to': '"Questions? Chat on WhatsApp!" (same bubble, contact only)'}]


def larose_nigeria(text):
    # Already submits to Skyfly with the Google Sheet as backup (live since commit 44d8337).
    for needle in [f'const SKYFLY_API="{SKYFLY_API}"', 'const SKYFLY_PAGE="larosenigeria"', 'const SKYFLY_SHEET_FALLBACK=true', 'Skyfly copies saved orders to the Google Sheet itself', 'id="skySum"']:
        if needle not in text:
            sys.exit(f'[larose-nigeria] expected the Skyfly order code ({needle!r}); re-check the source')
    text, bubble = bubble_is_contact_only(text, 'larose-nigeria')
    text, ctas = whatsapp_order_ctas_to_form(text, {
        'Order on WhatsApp Now': 'Order Now',
        'Yes! I Want This — WhatsApp Me': 'Yes! I Want This — Order Now',
    }, 'larose-nigeria')
    return text, ctas + bubble


def larose_uk(text, nigeria_source):
    changes = []
    what = 'larose-uk'
    # 1. Package options carry the Skyfly product code and the displayed price.
    for code, _, price in PAGES['larose-uk']['products']:
        n = code.split('-')[-1]
        m = re.search(r'<option value="(Package ' + n + r' – [^"]*– £' + str(price) + r')">', text)
        if not m:
            sys.exit(f'[{what}] package {n} option not found')
        text = replace_once(text, m.group(0), f'<option value="{m.group(1)}" data-product="{code}" data-price="{price}">', what)
    changes.append({'change': 'Package options tagged with Skyfly product codes uk-package-1..3 and prices'})

    # 2. Same extra fields as the Nigeria page (minus State), in the page's own style.
    text = replace_once(text, '      <button class="subbtn" id="sb" onclick="doSub()">', '''      <div class="fg"><label>Quantity</label><select id="qty"><option value="1">1</option><option value="2">2</option><option value="3">3</option><option value="4">4</option><option value="5">5</option></select></div>
      <div class="fg"><label>Notes (optional)</label><input type="text" id="nt" maxlength="500" placeholder="Postcode, best time to call, etc."></div>
      <div style="position:absolute;left:-9999px" aria-hidden="true"><input type="text" id="skyfly_hp" tabindex="-1" autocomplete="off"></div>
      <div id="skySum" aria-live="polite" style="display:none;background:#FFF8EC;border:1px solid #E8C989;color:#3D2A10;padding:12px 14px;border-radius:10px;font-size:14px;line-height:1.6;margin-bottom:12px"></div>
      <div id="skyErr" role="alert" style="display:none;background:#FEF2F2;border:1px solid #FCA5A5;color:#B91C1C;padding:12px 14px;border-radius:10px;font-size:13px;line-height:1.6;margin-bottom:12px"></div>
      <button class="subbtn" id="sb" onclick="doSub()">''', what)
    text = replace_once(text, '📲 Place My Order — Contact Me on WhatsApp →', '📲 Place My Order →', what)
    changes.append({'change': 'Added Quantity and optional Notes fields, a hidden spam trap and an error box; submit button no longer mentions WhatsApp'})

    # 3. Order submission: the Nigeria page's tested Skyfly code, adapted.
    start = nigeria_source.index('// --- Skyfly order submission')
    end = nigeria_source.index('</script>', start)
    sub = nigeria_source[start:end]
    for old, new in [
        ('const SKYFLY_PAGE="larosenigeria";', 'const SKYFLY_PAGE="larose-uk";'),
        ("const st=document.getElementById('st').value;", "const st='';"),
        ("  if(!st)missing.state='Select your state.';\n", ''),
        ('customer:{name:fn,phone:ph,', 'customer:{name:fn,phone:skyUkPhone(ph),'),
        ("source:'Larose Nigeria Landing Page 2026 | '", "source:'Larose Landing Page 2026 | '"),
        ("const name=opt.value.replace(/\\s+–\\s+₦[\\d,]+$/,'')", "const name=opt.value.replace(/\\s+–\\s+£[\\d,]+$/,'')"),
        ("'Total: ₦'+total.toLocaleString('en-NG')+' · pay on delivery'", "'Total: £'+total.toLocaleString('en-GB')+' · our team confirms and takes payment'"),
    ]:
        sub = replace_once(sub, old, new, what + ' order code')
    sub = sub.replace('// --- Skyfly order submission --------------------------------------------', '''// --- Skyfly order submission --------------------------------------------
// UK mobiles typed as 07xxx are sent as +44 (Nigerian 070x numbers are left as they are).
function skyUkPhone(p){const d=String(p).replace(/[^\\d+]/g,'');if(/^07[1-9]\\d{8}$/.test(d))return '+44'+d.slice(1);if(/^447\\d{9}$/.test(d))return '+'+d;return p;}''', 1)
    old_start = text.index('async function doSub(){')
    old_end = text.index('</script>', old_start)
    text = text[:old_start] + sub + text[old_end:]
    changes.append({'change': 'Order summary (package × quantity, total in £, "our team confirms and takes payment" as the page already says) shown before submitting'})
    changes.append({'change': 'doSub(): saves the order in Skyfly first (one retry with the same submission ID) and opens the Skyfly confirmation page; Skyfly copies it to the Google Sheet (marked "Skyfly <reference>"). If Skyfly cannot save it, the order goes to the Google Sheet marked "NOT IN SKYFLY" and the original success box is shown. Validation errors are shown on the form.'})

    # 4. Skyfly SDK (pixels configured in Skyfly) + InitiateCheckout, invisible.
    text = replace_once(text, '</body>', f'''<script src="{SKYFLY_API}/sdk/skyfly.js" data-page="larose-uk" async></script>
<script>document.addEventListener('focusin',function(e){{var f=document.getElementById('order');if(f&&f.contains(e.target)&&window.Skyfly&&Skyfly.trackInitiateCheckout)Skyfly.trackInitiateCheckout();}});</script>
</body>''', what)
    changes.append({'change': 'Added the Skyfly page script (loads pixels configured in Skyfly; the page\'s own Meta Pixel is not loaded twice)'})

    text, ctas = whatsapp_order_ctas_to_form(text, {'Yes! I Want This — WhatsApp Me': 'Yes! I Want This — Order Now'}, what)
    text, bubble = bubble_is_contact_only(text, what)
    return text, changes + ctas + bubble


# ---------------------------------------------------------------- manifest
class Outline(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.stack, self.headings, self.buttons, self.fields, self.labels = [], [], [], [], []
        self.sections, self.meta, self.title, self._text = [], {}, '', None

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag in ('h1', 'h2', 'h3', 'button', 'title', 'label') or (tag == 'a' and ('onclick' in a or a.get('href', '').startswith(('https://wa.me', '#')))):
            self._text = {'tag': tag, 'attrs': a, 'text': ''}
        if tag in ('input', 'select', 'textarea') and a.get('type') not in ('hidden',) and a.get('id') != 'skyfly_hp':
            self.fields.append({'id': a.get('id'), 'type': a.get('type', tag), 'required': 'required' in a, 'placeholder': a.get('placeholder')})
        if tag == 'section' or (tag == 'div' and a.get('id')):
            self.sections.append({'tag': tag, 'id': a.get('id'), 'class': a.get('class')})
        if tag == 'meta' and (a.get('name') or a.get('property')):
            self.meta[a.get('name') or a.get('property')] = a.get('content')

    def handle_data(self, data):
        if self._text is not None:
            self._text['text'] += data

    def handle_endtag(self, tag):
        t = self._text
        if t and t['tag'] == tag:
            text = re.sub(r'\s+', ' ', t['text']).strip()
            if tag == 'title':
                self.title = text
            elif tag in ('h1', 'h2', 'h3'):
                self.headings.append({'level': tag, 'text': text})
            elif tag == 'label':
                self.labels.append(text)
            elif text:
                self.buttons.append({'text': text, 'action': t['attrs'].get('onclick') or t['attrs'].get('href', '')[:80]})
            self._text = None


def manifest_for(slug, cfg, page, images, changes, source):
    o = Outline()
    o.feed(re.sub(r'<script\b.*?</script>', '', page, flags=re.S))
    colors = dict(re.findall(r'--([a-z0-9-]+):\s*(#[0-9A-Fa-f]{3,8})', page.split('</style>')[0]))
    fonts = sorted(set(re.findall(r'family=([A-Za-z+]+)', page)))
    options = [{'label': html.unescape(re.sub(r'<[^>]+>', '', m.group(3))).strip(), 'value': html.unescape(m.group(1)), 'productCode': m.group(2)}
               for m in re.finditer(r'<option value="([^"]+)"(?: data-product="([^"]+)" data-price="[^"]+")?>([^<]*)', page)
               if m.group(1) and (m.group(2) or re.search(r'[₦£$€]', m.group(1)))]
    whatsapp = sorted(set(re.findall(r'wa\.me/(\d{8,15})', page)))
    pixels = [{'provider': 'meta', 'id': i} for i in sorted(set(re.findall(r"fbq\('init',\s*'(\d+)'", page)))] + \
             [{'provider': 'tiktok', 'id': i} for i in sorted(set(re.findall(r"ttq\.load\('([A-Z0-9]+)'", page)))]
    order_flow = 'skyfly+google-sheet-backup' if 'const SKYFLY_API=' in page else ('google-sheet+whatsapp' if SHEET_URL in page else 'whatsapp-links-only' if whatsapp else 'none')
    integrations = []
    if 'const SKYFLY_API=' in page:
        integrations.append({'service': 'Skyfly order API', 'endpoint': f'{SKYFLY_API}/api/public/orders', 'formKey': cfg.get('formKey'),
                             'auth': 'none in the browser: Skyfly accepts orders only from the page\'s registered website address (Origin check). No API key in the page.'})
    if SHEET_URL in page:
        integrations.append({'service': 'Google Sheets via SheetDB (backup)', 'endpoint': SHEET_URL, 'note': 'Public SheetDB endpoint already used by the live page; no secret. Keep until Skyfly is verified end to end.'})
    if pixels:
        integrations.append({'service': 'Meta Pixel (in page code)', 'ids': [p['id'] for p in pixels if p['provider'] == 'meta']})
    if 'fonts.googleapis.com' in page:
        integrations.append({'service': 'Google Fonts', 'families': [f.replace('+', ' ') for f in fonts]})
    return {
        'skyflyManifestVersion': 1,
        'slug': slug,
        'name': cfg['name'],
        'pageType': cfg['kind'],
        'source': source,
        'entry': 'index.html',
        'assets': [{'file': 'index.html', 'bytes': len(page.encode())}] + [{k: i[k] for k in ('file', 'bytes', 'sha256', 'uses')} for i in images],
        'orderFlow': {
            'current': order_flow,
            'skyflyFormKey': cfg.get('formKey'),
            'currency': cfg.get('currency'),
            'products': [{'code': c, 'name': n, 'price': p} for c, n, p in cfg.get('products', [])],
            'connectionTested': 'locally only (see IMPORT.md); not yet tested against the live Skyfly service' if cfg['kind'] == 'product-orders' else 'not applicable',
        },
        'changesFromOriginal': [{'change': 'Embedded base64 images moved to assets/images/ (same files, same order; the page looks the same)'}] + changes,
        'integrations': integrations,
        'environment': {'requiredInPage': [], 'requiredInSkyfly': (['business with currency ' + cfg['currency'], 'products with the codes above', f'landing page with form key "{cfg["formKey"]}"'] if cfg.get('formKey') else []),
                        'secrets': 'none: the page contains no private keys or tokens. Pixel access tokens are entered only in Skyfly\'s Pixels screen.'},
        'editableFields': {
            'seo': {'title': o.title, 'description': o.meta.get('description'), 'og': {k: v for k, v in o.meta.items() if k.startswith('og:')}},
            'headings': o.headings,
            'callsToAction': o.buttons,
            'packages': options,
            'contact': {'whatsappNumbers': whatsapp, 'ownerWhatsApp': OWNER_WHATSAPP},
            'formFields': [dict(f, label=(o.labels[i] if i < len(o.labels) else None)) for i, f in enumerate(o.fields)],
            'design': {'colors': colors, 'fonts': [f.replace('+', ' ') for f in fonts]},
            'sections': o.sections,
            'images': [{'file': i['file'], 'bytes': i['bytes']} for i in images],
            'pixels': pixels,
        },
    }


# ---------------------------------------------------------------- build
def main():
    shutil.rmtree(PACKAGES, ignore_errors=True)
    shutil.rmtree(DIST, ignore_errors=True)
    DIST.mkdir(parents=True)
    nigeria_source = (SOURCES / 'larose-nigeria' / 'original.html').read_text(encoding='utf-8')
    for slug, cfg in PAGES.items():
        src = SOURCES / slug
        out = PACKAGES / slug
        out.mkdir(parents=True)
        source = json.loads((src / 'source.json').read_text())
        original = (src / 'original.html').read_text(encoding='utf-8')
        page, images = extract_images(original, out)
        if slug == 'larose-nigeria':
            page, changes = larose_nigeria(page)
        elif slug == 'larose-uk':
            page, changes = larose_uk(page, nigeria_source)
        else:
            changes = []
        (out / 'index.html').write_text(page, encoding='utf-8')
        manifest = manifest_for(slug, cfg, page, images, changes, source)
        (out / 'skyfly-manifest.json').write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
        template = ROOT / 'templates' / f'{slug}.md'
        if not template.exists():
            template = ROOT / 'templates' / f'{cfg["kind"]}.md'
        (out / 'IMPORT.md').write_text(template.read_text(encoding='utf-8')
                                       .replace('{{NAME}}', cfg['name']).replace('{{SLUG}}', slug)
                                       .replace('{{FORM_KEY}}', cfg.get('formKey') or '')
                                       .replace('{{PRODUCTS}}', '\n'.join(f'   | `{c}` | {n} | {p} |' for c, n, p in cfg.get('products', []))), encoding='utf-8')
        with zipfile.ZipFile(DIST / f'{slug}.zip', 'w', zipfile.ZIP_DEFLATED) as z:
            for f in sorted(out.rglob('*')):
                if f.is_file() and f.name not in ('skyfly-manifest.json', 'IMPORT.md'):
                    z.write(f, f.relative_to(out).as_posix())
        print(f'{slug}: {len(images)} images, {len(changes)} changes, {(DIST / f"{slug}.zip").stat().st_size // 1024} KB zip')


if __name__ == '__main__':
    main()
