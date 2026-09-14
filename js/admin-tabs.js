// Darwesh Admin Panel — shared AdminTabs component (redesign Phase 1).
//
// Generalizes the sub-tab pattern already proven in js/admin-brokerage.js
// (a small `state.subTab` field plus a `[data-bd-subtab]` click handler,
// fully self-contained inside that module) into one reusable component any
// hub can mount. A hub stays exactly one `data-tab="X"` panel from the
// legacy `.admin-tab` click mechanism's point of view (see js/admin-shell.js's
// own header comment) -- AdminTabs only owns switching *within* that one
// panel, the same way admin-brokerage.js's subTab already does today. This
// file adds no new tab-switching contract, it generalizes the existing one
// so Phase 2+'s hub shells (People, Properties, Finance, System) don't each
// reinvent it.
//
// Usage:
//   const tabs = window.AdminTabs.create({
//     mount: containerEl,
//     tabs: [{ key: 'all', label: () => t('key', 'All'), icon: 'list' }, ...],
//     active: 'all',
//     onChange(key) { /* re-render the panel body for `key` */ },
//   });
//   tabs.setActive('history');   // programmatic switch, e.g. after a save
//   tabs.getActive();            // 'history'
//   tabs.refresh();              // re-render labels (e.g. after a language switch)
(function () {
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function label(t) {
    return typeof t.label === 'function' ? t.label() : String(t.label || t.key);
  }

  function create(opts) {
    var mount = opts.mount;
    var tabs = opts.tabs || [];
    var active = opts.active || (tabs[0] && tabs[0].key);
    var onChange = typeof opts.onChange === 'function' ? opts.onChange : function () {};

    function render() {
      mount.innerHTML =
        '<div class="ash-tabs" role="tablist">' +
        tabs.map(function (t) {
          var isActive = t.key === active;
          return (
            '<button type="button" class="ash-tabs-btn' + (isActive ? ' active' : '') + '"' +
              ' role="tab" aria-selected="' + (isActive ? 'true' : 'false') + '"' +
              (t.badge ? ' data-ash-tab-badge="1"' : '') +
              ' data-ash-tab-key="' + esc(t.key) + '">' +
              (t.icon ? '<span class="material-symbols-outlined" aria-hidden="true">' + esc(t.icon) + '</span>' : '') +
              '<span>' + esc(label(t)) + '</span>' +
              (t.badge != null ? '<span class="ash-tabs-badge">' + esc(t.badge) + '</span>' : '') +
            '</button>'
          );
        }).join('') +
        '</div>';
      Array.prototype.forEach.call(mount.querySelectorAll('[data-ash-tab-key]'), function (btn) {
        btn.addEventListener('click', function () { setActive(btn.dataset.ashTabKey); });
      });
    }

    function setActive(key, force) {
      if (key === active && !force) return;
      if (!tabs.some(function (t) { return t.key === key; })) return;
      active = key;
      render();
      onChange(active);
    }

    render();

    return {
      setActive: function (key) { setActive(key, false); },
      getActive: function () { return active; },
      refresh: render,
    };
  }

  window.AdminTabs = { create: create };
})();
