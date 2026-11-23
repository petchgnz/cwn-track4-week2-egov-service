/* e-Service กลาง · shared browser helpers (B01)
 *   App.showError(msg)    → fills the single [data-testid=action-error] (role=alert) and shows it
 *   App.showSuccess(msg)  → fills [data-testid=action-success] (toast) and shows it
 *   App.clearMessages()
 *   App.api(method, url, body) → Promise<{status, ok, data}>  (JSON in/out, same-origin cookie)
 *   App.upload(url, formData)  → same, for multipart
 */
(function () {
  'use strict';
  function slot(id) { return document.querySelector('[data-testid="' + id + '"]'); }
  function show(id, msg) {
    var el = slot(id);
    if (!el) return;
    el.textContent = msg == null ? '' : String(msg);
    el.hidden = !msg;
  }
  function clearMessages() { show('action-error', ''); show('action-success', ''); }
  function showError(msg) { show('action-success', ''); show('action-error', msg); }
  function showSuccess(msg) { show('action-error', ''); show('action-success', msg); }
  function parse(res) {
    return res.text().then(function (t) {
      var data = null;
      try { data = t ? JSON.parse(t) : null; } catch (e) { data = { raw: t }; }
      return { status: res.status, ok: res.ok, data: data };
    });
  }
  function api(method, url, body) {
    var opts = { method: method, credentials: 'same-origin', headers: { Accept: 'application/json' } };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    return fetch(url, opts).then(parse);
  }
  function upload(url, formData) {
    return fetch(url, { method: 'POST', credentials: 'same-origin', body: formData, headers: { Accept: 'application/json' } }).then(parse);
  }
  window.App = { showError: showError, showSuccess: showSuccess, clearMessages: clearMessages, api: api, upload: upload };
})();
