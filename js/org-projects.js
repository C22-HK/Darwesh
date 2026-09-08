// Darwesh Group -- Organization project authoring/management (org-projects.html).
//
// Reuses the real schema, auth, and organization-permission system this
// session discovered already exists in firestore.rules/backend/app/access
// but had ZERO frontend consumer before this file: projects/{id} (+ its
// floorPlans subcollection), organizations/{id} (ownerId + type ==
// 'developer_project'|'residential_community'), and hasOrgPermission()'s
// 'create_project'/'edit_own_project'/'manage_floor_plans' keys. This page
// does not re-implement any of that authorization -- it only builds the
// write and lets firestore.rules be the one that actually decides whether
// it's allowed. See the end-of-session report for the one real, disclosed
// gap this surfaces: whether a given organization's owner/staff actually
// HOLD those permission keys depends on `rolePermissionDefaults` (or a
// per-member override), both entirely backend/admin-configured -- nothing
// here can grant a permission a real project's write still needs.
import { auth, db, storage, getDoc, getDocs, addDoc, updateDoc, setDoc } from './firebase-init.js';
import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/12.18.0/firebase-auth.js';
import { doc, collection, query, where, limit, serverTimestamp } from 'https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js';
import { ref as storageRef, uploadBytes, getDownloadURL } from 'https://www.gstatic.com/firebasejs/12.18.0/firebase-storage.js';
import { compressImage, PORTFOLIO_IMAGE, createUploadGate } from './image-compress.js';

function tr(key, fallback) { return (window.t && window.t(key)) || fallback; }
const el = (id) => document.getElementById(id);
function show(id) { const n = el(id); if (n) n.classList.remove('hidden'); }
function hide(id) { const n = el(id); if (n) n.classList.add('hidden'); }
const esc = window.escapeHtml;
const isSafeUrl = window.isSafeHttpUrl;

const ORG_TYPES = ['developer_project', 'residential_community'];
const AMENITY_KEYS = ['security', 'parking', 'electricity', 'water', 'elevator', 'garden', 'playground', 'pool', 'gym'];
const uploadGate = createUploadGate();

let orgs = [];
let activeOrg = null;
let orgProjects = [];
let editingProject = null; // {id, ...} or null (new)
let editingFloorPlans = [];

function money(n) { return typeof n === 'number' ? n : (n ? Number(n) : null); }

// ---- auth + org discovery ------------------------------------------------
onAuthStateChanged(auth, async (user) => {
  if (!user) { hide('opLoadingGate'); show('opSignedOut'); return; }
  await loadMyOrgs(user.uid);
});

async function loadMyOrgs(uid) {
  // Primary path: organizations this user OWNS (a direct, simple,
  // single-field-index query). A non-owner staff member with no owned org
  // reaches their org only via a real ?org=<id> deep link below -- there
  // is no "list every org I merely belong to" query available client-side
  // without the backend's own GET /me/organizations endpoint (which this
  // page deliberately does not call, to stay a pure Firestore-rules-
  // enforced flow) -- a disclosed, real scope limit, not silently assumed
  // away.
  try {
    const snap = await getDocs(query(collection(db, 'organizations'), where('ownerId', '==', uid), limit(20)));
    orgs = [];
    snap.forEach((d) => { const data = d.data(); if (ORG_TYPES.includes(data.type)) orgs.push({ id: d.id, ...data }); });
  } catch { orgs = []; }

  const deepLinkOrgId = new URLSearchParams(window.location.search).get('org');
  if (deepLinkOrgId && !orgs.find((o) => o.id === deepLinkOrgId)) {
    try {
      const s = await getDoc(doc(db, 'organizations', deepLinkOrgId));
      if (s.exists() && ORG_TYPES.includes(s.data().type)) orgs.push({ id: s.id, ...s.data() });
    } catch { /* not accessible / doesn't exist -- ignored, not added */ }
  }

  hide('opLoadingGate');
  if (!orgs.length) { show('opNoOrgs'); return; }
  show('opContent');
  renderOrgPicker();
  selectOrg(orgs[0]);
}

