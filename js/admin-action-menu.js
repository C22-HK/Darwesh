// Darwesh Admin Panel — shared AdminActionMenu component (redesign Stage 3).
//
// Replaces "Edit | Verify | Suspend | Delete | More" rows of separate
// buttons with one "..." trigger per row and a single reusable popover menu
// -- one instance shared by the whole page (not one hidden menu per row),
// repositioned to whichever trigger was clicked. Full keyboard support
// (ArrowUp/Down, Home/End, Escape, click-outside) and RTL-aware
// positioning via inset-inline so it needs no separate RTL branch.
//
// Usage (delegated -- works for any number of rows, including rows
// rendered/replaced after attach() runs):
//   window.AdminActionMenu.attach(tableBodyEl, function (triggerEl) {
//     const uid = triggerEl.closest('tr').dataset.uid;
//     return [
//       { label: () => t('common.edit', 'Edit'), icon: 'edit', onClick: () => editRow(uid) },
//       { label: () => t('common.delete', 'Delete'), icon: 'delete', danger: true, onClick: () => deleteRow(uid) },
//     ];
//   });
// Each trigger button must carry `data-ash-menu-trigger` and
// `aria-haspopup="menu"`.
(function () {
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function resolve(v) { return typeof v === 'function' ? v() : v; }

  var menuEl = null;
  var openTrigger = null;
  var currentItems = [];
  var focusIndex = -1;

  function ensureMenu() {
    if (menuEl) return menuEl;
    menuEl = document.createElement('div');
    menuEl.className = 'ash-menu';
    menuEl.setAttribute('role', 'menu');
    menuEl.hidden = true;
    document.body.appendChild(menuEl);
    menuEl.addEventListener('keydown', onMenuKeydown);
    menuEl.addEventListener('click', function (e) {
      var item = e.target.closest('[data-ash-menu-item]');
      if (!item || item.getAttribute('aria-disabled') === 'true') return;
      var idx = Number(item.dataset.ashMenuItem);
      activateItem(idx);
    });
    return menuEl;
  }

  function renderItems() {
    menuEl.innerHTML = currentItems.map(function (it, i) {
      var cls = 'ash-menu-item' + (it.danger ? ' danger' : '') + (it.disabled ? ' disabled' : '');
      return (
        '<button type="button" class="' + cls + '" role="menuitem" tabindex="-1"' +
          ' data-ash-menu-item="' + i + '"' +
          (it.disabled ? ' aria-disabled="true"' : '') + '>' +
          (it.icon ? '<span class="material-symbols-outlined" aria-hidden="true">' + esc(it.icon) + '</span>' : '') +
          '<span>' + esc(resolve(it.label)) + '</span>' +
        '</button>'
      );
    }).join('');
  }

  function position(trigger) {
    var r = trigger.getBoundingClientRect();
    var isRtl = getComputedStyle(trigger).direction === 'rtl' ||
      trigger.closest('[dir="rtl"]') != null;
    menuEl.style.position = 'fixed';
    menuEl.style.top = Math.round(r.bottom + 6) + 'px';
    // Anchor to whichever edge keeps the menu on-screen and reading in the
    // page's own direction, rather than always the same physical side.
    var menuW = 200; // matches CSS min-width, used before first paint
    if (isRtl) {
      var left = Math.max(8, Math.round(r.left));
      menuEl.style.left = left + 'px';
      menuEl.style.right = 'auto';
    } else {
      var right = Math.max(8, Math.round(window.innerWidth - r.right));
      menuEl.style.right = right + 'px';
      menuEl.style.left = 'auto';
    }
    // Flip above the trigger if there isn't room below.
    requestAnimationFrame(function () {
      var mRect = menuEl.getBoundingClientRect();
      if (mRect.bottom > window.innerHeight - 8) {
        menuEl.style.top = Math.max(8, Math.round(r.top - mRect.height - 6)) + 'px';
      }
    });
  }

  function open(trigger, items) {
    if (openTrigger === trigger) { close(); return; }
    close();
    ensureMenu();
    currentItems = items || [];
    if (!currentItems.length) return;
    renderItems();
    menuEl.hidden = false;
    position(trigger);
    openTrigger = trigger;
    trigger.setAttribute('aria-expanded', 'true');
    focusIndex = 0;
    focusItem(0);
    document.addEventListener('mousedown', onOutsideMousedown, true);
    document.addEventListener('keydown', onDocKeydown, true);
  }

  function close() {
    if (!menuEl || menuEl.hidden) return;
    menuEl.hidden = true;
    if (openTrigger) {
      openTrigger.setAttribute('aria-expanded', 'false');
      openTrigger.focus();
    }
    openTrigger = null;
    currentItems = [];
    focusIndex = -1;
    document.removeEventListener('mousedown', onOutsideMousedown, true);
    document.removeEventListener('keydown', onDocKeydown, true);
  }

  function focusItem(i) {
    var els = menuEl.querySelectorAll('[data-ash-menu-item]:not([aria-disabled="true"])');
    if (!els.length) return;
    focusIndex = ((i % els.length) + els.length) % els.length;
    els[focusIndex].focus();
  }

  function activateItem(idx) {
    var item = currentItems[idx];
    close();
    if (item && typeof item.onClick === 'function') item.onClick();
  }

  function onMenuKeydown(e) {
    var els = menuEl.querySelectorAll('[data-ash-menu-item]:not([aria-disabled="true"])');
    if (e.key === 'ArrowDown') { e.preventDefault(); focusItem(focusIndex + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); focusItem(focusIndex - 1); }
    else if (e.key === 'Home') { e.preventDefault(); focusItem(0); }
    else if (e.key === 'End') { e.preventDefault(); focusItem(els.length - 1); }
    else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      var focused = document.activeElement;
      var idx = focused && focused.dataset ? Number(focused.dataset.ashMenuItem) : -1;
      if (idx >= 0) activateItem(idx);
    }
  }

  function onDocKeydown(e) {
    if (e.key === 'Escape') { e.preventDefault(); close(); }
  }

  function onOutsideMousedown(e) {
    if (menuEl && !menuEl.contains(e.target) && e.target !== openTrigger) close();
  }

  // Event delegation so triggers rendered/replaced after attach() (any
  // table body re-rendered on every fetch) still work with one listener.
  function attach(container, getItems) {
    container.addEventListener('click', function (e) {
      var trigger = e.target.closest('[data-ash-menu-trigger]');
      if (!trigger || !container.contains(trigger)) return;
      e.stopPropagation();
      open(trigger, getItems(trigger));
    });
  }

  window.AdminActionMenu = { attach: attach, close: close };
})();
