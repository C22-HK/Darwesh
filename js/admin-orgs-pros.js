// Darwesh Admin Panel Phase 2 -- Organizations & Professionals tabs.
// Reuses Phase 1's shell tokens/toast/badges (css/admin-shell.css,
// js/admin-shell.js), admin.html's own .admin-table/.badge/.filter-chip
// classes, and the existing backend-api.js wrappers for every mutation --
// this file only adds the desktop-table/mobile-card dual-render, search/
// filter/sort/pagination, and the shared entity detail overlay, none of
// which had a precedent anywhere in admin.html before this phase.
//
// Data-model note (see the approved Phase 2 plan): "Organizations" here is
// a UNIFIED view over two real collections -- `organizations` (residential
// community / developer / finance / furniture / contractor / moving
// company) and `companies` (real-estate agencies/offices) -- both
// owner+verified-shaped, surfaced side by side rather than invented into a
// single fabricated collection. "Professionals" covers `serviceProviders`
// (engineer/designer/lawyer/landscaping/cleaning/maintenance) -- agents
// already have their own working tab from Phase 1 and are not duplicated
// here.
import { auth, db, storage, getDocs } from './firebase-init.js';
import {
  doc, collection, query, where, orderBy, limit as fsLimit
} from 'https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js';
import { ref as storageRef, listAll, getBytes } from 'https://www.gstatic.com/firebasejs/12.18.0/firebase-storage.js';
import {
  setOrganizationStatus, setOrganizationVerified, setCompanyStatus, setCompanyVerified,
  setProviderStatus, setProviderVerified, addOrganizationNote, addCompanyNote, addProviderNote,
  inviteOrganizationMember, transferOrganizationOwnership,
  approveOrganizationMembership, rejectOrganizationMembership, removeOrganizationMember,
  inviteCompanyEmployee, approveCompanyMembership, rejectCompanyMembership, removeCompanyEmployee,
  BackendResponseError
} from './backend-api.js';

function tr(key, fallback) { return (window.t && window.t(key)) || fallback; }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function toast(msg, variant) { if (window.AdminShellToast) window.AdminShellToast(msg, variant); }

