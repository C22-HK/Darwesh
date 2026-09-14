// Darwesh Admin Panel — shared AdminPageHeader component (redesign Phase 1).
//
// Icon + short title + one-line description + a slot for the page's
// primary action(s), used at the top of every hub from Phase 2 on so every
// tab answers "where am I / what is this for / what can I do here" the
// same, consistent way instead of each tab inventing its own heading
// markup (compare the current Dashboard/Users/Projects tabs, each with a
// differently-shaped title block).
//
// Usage:
//   window.AdminPageHeader.mount(containerEl, {
//     icon: 'group',
//     title: () => t('admin.nav.groupPeople', 'People'),
//     description: () => t('admin.people.desc', 'Accounts, verification, organizations and professionals.'),
//     actions: [{ label: () => t('...', 'Add Agent'), variant: 'primary', onClick() { ... } }],
//   });
(function () {
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function resolve(v) { return typeof v === 'function' ? v() : v; }

  function mount(container, opts) {
    opts = opts || {};
    var title = resolve(opts.title) || '';
    var description = resolve(opts.description) || '';
    var icon = opts.icon || 'dashboard';
    var actions = opts.actions || [];

    container.innerHTML =
      '<div class="ash-page-header">' +
        '<div class="ash-page-header-main">' +
          '<span class="ash-page-header-icon"><span class="material-symbols-outlined" aria-hidden="true">' + esc(icon) + '</span></span>' +
          '<div>' +
            '<p class="ash-page-header-title">' + esc(title) + '</p>' +
            (description ? '<p class="ash-page-header-desc">' + esc(description) + '</p>' : '') +
          '</div>' +
        '</div>' +
        (actions.length ? '<div class="ash-page-header-actions">' +
          actions.map(function (a, i) {
            var cls = a.variant === 'primary' ? 'ash-detail-btn ash-detail-btn-primary' : 'ash-detail-btn';
            return '<button type="button" class="' + cls + '" data-ash-header-action="' + i + '">' + esc(resolve(a.label)) + '</button>';
          }).join('') +
        '</div>' : '') +
      '</div>';

    Array.prototype.forEach.call(container.querySelectorAll('[data-ash-header-action]'), function (btn) {
      var idx = Number(btn.dataset.ashHeaderAction);
      var action = actions[idx];
      if (action && typeof action.onClick === 'function') {
        btn.addEventListener('click', action.onClick);
      }
    });
  }

  window.AdminPageHeader = { mount: mount };
})();