function renderOrgPicker() {
  const wrap = el('opOrgPicker');
  if (orgs.length <= 1) { hide('opOrgPicker'); return; }
  show('opOrgPicker');
  wrap.innerHTML = orgs.map((o) => `
    <button type="button" class="op-org-card" data-id="${esc(o.id)}">
      <span class="font-body-md text-[13.5px] font-semibold">${esc(o.name || o.id)}</span>
      <span class="material-symbols-outlined text-[16px]" aria-hidden="true">chevron_right</span>
    </button>`).join('');
  wrap.querySelectorAll('.op-org-card').forEach((btn) => {
    btn.addEventListener('click', () => selectOrg(orgs.find((o) => o.id === btn.dataset.id)));
  });
}

async function selectOrg(org) {
  activeOrg = org;
  document.querySelectorAll('.op-org-card').forEach((c) => c.classList.toggle('is-active', c.dataset.id === org.id));
  showListView();
  await loadOrgProjects();
}

async function loadOrgProjects() {
  try {
    const snap = await getDocs(query(collection(db, 'projects'), where('organizationId', '==', activeOrg.id), limit(60)));
    orgProjects = [];
    snap.forEach((d) => orgProjects.push({ id: d.id, ...d.data() }));
  } catch { orgProjects = []; }
  renderProjectList();
}

// Admin-approval-before-publication status badge -- shown everywhere a
// project's own state matters (list row, form header). A project is never
// publicly visible (projects.html/project.html) until an admin flips this
// to 'published' -- see firestore.rules' isProjectPubliclyVisible().
const PUBLICATION_STATUS_META = {
  draft: { i18n: 'op.statusDraft', fallback: 'Draft', style: 'background:rgba(129,146,167,.15); color:#8192a7;' },
  pending_review: { i18n: 'op.statusPendingReview', fallback: 'Pending Review', style: 'background:rgba(198,154,75,.15); color:#C69A4B;' },
  published: { i18n: 'op.statusPublished', fallback: 'Published', style: 'background:rgba(127,184,154,.15); color:#7FB89A;' },
  changes_requested: { i18n: 'op.statusChangesRequested', fallback: 'Changes Requested', style: 'background:rgba(224,122,95,.15); color:#E07A5F;' },
  rejected: { i18n: 'op.statusRejected', fallback: 'Rejected', style: 'background:rgba(196,90,90,.15); color:#C45A5A;' }
};
function publicationBadge(status) {
  const meta = PUBLICATION_STATUS_META[status] || PUBLICATION_STATUS_META.draft;
  return `<span class="font-label-caps text-[10.5px] font-bold uppercase px-2 py-0.5 rounded-full" style="${meta.style}">${esc(tr(meta.i18n, meta.fallback))}</span>`;
}

function renderProjectList() {
  const wrap = el('opProjectList');
  if (!orgProjects.length) { wrap.innerHTML = ''; show('opNoProjects'); return; }
  hide('opNoProjects');
  wrap.innerHTML = orgProjects.map((p) => `
    <div class="op-proj-row">
      <div class="flex items-center gap-3 min-w-0">
        ${isSafeUrl(p.coverImageUrl) ? `<img class="op-thumb" src="${esc(p.coverImageUrl)}" alt=""/>` : `<div class="op-thumb flex items-center justify-center"><span class="material-symbols-outlined text-[18px]" aria-hidden="true">apartment</span></div>`}
        <div class="min-w-0">
          <p class="font-body-md text-[13.5px] font-semibold truncate">${esc(p.name || '')}</p>
          <p class="font-body-md text-[12px] text-on-surface-variant flex items-center gap-1.5 mt-0.5">${esc(p.city || '')}${p.verified ? ' · ' + esc(tr('rp.verified', 'Verified')) : ''} ${publicationBadge(p.publicationStatus)} ${p.revisionStatus === 'pending_review' ? publicationBadge('pending_review') : ''}</p>
        </div>
      </div>
      <div class="flex items-center gap-2 flex-none">
        <a href="project.html?id=${encodeURIComponent(p.id)}" target="_blank" rel="noopener" class="op-btn op-btn-ghost" title="${esc(tr('proj.viewDetails', 'View details'))}"><span class="material-symbols-outlined text-[16px]" aria-hidden="true">open_in_new</span></a>
        <button type="button" class="op-btn op-btn-ghost" data-edit="${esc(p.id)}" data-i18n="common.edit">Edit</button>
      </div>
    </div>`).join('');
  wrap.querySelectorAll('[data-edit]').forEach((btn) => {
    btn.addEventListener('click', () => openForm(orgProjects.find((p) => p.id === btn.dataset.edit)));
  });
}

