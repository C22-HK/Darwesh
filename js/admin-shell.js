// Darwesh Admin Panel — application shell (Phase 1 of the full redesign).
// Renders the collapsible sidebar + enhances the existing topbar + a
// Ctrl/Cmd+K command palette. Deliberately a CLASSIC script (like
// site-header.js/site-mobile-nav.js), placed after #adminSidebarMount AND
// the existing <header> in the document so it can mount into the former and
// wire the latter synchronously, before the page's own inline
// `<script type="module">` runs its one-time `.admin-tab` click-handler
// wiring pass (that pass does `document.querySelectorAll('.admin-tab')`,
// so every sidebar button rendered here carries the SAME `admin-tab
// data-tab="..."` contract the rest of admin.html already keys off --
// this file adds no new tab-switching logic, it only adds a second,
// better-looking place those same buttons live).
(function () {
  var mount = document.getElementById('adminSidebarMount');
  if (!mount) return;

  function tr(key, fallback) { return (window.t && window.t(key)) || fallback; }

  // One row per real destination. `tab` must match an existing
  // `data-tab="X"` / `id="tab-X"` pair. `soon: true` marks the nine
  // sections this phase ships as an honest roadmap placeholder rather than
  // a fabricated feature (see the nine `tab-*` placeholder <section>s added
  // to admin.html alongside this file) -- distinct from `alias: true`,
  // which points a brief-requested nav label at a tab that already fully
  // implements that job under a different name (Approvals -> the existing
  // Projects approval queue; Roles & Permissions -> the existing Role
  // Defaults panel inside Users & Roles).
  var GROUPS = [
    { key: 'overview', labelKey: 'admin.nav.groupOverview', labelText: 'Overview', items: [
      { tab: 'dashboard', icon: 'dashboard', labelKey: 'admin.dashboardTab', labelText: 'Dashboard' }
    ] },
    { key: 'listings', labelKey: 'admin.nav.groupListings', labelText: 'Listings & Projects', items: [
      { tab: 'listings', icon: 'home_work', labelKey: 'admin.listingsTab', labelText: 'Listings' },
      { tab: 'projects', icon: 'apartment', labelKey: 'admin.projectsTab', labelText: 'Projects' },
      { tab: 'projects', icon: 'fact_check', labelKey: 'admin.nav.approvals', labelText: 'Approvals', alias: true },
      { tab: 'market', icon: 'insights', labelKey: 'admin.marketOverviewTab', labelText: 'Market Overview' },
      { tab: 'estateintel', icon: 'map', labelKey: 'admin.estateIntelTab', labelText: 'Estate Intelligence Map' },
      { tab: 'estatedata', icon: 'storage', labelKey: 'admin.estateDataTab', labelText: 'Estate Data' }
    ] },
    { key: 'people', labelKey: 'admin.nav.groupPeople', labelText: 'People & Organizations', items: [
      { tab: 'users', icon: 'group', labelKey: 'admin.usersTab', labelText: 'Users & Roles' },
      { tab: 'organizations', icon: 'domain', labelKey: 'admin.nav.organizations', labelText: 'Organizations' },
      { tab: 'professionals', icon: 'engineering', labelKey: 'admin.nav.professionals', labelText: 'Professionals' },
      { tab: 'agents', icon: 'badge', labelKey: 'admin.agentsTab', labelText: 'Agents' },
      { tab: 'branches', icon: 'account_tree', labelKey: 'admin.branchesTab', labelText: 'Branches' },
      { tab: 'network', icon: 'hub', labelKey: 'admin.networkTab', labelText: 'Network' },
      { tab: 'leaderboard', icon: 'leaderboard', labelKey: 'admin.leaderboardTab', labelText: 'Leaderboard' }
    ] },
    { key: 'requests', labelKey: 'admin.nav.groupRequests', labelText: 'Requests', items: [
      { tab: 'services', icon: 'support_agent', labelKey: 'admin.nav.serviceRequests', labelText: 'Service Requests' },
      { tab: 'requestsmap', icon: 'pin_drop', labelKey: 'admin.requestsMapTab', labelText: 'Requests Map' }
    ] },
    { key: 'finance', labelKey: 'admin.nav.groupFinance', labelText: 'Finance & Reports', items: [
      { tab: 'financial', icon: 'payments', labelKey: 'admin.nav.financial', labelText: 'Financial Management', soon: true },
      { tab: 'reports', icon: 'monitoring', labelKey: 'admin.nav.reports', labelText: 'Reports', soon: true }
    ] },
    { key: 'operations', labelKey: 'admin.nav.groupOperations', labelText: 'Operations', items: [
      { tab: 'content', icon: 'edit_note', labelKey: 'admin.nav.content', labelText: 'Content Management', soon: true },
      { tab: 'notifications', icon: 'notifications', labelKey: 'admin.nav.notifications', labelText: 'Notifications', soon: true },
      { tab: 'scanlog', icon: 'qr_code_scanner', labelKey: 'admin.scanLogTab', labelText: 'Scan Log' }
    ] },
    { key: 'admin', labelKey: 'admin.nav.groupAdmin', labelText: 'Administration', items: [
      { tab: 'users', icon: 'admin_panel_settings', labelKey: 'admin.nav.rolesPermissions', labelText: 'Roles & Permissions', alias: true, requires: ['manage_permissions', 'manage_roles'] },
      { tab: 'security', icon: 'shield', labelKey: 'admin.nav.security', labelText: 'Security', soon: true, requires: ['manage_platform_security'] },
      { tab: 'auditlogs', icon: 'history', labelKey: 'admin.nav.auditLogs', labelText: 'Audit Logs', soon: true, requires: ['manage_platform_security'] },
      { tab: 'settings', icon: 'settings', labelKey: 'admin.nav.settings', labelText: 'Settings', soon: true }
    ] }
  ];

  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  function navItemHtml(item, idx) {
    var label = tr(item.labelKey, item.labelText);
    var soonBadge = item.soon ? '<span class="ash-nav-badge" data-i18n="admin.shell.soonBadge">Soon</span>' : '';
    return (
      '<button type="button" class="admin-tab ash-nav-item' + (item.tab === 'dashboard' ? ' active' : '') + '"' +
        ' data-tab="' + item.tab + '"' +
        (item.requires ? ' data-requires="' + item.requires.join(',') + '"' : '') +
        ' data-nav-id="n' + idx + '"' +
        ' title="' + esc(label) + '">' +
        '<span class="material-symbols-outlined" aria-hidden="true">' + item.icon + '</span>' +
        '<span class="ash-nav-label" data-i18n="' + item.labelKey + '">' + esc(label) + '</span>' +
        soonBadge +
      '</button>'
    );
  }

  var navIndex = 0;
  var flatItems = [];
  var groupsHtml = GROUPS.map(function (g) {
    var itemsHtml = g.items.map(function (item) {
      item._id = 'n' + navIndex;
      flatItems.push(item);
      var html = navItemHtml(item, navIndex);
      navIndex++;
      return html;
    }).join('');
    return (
      '<div class="ash-sidebar-group">' +
        '<div class="ash-sidebar-group-label" data-i18n="' + g.labelKey + '">' + esc(tr(g.labelKey, g.labelText)) + '</div>' +
        itemsHtml +
      '</div>'
    );
  }).join('');

  mount.innerHTML =
    '<nav class="ash-sidebar" aria-label="Admin navigation">' +
      '<div class="ash-sidebar-head">' +
        '<span class="ash-sidebar-logo"><img src="images/brand/darwesh-approved-new-logo.png" alt="" decoding="async"></span>' +
        '<span class="ash-sidebar-brand" data-i18n="admin.title">Darwesh Admin</span>' +
      '</div>' +
      '<div class="ash-sidebar-nav">' + groupsHtml + '</div>' +
      '<div class="ash-sidebar-foot">' +
        '<button type="button" class="ash-collapse-btn" id="ashCollapseBtn">' +
          '<span class="material-symbols-outlined" aria-hidden="true">left_panel_close</span>' +
          '<span class="ash-nav-label" data-i18n="admin.shell.collapseSidebar">Collapse</span>' +
        '</button>' +
      '</div>' +
    '</nav>' +
    '<div class="ash-drawer-scrim" id="ashDrawerScrim"></div>';

  var adminContent = document.getElementById('adminContent');

  // ---- Collapse (desktop) --------------------------------------------
  var COLLAPSE_KEY = 'darwesh_admin_sidebar_collapsed';
  var collapseBtn = document.getElementById('ashCollapseBtn');
  function setCollapsed(on) {
    adminContent.classList.toggle('ash-collapsed', !!on);
    try { localStorage.setItem(COLLAPSE_KEY, on ? '1' : '0'); } catch (e) {}
  }
  try { if (localStorage.getItem(COLLAPSE_KEY) === '1') setCollapsed(true); } catch (e) {}
  collapseBtn.addEventListener('click', function () {
    setCollapsed(!adminContent.classList.contains('ash-collapsed'));
  });

  // ---- Mobile drawer ---------------------------------------------------
  var scrim = document.getElementById('ashDrawerScrim');
  function openDrawer() { adminContent.classList.add('ash-drawer-open'); }
  function closeDrawer() { adminContent.classList.remove('ash-drawer-open'); }
  scrim.addEventListener('click', closeDrawer);
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeDrawer(); });
  // Close the drawer after choosing a section on mobile (desktop ignores this, the drawer is never open there).
  mount.addEventListener('click', function (e) {
    if (e.target.closest('.ash-nav-item')) closeDrawer();
  });
  window.AdminShellToggleDrawer = function () {
    adminContent.classList.toggle('ash-drawer-open');
  };

  // ---- Topbar wiring (elements are static markup in admin.html) --------
  var hamburgerBtn = document.getElementById('adminHamburgerBtn');
  if (hamburgerBtn) hamburgerBtn.addEventListener('click', function () { window.AdminShellToggleDrawer(); });

  var breadcrumb = document.getElementById('adminBreadcrumb');
  function updateBreadcrumb(tabKey) {
    if (!breadcrumb) return;
    var match = flatItems.filter(function (it) { return it.tab === tabKey && !it.alias; })[0] || flatItems.filter(function (it) { return it.tab === tabKey; })[0];
    breadcrumb.textContent = match ? tr(match.labelKey, match.labelText) : '';
  }
  updateBreadcrumb('dashboard');
  document.addEventListener('click', function (e) {
    var tabBtn = e.target.closest('.admin-tab');
    if (tabBtn && tabBtn.dataset.tab) updateBreadcrumb(tabBtn.dataset.tab);
  });

  var quickCreateBtn = document.getElementById('adminQuickCreateBtn');
  if (quickCreateBtn) {
    quickCreateBtn.addEventListener('click', function () {
      var listingsTab = document.querySelector('.admin-tab[data-tab="listings"]');
      if (listingsTab) listingsTab.click();
      setTimeout(function () {
        var form = document.getElementById('listingForm');
        if (form) form.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 60);
    });
  }

  // ---- Command palette (Ctrl/Cmd+K) -------------------------------------
  var cmdkBackdrop = null, cmdkInput = null, cmdkList = null, cmdkFocusIdx = -1, cmdkVisible = [];

  function buildCmdk() {
    if (cmdkBackdrop) return;
    cmdkBackdrop = document.createElement('div');
    cmdkBackdrop.className = 'ash-cmdk-backdrop';
    cmdkBackdrop.style.display = 'none';
    cmdkBackdrop.innerHTML =
      '<div class="ash-cmdk" role="dialog" aria-modal="true" aria-label="Command palette">' +
        '<div class="ash-cmdk-input-row">' +
          '<span class="material-symbols-outlined" aria-hidden="true">search</span>' +
          '<input type="text" id="ashCmdkInput" data-i18n-placeholder="admin.shell.searchPlaceholder" placeholder="Search admin sections…">' +
        '</div>' +
        '<div class="ash-cmdk-list" id="ashCmdkList"></div>' +
      '</div>';
    document.body.appendChild(cmdkBackdrop);
    cmdkInput = document.getElementById('ashCmdkInput');
    cmdkList = document.getElementById('ashCmdkList');
    cmdkBackdrop.addEventListener('click', function (e) { if (e.target === cmdkBackdrop) closeCmdk(); });
    cmdkInput.addEventListener('input', function () { renderCmdkList(cmdkInput.value); });
    cmdkInput.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { e.preventDefault(); closeCmdk(); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); moveCmdkFocus(1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); moveCmdkFocus(-1); }
      else if (e.key === 'Enter') { e.preventDefault(); chooseCmdk(cmdkFocusIdx); }
    });
  }

  function renderCmdkList(query) {
    var q = (query || '').trim().toLowerCase();
    cmdkVisible = flatItems.filter(function (it) {
      var label = tr(it.labelKey, it.labelText).toLowerCase();
      return !q || label.indexOf(q) !== -1;
    });
    cmdkFocusIdx = cmdkVisible.length ? 0 : -1;
    if (!cmdkVisible.length) {
      cmdkList.innerHTML = '<div class="ash-cmdk-empty" data-i18n="admin.shell.noResults">No matching sections</div>';
      return;
    }
    cmdkList.innerHTML = cmdkVisible.map(function (it, i) {
      return (
        '<button type="button" class="ash-cmdk-item" data-idx="' + i + '"' + (i === 0 ? ' data-focused="true"' : '') + '>' +
          '<span class="material-symbols-outlined" aria-hidden="true">' + it.icon + '</span>' +
          '<span>' + esc(tr(it.labelKey, it.labelText)) + '</span>' +
        '</button>'
      );
    }).join('');
    Array.prototype.forEach.call(cmdkList.querySelectorAll('.ash-cmdk-item'), function (btn) {
      btn.addEventListener('click', function () { chooseCmdk(parseInt(btn.dataset.idx, 10)); });
    });
  }

  function moveCmdkFocus(delta) {
    if (!cmdkVisible.length) return;
    cmdkFocusIdx = (cmdkFocusIdx + delta + cmdkVisible.length) % cmdkVisible.length;
    Array.prototype.forEach.call(cmdkList.querySelectorAll('.ash-cmdk-item'), function (btn, i) {
      if (i === cmdkFocusIdx) btn.setAttribute('data-focused', 'true'); else btn.removeAttribute('data-focused');
    });
    var el = cmdkList.querySelector('[data-idx="' + cmdkFocusIdx + '"]');
    if (el) el.scrollIntoView({ block: 'nearest' });
  }

  function chooseCmdk(idx) {
    var item = cmdkVisible[idx];
    if (!item) return;
    var el = document.querySelector('.admin-tab[data-tab="' + item.tab + '"]');
    if (el) el.click();
    closeCmdk();
  }

  function openCmdk(prefill) {
    buildCmdk();
    cmdkBackdrop.style.display = 'flex';
    cmdkInput.value = prefill || '';
    renderCmdkList(cmdkInput.value);
    setTimeout(function () { cmdkInput.focus(); }, 0);
  }
  function closeCmdk() { if (cmdkBackdrop) cmdkBackdrop.style.display = 'none'; }

  document.addEventListener('keydown', function (e) {
    var meta = e.metaKey || e.ctrlKey;
    if (meta && (e.key === 'k' || e.key === 'K')) { e.preventDefault(); openCmdk(); }
  });

  var searchInput = document.getElementById('adminSearchInput');
  if (searchInput) {
    searchInput.addEventListener('focus', function () { openCmdk(searchInput.value); });
    searchInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); openCmdk(searchInput.value); }
    });
  }
  var cmdkTrigger = document.getElementById('adminCmdkHint');
  if (cmdkTrigger) cmdkTrigger.addEventListener('click', function () { openCmdk(); });

  // ---- Progressive permission-based visibility --------------------------
  // Page access itself stays a hard server-enforced role==='admin' gate
  // (unchanged); this only hides a couple of the most sensitive NAV
  // entries from a caller whose effective permissions don't include them.
  // Expects the raw GET /api/v1/access/me/permissions response
  // ({role, globalPermissions, ...} -- js/backend-api.js's getMyPermissions).
  // Every PROTECTED_PERMISSIONS key (manage_permissions,
  // manage_platform_security, ...) is deliberately never resolvable
  // through globalPermissions -- backend/app/access/permission_resolver.py
  // strips them on purpose, since they're not meant to be delegable via
  // rolePermissionDefaults/overrides. Today's ONLY admin concept is the
  // flat role==='admin' gate this page already enforces before this
  // function is ever called, so role==='admin' satisfies any `requires`
  // list unconditionally -- matching current real access exactly. This
  // still leaves the mechanism in place for a future, finer-grained admin
  // tier: once one exists with real accountType-backed permissions, a
  // non-'admin' caller reaching this page would be gated on
  // globalPermissions instead. Best-effort and fail-open by design: if
  // this is never called, or the permissions fetch fails, every item
  // stays visible -- the actual authorization boundary is the backend/
  // firestore.rules layer, same as everywhere else on this page, not
  // this list.
  window.AdminShellApplyPermissions = function (res) {
    if (!res) return;
    var isFullAdmin = res.role === 'admin';
    var globalPermissions = res.globalPermissions || {};
    flatItems.forEach(function (it) {
      if (!it.requires) return;
      var granted = isFullAdmin || it.requires.some(function (key) { return globalPermissions[key] === true; });
      var el = mount.querySelector('.ash-nav-item[data-nav-id="' + it._id + '"]');
      if (el) el.style.display = granted ? '' : 'none';
    });
  };

  // ---- Shared toast feedback (Admin Panel Phase 2) ----------------------
  // No toast system existed anywhere in admin.html before this -- every
  // tab used alert()/confirm() for mutation feedback. Organizations/
  // Professionals' new approve/reject/verify/suspend/reactivate actions
  // need non-blocking success/error feedback, so this is a small, shared,
  // --ash-*-themed helper any tab (not just the two new ones) can call.
  var toastHost = null;
  function ensureToastHost() {
    if (toastHost) return toastHost;
    toastHost = document.createElement('div');
    toastHost.className = 'ash-toast-host';
    toastHost.setAttribute('aria-live', 'polite');
    toastHost.setAttribute('role', 'status');
    document.body.appendChild(toastHost);
    return toastHost;
  }
  // variant: 'success' (default) | 'error'
  window.AdminShellToast = function (message, variant) {
    var host = ensureToastHost();
    var el = document.createElement('div');
    el.className = 'ash-toast ash-toast-' + (variant === 'error' ? 'error' : 'success');
    el.textContent = String(message == null ? '' : message);
    host.appendChild(el);
    // Force layout before adding the visible class so the entrance
    // transition actually runs instead of starting already-shown.
    void el.offsetWidth;
    el.classList.add('ash-toast-show');
    setTimeout(function () {
      el.classList.remove('ash-toast-show');
      setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 220);
    }, variant === 'error' ? 5000 : 3200);
  };
})();
