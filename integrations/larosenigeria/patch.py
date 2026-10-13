#!/usr/bin/env python3
"""Connects the Larose Nigeria landing page order form to Skyfly.

Usage: python3 patch.py <path/to/original/index.html> <output.html> <skyfly-base-url>

Makes the smallest possible change to the existing page: adds data attributes
to the package options, adds State / Quantity / Notes fields in the existing
style, and replaces doSub() so the order is saved in Skyfly before the customer
is redirected to their confirmation page. Fails if the page has changed shape.
"""
import sys

src, out, api = sys.argv[1], sys.argv[2], sys.argv[3].rstrip('/')
if not api.startswith('https://') and not api.startswith('http://127.0.0.1') and not api.startswith('http://localhost'):
    sys.exit('Skyfly URL must be https:// (or localhost for testing)')
html = open(src, encoding='utf-8').read()

def replace_once(old, new):
    global html
    count = html.count(old)
    if count != 1:
        sys.exit(f'Expected exactly one match, found {count}: {old[:80]!r}')
    html = html.replace(old, new)

PACKAGES = [
    ('Package 1 – Starter Glow Soap (1kg Soap) – ₦23,500', 'package-1', 23500),
    ('Package 2 – Starter Glow Combo – ₦33,000', 'package-2', 33000),
    ('Package 3 – Power Glow – ₦51,500', 'package-3', 51500),
    ('Package 4 – Total Revive Full – ₦93,500', 'package-4', 93500),
    ('Package 5 – Total Transformation VIP Luxury (5kg Soap) – ₦202,000', 'package-5', 202000),
]
for value, code, price in PACKAGES:
    replace_once(f'<option value="{value}">', f'<option value="{value}" data-product="{code}" data-price="{price}">')

STATES = ['Abia', 'Adamawa', 'Akwa Ibom', 'Anambra', 'Bauchi', 'Bayelsa', 'Benue', 'Borno', 'Cross River',
          'Delta', 'Ebonyi', 'Edo', 'Ekiti', 'Enugu', 'FCT - Abuja', 'Gombe', 'Imo', 'Jigawa', 'Kaduna', 'Kano',
          'Katsina', 'Kebbi', 'Kogi', 'Kwara', 'Lagos', 'Nasarawa', 'Niger', 'Ogun', 'Ondo', 'Osun', 'Oyo',
          'Plateau', 'Rivers', 'Sokoto', 'Taraba', 'Yobe', 'Zamfara']
state_options = ''.join(f'<option value="{s}">{s}</option>' for s in STATES)

replace_once(
    '      <button class="subbtn" id="sb" onclick="doSub()">',
    f'''      <div class="fg"><label>State *</label><select id="st" required><option value="">— Select your state —</option>{state_options}</select></div>
      <div class="fg"><label>Quantity</label><select id="qty"><option value="1">1</option><option value="2">2</option><option value="3">3</option><option value="4">4</option><option value="5">5</option></select></div>
      <div class="fg"><label>Notes (optional)</label><input type="text" id="nt" maxlength="500" placeholder="Landmark, best time to call, etc."></div>
      <div style="position:absolute;left:-9999px" aria-hidden="true"><input type="text" id="skyfly_hp" tabindex="-1" autocomplete="off"></div>
      <div id="skyErr" role="alert" style="display:none;background:#FEF2F2;border:1px solid #FCA5A5;color:#B91C1C;padding:12px 14px;border-radius:10px;font-size:13px;line-height:1.6;margin-bottom:12px"></div>
      <button class="subbtn" id="sb" onclick="doSub()">''',
)

start = html.index('async function doSub(){')
end = html.index('</script>', start)
if html.count('async function doSub(){') != 1:
    sys.exit('doSub() not found exactly once')

