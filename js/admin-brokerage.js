// Admin Panel -- Brokerage Fee Discount system (Phase 1: per-account
// manual control). Same lazy-init-on-first-click pattern as
// js/admin-alerts.js/js/admin-offers.js/js/admin-arena.js; every read and
// write goes through js/backend-api.js's brokerage wrappers -- there is
// no direct Firestore path here, since firestore.rules make
// brokerageDiscountHistory/brokerageFeeSnapshots `allow write: if false`
// for every client SDK caller (admin sessions included) and the four
// discount fields on users/{uid}/privateProfile/main are admin-write-
// only through the same backend route this file calls.
//
// SCOPE, restated because it matters for every string in this file: this
// discount applies ONLY to the Darwesh brokerage/service fee, never to a
// property's own sale/rent/land/unit/project price. The preview
// calculator at the bottom of the account detail panel is a standalone
// tool -- it always calls compute-fee with record:false and never feeds
// any real deal-closing flow, because none exists in this codebase yet.
import { auth } from './firebase-init.js';
import {
  listBrokerageAccounts, getBrokerageAccount, setBrokerageDiscount, disableBrokerageDiscount,
  enableBrokerageDiscount, removeBrokerageDiscount, bulkSetBrokerageDiscount, listBrokerageHistory,
  computeBrokerageFee, localizeBackendError, isEndpointUnavailable,
} from './backend-api.js';
import { SELF_ACCOUNT_TYPES } from './permission-catalog.js';

function tr(key, fallback) { return (window.t && window.t(key)) || fallback; }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function toast(msg, variant) { if (window.AdminShellToast) window.AdminShellToast(msg, variant || 'success'); }
function user() { return auth.currentUser; }

const PRESETS = [0, 5, 10, 20, 30];

const ACCOUNT_TYPE_LABELS = {
  individual_customer: ['admin.roleCustomer', 'Customer'],
  real_estate_agent: ['admin.roleAgent', 'Agent'],
  office_owner: ['auth.pro.typeOfficeOwner', 'Real Estate Office'],
  office_employee: ['admin.rd.typeOfficeEmployee', 'Office employee'],
  professional_engineer: ['auth.pro.typeEngineer', 'Engineer'],
  professional_designer: ['auth.pro.typeDesigner', 'Designer'],
  professional_lawyer: ['auth.pro.typeLawyer', 'Lawyer'],
  professional_landscaping: ['auth.pro.typeLandscaping', 'Landscaping'],
  professional_maintenance: ['auth.pro.typeMaintenance', 'Maintenance'],
  cleaning_individual: ['auth.pro.typeCleaningIndividual', 'Cleaning (Individual)'],
  cleaning_team_or_company_owner: ['auth.pro.typeCleaningTeam', 'Cleaning (Team / Company)'],
  org_owner_residential_community: ['auth.pro.typeResidentialCommunity', 'Residential Community'],
  org_owner_developer: ['auth.pro.typeDeveloper', 'Developer / Apartment Project'],
  org_owner_finance_provider: ['auth.pro.typeFinanceProvider', 'Installment / Finance Provider'],
  org_owner_furniture_store: ['auth.pro.typeFurnitureStore', 'Home Goods / Furniture Seller'],
};
function accountTypeLabel(type) {
  const e = ACCOUNT_TYPE_LABELS[type];
  return e ? tr(e[0], e[1]) : (type || '—');
}

const VERIFICATION_LABELS = {
  unverified: ['vr.status.unverified', 'Not started'],
  pending: ['vr.status.pending', 'In review'],
  needs_review: ['vr.status.needsReview', 'Needs manual review'],
  needs_resubmission: ['vr.status.needsResubmission', 'Needs resubmission'],
  verified: ['vr.status.verified', 'Verified'],
  rejected: ['vr.status.rejected', 'Not approved'],
};
const VERIFICATION_BADGE = {
  unverified: 'badge-private', pending: 'badge-pending', needs_review: 'badge-pending',
  needs_resubmission: 'badge-suspended', verified: 'badge-active', rejected: 'badge-rejected',
};
function verificationBadgeHtml(status) {
  const e = VERIFICATION_LABELS[status] || VERIFICATION_LABELS.unverified;
  const cls = VERIFICATION_BADGE[status] || 'badge-private';
  return `<span class="badge ${cls}">${esc(tr(e[0], e[1]))}</span>`;
}

const HISTORY_ACTION_LABELS = {
  set: ['brokerage.action.set', 'Set'],
  bulk_set: ['brokerage.action.bulkSet', 'Bulk set'],
  disable: ['brokerage.action.disable', 'Disabled'],
  enable: ['brokerage.action.enable', 'Enabled'],
  remove: ['brokerage.action.remove', 'Removed'],
};
function historyActionLabel(action) {
  const e = HISTORY_ACTION_LABELS[action];
  return e ? tr(e[0], e[1]) : (action || '—');
}

