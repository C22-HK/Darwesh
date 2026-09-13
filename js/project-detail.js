// Darwesh Group -- Project detail (project.html).
//
// Reads a single real projects/{id} document plus its real subcollections
// (buildings/floorPlans) and the top-level units collection (filtered by
// projectId) -- the exact schema firestore.rules already defines and
// js/installments.js already reads a summary of. Every section below is
// rendered ONLY when the underlying field/subcollection actually has
// data; nothing here computes a price, infers a status, or fabricates a
// destination that doesn't exist (see js/installments.js's own header
// comment for the same discipline this file follows).
import { db, getDoc, getDocs, addDoc } from './firebase-init.js';
import { auth } from './firebase-init.js';
import { doc, collection, query, where, limit, serverTimestamp } from 'https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js';

function tr(key, fallback) { return (window.t && window.t(key)) || fallback; }
function trf(key, fallback, vars) {
  const s = tr(key, fallback);
  return Object.keys(vars || {}).reduce((acc, k) => acc.replace(`{${k}}`, vars[k]), s);
}
function cityLabel(name) { return (window.cityLabel && window.cityLabel(name)) || name; }
const el = (id) => document.getElementById(id);
function show(id) { const n = el(id); if (n) n.classList.remove('hidden'); }
function hide(id) { const n = el(id); if (n) n.classList.add('hidden'); }
const esc = window.escapeHtml;
const isSafeUrl = window.isSafeHttpUrl;

function money(amount, currency) {
  if (typeof amount !== 'number' || !Number.isFinite(amount)) return null;
  const c = typeof currency === 'string' && currency.trim() ? currency.trim() : '';
  return `${c ? c + ' ' : '$'}${amount.toLocaleString()}`;
}

const CATEGORY_LABELS = {
  apartment: () => tr('proj.categoryApartment', 'Apartments'),
  residential_community: () => tr('proj.categoryResidential', 'Residential Projects')
};
const STATUS_LABELS = {
  planning: () => tr('proj.statusPlanning', 'Planning'),
  under_construction: () => tr('proj.statusUnderConstruction', 'Under Construction'),
  nearing_completion: () => tr('proj.statusNearingCompletion', 'Nearing Completion'),
  completed: () => tr('proj.statusCompleted', 'Completed')
};
// Amenity keys this UI recognizes and gives an icon/label to -- an
// amenity present in the data under any OTHER key still renders (the raw
// key, title-cased), it just falls back to a generic icon. Never assumes
// a project has any of these; only truthy keys in the real `amenities`
// map render at all.
const AMENITY_META = {
  security: { icon: 'security', labelKey: 'proj.amenity.security', fallback: 'Security' },
  parking: { icon: 'local_parking', labelKey: 'proj.amenity.parking', fallback: 'Parking' },
  electricity: { icon: 'bolt', labelKey: 'proj.amenity.electricity', fallback: '24/7 Electricity' },
  water: { icon: 'water_drop', labelKey: 'proj.amenity.water', fallback: 'Water Supply' },
  elevator: { icon: 'elevator', labelKey: 'proj.amenity.elevator', fallback: 'Elevator' },
  elevators: { icon: 'elevator', labelKey: 'proj.amenity.elevator', fallback: 'Elevator' },
  garden: { icon: 'park', labelKey: 'proj.amenity.garden', fallback: 'Garden' },
  gardens: { icon: 'park', labelKey: 'proj.amenity.garden', fallback: 'Garden' },
  playground: { icon: 'toys', labelKey: 'proj.amenity.playground', fallback: 'Playground' },
  pool: { icon: 'pool', labelKey: 'proj.amenity.pool', fallback: 'Swimming Pool' },
  swimmingPool: { icon: 'pool', labelKey: 'proj.amenity.pool', fallback: 'Swimming Pool' },
  gym: { icon: 'fitness_center', labelKey: 'proj.amenity.gym', fallback: 'Gym' }
};

const params = new URLSearchParams(window.location.search);
const projectId = params.get('id');

let project = null;
let org = null;
let floorPlans = [];
let selectedFloorPlanId = null;

// ---- gallery state --------------------------------------------------
let galleryImages = [];
let galleryIndex = 0;

