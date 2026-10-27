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
  function inPage(p) {
    var scripts = document.getElementsByTagName('script');
    for (var i = 0; i < scripts.length; i++) {
      var s = scripts[i];
      if (s.src || s.hasAttribute('data-skyfly-config')) continue; // Skyfly's own config is not the page's pixel code
      var t = s.text;
      // X IDs are short: only the page's own twq('config', '<id>') counts.
      if (p.provider === 'x' ? new RegExp("twq\\(\\s*['\"]config['\"]\\s*,\\s*['\"]" + p.id + "['\"]").test(t) : t.indexOf(p.id) !== -1) return true;
    }
    return false;
  }
  // Ad platform scripts are fetched after the page has loaded (so they never slow down the
  // page's own content); events called before that are queued and sent once they arrive.
  function later(fn) {
    function go() { if (window.requestIdleCallback) requestIdleCallback(fn, { timeout: 2000 }); else setTimeout(fn, 1); }
    if (document.readyState === 'complete') go(); else window.addEventListener('load', go);
  }
  function addScript(src, onload) {
    var t = document.createElement('script'); t.async = true; t.src = src;
    if (onload) t.onload = onload;
    var s = document.getElementsByTagName('script')[0]; s ? s.parentNode.insertBefore(t, s) : document.head.appendChild(t);
  }
  // Which platforms' official scripts actually loaded on this page (for "Browser tag loaded").
  var loadedScripts = {};
  function scriptLoaded(provider) { return function () { loadedScripts[provider] = true; reportSeen(); debugShow(); }; }
  // When the page's own code already set up a platform (e.g. its own Meta Pixel), Skyfly adds no
  // second copy of the script, so it checks that the official script is running instead.
  var adding = {};
  function resourceLoaded(re) {
    try { return performance.getEntriesByType('resource').some(function (e) { return re.test(e.name); }); } catch (e) { return false; }
  }
  var RUNNING = {
    meta: function () { return typeof (window.fbq && window.fbq.callMethod) === 'function' || resourceLoaded(/^https:\/\/connect\.facebook\.net\/[^?#]*\/fbevents\.js/); },
    tiktok: function () { return resourceLoaded(/^https:\/\/analytics\.tiktok\.com\/i18n\/pixel\/events\.js/); },
    x: function () { return typeof (window.twq && window.twq.exe) === 'function' || resourceLoaded(/^https:\/\/static\.ads-twitter\.com\/uwt\.js/); },
  };
  function watchRunning(provider) {
    later(function () {
      var tries = 0;
      (function check() {
        if (loadedScripts[provider]) return;
        if (RUNNING[provider]()) return scriptLoaded(provider)();
        if ((tries += 1) < 40) setTimeout(check, 500); // up to 20 s after the page has loaded
      })();
    });
  }
  function loadMeta(p) {
    if (!window.fbq) {
      adding.meta = true;
      /* Meta Pixel base code (queue now, script after load) */
      var n = window.fbq = function () { n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments); };
      if (!window._fbq) window._fbq = n; n.push = n; n.loaded = true; n.version = '2.0'; n.queue = [];
      later(function () { addScript('https://connect.facebook.net/en_US/fbevents.js', scriptLoaded('meta')); });
    }
    window.fbq('init', p.id);
  }
  function loadTikTok(p) {
    if (!window.ttq) {
      adding.tiktok = true;
      /* TikTok Pixel base code */
      !function (w, d, t) { w.TiktokAnalyticsObject = t; var ttq = w[t] = w[t] || []; ttq.methods = ['page', 'track', 'identify', 'instances', 'debug', 'on', 'off', 'once', 'ready', 'alias', 'group', 'enableCookie', 'disableCookie', 'holdConsent', 'revokeConsent', 'grantConsent'];
        ttq.setAndDefer = function (t, e) { t[e] = function () { t.push([e].concat(Array.prototype.slice.call(arguments, 0))); }; };
        for (var i = 0; i < ttq.methods.length; i++) ttq.setAndDefer(ttq, ttq.methods[i]);
        ttq.instance = function (t) { for (var e = ttq._i[t] || [], n = 0; n < ttq.methods.length; n++) ttq.setAndDefer(e, ttq.methods[n]); return e; };
        ttq.load = function (e, n) { var r = 'https://analytics.tiktok.com/i18n/pixel/events.js'; ttq._i = ttq._i || {}; ttq._i[e] = []; ttq._i[e]._u = r; ttq._t = ttq._t || {}; ttq._t[e] = +new Date(); ttq._o = ttq._o || {}; ttq._o[e] = n || {};
          later(function () { addScript(r + '?sdkid=' + e + '&lib=' + t, scriptLoaded('tiktok')); }); };
      }(window, document, 'ttq');
    }
    window.ttq.load(p.id);
  }
  function loadX(p) {
    if (!window.twq) {
      adding.x = true;
      /* X (Twitter) website tag base code: queue now, uwt.js after load */
      var s = window.twq = function () { s.exe ? s.exe.apply(s, arguments) : s.queue.push(arguments); };
      s.version = '1.1'; s.queue = [];
      later(function () { addScript('https://static.ads-twitter.com/uwt.js', scriptLoaded('x')); });
    }
    window.twq('config', p.id); // records the page view for this pixel
  }
  var LOADERS = { meta: loadMeta, tiktok: loadTikTok, x: loadX };
  function wants(p, event) { return p.events.indexOf(event) !== -1; }

  // Fires an event once per page view (or once per key, e.g. per order reference), to every tracking
  // ID on the page that wants it, in each platform's own way.
  function track(event, params, onceKey, skipOwn) {
    var key = event + ':' + (onceKey || '');
    if (fired[key]) return;
    fired[key] = true;
    var data = params && params.data || {};
    var eventId = params && params.eventId;
    pixels.forEach(function (p) {
      if (!wants(p, event) || (skipOwn && p.own)) return;
      try {
        if (p.provider === 'meta' && window.fbq) {
          window.fbq('trackSingle', p.id, event, data, eventId ? { eventID: eventId } : undefined);
          debugLog(p, event);
        } else if (p.provider === 'tiktok' && window.ttq) {
          var ev = { PageView: null, ViewContent: 'ViewContent', InitiateCheckout: 'InitiateCheckout', Lead: 'SubmitForm', Purchase: p.purchaseEvent || 'CompletePayment' }[event];
          var inst = window.ttq.instance(p.id);
          if (event === 'PageView') inst.page();
          else if (ev) inst.track(ev, data, eventId ? { event_id: eventId } : undefined);
          debugLog(p, ev || 'PageView');
        } else if (p.provider === 'x' && window.twq) {
          // PageView is recorded by twq('config'); other events need their X event ID.
          if (event === 'PageView') { debugLog(p, 'PageView'); return; }
          var eid = p.eventIds && p.eventIds[event];
          if (!eid) return;
          var xp = {};
          if (data.value !== undefined) { xp.value = data.value; xp.currency = data.currency; }
          // conversion_id lets X count a purchase once (same as the order reference).
          if (event === 'Purchase' && eventId) xp.conversion_id = eventId;
          window.twq('event', 'tw-' + p.id + '-' + eid, xp);
          debugLog(p, event);
        }
      } catch (e) { /* tracking must never break the page */ }
    });
  }

  // "Browser tag loaded": tells Skyfly once per page view which tracking IDs' scripts loaded here.
  var seenSent = {};
  var seenTimer = null;
  function reportSeen() {
    clearTimeout(seenTimer);
    seenTimer = setTimeout(function () {
      var list = pixels.filter(function (p) { return loadedScripts[p.provider] && !seenSent[p.provider + p.id]; });
      if (!list.length || !pageKey || !api) return;
      list.forEach(function (p) { seenSent[p.provider + p.id] = true; });
      var body = JSON.stringify({ page: pageKey, pixels: list.map(function (p) { return { provider: p.provider, id: p.id }; }) });
      try { if (navigator.sendBeacon && navigator.sendBeacon(api + '/api/public/pixels-seen', new Blob([body], { type: 'text/plain' }))) return; } catch (e) { /* fall back */ }
      fetch(api + '/api/public/pixels-seen', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: body, keepalive: true }).catch(function () {});
    }, 1500);
  }

  // ?skyfly_debug=1: a small panel listing every tracking ID on this page and the events sent to it,
  // so the owner can check a page without browser extensions. Shows nothing otherwise.
  var debugOn = /[?&]skyfly_debug=1\b/.test(location.search);
  var debugEvents = {};
  function debugLog(p, name) { if (!debugOn) return; var k = p.provider + ':' + p.id; (debugEvents[k] = debugEvents[k] || []).push(name); debugShow(); }
  function debugShow() {
    if (!debugOn || !document.body) return;
    var box = document.getElementById('skyfly-debug');
    if (!box) { box = document.createElement('div'); box.id = 'skyfly-debug'; box.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:2147483647;max-width:360px;max-height:50vh;overflow:auto;background:#111;color:#fff;font:12px/1.4 monospace;padding:8px 10px;border-radius:8px;opacity:.92'; document.body.appendChild(box); }
    box.textContent = '';
    var h = document.createElement('div'); h.style.fontWeight = 'bold'; h.textContent = 'Skyfly tracking (' + pixels.length + ' IDs)'; box.appendChild(h);
    pixels.forEach(function (p) {
      var row = document.createElement('div');
      row.setAttribute('data-skyfly-debug-pixel', p.provider + ':' + p.id);
      row.textContent = p.provider + ' ' + p.id + (p.own ? ' (page\'s own code)' : '') + ' · script ' + (p.own || loadedScripts[p.provider] ? 'loaded' : 'loading…') + ' · ' + ((debugEvents[p.provider + ':' + p.id] || []).join(', ') || 'no events yet');
      box.appendChild(row);
    });
  }

  function startPixels(config) {
    var seen = {};
    (config.pixels || []).forEach(function (p) {
      if (!LOADERS[p.provider] || seen[p.provider + p.id]) return; // each ID once per page
      seen[p.provider + p.id] = true;
      var own = inPage(p); // the page already loads this pixel and fires its own PageView
      try {
        if (!own) LOADERS[p.provider](p);
      } catch (e) { return; }
      pixels.push({ provider: p.provider, id: p.id, own: own, purchaseEvent: p.purchaseEvent, eventIds: p.eventIds || {},
        events: own ? p.events.filter(function (e) { return e !== 'PageView'; }) : p.events });
    });
    var watched = {};
    pixels.forEach(function (p) { if (!adding[p.provider] && !watched[p.provider]) { watched[p.provider] = true; watchRunning(p.provider); } });
    track('PageView');
    track('ViewContent');
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', debugShow); else debugShow();
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

  // ---------- checkout progress (abandoned checkouts) ----------
  // What the customer chooses and types is kept as they go: on this device (the chosen products for
  // 7 days; name, phone, address… only for this browser session) and in Skyfly, so a refresh or a lost
  // connection loses nothing and the business can see checkouts that were started but not finished.
  // Nothing about payment is ever collected. Saving never blocks or slows the order form.
  function local(k, v) {
    try { if (v === undefined) return localStorage.getItem(k); if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); }
    catch (e) { return v === undefined ? store(k) : store(k, v === null ? '' : v); }
  }
  function readJson(text) { try { return JSON.parse(text || 'null'); } catch (e) { return null; } }
  var CO_DAYS = 7;
  var sessions = {}; // per page: { token, seq, last, dirty, timer, retry }
  function session(page) {
    var c = sessions[page];
    if (c) return c;
    c = sessions[page] = { seq: 0 };
    var saved = readJson(local('skyfly_co_' + page));
    if (saved && saved.t && Date.now() - saved.at < CO_DAYS * 864e5) { c.token = saved.t; c.seq = saved.seq || 0; c.items = saved.items || []; c.step = saved.step; }
    return c;
  }
  function remember(page) {
    var c = sessions[page];
    local('skyfly_co_' + page, JSON.stringify({ t: c.token, at: Date.now(), seq: c.seq, items: (c.last && c.last.items) || c.items || [], step: c.last && c.last.step }));
  }
  // Called whenever the customer changes something: { customer, items, step }.
  function saveProgress(page, data) {
    if (!page || !data || !window.JSON) return;
    var c = session(page);
    if (!c.token) c.token = randomId();
    c.last = data; c.dirty = true;
    remember(page);
    store('skyfly_co_d_' + page, JSON.stringify(data.customer || {}));
    clearTimeout(c.timer);
    c.timer = setTimeout(function () { flush(page); }, 1200);
  }
  function body(page) {
    var c = sessions[page];
    c.seq += 1; remember(page);
    return JSON.stringify({ token: c.token, seq: c.seq, landingPage: page, step: c.last.step || 'started', customer: c.last.customer || {}, items: c.last.items || [], attribution: attribution() });
  }
  function flush(page, closing) {
    var c = sessions[page];
    if (!c || !c.dirty || !c.last || !api) return;
    clearTimeout(c.timer); clearTimeout(c.retry);
    var text = body(page);
    c.dirty = false;
    // The page is being closed: the browser sends this even as it leaves.
    if (closing && navigator.sendBeacon) { try { if (navigator.sendBeacon(api + '/api/public/checkouts', new Blob([text], { type: 'text/plain' }))) return; } catch (e) { /* fall back to fetch */ } }
    fetch(api + '/api/public/checkouts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: text, keepalive: true })
      .then(function (r) { return r.json(); })
      .then(function (r) { if (r && r.ended) restart(page); }, function () {
        // Offline or the server could not be reached: try again shortly and when the connection is back.
        c.dirty = true; c.retry = setTimeout(function () { flush(page); }, 15000);
      });
  }
  // After an order (or when the session ended elsewhere): the next checkout is a new session.
  function restart(page) {
    var c = sessions[page];
    if (c) { clearTimeout(c.timer); clearTimeout(c.retry); }
    sessions[page] = { seq: 0 };
    local('skyfly_co_' + page, null);
    store('skyfly_co_d_' + page, '');
  }
  function flushAll(closing) { Object.keys(sessions).forEach(function (p) { flush(p, closing); }); }
  window.addEventListener('pagehide', function () { flushAll(true); });
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'hidden') flushAll(true); });
  window.addEventListener('online', function () { flushAll(false); });
  // What was saved for this page on this device: { items, step, customer } (empty when nothing).
  function savedProgress(page) {
    var c = session(page);
    return { items: (c.last && c.last.items) || c.items || [], step: c.step, customer: readJson(store('skyfly_co_d_' + page)) || {} };
  }
  // A resume link (?skyfly_checkout=<id>, e.g. sent by the business on WhatsApp) continues that
  // session on this device: its chosen products come back (never personal details).
  function resumeFromLink(page) {
    var id = new URLSearchParams(location.search).get('skyfly_checkout');
    if (!id || !/^[A-Za-z0-9_-]{16,100}$/.test(id) || !api) return Promise.resolve(null);
    return fetch(api + '/api/public/checkouts/' + encodeURIComponent(id)).then(function (r) { return r.ok ? r.json() : null; }).then(function (r) {
      if (!r || !r.ok || (r.landingPage && r.landingPage !== page)) return null;
      var c = session(page); c.token = id; c.items = r.items || []; c.step = r.step; c.last = null;
      remember(page);
      return r;
    }, function () { return null; });
  }

  // Resolves with { ok: true, reference, confirmationUrl, ... } only after Skyfly has saved the order.
  var attempted = {};
  function submitOrder(order) {
    order = Object.assign({ landingPage: pageKey }, order);
    order.idempotencyKey = keyFor(order);
    // The checkout session this order completes (so it is not shown as abandoned).
    var co = sessions[order.landingPage] || session(order.landingPage);
    if (co.token) { order.checkoutId = co.token; clearTimeout(co.timer); }
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
          restart(order.landingPage);
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
  // Fields marked by Skyfly's import adapter (data-skyfly-field="name"…) come first; then common names.
  function marked(form, key) { return form.querySelectorAll('[data-skyfly-field="' + key + '"]'); }
  function field(form, names) {
    var m = marked(form, names[0]);
    if (m.length) return Array.prototype.map.call(m, function (el) { return String(el.value || '').trim(); }).filter(Boolean).join(' ');
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
  function formPage(form) { return form.getAttribute('data-skyfly-form') || pageKey; }
  // What the form holds now (the order it would send).
  function gather(form) {
    var productEl = marked(form, 'product')[0] || form.elements.product;
    var opt = productEl && productEl.options ? productEl.options[productEl.selectedIndex] : null;
    var product = opt ? (opt.getAttribute('data-product') || opt.value) : (productEl ? productEl.value : form.getAttribute('data-product'));
    var displayed = opt && opt.getAttribute('data-price');
    var order = {
      landingPage: formPage(form),
      customer: {}, items: [{ product: product, quantity: parseInt(field(form, ['quantity', 'qty']), 10) || 1 }],
      website: form.elements.website ? String(form.elements.website.value || '') : '',
    };
    if (displayed) order.items[0].unitPrice = Number(displayed);
    // The product's options chosen on the page (size, colour…): Skyfly checks and prices them.
    var chosen = {}; var anyChoice = false;
    Array.prototype.forEach.call(form.querySelectorAll('select[data-skyfly-option]'), function (sel) {
      var o = sel.options[sel.selectedIndex];
      var v = o ? (o.getAttribute('data-option-value') || '') : '';
      if (v) { chosen[sel.getAttribute('data-skyfly-option')] = v; anyChoice = true; }
    });
    if (anyChoice) order.items[0].options = chosen;
    Object.keys(FIELDS).forEach(function (k) { order.customer[k] = field(form, FIELDS[k]); });
    return order;
  }
  function progressOf(form) {
    var o = gather(form);
    var typed = ['name', 'phone', 'email', 'address'].some(function (k) { return o.customer[k]; });
    return { customer: o.customer, items: o.items[0].product ? o.items : [], step: typed ? 'details' : 'started' };
  }
  // Puts back what this customer typed earlier in this browser session (after a refresh), without
  // overwriting anything already in the form.
  function restoreForm(form) {
    var saved = savedProgress(formPage(form));
    Object.keys(FIELDS).forEach(function (k) {
      var v = saved.customer[k];
      if (!v) return;
      var el = marked(form, FIELDS[k][0])[0];
      for (var i = 0; !el && i < FIELDS[k].length; i++) el = form.elements[FIELDS[k][i]];
      if (el && el.value !== undefined && !el.value && el.tagName !== 'SELECT') el.value = v;
    });
    var first = saved.items[0];
    var sel = marked(form, 'product')[0] || form.elements.product;
    if (first && sel && sel.options) for (var j = 0; j < sel.options.length; j++) if ((sel.options[j].getAttribute('data-product') || sel.options[j].value) === first.product) sel.selectedIndex = j;
  }
  function bind(form) {
    if (form.__skyfly) return;
    form.__skyfly = true;
    try { restoreForm(form); } catch (e) { /* never break the form */ }
    form.addEventListener('focusin', function () { track('InitiateCheckout'); });
    var changed = function () { try { saveProgress(formPage(form), progressOf(form)); } catch (e) { /* never break the form */ } };
    form.addEventListener('input', changed);
    form.addEventListener('change', changed);
    // Imported forms (data-skyfly-exclusive) are handled in the capture phase (see below), so the
    // page's own scripts can't also send the order to WhatsApp or another service.
    if (!form.hasAttribute('data-skyfly-exclusive')) form.addEventListener('submit', function (e) { e.preventDefault(); send(form); });
  }
  function send(form) {
      if (form.__busy) return;
      var order = gather(form);
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
  }
  function bindAll() { Array.prototype.forEach.call(document.querySelectorAll('form[data-skyfly-form]'), bind); }

  // Capture phase: runs before the page's own handlers (inline onclick/onsubmit included).
  // - an imported order form's submit: Skyfly saves the order; the page's code doesn't run.
  // - its submit button: the page's click code (e.g. "open WhatsApp") doesn't run; the form submits.
  // - a purchase button (data-skyfly-buy): opens Skyfly's order form, with its product chosen.
  document.addEventListener('submit', function (e) {
    var form = e.target;
    if (!form || !form.matches || !form.matches('form[data-skyfly-form][data-skyfly-exclusive]')) return;
    e.preventDefault(); e.stopImmediatePropagation();
    bind(form); send(form);
  }, true);
  document.addEventListener('click', function (e) {
    var el = e.target && e.target.closest ? e.target.closest('[data-skyfly-submit],[data-skyfly-buy]') : null;
    if (!el) return;
    if (el.hasAttribute('data-skyfly-submit')) {
      var form = el.closest('form[data-skyfly-exclusive]');
      if (form) e.stopImmediatePropagation(); // the browser still submits the form (default action)
      return;
    }
    e.preventDefault(); e.stopImmediatePropagation();
    choose(el.getAttribute('data-product'), (el.getAttribute('href') || '').charAt(0) === '#' ? el.getAttribute('href').slice(1) : '');
  }, true);
  function choose(code, targetId) {
    var target = (targetId && document.getElementById(targetId)) || document.querySelector('form[data-skyfly-form],[data-skyfly-checkout]');
    if (!target) return;
    track('InitiateCheckout');
    if (code) {
      var co = target.matches('[data-skyfly-checkout]') ? target : target.querySelector('[data-skyfly-checkout]');
      if (co && co.__skyflySelect) co.__skyflySelect(code);
      var sel = target.matches('form') ? marked(target, 'product')[0] || target.elements.product : null;
      if (sel && sel.options) {
        for (var i = 0; i < sel.options.length; i++) if (sel.options[i].getAttribute('data-product') === code) { sel.selectedIndex = i; sel.dispatchEvent(new Event('change', { bubbles: true })); }
      } else if (target.matches('form')) target.setAttribute('data-product', code);
    }
    if (target.scrollIntoView) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    var first = target.querySelector('input:not([type=hidden]),select,textarea');
    if (first && first.focus) setTimeout(function () { try { first.focus({ preventScroll: true }); } catch (x) { /* older browsers */ } }, 400);
  }

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
    var cat = null; var st8 = { product: box.getAttribute('data-product') || '', qty: 1, c: {}, addon: false, opts: {} }; var started = false;
    box.innerHTML = '<p class="sky-muted">Loading the order form…</p>';
    function start() { if (!started) { started = true; track('InitiateCheckout'); } }
    var reviewing = false;
    // Saves what the customer has chosen and typed so far (see saveProgress).
    function progress() {
      if (!cat || !product()) return;
      var items = [{ product: st8.product, quantity: st8.qty }];
      if (groups().length) { items[0].options = {}; groups().forEach(function (g) { items[0].options[g.name] = choice(g).label; }); }
      if (addon()) items.push({ product: addon().code, quantity: 1, upsell: true });
      var c = st8.c;
      var typed = ['name', 'phone', 'email', 'address'].some(function (k) { return c[k]; });
      saveProgress(page, { customer: { name: c.name || '', phone: c.phone || '', email: c.email || '', address: c.address || '', state: c.state || '', notes: c.notes || '', marketingConsent: Boolean(c.marketingConsent) },
        items: items, step: reviewing ? 'review' : typed ? 'details' : 'started' });
    }
    function restoreProgress() {
      var saved = savedProgress(page);
      var main = null; var hasAddon = false;
      saved.items.forEach(function (i) { if (i.upsell) hasAddon = true; else if (!main) main = i; });
      if (main && cat.products.some(function (p) { return p.code === main.product; })) {
        st8.product = main.product; st8.qty = Math.max(1, Math.min(10, main.quantity || 1)); st8.opts = main.options || {};
      }
      st8.addon = hasAddon && Boolean(cat.upsell);
      ['name', 'phone', 'address', 'state', 'email', 'notes'].forEach(function (n) { if (saved.customer[n] && !st8.c[n]) st8.c[n] = saved.customer[n]; });
      if (saved.customer.marketingConsent) st8.c.marketingConsent = true;
    }
    function product() { for (var i = 0; i < cat.products.length; i++) if (cat.products[i].code === st8.product) return cat.products[i]; return null; }
    function wa() { return cat.whatsapp ? '<p class="sky-muted" style="margin-top:14px">Questions? <a href="https://wa.me/' + esc(cat.whatsapp) + '" target="_blank" rel="noopener">Chat with us on WhatsApp</a> (optional)</p>' : ''; }
    // The page's optional add-on, when the customer has added it.
    function addon() { return st8.addon && cat.upsell ? cat.upsell : null; }
    // Options of the chosen product: each group's chosen value (the first one until the customer picks).
    function groups() { var p = product(); return (p && p.options) || []; }
    function choice(g) { var v = st8.opts[g.name]; for (var i = 0; i < g.values.length; i++) if (g.values[i].label === v) return g.values[i]; return g.values[0]; }
    function unit() { var p = product(); if (!p) return 0; return Math.max(0, p.price + groups().reduce(function (n, g) { return n + (choice(g).delta || 0); }, 0)); }
    function optionText() { return groups().map(function (g) { return g.name + ': ' + choice(g).label; }).join(', '); }
    function subtotal() { return product() ? unit() * st8.qty + (addon() ? addon().price : 0) : 0; }
    // Delivery as the business set it (Skyfly charges it again when saving the order).
    function delivery() { var d = cat.delivery || {}; var sub = subtotal(); if (!d.fee || (d.freeFrom !== null && d.freeFrom !== undefined && sub >= d.freeFrom)) return 0; return d.fee; }
    function sum() { return product() ? subtotal() + delivery() : 0; }
    function showConfirmation(r) {
      // Shown only for Skyfly's reply for a saved order; WhatsApp is optional (the order is already saved).
      box.innerHTML = '<div class="sky-ok" role="status"><h3>Thank you! We have received your order.</h3><div class="sky-rows">' +
        '<div><span>Order reference</span><b data-skyfly-reference>' + esc(r.reference) + '</b></div>' +
        (r.summary ? '<div><span>Order</span><b>' + esc(r.summary) + '</b></div>' : '') +
        (r.deliveryFee ? '<div><span>Delivery</span><b>' + esc(money(r.deliveryFee, r.currency)) + '</b></div>' : '') +
        '<div><span>Total</span><b data-skyfly-total>' + esc(money(r.total, r.currency)) + '</b></div></div>' +
        '<p>Our team will contact you shortly to confirm the details and delivery.' + (r.whatsappUrl ? ' You can speak with our representative on WhatsApp using the button below.' : '') + ' Please keep your order reference for follow-up.</p>' +
        (r.whatsappUrl ? '<a class="sky-btn" style="background:#25d366;text-align:center;text-decoration:none" data-skyfly-whatsapp href="' + esc(r.whatsappUrl) + '" target="_blank" rel="noopener">Chat with us on WhatsApp</a>' : '') +
        (r.confirmationUrl ? '<p><a href="' + esc(r.confirmationUrl) + '" target="_blank" rel="noopener">View your order details</a></p>' : '') +
        '<button type="button" class="sky-link" data-again>Place another order</button></div>';
      box.querySelector('[data-again]').onclick = function () { store(doneKey, ''); st8.c = {}; st8.addon = false; render(); };
    }
    function upsellBox() {
      var u = cat.upsell;
      if (!u) return '';
      return '<div class="sky-up" data-skyfly-upsell style="border:2px dashed #7c5cff;border-radius:12px;padding:12px;margin-top:14px;background:#f6f3ff">' +
        '<b>' + esc(u.headline) + '</b>' + (u.text ? '<p class="sky-muted" style="margin:6px 0">' + esc(u.text) + '</p>' : '') +
        '<div style="display:flex;align-items:center;gap:10px;margin-top:8px"><span>' + esc(u.name) + ' · <b>' + esc(money(u.price, cat.currency)) + '</b></span>' +
        '<button type="button" class="sky-btn" data-addon style="width:auto;margin:0 0 0 auto;padding:10px 16px">' + (st8.addon ? 'Added ✓ (remove)' : 'Add') + '</button></div></div>';
    }
    function form() {
      var opts = cat.products.map(function (p) {
        return '<label class="sky-opt' + (p.code === st8.product ? ' on' : '') + '"><input type="radio" name="sky_product" value="' + esc(p.code) + '"' + (p.code === st8.product ? ' checked' : '') + '>' +
          '<span>' + esc(p.name) + (p.description ? '<br><span class="sky-muted">' + esc(p.description) + '</span>' : '') + '</span>' +
          '<b>' + (p.compareAt ? '<s class="sky-muted" style="font-weight:400">' + esc(money(p.compareAt, cat.currency)) + '</s> ' : '') + esc(money(p.price, cat.currency)) + '</b></label>';
      }).join('');
      var optHtml = groups().map(function (g, gi) {
        return '<label for="sky-o' + gi + '">' + esc(g.name) + '</label><select id="sky-o' + gi + '" name="sky_opt" data-group="' + esc(g.name) + '">' +
          g.values.map(function (v) { return '<option' + (choice(g).label === v.label ? ' selected' : '') + ' value="' + esc(v.label) + '">' + esc(v.label) + (v.delta ? ' (' + (v.delta > 0 ? '+' : '−') + esc(money(Math.abs(v.delta), cat.currency)) + ')' : '') + '</option>'; }).join('') + '</select>';
      }).join('');
      var q = ''; for (var i = 1; i <= 10; i++) q += '<option' + (i === st8.qty ? ' selected' : '') + '>' + i + '</option>';
      var c = st8.c;
      box.innerHTML = '<form novalidate><h3>' + esc(box.getAttribute('data-title') || 'Place your order') + '</h3>' +
        '<label>Choose your package</label>' + opts + optHtml +
        '<label for="sky-qty">Quantity</label><select id="sky-qty" name="qty">' + q + '</select>' +
        '<label for="sky-name">Full name *</label><input id="sky-name" name="name" autocomplete="name" value="' + esc(c.name) + '">' +
        '<label for="sky-phone">Phone number *</label><input id="sky-phone" name="phone" type="tel" autocomplete="tel" value="' + esc(c.phone) + '">' +
        '<label for="sky-address">Delivery address *</label><textarea id="sky-address" name="address" autocomplete="street-address">' + esc(c.address) + '</textarea>' +
        '<label for="sky-state">State / city</label><input id="sky-state" name="state" autocomplete="address-level1" value="' + esc(c.state) + '">' +
        '<label for="sky-email">Email (optional)</label><input id="sky-email" name="email" type="email" autocomplete="email" value="' + esc(c.email) + '">' +
        '<label style="font-weight:400"><input type="checkbox" name="consent" style="width:auto"' + (c.marketingConsent ? ' checked' : '') + '> Send me offers by email (optional)</label>' +
        '<label for="sky-notes">Notes (optional)</label><textarea id="sky-notes" name="notes">' + esc(c.notes) + '</textarea>' +
        '<div class="sky-hp" aria-hidden="true"><input name="website" tabindex="-1" autocomplete="off"></div>' +
        upsellBox() +
        '<div class="sky-total" data-total></div><div class="sky-err" data-err hidden role="alert"></div>' +
        '<button class="sky-btn" type="submit">' + esc(box.getAttribute('data-button') || 'Review my order') + '</button></form>' + wa();
      var f = box.querySelector('form');
      function total() {
        var p = product();
        box.querySelector('[data-total]').innerHTML = p ? '<div class="sky-muted">' + esc(p.name) + (optionText() ? ' (' + esc(optionText()) + ')' : '') + ' × ' + st8.qty + (addon() ? ' + ' + esc(addon().name) : '') + '</div>' +
          (cat.delivery && cat.delivery.fee ? '<div class="sky-muted">Delivery: ' + (delivery() ? esc(money(delivery(), cat.currency)) : 'free') + '</div>' : '') +
          'Total: <b data-skyfly-total>' + esc(money(sum(), cat.currency)) + '</b> <span class="sky-muted">(confirmed by our system when you order)</span>' : '';
      }
      var addBtn = box.querySelector('[data-addon]');
      if (addBtn) addBtn.onclick = function () { st8.addon = !st8.addon; addBtn.textContent = st8.addon ? 'Added ✓ (remove)' : 'Add'; total(); progress(); };
      f.addEventListener('focusin', start);
      // Typing: keep the details (for a refresh) and save the progress.
      f.addEventListener('input', function (e) {
        if (['name', 'phone', 'address', 'state', 'email', 'notes'].indexOf(e.target.name) === -1) return;
        st8.c[e.target.name] = String(e.target.value || '');
        progress();
      });
      f.addEventListener('change', function (e) {
        if (e.target.name === 'sky_product') { st8.product = e.target.value; Array.prototype.forEach.call(f.querySelectorAll('.sky-opt'), function (o) { o.classList.toggle('on', o.querySelector('input').checked); }); }
        if (e.target.name === 'qty') st8.qty = parseInt(e.target.value, 10) || 1;
        if (e.target.name === 'sky_opt') st8.opts[e.target.getAttribute('data-group')] = e.target.value;
        // A different package has its own options: show them.
        if (e.target.name === 'sky_product' && cat.products.some(function (x) { return x.options; })) {
          // Keep what the customer typed, then show the new package's options.
          ['name', 'phone', 'address', 'state', 'email', 'notes'].forEach(function (n) { st8.c[n] = String(f.elements[n].value || ''); });
          st8.opts = {}; form(); return progress();
        }
        if (e.target.name === 'sky_product') st8.opts = {};
        if (e.target.name === 'consent') st8.c.marketingConsent = e.target.checked;
        total();
        progress();
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
      reviewing = true; progress();
      box.innerHTML = '<h3>Review your order</h3><div class="sky-rows">' +
        '<div><span>Package</span><b>' + esc(p.name) + ' × ' + st8.qty + '</b></div>' +
        (optionText() ? '<div><span>Options</span><b>' + esc(optionText()) + '</b></div>' : '') +
        (cat.delivery && cat.delivery.fee ? '<div><span>Delivery</span><b>' + (delivery() ? esc(money(delivery(), cat.currency)) : 'Free') + '</b></div>' : '') +
        (addon() ? '<div><span>Add-on</span><b>' + esc(addon().name) + ' (' + esc(money(addon().price, cat.currency)) + ')</b></div>' : '') +
        '<div><span>Total</span><b>' + esc(money(sum(), cat.currency)) + '</b></div>' +
        '<div><span>Name</span><b>' + esc(c.name) + '</b></div><div><span>Phone</span><b>' + esc(c.phone) + '</b></div>' +
        '<div><span>Deliver to</span><b>' + esc(c.address + (c.state ? ', ' + c.state : '')) + '</b></div>' +
        (c.email ? '<div><span>Email</span><b>' + esc(c.email) + '</b></div>' : '') + '</div>' +
        '<div class="sky-err" data-err' + (message ? '' : ' hidden') + ' role="alert">' + esc(message || '') + '</div>' +
        '<button class="sky-btn" type="button" data-place>' + esc(box.getAttribute('data-place') || 'Place my order') + '</button>' +
        '<p style="text-align:center"><button type="button" class="sky-link" data-edit>Change details</button></p>';
      box.querySelector('[data-edit]').onclick = function () { reviewing = false; form(); };
      var btn = box.querySelector('[data-place]');
      btn.onclick = function () {
        if (btn.disabled) return;
        btn.disabled = true; btn.textContent = 'Placing your order…';
        var items = [{ product: st8.product, quantity: st8.qty }];
        if (groups().length) { items[0].options = {}; groups().forEach(function (g) { items[0].options[g.name] = choice(g).label; }); }
        if (addon()) items.push({ product: addon().code, quantity: 1, upsell: true });
        submitOrder({ landingPage: page, customer: st8.c, items: items, website: st8.website || '' }).then(function (r) {
          // Success only when Skyfly has saved the order and returned its reference.
          if (r && r.ok === true && r.reference) {
            // The summary and total are Skyfly's (what was saved and priced), not the browser's.
            var saved = (r.items || []).map(function (i) { return i.name + ' × ' + i.quantity + (i.upsell ? ' (add-on)' : ''); }).join(', ');
            var conf = { reference: r.reference, total: r.total, deliveryFee: r.deliveryFee || 0, currency: r.currency, confirmationUrl: r.confirmationUrl, whatsappUrl: r.whatsappUrl, summary: saved || p.name + ' × ' + st8.qty };
            store(doneKey, JSON.stringify(conf));
            showConfirmation(conf);
            return;
          }
          var details = r && r.fields ? Object.keys(r.fields).map(function (k) { return r.fields[k]; }) : [];
          review(['Your order has not been placed yet.', (r && r.message) || 'Please try again.'].concat(details).join(' '));
        });
      };
    }
    // A purchase button elsewhere on the page chose a product.
    box.__skyflySelect = function (code) { st8.product = code; if (cat && cat.destination === 'whatsapp') return whatsappOnly(); if (cat && !store(doneKey)) form(); };
    // "WhatsApp direct" pages: the button opens a WhatsApp conversation with the chosen package.
    // Nothing is ordered in Skyfly (and no Lead or Purchase is counted): the order is agreed in the chat.
    function whatsappOnly() {
      if (!cat.whatsapp || !cat.products.length) { box.innerHTML = '<p class="sky-err">Ordering is not available on this page right now.</p>'; return; }
      box.innerHTML = '<h3>Order on WhatsApp</h3><label>Package<select data-wa-product>' + cat.products.map(function (p) {
        return '<option value="' + esc(p.code) + '"' + (p.code === st8.product ? ' selected' : '') + '>' + esc(p.name) + ' — ' + esc(money(p.price, cat.currency)) + '</option>';
      }).join('') + '</select></label><label>Quantity<input data-wa-qty type="number" min="1" max="99" value="1" inputmode="numeric"></label>' +
        '<a class="sky-btn" style="background:#25d366;text-align:center;text-decoration:none" data-skyfly-whatsapp-direct target="_blank" rel="noopener">Chat on WhatsApp to order</a>' +
        '<p class="sky-muted">This opens a WhatsApp conversation with us. Your order is agreed in the chat; nothing is ordered until then.</p>';
      var sel = box.querySelector('[data-wa-product]'); var qty = box.querySelector('[data-wa-qty]'); var link = box.querySelector('[data-skyfly-whatsapp-direct]');
      function update() {
        var p = null; for (var i = 0; i < cat.products.length; i++) if (cat.products[i].code === sel.value) p = cat.products[i];
        var q = Math.max(1, Math.min(99, parseInt(qty.value, 10) || 1));
        link.href = 'https://wa.me/' + encodeURIComponent(cat.whatsapp) + '?text=' + encodeURIComponent('Hi! I would like to order ' + (p ? p.name : '') + ' × ' + q + '.');
      }
      sel.onchange = update; qty.oninput = update; update();
    }
    function render() {
      if (cat.destination === 'whatsapp') return whatsappOnly();
      var saved = store(doneKey);
      if (saved) { try { return showConfirmation(JSON.parse(saved)); } catch (e) { /* show the form */ } }
      if (!cat.products.length) { box.innerHTML = '<p class="sky-err">Ordering is not available on this page right now.</p>' + wa(); return; }
      try { restoreProgress(); } catch (e) { /* start fresh */ }
      if (!product()) st8.product = cat.products[0].code;
      form();
    }
    fetch(api + '/api/public/pages/' + encodeURIComponent(page) + '/catalog')
      .then(function (r) { if (!r.ok) throw new Error('catalog'); return r.json(); })
      .then(function (data) { cat = data; return resumeFromLink(page).then(render); }, function () {
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
    // For pages with their own order form: call as the customer types or chooses, with
    // { landingPage?, customer: { name, phone, email, address, state, notes }, items: [{ product, quantity, upsell? }], step? }.
    // Skyfly then shows checkouts that were started but not finished; submitOrder() completes them.
    saveCheckout: function (progress) {
      progress = progress || {};
      saveProgress(progress.landingPage || pageKey, { customer: progress.customer || {}, items: progress.items || [], step: progress.step || 'details' });
    },
    // The current checkout session's ID, for pages that send orders themselves (as "checkoutId").
    checkoutId: function (page) { return session(page || pageKey).token || null; },
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