function fmtDateTime(v) {
  if (!v) return '—';
  const d = new Date(v);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function fmtMoney(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '—';
  return v.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}
function initials(name) {
  const s = String(name || '').trim();
  if (!s) return '?';
  const parts = s.split(/\s+/).filter(Boolean);
  const chars = parts.length > 1 ? parts[0][0] + parts[1][0] : s.slice(0, 2);
  return chars.toUpperCase();
}
function avatarHtml(a) {
  const name = a.displayName || a.uid;
  if (a.photoURL) {
    return `<div class="bd-avatar-wrap">
      <img class="bd-avatar" src="${esc(a.photoURL)}" alt="" loading="lazy" decoding="async"
           onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';">
      <div class="bd-avatar-fallback" style="display:none;">${esc(initials(name))}</div>
    </div>`;
  }
  return `<div class="bd-avatar-wrap"><div class="bd-avatar-fallback" style="display:flex;">${esc(initials(name))}</div></div>`;
}

async function withBusy(btn, fn) {
  if (!btn || btn.disabled) return fn();
  btn.disabled = true;
  const prev = btn.textContent;
  btn.textContent = tr('brokerage.working', 'Working…');
  try { return await fn(); } finally { btn.disabled = false; btn.textContent = prev; }
}

function describeError(err) {
  if (isEndpointUnavailable(err)) return tr('brokerage.errUnavailable', 'The brokerage discount backend is not deployed in this environment yet.');
  return localizeBackendError(err, tr, 'brokerage.errGeneric', 'Something went wrong. Please try again.');
}

// ---------------------------------------------------------------------
// Shell + sub-tabs
// ---------------------------------------------------------------------
const SUB_TABS = [
  { key: 'all', label: () => tr('brokerage.tabAll', 'All Accounts') },
  { key: 'discounted', label: () => tr('brokerage.tabDiscounted', 'Discounted Accounts') },
  { key: 'nodiscount', label: () => tr('brokerage.tabNoDiscount', 'No Discount') },
  { key: 'history', label: () => tr('brokerage.tabHistory', 'History') },
];

const state = {
  mounted: false,
  subTab: 'all',
  filters: { search: '', accountType: '', discountMin: '', discountMax: '', noDiscountOnly: false },
  accounts: [],
  accountsById: new Map(),
  loading: false,
  error: null,
  cursor: null,
  hasMore: false,
  selected: new Set(),
  history: { uid: '', rows: [], loading: false, error: null },
};

function panel() { return document.getElementById('tab-brokerage'); }

function ensureShell() {
  const root = panel();
  if (!root || state.mounted) return root;
  root.innerHTML = `
    <div class="ash-offers">
      <div class="ash-offers-head">
        <div>
          <p class="font-headline-md text-[22px] text-on-surface font-bold" data-i18n="brokerage.title">Brokerage Fee Discounts</p>
          <p class="font-body-md text-[12.5px] text-on-surface-variant mt-1" data-i18n="brokerage.subtitle">Admin-controlled discounts on the Darwesh brokerage/service fee only -- never on a property's own sale, rent, or unit price. Nothing here is applied automatically by role, city, or campaign.</p>
        </div>
      </div>
      <div id="bdSubTabs" style="display:flex;gap:8px;flex-wrap:wrap;margin:16px 0;"></div>
      <div id="bdSubPanel"></div>
    </div>`;
  state.mounted = true;
  return root;
}

function renderSubTabs() {
  const el = document.getElementById('bdSubTabs');
  if (!el) return;
  el.innerHTML = SUB_TABS.map((t) => `
    <button type="button" class="ash-detail-btn${state.subTab === t.key ? ' ash-detail-btn-primary' : ''}" data-bd-subtab="${t.key}">${esc(t.label())}</button>
  `).join('');
  el.querySelectorAll('[data-bd-subtab]').forEach((btn) => {
    btn.addEventListener('click', () => { state.subTab = btn.dataset.bdSubtab; renderSubTabs(); renderSubPanel(); });
  });
}

function renderSubPanel() {
  const el = document.getElementById('bdSubPanel');
  if (!el) return;
  if (state.subTab === 'history') return mountHistoryPanel(el);
  return mountAccountsPanel(el, state.subTab);
}

// ---------------------------------------------------------------------
// Accounts sub-tabs (All / Discounted / No Discount)
// ---------------------------------------------------------------------
function mountAccountsPanel(el, subTab) {
  if (el.dataset.bdMode !== 'accounts' || el.dataset.bdSubtab !== subTab) {
    el.dataset.bdMode = 'accounts';
    el.dataset.bdSubtab = subTab;
    buildAccountsShell(el, subTab);
    fetchAccounts({ reset: true });
  } else {
    renderAccountsList();
  }
}

function buildAccountsShell(el, subTab) {
  const showAdvanced = subTab === 'all';
  el.innerHTML = `
    <div class="ash-entity-toolbar">
      <div class="ash-entity-search">
        <span class="material-symbols-outlined" aria-hidden="true">search</span>
        <input type="text" id="bdSearchInput" data-i18n-placeholder="brokerage.searchPlaceholder" placeholder="Search by name, phone, account type, city, or ID…" value="${esc(state.filters.search)}">
      </div>
      <select id="bdTypeFilter" class="ash-entity-select"></select>
      <span class="ash-entity-count" id="bdCount"></span>
    </div>
    ${showAdvanced ? `
    <div class="bd-filter-row">
      <label class="block" style="margin:0;">
        <span class="admin-label" data-i18n="brokerage.filterDiscountMin">Min %</span>
        <input type="number" min="0" max="100" class="admin-input" id="bdMinFilter" value="${esc(state.filters.discountMin)}">
      </label>
      <label class="block" style="margin:0;">
        <span class="admin-label" data-i18n="brokerage.filterDiscountMax">Max %</span>
        <input type="number" min="0" max="100" class="admin-input" id="bdMaxFilter" value="${esc(state.filters.discountMax)}">
      </label>
      <label style="display:flex; align-items:center; gap:6px; font: 500 12.5px/1.3 'Inter', sans-serif; color: var(--ash-text);">
        <input type="checkbox" id="bdNoDiscountFilter" ${state.filters.noDiscountOnly ? 'checked' : ''}>
        <span data-i18n="brokerage.filterNoDiscountOnly">No discount only</span>
      </label>
    </div>` : ''}
    <div id="bdBulkBar"></div>
    <div class="ash-entity-table-wrap bg-surface-container-lowest border border-outline-variant rounded-xl overflow-hidden" style="margin-top:12px;">
      <div class="overflow-x-auto">
        <table class="admin-table">
          <thead><tr>
            <th><input type="checkbox" id="bdSelectAll" aria-label="${esc(tr('brokerage.selectAll', 'Select all'))}"></th>
            <th data-i18n="brokerage.thPhoto">Photo</th>
            <th data-i18n="brokerage.thName">Name</th>
            <th data-i18n="brokerage.thAccountType">Account Type</th>
            <th data-i18n="brokerage.thCity">City</th>
            <th data-i18n="brokerage.thVerification">Verification</th>
            <th data-i18n="brokerage.thDiscount">Discount</th>
            <th data-i18n="brokerage.thStatus">Status</th>
            <th data-i18n="brokerage.thLastUpdated">Last Updated</th>
            <th data-i18n="brokerage.thUpdatedBy">Updated By</th>
            <th data-i18n="brokerage.thActions">Actions</th>
          </tr></thead>
          <tbody id="bdTableBody"></tbody>
        </table>
      </div>
    </div>
    <div style="text-align:center; margin-top:14px;">
      <button type="button" class="ash-detail-btn hidden" id="bdLoadMoreBtn" data-i18n="brokerage.loadMore">Load more</button>
    </div>`;

  const typeSel = document.getElementById('bdTypeFilter');
  typeSel.innerHTML = `<option value="">${esc(tr('admin.filterAll', 'All'))}</option>` +
    SELF_ACCOUNT_TYPES.map((t) => `<option value="${t}"${state.filters.accountType === t ? ' selected' : ''}>${esc(accountTypeLabel(t))}</option>`).join('');

  let searchTimer = null;
  document.getElementById('bdSearchInput').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    const val = e.target.value;
    searchTimer = setTimeout(() => { state.filters.search = val; fetchAccounts({ reset: true }); }, 300);
  });
  typeSel.addEventListener('change', (e) => { state.filters.accountType = e.target.value; fetchAccounts({ reset: true }); });

  if (showAdvanced) {
    let rangeTimer = null;
    const onRangeChange = () => {
      clearTimeout(rangeTimer);
      rangeTimer = setTimeout(() => {
        state.filters.discountMin = document.getElementById('bdMinFilter').value;
        state.filters.discountMax = document.getElementById('bdMaxFilter').value;
        fetchAccounts({ reset: true });
      }, 300);
    };
    document.getElementById('bdMinFilter').addEventListener('input', onRangeChange);
    document.getElementById('bdMaxFilter').addEventListener('input', onRangeChange);
    document.getElementById('bdNoDiscountFilter').addEventListener('change', (e) => {
      state.filters.noDiscountOnly = e.target.checked;
      fetchAccounts({ reset: true });
    });
  }

  document.getElementById('bdSelectAll').addEventListener('change', (e) => {
    if (e.target.checked) state.accounts.forEach((a) => state.selected.add(a.uid));
    else state.selected.clear();
    renderAccountsList();
  });

  document.getElementById('bdLoadMoreBtn').addEventListener('click', () => fetchAccounts({ reset: false }));

  const tbody = document.getElementById('bdTableBody');
  tbody.addEventListener('change', (e) => {
    const cb = e.target.closest('[data-bd-select]');
    if (!cb) return;
    const uid = cb.dataset.bdSelect;
    if (cb.checked) state.selected.add(uid); else state.selected.delete(uid);
    renderBulkBar();
    const selectAll = document.getElementById('bdSelectAll');
    if (selectAll) selectAll.checked = state.accounts.length > 0 && state.accounts.every((a) => state.selected.has(a.uid));
  });
  tbody.addEventListener('click', (e) => {
    const rowEl = e.target.closest('tr[data-uid]');
    if (!rowEl) return;
    const uid = rowEl.dataset.uid;
    const presetBtn = e.target.closest('[data-row-preset]');
    const customBtn = e.target.closest('[data-row-custom-apply]');
    const toggleBtn = e.target.closest('[data-row-toggle]');
    const removeBtn = e.target.closest('[data-row-remove]');
    const viewBtn = e.target.closest('[data-row-view]');
    if (presetBtn) { applyRowPreset(uid, Number(presetBtn.dataset.rowPreset)); return; }
    if (customBtn) { applyRowCustom(uid, rowEl); return; }
    if (toggleBtn) { toggleRowActive(uid, toggleBtn.dataset.active === 'true'); return; }
    if (removeBtn) { removeRowDiscount(uid); return; }
    if (viewBtn) { openDetail(uid); return; }
    if (e.target.closest('.bd-row-actions') || e.target.closest('[data-bd-select]')) return;
    openDetail(uid);
  });
}