function buildGalleryImages(p) {
  const imgs = [];
  if (isSafeUrl(p.coverImageUrl)) imgs.push(p.coverImageUrl);
  if (Array.isArray(p.gallery)) {
    p.gallery.forEach((u) => { if (isSafeUrl(u) && !imgs.includes(u)) imgs.push(u); });
  }
  return imgs;
}

function renderGallery() {
  const mainImg = el('projGalleryMainImg');
  const thumbs = el('projGalleryThumbs');
  if (!galleryImages.length) {
    el('projGalleryMain').classList.add('hidden');
    thumbs.innerHTML = '';
    return;
  }
  el('projGalleryMain').classList.remove('hidden');
  mainImg.src = galleryImages[galleryIndex];
  const showNav = galleryImages.length > 1;
  el('projGalleryPrev').style.display = showNav ? '' : 'none';
  el('projGalleryNext').style.display = showNav ? '' : 'none';
  thumbs.innerHTML = galleryImages.map((u, i) =>
    `<button type="button" class="proj-gallery-thumb${i === galleryIndex ? ' is-active' : ''}" data-i="${i}"><img src="${esc(u)}" alt="" loading="lazy"/></button>`
  ).join('');
  thumbs.querySelectorAll('.proj-gallery-thumb').forEach((btn) => {
    btn.addEventListener('click', () => { galleryIndex = Number(btn.dataset.i); renderGallery(); });
  });
}
function galleryStep(delta) {
  if (!galleryImages.length) return;
  galleryIndex = (galleryIndex + delta + galleryImages.length) % galleryImages.length;
  renderGallery();
}
function openLightbox(src) {
  el('projLightboxImg').src = src;
  show('projLightbox');
}
function closeLightbox() { hide('projLightbox'); }

// ---- overview ---------------------------------------------------------
function fmtDate(v) {
  // Firestore Timestamp instance, ISO string, or millis -- rendered only
  // if it actually parses; never a guessed/derived date.
  try {
    const d = v && typeof v.toDate === 'function' ? v.toDate() : new Date(v);
    if (Number.isNaN(d.getTime())) return null;
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'long' });
  } catch { return null; }
}

function renderOverview(p) {
  el('projName').textContent = p.name || '';
  el('projNameCrumb').textContent = p.name || '';
  const place = [p.city, p.district || p.neighborhood].filter(Boolean).join(' · ');
  el('projPlace').querySelector('span:last-child').textContent = place;
  if (p.description) { el('projDescription').textContent = p.description; el('projDescription').classList.remove('hidden'); }
  else { el('projDescription').classList.add('hidden'); }

  if (p.verified === true) show('projVerifiedBadge'); else hide('projVerifiedBadge');

  const facts = [];
  const catLabel = CATEGORY_LABELS[p.projectType] ? CATEGORY_LABELS[p.projectType]() : null;
  if (catLabel) facts.push([tr('proj.typeLabel', 'Type'), catLabel]);
  const statusLabel = STATUS_LABELS[p.constructionStatus] ? STATUS_LABELS[p.constructionStatus]() : null;
  if (statusLabel) facts.push([tr('proj.statusLabel', 'Status'), statusLabel]);
  if (org && org.name) facts.push([tr('proj.developerTitle', 'Developer'), org.name]);
  const handover = fmtDate(p.handoverDate || p.expectedCompletionDate);
  if (handover) facts.push([tr('proj.completionDateTitle', 'Expected Completion'), handover]);
  if (typeof p.numberOfBuildings === 'number') facts.push([tr('proj.buildingsTitle', 'Buildings'), String(p.numberOfBuildings)]);
  if (typeof p.numberOfUnits === 'number') facts.push([tr('proj.unitsTitle', 'Units'), String(p.numberOfUnits)]);
  if (typeof p.totalLandAreaSqm === 'number') facts.push([tr('proj.landAreaTitle', 'Land Area'), `${p.totalLandAreaSqm.toLocaleString()} m²`]);

  el('projFactGrid').innerHTML = facts.map(([k, v]) =>
    `<div class="proj-fact"><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`
  ).join('');
}

