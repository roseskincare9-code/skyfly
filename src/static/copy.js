// "Copy" buttons: <button data-copy="element-id">. Served from Skyfly (the dashboard allows no inline scripts).
document.addEventListener('click', function (e) {
  var btn = e.target.closest('[data-copy]');
  if (!btn) return;
  var el = document.getElementById(btn.getAttribute('data-copy'));
  if (!el) return;
  var done = function () { var t = btn.textContent; btn.textContent = 'Copied ✓'; setTimeout(function () { btn.textContent = t; }, 2000); };
  if (navigator.clipboard) navigator.clipboard.writeText(el.value || el.textContent).then(done, function () { el.select(); });
  else { el.select(); document.execCommand('copy'); done(); }
});
