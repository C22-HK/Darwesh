// Darwesh Group -- shared role-profile bootstrap for individual service-
// provider profile pages (engineer.html, designer.html today; any future
// individual serviceProviders-backed profile can reuse this unchanged).
//
// Mirrors office.html's state-machine, owner/public-view resolution, and
// mountTabs() usage exactly -- adapted for serviceProviders/{uid} instead
// of companies/{id}. Engineer/Designer/Lawyer/Landscaping providers are
// always providerType=='individual' with providerId == ownerId == uid
// (firestore.rules' serviceProviders create rule), so "my profile"
// resolves directly by the signed-in uid -- no backend list call needed,
// unlike office.html's listMyCompanies().
//
// PHASE 3B replaced the display-only limitation noted here previously.
// Phase 3A shipped professional-media/{providerId}/{photo|cover}/, so a
// profile photo/logo and a cover image are now uploadable by the owner
// through js/profile-media.js. Only those two {kind} values exist; 'work'
// stays closed until the Phase 3C limiter.
//
// CAPABILITIES COME FROM THE MAP, NOT FROM THIS FILE. Before Phase 3B the
// Projects tab was rendered for every role that did not supply a custom
// work tab, which silently included lawyer.html -- a legal profile with a
// photo grid, contradicting the approved decision that legal work is not
// a visual portfolio. Tab presence is now derived from
// js/professional-roles.js' `portfolio` flag, so the decision lives in
// one auditable place and a new role inherits it by declaration.
//
// Every rendered value comes straight from the real serviceProviders
// schema; nothing here invents fields, sample projects, or placeholder
// people.
//
// One config object drives every role page -- this file has no
// page-specific knowledge beyond `serviceType`.

import { auth, db, getDoc, setDoc, updateDoc, addDoc } from './firebase-init.js';
import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/12.18.0/firebase-auth.js';
import { doc, collection } from 'https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js';
import { mountTabs, renderEmptyState, renderErrorState, withBusyButton } from './profile-shell.js';
import { allowsPortfolio, roleIcon } from './professional-roles.js';
import { wireMediaInput } from './profile-media.js';
import { seedDoc, readSeed } from './data-cache.js';