// ---- amenities ----------------------------------------------------------
function renderAmenities(p) {
  const wrap = el('projAmenities');
  const map = p.amenities && typeof p.amenities === 'object' ? p.amenities : {};
  const keys = Object.keys(map).filter((k) => map[k]);
  if (!keys.length) {
    wrap.innerHTML = '';
    show('projNoAmenities');
    return;
  }
  hide('projNoAmenities');
  wrap.innerHTML = keys.map((k) => {
    const meta = AMENITY_META[k];
    const icon = meta ? meta.icon : 'check_circle';
    const label = meta ? tr(meta.labelKey, meta.fallback) : (k.charAt(0).toUpperCase() + k.slice(1).replace(/([A-Z])/g, ' $1'));
    return `<span class="proj-amenity-chip"><span class="material-symbols-outlined text-[14px]" aria-hidden="true">${icon}</span>${esc(label)}</span>`;
  }).join('');
}

// ---- unit types / floor plans -------------------------------------------
function renderUnitTypeDetail(fp) {
  const wrap = el('projUnitTypeDetail');
  if (!fp) { wrap.innerHTML = ''; return; }
  const bits = [];
  if (typeof fp.areaSqm === 'number') bits.push(`${fp.areaSqm.toLocaleString()} m²`);
  if (typeof fp.bedrooms === 'number') bits.push(trf('proj.bedsAbbrev', '{n} bd', { n: fp.bedrooms }));
  if (typeof fp.bathrooms === 'number') bits.push(trf('proj.bathsAbbrev', '{n} ba', { n: fp.bathrooms }));
  const price = money(fp.startingPrice, fp.currency);
  wrap.innerHTML = `
    <div class="flex flex-wrap items-start gap-4">
      ${isSafeUrl(fp.floorPlanImageUrl) ? `<img src="${esc(fp.floorPlanImageUrl)}" alt="" class="proj-floorplan-img" id="projFloorPlanImg"/>` : ''}
      <div class="min-w-0">
        <p class="font-body-md text-[14px] font-semibold text-on-surface">${esc(fp.name || '')}</p>
        ${bits.length ? `<p class="font-body-md text-[13px] text-on-surface-variant mt-1">${esc(bits.join(' · '))}</p>` : ''}
        ${price ? `<p class="font-body-md text-[14px] font-bold text-secondary mt-1">${esc(price)}</p>` : ''}
        ${fp.description ? `<p class="font-body-md text-[12.5px] text-on-surface-variant mt-2 leading-relaxed">${esc(fp.description)}</p>` : ''}
      </div>
    </div>`;
  const imgEl = document.getElementById('projFloorPlanImg');
  if (imgEl) imgEl.addEventListener('click', () => openLightbox(fp.floorPlanImageUrl));
  renderPaymentTerms(project, fp);
}

function selectFloorPlan(id) {
  selectedFloorPlanId = id;
  document.querySelectorAll('.proj-unittype-chip').forEach((c) => c.classList.toggle('is-active', c.dataset.id === id));
  renderUnitTypeDetail(floorPlans.find((f) => f.id === id) || null);
}

function renderUnitTypes() {
  if (!floorPlans.length) {
    hide('projUnitTypesSection');
    show('projNoUnitTypes');
    return;
  }
  show('projUnitTypesSection');
  hide('projNoUnitTypes');
  el('projUnitTypeChips').innerHTML = floorPlans.map((fp, i) =>
    `<button type="button" class="proj-unittype-chip${i === 0 ? ' is-active' : ''}" data-id="${esc(fp.id)}" role="tab" aria-selected="${i === 0}">${esc(fp.name || '')}</button>`
  ).join('');
  document.querySelectorAll('.proj-unittype-chip').forEach((btn) => {
    btn.addEventListener('click', () => selectFloorPlan(btn.dataset.id));
  });
  selectFloorPlan(floorPlans[0].id);
}

