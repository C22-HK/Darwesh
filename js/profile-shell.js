// Reusable Profile Shell (Phase 3) -- replaces the copy-pasted tab-
// switcher pattern hand-duplicated in account.html/agent-dashboard.html/
// admin.html with one data-driven controller, plus the small set of
// cross-cutting UI helpers every profile page needs (loading/error state
// rendering, busy-button, avatar/logo upload). This module has no page-
// specific knowledge -- it's mounted by office.html (and, later, other
// profile pages) with a config object, never edited to add a new field
// or tab.
//
// Authenticated backend calls (authedRequest, BackendResponseError,
// BackendUnavailableError) live in backend-api.js, not here -- keeping
// exactly one definition of those classes so an error thrown by any
// backend-api.js wrapper function is reliably `instanceof`-matchable by
// every caller, rather than two same-named-but-distinct classes that
// would silently fail to match each other.

// ---- Tabs -------------------------------------------------------------
//
// Accessible tablist (role="tablist"/"tab"/"tabpanel", arrow-key
// navigation) with URL hash state (#tab=team) so a shared link and the
// browser back/forward button both land on the right panel -- neither
// of account.html/agent-dashboard.html/admin.html's own tab code has
// this today (confirmed: no hash/URL state anywhere in any of them).
//
// `tabs`: [{ key, label, panel }] -- `panel` is the panel element itself
// (already in the DOM, initially hidden). `tablist`/`onChange` optional.
export function mountTabs({ tablist, tabs, onChange }) {
  function activate(key, { pushHistory = true } = {}) {
    const match = tabs.find((t) => t.key === key) || tabs[0];
    if (!match) return;
    for (const tab of tabs) {
      const selected = tab.key === match.key;
      tab.button.setAttribute('aria-selected', selected ? 'true' : 'false');
      tab.button.tabIndex = selected ? 0 : -1;
      tab.panel.hidden = !selected;
    }
    if (pushHistory && window.location.hash !== `#tab=${match.key}`) {
      history.replaceState(null, '', `#tab=${match.key}`);
    }
    if (onChange) onChange(match.key);
  }

  tabs.forEach((tab, i) => {
    tab.button.addEventListener('click', () => activate(tab.key));
    tab.button.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      e.preventDefault();
      const dir = (document.documentElement.dir === 'rtl' ? -1 : 1) * (e.key === 'ArrowRight' ? 1 : -1);
      const next = tabs[(i + dir + tabs.length) % tabs.length];
      next.button.focus();
      activate(next.key);
    });
  });

  window.addEventListener('hashchange', () => {
    const key = (window.location.hash || '').replace('#tab=', '');
    if (key) activate(key, { pushHistory: false });
  });

  const initialKey = (window.location.hash || '').replace('#tab=', '');
  activate(initialKey || tabs[0]?.key, { pushHistory: false });

  return { activate };
}

// ---- Loading / empty / error state rendering ---------------------------

export function renderSkeletonRows(container, count, heightPx = 56) {
  container.innerHTML = '';
  for (let i = 0; i < count; i++) {
    const row = document.createElement('div');
    row.className = 'ps-skeleton';
    row.style.height = `${heightPx}px`;
    row.style.marginBottom = '8px';
    container.appendChild(row);
  }
}

export function renderEmptyState(container, { icon = 'inbox', title, hint }) {
  container.innerHTML = `
    <div class="ps-empty">
      <span class="material-symbols-outlined text-[32px] text-on-surface-variant opacity-60" aria-hidden="true">${icon}</span>
      <p class="font-body-md text-[14px] text-on-surface font-medium mt-3">${title}</p>
      ${hint ? `<p class="font-body-md text-[13px] text-on-surface-variant mt-1">${hint}</p>` : ''}
    </div>
  `;
}

export function renderErrorState(container, { message, onRetry }) {
  container.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'ps-empty';
  wrap.innerHTML = `
    <span class="material-symbols-outlined text-[32px] text-error opacity-80" aria-hidden="true">error</span>
    <p class="font-body-md text-[14px] text-on-surface font-medium mt-3">${message}</p>
  `;
  if (onRetry) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ps-btn mt-4 border border-outline-variant rounded-full px-4 py-2 font-label-caps text-label-caps text-on-surface hover:bg-surface-container transition-colors';
    btn.textContent = 'Retry';
    btn.addEventListener('click', onRetry);
    wrap.appendChild(btn);
  }
  container.appendChild(wrap);
}

// ---- Busy-button helper (never double-submit on repeated taps) ---------

export async function withBusyButton(button, fn) {
  if (button.getAttribute('aria-busy') === 'true') return;
  const originalHtml = button.innerHTML;
  button.setAttribute('aria-busy', 'true');
  button.disabled = true;
  try {
    return await fn();
  } finally {
    button.removeAttribute('aria-busy');
    button.disabled = false;
    button.innerHTML = originalHtml;
  }
}

// ---- Avatar / logo upload -------------------------------------------------
//
// Extracted from the three near-identical copies in account.html/
// agent-dashboard.html (upload -> getDownloadURL -> write URL to a
// Firestore doc, wrapped in a hard timeout). Same shape, generalized
// over which storage path and which doc/field to write.
export function withUploadTimeout(promise, ms = 25000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Upload timed out')), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (err) => { clearTimeout(timer); reject(err); }
    );
  });
}