function subTabParams(subTab) {
  if (subTab === 'nodiscount') return { noDiscountOnly: true };
  if (subTab === 'discounted') return { discountMin: 0.01 };
  return {
    discountMin: state.filters.discountMin !== '' ? Number(state.filters.discountMin) : undefined,
    discountMax: state.filters.discountMax !== '' ? Number(state.filters.discountMax) : undefined,
    noDiscountOnly: state.filters.noDiscountOnly,
  };
}

async function fetchAccounts({ reset = false } = {}) {
  if (!user()) return;
  if (reset) { state.accounts = []; state.cursor = null; state.hasMore = false; state.selected.clear(); }
  state.loading = true;
  state.error = null;
  renderAccountsList();
  try {
    const res = await listBrokerageAccounts(user(), {
      search: state.filters.search || undefined,
      accountType: state.filters.accountType || undefined,
      ...subTabParams(state.subTab),
      cursor: reset ? undefined : (state.cursor || undefined),
      limit: 50,
    });
    const rows = res.accounts || [];
    state.accounts = reset ? rows : state.accounts.concat(rows);
    rows.forEach((r) => state.accountsById.set(r.uid, r));
    state.cursor = res.nextCursor || null;
    state.hasMore = !!res.nextCursor;
  } catch (err) {
    state.error = err;
  } finally {
    state.loading = false;
    renderAccountsList();
  }
}

async function refreshRowIfLoaded(uid) {
  try {
    const fresh = await getBrokerageAccount(user(), uid);
    state.accountsById.set(uid, fresh);
    const idx = state.accounts.findIndex((a) => a.uid === uid);
    if (idx >= 0) { state.accounts[idx] = fresh; renderAccountsList(); }
  } catch { /* row simply won't refresh; not fatal */ }
}