// ---- payment plan ---------------------------------------------------------
// Rebuilt whenever a different unit type is selected: a floor plan with
// its own real price replaces the project-level cash-price row (spec
// section E), everything else (down payment/monthly/duration) stays the
// project's own published terms -- those are never per-unit-type here.
function renderPaymentTerms(p, selectedFp) {
  const terms = [];
  const cashPrice = (selectedFp && money(selectedFp.startingPrice, selectedFp.currency)) || money(p.startingPrice, p.currency);
  if (cashPrice) terms.push([tr('proj.cashPrice', 'Cash price'), cashPrice]);
  if (typeof p.minDownPaymentPercent === 'number') terms.push([tr('inst.downPayment', 'Down payment'), `${p.minDownPaymentPercent}%`]);
  const monthly = money(p.monthlyInstallmentFrom, p.currency);
  if (monthly) terms.push([tr('inst.monthlyFrom', 'Monthly from'), monthly]);
  if (typeof p.paymentPeriodMonths === 'number' && p.paymentPeriodMonths > 0) {
    terms.push([tr('inst.duration', 'Duration'), trf('inst.months', '{n} months', { n: p.paymentPeriodMonths })]);
  }
  const wrap = el('projPaymentTerms');
  if (!terms.length) {
    wrap.innerHTML = `<div class="proj-term"><dt>${esc(tr('proj.cashPrice', 'Cash price'))}</dt><dd>${esc(tr('proj.contactForPrice', 'Contact for price'))}</dd></div>`;
    return;
  }
  wrap.innerHTML = terms.map(([k, v]) => `<div class="proj-term"><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('');
}

// ---- location -----------------------------------------------------------
let leafletMap = null;
function renderLocation(p) {
  const loc = p.location;
  const hasCoords = loc && typeof loc.lat === 'number' && typeof loc.lng === 'number';
  // The directions link only needs the two real numbers -- it must not
  // disappear just because the Leaflet tile library happened to fail to
  // load (CDN hiccup, blocked request, etc). Kept as its own condition,
  // separate from the map embed below.
  if (hasCoords) {
    el('projDirectionsLink').href = `https://www.google.com/maps/dir/?api=1&destination=${loc.lat},${loc.lng}`;
    show('projDirectionsLink');
  } else {
    hide('projDirectionsLink');
  }
  if (hasCoords && window.L) {
    show('projMapWrap');
    if (!leafletMap) {
      leafletMap = window.L.map('projMap', { zoomControl: true, attributionControl: false }).setView([loc.lat, loc.lng], 15);
      window.L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(leafletMap);
    } else {
      leafletMap.setView([loc.lat, loc.lng], 15);
    }
    window.L.marker([loc.lat, loc.lng]).addTo(leafletMap);
    setTimeout(() => leafletMap.invalidateSize(), 50);
  } else {
    hide('projMapWrap');
  }
  // Many real Iraqi governorates share their name with their capital city
  // (Kirkuk, Erbil, Duhok...) -- de-duplicate adjacent identical segments
  // so the address line doesn't read "..., Kirkuk, Kirkuk".
  const addrParts = [p.address, p.district || p.neighborhood, p.city, p.governorate]
    .filter(Boolean)
    .filter((v, i, arr) => i === 0 || v.trim().toLowerCase() !== arr[i - 1].trim().toLowerCase());
  el('projAddress').textContent = addrParts.join(', ');

  const nearby = Array.isArray(p.nearbyLandmarks) ? p.nearbyLandmarks.filter((s) => typeof s === 'string' && s.trim()) : [];
  if (nearby.length) {
    el('projNearbyList').innerHTML = nearby.map((s) => `<li>${esc(s)}</li>`).join('');
    show('projNearbyWrap');
  } else {
    hide('projNearbyWrap');
  }
}

// ---- developer attribution / Darwesh Group contact -------------------------
// Darwesh Group is the sole public intermediary for every project (per the
// approved requirement): the developer's own name/logo is shown as plain,
// non-interactive attribution ("who built this"), but every actionable
// contact channel below -- Call, WhatsApp, and the inquiry form -- reaches
// DARWESH, never the developer directly. There is deliberately no public
// developer profile link (none exists in this build, matching
// js/installments.js's own "no organisation profile page" precedent) and
// no developer phone/WhatsApp rendered anywhere on this page -- that field
// was moved off the publicly-readable projects/{id} document entirely (see
// firestore.rules' projects/{id}/private/contact), not just hidden here.
//
// This is Darwesh Group's own real, already-configured WhatsApp number --
// the same one promo.html's agent-discount flow already uses (its
// `OWNER_WHATSAPP` constant). Not invented for this page; there is no
// dedicated contact/support page anywhere else in this codebase with a
// second number to prefer instead (confirmed by search).
const DARWESH_WHATSAPP = '9647773002400';

