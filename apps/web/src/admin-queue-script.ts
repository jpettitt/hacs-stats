/**
 * Tiny script served at /static/admin-queue.js and pulled in by the
 * admin queue page. Intercepts the Accept / Reject form submits so
 * they POST to /admin/queue/decide?json=1 (which returns 204) and
 * the row drops out of the table in place — no full page reload.
 *
 * Pure progressive enhancement: if JS is off / fails, the unmodified
 * forms still submit normally and the existing 303 redirect carries
 * the page-reload flow.
 *
 * No deps; ships as a string from the layout module.
 */
export const ADMIN_QUEUE_JS = `
(function () {
  'use strict';
  var forms = document.querySelectorAll('form[action="/admin/queue/decide"]');
  forms.forEach(function (form) {
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var row = form.closest('tr');
      if (!row) return;
      // Disable both buttons in this row so a double-click can't double-act.
      var buttons = row.querySelectorAll('button');
      buttons.forEach(function (b) { b.disabled = true; });
      row.style.opacity = '0.5';

      var data = new FormData(form);
      fetch('/admin/queue/decide?json=1', { method: 'POST', body: data })
        .then(function (res) {
          if (res.ok || res.status === 204) {
            // Quick fade-out then drop the row entirely.
            row.style.transition = 'opacity .2s';
            row.style.opacity = '0';
            setTimeout(function () { row.remove(); }, 200);
          } else {
            // Restore on server-side validation failure.
            buttons.forEach(function (b) { b.disabled = false; });
            row.style.opacity = '1';
            res.text().then(function (msg) {
              alert('Action failed: ' + (msg || res.status));
            });
          }
        })
        .catch(function () {
          buttons.forEach(function (b) { b.disabled = false; });
          row.style.opacity = '1';
          alert('Network error — try again.');
        });
    });
  });
})();
`;