function discountBadgeHtml(a) {
  if (a.discountPercent === null || a.discountPercent === undefined) return '—';
  return a.discountActive === false
    ? `<span class="badge badge-suspended">${esc(tr('brokerage.statusDisabled', 'Disabled'))}</span>`
    : `<span class="badge badge-active">${esc(tr('brokerage.statusActive', 'Active'))}</span>`;
}

function rowActionsHtml(a) {
  const hasDiscount = a.discountPercent !== null && a.discountPercent !== undefined;
  const isActive = a.discountActive !== false;
  return `
    <div class="bd-row-actions">
      <div class="bd-preset-group">
        ${PRESETS.map((p) => `<button type="button" class="ash-detail-btn" data-row-preset="${p}" title="${esc(tr('brokerage.presetLabel', 'Quick set'))}">${p}%</button>`).join('')}
      </div>
      <div class="bd-custom-group">
        <input type="number" class="bd-custom-input" min="0" max="100" placeholder="${esc(tr('brokerage.customPercent', 'Custom %'))}" value="${hasDiscount ? esc(String(a.discountPercent)) : ''}">
        <button type="button" class="ash-detail-btn" data-row-custom-apply>${esc(tr('brokerage.set', 'Set'))}</button>
      </div>
      ${hasDiscount ? `<button type="button" class="ash-detail-btn" data-row-toggle data-active="${isActive}">${esc(isActive ? tr('brokerage.actionDisable', 'Disable') : tr('brokerage.actionEnable', 'Re-enable'))}</button>` : ''}
      ${hasDiscount ? `<button type="button" class="ash-detail-btn ash-detail-btn-danger" data-row-remove>${esc(tr('brokerage.actionRemove', 'Remove'))}</button>` : ''}
      <button type="button" class="ash-detail-btn" data-row-view>${esc(tr('brokerage.actionView', 'View'))}</button>
    </div>`;
}

function accountRowHtml(a) {
  return `
    <tr data-uid="${esc(a.uid)}">
      <td><input type="checkbox" data-bd-select="${esc(a.uid)}" ${state.selected.has(a.uid) ? 'checked' : ''}></td>
      <td>${avatarHtml(a)}</td>
      <td>${esc(a.displayName || a.uid)}</td>
      <td>${esc(accountTypeLabel(a.accountType))}</td>
      <td>${esc(a.city || '—')}</td>
      <td>${verificationBadgeHtml(a.verificationStatus)}</td>
      <td>${a.discountPercent === null || a.discountPercent === undefined ? '—' : `${esc(String(a.effectiveDiscountPercent))}%`}</td>
      <td>${discountBadgeHtml(a)}</td>
      <td>${esc(fmtDateTime(a.discountUpdatedAt))}</td>
      <td>${esc(a.discountUpdatedBy || '—')}</td>
      <td>${rowActionsHtml(a)}</td>
    </tr>`;
}

function renderAccountsList() {
  const tbody = document.getElementById('bdTableBody');
  const countEl = document.getElementById('bdCount');
  const loadMoreBtn = document.getElementById('bdLoadMoreBtn');
  if (!tbody) return;
  renderBulkBar();

  if (state.loading && !state.accounts.length) {
    tbody.innerHTML = `<tr><td colspan="11" class="ash-entity-loading">${esc(tr('brokerage.loading', 'Loading accounts…'))}</td></tr>`;
    if (countEl) countEl.textContent = '';
    if (loadMoreBtn) loadMoreBtn.classList.add('hidden');
    return;
  }
  if (state.error) {
    tbody.innerHTML = `<tr><td colspan="11" class="ash-entity-error">
      ${esc(describeError(state.error))}
      <div><button type="button" class="ash-entity-retry" id="bdRetryBtn">${esc(tr('brokerage.retry', 'Try again'))}</button></div>
    </td></tr>`;
    document.getElementById('bdRetryBtn')?.addEventListener('click', () => fetchAccounts({ reset: true }));
    if (countEl) countEl.textContent = '';
    if (loadMoreBtn) loadMoreBtn.classList.add('hidden');
    return;
  }
  if (!state.accounts.length) {
    tbody.innerHTML = `<tr><td colspan="11" class="ash-entity-empty">${esc(tr('brokerage.empty', 'No accounts match your filters.'))}</td></tr>`;
    if (countEl) countEl.textContent = '';
    if (loadMoreBtn) loadMoreBtn.classList.add('hidden');
    return;
  }
  if (countEl) countEl.textContent = tr('brokerage.countLabel', '{n} accounts').replace('{n}', String(state.accounts.length));
  tbody.innerHTML = state.accounts.map(accountRowHtml).join('');
  if (loadMoreBtn) loadMoreBtn.classList.toggle('hidden', !state.hasMore);
}

