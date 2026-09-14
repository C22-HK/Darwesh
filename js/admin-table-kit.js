// Darwesh Admin -- shared enterprise table primitives (Stage 3).
//
// Three small, genuinely-reused pieces factored out while standardizing
// People/Accounts, Properties/Listings and Discounts/Accounts onto one
// table system: client-side pagination (the exact algorithm
// js/admin-orgs-pros.js already uses locally, now callable instead of
// re-typed a third time), a bulk-selection toolbar (generalized from
// admin-brokerage.js's own bd-bulk-bar, which already had every piece of
// this right), and skeleton-row markup for the loading state every table
// needs. No table's actual data-fetch/business logic lives here -- this
// only renders what a caller's own state already computed.

// Renders "‹ 1 2 3 … n ›" into #hostId; clamps state.page into range and
// hides itself entirely when everything fits on one page. `state` is the
// caller's own mutable {page, pageSize} -- this only reads/clamps it and
// calls onPage(n) on a click; the caller owns re-rendering after that.
export function renderPagination(hostId, totalRows, state, onPage) {
  const host = document.getElementById(hostId);
  if (!host) return;
  const totalPages = Math.max(1, Math.ceil(totalRows / state.pageSize));
  if (state.page > totalPages) state.page = totalPages;
  if (state.page < 1) state.page = 1;
  if (totalRows <= state.pageSize) { host.innerHTML = ''; return; }
  const start = (state.page - 1) * state.pageSize + 1;
  const end = Math.min(totalRows, state.page * state.pageSize);
  const buttons = [];
  buttons.push(`<button type="button" class="ash-entity-page-btn" data-page="${state.page - 1}" ${state.page <= 1 ? 'disabled' : ''} aria-label="Previous page">‹</button>`);
  const around = Math.max(1, state.page - 2), upto = Math.min(totalPages, state.page + 2);
  for (let p = around; p <= upto; p++) {
    buttons.push(`<button type="button" class="ash-entity-page-btn${p === state.page ? ' active' : ''}" data-page="${p}" aria-current="${p === state.page ? 'page' : 'false'}">${p}</button>`);
  }
  buttons.push(`<button type="button" class="ash-entity-page-btn" data-page="${state.page + 1}" ${state.page >= totalPages ? 'disabled' : ''} aria-label="Next page">›</button>`);
  host.innerHTML = `<span class="ash-entity-count" dir="ltr">${start}–${end} / ${totalRows}</span>${buttons.join('')}`;
  host.querySelectorAll('[data-page]').forEach((btn) => {
    btn.addEventListener('click', () => onPage(parseInt(btn.dataset.page, 10)));
  });
}

// Renders the "N selected [actions] [Clear selection]" bar into #hostId,
// or clears it when count is 0 -- the bar's own presence IS the "only
// show bulk controls once something is selected" behavior, same as
// admin-brokerage.js's original renderBulkBar. `actions` is
// [{ label, icon?, danger?, onClick }]; `extra` is optional raw HTML
// (e.g. a reason textarea) inserted between the count and the actions.
export function renderBulkBar(hostId, { count, countLabel, actions = [], onClear, clearLabel = 'Clear selection', extraHtml = '' }) {
  const host = document.getElementById(hostId);
  if (!host) return;
  if (!count) { host.innerHTML = ''; return; }
  const label = countLabel ? countLabel.replace('{count}', String(count)) : `${count} selected`;
  host.innerHTML = `
    <div class="ash-bulk-bar">
      <span class="ash-bulk-count">${label}</span>
      ${extraHtml}
      <div class="ash-bulk-actions">
        ${actions.map((a, i) => `<button type="button" class="ash-detail-btn${a.danger ? ' ash-detail-btn-danger' : ''}" data-bulk-action="${i}">${a.icon ? `<span class="material-symbols-outlined" aria-hidden="true" style="font-size:16px;vertical-align:-3px;">${a.icon}</span> ` : ''}${a.label}</button>`).join('')}
        <button type="button" class="ash-detail-btn" data-bulk-clear>${clearLabel}</button>
      </div>
    </div>`;
  host.querySelectorAll('[data-bulk-action]').forEach((btn) => {
    btn.addEventListener('click', () => actions[Number(btn.dataset.bulkAction)].onClick(btn));
  });
  const clearBtn = host.querySelector('[data-bulk-clear]');
  if (clearBtn && onClear) clearBtn.addEventListener('click', onClear);
}

// `<tr>` markup for N skeleton loading rows spanning `colspan` columns --
// same shimmer CSS (.ash-entity-skeleton-row/.ash-entity-skel) every
// entity table already ships.
export function skeletonRows(n, colspan) {
  return Array.from({ length: n }).map(() =>
    `<tr class="ash-entity-skeleton-row"><td colspan="${colspan}"><div class="ash-entity-skel" style="width:100%"></div></td></tr>`
  ).join('');
}

window.AdminTableKit = { renderPagination, renderBulkBar, skeletonRows };