// ---- form view -------------------------------------------------------------
function showListView() { show('opListView'); hide('opFormView'); }
function showFormView() { hide('opListView'); show('opFormView'); }

el('opNewProjectBtn').addEventListener('click', () => openForm(null));
el('opBackToList').addEventListener('click', showListView);

function renderAmenityChips(selected) {
  el('opfAmenities').innerHTML = AMENITY_KEYS.map((k) => `
    <label class="op-check-chip"><input type="checkbox" data-amenity="${k}" ${selected && selected[k] ? 'checked' : ''}/> ${esc(tr('proj.amenity.' + k, k))}</label>
  `).join('');
}

function fmtDateInput(v) {
  try {
    const d = v && typeof v.toDate === 'function' ? v.toDate() : new Date(v);
    if (Number.isNaN(d.getTime())) return '';
    return d.toISOString().slice(0, 10);
  } catch { return ''; }
}

async function openForm(project) {
  editingProject = project;
  editingFloorPlans = [];
  el('opFormError').classList.add('hidden');
  el('opFormSuccess').classList.add('hidden');
  el('opFormTitle').innerHTML = `${esc(project ? tr('op.editProject', 'Edit Project') : tr('op.newProject', '+ New Project'))} ${project ? publicationBadge(project.publicationStatus) : ''}`;

  const feedbackEl = el('opReviewFeedback');
  const isPublished = project?.publicationStatus === 'published';
  if (project && project.revisionStatus === 'pending_review') {
    feedbackEl.textContent = tr('op.revisionPending', 'Your latest changes are awaiting admin review. The live public page still shows the last approved version until this is approved.');
    feedbackEl.classList.remove('hidden');
  } else if (project && project.revisionFeedback && project.revisionStatus === 'changes_requested') {
    feedbackEl.textContent = tr('op.revisionChangesRequested', 'Admin requested changes to your last revision: ') + project.revisionFeedback;
    feedbackEl.classList.remove('hidden');
  } else if (project && project.publicationStatus === 'changes_requested' && project.reviewFeedback) {
    feedbackEl.textContent = tr('op.changesRequested', 'Admin requested changes before this can be published: ') + project.reviewFeedback;
    feedbackEl.classList.remove('hidden');
  } else if (project && project.publicationStatus === 'rejected' && project.reviewFeedback) {
    feedbackEl.textContent = tr('op.rejected', 'This project was rejected: ') + project.reviewFeedback;
    feedbackEl.classList.remove('hidden');
  } else {
    feedbackEl.classList.add('hidden');
  }

  // Once published, content edits never touch the live public doc directly
  // (see firestore.rules) -- they're staged in private/pendingRevision and
  // only take effect once an admin approves them, so the currently-
  // approved public page stays live and unchanged while a new revision is
  // under review. isPublished is read by the submit handler below.
  el('opProjectForm').dataset.published = isPublished ? '1' : '';
  el('opFormSubmit').textContent = isPublished ? tr('op.submitRevision', 'Submit Revision for Review') : tr('common.save', 'Save');
  el('opSubmitForReviewBtn').classList.toggle('hidden', !project || isPublished || project.publicationStatus === 'pending_review');

  el('opfName').value = project?.name || '';
  el('opfType').value = project?.projectType || 'apartment';
  el('opfCity').value = project?.city || 'Kirkuk';
  el('opfDistrict').value = project?.district || project?.neighborhood || '';
  el('opfAddress').value = project?.address || '';
  el('opfLat').value = project?.location?.lat ?? '';
  el('opfLng').value = project?.location?.lng ?? '';
  el('opfDescription').value = project?.description || '';
  el('opfStatus').value = project?.constructionStatus || 'planning';
  el('opfHandoverDate').value = fmtDateInput(project?.handoverDate || project?.expectedCompletionDate);
  el('opfBuildings').value = project?.numberOfBuildings ?? '';
  el('opfUnits').value = project?.numberOfUnits ?? '';
  el('opfLandArea').value = project?.totalLandAreaSqm ?? '';
  renderAmenityChips(project?.amenities);
  el('opfStartingPrice').value = project?.startingPrice ?? '';
  el('opfPriceMax').value = project?.priceRangeMax ?? '';
  el('opfCurrency').value = project?.currency || 'USD';
  el('opfInstallmentAvailable').checked = !!project?.installmentAvailable;
  el('opfDownPct').value = project?.minDownPaymentPercent ?? '';
  el('opfMonthly').value = project?.monthlyInstallmentFrom ?? '';
  el('opfMonths').value = project?.paymentPeriodMonths ?? '';
  el('opfCoverFile').value = '';
  el('opfGalleryFiles').value = '';
  el('opfCoverPreview').classList.toggle('hidden', !isSafeUrl(project?.coverImageUrl));
  if (isSafeUrl(project?.coverImageUrl)) el('opfCoverPreview').src = project.coverImageUrl;
  renderGalleryPreview(Array.isArray(project?.gallery) ? project.gallery.slice() : []);
  el('opfPhone').value = '';

  if (project) {
    show('opFloorPlansSection');
    try {
      const snap = await getDocs(collection(db, 'projects', project.id, 'floorPlans'));
      editingFloorPlans = [];
      snap.forEach((d) => editingFloorPlans.push({ id: d.id, ...d.data() }));
    } catch { editingFloorPlans = []; }
    renderFloorPlanList();
    // The private contact doc is only readable by an org member/admin --
    // resolved best-effort so the field pre-fills for someone with access;
    // a denied read here just leaves the field blank (still editable/
    // savable), never surfaced as an error.
    try {
      const s = await getDoc(doc(db, 'projects', project.id, 'private', 'contact'));
      if (s.exists()) el('opfPhone').value = s.data().phone || '';
    } catch { /* no read access -- leave blank */ }
    show('opUnitsSection');
    await loadUnits(project.id);
  } else {
    hide('opFloorPlansSection');
    hide('opUnitsSection');
  }
  showFormView();
}