function renderBulkBar() {
  const bar = document.getElementById('bdBulkBar');
  if (!bar) return;
  const priorReason = document.getElementById('bdBulkReason')?.value || '';
  const n = state.selected.size;
  if (!n) { bar.innerHTML = ''; return; }
  bar.innerHTML = `
    <div class="bd-bulk-bar">
      <span class="bd-bulk-count">${esc(tr('brokerage.bulkSelectedCount', '{count} selected').replace('{count}', String(n)))}</span>
      <div class="bd-preset-group">
        ${PRESETS.map((p) => `<button type="button" class="ash-detail-btn" data-bulk-preset="${p}">${p}%</button>`).join('')}
      </div>
      <div class="bd-custom-group">
        <input type="number" class="bd-custom-input" min="0" max="100" id="bdBulkCustom" placeholder="${esc(tr('brokerage.customPercent', 'Custom %'))}">
        <button type="button" class="ash-detail-btn" id="bdBulkCustomApply">${esc(tr('brokerage.apply', 'Apply'))}</button>
      </div>
      <button type="button" class="ash-detail-btn ash-detail-btn-danger" id="bdBulkRemoveBtn">${esc(tr('brokerage.bulkRemove', 'Remove discount'))}</button>
      <textarea class="bd-bulk-reason" id="bdBulkReason" rows="1" data-i18n-placeholder="brokerage.bulkReasonPlaceholder" placeholder="Reason (optional, applied to every account in this action)…">${esc(priorReason)}</textarea>
      <button type="button" class="ash-detail-btn" id="bdBulkClearBtn">${esc(tr('brokerage.clearSelection', 'Clear selection'))}</button>
    </div>`;
  bar.querySelectorAll('[data-bulk-preset]').forEach((b) => b.addEventListener('click', () => bulkApply(Number(b.dataset.bulkPreset), b)));
  document.getElementById('bdBulkCustomApply').addEventListener('click', (e) => {
    const val = Number(document.getElementById('bdBulkCustom').value);
    if (!Number.isFinite(val) || val < 0 || val > 100) { toast(tr('brokerage.invalidPercent', 'Enter a percentage between 0 and 100.'), 'error'); return; }
    bulkApply(val, e.currentTarget);
  });
  document.getElementById('bdBulkRemoveBtn').addEventListener('click', (e) => bulkRemove(e.currentTarget));
  document.getElementById('bdBulkClearBtn').addEventListener('click', () => { state.selected.clear(); renderAccountsList(); });
}

function bulkReason() {
  const v = (document.getElementById('bdBulkReason')?.value || '').trim();
  return v || undefined;
}

function reportBulkResult(res) {
  const results = res.results || [];
  const ok = results.filter((r) => r.ok).length;
  const failed = results.length - ok;
  if (failed > 0) {
    toast(tr('brokerage.bulkResultSummary', '{ok} updated, {failed} failed.').replace('{ok}', String(ok)).replace('{failed}', String(failed)), 'error');
  } else {
    toast(tr('brokerage.bulkResultAllOk', '{ok} accounts updated.').replace('{ok}', String(ok)), 'success');
  }
}

async function bulkApply(percent, btn) {
  const ids = Array.from(state.selected);
  if (!ids.length) return;
  const msg = tr('brokerage.confirmBulkApply', 'Apply {percent}% discount to {count} accounts?')
    .replace('{percent}', String(percent)).replace('{count}', String(ids.length));
  if (!window.confirm(msg)) return;
  try {
    const res = await withBusy(btn, () => bulkSetBrokerageDiscount(user(), { accountIds: ids, percent, active: true, reason: bulkReason() }));
    reportBulkResult(res);
    state.selected.clear();
    await fetchAccounts({ reset: true });
  } catch (err) {
    toast(describeError(err), 'error');
  }
}

async function bulkRemove(btn) {
  const ids = Array.from(state.selected);
  if (!ids.length) return;
  const msg = tr('brokerage.confirmBulkRemove', 'Remove the brokerage-fee discount from {count} accounts?').replace('{count}', String(ids.length));
  if (!window.confirm(msg)) return;
  try {
    const res = await withBusy(btn, () => bulkSetBrokerageDiscount(user(), { accountIds: ids, percent: 0, active: false, reason: bulkReason() }));
    reportBulkResult(res);
    state.selected.clear();
    await fetchAccounts({ reset: true });
  } catch (err) {
    toast(describeError(err), 'error');
  }
}

async function applyRowPreset(uid, percent) {
  try {
    await setBrokerageDiscount(user(), uid, { percent, active: true });
    toast(tr('brokerage.toastSet', 'Discount updated.'), 'success');
    await refreshRowIfLoaded(uid);
  } catch (err) {
    toast(describeError(err), 'error');
  }
}

async function applyRowCustom(uid, rowEl) {
  const input = rowEl.querySelector('.bd-custom-input');
  const val = Number(input.value);
  if (!Number.isFinite(val) || val < 0 || val > 100) { toast(tr('brokerage.invalidPercent', 'Enter a percentage between 0 and 100.'), 'error'); return; }
  const btn = rowEl.querySelector('[data-row-custom-apply]');
  try {
    await withBusy(btn, () => setBrokerageDiscount(user(), uid, { percent: val, active: true }));
    toast(tr('brokerage.toastSet', 'Discount updated.'), 'success');
    await refreshRowIfLoaded(uid);
  } catch (err) {
    toast(describeError(err), 'error');
  }
}

async function toggleRowActive(uid, isActive) {
  const a = state.accountsById.get(uid);
  const name = (a && (a.displayName || a.uid)) || uid;
  const msg = isActive
    ? tr('brokerage.confirmDisable', 'Disable the brokerage-fee discount for {name}? The stored percentage is kept and can be re-enabled later.').replace('{name}', name)
    : tr('brokerage.confirmEnable', 'Re-enable the brokerage-fee discount for {name} at its previous percentage?').replace('{name}', name);
  if (!window.confirm(msg)) return;
  try {
    if (isActive) await disableBrokerageDiscount(user(), uid);
    else await enableBrokerageDiscount(user(), uid);
    toast(isActive ? tr('brokerage.toastDisabled', 'Discount disabled.') : tr('brokerage.toastEnabled', 'Discount re-enabled.'), 'success');
    await refreshRowIfLoaded(uid);
  } catch (err) {
    toast(describeError(err), 'error');
  }
}

async function removeRowDiscount(uid) {
  const a = state.accountsById.get(uid);
  const name = (a && (a.displayName || a.uid)) || uid;
  const msg = tr('brokerage.confirmRemove', 'Remove the brokerage-fee discount for {name}? This sets it to 0% and disabled.').replace('{name}', name);
  if (!window.confirm(msg)) return;
  try {
    await removeBrokerageDiscount(user(), uid);
    toast(tr('brokerage.toastRemoved', 'Discount removed.'), 'success');
    await refreshRowIfLoaded(uid);
  } catch (err) {
    toast(describeError(err), 'error');
  }
}

