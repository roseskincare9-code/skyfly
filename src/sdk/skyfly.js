/*! Skyfly page SDK: order form connection + pixel events. https://github.com/roseskincare9-code/skyfly */
(function () {
  'use strict';
  if (window.Skyfly && window.Skyfly.version) return; // loaded twice: keep the first copy

  var script = document.currentScript || document.querySelector('script[src*="/sdk/skyfly.js"]');
  var injected = window.__SKYFLY__ || null;
  var pageKey = (injected && injected.page) || (script && script.getAttribute('data-page')) || '';
  var api = ((injected && injected.api) || (script && script.getAttribute('data-api')) ||
    (script ? new URL(script.src, location.href).origin : '')).replace(/\/+$/, '');
  var fired = {};

  // ---------- storage that never throws (private browsing, sandboxed pages) ----------
  var mem = {};
  function store(k, v) {
    try { if (v === undefined) return sessionStorage.getItem(k); sessionStorage.setItem(k, v); }
    catch (e) { if (v === undefined) return mem[k] || null; mem[k] = v; }
  }
  function cookie(name) {
    var all = '';
    try { all = document.cookie; } catch (e) { return null; } // sandboxed pages have no cookies (reading them throws)
    var m = all.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
    return m ? decodeURIComponent(m[1]) : null;
  }
  function randomId() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    var a = new Uint8Array(16); crypto.getRandomValues(a);
    return Array.prototype.map.call(a, function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
  }

  // ---------- pixels ----------
  var pixels = [];
  // A pixel ID already present in the page's own code is left to the page, so it is never loaded or counted twice.
  function inPage(id) {
    var scripts = document.getElementsByTagName('script');
    for (var i = 0; i < scripts.length; i++) {
      var s = scripts[i];
      if (s.src || s.hasAttribute('data-skyfly-config')) continue; // Skyfly's own config is not the page's pixel code
      if (s.text.indexOf(id) !== -1) return true;
    }
    return false;
  }
  // Ad platform scripts are fetched after the page has loaded (so they never slow down the
  // page's own content); events called before that are queued and sent once they arrive.
  function later(fn) {
    function go() { if (window.requestIdleCallback) requestIdleCallback(fn, { timeout: 2000 }); else setTimeout(fn, 1); }
    if (document.readyState === 'complete') go(); else window.addEventListener('load', go);
  }
  function addScript(src) {
    var t = document.createElement('script'); t.async = true; t.src = src;
    var s = document.getElementsByTagName('script')[0]; s ? s.parentNode.insertBefore(t, s) : document.head.appendChild(t);
  }
  function loadMeta(p) {
    if (!window.fbq) {
      /* Meta Pixel base code (queue now, script after load) */
      var n = window.fbq = function () { n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments); };
      if (!window._fbq) window._fbq = n; n.push = n; n.loaded = true; n.version = '2.0'; n.queue = [];
      later(function () { addScript('https://connect.facebook.net/en_US/fbevents.js'); });
    }
    window.fbq('init', p.id);
  }
  function loadTikTok(p) {
    if (!window.ttq) {
      /* TikTok Pixel base code */
      !function (w, d, t) { w.TiktokAnalyticsObject = t; var ttq = w[t] = w[t] || []; ttq.methods = ['page', 'track', 'identify', 'instances', 'debug', 'on', 'off', 'once', 'ready', 'alias', 'group', 'enableCookie', 'disableCookie', 'holdConsent', 'revokeConsent', 'grantConsent'];
        ttq.setAndDefer = function (t, e) { t[e] = function () { t.push([e].concat(Array.prototype.slice.call(arguments, 0))); }; };
        for (var i = 0; i < ttq.methods.length; i++) ttq.setAndDefer(ttq, ttq.methods[i]);
        ttq.instance = function (t) { for (var e = ttq._i[t] || [], n = 0; n < ttq.methods.length; n++) ttq.setAndDefer(e, ttq.methods[n]); return e; };
        ttq.load = function (e, n) { var r = 'https://analytics.tiktok.com/i18n/pixel/events.js'; ttq._i = ttq._i || {}; ttq._i[e] = []; ttq._i[e]._u = r; ttq._t = ttq._t || {}; ttq._t[e] = +new Date(); ttq._o = ttq._o || {}; ttq._o[e] = n || {};
          later(function () { addScript(r + '?sdkid=' + e + '&lib=' + t); }); };
      }(window, document, 'ttq');
    }
    window.ttq.load(p.id);
  }
  function wants(p, event) { return p.events.indexOf(event) !== -1; }

  // Fires an event once per page view (or once per key, e.g. per order reference).
  function track(event, params, onceKey, skipOwn) {
    var key = event + ':' + (onceKey || '');
    if (fired[key]) return;
    fired[key] = true;
    pixels.forEach(function (p) {
      if (!wants(p, event) || (skipOwn && p.own)) return;
      try {
        if (p.provider === 'meta' && window.fbq) {
          window.fbq('trackSingle', p.id, event, params && params.data || {}, params && params.eventId ? { eventID: params.eventId } : undefined);
        } else if (p.provider === 'tiktok' && window.ttq) {
          var ev = { PageView: null, ViewContent: 'ViewContent', InitiateCheckout: 'InitiateCheckout', Lead: 'SubmitForm', Purchase: 'CompletePayment' }[event];
          var inst = window.ttq.instance(p.id);
          if (event === 'PageView') inst.page();
          else if (ev) inst.track(ev, params && params.data || {}, params && params.eventId ? { event_id: params.eventId } : undefined);
        }
      } catch (e) { /* tracking must never break the page */ }
    });
  }

  function startPixels(config) {
    (config.pixels || []).forEach(function (p) {
      var own = inPage(p.id); // the page already loads this pixel and fires its own PageView
      try {
        if (!own) (p.provider === 'meta' ? loadMeta : loadTikTok)(p);
      } catch (e) { return; }
      pixels.push({ provider: p.provider, id: p.id, own: own, events: own ? p.events.filter(function (e) { return e !== 'PageView'; }) : p.events });
    });
    track('PageView');
    track('ViewContent');
  }

  // ---------- orders ----------
  function attribution() {
    var q = new URLSearchParams(location.search);
    var fbclid = q.get('fbclid');
    return {
      pageUrl: location.href, referrer: document.referrer,
      utm_source: q.get('utm_source'), utm_medium: q.get('utm_medium'), utm_campaign: q.get('utm_campaign'),
      utm_content: q.get('utm_content'), utm_term: q.get('utm_term'),
      fbp: cookie('_fbp'), fbc: cookie('_fbc') || (fbclid ? 'fb.1.' + Date.now() + '.' + fbclid : null),
      ttp: cookie('_ttp'), ttclid: q.get('ttclid'),
    };
  }

  // Purchase: only after Skyfly has saved the order and given it a reference; once per order on
  // this browser (a refresh, a retry or a second tab never counts it again); never for test
  // orders. The event ID matches Skyfly's server-side Purchase, so the platform counts it once.
  function purchase(data) {
    // Only Skyfly's success reply for a saved order counts (never a click, an attempt or a page visit).
    if (!data || data.ok !== true || !data.reference || data.test) return;
    var key = 'skyfly_purchase_' + data.reference;
    var seen = false;
    try { seen = Boolean(localStorage.getItem(key)); localStorage.setItem(key, '1'); } catch (e) { /* storage blocked */ }
    if (seen || store(key)) return;
    store(key, '1');
    track('Purchase', { data: { value: data.total, currency: data.currency, content_type: 'product' }, eventId: 'purchase_' + data.reference }, data.reference);
  }

  // Same details => same key, so retries and double clicks never create a second order.
  var canStore = (function () { try { sessionStorage.setItem('skyfly_t', '1'); sessionStorage.removeItem('skyfly_t'); return true; } catch (e) { return false; } })();
  function hash(text) { // cyrb53: a short, stable fingerprint (not a secret)
    var h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (var i = 0; i < text.length; i++) { var c = text.charCodeAt(i); h1 = Math.imul(h1 ^ c, 2654435761); h2 = Math.imul(h2 ^ c, 1597334677); }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (h2 >>> 0).toString(36) + (h1 >>> 0).toString(36);
  }
  function keyFor(order) {
    var text = JSON.stringify([order.landingPage, order.customer, order.items]);
    // Without storage (sandboxed or private pages) the key comes from the details and a 30-minute
    // window, so submitting the same order again after a refresh returns the saved order.
    if (!canStore) return 'skyh-' + hash(text) + '-' + Math.floor(Date.now() / 1800000).toString(36);
    if (store('skyfly_payload') !== text) { store('skyfly_key', randomId()); store('skyfly_payload', text); }
    return store('skyfly_key');
  }

  // Resolves with { ok: true, reference, confirmationUrl, ... } only after Skyfly has saved the order.
  var attempted = {};
  function submitOrder(order) {
    order = Object.assign({ landingPage: pageKey }, order);
    order.idempotencyKey = keyFor(order);
    // A replayed order that this visit never sent was saved (and counted) on an earlier visit:
    // e.g. a refresh, then the same details sent again. Without storage, only this tells them apart.
    var earlierVisit = !canStore && !attempted[order.idempotencyKey];
    attempted[order.idempotencyKey] = true;
    order.attribution = Object.assign(attribution(), order.attribution || {});
    var ctrl = window.AbortController ? new AbortController() : null;
    var timer = ctrl && setTimeout(function () { ctrl.abort(); }, 60000);
    return fetch(api + '/api/public/orders', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(order), signal: ctrl && ctrl.signal,
    }).then(function (res) {
      return res.json().catch(function () { return null; }).then(function (data) {
        if (res.ok && data && data.ok) {
          if (!(data.replayed && earlierVisit)) {
            track('Lead', { data: { value: data.total, currency: data.currency }, eventId: 'lead_' + data.reference }, data.reference);
            purchase(data);
          }
          return data;
        }
        return data || { ok: false, message: 'We could not save your order. Please try again.' };
      });
    }, function () {
      return { ok: false, error: 'NETWORK', message: "We couldn't reach our order system. Please check your connection and try again. Your details are still here." };
    }).finally(function () { if (timer) clearTimeout(timer); });
  }

  // ---------- automatic connection for <form data-skyfly-form> ----------
  var FIELDS = { name: ['name', 'full_name', 'fullname'], phone: ['phone', 'tel', 'whatsapp'], email: ['email'],
    address: ['address', 'delivery_address'], state: ['state'], notes: ['notes', 'note', 'message'] };
  function field(form, names) {
    for (var i = 0; i < names.length; i++) { var el = form.elements[names[i]]; if (el && el.value !== undefined) return String(el.value).trim(); }
    return '';
  }
  function errorBox(form) {
    var box = form.querySelector('[data-skyfly-error]');
    if (!box) {
      box = document.createElement('div');
      box.setAttribute('data-skyfly-error', '');
      box.setAttribute('role', 'alert');
      box.style.cssText = 'background:#FEF2F2;border:1px solid #FCA5A5;color:#B91C1C;padding:10px 12px;border-radius:8px;margin:10px 0;font-size:14px';
      var btn = form.querySelector('[type=submit],button:not([type])');
      btn ? btn.parentNode.insertBefore(box, btn) : form.appendChild(box);
    }
    return box;
  }
  function bind(form) {
    if (form.__skyfly) return;
    form.__skyfly = true;
    form.addEventListener('focusin', function () { track('InitiateCheckout'); });
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      if (form.__busy) return;
      var productEl = form.elements.product;
      var opt = productEl && productEl.options ? productEl.options[productEl.selectedIndex] : null;
      var product = opt ? (opt.getAttribute('data-product') || opt.value) : (productEl ? productEl.value : form.getAttribute('data-product'));
      var displayed = opt && opt.getAttribute('data-price');
      var order = {
        landingPage: form.getAttribute('data-skyfly-form') || pageKey,
        customer: {}, items: [{ product: product, quantity: parseInt(field(form, ['quantity', 'qty']), 10) || 1 }],
        website: field(form, ['website']),
      };
      if (displayed) order.items[0].unitPrice = Number(displayed);
      Object.keys(FIELDS).forEach(function (k) { order.customer[k] = field(form, FIELDS[k]); });
      var btn = form.querySelector('[type=submit],button:not([type])');
      var label = btn && btn.textContent;
      form.__busy = true;
      if (btn) { btn.disabled = true; btn.textContent = form.getAttribute('data-skyfly-busy') || 'Submitting...'; }
      errorBox(form).style.display = 'none';
      submitOrder(order).then(function (res) {
        if (res.ok) {
          var target = form.getAttribute('data-skyfly-redirect');
          setTimeout(function () { location.href = target && target !== 'confirmation' ? target : res.confirmationUrl; }, 300);
          return;
        }
        form.__busy = false;
        if (btn) { btn.disabled = false; btn.textContent = label; }
        var box = errorBox(form);
        var details = res.fields ? Object.keys(res.fields).map(function (k) { return res.fields[k]; }) : [];
        box.textContent = [res.message].concat(details).join(' ');
        box.style.display = 'block';
      });
    });
  }
  function bindAll() { Array.prototype.forEach.call(document.querySelectorAll('form[data-skyfly-form]'), bind); }

  // ---------- drop-in checkout: <div data-skyfly-checkout></div> ----------
  // Package -> quantity -> details -> review -> submit -> confirmation, with prices from Skyfly.
  // The total shown is for the customer only; Skyfly prices the order itself when saving it.
  var CSS = '.sky-co{font:15px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#1f1d2b;max-width:560px;margin:0 auto;min-height:420px}' +
    '.sky-co *{box-sizing:border-box}.sky-co h3{font-size:18px;margin:0 0 12px}.sky-co label{display:block;font-size:13px;font-weight:600;margin:12px 0 4px}' +
    '.sky-co input,.sky-co select,.sky-co textarea{width:100%;font:inherit;padding:11px 12px;border:1px solid #cfcbe0;border-radius:10px;background:#fff;color:inherit}' +
    '.sky-co textarea{min-height:64px}.sky-opt{display:flex;gap:10px;align-items:center;border:1px solid #cfcbe0;border-radius:12px;padding:12px;margin:8px 0;cursor:pointer;font-weight:400}' +
    '.sky-opt input{width:auto;margin:0}.sky-opt b{margin-left:auto;white-space:nowrap}.sky-opt.on{border-color:#7c5cff;background:#f6f3ff}' +
    '.sky-btn{display:block;width:100%;margin-top:16px;padding:14px;border:0;border-radius:12px;background:#7c5cff;color:#fff;font:600 16px system-ui,sans-serif;cursor:pointer}' +
    '.sky-btn[disabled]{opacity:.6;cursor:wait}.sky-link{background:none;border:0;color:#5b3fd6;font:inherit;text-decoration:underline;cursor:pointer;padding:0}' +
    '.sky-total{margin-top:12px;font-size:16px}.sky-err{background:#fef2f2;border:1px solid #fca5a5;color:#b91c1c;padding:10px 12px;border-radius:10px;margin-top:12px}' +
    '.sky-ok{background:#f0fdf4;border:1px solid #86efac;padding:16px;border-radius:12px}.sky-rows div{display:flex;justify-content:space-between;gap:12px;padding:6px 0;border-bottom:1px solid #eee}' +
    '.sky-rows span{color:#6b6880}.sky-muted{color:#6b6880;font-size:13px}.sky-hp{position:absolute;left:-9999px;height:0;overflow:hidden}';
  function esc(v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function money(amount, currency) {
    try { return new Intl.NumberFormat('en-NG', { style: 'currency', currency: currency, maximumFractionDigits: amount % 1 ? 2 : 0 }).format(amount); }
    catch (e) { return currency + ' ' + amount; }
  }
  function checkout(box) {
    if (box.__skyfly) return;
    box.__skyfly = true;
    if (!document.getElementById('sky-co-css')) { var st = document.createElement('style'); st.id = 'sky-co-css'; st.textContent = CSS; document.head.appendChild(st); }
    box.classList.add('sky-co');
    var page = box.getAttribute('data-skyfly-checkout') || pageKey;
    var doneKey = 'skyfly_done_' + page;
    var cat = null; var st8 = { product: box.getAttribute('data-product') || '', qty: 1, c: {} }; var started = false;
    box.innerHTML = '<p class="sky-muted">Loading the order form…</p>';
    function start() { if (!started) { started = true; track('InitiateCheckout'); } }
    function product() { for (var i = 0; i < cat.products.length; i++) if (cat.products[i].code === st8.product) return cat.products[i]; return null; }
    function wa() { return cat.whatsapp ? '<p class="sky-muted" style="margin-top:14px">Questions? <a href="https://wa.me/' + esc(cat.whatsapp) + '" target="_blank" rel="noopener">Chat with us on WhatsApp</a> (optional)</p>' : ''; }
    function showConfirmation(r) {
      box.innerHTML = '<div class="sky-ok" role="status"><h3>Thank you! Your order is confirmed.</h3><div class="sky-rows">' +
        '<div><span>Order reference</span><b data-skyfly-reference>' + esc(r.reference) + '</b></div>' +
        (r.summary ? '<div><span>Order</span><b>' + esc(r.summary) + '</b></div>' : '') +
        '<div><span>Total</span><b>' + esc(money(r.total, r.currency)) + '</b></div></div>' +
        '<p>We will contact you to arrange delivery. Keep your order reference.</p>' +
        (r.confirmationUrl ? '<p><a href="' + esc(r.confirmationUrl) + '" target="_blank" rel="noopener">View your order details</a></p>' : '') +
        '<button type="button" class="sky-link" data-again>Place another order</button></div>' + wa();
      box.querySelector('[data-again]').onclick = function () { store(doneKey, ''); st8.c = {}; render(); };
    }
    function form() {
      var opts = cat.products.map(function (p) {
        return '<label class="sky-opt' + (p.code === st8.product ? ' on' : '') + '"><input type="radio" name="sky_product" value="' + esc(p.code) + '"' + (p.code === st8.product ? ' checked' : '') + '>' +
          esc(p.name) + '<b>' + esc(money(p.price, cat.currency)) + '</b></label>';
      }).join('');
      var q = ''; for (var i = 1; i <= 10; i++) q += '<option' + (i === st8.qty ? ' selected' : '') + '>' + i + '</option>';
      var c = st8.c;
      box.innerHTML = '<form novalidate><h3>' + esc(box.getAttribute('data-title') || 'Place your order') + '</h3>' +
        '<label>Choose your package</label>' + opts +
        '<label for="sky-qty">Quantity</label><select id="sky-qty" name="qty">' + q + '</select>' +
        '<label for="sky-name">Full name *</label><input id="sky-name" name="name" autocomplete="name" value="' + esc(c.name) + '">' +
        '<label for="sky-phone">Phone number *</label><input id="sky-phone" name="phone" type="tel" autocomplete="tel" value="' + esc(c.phone) + '">' +
        '<label for="sky-address">Delivery address *</label><textarea id="sky-address" name="address" autocomplete="street-address">' + esc(c.address) + '</textarea>' +
        '<label for="sky-state">State / city</label><input id="sky-state" name="state" autocomplete="address-level1" value="' + esc(c.state) + '">' +
        '<label for="sky-email">Email (optional)</label><input id="sky-email" name="email" type="email" autocomplete="email" value="' + esc(c.email) + '">' +
        '<label style="font-weight:400"><input type="checkbox" name="consent" style="width:auto"' + (c.marketingConsent ? ' checked' : '') + '> Send me offers by email (optional)</label>' +
        '<label for="sky-notes">Notes (optional)</label><textarea id="sky-notes" name="notes">' + esc(c.notes) + '</textarea>' +
        '<div class="sky-hp" aria-hidden="true"><input name="website" tabindex="-1" autocomplete="off"></div>' +
        '<div class="sky-total" data-total></div><div class="sky-err" data-err hidden role="alert"></div>' +
        '<button class="sky-btn" type="submit">' + esc(box.getAttribute('data-button') || 'Review my order') + '</button></form>' + wa();
      var f = box.querySelector('form');
      function total() {
        var p = product();
        box.querySelector('[data-total]').innerHTML = p ? 'Total: <b>' + esc(money(p.price * st8.qty, cat.currency)) + '</b> <span class="sky-muted">(confirmed by our system when you order)</span>' : '';
      }
      f.addEventListener('focusin', start);
      f.addEventListener('change', function (e) {
        if (e.target.name === 'sky_product') { st8.product = e.target.value; Array.prototype.forEach.call(f.querySelectorAll('.sky-opt'), function (o) { o.classList.toggle('on', o.querySelector('input').checked); }); }
        if (e.target.name === 'qty') st8.qty = parseInt(e.target.value, 10) || 1;
        total();
      });
      total();
      f.addEventListener('submit', function (e) {
        e.preventDefault();
        var v = function (n) { return String(f.elements[n].value || '').trim(); };
        st8.c = { name: v('name'), phone: v('phone'), address: v('address'), state: v('state'), email: v('email'), notes: v('notes'), marketingConsent: f.elements.consent.checked && Boolean(v('email')) };
        st8.website = v('website');
        var missing = [];
        if (!product()) missing.push('choose a package');
        if (!st8.c.name) missing.push('your name');
        if (!st8.c.phone) missing.push('your phone number');
        if (!st8.c.address) missing.push('your delivery address');
        var err = box.querySelector('[data-err]');
        if (missing.length) { err.textContent = 'Please fill in: ' + missing.join(', ') + '.'; err.hidden = false; return; }
        review();
      });
    }
    function review(message) {
      var p = product(); var c = st8.c;
      box.innerHTML = '<h3>Review your order</h3><div class="sky-rows">' +
        '<div><span>Package</span><b>' + esc(p.name) + ' × ' + st8.qty + '</b></div>' +
        '<div><span>Total</span><b>' + esc(money(p.price * st8.qty, cat.currency)) + '</b></div>' +
        '<div><span>Name</span><b>' + esc(c.name) + '</b></div><div><span>Phone</span><b>' + esc(c.phone) + '</b></div>' +
        '<div><span>Deliver to</span><b>' + esc(c.address + (c.state ? ', ' + c.state : '')) + '</b></div>' +
        (c.email ? '<div><span>Email</span><b>' + esc(c.email) + '</b></div>' : '') + '</div>' +
        '<div class="sky-err" data-err' + (message ? '' : ' hidden') + ' role="alert">' + esc(message || '') + '</div>' +
        '<button class="sky-btn" type="button" data-place>' + esc(box.getAttribute('data-place') || 'Place my order') + '</button>' +
        '<p style="text-align:center"><button type="button" class="sky-link" data-edit>Change details</button></p>';
      box.querySelector('[data-edit]').onclick = function () { form(); };
      var btn = box.querySelector('[data-place]');
      btn.onclick = function () {
        if (btn.disabled) return;
        btn.disabled = true; btn.textContent = 'Placing your order…';
        submitOrder({ landingPage: page, customer: st8.c, items: [{ product: st8.product, quantity: st8.qty }], website: st8.website || '' }).then(function (r) {
          // Success only when Skyfly has saved the order and returned its reference.
          if (r && r.ok === true && r.reference) {
            var conf = { reference: r.reference, total: r.total, currency: r.currency, confirmationUrl: r.confirmationUrl, summary: p.name + ' × ' + st8.qty };
            store(doneKey, JSON.stringify(conf));
            showConfirmation(conf);
            return;
          }
          var details = r && r.fields ? Object.keys(r.fields).map(function (k) { return r.fields[k]; }) : [];
          review(['Your order has not been placed yet.', (r && r.message) || 'Please try again.'].concat(details).join(' '));
        });
      };
    }
    function render() {
      var saved = store(doneKey);
      if (saved) { try { return showConfirmation(JSON.parse(saved)); } catch (e) { /* show the form */ } }
      if (!cat.products.length) { box.innerHTML = '<p class="sky-err">Ordering is not available on this page right now.</p>' + wa(); return; }
      if (!product()) st8.product = cat.products[0].code;
      form();
    }
    fetch(api + '/api/public/pages/' + encodeURIComponent(page) + '/catalog')
      .then(function (r) { if (!r.ok) throw new Error('catalog'); return r.json(); })
      .then(function (data) { cat = data; render(); }, function () {
        box.innerHTML = '<p class="sky-err">The order form could not load. Please refresh the page.</p>';
      });
  }
  function bindCheckouts() { Array.prototype.forEach.call(document.querySelectorAll('[data-skyfly-checkout]'), checkout); }

  window.Skyfly = {
    version: '1',
    submitOrder: submitOrder,
    // For custom forms: call when the visitor starts filling in the order form.
    trackInitiateCheckout: function () { track('InitiateCheckout'); },
    // For pages that save orders themselves and already fire Lead for their own pixel code:
    // sends Lead only to the pixels Skyfly loaded, once per order reference.
    // For pages that save orders themselves: call with Skyfly's reply after a successful save.
    // Fires Purchase once per order (never for test orders, never twice on retries or refreshes).
    trackPurchase: function (data) { purchase(data); },
    trackLead: function (value, currency, reference) {
      track('Lead', { data: { value: value, currency: currency }, eventId: 'lead_' + reference }, reference, true);
    },
  };

  function start() {
    bindAll();
    bindCheckouts();
    if (injected) return startPixels(injected);
    if (!pageKey) return;
    fetch(api + '/api/public/pages/' + encodeURIComponent(pageKey) + '/tracking')
      .then(function (r) { return r.ok ? r.json() : { pixels: [] }; })
      .then(startPixels, function () {});
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
