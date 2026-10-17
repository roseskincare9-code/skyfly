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
# "disabled": orders go only to the Google Sheet (used until the real Skyfly URL is confirmed).
if api == 'disabled':
    api = ''
elif not api.startswith('https://') and not api.startswith('http://127.0.0.1') and not api.startswith('http://localhost'):
    sys.exit('Skyfly URL must be https:// (or localhost for testing), or "disabled"')
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
      <div id="skySum" aria-live="polite" style="display:none;background:#FFF8EC;border:1px solid #E8C989;color:#3D2A10;padding:12px 14px;border-radius:10px;font-size:14px;line-height:1.6;margin-bottom:12px"></div>
      <div id="skyErr" role="alert" style="display:none;background:#FEF2F2;border:1px solid #FCA5A5;color:#B91C1C;padding:12px 14px;border-radius:10px;font-size:13px;line-height:1.6;margin-bottom:12px"></div>
      <button class="subbtn" id="sb" onclick="doSub()">''',
)

# The old WhatsApp number (07039361243) was blocked by WhatsApp. Replace every
# link, visible number and the WA constant with the new business number.
OLD_INTL, NEW_INTL = '2347039361243', '2349049206695'
OLD_LOCAL, NEW_LOCAL = '07039361243', '09049206695'
found = html.count(OLD_INTL) + html.count(OLD_LOCAL)
html = html.replace(OLD_INTL, NEW_INTL).replace(OLD_LOCAL, NEW_LOCAL)
if '7039361243' in html:
    sys.exit('Old WhatsApp number still present after replacement')
print(f'Replaced {found} uses of the old WhatsApp number')

start = html.index('async function doSub(){')
end = html.index('</script>', start)
if html.count('async function doSub(){') != 1:
    sys.exit('doSub() not found exactly once')

new_sub = r'''// --- Skyfly order submission --------------------------------------------
const SKYFLY_API="__SKYFLY_API__";
const SKYFLY_PAGE="larosenigeria";
// While Skyfly is being proven, orders Skyfly can't save still go to the Google Sheet.
// Set to false once Skyfly has received real orders reliably.
const SKYFLY_SHEET_FALLBACK=true;
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
// Order summary: package × quantity and the total, shown before the customer submits.
function skyUpdateSummary(){
  const sel=document.getElementById('pr'),q=document.getElementById('qty'),box=document.getElementById('skySum');
  if(!sel||!q||!box)return;
  const opt=sel.options[sel.selectedIndex],qty=parseInt(q.value,10)||1;
  if(!sel.value||!opt||!opt.dataset.price){box.style.display='none';return;}
  const name=opt.value.replace(/\s+–\s+₦[\d,]+$/,''),total=Number(opt.dataset.price)*qty;
  box.textContent='';
  const t=document.createElement('div');t.style.fontWeight='700';t.textContent='Your order';box.appendChild(t);
  const l=document.createElement('div');l.textContent=name+' × '+qty;box.appendChild(l);
  const s=document.createElement('div');s.style.fontWeight='700';s.textContent='Total: ₦'+total.toLocaleString('en-NG')+' · pay on delivery';box.appendChild(s);
  box.style.display='block';
}
document.addEventListener('change',function(e){if(e.target&&(e.target.id==='pr'||e.target.id==='qty'))skyUpdateSummary();});
if(typeof selectPkg==='function'){const skyPick=selectPkg;selectPkg=function(v){skyPick(v);skyUpdateSummary();};}
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
  // No confirmed Skyfly address yet: send the order only to the Google Sheet, as before.
  if(!SKYFLY_API){
    if(await skySheet(order,'SKYFLY NOT CONNECTED',15000)){skyOldSuccess(fn,sel.value,addr);return;}
    skyBusy=false;btn.disabled=false;btn.textContent=label;
    skyShowError("We couldn't send your order. Please check your internet connection and tap the button again — your details are still here.");
    return;
  }
  document.getElementById('skyErr').style.display='none';
  let res,data;
  // One retry with the same submission ID if Skyfly can't be reached or errors on its side.
  // Retrying is safe: if the first attempt was saved, Skyfly returns that same order.
  for(let attempt=0;attempt<2;attempt++){
    if(attempt){btn.textContent='Still sending...';await new Promise(r=>setTimeout(r,2000));}
    const ctrl=new AbortController();const timer=setTimeout(()=>ctrl.abort(),attempt?30000:45000);
    res=null;data=null;
    try{
      res=await fetch(SKYFLY_API+'/api/public/orders',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(order),signal:ctrl.signal});
      data=await res.json().catch(()=>null);
    }catch(e){}finally{clearTimeout(timer);}
    if(res&&res.status<500&&res.status!==429)break;
  }

  if(res&&res.ok&&data&&data.ok&&data.confirmationUrl){
    btn.textContent='Order saved ✓';
    try{fbq('track','Lead',{value:data.total,currency:data.currency});}catch(e){}
    try{if(window.Skyfly&&Skyfly.trackLead)Skyfly.trackLead(data.total,data.currency,data.reference);}catch(e){}
    // One Purchase per saved order (never for test orders); Skyfly keeps it from repeating on retries or refreshes.
    try{if(window.Skyfly&&Skyfly.trackPurchase)Skyfly.trackPurchase(data);}catch(e){}
    // Skyfly copies saved orders to the Google Sheet itself (with retries), so the page doesn't.
    setTimeout(()=>{location.href=data.confirmationUrl;},300);
    return;
  }
  // The customer's details need fixing: show what to change and let them retry.
  if(data&&data.error==='VALIDATION'){
    skyBusy=false;btn.disabled=false;btn.textContent=label;
    skyShowError(data.message,data.fields);
    return;
  }
  // Skyfly unreachable or not ready: fall back to the existing Google Sheet flow so no order is lost.
  if(SKYFLY_SHEET_FALLBACK){
    const saved=await skySheet(order,'NOT IN SKYFLY ('+((data&&data.error)||'unreachable')+')',15000);
    if(saved){skyOldSuccess(fn,sel.value,addr);return;}
  }
  skyBusy=false;btn.disabled=false;btn.textContent=label;
  if(data&&data.message){skyShowError(data.message,data.fields);}
  else{skyShowError("We couldn't reach our order system. Please check your internet connection and tap the button again — your details are still here.");}
}
// Sends the order to the existing Google Sheet (SheetDB). Resolves true if it was accepted.
async function skySheet(order,marker,waitMs){
  const c=order.customer,it=order.items[0];
  const d={timestamp:new Date().toISOString(),fullName:c.name,address:c.address+(c.state?', '+c.state:''),phone:c.phone,email:c.email,
    package:document.getElementById('pr').value+(it.quantity>1?' x'+it.quantity:''),
    // The submission ID is also stored in Skyfly, so any row can be matched to (or ruled out from) a Skyfly order.
    source:'Larose Nigeria Landing Page 2026 | '+marker+(order.idempotencyKey?' | ID '+order.idempotencyKey.slice(0,8):''),
    state:c.state,quantity:it.quantity,notes:c.notes,skyflyId:order.idempotencyKey||''};
  try{
    const req=fetch(SHEET,{method:'POST',keepalive:true,headers:{'Content-Type':'application/json'},body:JSON.stringify({data:d})}).then(r=>r.ok,()=>false);
    return await Promise.race([req,new Promise(r=>setTimeout(()=>r(false),waitMs))]);
  }catch(e){return false;}
}
// The page's original "Order Received" box with its WhatsApp button (used only in fallback).
function skyOldSuccess(fn,pr,addr){
  const msg=encodeURIComponent(`Hi Larose! I just placed an order.\n\n👤 Name: ${fn}\n📦 Package: ${pr}\n📍 Address: ${addr}\n\nPlease confirm my order. Thank you! 🙏`);
  document.getElementById('waFinal').href=`https://wa.me/${WA}?text=${msg}`;
  document.getElementById('formContent').style.display='none';
  document.getElementById('sb2').style.display='block';
  window.scrollTo({top:document.getElementById('order').offsetTop-80,behavior:'smooth'});
}
'''.replace('__SKYFLY_API__', api)

html = html[:start] + new_sub + html[end:]

if api:
    # Skyfly page SDK: loads the pixels configured in Skyfly (Meta/TikTok) and fires
    # InitiateCheckout when the visitor starts the order form. Loads async, invisible.
    sdk = (f'<script src="{api}/sdk/skyfly.js" data-page="larosenigeria" async></script>\n'
           '<script>document.addEventListener(\'focusin\',function(e){var f=document.getElementById(\'order\');'
           'if(f&&f.contains(e.target)&&window.Skyfly&&Skyfly.trackInitiateCheckout)Skyfly.trackInitiateCheckout();});</script>\n')
    if html.count('</body>') != 1:
        sys.exit('</body> not found exactly once')
    html = html.replace('</body>', sdk + '</body>')
open(out, 'w', encoding='utf-8').write(html)
print(f'Wrote {out} (Skyfly API: {api})')