// ---------------------------------------------------------------------
// History sub-tab
// ---------------------------------------------------------------------
function mountHistoryPanel(el) {
  if (el.dataset.bdMode !== 'history') {
    el.dataset.bdMode = 'history';
    delete el.dataset.bdSubtab;
    buildHistoryShell(el);
    fetchHistory();
  } else {
    renderHistoryList();
  }
}

function buildHistoryShell(el) {
  el.innerHTML = `
    <div class="ash-entity-toolbar">
      <div class="ash-entity-search">
        <span class="material-symbols-outlined" aria-hidden="true">search</span>
        <input type="text" id="bdHistoryUidInput" data-i18n-placeholder="brokerage.historySearchPlaceholder" placeholder="Filter by account UID…" value="${esc(state.history.uid)}">
      </div>
      <button type="button" class="ash-detail-btn" id="bdHistoryClearBtn" data-i18n="brokerage.historyClear">Show all accounts</button>
      <span class="ash-entity-count" id="bdHistoryCount"></span>
    </div>
    <div class="ash-entity-table-wrap bg-surface-container-lowest border border-outline-variant rounded-xl overflow-hidden">
      <div class="overflow-x-auto">
        <table class="admin-table">
          <thead><tr>
            <th data-i18n="brokerage.thAccount">Account</th>
            <th data-i18n="brokerage.thPrevPercent">Previous %</th>
            <th data-i18n="brokerage.thNewPercent">New %</th>
            <th data-i18n="brokerage.thPrevActive">Active Before</th>
            <th data-i18n="brokerage.thNewActive">Active After</th>
            <th data-i18n="brokerage.thAction">Action</th>
            <th data-i18n="brokerage.thChangedBy">Changed By</th>
            <th data-i18n="brokerage.thChangedAt">Changed At</th>
            <th data-i18n="brokerage.thReason">Reason</th>
          </tr></thead>
          <tbody id="bdHistoryTableBody"></tbody>
        </table>
      </div>
    </div>`;

  let timer = null;
  document.getElementById('bdHistoryUidInput').addEventListener('input', (e) => {
    clearTimeout(timer);
    const val = e.target.value.trim();
    timer = setTimeout(() => { state.history.uid = val; fetchHistory(); }, 300);
  });
  document.getElementById('bdHistoryClearBtn').addEventListener('click', () => {
    state.history.uid = '';
    document.getElementById('bdHistoryUidInput').value = '';
    fetchHistory();
  });
}

async function fetchHistory() {
  if (!user()) return;
  state.history.loading = true;
  state.history.error = null;
  renderHistoryList();
  try {
    const res = await listBrokerageHistory(user(), { uid: state.history.uid || undefined, limit: 50 });
    state.history.rows = res.history || [];
  } catch (err) {
    state.history.error = err;
  } finally {
    state.history.loading = false;
    renderHistoryList();
  }
}

function activeLabel(v) {
  if (v === true) return tr('brokerage.statusActive', 'Active');
  if (v === false) return tr('brokerage.statusDisabled', 'Disabled');
  return '—';
}

function historyRowHtml(h) {
  return `
    <tr>
      <td>${esc(h.uid || '—')}</td>
      <td>${h.previousPercent === null || h.previousPercent === undefined ? '—' : esc(String(h.previousPercent)) + '%'}</td>
      <td>${h.newPercent === null || h.newPercent === undefined ? '—' : esc(String(h.newPercent)) + '%'}</td>
      <td>${esc(activeLabel(h.previousActive))}</td>
      <td>${esc(activeLabel(h.newActive))}</td>
      <td>${esc(historyActionLabel(h.action))}</td>
      <td>${esc(h.changedBy || '—')}</td>
      <td>${esc(fmtDateTime(h.changedAt))}</td>
      <td>${esc(h.reason || '—')}</td>
    </tr>`;
}

function renderHistoryList() {
  const tbody = document.getElementById('bdHistoryTableBody');
  const countEl = document.getElementById('bdHistoryCount');
  if (!tbody) return;
  if (state.history.loading) {
    tbody.innerHTML = `<tr><td colspan="9" class="ash-entity-loading">${esc(tr('brokerage.loading', 'Loading…'))}</td></tr>`;
    if (countEl) countEl.textContent = '';
    return;
  }
  if (state.history.error) {
    tbody.innerHTML = `<tr><td colspan="9" class="ash-entity-error">
      ${esc(describeError(state.history.error))}
      <div><button type="button" class="ash-entity-retry" id="bdHistoryRetryBtn">${esc(tr('brokerage.retry', 'Try again'))}</button></div>
    </td></tr>`;
    document.getElementById('bdHistoryRetryBtn')?.addEventListener('click', fetchHistory);
    if (countEl) countEl.textContent = '';
    return;
  }
  if (!state.history.rows.length) {
    tbody.innerHTML = `<tr><td colspan="9" class="ash-entity-empty">${esc(tr('brokerage.historyEmpty', 'No discount history yet.'))}</td></tr>`;
    if (countEl) countEl.textContent = '';
    return;
  }
  if (countEl) countEl.textContent = tr('brokerage.countLabel', '{n} accounts').replace('{n}', String(state.history.rows.length));
  tbody.innerHTML = state.history.rows.map(historyRowHtml).join('');
}

// ---------------------------------------------------------------------
// Account detail panel
// ---------------------------------------------------------------------
let detailBackdrop = null;
function ensureDetailOverlay() {
  if (detailBackdrop) return detailBackdrop;
  detailBackdrop = document.createElement('div');
  detailBackdrop.className = 'ash-detail-backdrop';
  detailBackdrop.style.display = 'none';
  detailBackdrop.innerHTML = `
    <div class="ash-detail-panel" role="dialog" aria-modal="true">
      <div class="ash-detail-head">
        <div>
          <div class="ash-detail-title" id="bdDetailTitle"></div>
          <div class="ash-detail-sub" id="bdDetailSub"></div>
        </div>
        <button type="button" class="ash-detail-close" id="bdDetailClose" aria-label="Close">
          <span class="material-symbols-outlined" aria-hidden="true">close</span>
        </button>
      </div>
      <div class="ash-detail-body" id="bdDetailBody"></div>
    </div>`;
  document.body.appendChild(detailBackdrop);
  detailBackdrop.addEventListener('click', (e) => { if (e.target === detailBackdrop) closeDetail(); });
  document.getElementById('bdDetailClose').addEventListener('click', closeDetail);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && detailBackdrop.style.display !== 'none') closeDetail(); });
  return detailBackdrop;
}
function closeDetail() { if (detailBackdrop) detailBackdrop.style.display = 'none'; }

