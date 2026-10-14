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
    var m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
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
  function loadMeta(p) {
    if (!window.fbq) {
      /* Meta Pixel base code */
      !function (f, b, e, v, n, t, s) { if (f.fbq) return; n = f.fbq = function () { n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments); };
        if (!f._fbq) f._fbq = n; n.push = n; n.loaded = !0; n.version = '2.0'; n.queue = []; t = b.createElement(e); t.async = !0;
        t.src = v; s = b.getElementsByTagName(e)[0]; s.parentNode.insertBefore(t, s); }(window, document, 'script', 'https://connect.facebook.net/en_US/fbevents.js');
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
          var o = d.createElement('script'); o.type = 'text/javascript'; o.async = !0; o.src = r + '?sdkid=' + e + '&lib=' + t; var a = d.getElementsByTagName('script')[0]; a.parentNode.insertBefore(o, a); };
      }(window, document, 'ttq');
    }
    window.ttq.load(p.id);
  }
  function wants(p, event) { return p.events.indexOf(event) !== -1; }

  // Fires an event once per page view (or once per key, e.g. per order reference).
  function track(event, params, onceKey) {
    var key = event + ':' + (onceKey || '');
    if (fired[key]) return;
    fired[key] = true;
    pixels.forEach(function (p) {
      if (!wants(p, event)) return;
      try {
        if (p.provider === 'meta' && window.fbq) {
          window.fbq('trackSingle', p.id, event, params && params.data || {}, params && params.eventId ? { eventID: params.eventId } : undefined);
        } else if (p.provider === 'tiktok' && window.ttq) {
          var ev = { PageView: null, ViewContent: 'ViewContent', InitiateCheckout: 'InitiateCheckout', Lead: 'SubmitForm' }[event];
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
      pixels.push({ provider: p.provider, id: p.id, events: own ? p.events.filter(function (e) { return e !== 'PageView'; }) : p.events });
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

  // Same details => same key, so retries and double clicks never create a second order.
  function keyFor(order) {
    var text = JSON.stringify([order.landingPage, order.customer, order.items]);
    if (store('skyfly_payload') !== text) { store('skyfly_key', randomId()); store('skyfly_payload', text); }
    return store('skyfly_key');
  }

  // Resolves with { ok: true, reference, confirmationUrl, ... } only after Skyfly has saved the order.
  function submitOrder(order) {
    order = Object.assign({ landingPage: pageKey }, order);
    order.idempotencyKey = keyFor(order);
    order.attribution = Object.assign(attribution(), order.attribution || {});
    var ctrl = window.AbortController ? new AbortController() : null;
    var timer = ctrl && setTimeout(function () { ctrl.abort(); }, 60000);
    return fetch(api + '/api/public/orders', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(order), signal: ctrl && ctrl.signal,
    }).then(function (res) {
      return res.json().catch(function () { return null; }).then(function (data) {
        if (res.ok && data && data.ok) {
          track('Lead', { data: { value: data.total, currency: data.currency }, eventId: 'lead_' + data.reference }, data.reference);
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

  window.Skyfly = {
    version: '1',
    submitOrder: submitOrder,
    // For custom forms: call when the visitor starts filling in the order form.
    trackInitiateCheckout: function () { track('InitiateCheckout'); },
  };

  function start() {
    bindAll();
    if (injected) return startPixels(injected);
    if (!pageKey) return;
    fetch(api + '/api/public/pages/' + encodeURIComponent(pageKey) + '/tracking')
      .then(function (r) { return r.ok ? r.json() : { pixels: [] }; })
      .then(startPixels, function () {});
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