let pendingGalleryUrls = [];
function renderGalleryPreview(existingUrls) {
  pendingGalleryUrls = existingUrls;
  el('opfGalleryPreview').innerHTML = pendingGalleryUrls.map((u) => `<img src="${esc(u)}" style="width:56px;height:56px;object-fit:cover;border-radius:6px;" alt=""/>`).join('');
}

async function uploadProjectImage(file, projectIdForPath) {
  const compressed = await compressImage(file, PORTFOLIO_IMAGE);
  const path = `project-media/${projectIdForPath}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jpg`;
  const ref = storageRef(storage, path);
  await uploadBytes(ref, compressed);
  return getDownloadURL(ref);
}

el('opProjectForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!uploadGate.begin()) return;
  const errEl = el('opFormError');
  const okEl = el('opFormSuccess');
  errEl.classList.add('hidden');
  okEl.classList.add('hidden');
  const submitBtn = el('opFormSubmit');
  submitBtn.disabled = true;
  try {
    const amenities = {};
    document.querySelectorAll('[data-amenity]').forEach((cb) => { amenities[cb.dataset.amenity] = cb.checked; });

    const isNew = !editingProject;
    const isPublished = el('opProjectForm').dataset.published === '1';
    // Storage's project-media/{projectId}/... rule needs a REAL projectId
    // that already resolves to this org -- so for a brand-new project the
    // Firestore doc is created FIRST (with no images yet), then images
    // upload against that real id, then a second update attaches them.
    let projectId = editingProject?.id;
    const baseData = {
      organizationId: activeOrg.id,
      name: el('opfName').value.trim(),
      projectType: el('opfType').value,
      city: el('opfCity').value,
      district: el('opfDistrict').value.trim() || null,
      address: el('opfAddress').value.trim() || null,
      description: el('opfDescription').value.trim() || null,
      constructionStatus: el('opfStatus').value,
      numberOfBuildings: el('opfBuildings').value ? Number(el('opfBuildings').value) : null,
      numberOfUnits: el('opfUnits').value ? Number(el('opfUnits').value) : null,
      totalLandAreaSqm: el('opfLandArea').value ? Number(el('opfLandArea').value) : null,
      amenities,
      currency: el('opfCurrency').value,
      installmentAvailable: el('opfInstallmentAvailable').checked,
      updatedAt: serverTimestamp()
    };
    if (el('opfLat').value && el('opfLng').value) baseData.location = { lat: Number(el('opfLat').value), lng: Number(el('opfLng').value) };
    if (el('opfHandoverDate').value) baseData.handoverDate = el('opfHandoverDate').value;
    if (el('opfStartingPrice').value) baseData.startingPrice = Number(el('opfStartingPrice').value);
    if (el('opfPriceMax').value) baseData.priceRangeMax = Number(el('opfPriceMax').value);
    if (el('opfDownPct').value) baseData.minDownPaymentPercent = Number(el('opfDownPct').value);
    if (el('opfMonthly').value) baseData.monthlyInstallmentFrom = Number(el('opfMonthly').value);
    if (el('opfMonths').value) baseData.paymentPeriodMonths = Number(el('opfMonths').value);
    // Firestore rejects `null` on several of these optional numeric/text
    // fields inconsistently across create vs update -- stripped here so
    // "left blank" means "field omitted", never a stored null.
    Object.keys(baseData).forEach((k) => { if (baseData[k] === null) delete baseData[k]; });

    if (isNew) {
      // Never auto-published -- admin approval is required before this is
      // ever publicly visible (firestore.rules' isProjectPubliclyVisible()).
      baseData.publicationStatus = 'draft';
      baseData.createdAt = serverTimestamp();
      const ref = await addDoc(collection(db, 'projects'), baseData);
      projectId = ref.id;
    } else if (!isPublished) {
      // Not yet published (draft/pending_review/changes_requested/
      // rejected) -- the owner edits the live doc directly, since there's
      // no approved public version to protect yet.
      await updateDoc(doc(db, 'projects', projectId), baseData);
    }
    // (isPublished handled below, after images resolve -- the whole
    // content+image set goes into private/pendingRevision as one write,
    // never onto the live public doc.)

    // Images: upload any newly-picked files against the now-real projectId,
    // then patch the doc (or the pending revision, if published) with
    // whatever URLs exist (existing + new).
    const coverFile = el('opfCoverFile').files[0];
    const galleryFiles = Array.from(el('opfGalleryFiles').files || []);
    const patch = {};
    if (coverFile) patch.coverImageUrl = await uploadProjectImage(coverFile, projectId);
    if (galleryFiles.length) {
      const uploaded = await Promise.all(galleryFiles.map((f) => uploadProjectImage(f, projectId)));
      patch.gallery = [...pendingGalleryUrls, ...uploaded].slice(0, 30);
    }

    if (isPublished) {
      // Already live -- stage the full proposed content (not a partial
      // patch) in the private, non-public subdoc, and flag the parent doc
      // as having a pending revision. The currently-approved public
      // content is untouched until an admin approves this revision (see
      // admin.html's review queue, which merges pendingRevision onto the
      // live doc and clears it).
      await setDoc(doc(db, 'projects', projectId, 'private', 'pendingRevision'), { ...baseData, ...patch });
      await updateDoc(doc(db, 'projects', projectId), { revisionStatus: 'pending_review', updatedAt: serverTimestamp() });
    } else if (Object.keys(patch).length) {
      patch.updatedAt = serverTimestamp();
      await updateDoc(doc(db, 'projects', projectId), patch);
    }

    // Private contact phone -- own subdoc, own permission gate (see
    // firestore.rules' projects/{id}/private/{docId}).
    const phone = el('opfPhone').value.trim();
    if (phone) {
      try {
        await setDoc(doc(db, 'projects', projectId, 'private', 'contact'), { phone, updatedAt: serverTimestamp() });
      } catch { /* permission for this subdoc denied -- project itself still saved */ }
    }

    okEl.textContent = isPublished
      ? tr('op.revisionSubmitted', 'Your revision was submitted for admin review. The live page is unchanged until it is approved.')
      : tr('op.saved', 'Saved.');
    okEl.classList.remove('hidden');
    editingProject = isPublished
      ? { ...editingProject, revisionStatus: 'pending_review' }
      : { id: projectId, ...baseData };
    await loadOrgProjects();
    if (isNew) await openForm(editingProject);
  } catch (err) {
    errEl.textContent = (err && err.code === 'permission-denied')
      ? tr('op.permissionDenied', 'Your account does not currently have permission to publish for this organization. Ask a Darwesh Group administrator to grant it.')
      : tr('op.saveError', 'Could not save this project -- please try again.');
    errEl.classList.remove('hidden');
  } finally {
    submitBtn.disabled = false;
    uploadGate.end();
  }
});