function renderContact(p, o) {
  if (o && isSafeUrl(o.logoUrl)) {
    el('projDevLogo').src = o.logoUrl;
    show('projDevLogo');
    hide('projDevIcon');
  } else {
    hide('projDevLogo');
    show('projDevIcon');
  }
  el('projDevName').textContent = (o && o.name) || tr('proj.developerTitle', 'Developer');

  // Project reference included automatically in every contact channel,
  // not just the form below -- a visitor tapping Call/WhatsApp from this
  // page is never asked to say which project they mean.
  const ref = p.name ? `${p.name} (#${projectId})` : `#${projectId}`;
  const waMessage = trf('proj.whatsappPrefill', 'Hello, I am interested in {ref} on Darwesh Group.', { ref });
  el('projCallBtn').href = 'tel:+' + DARWESH_WHATSAPP;
  el('projWhatsappBtn').href = `https://wa.me/${DARWESH_WHATSAPP}?text=${encodeURIComponent(waMessage)}`;
  show('projCallBtn');
  show('projWhatsappBtn');
}

// ---- available units ----------------------------------------------------
function unitCard(u) {
  const bits = [];
  if (typeof u.bedrooms === 'number') bits.push(trf('proj.bedsAbbrev', '{n} bd', { n: u.bedrooms }));
  if (typeof u.bathrooms === 'number') bits.push(trf('proj.bathsAbbrev', '{n} ba', { n: u.bathrooms }));
  if (typeof u.totalAreaSqm === 'number') bits.push(`${u.totalAreaSqm.toLocaleString()} m²`);
  const price = money(u.priceAmount, u.currency);
  return `
    <div class="proj-unit-card">
      <div class="min-w-0">
        <p class="font-body-md text-[13.5px] font-semibold text-on-surface">${esc(u.unitNumber || '')}</p>
        ${bits.length ? `<p class="font-body-md text-[12px] text-on-surface-variant mt-0.5">${esc(bits.join(' · '))}</p>` : ''}
      </div>
      ${price ? `<span class="font-body-md text-[13px] font-bold text-secondary flex-none">${esc(price)}</span>` : ''}
    </div>`;
}

async function loadAvailableUnits() {
  try {
    // "Available Units" means available -- a unit that's sold/rented/
    // reserved/off_market, or whose sale is merely reported and awaiting
    // admin confirmation (saleReportStatus != 'none'), must never appear
    // here. Needs a composite index on (projectId, status,
    // saleReportStatus) -- see firestore.indexes.json.
    const snap = await getDocs(query(
      collection(db, 'units'),
      where('projectId', '==', projectId),
      where('status', 'in', ['coming_soon', 'available']),
      where('saleReportStatus', '==', 'none'),
      limit(24)
    ));
    const units = [];
    snap.forEach((d) => units.push({ id: d.id, ...d.data() }));
    if (!units.length) {
      el('projUnitsList').innerHTML = '';
      show('projNoUnits');
      return;
    }
    hide('projNoUnits');
    el('projUnitsList').innerHTML = units.map(unitCard).join('');
  } catch {
    el('projUnitsList').innerHTML = '';
    show('projNoUnits');
  }
}

// ---- inquiry form ---------------------------------------------------------
function wireInquiryForm(p) {
  el('projInquireForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errEl = el('projInquireError');
    const okEl = el('projInquireSuccess');
    errEl.classList.add('hidden');
    okEl.classList.add('hidden');
    const name = el('projInquireName').value.trim();
    const phone = el('projInquirePhone').value.trim();
    const submitBtn = el('projInquireSubmit');
    submitBtn.disabled = true;
    try {
      // Same real intake pipeline listing.html's "Request Viewing" already
      // writes to (submissions/{id}) -- see firestore.rules' 'project_inquiry'
      // addition, which mirrors the existing 'viewing' shape/existence check.
      await addDoc(collection(db, 'submissions'), {
        type: 'project_inquiry',
        projectId,
        projectName: p.name || '',
        city: p.city || '',
        name, phone,
        uid: auth.currentUser ? auth.currentUser.uid : null,
        status: 'pending', createdAt: serverTimestamp()
      });
      el('projInquireForm').reset();
      okEl.textContent = tr('proj.inquireSent', 'Your inquiry has been sent — Darwesh Group will contact you soon.');
      okEl.classList.remove('hidden');
    } catch {
      errEl.textContent = tr('proj.inquireError', 'Could not send your request — please try again in a moment.');
      errEl.classList.remove('hidden');
    } finally {
      submitBtn.disabled = false;
    }
  });
}