new_sub = r'''// --- Skyfly order submission --------------------------------------------
const SKYFLY_API="__SKYFLY_API__";
const SKYFLY_PAGE="larosenigeria";
let skyMem={};
function skyStore(k,v){try{if(v===undefined)return sessionStorage.getItem(k);sessionStorage.setItem(k,v);}catch(e){if(v===undefined)return skyMem[k]||null;skyMem[k]=v;}}
function skyRandom(){if(window.crypto&&crypto.randomUUID)return crypto.randomUUID();let s='';const a=new Uint8Array(16);crypto.getRandomValues(a);a.forEach(b=>s+=b.toString(16).padStart(2,'0'));return s;}
// Same details => same key, so retries and double clicks never create a second order.
function skyKey(payloadText){if(skyStore('skyflyPayload')!==payloadText){skyStore('skyflyKey',skyRandom());skyStore('skyflyPayload',payloadText);}return skyStore('skyflyKey');}
const SKY_FIELDS={name:'fn',phone:'ph',address:'addr',email:'em',state:'st',items:'pr',quantity:'qty'};
function skyShowError(msg,fields){
  const box=document.getElementById('skyErr');
  Object.values(SKY_FIELDS).forEach(id=>{const el=document.getElementById(id);if(el)el.style.borderColor='';});
  Object.keys(fields||{}).forEach(f=>{const el=document.getElementById(SKY_FIELDS[f]);if(el)el.style.borderColor='#DC2626';});
  const details=Object.values(fields||{}).filter(Boolean);
  box.textContent='';
  const p=document.createElement('div');p.textContent=msg;box.appendChild(p);
  if(details.length){const ul=document.createElement('ul');ul.style.margin='6px 0 0 18px';details.forEach(d=>{const li=document.createElement('li');li.textContent=d;ul.appendChild(li);});box.appendChild(ul);}
  const wa=document.createElement('div');wa.style.marginTop='6px';
  wa.innerHTML='Still having trouble? <a target="_blank" rel="noopener" style="color:#B91C1C;font-weight:700" href="https://wa.me/'+WA+'?text='+encodeURIComponent('Hi Larose! I tried to order on the website but it did not go through.')+'">Message us on WhatsApp</a>.';
  box.appendChild(wa);
  box.style.display='block';
  box.scrollIntoView({behavior:'smooth',block:'center'});
}
let skyBusy=false;
async function doSub(){
  if(skyBusy)return;
  const fn=document.getElementById('fn').value.trim();
  const ph=document.getElementById('ph').value.trim();
  const addr=document.getElementById('addr').value.trim();
  const em=document.getElementById('em').value.trim();
  const st=document.getElementById('st').value;
  const qty=parseInt(document.getElementById('qty').value,10)||1;
  const nt=document.getElementById('nt').value.trim();
  const sel=document.getElementById('pr');
  const opt=sel.options[sel.selectedIndex];
  const missing={};
  if(!fn)missing.name='Enter your full name.';
  if(!addr)missing.address='Enter your delivery address.';
  if(!ph)missing.phone='Enter your phone number.';
  if(!st)missing.state='Select your state.';
  if(!sel.value||!opt||!opt.dataset.product)missing.items='Select your package.';
  if(Object.keys(missing).length){skyShowError('Please fill in all required fields.',missing);return;}

  const q=new URLSearchParams(location.search);
  const order={landingPage:SKYFLY_PAGE,
    customer:{name:fn,phone:ph,email:em,address:addr,state:st,notes:nt},
    items:[{product:opt.dataset.product,quantity:qty,unitPrice:Number(opt.dataset.price)}],
    website:document.getElementById('skyfly_hp').value};
  order.idempotencyKey=skyKey(JSON.stringify(order));
  order.attribution={pageUrl:location.href,referrer:document.referrer,utm_source:q.get('utm_source'),utm_medium:q.get('utm_medium'),utm_campaign:q.get('utm_campaign'),utm_content:q.get('utm_content'),utm_term:q.get('utm_term')};

  const btn=document.getElementById('sb');
  const label=btn.textContent;
  skyBusy=true;btn.disabled=true;btn.textContent='Submitting...';
  document.getElementById('skyErr').style.display='none';
  const ctrl=new AbortController();const timer=setTimeout(()=>ctrl.abort(),60000);
  let res,data;
  try{
    res=await fetch(SKYFLY_API+'/api/public/orders',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(order),signal:ctrl.signal});
    data=await res.json().catch(()=>null);
  }catch(e){
    data=null;
  }finally{clearTimeout(timer);}

  if(res&&res.ok&&data&&data.ok&&data.confirmationUrl){
    btn.textContent='Order saved ✓';
    try{fbq('track','Lead',{value:data.total,currency:data.currency});}catch(e){}
    // Keep the existing Google Sheet copy (best effort; never blocks the order).
    try{fetch(SHEET,{method:'POST',keepalive:true,headers:{'Content-Type':'application/json'},body:JSON.stringify({data:{timestamp:new Date().toISOString(),reference:data.reference,fullName:fn,address:addr,state:st,phone:ph,email:em,package:sel.value,quantity:qty,notes:nt,source:'Larose Nigeria Landing Page 2026'}})}).catch(()=>{});}catch(e){}
    setTimeout(()=>{location.href=data.confirmationUrl;},150);
    return;
  }
  skyBusy=false;btn.disabled=false;btn.textContent=label;
  if(data&&data.message){skyShowError(data.message,data.fields);}
  else{skyShowError("We couldn't reach our order system. Please check your internet connection and tap the button again — your details are still here.");}
}
'''.replace('__SKYFLY_API__', api)

html = html[:start] + new_sub + html[end:]
open(out, 'w', encoding='utf-8').write(html)
print(f'Wrote {out} (Skyfly API: {api})')