function fmtDate(v) {
  if (!v) return '—';
  const d = typeof v.toDate === 'function' ? v.toDate() : (v instanceof Date ? v : (typeof v === 'number' ? new Date(v) : null));
  if (!d || isNaN(d.getTime())) return '—';
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}
function fmtDateTime(v) {
  if (!v) return '—';
  const d = typeof v.toDate === 'function' ? v.toDate() : (v instanceof Date ? v : (typeof v === 'number' ? new Date(v) : null));
  if (!d || isNaN(d.getTime())) return '—';
  return d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

// A doc with no `status` field yet (every entity that existed before this
// phase) is read as 'active' if verified, else 'pending' -- computed here
// at read time, matching the plan's "no bulk migration write" decision.
function computeStatus(data) {
  return data.status || (data.verified ? 'active' : 'pending');
}

const STATUS_BADGE_CLASS = { pending: 'badge-pending', active: 'badge-active', rejected: 'badge-rejected', suspended: 'badge-suspended' };
const STATUS_LABEL_KEY = {
  pending: ['admin.entity.statusPending', 'Pending'],
  active: ['admin.entity.statusActive', 'Active'],
  rejected: ['admin.entity.statusRejected', 'Rejected'],
  suspended: ['admin.entity.statusSuspended', 'Suspended'],
};
function statusBadgeHtml(status) {
  const cls = STATUS_BADGE_CLASS[status] || 'badge-pending';
  const [key, fallback] = STATUS_LABEL_KEY[status] || STATUS_LABEL_KEY.pending;
  return `<span class="badge ${cls}">${esc(tr(key, fallback))}</span>`;
}

function currentUser() { return auth.currentUser; }

async function withBusyButton(btn, fn) {
  if (!btn || btn.disabled) return fn();
  btn.disabled = true;
  const prevText = btn.textContent;
  btn.textContent = tr('admin.entity.working', 'Working…');
  try { return await fn(); } finally { btn.disabled = false; btn.textContent = prevText; }
}

function describeError(err) {
  if (err instanceof BackendResponseError) return err.message;
  return tr('admin.entity.actionFailed', 'Could not complete this action right now.');
}

// ---------------------------------------------------------------------
// Organizations: unified `organizations` + `companies`
// ---------------------------------------------------------------------

const ORG_TYPE_LABELS = {
  residential_community: ['admin.orgs.typeResidentialCommunity', 'Residential Community'],
  developer_project: ['admin.orgs.typeDeveloper', 'Property Developer'],
  finance_provider: ['admin.orgs.typeFinanceProvider', 'Finance Provider'],
  furniture_store: ['admin.orgs.typeFurnitureStore', 'Furniture Business'],
  contractor: ['admin.orgs.typeContractor', 'Contractor'],
  moving_company: ['admin.orgs.typeMovingCompany', 'Moving Company'],
  real_estate_agency: ['admin.orgs.typeRealEstateAgency', 'Real Estate Agency'],
};
function orgTypeLabel(type) {
  const [key, fallback] = ORG_TYPE_LABELS[type] || [null, type || '—'];
  return key ? tr(key, fallback) : fallback;
}

const orgsState = { inited: false, loading: false, error: null, all: [], search: '', type: 'all', status: 'all', sort: 'name-asc', page: 1, pageSize: 20 };

async function fetchOrganizationsData() {
  orgsState.loading = true; orgsState.error = null;
  renderOrganizationsTab();
  try {
    const [orgsSnap, companiesSnap] = await Promise.all([
      getDocs(collection(db, 'organizations')),
      getDocs(collection(db, 'companies')),
    ]);
    const orgs = orgsSnap.docs.map((d) => {
      const data = d.data();
      return {
        id: d.id, collection: 'organizations', name: data.name || '(unnamed)', type: data.type || '—',
        city: data.city || '', district: data.district || '', ownerId: data.ownerId || null,
        verified: !!data.verified, status: computeStatus(data), rejectionReason: data.rejectionReason || null,
        createdAt: data.createdAt || null,
      };
    });
    const companies = companiesSnap.docs.map((d) => {
      const data = d.data();
      return {
        id: d.id, collection: 'companies', name: data.name || '(unnamed)', type: 'real_estate_agency',
        city: data.city || '', district: data.district || '', ownerId: data.ownerId || null,
        verified: !!data.verified, status: computeStatus(data), rejectionReason: data.rejectionReason || null,
        createdAt: data.createdAt || null,
      };
    });
    orgsState.all = orgs.concat(companies);
    orgsState.page = 1;
  } catch (err) {
    orgsState.error = err;
  } finally {
    orgsState.loading = false;
    renderOrganizationsTab();
  }
}

function filterSortEntities(all, { search, typeFilter, statusFilter, sort }) {
  const q = (search || '').trim().toLowerCase();
  let rows = all.filter((r) => {
    if (statusFilter !== 'all' && r.status !== statusFilter) return false;
    if (typeFilter !== 'all' && r.type !== typeFilter) return false;
    if (q && !(String(r.name).toLowerCase().includes(q) || String(r.city).toLowerCase().includes(q))) return false;
    return true;
  });
  const tsMillis = (v) => (v && typeof v.toMillis === 'function' ? v.toMillis() : 0);
  rows.sort((a, b) => {
    if (sort === 'name-asc') return String(a.name).localeCompare(String(b.name));
    if (sort === 'name-desc') return String(b.name).localeCompare(String(a.name));
    if (sort === 'newest') return tsMillis(b.createdAt) - tsMillis(a.createdAt);
    if (sort === 'oldest') return tsMillis(a.createdAt) - tsMillis(b.createdAt);
    return 0;
  });
  return rows;
}

function ensureOrgsShell() {
  const section = document.getElementById('tab-organizations');
  if (!section || section.dataset.ashBuilt === '1') return;
  section.dataset.ashBuilt = '1';
  section.innerHTML = `
    <div class="ash-entity-toolbar">
      <div class="ash-entity-search">
        <span class="material-symbols-outlined" aria-hidden="true">search</span>
        <input type="text" id="orgsSearchInput" data-i18n-placeholder="admin.orgs.searchPlaceholder" placeholder="Search organizations by name or city…">
      </div>
      <select id="orgsTypeFilter" class="ash-entity-select"></select>
      <select id="orgsStatusFilter" class="ash-entity-select"></select>
      <select id="orgsSortSelect" class="ash-entity-select"></select>
      <span class="ash-entity-count" id="orgsCount"></span>
    </div>
    <div class="ash-entity-table-wrap bg-surface-container-lowest border border-outline-variant rounded-xl overflow-hidden">
      <div class="overflow-x-auto">
        <table class="admin-table">
          <thead><tr>
            <th data-i18n="admin.orgs.thName">Name</th>
            <th data-i18n="admin.orgs.thType">Type</th>
            <th data-i18n="admin.orgs.thCity">City</th>
            <th data-i18n="admin.orgs.thStatus">Status</th>
            <th data-i18n="admin.orgs.thVerified">Verified</th>
          </tr></thead>
          <tbody id="orgsTableBody"></tbody>
        </table>
      </div>
    </div>
    <div class="ash-entity-cards" id="orgsCards"></div>
    <div id="orgsPagination" class="ash-entity-pagination"></div>
  `;
  document.getElementById('orgsTypeFilter').innerHTML =
    `<option value="all" data-i18n="admin.filterAll">All types</option>` +
    Object.keys(ORG_TYPE_LABELS).map((t) => `<option value="${t}">${esc(orgTypeLabel(t))}</option>`).join('');
  document.getElementById('orgsStatusFilter').innerHTML =
    `<option value="all" data-i18n="admin.filterAll">All statuses</option>` +
    Object.keys(STATUS_LABEL_KEY).map((s) => `<option value="${s}">${esc(tr(...STATUS_LABEL_KEY[s]))}</option>`).join('');
  document.getElementById('orgsSortSelect').innerHTML = `
    <option value="name-asc" data-i18n="admin.entity.sortNameAsc">Name (A–Z)</option>
    <option value="name-desc" data-i18n="admin.entity.sortNameDesc">Name (Z–A)</option>
    <option value="newest" data-i18n="admin.entity.sortNewest">Newest first</option>
    <option value="oldest" data-i18n="admin.entity.sortOldest">Oldest first</option>
  `;
  let searchTimer = null;
  document.getElementById('orgsSearchInput').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    const val = e.target.value;
    searchTimer = setTimeout(() => { orgsState.search = val; orgsState.page = 1; renderOrganizationsTab(); }, 180);
  });
  document.getElementById('orgsTypeFilter').addEventListener('change', (e) => { orgsState.type = e.target.value; orgsState.page = 1; renderOrganizationsTab(); });
  document.getElementById('orgsStatusFilter').addEventListener('change', (e) => { orgsState.status = e.target.value; orgsState.page = 1; renderOrganizationsTab(); });
  document.getElementById('orgsSortSelect').addEventListener('change', (e) => { orgsState.sort = e.target.value; renderOrganizationsTab(); });
}

function renderPagination(hostId, totalRows, state, onPage) {
  const host = document.getElementById(hostId);
  if (!host) return;
  const totalPages = Math.max(1, Math.ceil(totalRows / state.pageSize));
  if (state.page > totalPages) state.page = totalPages;
  if (totalRows <= state.pageSize) { host.innerHTML = ''; return; }
  const buttons = [];
  buttons.push(`<button type="button" class="ash-entity-page-btn" data-page="${state.page - 1}" ${state.page <= 1 ? 'disabled' : ''}>‹</button>`);
  const start = Math.max(1, state.page - 2), end = Math.min(totalPages, state.page + 2);
  for (let p = start; p <= end; p++) {
    buttons.push(`<button type="button" class="ash-entity-page-btn${p === state.page ? ' active' : ''}" data-page="${p}">${p}</button>`);
  }
  buttons.push(`<button type="button" class="ash-entity-page-btn" data-page="${state.page + 1}" ${state.page >= totalPages ? 'disabled' : ''}>›</button>`);
  host.innerHTML = buttons.join('');
  host.querySelectorAll('[data-page]').forEach((btn) => {
    btn.addEventListener('click', () => { onPage(parseInt(btn.dataset.page, 10)); });
  });
}