// Submits an already-saved draft/changes_requested project for admin
// review, WITHOUT going through the content form again -- a pure status
// transition (draft/changes_requested -> pending_review). Content is
// still whatever was last saved via the main Save button above.
el('opSubmitForReviewBtn').addEventListener('click', async () => {
  if (!editingProject) return;
  const btn = el('opSubmitForReviewBtn');
  const errEl = el('opFormError');
  const okEl = el('opFormSuccess');
  errEl.classList.add('hidden');
  btn.disabled = true;
  try {
    await updateDoc(doc(db, 'projects', editingProject.id), { publicationStatus: 'pending_review', updatedAt: serverTimestamp() });
    editingProject = { ...editingProject, publicationStatus: 'pending_review' };
    okEl.textContent = tr('op.submittedForReview', 'Submitted for admin review.');
    okEl.classList.remove('hidden');
    await loadOrgProjects();
    await openForm(editingProject);
  } catch (err) {
    errEl.textContent = (err && err.code === 'permission-denied')
      ? tr('op.permissionDenied', 'Your account does not currently have permission to publish for this organization. Ask a Darwesh Group administrator to grant it.')
      : tr('op.saveError', 'Could not save this project -- please try again.');
    errEl.classList.remove('hidden');
  } finally {
    btn.disabled = false;
  }
});

