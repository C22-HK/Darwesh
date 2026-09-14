// Darwesh Admin Panel — shared AdminDialog component (redesign Stage 3).
//
// Replaces bare window.confirm()/alert() calls (currently scattered across
// admin.html's own module script and several admin-*.js modules) with a
// themed dialog that matches the rest of the shell, focus-traps, and reads
// visually dangerous for a destructive action instead of an identical grey
// browser prompt for every kind of confirmation.
//
// Usage:
//   const ok = await window.AdminDialog.confirm({
//     title: () => t('admin.deleteListingTitle', 'Delete listing?'),
//     body: () => t('admin.deleteListingConfirm', 'This removes it immediately.'),
//     confirmLabel: () => t('common.delete', 'Delete'),
//     danger: true,
//   });
//   if (!ok) return;
(function () {
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function resolve(v) { return typeof v === 'function' ? v() : v; }

  var backdropEl = null;
  var lastFocused = null;

  function ensure() {
    if (backdropEl) return backdropEl;
    backdropEl = document.createElement('div');
    backdropEl.className = 'ash-dialog-backdrop';
    backdropEl.hidden = true;
    backdropEl.innerHTML =
      '<div class="ash-dialog" role="alertdialog" aria-modal="true" aria-labelledby="ashDialogTitle" aria-describedby="ashDialogBody">' +
        '<p class="ash-dialog-title" id="ashDialogTitle"></p>' +
        '<p class="ash-dialog-body" id="ashDialogBody"></p>' +
        '<div class="ash-dialog-actions">' +
          '<button type="button" class="ash-detail-btn" data-ash-dialog-cancel></button>' +
          '<button type="button" class="ash-detail-btn ash-detail-btn-primary" data-ash-dialog-confirm></button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(backdropEl);
    backdropEl.addEventListener('mousedown', function (e) {
      if (e.target === backdropEl) cancelCurrent();
    });
    backdropEl.addEventListener('keydown', onKeydown);
    return backdropEl;
  }

  var resolveCurrent = null;

  function cancelCurrent() {
    if (!resolveCurrent) return;
    var r = resolveCurrent;
    close();
    r(false);
  }

  function close() {
    if (!backdropEl || backdropEl.hidden) return;
    backdropEl.hidden = true;
    resolveCurrent = null;
    if (lastFocused && typeof lastFocused.focus === 'function') lastFocused.focus();
    lastFocused = null;
  }

  function focusableEls() {
    return Array.prototype.slice.call(
      backdropEl.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')
    );
  }

  function onKeydown(e) {
    if (e.key === 'Escape') { e.preventDefault(); cancelCurrent(); return; }
    if (e.key !== 'Tab') return;
    var els = focusableEls();
    if (!els.length) return;
    var first = els[0], last = els[els.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  function confirm(opts) {
    opts = opts || {};
    ensure();
    lastFocused = document.activeElement;
    backdropEl.querySelector('#ashDialogTitle').textContent = resolve(opts.title) || '';
    backdropEl.querySelector('#ashDialogBody').textContent = resolve(opts.body) || '';
    var cancelBtn = backdropEl.querySelector('[data-ash-dialog-cancel]');
    var confirmBtn = backdropEl.querySelector('[data-ash-dialog-confirm]');
    cancelBtn.textContent = resolve(opts.cancelLabel) || 'Cancel';
    confirmBtn.textContent = resolve(opts.confirmLabel) || 'Confirm';
    confirmBtn.className = 'ash-detail-btn ' + (opts.danger ? 'ash-detail-btn-danger' : 'ash-detail-btn-primary');
    backdropEl.hidden = false;

    return new Promise(function (res) {
      resolveCurrent = res;
      cancelBtn.onclick = function () { close(); res(false); };
      confirmBtn.onclick = function () { close(); res(true); };
      confirmBtn.focus();
    });
  }

  window.AdminDialog = { confirm: confirm, close: close };
})();
