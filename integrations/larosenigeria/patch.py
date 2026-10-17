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

# Orders are placed on the website (saved in Skyfly). The two "order on WhatsApp" buttons now
# open the on-page checkout, in the page's own button style. WhatsApp stays as a voluntary
# support contact (the floating button and "Chat With Us"), and never opens by itself.
ORDER_CTA = '<a class="btng" href="#order" style="text-decoration:none;font-size:13px;padding:15px 38px;animation:none" onclick="smoothTo(\'order\',event)">'
replace_once(
    '<a class="wa-sbtn" href="https://wa.me/2349049206695?text=Hi%20Larose!%20I%20want%20to%20order!" target="_blank"><svg viewBox="0 0 24 24"><use href="#waico"/></svg>Order on WhatsApp Now</a>',
    ORDER_CTA + '🛍️ Order Now — Pay on Delivery</a>')
replace_once(
    '<a class="wa-sbtn" href="https://wa.me/2349049206695?text=Hi%20Larose!%20I%20want%20to%20order!" target="_blank"><svg viewBox="0 0 24 24"><use href="#waico"/></svg>Yes! I Want This — WhatsApp Me</a>',
    ORDER_CTA + '💜 Yes! I Want This — Order Now</a>')
replace_once('<div class="wabub" id="wabub">Order on <span>WhatsApp</span>! 👋</div>',
             '<div class="wabub" id="wabub">Questions? Chat on <span>WhatsApp</span> 👋</div>')
replace_once('<a class="wafbtn" href="https://wa.me/2349049206695?text=Hi%20Larose!%20I%20want%20to%20order!" target="_blank">',
             '<a class="wafbtn" href="https://wa.me/2349049206695?text=Hi%20Larose!%20I%20have%20a%20question." target="_blank" rel="noopener" aria-label="Chat with Larose on WhatsApp (09049206695)">')
replace_once('<button class="subbtn" id="sb" onclick="doSub()">📲 Place My Order — Call/WhatsApp Me →</button>',
             '<button class="subbtn" id="sb" onclick="doSub()">🛍️ Place My Order →</button>')
# The confirmation is shown on the page, filled in from Skyfly's reply (never before the order is saved).
replace_once('''    <div class="succbox" id="sb2">
      <div class="ck">🎉</div>
      <h3>Order Received!</h3>
      <p>Our team will call or WhatsApp you within <strong>1 hour</strong> to confirm your package and arrange delivery.</p>
      <p style="margin-top:10px;color:var(--purple);font-weight:600">Can't wait? Message us now 👇</p>
      <a class="wabig" id="waFinal" href="#" target="_blank"><svg style="width:20px;height:20px;fill:#fff" viewBox="0 0 24 24"><use href="#waico"/></svg>Message Larose on WhatsApp</a>
    </div>''', '''    <div class="succbox" id="sb2" role="status" aria-live="polite">
      <div class="ck">🎉</div>
      <h3 id="skyThanks">Thank you! Your order is confirmed.</h3>
      <div id="skyConf" style="background:#FFF8EC;border:1px solid #E8C989;color:#3D2A10;padding:14px 16px;border-radius:10px;font-size:14px;line-height:1.8;text-align:left;margin:14px 0"></div>
      <p><strong>What happens next:</strong> our team will call you within <strong>1 hour</strong> (8am–8pm) to confirm your package and delivery. You pay when your order arrives.</p>
      <p style="margin-top:10px"><a id="skyView" href="#" style="color:var(--purple);font-weight:600">View your order details</a> · <a href="#" id="skyAgain" style="color:var(--muted)">Place another order</a></p>
      <p style="margin-top:10px;font-size:12px">Questions? <a href="https://wa.me/2349049206695" target="_blank" rel="noopener" style="color:var(--pink2)">WhatsApp 09049206695</a></p>
    </div>''')

start = html.index('async function doSub(){')
end = html.index('</script>', start)
if html.count('async function doSub(){') != 1:
    sys.exit('doSub() not found exactly once')

new_sub = r'''// --- Skyfly order submission --------------------------------------------
const SKYFLY_API="__SKYFLY_API__";
const SKYFLY_PAGE="larosenigeria";
// Orders are confirmed only by Skyfly (the database is the source of truth). Skyfly copies
// each saved order to the Google Sheet itself, so the page never writes to the Sheet.
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
  skyBusy=true;btn.disabled=true;btn.textContent='Placing your order...';
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

  if(res&&res.ok&&data&&data.ok&&data.reference){
    btn.textContent='Order saved ✓';
    try{fbq('track','Lead',{value:data.total,currency:data.currency});}catch(e){}
    try{if(window.Skyfly&&Skyfly.trackLead)Skyfly.trackLead(data.total,data.currency,data.reference);}catch(e){}
    // One Purchase per saved order (never for test orders); Skyfly keeps it from repeating on retries or refreshes.
    try{if(window.Skyfly&&Skyfly.trackPurchase)Skyfly.trackPurchase(data);}catch(e){}
    const conf={name:fn,reference:data.reference,item:opt.value.replace(/\s+–\s+₦[\d,]+$/,''),quantity:qty,total:data.total,currency:data.currency,url:data.confirmationUrl};
    skyStore('skyflyConfirmed',JSON.stringify(conf));
    skyShowConfirmation(conf);
    return;
  }
  // The customer's details need fixing: show what to change and let them retry.
  if(data&&data.error==='VALIDATION'){
    skyBusy=false;btn.disabled=false;btn.textContent=label;
    skyShowError(data.message,data.fields);
    return;
  }
  // Not saved: say so plainly. Tapping again is safe (same submission ID, so never a duplicate).
  skyBusy=false;btn.disabled=false;btn.textContent=label;
  if(data&&data.message){skyShowError(data.message,data.fields);}
  else{skyShowError("Your order has not been placed yet: we couldn't reach our order system. Please check your internet connection and tap the button again — your details are still here.");}
}
// The on-page confirmation, built only from Skyfly's reply for a saved order.
function skyShowConfirmation(c){
  const box=document.getElementById('skyConf');box.textContent='';
  const fmt=(n)=>(c.currency==='NGN'?'₦':c.currency+' ')+Number(n).toLocaleString('en-NG');
  [['Order reference',c.reference],['Package',c.item],['Quantity',String(c.quantity)],['Total (pay on delivery)',fmt(c.total)]].forEach(([k,v])=>{
    const row=document.createElement('div');const b=document.createElement('strong');b.textContent=k+': ';row.appendChild(b);
    const val=document.createElement('span');val.textContent=v;if(k==='Order reference')val.id='skyRef';row.appendChild(val);box.appendChild(row);});
  document.getElementById('skyThanks').textContent='Thank you'+(c.name?', '+c.name.split(' ')[0]:'')+'! Your order is confirmed.';
  const view=document.getElementById('skyView');if(c.url){view.href=c.url;view.style.display='';}else{view.style.display='none';}
  document.getElementById('formContent').style.display='none';
  document.getElementById('sb2').style.display='block';
  const o=document.getElementById('order');if(o)window.scrollTo({top:o.offsetTop-80,behavior:'smooth'});
}
// After a refresh the confirmation stays (no new order, no new Purchase); "Place another order" clears it.
(function(){
  const again=document.getElementById('skyAgain');
  if(again)again.addEventListener('click',function(e){e.preventDefault();skyStore('skyflyConfirmed','');skyStore('skyflyPayload','');location.hash='order';location.reload();});
  let saved=null;try{saved=JSON.parse(skyStore('skyflyConfirmed')||'null');}catch(e){}
  if(saved&&saved.reference)skyShowConfirmation(saved);
})();
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