// ---- floor plans (unit types) ---------------------------------------------
function renderFloorPlanList() {
  const wrap = el('opFloorPlanList');
  if (!editingFloorPlans.length) { wrap.innerHTML = `<p class="font-body-md text-[13px] text-on-surface-variant">${esc(tr('proj.noUnitTypes', 'No unit types published yet.'))}</p>`; return; }
  wrap.innerHTML = editingFloorPlans.map((fp) => `
    <div class="op-fp-row">
      <span class="font-body-md text-[13px]">${esc(fp.name || '')}${typeof fp.bedrooms === 'number' ? ' · ' + fp.bedrooms + 'bd' : ''}${typeof fp.areaSqm === 'number' ? ' · ' + fp.areaSqm + 'm²' : ''}</span>
      ${typeof fp.startingPrice === 'number' ? `<span class="font-body-md text-[13px] font-bold text-secondary">${esc(fp.currency || '')} ${fp.startingPrice.toLocaleString()}</span>` : ''}
    </div>`).join('');
}

el('opFloorPlanForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!editingProject) return;
  if (!uploadGate.begin()) return;
  const errEl = el('opFpError');
  errEl.classList.add('hidden');
  try {
    const data = { projectId: editingProject.id, name: el('opfpName').value.trim() };
    if (el('opfpBedrooms').value) data.bedrooms = Number(el('opfpBedrooms').value);
    if (el('opfpBathrooms').value) data.bathrooms = Number(el('opfpBathrooms').value);
    if (el('opfpArea').value) data.areaSqm = Number(el('opfpArea').value);
    if (el('opfpPrice').value) { data.startingPrice = Number(el('opfpPrice').value); data.currency = el('opfCurrency').value; }
    if (el('opfpDescription').value.trim()) data.description = el('opfpDescription').value.trim();
    data.createdAt = serverTimestamp();
    data.updatedAt = serverTimestamp();

    const ref = await addDoc(collection(db, 'projects', editingProject.id, 'floorPlans'), data);
    const file = el('opfpImageFile').files[0];
    if (file) {
      const compressed = await compressImage(file, PORTFOLIO_IMAGE);
      const path = `floorplan-media/${editingProject.id}/${ref.id}/${Date.now()}.jpg`;
      const sref = storageRef(storage, path);
      await uploadBytes(sref, compressed);
      const url = await getDownloadURL(sref);
      await updateDoc(doc(db, 'projects', editingProject.id, 'floorPlans', ref.id), { floorPlanImageUrl: url, updatedAt: serverTimestamp() });
    }
    el('opFloorPlanForm').reset();
    const snap = await getDocs(collection(db, 'projects', editingProject.id, 'floorPlans'));
    editingFloorPlans = [];
    snap.forEach((d) => editingFloorPlans.push({ id: d.id, ...d.data() }));
    renderFloorPlanList();
  } catch (err) {
    errEl.textContent = (err && err.code === 'permission-denied')
      ? tr('op.permissionDenied', 'Your account does not currently have permission to publish for this organization. Ask a Darwesh Group administrator to grant it.')
      : tr('op.saveError', 'Could not save this unit type -- please try again.');
    errEl.classList.remove('hidden');
  } finally {
    uploadGate.end();
  }
});