// ---- top-level render / load ---------------------------------------------
function renderAll() {
  if (!project) return;
  el('projBackToCity').href = 'projects.html?city=' + encodeURIComponent(project.city || '');
  renderOverview(project);
  renderAmenities(project);
  renderUnitTypes();
  if (!floorPlans.length) renderPaymentTerms(project, null);
  renderLocation(project);
  renderContact(project, org);
}

async function load() {
  if (!projectId) { hide('projLoadingState'); show('projNotFoundState'); return; }
  try {
    // A draft/pending_review/changes_requested/rejected project is denied
    // by firestore.rules' isProjectPubliclyVisible() gate -- getDoc throws
    // permission-denied for exactly the same id shape as a nonexistent
    // one, so both land on the identical not-found state. No distinction
    // is made publicly between "doesn't exist" and "not published yet" --
    // that would itself leak which ids are real drafts.
    let snap;
    try {
      snap = await getDoc(doc(db, 'projects', projectId));
    } catch {
      hide('projLoadingState'); show('projNotFoundState'); return;
    }
    if (!snap.exists()) { hide('projLoadingState'); show('projNotFoundState'); return; }
    project = { id: snap.id, ...snap.data() };

    galleryImages = buildGalleryImages(project);
    galleryIndex = 0;

    const tasks = [];
    if (project.organizationId) {
      tasks.push(getDoc(doc(db, 'organizations', project.organizationId)).then((s) => { org = s.exists() ? s.data() : null; }).catch(() => { org = null; }));
    }
    tasks.push(
      getDocs(collection(db, 'projects', projectId, 'floorPlans')).then((s) => {
        floorPlans = [];
        s.forEach((d) => floorPlans.push({ id: d.id, ...d.data() }));
      }).catch(() => { floorPlans = []; })
    );
    await Promise.all(tasks);

    hide('projLoadingState');
    show('projContent');
    renderGallery();
    renderAll();
    wireInquiryForm(project);
    loadAvailableUnits();
  } catch {
    hide('projLoadingState');
    show('projNotFoundState');
  }
}

el('projGalleryPrev').addEventListener('click', () => galleryStep(-1));
el('projGalleryNext').addEventListener('click', () => galleryStep(1));
el('projGalleryMain').addEventListener('click', () => { if (galleryImages.length) openLightbox(galleryImages[galleryIndex]); });
el('projGalleryMain').addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (galleryImages.length) openLightbox(galleryImages[galleryIndex]); } });
el('projLightboxClose').addEventListener('click', closeLightbox);
el('projLightbox').addEventListener('click', (e) => { if (e.target.id === 'projLightbox') closeLightbox(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !el('projLightbox').classList.contains('hidden')) closeLightbox(); });

// Touch swipe on the main gallery image (mobile).
(function wireSwipe() {
  const stage = el('projGalleryMain');
  let sx = 0, tracking = false;
  stage.addEventListener('touchstart', (e) => { if (e.touches.length !== 1) return; sx = e.touches[0].clientX; tracking = true; }, { passive: true });
  stage.addEventListener('touchend', (e) => {
    if (!tracking) return;
    tracking = false;
    const dx = e.changedTouches[0].clientX - sx;
    if (Math.abs(dx) < 40) return;
    const rtl = document.documentElement.getAttribute('dir') === 'rtl';
    galleryStep((dx < 0) === !rtl ? 1 : -1);
  }, { passive: true });
})();

document.addEventListener('darwesh:langchange', () => { if (project) renderAll(); });
load();