function renderOrganizationsTab() {
  ensureOrgsShell();
  const tbody = document.getElementById('orgsTableBody');
  const cards = document.getElementById('orgsCards');
  const countEl = document.getElementById('orgsCount');
  if (!tbody || !cards) return;

  if (orgsState.loading && !orgsState.all.length) {
    tbody.innerHTML = Array.from({ length: 5 }).map(() =>
      `<tr class="ash-entity-skeleton-row"><td colspan="5"><div class="ash-entity-skel" style="width:100%"></div></td></tr>`
    ).join('');
    cards.innerHTML = '';
    countEl.textContent = '';
    document.getElementById('orgsPagination').innerHTML = '';
    return;
  }
  if (orgsState.error) {
    tbody.innerHTML = '';
    cards.innerHTML = `<div class="ash-entity-error">${esc(tr('admin.entity.loadFailedOrgs', 'Could not load organizations.'))}
      <div><button type="button" class="ash-entity-retry" id="orgsRetryBtn">${esc(tr('admin.entity.retry', 'Retry'))}</button></div></div>`;
    document.getElementById('orgsRetryBtn')?.addEventListener('click', fetchOrganizationsData);
    countEl.textContent = '';
    document.getElementById('orgsPagination').innerHTML = '';
    return;
  }

  const rows = filterSortEntities(orgsState.all, { search: orgsState.search, typeFilter: orgsState.type, statusFilter: orgsState.status, sort: orgsState.sort });
  countEl.textContent = tr('admin.entity.countLabel', '{n} organizations').replace('{n}', String(rows.length));
  if (!rows.length) {
    tbody.innerHTML = '';
    cards.innerHTML = `<div class="ash-entity-empty">${esc(tr('admin.entity.noResults', 'No organizations match your filters.'))}</div>`;
    document.getElementById('orgsPagination').innerHTML = '';
    return;
  }
  const start = (orgsState.page - 1) * orgsState.pageSize;
  const pageRows = rows.slice(start, start + orgsState.pageSize);

  tbody.innerHTML = pageRows.map((r) => `
    <tr class="ash-entity-row" data-collection="${r.collection}" data-id="${esc(r.id)}">
      <td>${esc(r.name)}</td>
      <td>${esc(orgTypeLabel(r.type))}</td>
      <td>${esc(r.city || '—')}</td>
      <td>${statusBadgeHtml(r.status)}</td>
      <td>${r.verified ? `<span class="badge badge-verified">${esc(tr('common.verified', 'Verified'))}</span>` : '—'}</td>
    </tr>
  `).join('');
  cards.innerHTML = pageRows.map((r) => `
    <div class="ash-entity-card" data-collection="${r.collection}" data-id="${esc(r.id)}">
      <div class="ash-entity-card-head">
        <div>
          <div class="ash-entity-card-title">${esc(r.name)}</div>
          <div class="ash-entity-card-sub">${esc(orgTypeLabel(r.type))} · ${esc(r.city || '—')}</div>
        </div>
        ${statusBadgeHtml(r.status)}
      </div>
      <div class="ash-entity-card-meta">${r.verified ? `<span class="badge badge-verified">${esc(tr('common.verified', 'Verified'))}</span>` : ''}</div>
    </div>
  `).join('');

  Array.from(tbody.querySelectorAll('.ash-entity-row')).concat(Array.from(cards.querySelectorAll('.ash-entity-card'))).forEach((el) => {
    el.addEventListener('click', () => openOrgDetail(el.dataset.collection, el.dataset.id));
  });

  renderPagination('orgsPagination', rows.length, orgsState, (p) => { orgsState.page = p; renderOrganizationsTab(); });
}