// ---- individual inventory units + mark-as-sold -----------------------------
// Mark-as-sold is deliberately a per-UNIT action, never a project-wide one --
// selling one apartment in a 40-unit building must never affect the other
// 39 (see firestore.rules' units update rule: there is no cross-unit or
// project-level write anywhere in this flow). Reporting a sale never
// self-confirms it -- only an admin can (see admin.html's Sale Reports
// queue); this page only ever writes saleReportStatus:'pending' plus a
// saleReports/{id} record for admin review.
//
// Evidence policy: there is no configured-policy mechanism anywhere in this
// codebase yet (no admin UI to set "evidence required" per org/project/
// account type) -- rather than invent a mandatory legal-document
// requirement that doesn't actually exist yet, evidenceRequired is
// explicitly false and the dialog says so plainly. See the end-of-session
// report for this disclosed gap.
const SALE_EVIDENCE_REQUIRED = false;
let editingUnits = [];
let soldModalUnit = null;

async function loadUnits(projectId) {
  try {
    const snap = await getDocs(collection(db, 'units'));
    editingUnits = [];
    snap.forEach((d) => { if (d.data().projectId === projectId) editingUnits.push({ id: d.id, ...d.data() }); });
  } catch { editingUnits = []; }
  renderUnitList();
}

const UNIT_STATUS_META = {
  coming_soon: { i18n: 'op.unitStatusComingSoon', fallback: 'Coming Soon' },
  available: { i18n: 'op.unitStatusAvailable', fallback: 'Available' },
  reserved: { i18n: 'op.unitStatusReserved', fallback: 'Reserved' },
  sold: { i18n: 'op.unitStatusSold', fallback: 'Sold' },
  rented: { i18n: 'op.unitStatusRented', fallback: 'Rented' },
  off_market: { i18n: 'op.unitStatusOffMarket', fallback: 'Off Market' }
};
function unitStatusLabel(status) { const m = UNIT_STATUS_META[status] || UNIT_STATUS_META.available; return tr(m.i18n, m.fallback); }