function tr(key, fallback) { return (window.t && window.t(key)) || fallback; }
const el = (id) => document.getElementById(id);
function show(id) { el(id).classList.remove('hidden'); }
function hide(id) { el(id).classList.add('hidden'); }
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function initServiceProviderProfile(config) {
  const { serviceType, tabOrder, renderWorkTab } = config;
  // The role page may still pass fallbackIcon, but the capability map is
  // the source of truth so a role's icon cannot disagree between its page
  // and any other surface that renders the same role.
  const fallbackIcon = config.fallbackIcon || roleIcon(serviceType);
  const fallbackClass = `rp-fallback--${serviceType}`;
  const showPortfolio = allowsPortfolio(serviceType);

  const params = new URLSearchParams(window.location.search);
  const requestedId = params.get('id');

  function hideStates() {
    ['loadingState', 'signinRequiredState', 'notFoundState', 'errorState', 'providerContent'].forEach(hide);
  }

  let currentUser = null;
  let viewerRole = null;
  let providerId = null;
  let providerData = null;
  let isOwnerView = false;
  let isAdminView = false;
  let tabsController = null;

  onAuthStateChanged(auth, async (user) => {
    currentUser = user;
    if (user) {
      try {
        const profileSnap = await getDoc(doc(db, 'users', user.uid));
        viewerRole = profileSnap.exists() ? (profileSnap.data().role || null) : null;
      } catch { viewerRole = null; }
    }
    resolveAndLoad();
  });

  function resolveAndLoad() {
    if (requestedId) {
      providerId = requestedId;
      loadProvider();
      return;
    }
    if (!currentUser) {
      hideStates();
      show('signinRequiredState');
      return;
    }
    providerId = currentUser.uid;
    loadProvider();
  }

  // Paints from the seed store before any network call when this profile
  // was already fetched in this tab (a service listing, a previous visit),
  // then revalidates below. Same stale-while-revalidate pattern
  // listing.html uses. serviceProviders is public-read, so seeding it
  // exposes nothing the page was not already about to render -- and
  // js/data-cache.js structurally cannot seed private/contact, which is a
  // subcollection and therefore not a two-segment path.
  function paintFromSeedIfAvailable() {
    const seed = readSeed(`serviceProviders/${providerId}`);
    if (!seed || seed.data.serviceType !== serviceType) return false;
    providerData = seed.data;
    isOwnerView = !!(currentUser && providerData.ownerId === currentUser.uid);
    isAdminView = viewerRole === 'admin';
    try {
      renderProvider();
      hideStates();
      show('providerContent');
      setupTabs();
      return true;
    } catch {
      return false;   // fall back to the normal loading state
    }
  }

  async function loadProvider() {
    const painted = paintFromSeedIfAvailable();
    if (!painted) { hideStates(); show('loadingState'); }
    try {
      const snap = await getDoc(doc(db, 'serviceProviders', providerId));
      // A mismatched serviceType (e.g. designer.html loading an
      // engineer's doc via a hand-edited ?id=) is treated the same as
      // not-found -- an honest UX guard, not a security boundary (the
      // doc is public-read regardless of which page requests it).
      if (!snap.exists() || snap.data().serviceType !== serviceType) {
        hideStates();
        show('notFoundState');
        return;
      }
      providerData = snap.data();
      seedDoc(`serviceProviders/${providerId}`, providerData);
      isOwnerView = !!(currentUser && providerData.ownerId === currentUser.uid);
      isAdminView = viewerRole === 'admin';
      renderProvider();
      hideStates();
      show('providerContent');
      setupTabs();
      if (showPortfolio) { if (renderWorkTab) renderWorkTab(workTabContext()); else renderProjects(); }
      renderContactTab();
    } catch (err) {
      hideStates();
      show('errorState');
      renderErrorState(el('errorState'), {
        message: tr('rp.errorGeneric', 'Something went wrong. Please try again.'),
        onRetry: loadProvider
      });
    }
  }

  function renderProvider() {
    el('providerName').textContent = providerData.displayName || '—';
    el('heroEyebrow').textContent = tr(`rp.role.${serviceType}`, serviceType);

    const locationParts = [providerData.city, providerData.district].filter(Boolean);
    const metaParts = [];
    if (locationParts.length) metaParts.push(locationParts.join(' · '));
    if (typeof providerData.experienceYears === 'number' && providerData.experienceYears > 0) {
      metaParts.push(`${providerData.experienceYears} ${tr('rp.yearsSuffix', 'years experience')}`);
    }
    el('heroMeta').textContent = metaParts.join(' — ');

    hide('verifiedBadge'); hide('unverifiedBadge');
    if (providerData.verified) show('verifiedBadge'); else show('unverifiedBadge');

    // Cover image (PHASE 3B). Optional: a profile without one keeps the
    // role's existing gradient hero exactly as before, so nothing looks
    // broken or empty for the profiles that already exist.
    const cover = el('heroCover');
    if (cover) {
      if (providerData.coverImageUrl) {
        cover.style.backgroundImage = `url("${providerData.coverImageUrl}")`;
        cover.classList.add('rp-hero-cover--set');
      } else {
        cover.style.backgroundImage = 'none';
        cover.classList.remove('rp-hero-cover--set');
      }
    }

    const media = el('heroMedia');
    media.innerHTML = '';
    if (providerData.photoOrLogoUrl) {
      media.style.backgroundImage = `url("${providerData.photoOrLogoUrl}")`;
    } else {
      media.style.backgroundImage = 'none';
      const fb = document.createElement('div');
      fb.className = `rp-fallback ${fallbackClass}`;
      fb.innerHTML = `<span class="material-symbols-outlined" aria-hidden="true">${fallbackIcon}</span>`;
      media.appendChild(fb);
    }

    // Media upload affordances are shown to the owner only. That is a UX
    // decision, not the security boundary: storage.rules independently
    // cross-checks {providerId} against this document's ownerId on every
    // write, so a non-owner who un-hides these buttons still cannot
    // upload into someone else's path.
    ['photoUploadLabel', 'coverUploadLabel'].forEach((id) => {
      const node = el(id);
      if (node) node.classList.toggle('hidden', !isOwnerView);
    });
    if (isOwnerView) wireMediaUploads();

    // Overview
    const descEl = el('ovDescription');
    if (providerData.description) {
      descEl.textContent = providerData.description;
      descEl.classList.remove('opacity-70');
    } else {
      descEl.textContent = tr('rp.overviewNoDescription', "This profile hasn't added a description yet.");
      descEl.classList.add('opacity-70');
    }
    el('ovCity').textContent = providerData.city || '—';
    el('ovDistrict').textContent = providerData.district || '—';
    el('ovExperience').textContent = typeof providerData.experienceYears === 'number' && providerData.experienceYears > 0
      ? `${providerData.experienceYears} ${tr('rp.yearsSuffix', 'years experience')}`
      : '—';
    const areas = Array.isArray(providerData.serviceAreas) ? providerData.serviceAreas : [];
    el('ovServiceAreas').textContent = areas.length ? areas.join(', ') : '—';

    renderChips('ovSpecialtiesChips', providerData.specialties, 'rp.noSpecialties', "No specialties listed yet.");
    renderChips('servicesChips', providerData.specialties, 'rp.noSpecialties', "No specialties listed yet.");

    // Owner / admin controls -- gated on a REAL ownerId match read from
    // the provider doc itself, never a client-side guess. Every write
    // these controls trigger is independently re-enforced server-side by
    // firestore.rules regardless of whether this button is even visible
    // -- UI hiding is not authorization.
    hide('editProfileBtn'); hide('adminViewingNote'); hide('verifyToggleBtn');
    if (isOwnerView) {
      show('editProfileBtn');
    }
    if (isAdminView) {
      show('adminViewingNote');
      const verifyBtn = el('verifyToggleBtn');
      verifyBtn.textContent = providerData.verified
        ? tr('rp.markUnverified', 'Remove verified status')
        : tr('rp.markVerified', 'Mark as verified');
      show('verifyToggleBtn');
      verifyBtn.onclick = () => withBusyButton(verifyBtn, async () => {
        await updateDoc(doc(db, 'serviceProviders', providerId), { verified: !providerData.verified, updatedAt: Date.now() / 1000 });
        providerData.verified = !providerData.verified;
        renderProvider();
      });
    }

    wireEditForm();
  }

  // PHASE 3B -- photo/logo and cover upload, owner only.
  //
  // The Storage upload and the Firestore field write are two steps, and
  // the order matters: the URL is written to serviceProviders ONLY after
  // Storage has confirmed the object. Claiming a photo saved before it
  // exists would leave a profile pointing at a URL that 404s. There is no
  // optimistic UI here for that reason.
  //
  // A failed Firestore write leaves an unreferenced object in Storage.
  // That is the safe direction to fail: an orphaned file costs a little
  // storage, whereas a dangling URL is a visibly broken profile.
  function wireMediaUploads() {
    const setStatus = (id, phase) => {
      const node = el(id);
      if (!node) return;
      if (!phase) { node.classList.add('hidden'); return; }
      node.textContent = phase === 'optimizing'
        ? tr('rp.mediaOptimizing', 'Optimising image…')
        : phase === 'uploading'
          ? tr('rp.mediaUploading', 'Uploading…')
          : tr('rp.mediaSaving', 'Saving…');
      node.classList.remove('hidden');
    };

    const wireOne = (inputId, statusId, kind, field) => {
      const input = el(inputId);
      if (!input) return;
      wireMediaInput({
        input,
        providerId,
        kind,
        onStart: (phase) => setStatus(statusId, phase || 'optimizing'),
        onDone: async (url) => {
          setStatus(statusId, 'saving');
          await updateDoc(doc(db, 'serviceProviders', providerId), {
            [field]: url,
            updatedAt: Date.now() / 1000
          });
          providerData[field] = url;
          seedDoc(`serviceProviders/${providerId}`, providerData);
          renderProvider();
          setStatus(statusId, null);
        },
        onError: () => {
          const node = el(statusId);
          if (!node) return;
          node.textContent = tr('rp.mediaUploadFailed', 'Upload failed. Please try again.');
          node.classList.remove('hidden');
        }
      });
    };

    // Only the two Phase 3A kinds exist. No 'work' path is reachable.
    wireOne('photoUploadInput', 'photoUploadStatus', 'photo', 'photoOrLogoUrl');
    wireOne('coverUploadInput', 'coverUploadStatus', 'cover', 'coverImageUrl');
  }

  function renderChips(containerId, values, emptyKey, emptyFallback) {
    const container = el(containerId);
    if (!container) return;
    const list = Array.isArray(values) ? values.filter(Boolean) : [];
    if (!list.length) {
      container.innerHTML = `<p class="font-body-md text-[13px] text-on-surface-variant opacity-70">${esc(tr(emptyKey, emptyFallback))}</p>`;
      return;
    }
    container.innerHTML = list.map((v) => `<span class="rp-chip">${esc(v)}</span>`).join('');
  }

  function wireEditForm() {
    const editBtn = el('editProfileBtn');
    const form = el('overviewEditForm');
    const readOnly = el('overviewReadOnly');
    if (editBtn.dataset.wired) return;
    editBtn.dataset.wired = '1';
    editBtn.addEventListener('click', () => {
      // The edit form lives inside the Overview/About panel, but Designer
      // (and any future role that reorders tabs) can default to a
      // DIFFERENT tab, e.g. "Work" -- so clicking Edit Profile from the
      // hero, which is always visible regardless of active tab, must
      // switch to that tab too. Without this, the form still gets
      // populated and unhidden correctly, but sits inside a panel whose
      // own `hidden` attribute (set by mountTabs' tab switching) keeps it
      // completely invisible -- the exact "Edit Profile does nothing"
      // symptom this fixes.
      if (tabsController) tabsController.activate('overview');
      el('editDisplayName').value = providerData.displayName || '';
      el('editDescription').value = providerData.description || '';
      el('editCity').value = providerData.city || '';
      el('editDistrict').value = providerData.district || '';
      el('editServiceAreas').value = (Array.isArray(providerData.serviceAreas) ? providerData.serviceAreas : []).join(', ');
      el('editExperienceYears').value = typeof providerData.experienceYears === 'number' ? providerData.experienceYears : '';
      el('editSpecialties').value = (Array.isArray(providerData.specialties) ? providerData.specialties : []).join(', ');
      el('editPricingModel').value = providerData.pricingModel || '';
      const visSel = el('editContactVisibility');
      if (visSel) visSel.value = providerData.contactVisibility || 'onRequest';
      readOnly.classList.add('hidden');
      form.classList.remove('hidden');
    });
    el('cancelOverviewBtn').addEventListener('click', () => {
      form.classList.add('hidden');
      readOnly.classList.remove('hidden');
    });
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const saveBtn = el('saveOverviewBtn');
      withBusyButton(saveBtn, async () => {
        const msg = el('overviewSaveMsg');
        msg.classList.add('hidden');
        const splitList = (v) => v.split(',').map((s) => s.trim()).filter(Boolean);
        const update = {
          displayName: el('editDisplayName').value.trim(),
          description: el('editDescription').value.trim(),
          city: el('editCity').value.trim(),
          district: el('editDistrict').value.trim(),
          serviceAreas: splitList(el('editServiceAreas').value),
          specialties: splitList(el('editSpecialties').value),
          updatedAt: Date.now() / 1000
        };
        const years = parseInt(el('editExperienceYears').value, 10);
        if (!Number.isNaN(years) && years >= 0) update.experienceYears = years;
        const pricing = el('editPricingModel').value.trim();
        if (pricing) update.pricingModel = pricing;
        // Only the two values firestore.rules accepts can ever be sent;
        // anything else is dropped rather than rejected server-side.
        const visSel = el('editContactVisibility');
        if (visSel && ['public', 'onRequest'].includes(visSel.value)) {
          update.contactVisibility = visSel.value;
        }
        try {
          await updateDoc(doc(db, 'serviceProviders', providerId), update);
          Object.assign(providerData, update);
          seedDoc(`serviceProviders/${providerId}`, providerData);
          renderProvider();
          renderContactTab();   // contactVisibility may have changed
          form.classList.add('hidden');
          readOnly.classList.remove('hidden');
        } catch (err) {
          msg.textContent = tr('rp.errorGeneric', 'Something went wrong. Please try again.');
          msg.style.color = '#ba1a1a';
          msg.classList.remove('hidden');
        }
      });
    });
  }

  function setupTabs() {
    // Tab ORDER is per-role config (Designer wants Work first, per
    // PROFESSIONAL_CONTENT_ARCHITECTURE.md). Tab PRESENCE is per-role
    // capability, read from js/professional-roles.js.
    //
    // A role without `portfolio` does not get a hidden-but-present
    // Projects tab -- the button and its panel are removed from the DOM
    // entirely. A hidden tab is still reachable by anything that walks
    // the DOM or by a future edit that re-shows it; removing it means a
    // lawyer profile has no visual-portfolio surface to reach at all.
    const byKey = {
      overview: { key: 'overview', button: el('tabBtnOverview'), panel: el('panelOverview') },
      projects: { key: 'projects', button: el('tabBtnProjects'), panel: el('panelProjects') },
      services: { key: 'services', button: el('tabBtnServices'), panel: el('panelServices') },
      contact: { key: 'contact', button: el('tabBtnContact'), panel: el('panelContact') }
    };

    let order = tabOrder || ['overview', 'projects', 'services', 'contact'];
    if (!showPortfolio) {
      order = order.filter((k) => k !== 'projects');
      const btn = el('tabBtnProjects');
      const panel = el('panelProjects');
      if (btn) btn.remove();
      if (panel) panel.remove();
    }

    tabsController = mountTabs({ tabs: order.map((k) => byKey[k]).filter(Boolean) });
  }

  // Read-only context handed to a role's custom work-tab renderer
  // (Designer's professional-content.js integration) -- exposes exactly
  // what it needs and nothing about this module's private state beyond
  // that.
  function workTabContext() {
    return {
      el, show, hide, esc,
      providerId, providerData, isOwnerView, isAdminView, serviceType, fallbackIcon
    };
  }

  function renderProjects() {
    // Second, independent guard. setupTabs() already removed the panel for
    // a role without the capability, so this should be unreachable -- but
    // a renderer that silently no-ops is a cheaper safety net than one
    // that throws on a missing element, and it means the capability holds
    // even if the tab wiring is ever changed.
    if (!showPortfolio) return;
    const grid = el('projectsGrid');
    const emptyEl = el('projectsEmpty');
    if (!grid || !emptyEl) return;
    const items = Array.isArray(providerData.portfolio) ? providerData.portfolio.filter((p) => p && p.imageUrl) : [];
    if (!items.length) {
      grid.innerHTML = '';
      renderEmptyState(emptyEl, {
        icon: fallbackIcon,
        title: isOwnerView
          ? tr(`${serviceType}.projectsEmptyOwner`, 'Once you add projects, they’ll appear here.')
          : tr(`${serviceType}.projectsEmpty`, 'No projects published yet.')
      });
      show('projectsEmpty');
      return;
    }
    hide('projectsEmpty');
    grid.innerHTML = items.map((item) => `
      <div class="rp-project-card">
        <div class="rp-project-media" style="background-image:url('${esc(item.imageUrl)}')" role="img" aria-label="${esc(item.caption || '')}"></div>
        ${item.caption ? `<div class="p-3"><p class="rp-project-title font-body-md text-[13.5px] font-medium">${esc(item.caption)}</p></div>` : ''}
      </div>
    `).join('');
  }

  // ---- Contact privacy (PHASE 3B, on the Phase 3A architecture) --------
  //
  // The real phone/whatsapp/email live in
  //     serviceProviders/{id}/private/contact
  // which firestore.rules makes readable ONLY by the provider who owns it
  // or an admin. That subcollection is never touched by any public code
  // path here: a visitor's render never issues a read against it, so
  // there is nothing to leak and nothing to accidentally log.
  //
  // WHAT contactVisibility DOES AND DOES NOT DO. It is a public field on
  // the profile document describing how the provider PREFERS to be
  // reached. It is not an access grant, and 'public' does NOT make
  // private/contact readable by visitors -- the rules do not permit that,
  // and this UI does not attempt it. It only changes the wording and the
  // affordance shown next to the request form. Actually revealing a
  // number to a visitor would need a deliberate product decision plus a
  // server-mediated path (Phase 3C or later); nothing here pre-empts it.
  //
  // So every non-owner, signed in or not, gets the SAME data surface: the
  // request form. Signing in changes only whether the form can be
  // submitted, never what contact data is visible.
  function contactVisibilityLabel() {
    return providerData.contactVisibility === 'public'
      ? tr('rp.contactVisibilityPublic', 'This provider welcomes direct contact requests.')
      : tr('rp.contactVisibilityOnRequest', 'This provider shares contact details on request.');
  }

  async function renderOwnerContactEditor(card) {
    card.innerHTML = `
      <p class="rp-owner-note mb-3">${esc(tr('rp.contactOwnerNote', 'This is your public profile.'))}</p>
      <p class="font-body-md text-[13px] text-on-surface-variant mb-3">${esc(tr('rp.contactPrivateNote', 'These details are private. Visitors never see them — only you and Darwesh Group admins can.'))}</p>
      <form id="privateContactForm">
        <label class="ps-field-label" for="pcPhone">${esc(tr('rp.contactPhoneLabel', 'Phone (optional)'))}</label>
        <input id="pcPhone" class="ps-input" type="tel" maxlength="40"/>
        <label class="ps-field-label mt-3 block" for="pcWhatsapp">${esc(tr('rp.contactWhatsappLabel', 'WhatsApp (optional)'))}</label>
        <input id="pcWhatsapp" class="ps-input" type="tel" maxlength="40"/>
        <label class="ps-field-label mt-3 block" for="pcEmail">${esc(tr('rp.contactEmailLabel', 'Email (optional)'))}</label>
        <input id="pcEmail" class="ps-input" type="email" maxlength="320"/>
        <button type="submit" id="pcSaveBtn" class="ps-btn mt-4 bg-secondary text-on-secondary px-5 py-2.5 rounded-full font-label-caps text-label-caps hover:bg-secondary-container hover:text-on-secondary-container transition-colors">${esc(tr('rp.contactSaveDetails', 'Save contact details'))}</button>
        <p id="pcMsg" class="hidden text-[12px] mt-2"></p>
      </form>
    `;
    // Owner-only read of the private document. A failure here is NOT an
    // error to surface loudly: a provider who has never saved contact
    // details simply has no document yet, which is the normal first-run
    // state, so the form stays empty and usable.
    try {
      const snap = await getDoc(doc(db, 'serviceProviders', providerId, 'private', 'contact'));
      if (snap.exists()) {
        const d = snap.data();
        el('pcPhone').value = d.phone || '';
        el('pcWhatsapp').value = d.whatsapp || '';
        el('pcEmail').value = d.email || '';
      }
    } catch { /* no document yet, or transient -- leave the form empty */ }

    el('privateContactForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const btn = el('pcSaveBtn');
      withBusyButton(btn, async () => {
        const msg = el('pcMsg');
        msg.classList.add('hidden');
        // Only the four keys firestore.rules allowlists are ever sent, and
        // empty inputs are omitted rather than written as '' so the
        // document stays clean.
        const payload = { updatedAt: Date.now() / 1000 };
        const phone = el('pcPhone').value.trim();
        const whatsapp = el('pcWhatsapp').value.trim();
        const email = el('pcEmail').value.trim();
        if (phone) payload.phone = phone;
        if (whatsapp) payload.whatsapp = whatsapp;
        if (email) payload.email = email;
        try {
          // setDoc, not updateDoc: the document may not exist yet on a
          // first save, and updateDoc fails on a missing document.
          await setDoc(doc(db, 'serviceProviders', providerId, 'private', 'contact'), payload);
          msg.textContent = tr('rp.contactSaved', 'Saved.');
          msg.style.color = '';
          msg.classList.remove('hidden');
        } catch (err) {
          msg.textContent = tr('rp.errorGeneric', 'Something went wrong. Please try again.');
          msg.style.color = '#ba1a1a';
          msg.classList.remove('hidden');
        }
      });
    });
  }

  function renderContactTab() {
    const card = el('contactCard');
    if (isOwnerView) {
      renderOwnerContactEditor(card);
      return;
    }
    if (isAdminView) {
      // Admins may read private/contact per firestore.rules. Rendered
      // read-only: admin verification and moderation need visibility, not
      // the ability to rewrite a provider's own contact details from here.
      card.innerHTML = `<p class="font-body-md text-[13.5px] text-on-surface-variant">${esc(tr('rp.contactAdminLoading', 'Loading contact details…'))}</p>`;
      getDoc(doc(db, 'serviceProviders', providerId, 'private', 'contact'))
        .then((snap) => {
          const d = snap.exists() ? snap.data() : null;
          const rows = d
            ? [['rp.contactPhoneLabel', 'Phone', d.phone], ['rp.contactWhatsappLabel', 'WhatsApp', d.whatsapp], ['rp.contactEmailLabel', 'Email', d.email]]
                .filter(([, , v]) => v)
                .map(([k, f, v]) => `<p class="font-body-md text-[13.5px]"><span class="text-on-surface-variant">${esc(tr(k, f))}:</span> ${esc(v)}</p>`)
                .join('')
            : '';
          card.innerHTML = `
            <p class="rp-owner-note mb-3">${esc(tr('rp.contactAdminNote', 'Admin view — private contact details.'))}</p>
            ${rows || `<p class="font-body-md text-[13.5px] text-on-surface-variant opacity-70">${esc(tr('rp.contactNoneSaved', 'This provider has not saved contact details.'))}</p>`}
          `;
        })
        .catch(() => {
          card.innerHTML = `<p class="font-body-md text-[13.5px] text-on-surface-variant opacity-70">${esc(tr('rp.contactNoneSaved', 'This provider has not saved contact details.'))}</p>`;
        });
      return;
    }
    // Both non-owner branches below show the SAME contact-data surface:
    // none. Signing in changes only whether the request form can be
    // submitted -- never what contact details are visible.
    const visibilityNote = `<p class="font-body-md text-[12.5px] text-on-surface-variant opacity-80 mb-3">${esc(contactVisibilityLabel())}</p>`;
    if (!currentUser) {
      card.innerHTML = `
        ${visibilityNote}
        <p class="font-body-md text-[13.5px] text-on-surface-variant mb-3">${esc(tr('rp.contactSignInPrompt', 'Sign in to send a request.'))}</p>
        <a href="login.html" class="ps-btn inline-block bg-primary text-on-primary px-5 py-2.5 rounded-full font-label-caps text-label-caps hover:bg-primary-container transition-colors">${esc(tr('rp.logIn', 'Log in'))}</a>
      `;
      return;
    }
    card.innerHTML = `
      ${visibilityNote}
      <form id="requestForm">
        <label class="ps-field-label" for="requestMessage">${esc(tr('rp.contactMessageLabel', 'Message'))}</label>
        <textarea id="requestMessage" class="ps-input" rows="3" maxlength="2000" required></textarea>
        <label class="ps-field-label mt-3 block" for="requestPhone">${esc(tr('rp.contactPhoneLabel', 'Phone (optional)'))}</label>
        <input id="requestPhone" class="ps-input" type="tel" maxlength="40"/>
        <button type="submit" id="requestSendBtn" class="ps-btn mt-4 bg-secondary text-on-secondary px-5 py-2.5 rounded-full font-label-caps text-label-caps hover:bg-secondary-container hover:text-on-secondary-container transition-colors">${esc(tr('rp.contactSend', 'Send request'))}</button>
        <p id="requestMsg" class="hidden text-[12px] mt-2"></p>
      </form>
    `;
    el('requestForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const btn = el('requestSendBtn');
      withBusyButton(btn, async () => {
        const msg = el('requestMsg');
        msg.classList.add('hidden');
        try {
          const payload = {
            customerUid: currentUser.uid,
            status: 'pending',
            message: el('requestMessage').value.trim(),
            createdAt: Date.now() / 1000
          };
          const phone = el('requestPhone').value.trim();
          if (phone) payload.contactPhone = phone;
          await addDoc(collection(db, 'serviceProviders', providerId, 'requests'), payload);
          card.innerHTML = `<p class="rp-contact-sent font-body-md text-[14px] font-medium">${esc(tr('rp.contactSent', 'Your request has been sent.'))}</p>`;
        } catch (err) {
          msg.textContent = tr('rp.contactError', 'Something went wrong. Please try again.');
          msg.style.color = '#ba1a1a';
          msg.classList.remove('hidden');
        }
      });
    });
  }
}