// ---- Organizations: detail overlay ----------------------------------

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
          <div class="ash-detail-title" id="ashDetailTitle"></div>
          <div class="ash-detail-sub" id="ashDetailSub"></div>
        </div>
        <button type="button" class="ash-detail-close" id="ashDetailClose" aria-label="Close">
          <span class="material-symbols-outlined" aria-hidden="true">close</span>
        </button>
      </div>
      <div class="ash-detail-body" id="ashDetailBody"></div>
    </div>
  `;
  document.body.appendChild(detailBackdrop);
  detailBackdrop.addEventListener('click', (e) => { if (e.target === detailBackdrop) closeDetail(); });
  document.getElementById('ashDetailClose').addEventListener('click', closeDetail);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && detailBackdrop.style.display !== 'none') closeDetail(); });
  return detailBackdrop;
}
function closeDetail() { if (detailBackdrop) detailBackdrop.style.display = 'none'; }
function openDetailWith(title, sub, bodyHtml) {
  ensureDetailOverlay();
  document.getElementById('ashDetailTitle').textContent = title;
  document.getElementById('ashDetailSub').textContent = sub;
  document.getElementById('ashDetailBody').innerHTML = bodyHtml;
  detailBackdrop.style.display = 'flex';
}

function statusActionsHtml() {
  return `
    <div class="ash-detail-section-title" data-i18n="admin.entity.sectionStatus">Status</div>
    <div class="ash-detail-actions" id="ashStatusActions"></div>
    <div id="ashReasonWrap" class="hidden" style="margin-top:10px; display:flex; flex-direction:column; gap:8px;">
      <textarea class="ash-detail-textarea" id="ashReasonInput" data-i18n-placeholder="admin.entity.reasonPlaceholder" placeholder="Reason (required for reject/suspend)…"></textarea>
      <div style="display:flex; gap:8px;">
        <button type="button" class="ash-detail-btn ash-detail-btn-danger" id="ashReasonSubmit"></button>
        <button type="button" class="ash-detail-btn" id="ashReasonCancel" data-i18n="admin.cancel">Cancel</button>
      </div>
      <p class="ash-detail-note-text hidden" id="ashReasonError" style="color:var(--ash-error)"></p>
    </div>
  `;
}

function wireStatusActions({ entity, onSetStatus, onSetVerified }) {
  const wrap = document.getElementById('ashStatusActions');
  const reasonWrap = document.getElementById('ashReasonWrap');
  const reasonInput = document.getElementById('ashReasonInput');
  const reasonSubmit = document.getElementById('ashReasonSubmit');
  const reasonCancel = document.getElementById('ashReasonCancel');
  const reasonError = document.getElementById('ashReasonError');
  let pendingStatus = null;

  function buttonsHtml() {
    const btns = [];
    if (entity.status !== 'active') btns.push(`<button type="button" class="ash-detail-btn ash-detail-btn-primary" data-action="approve">${esc(tr('admin.entity.actionApprove', 'Approve'))}</button>`);
    if (entity.status !== 'rejected') btns.push(`<button type="button" class="ash-detail-btn ash-detail-btn-danger" data-action="reject">${esc(tr('admin.entity.actionReject', 'Reject'))}</button>`);
    if (entity.status === 'active') btns.push(`<button type="button" class="ash-detail-btn ash-detail-btn-danger" data-action="suspend">${esc(tr('admin.entity.actionSuspend', 'Suspend'))}</button>`);
    if (entity.status === 'suspended' || entity.status === 'rejected') btns.push(`<button type="button" class="ash-detail-btn ash-detail-btn-primary" data-action="reactivate">${esc(tr('admin.entity.actionReactivate', 'Reactivate'))}</button>`);
    btns.push(`<button type="button" class="ash-detail-btn" data-action="toggle-verify">${entity.verified ? esc(tr('admin.entity.actionUnverify', 'Remove verification')) : esc(tr('admin.entity.actionVerify', 'Verify'))}</button>`);
    return btns.join('');
  }
  wrap.innerHTML = buttonsHtml();

  function openReason(status) {
    pendingStatus = status;
    reasonWrap.classList.remove('hidden');
    reasonInput.value = '';
    reasonError.classList.add('hidden');
    reasonSubmit.textContent = tr('admin.entity.actionSubmit', 'Submit');
    reasonInput.focus();
  }
  reasonCancel.addEventListener('click', () => { reasonWrap.classList.add('hidden'); pendingStatus = null; });
  reasonSubmit.addEventListener('click', async () => {
    const reason = reasonInput.value.trim();
    if (!reason) {
      reasonError.textContent = tr('admin.entity.reasonRequired', 'A reason is required for this action.');
      reasonError.classList.remove('hidden');
      return;
    }
    try {
      await withBusyButton(reasonSubmit, () => onSetStatus(pendingStatus, reason));
      reasonWrap.classList.add('hidden');
      toast(tr('admin.entity.actionSuccess', 'Done.'), 'success');
    } catch (err) {
      reasonError.textContent = describeError(err);
      reasonError.classList.remove('hidden');
    }
  });

  wrap.querySelectorAll('[data-action]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const action = btn.dataset.action;
      if (action === 'approve') {
        try { await withBusyButton(btn, () => onSetStatus('active', null)); toast(tr('admin.entity.actionSuccess', 'Done.'), 'success'); }
        catch (err) { toast(describeError(err), 'error'); }
      } else if (action === 'reject') openReason('rejected');
      else if (action === 'suspend') openReason('suspended');
      else if (action === 'reactivate') {
        try { await withBusyButton(btn, () => onSetStatus('active', null)); toast(tr('admin.entity.actionSuccess', 'Done.'), 'success'); }
        catch (err) { toast(describeError(err), 'error'); }
      } else if (action === 'toggle-verify') {
        try { await withBusyButton(btn, () => onSetVerified(!entity.verified)); toast(tr('admin.entity.actionSuccess', 'Done.'), 'success'); }
        catch (err) { toast(describeError(err), 'error'); }
      }
    });
  });
}

function notesHtml(notes) {
  if (!notes.length) return `<p class="ash-detail-note-text" style="opacity:.7">${esc(tr('admin.entity.noNotes', 'No notes yet.'))}</p>`;
  return notes.map((n) => `
    <div class="ash-detail-note">
      <div class="ash-detail-note-meta">${esc(n.authorName || n.authorUid || '—')} · ${esc(fmtDateTime(n.createdAt))}</div>
      <div class="ash-detail-note-text">${esc(n.text)}</div>
    </div>
  `).join('');
}
function wireNotesSection({ listNotes, addNote }) {
  const list = document.getElementById('ashNotesList');
  const input = document.getElementById('ashNoteInput');
  const btn = document.getElementById('ashNoteAddBtn');
  async function refresh() {
    list.innerHTML = `<p class="ash-detail-note-text" style="opacity:.6">${esc(tr('admin.entity.loading', 'Loading…'))}</p>`;
    try { list.innerHTML = notesHtml(await listNotes()); }
    catch { list.innerHTML = `<p class="ash-detail-note-text" style="color:var(--ash-error)">${esc(tr('admin.entity.loadFailed', 'Could not load.'))}</p>`; }
  }
  btn.addEventListener('click', async () => {
    const text = input.value.trim();
    if (!text) return;
    try {
      await withBusyButton(btn, () => addNote(text));
      input.value = '';
      await refresh();
      toast(tr('admin.entity.noteAdded', 'Note added.'), 'success');
    } catch (err) { toast(describeError(err), 'error'); }
  });
  refresh();
}

function docsHtml(files) {
  if (!files.length) return `<p class="ash-detail-note-text" style="opacity:.7">${esc(tr('admin.entity.noDocs', 'No verification documents uploaded.'))}</p>`;
  return files.map((f, i) => `
    <div class="ash-detail-related-link">
      <span>${esc(f.name)}</span>
      <button type="button" class="ash-detail-btn" data-doc-idx="${i}">${esc(tr('admin.entity.viewDoc', 'View'))}</button>
    </div>
  `).join('');
}
function wireDocsSection({ collectionName, entityId }) {
  const host = document.getElementById('ashDocsList');
  host.innerHTML = `<p class="ash-detail-note-text" style="opacity:.6">${esc(tr('admin.entity.loading', 'Loading…'))}</p>`;
  listAll(storageRef(storage, `verification-docs/${collectionName}/${entityId}`)).then((res) => {
    host.innerHTML = docsHtml(res.items);
    host.querySelectorAll('[data-doc-idx]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const item = res.items[parseInt(btn.dataset.docIdx, 10)];
        try {
          const bytes = await withBusyButton(btn, () => getBytes(item));
          const blobUrl = URL.createObjectURL(new Blob([bytes]));
          window.open(blobUrl, '_blank', 'noopener');
        } catch { toast(tr('admin.entity.actionFailed', 'Could not complete this action right now.'), 'error'); }
      });
    });
  }).catch(() => { host.innerHTML = `<p class="ash-detail-note-text" style="opacity:.7">${esc(tr('admin.entity.noDocs', 'No verification documents uploaded.'))}</p>`; });
}

function relatedHtml(items, emptyKey, emptyFallback) {
  if (!items.length) return `<p class="ash-detail-note-text" style="opacity:.7">${esc(tr(emptyKey, emptyFallback))}</p>`;
  return items.map((it) => `<div class="ash-detail-related-link"><span>${esc(it.label)}</span><span>${esc(it.meta || '')}</span></div>`).join('');
}

function auditHtml(entries) {
  if (!entries.length) return `<p class="ash-detail-note-text" style="opacity:.7">${esc(tr('admin.entity.noAudit', 'No audit history yet.'))}</p>`;
  return `<div class="ash-detail-timeline">` + entries.map((e) => `
    <div class="ash-detail-timeline-item">
      <span class="ash-detail-timeline-dot"></span>
      <div>
        <div>${esc(e.action || '—')}${e.newValue !== undefined ? ' → ' + esc(String(e.newValue)) : ''}</div>
        <div class="ash-detail-timeline-time">${esc(e.actorUid || '—')} · ${esc(fmtDateTime(e.timestamp))}</div>
      </div>
    </div>
  `).join('') + `</div>`;
}
async function fetchAuditFor(targetId) {
  const snap = await getDocs(query(
    collection(db, 'accessAuditLog'),
    where('targetType', '==', 'organization'),
    where('targetId', '==', targetId),
    orderBy('timestamp', 'desc'),
    fsLimit(20)
  ));
  return snap.docs.map((d) => d.data());
}
async function fetchAuditForProvider(providerId) {
  const snap = await getDocs(query(
    collection(db, 'accessAuditLog'),
    where('targetType', '==', 'serviceProvider'),
    where('targetId', '==', providerId),
    orderBy('timestamp', 'desc'),
    fsLimit(20)
  ));
  return snap.docs.map((d) => d.data());
}

async function openOrgDetail(collectionName, id) {
  const entity = orgsState.all.find((r) => r.collection === collectionName && r.id === id);
  if (!entity) return;
  const isOrg = collectionName === 'organizations';
  const memberCollection = isOrg ? 'members' : 'employees';

  openDetailWith(entity.name, `${orgTypeLabel(entity.type)} · ${entity.city || '—'}`, `
    ${statusActionsHtml()}
    <div>
      <div class="ash-detail-section-title" data-i18n="admin.entity.sectionOverview">Overview</div>
      <dl class="ash-detail-kv">
        <dt data-i18n="admin.orgs.thType">Type</dt><dd>${esc(orgTypeLabel(entity.type))}</dd>
        <dt data-i18n="admin.orgs.thCity">City</dt><dd>${esc(entity.city || '—')}</dd>
        <dt data-i18n="admin.entity.district">District</dt><dd>${esc(entity.district || '—')}</dd>
        <dt data-i18n="admin.entity.ownerId">Owner UID</dt><dd>${esc(entity.ownerId || '—')}</dd>
        <dt data-i18n="admin.entity.created">Created</dt><dd>${esc(fmtDate(entity.createdAt))}</dd>
        ${entity.rejectionReason ? `<dt data-i18n="admin.entity.lastReason">Last reason</dt><dd>${esc(entity.rejectionReason)}</dd>` : ''}
      </dl>
    </div>
    <div>
      <div class="ash-detail-section-title" data-i18n="admin.orgs.sectionMembers">Members &amp; ownership</div>
      <div id="ashMembersList" style="display:flex; flex-direction:column; gap:8px;"></div>
      <div style="display:flex; gap:8px; margin-top:10px;">
        <input type="text" id="ashInviteUidInput" class="ash-detail-textarea" style="min-height:unset;" data-i18n-placeholder="admin.orgs.inviteUidPlaceholder" placeholder="User UID to invite as staff…">
        <button type="button" class="ash-detail-btn" id="ashInviteBtn" data-i18n="admin.orgs.invite">Invite</button>
      </div>
      ${isOrg ? `
      <div style="display:flex; gap:8px; margin-top:10px;">
        <input type="text" id="ashTransferUidInput" class="ash-detail-textarea" style="min-height:unset;" data-i18n-placeholder="admin.orgs.transferOwnerPlaceholder" placeholder="New owner UID…">
        <button type="button" class="ash-detail-btn" id="ashTransferBtn" data-i18n="admin.orgs.transferOwnership">Transfer ownership</button>
      </div>` : ''}
    </div>
    <div>
      <div class="ash-detail-section-title" data-i18n="admin.entity.sectionRelated">Related records</div>
      <div id="ashRelatedList" style="display:flex; flex-direction:column; gap:6px;"></div>
    </div>
    <div>
      <div class="ash-detail-section-title" data-i18n="admin.entity.sectionDocs">Verification documents</div>
      <div id="ashDocsList" style="display:flex; flex-direction:column; gap:6px;"></div>
    </div>
    <div>
      <div class="ash-detail-section-title" data-i18n="admin.entity.sectionNotes">Private admin notes</div>
      <div id="ashNotesList" style="display:flex; flex-direction:column; gap:8px; margin-bottom:10px;"></div>
      <textarea class="ash-detail-textarea" id="ashNoteInput" data-i18n-placeholder="admin.entity.notePlaceholder" placeholder="Add a private note (never visible to the owner)…"></textarea>
      <button type="button" class="ash-detail-btn" id="ashNoteAddBtn" style="margin-top:8px;" data-i18n="admin.entity.addNote">Add note</button>
    </div>
    <div>
      <div class="ash-detail-section-title" data-i18n="admin.entity.sectionAudit">Audit timeline</div>
      <div id="ashAuditList"></div>
    </div>
  `);

  wireStatusActions({
    entity,
    onSetStatus: async (status, reason) => {
      const user = currentUser();
      if (isOrg) await setOrganizationStatus(user, id, status, reason);
      else await setCompanyStatus(user, id, status, reason);
      entity.status = status; entity.rejectionReason = status === 'rejected' || status === 'suspended' ? reason : null;
      fetchOrganizationsData();
    },
    onSetVerified: async (verified) => {
      const user = currentUser();
      if (isOrg) await setOrganizationVerified(user, id, verified);
      else await setCompanyVerified(user, id, verified);
      entity.verified = verified;
      fetchOrganizationsData();
    },
  });

  // Members / staff
  const membersList = document.getElementById('ashMembersList');
  async function refreshMembers() {
    membersList.innerHTML = `<p class="ash-detail-note-text" style="opacity:.6">${esc(tr('admin.entity.loading', 'Loading…'))}</p>`;
    const snap = await getDocs(collection(db, collectionName, id, memberCollection));
    const rows = snap.docs.map((d) => ({ uid: d.id, ...d.data() }));
    if (!rows.length) { membersList.innerHTML = `<p class="ash-detail-note-text" style="opacity:.7">${esc(tr('admin.orgs.noMembers', 'No staff members yet.'))}</p>`; return; }
    membersList.innerHTML = rows.map((m) => `
      <div class="ash-detail-related-link">
        <span>${esc(m.uid)} · ${esc(m.status || '—')}</span>
        <span style="display:flex; gap:6px;">
          ${m.status === 'pending' ? `<button type="button" class="ash-detail-btn" data-m-action="approve" data-m-uid="${esc(m.uid)}">${esc(tr('admin.entity.actionApprove', 'Approve'))}</button>
             <button type="button" class="ash-detail-btn ash-detail-btn-danger" data-m-action="reject" data-m-uid="${esc(m.uid)}">${esc(tr('admin.entity.actionReject', 'Reject'))}</button>` : ''}
          ${m.status === 'active' || m.status === 'invited' ? `<button type="button" class="ash-detail-btn ash-detail-btn-danger" data-m-action="remove" data-m-uid="${esc(m.uid)}">${esc(tr('admin.orgs.remove', 'Remove'))}</button>` : ''}
        </span>
      </div>
    `).join('');
    membersList.querySelectorAll('[data-m-action]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const uid = btn.dataset.mUid, action = btn.dataset.mAction, user = currentUser();
        try {
          await withBusyButton(btn, async () => {
            if (isOrg) {
              if (action === 'approve') await approveOrganizationMembership(user, id, uid);
              else if (action === 'reject') await rejectOrganizationMembership(user, id, uid);
              else if (action === 'remove') await removeOrganizationMember(user, id, uid);
            } else {
              if (action === 'approve') await approveCompanyMembership(user, id, uid);
              else if (action === 'reject') await rejectCompanyMembership(user, id, uid);
              else if (action === 'remove') await removeCompanyEmployee(user, id, uid);
            }
          });
          toast(tr('admin.entity.actionSuccess', 'Done.'), 'success');
          refreshMembers();
        } catch (err) { toast(describeError(err), 'error'); }
      });
    });
  }
  refreshMembers();
  document.getElementById('ashInviteBtn').addEventListener('click', async (e) => {
    const input = document.getElementById('ashInviteUidInput');
    const uid = input.value.trim();
    if (!uid) return;
    try {
      await withBusyButton(e.currentTarget, () => isOrg ? inviteOrganizationMember(currentUser(), id, uid) : inviteCompanyEmployee(currentUser(), id, uid));
      input.value = '';
      toast(tr('admin.entity.actionSuccess', 'Done.'), 'success');
      refreshMembers();
    } catch (err) { toast(describeError(err), 'error'); }
  });
  const transferBtn = document.getElementById('ashTransferBtn');
  if (transferBtn) {
    transferBtn.addEventListener('click', async (e) => {
      const input = document.getElementById('ashTransferUidInput');
      const uid = input.value.trim();
      if (!uid) return;
      try {
        await withBusyButton(e.currentTarget, () => transferOrganizationOwnership(currentUser(), id, uid));
        input.value = '';
        entity.ownerId = uid;
        toast(tr('admin.entity.actionSuccess', 'Done.'), 'success');
      } catch (err) { toast(describeError(err), 'error'); }
    });
  }

  // Related records: real linkage fields only (organizations.organizationId
  // on projects / publisherOrgId on listings; companies.companyId on
  // listings) -- never a fabricated count.
  (async () => {
    const host = document.getElementById('ashRelatedList');
    try {
      const items = [];
      if (isOrg) {
        const [projSnap, listSnap] = await Promise.all([
          getDocs(query(collection(db, 'projects'), where('organizationId', '==', id))),
          getDocs(query(collection(db, 'listings'), where('publisherOrgId', '==', id))),
        ]);
        projSnap.forEach((d) => items.push({ label: d.data().name || d.id, meta: tr('admin.entity.project', 'Project') }));
        listSnap.forEach((d) => items.push({ label: d.data().title || d.id, meta: tr('admin.entity.listing', 'Listing') }));
      } else {
        const listSnap = await getDocs(query(collection(db, 'listings'), where('companyId', '==', id)));
        listSnap.forEach((d) => items.push({ label: d.data().title || d.id, meta: tr('admin.entity.listing', 'Listing') }));
      }
      host.innerHTML = relatedHtml(items, 'admin.entity.noRelated', 'No related properties or projects found.');
    } catch { host.innerHTML = relatedHtml([], 'admin.entity.noRelated', 'No related properties or projects found.'); }
  })();

  wireDocsSection({ collectionName, entityId: id });
  wireNotesSection({
    listNotes: async () => {
      const snap = await getDocs(query(collection(db, collectionName, id, 'adminNotes'), orderBy('createdAt', 'desc')));
      return snap.docs.map((d) => d.data());
    },
    addNote: async (text) => {
      const user = currentUser();
      const authorName = (user && user.displayName) || null;
      if (isOrg) await addOrganizationNote(user, id, text, authorName);
      else await addCompanyNote(user, id, text, authorName);
    },
  });

  (async () => {
    const host = document.getElementById('ashAuditList');
    host.innerHTML = `<p class="ash-detail-note-text" style="opacity:.6">${esc(tr('admin.entity.loading', 'Loading…'))}</p>`;
    try { host.innerHTML = auditHtml(await fetchAuditFor(id)); }
    catch { host.innerHTML = auditHtml([]); }
  })();
}

// ---------------------------------------------------------------------
// Professionals: `serviceProviders`
// ---------------------------------------------------------------------

const PRO_TYPE_LABELS = {
  engineer: ['admin.pros.typeEngineer', 'Engineer'],
  designer: ['admin.pros.typeDesigner', 'Designer'],
  lawyer: ['admin.pros.typeLawyer', 'Lawyer'],
  landscaping: ['admin.pros.typeLandscaping', 'Landscaping Provider'],
  cleaning: ['admin.pros.typeCleaning', 'Cleaning Provider'],
  maintenance: ['admin.pros.typeMaintenance', 'Maintenance Provider'],
};
function proTypeLabel(type) {
  const [key, fallback] = PRO_TYPE_LABELS[type] || [null, type || '—'];
  return key ? tr(key, fallback) : fallback;
}

const prosState = { inited: false, loading: false, error: null, all: [], search: '', type: 'all', status: 'all', sort: 'name-asc', page: 1, pageSize: 20 };

async function fetchProfessionalsData() {
  prosState.loading = true; prosState.error = null;
  renderProfessionalsTab();
  try {
    const snap = await getDocs(collection(db, 'serviceProviders'));
    prosState.all = snap.docs.map((d) => {
      const data = d.data();
      return {
        id: d.id, name: data.displayName || data.companyName || '(unnamed)', type: data.serviceType || '—',
        city: data.city || '', district: data.district || '', ownerId: data.ownerId || null,
        verified: !!data.verified, status: computeStatus(data), rejectionReason: data.rejectionReason || null,
        createdAt: data.createdAt || null,
      };
    });
    prosState.page = 1;
  } catch (err) {
    prosState.error = err;
  } finally {
    prosState.loading = false;
    renderProfessionalsTab();
  }
}

function ensureProsShell() {
  const section = document.getElementById('tab-professionals');
  if (!section || section.dataset.ashBuilt === '1') return;
  section.dataset.ashBuilt = '1';
  section.innerHTML = `
    <div class="ash-entity-toolbar">
      <div class="ash-entity-search">
        <span class="material-symbols-outlined" aria-hidden="true">search</span>
        <input type="text" id="prosSearchInput" data-i18n-placeholder="admin.pros.searchPlaceholder" placeholder="Search professionals by name or city…">
      </div>
      <select id="prosTypeFilter" class="ash-entity-select"></select>
      <select id="prosStatusFilter" class="ash-entity-select"></select>
      <select id="prosSortSelect" class="ash-entity-select"></select>
      <span class="ash-entity-count" id="prosCount"></span>
    </div>
    <div class="ash-entity-table-wrap bg-surface-container-lowest border border-outline-variant rounded-xl overflow-hidden">
      <div class="overflow-x-auto">
        <table class="admin-table">
          <thead><tr>
            <th data-i18n="admin.pros.thName">Name</th>
            <th data-i18n="admin.pros.thType">Profession</th>
            <th data-i18n="admin.orgs.thCity">City</th>
            <th data-i18n="admin.orgs.thStatus">Status</th>
            <th data-i18n="admin.orgs.thVerified">Verified</th>
          </tr></thead>
          <tbody id="prosTableBody"></tbody>
        </table>
      </div>
    </div>
    <div class="ash-entity-cards" id="prosCards"></div>
    <div id="prosPagination" class="ash-entity-pagination"></div>
  `;
  document.getElementById('prosTypeFilter').innerHTML =
    `<option value="all" data-i18n="admin.filterAll">All professions</option>` +
    Object.keys(PRO_TYPE_LABELS).map((t) => `<option value="${t}">${esc(proTypeLabel(t))}</option>`).join('');
  document.getElementById('prosStatusFilter').innerHTML =
    `<option value="all" data-i18n="admin.filterAll">All statuses</option>` +
    Object.keys(STATUS_LABEL_KEY).map((s) => `<option value="${s}">${esc(tr(...STATUS_LABEL_KEY[s]))}</option>`).join('');
  document.getElementById('prosSortSelect').innerHTML = `
    <option value="name-asc" data-i18n="admin.entity.sortNameAsc">Name (A–Z)</option>
    <option value="name-desc" data-i18n="admin.entity.sortNameDesc">Name (Z–A)</option>
    <option value="newest" data-i18n="admin.entity.sortNewest">Newest first</option>
    <option value="oldest" data-i18n="admin.entity.sortOldest">Oldest first</option>
  `;
  let searchTimer = null;
  document.getElementById('prosSearchInput').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    const val = e.target.value;
    searchTimer = setTimeout(() => { prosState.search = val; prosState.page = 1; renderProfessionalsTab(); }, 180);
  });
  document.getElementById('prosTypeFilter').addEventListener('change', (e) => { prosState.type = e.target.value; prosState.page = 1; renderProfessionalsTab(); });
  document.getElementById('prosStatusFilter').addEventListener('change', (e) => { prosState.status = e.target.value; prosState.page = 1; renderProfessionalsTab(); });
  document.getElementById('prosSortSelect').addEventListener('change', (e) => { prosState.sort = e.target.value; renderProfessionalsTab(); });
}

function renderProfessionalsTab() {
  ensureProsShell();
  const tbody = document.getElementById('prosTableBody');
  const cards = document.getElementById('prosCards');
  const countEl = document.getElementById('prosCount');
  if (!tbody || !cards) return;

  if (prosState.loading && !prosState.all.length) {
    tbody.innerHTML = Array.from({ length: 5 }).map(() =>
      `<tr class="ash-entity-skeleton-row"><td colspan="5"><div class="ash-entity-skel" style="width:100%"></div></td></tr>`
    ).join('');
    cards.innerHTML = '';
    countEl.textContent = '';
    document.getElementById('prosPagination').innerHTML = '';
    return;
  }
  if (prosState.error) {
    tbody.innerHTML = '';
    cards.innerHTML = `<div class="ash-entity-error">${esc(tr('admin.entity.loadFailedPros', 'Could not load professionals.'))}
      <div><button type="button" class="ash-entity-retry" id="prosRetryBtn">${esc(tr('admin.entity.retry', 'Retry'))}</button></div></div>`;
    document.getElementById('prosRetryBtn')?.addEventListener('click', fetchProfessionalsData);
    countEl.textContent = '';
    document.getElementById('prosPagination').innerHTML = '';
    return;
  }

  const rows = filterSortEntities(prosState.all, { search: prosState.search, typeFilter: prosState.type, statusFilter: prosState.status, sort: prosState.sort });
  countEl.textContent = tr('admin.entity.countLabelPros', '{n} professionals').replace('{n}', String(rows.length));
  if (!rows.length) {
    tbody.innerHTML = '';
    cards.innerHTML = `<div class="ash-entity-empty">${esc(tr('admin.entity.noResults', 'No professionals match your filters.'))}</div>`;
    document.getElementById('prosPagination').innerHTML = '';
    return;
  }
  const start = (prosState.page - 1) * prosState.pageSize;
  const pageRows = rows.slice(start, start + prosState.pageSize);

  tbody.innerHTML = pageRows.map((r) => `
    <tr class="ash-entity-row" data-id="${esc(r.id)}">
      <td>${esc(r.name)}</td>
      <td>${esc(proTypeLabel(r.type))}</td>
      <td>${esc(r.city || '—')}</td>
      <td>${statusBadgeHtml(r.status)}</td>
      <td>${r.verified ? `<span class="badge badge-verified">${esc(tr('common.verified', 'Verified'))}</span>` : '—'}</td>
    </tr>
  `).join('');
  cards.innerHTML = pageRows.map((r) => `
    <div class="ash-entity-card" data-id="${esc(r.id)}">
      <div class="ash-entity-card-head">
        <div>
          <div class="ash-entity-card-title">${esc(r.name)}</div>
          <div class="ash-entity-card-sub">${esc(proTypeLabel(r.type))} · ${esc(r.city || '—')}</div>
        </div>
        ${statusBadgeHtml(r.status)}
      </div>
      <div class="ash-entity-card-meta">${r.verified ? `<span class="badge badge-verified">${esc(tr('common.verified', 'Verified'))}</span>` : ''}</div>
    </div>
  `).join('');

  Array.from(tbody.querySelectorAll('.ash-entity-row')).concat(Array.from(cards.querySelectorAll('.ash-entity-card'))).forEach((el) => {
    el.addEventListener('click', () => openProDetail(el.dataset.id));
  });

  renderPagination('prosPagination', rows.length, prosState, (p) => { prosState.page = p; renderProfessionalsTab(); });
}

async function openProDetail(id) {
  const entity = prosState.all.find((r) => r.id === id);
  if (!entity) return;

  openDetailWith(entity.name, `${proTypeLabel(entity.type)} · ${entity.city || '—'}`, `
    ${statusActionsHtml()}
    <div>
      <div class="ash-detail-section-title" data-i18n="admin.entity.sectionOverview">Overview</div>
      <dl class="ash-detail-kv">
        <dt data-i18n="admin.pros.thType">Profession</dt><dd>${esc(proTypeLabel(entity.type))}</dd>
        <dt data-i18n="admin.orgs.thCity">City</dt><dd>${esc(entity.city || '—')}</dd>
        <dt data-i18n="admin.entity.district">District</dt><dd>${esc(entity.district || '—')}</dd>
        <dt data-i18n="admin.entity.ownerId">Owner UID</dt><dd>${esc(entity.ownerId || '—')}</dd>
        <dt data-i18n="admin.entity.created">Created</dt><dd>${esc(fmtDate(entity.createdAt))}</dd>
        ${entity.rejectionReason ? `<dt data-i18n="admin.entity.lastReason">Last reason</dt><dd>${esc(entity.rejectionReason)}</dd>` : ''}
      </dl>
    </div>
    <div>
      <div class="ash-detail-section-title" data-i18n="admin.pros.sectionStats">Response statistics</div>
      <div class="ash-detail-stat-grid" id="ashStatsGrid"></div>
    </div>
    <div>
      <div class="ash-detail-section-title" data-i18n="admin.pros.sectionRequests">Related service requests</div>
      <div id="ashRelatedList" style="display:flex; flex-direction:column; gap:6px;"></div>
    </div>
    <div>
      <div class="ash-detail-section-title" data-i18n="admin.entity.sectionDocs">Verification documents</div>
      <div id="ashDocsList" style="display:flex; flex-direction:column; gap:6px;"></div>
    </div>
    <div>
      <div class="ash-detail-section-title" data-i18n="admin.entity.sectionNotes">Private admin notes</div>
      <div id="ashNotesList" style="display:flex; flex-direction:column; gap:8px; margin-bottom:10px;"></div>
      <textarea class="ash-detail-textarea" id="ashNoteInput" data-i18n-placeholder="admin.entity.notePlaceholder" placeholder="Add a private note (never visible to the owner)…"></textarea>
      <button type="button" class="ash-detail-btn" id="ashNoteAddBtn" style="margin-top:8px;" data-i18n="admin.entity.addNote">Add note</button>
    </div>
    <div>
      <div class="ash-detail-section-title" data-i18n="admin.entity.sectionAudit">Audit timeline</div>
      <div id="ashAuditList"></div>
    </div>
  `);

  wireStatusActions({
    entity,
    onSetStatus: async (status, reason) => {
      await setProviderStatus(currentUser(), id, status, reason);
      entity.status = status; entity.rejectionReason = status === 'rejected' || status === 'suspended' ? reason : null;
      fetchProfessionalsData();
    },
    onSetVerified: async (verified) => {
      await setProviderVerified(currentUser(), id, verified);
      entity.verified = verified;
      fetchProfessionalsData();
    },
  });

  // Real response statistics only -- computed from the provider's own
  // requests subcollection, never fabricated (no ratings/reviews data
  // exists anywhere in this schema).
  (async () => {
    const host = document.getElementById('ashStatsGrid');
    const relatedHost = document.getElementById('ashRelatedList');
    try {
      const snap = await getDocs(collection(db, 'serviceProviders', id, 'requests'));
      const counts = { total: 0, pending: 0, accepted: 0, declined: 0, completed: 0 };
      const items = [];
      snap.forEach((d) => {
        const data = d.data();
        counts.total++;
        const st = data.status || 'pending';
        if (counts[st] !== undefined) counts[st]++;
        items.push({ label: data.customerName || data.customerUid || d.id, meta: st });
      });
      host.innerHTML = ['total', 'pending', 'accepted', 'declined', 'completed'].map((k) => `
        <div class="ash-detail-stat">
          <div class="ash-detail-stat-value">${counts[k]}</div>
          <div class="ash-detail-stat-label">${esc(tr('admin.pros.stat.' + k, k))}</div>
        </div>
      `).join('');
      relatedHost.innerHTML = relatedHtml(items, 'admin.pros.noRequests', 'No service requests yet.');
    } catch {
      host.innerHTML = '';
      relatedHost.innerHTML = relatedHtml([], 'admin.pros.noRequests', 'No service requests yet.');
    }
  })();

  wireDocsSection({ collectionName: 'serviceProviders', entityId: id });
  wireNotesSection({
    listNotes: async () => {
      const snap = await getDocs(query(collection(db, 'serviceProviders', id, 'adminNotes'), orderBy('createdAt', 'desc')));
      return snap.docs.map((d) => d.data());
    },
    addNote: async (text) => {
      const user = currentUser();
      await addProviderNote(user, id, text, (user && user.displayName) || null);
    },
  });

  (async () => {
    const host = document.getElementById('ashAuditList');
    host.innerHTML = `<p class="ash-detail-note-text" style="opacity:.6">${esc(tr('admin.entity.loading', 'Loading…'))}</p>`;
    try { host.innerHTML = auditHtml(await fetchAuditForProvider(id)); }
    catch { host.innerHTML = auditHtml([]); }
  })();
}

// ---------------------------------------------------------------------
// Public entry points, called from admin.html's tab-dispatch block.
// ---------------------------------------------------------------------

export function renderOrgsTab() {
  if (!orgsState.inited) { orgsState.inited = true; fetchOrganizationsData(); return; }
  renderOrganizationsTab();
}
export function renderProsTab() {
  if (!prosState.inited) { prosState.inited = true; fetchProfessionalsData(); return; }
  renderProfessionalsTab();
}
document.addEventListener('darwesh:langchange', () => {
  if (orgsState.inited) renderOrganizationsTab();
  if (prosState.inited) renderProfessionalsTab();
});