function renderUnitList() {
  const wrap = el('opUnitList');
  if (!editingUnits.length) { wrap.innerHTML = `<p class="font-body-md text-[13px] text-on-surface-variant">${esc(tr('op.noUnitsYet', 'No individual units added yet.'))}</p>`; return; }
  wrap.innerHTML = editingUnits.map((u) => {
    const isFinal = u.status === 'sold' || u.status === 'rented';
    const isPending = u.saleReportStatus === 'pending';
    const statusBits = [unitStatusLabel(u.status)];
    if (isPending) statusBits.push(tr('op.saleAwaitingConfirmation', 'sale reported, awaiting confirmation'));
    return `
    <div class="op-fp-row">
      <span class="font-body-md text-[13px]">${esc(u.unitNumber || '')} · ${esc(statusBits.join(' — '))}${typeof u.priceAmount === 'number' ? ' · ' + esc(u.currency || '') + ' ' + u.priceAmount.toLocaleString() : ''}</span>
      ${!isFinal && !isPending ? `<button type="button" class="op-btn op-btn-ghost" data-mark-sold="${esc(u.id)}" data-i18n="op.markAsSold">Mark as Sold</button>` : ''}
    </div>`;
  }).join('');
  wrap.querySelectorAll('[data-mark-sold]').forEach((btn) => {
    btn.addEventListener('click', () => openSoldModal(editingUnits.find((u) => u.id === btn.dataset.markSold)));
  });
}

el('opUnitForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!editingProject) return;
  const errEl = el('opUnitError');
  errEl.classList.add('hidden');
  try {
    await addDoc(collection(db, 'units'), {
      organizationId: activeOrg.id,
      projectId: editingProject.id,
      unitNumber: el('opuNumber').value.trim(),
      propertyType: el('opuPropertyType').value,
      listingType: el('opuListingType').value,
      status: 'available',
      priceAmount: Number(el('opuPrice').value),
      currency: el('opfCurrency').value,
      city: editingProject.city,
      saleReportStatus: 'none',
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });
    el('opUnitForm').reset();
    await loadUnits(editingProject.id);
  } catch (err) {
    errEl.textContent = (err && err.code === 'permission-denied')
      ? tr('op.permissionDenied', 'Your account does not currently have permission to publish for this organization. Ask a Darwesh Group administrator to grant it.')
      : tr('op.saveError', 'Could not save this unit -- please try again.');
    errEl.classList.remove('hidden');
  }
});

function openSoldModal(unit) {
  if (!unit) return;
  soldModalUnit = unit;
  el('opSoldUnitRef').textContent = `${unit.unitNumber} — #${unit.id}`;
  el('opSoldDate').value = new Date().toISOString().slice(0, 10);
  el('opSoldNote').value = '';
  el('opSoldError').classList.add('hidden');
  el('opSoldEvidenceNote').textContent = SALE_EVIDENCE_REQUIRED
    ? tr('op.evidenceRequiredNote', 'Supporting evidence is required for this report.')
    : tr('op.evidenceNotRequiredNote', 'No supporting evidence is required for this report.');
  show('opSoldModal');
}
el('opSoldCancel').addEventListener('click', () => { hide('opSoldModal'); soldModalUnit = null; });

el('opSoldConfirm').addEventListener('click', async () => {
  if (!soldModalUnit || !editingProject) return;
  const errEl = el('opSoldError');
  errEl.classList.add('hidden');
  const btn = el('opSoldConfirm');
  btn.disabled = true;
  try {
    const note = el('opSoldNote').value.trim();
    const reportData = {
      organizationId: activeOrg.id,
      unitId: soldModalUnit.id,
      projectId: editingProject.id,
      reportedByUid: auth.currentUser.uid,
      saleDate: el('opSoldDate').value,
      status: 'pending',
      evidenceRequired: SALE_EVIDENCE_REQUIRED,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    };
    if (note) reportData.note = note;
    await addDoc(collection(db, 'saleReports'), reportData);
    // Immediately stop presenting the unit as available -- the report
    // itself, not this flag, is what admin actually reviews; this is only
    // the public-facing "don't show it as available" signal.
    await updateDoc(doc(db, 'units', soldModalUnit.id), { saleReportStatus: 'pending', updatedAt: serverTimestamp() });
    hide('opSoldModal');
    soldModalUnit = null;
    await loadUnits(editingProject.id);
  } catch (err) {
    errEl.textContent = (err && err.code === 'permission-denied')
      ? tr('op.permissionDenied', 'Your account does not currently have permission to report a sale for this organization.')
      : tr('op.saveError', 'Could not submit this report -- please try again.');
    errEl.classList.remove('hidden');
  } finally {
    btn.disabled = false;
  }
});