async function openDetail(uid) {
  ensureDetailOverlay();
  detailBackdrop.style.display = 'flex';
  document.getElementById('bdDetailTitle').textContent = tr('brokerage.loading', 'Loading…');
  document.getElementById('bdDetailSub').textContent = '';
  document.getElementById('bdDetailBody').innerHTML = '';
  try {
    const account = await getBrokerageAccount(user(), uid);
    state.accountsById.set(uid, account);
    renderDetailBody(account);
  } catch (err) {
    document.getElementById('bdDetailTitle').textContent = uid;
    document.getElementById('bdDetailBody').innerHTML = `<p class="ash-entity-error">${esc(describeError(err))}</p>`;
  }
}

async function refreshDetail(uid) {
  try {
    const account = await getBrokerageAccount(user(), uid);
    state.accountsById.set(uid, account);
    renderDetailBody(account);
  } catch (err) {
    toast(describeError(err), 'error');
  }
}

function renderDetailBody(account) {
  const uid = account.uid;
  const hasDiscount = account.discountPercent !== null && account.discountPercent !== undefined;
  const isActive = account.discountActive !== false;

  document.getElementById('bdDetailTitle').textContent = account.displayName || uid;
  document.getElementById('bdDetailSub').textContent = `${accountTypeLabel(account.accountType)} · ${account.city || '—'}`;

  document.getElementById('bdDetailBody').innerHTML = `
    <div style="display:flex; align-items:center; gap:12px;">
      ${avatarHtml(account)}
      <div>
        <div class="ash-detail-kv" style="grid-template-columns:auto auto; gap:6px 12px;">
          ${verificationBadgeHtml(account.verificationStatus)}
        </div>
      </div>
    </div>
    <div>
      <div class="ash-detail-section-title" data-i18n="brokerage.detailSectionDiscount">Brokerage Discount</div>
      <p class="ash-detail-note-text">${esc(tr('brokerage.detailCurrent', 'Current:'))} <strong>${hasDiscount ? esc(String(account.discountPercent)) + '%' : esc(tr('brokerage.notConfigured', 'Not configured'))}</strong> ${hasDiscount ? discountBadgeHtml(account) : ''}</p>
      <div style="display:flex; flex-direction:column; gap:10px; margin-top:10px;">
        <label class="block">
          <span class="admin-label" data-i18n="brokerage.customPercent">Custom %</span>
          <input type="number" class="admin-input" id="bdEditPercent" min="0" max="100" value="${hasDiscount ? esc(String(account.discountPercent)) : 0}">
        </label>
        <div class="bd-preset-group">
          ${PRESETS.map((p) => `<button type="button" class="ash-detail-btn" data-edit-preset="${p}">${p}%</button>`).join('')}
        </div>
        <label class="block">
          <span class="admin-label" data-i18n="brokerage.detailReasonLabel">Reason (optional)</span>
          <textarea class="ash-detail-textarea" id="bdEditReason" data-i18n-placeholder="brokerage.detailReasonPlaceholder" placeholder="Why is this discount changing? (optional, kept in the account's history)…"></textarea>
        </label>
        <div style="display:flex; gap:8px; flex-wrap:wrap;">
          <button type="button" class="ash-detail-btn ash-detail-btn-primary" id="bdSaveBtn" data-i18n="brokerage.detailSave">Save discount</button>
          ${hasDiscount ? `<button type="button" class="ash-detail-btn" id="bdToggleBtn">${esc(isActive ? tr('brokerage.actionDisable', 'Disable') : tr('brokerage.actionEnable', 'Re-enable'))}</button>` : ''}
          ${hasDiscount ? `<button type="button" class="ash-detail-btn ash-detail-btn-danger" id="bdRemoveBtn" data-i18n="brokerage.actionRemove">Remove</button>` : ''}
        </div>
      </div>
    </div>
    <div>
      <div class="ash-detail-section-title" data-i18n="brokerage.detailSectionHistory">Discount history</div>
      <div id="bdDetailHistory"><p class="ash-detail-note-text" style="opacity:.6">${esc(tr('brokerage.loading', 'Loading…'))}</p></div>
    </div>
    <div>
      <div class="ash-detail-section-title" data-i18n="brokerage.detailSectionCalculator">Preview calculation</div>
      <p class="ash-detail-note-text" style="opacity:.75" data-i18n="brokerage.detailCalculatorHint">A standalone preview tool. It never applies a discount to a real deal -- no deal-closing flow exists in this system yet.</p>
      <div class="bd-calc-row" style="margin-top:10px;">
        <label class="block">
          <span class="admin-label" data-i18n="brokerage.calcOriginalFee">Original brokerage fee</span>
          <input type="number" class="admin-input" id="bdCalcAmount" min="0" step="0.01" value="1000">
        </label>
        <label class="block">
          <span class="admin-label" data-i18n="brokerage.calcCurrency">Currency</span>
          <select class="admin-input" id="bdCalcCurrency"><option value="USD">USD</option><option value="IQD">IQD</option></select>
        </label>
        <button type="button" class="ash-detail-btn ash-detail-btn-primary" id="bdCalcBtn" data-i18n="brokerage.calcPreview">Preview calculation</button>
      </div>
      <dl class="ash-detail-kv" id="bdCalcResult" style="margin-top:12px;"></dl>
    </div>`;

  document.querySelectorAll('#bdDetailBody [data-edit-preset]').forEach((b) => {
    b.addEventListener('click', () => { document.getElementById('bdEditPercent').value = b.dataset.editPreset; });
  });
  document.getElementById('bdSaveBtn').addEventListener('click', async (e) => {
    const val = Number(document.getElementById('bdEditPercent').value);
    if (!Number.isFinite(val) || val < 0 || val > 100) { toast(tr('brokerage.invalidPercent', 'Enter a percentage between 0 and 100.'), 'error'); return; }
    const reason = document.getElementById('bdEditReason').value.trim() || undefined;
    try {
      await withBusy(e.currentTarget, () => setBrokerageDiscount(user(), uid, { percent: val, active: true, reason }));
      toast(tr('brokerage.toastSet', 'Discount updated.'), 'success');
      await refreshDetail(uid);
      await refreshRowIfLoaded(uid);
    } catch (err) { toast(describeError(err), 'error'); }
  });
  document.getElementById('bdToggleBtn')?.addEventListener('click', async (e) => {
    const reason = document.getElementById('bdEditReason').value.trim() || undefined;
    const name = account.displayName || uid;
    const msg = isActive
      ? tr('brokerage.confirmDisable', 'Disable the brokerage-fee discount for {name}? The stored percentage is kept and can be re-enabled later.').replace('{name}', name)
      : tr('brokerage.confirmEnable', 'Re-enable the brokerage-fee discount for {name} at its previous percentage?').replace('{name}', name);
    if (!window.confirm(msg)) return;
    try {
      await withBusy(e.currentTarget, () => (isActive ? disableBrokerageDiscount(user(), uid, reason) : enableBrokerageDiscount(user(), uid, reason)));
      toast(isActive ? tr('brokerage.toastDisabled', 'Discount disabled.') : tr('brokerage.toastEnabled', 'Discount re-enabled.'), 'success');
      await refreshDetail(uid);
      await refreshRowIfLoaded(uid);
    } catch (err) { toast(describeError(err), 'error'); }
  });
  document.getElementById('bdRemoveBtn')?.addEventListener('click', async (e) => {
    const reason = document.getElementById('bdEditReason').value.trim() || undefined;
    const name = account.displayName || uid;
    const msg = tr('brokerage.confirmRemove', 'Remove the brokerage-fee discount for {name}? This sets it to 0% and disabled.').replace('{name}', name);
    if (!window.confirm(msg)) return;
    try {
      await withBusy(e.currentTarget, () => removeBrokerageDiscount(user(), uid, reason));
      toast(tr('brokerage.toastRemoved', 'Discount removed.'), 'success');
      await refreshDetail(uid);
      await refreshRowIfLoaded(uid);
    } catch (err) { toast(describeError(err), 'error'); }
  });
  document.getElementById('bdCalcBtn').addEventListener('click', async (e) => {
    const amount = Number(document.getElementById('bdCalcAmount').value);
    if (!Number.isFinite(amount) || amount < 0) { toast(tr('brokerage.calcInvalidAmount', 'Enter a fee amount of 0 or more.'), 'error'); return; }
    const currency = document.getElementById('bdCalcCurrency').value;
    try {
      const res = await withBusy(e.currentTarget, () => computeBrokerageFee(user(), { uid, originalFee: amount, currency, record: false }));
      document.getElementById('bdCalcResult').innerHTML = `
        <dt data-i18n="brokerage.calcOriginalFee">Original brokerage fee</dt><dd>${esc(fmtMoney(res.originalFee))} ${esc(res.currency)}</dd>
        <dt data-i18n="brokerage.calcDiscountPercent">Discount %</dt><dd>${esc(String(res.discountPercent))}%</dd>
        <dt data-i18n="brokerage.calcDiscountAmount">Discount amount</dt><dd>${esc(fmtMoney(res.discountAmount))} ${esc(res.currency)}</dd>
        <dt data-i18n="brokerage.calcFinalFee">Final fee</dt><dd><strong>${esc(fmtMoney(res.finalFee))} ${esc(res.currency)}</strong></dd>`;
    } catch (err) { toast(describeError(err), 'error'); }
  });

  (async () => {
    const host = document.getElementById('bdDetailHistory');
    try {
      const res = await listBrokerageHistory(user(), { uid, limit: 50 });
      const rows = res.history || [];
      if (!rows.length) { host.innerHTML = `<p class="ash-detail-note-text" style="opacity:.7">${esc(tr('brokerage.detailNoHistory', 'No discount changes recorded yet.'))}</p>`; return; }
      host.innerHTML = `<div class="ash-detail-timeline">` + rows.map((h) => `
        <div class="ash-detail-timeline-item">
          <span class="ash-detail-timeline-dot"></span>
          <div>
            <div>${esc(historyActionLabel(h.action))} — ${h.previousPercent === null || h.previousPercent === undefined ? '—' : esc(String(h.previousPercent)) + '%'} → ${h.newPercent === null || h.newPercent === undefined ? '—' : esc(String(h.newPercent)) + '%'}</div>
            <div class="ash-detail-timeline-time">${esc(h.changedBy || '—')} · ${esc(fmtDateTime(h.changedAt))}${h.reason ? ' · ' + esc(h.reason) : ''}</div>
          </div>
        </div>`).join('') + `</div>`;
    } catch (err) {
      host.innerHTML = `<p class="ash-detail-note-text" style="color:var(--ash-error)">${esc(describeError(err))}</p>`;
    }
  })();
}

// ---------------------------------------------------------------------
export function renderBrokerageTab() {
  ensureShell();
  renderSubTabs();
  renderSubPanel();
}

document.addEventListener('darwesh:langchange', () => {
  if (!state.mounted) return;
  renderSubTabs();
  const el = document.getElementById('bdSubPanel');
  if (el) { delete el.dataset.bdMode; delete el.dataset.bdSubtab; }
  renderSubPanel();
});
