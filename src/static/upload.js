// Import form: drag and drop onto [data-dropzone], and an upload progress bar. Without
// JavaScript the form still uploads normally. Served from Skyfly (no inline scripts).
(function () {
  var zone = document.querySelector('[data-dropzone]');
  if (!zone) return;
  var form = zone.closest('form');
  var input = zone.querySelector('input[type=file]');
  var name = zone.querySelector('[data-dropzone-name]');
  var bar = form.querySelector('[data-upload-progress]');
  var status = form.querySelector('[data-upload-status]');
  var show = function () { name.textContent = input.files[0] ? input.files[0].name + ' (' + Math.ceil(input.files[0].size / 1024) + ' KB)' : ''; };
  input.addEventListener('change', show);
  ['dragenter', 'dragover'].forEach(function (t) { zone.addEventListener(t, function (e) { e.preventDefault(); zone.style.background = 'rgba(0,0,0,.04)'; }); });
  ['dragleave', 'drop'].forEach(function (t) { zone.addEventListener(t, function (e) { e.preventDefault(); zone.style.background = ''; }); });
  zone.addEventListener('drop', function (e) {
    if (!e.dataTransfer || !e.dataTransfer.files.length) return;
    input.files = e.dataTransfer.files;
    show();
  });
  form.addEventListener('submit', function (e) {
    if (!window.FormData || !window.XMLHttpRequest || !input.files[0]) return;
    e.preventDefault();
    var button = form.querySelector('button[type=submit]');
    button.disabled = true;
    bar.hidden = false;
    var xhr = new XMLHttpRequest();
    xhr.open('POST', form.action);
    xhr.setRequestHeader('X-Skyfly-Upload', '1');
    xhr.upload.onprogress = function (p) {
      if (!p.lengthComputable) return;
      bar.value = Math.round(p.loaded / p.total * 100);
      status.textContent = bar.value < 100 ? 'Uploading… ' + bar.value + '%' : 'Checking the page…';
    };
    var failed = function (msg) { button.disabled = false; bar.hidden = true; status.textContent = msg; };
    // Skyfly answers {location} (the page, or this list with the reason it was refused).
    xhr.onload = function () {
      var next = null;
      try { next = JSON.parse(xhr.responseText).location; } catch (err) { /* not Skyfly's answer */ }
      if (next) location.href = next;
      else failed(xhr.status === 403 ? 'Your session has expired. Reload this page and upload again.' : 'The upload failed (HTTP ' + xhr.status + '). Reload the page and try again.');
    };
    xhr.onerror = function () { failed('The upload failed. Check your connection and try again.'); };
    xhr.send(new FormData(form));
  });
})();
