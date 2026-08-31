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
// Display-only this phase: no image/portfolio upload UI, because
// storage.rules has no service-provider media path yet (out of scope --
// backend/rules are frozen). Every rendered value comes straight from the
// real serviceProviders schema; nothing here invents fields, sample
// projects, or placeholder people.
//
// One config object drives both pages -- this file has no page-specific
// knowledge beyond `serviceType` and the hero fallback icon.

import { auth, db, getDoc, updateDoc, addDoc } from './firebase-init.js';
import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/12.18.0/firebase-auth.js';
import { doc, collection } from 'https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js';
import { mountTabs, renderEmptyState, renderErrorState, withBusyButton } from './profile-shell.js';

function tr(key, fallback) { return (window.t && window.t(key)) || fallback; }
const el = (id) => document.getElementById(id);
function show(id) { el(id).classList.remove('hidden'); }
function hide(id) { el(id).classList.add('hidden'); }
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function initServiceProviderProfile(config) {
  const { serviceType, fallbackIcon } = config;
  const fallbackClass = `rp-fallback--${serviceType}`;

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

  async function loadProvider() {
    hideStates();
    show('loadingState');
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
      isOwnerView = !!(currentUser && providerData.ownerId === currentUser.uid);
      isAdminView = viewerRole === 'admin';
      renderProvider();
      hideStates();
      show('providerContent');
      setupTabs();
      renderProjects();
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
      el('editDisplayName').value = providerData.displayName || '';
      el('editDescription').value = providerData.description || '';
      el('editCity').value = providerData.city || '';
      el('editDistrict').value = providerData.district || '';
      el('editServiceAreas').value = (Array.isArray(providerData.serviceAreas) ? providerData.serviceAreas : []).join(', ');
      el('editExperienceYears').value = typeof providerData.experienceYears === 'number' ? providerData.experienceYears : '';
      el('editSpecialties').value = (Array.isArray(providerData.specialties) ? providerData.specialties : []).join(', ');
      el('editPricingModel').value = providerData.pricingModel || '';
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
        try {
          await updateDoc(doc(db, 'serviceProviders', providerId), update);
          Object.assign(providerData, update);
          renderProvider();
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
    const tabs = [
      { key: 'overview', button: el('tabBtnOverview'), panel: el('panelOverview') },
      { key: 'projects', button: el('tabBtnProjects'), panel: el('panelProjects') },
      { key: 'services', button: el('tabBtnServices'), panel: el('panelServices') },
      { key: 'contact', button: el('tabBtnContact'), panel: el('panelContact') }
    ];
    mountTabs({ tabs });
  }

  function renderProjects() {
    const grid = el('projectsGrid');
    const emptyEl = el('projectsEmpty');
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

  function renderContactTab() {
    const card = el('contactCard');
    if (isOwnerView) {
      card.innerHTML = `<p class="rp-owner-note">${esc(tr('rp.contactOwnerNote', 'This is your public profile.'))}</p>`;
      return;
    }
    if (!currentUser) {
      card.innerHTML = `
        <p class="font-body-md text-[13.5px] text-on-surface-variant mb-3">${esc(tr('rp.contactSignInPrompt', 'Sign in to send a request.'))}</p>
        <a href="login.html" class="ps-btn inline-block bg-primary text-on-primary px-5 py-2.5 rounded-full font-label-caps text-label-caps hover:bg-primary-container transition-colors">${esc(tr('rp.logIn', 'Log in'))}</a>
      `;
      return;
    }
    card.innerHTML = `
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
