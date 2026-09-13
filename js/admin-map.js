// Darwesh Admin Panel -- Map Management tab.
//
// Replaces THREE old, independent map implementations at once:
//   #adminPinMap     (Listings tab's precise-location picker)
//   #estateIntelMap  (Google Maps "Estate Intelligence" tab)
//   #dashRequestsMap (Leaflet "Requests Map" tab -- plotted every listing's
//                     FULL PRECISE coordinate in bulk, a privacy-architecture
//                     outlier this consolidation deliberately fixes)
//
// with the SAME shared map foundation map.html's Explore/My Properties
// modes use (window.DarweshMarker / window.DarweshLeafletHelpers /
// window.DarweshListingAccess / window.DarweshLocationEdit -- classic
// scripts, already loaded on this page; read directly off `window`, never
// re-imported). Admin is the one account type that gets an extra
// capability layer on top of that shared foundation: precise coordinates
// on demand for any single listing, cross-account visibility, and a rich
// moderation detail panel -- never a fourth competing map or marker style.
//
// THE PRIVACY INVARIANT THIS FILE EXISTS TO ENFORCE:
//   - The bulk map view NEVER plots a precise coordinate. Every marker in
//     renderMarkers() comes from window.DarweshListingAccess.publicPinOf(),
//     the exact same rounded-pair validator Explore uses.
//   - window.DarweshListingAccess.fetchPreciseLocationFor() -- the one
//     chokepoint for a precise read -- is called ONLY for the single
//     listing currently open in the detail panel (openDetail()) or in
//     location-edit mode, and always for exactly one listing id at a time.
//     Grep this file for fetchPreciseLocationFor and confirm every call
//     site passes one literal listing id, never a loop/map/forEach.
//
// Like js/admin-orgs-pros.js, this is a separate ES module (not inlined
// into admin.html's own big module script) that imports firebase-init.js
// directly and is mounted the same lazy-init-on-first-tab-click way.
import { db, getDocs, getDoc, setDoc } from './firebase-init.js';
import {
  doc, collection, query, limit as fsLimit, serverTimestamp
} from 'https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js';

function tr(key, fallback) { return (window.t && window.t(key)) || fallback; }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function toast(msg, variant) { if (window.AdminShellToast) window.AdminShellToast(msg, variant); }
function fmtDate(v) {
  if (!v) return '—';
  const d = typeof v.toDate === 'function' ? v.toDate() : (v instanceof Date ? v : (typeof v === 'number' ? new Date(v) : null));
  if (!d || isNaN(d.getTime())) return '—';
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

// Same canonical known-city allowlist map.html's own CITY_CENTERS/
// KNOWN_CITY_NAMES uses (see map.html) -- never a second, drifting list.
const CITY_CENTERS = {
  Erbil: [36.1911, 44.0093],
  Sulaymaniyah: [35.5608, 45.4347],
  Duhok: [36.8642, 42.9903],
  Zakho: [37.1450, 42.6829],
  Soran: [36.6500, 44.5450],
  Koya: [36.0750, 44.6200],
  Kirkuk: [35.4681, 44.3922]
};
const KNOWN_CITY_NAMES = Object.keys(CITY_CENTERS);
// The same i18n keys the Listings form's own city <select> already uses
// (admin.html #fCity) -- reused, not re-authored.
const CITY_LABEL_KEYS = {
  Erbil: 'cities.erbil', Sulaymaniyah: 'cities.sulaymaniyah', Duhok: 'cities.duhok',
  Zakho: 'cities.zakho', Soran: 'cities.soran', Koya: 'cities.koya', Kirkuk: 'cities.kirkuk'
};
// Same property types + i18n keys the Listings form's #fPropertyType
// select already uses.
const PROPERTY_TYPE_LABEL_KEYS = {
  house: 'map.house', villa: 'map.villa', apartment: 'map.apartment', land: 'map.land',
  building: 'map.building', office: 'map.office', shop: 'map.shop', commercialProperty: 'map.commercialProperty'
};

const state = {
  inited: false,
  map: null,
  loading: false,
  error: null,
  listings: [],
  activeId: null,
  filters: { search: '', status: 'all', verified: 'all', city: 'all', type: 'all' },
  filtersOpen: false,
  markerLayer: null,
  boundaryLayers: [],
  boundariesLoaded: false,
};

// ---------------------------------------------------------------------
// Doc -> display shape. Deliberately the same field set/derivation as
// map.html's own toDisplayListing()/loadListings() mapper (id, price,
// priceLabel, beds/baths/sqft as null-not-zero, img via the shared
// listingImageUrl() resolver) so a listing looks and reads identically
// wherever an admin sees it. _lat/_lng are the bulk-safe APPROXIMATE
// pair only -- see publicPinOf() in js/darwesh-listing-access.js.
// ---------------------------------------------------------------------
function numOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}
function normalizeListing(d) {
  const pin = window.DarweshListingAccess.publicPinOf(d);
  const price = Number(d.price) || 0;
  return {
    id: d.id,
    title: (typeof d.title === 'string' ? d.title.trim() : ''),
    address: d.address || '',
    city: d.city || '',
    district: d.district || '',
    dealType: d.dealType === 'rent' ? 'rent' : 'sale',
    price,
    priceLabel: d.dealType === 'rent' ? ('$' + price.toLocaleString() + '/mo') : ('$' + price.toLocaleString()),
    beds: numOrNull(d.beds),
    baths: numOrNull(d.baths),
    sqft: numOrNull(d.sqft),
    propertyType: d.propertyType || '',
    img: (window.listingImageUrl && window.listingImageUrl(d)) || null,
    verified: !!d.verified,
    private: !!d.private,
    status: d.status || 'active',
    agentId: d.agentId || null,
    agentName: d.agentName || null,
    companyId: d.companyId || null,
    publisherOrgId: d.publisherOrgId || null,
    estateId: d.estateId || null,
    sourceSubmissionId: d.sourceSubmissionId || null,
    createdAt: d.createdAt || null,
    updatedAt: d.updatedAt || null,
    _lat: pin.lat,
    _lng: pin.lng,
    // Filled in on demand by openDetail() -- never in bulk. null means
    // "not fetched yet / unavailable", NOT "confirmed absent".
    _preciseLat: null,
    _preciseLng: null,
  };
}

// ---------------------------------------------------------------------
// Shell (built once, matching js/admin-orgs-pros.js's ensureOrgsShell
// pattern) -- toolbar, map canvas, legend, docked detail panel.
// ---------------------------------------------------------------------
function ensureShell() {
  const section = document.getElementById('tab-map');
  if (!section || section.dataset.ashBuilt === '1') return;
  section.dataset.ashBuilt = '1';
  section.innerHTML = `
    <div class="ash-map-shell">
      <div class="ash-map-canvas-wrap">
        <div class="ash-map-toolbar">
          <div class="ash-entity-search">
            <span class="material-symbols-outlined" aria-hidden="true">search</span>
            <input type="text" id="ashMapSearchInput" data-i18n-placeholder="admin.map.searchPlaceholder" placeholder="Search by title, address or agent…">
          </div>
          <button type="button" class="ash-map-filter-toggle" id="ashMapFilterToggle">
            <span class="material-symbols-outlined" style="font-size:16px;" aria-hidden="true">tune</span>
            <span data-i18n="admin.map.filtersToggle">Filters</span>
          </button>
          <span class="ash-entity-count" id="ashMapCount"></span>
          <div class="ash-map-toolbar-row" id="ashMapFilterRow">
            <select id="ashMapStatusFilter" class="ash-entity-select"></select>
            <select id="ashMapVerifiedFilter" class="ash-entity-select"></select>
            <select id="ashMapCityFilter" class="ash-entity-select"></select>
            <select id="ashMapTypeFilter" class="ash-entity-select"></select>
            <label style="display:flex; align-items:center; gap:5px; font:500 12px/1.3 'Inter',sans-serif; color:var(--ash-text); cursor:pointer; user-select:none; flex:none;">
              <input type="checkbox" id="ashMapBoundariesToggle" checked/>
              <span data-i18n="map.legendAdminArea">Administrative Area</span>
            </label>
          </div>
        </div>
        <div id="ashMapCanvas" class="ash-map-canvas"></div>
        <div class="ash-map-legend">
          <span class="ash-map-legend-item"><span class="ash-map-legend-dot"></span><span data-i18n="common.verified">Verified</span></span>
          <span class="ash-map-legend-item"><span class="ash-map-legend-dot unverified"></span><span data-i18n="admin.filterUnverified">Unverified</span></span>
          <span class="ash-map-legend-item"><span class="ash-map-legend-dot" style="background:#17150F; box-shadow:0 0 0 2px #9c6ade;"></span><span data-i18n="admin.legendPrivateListing">Private (full access)</span></span>
          <span class="ash-map-legend-item"><span class="ash-map-legend-line"></span><span data-i18n="map.legendAdminArea">Administrative Area</span></span>
        </div>
        <div class="ash-map-status-overlay hidden" id="ashMapStatusOverlay"></div>
      </div>
      <div class="ash-map-detail" id="ashMapDetail">
        <div class="ash-map-detail-empty" id="ashMapDetailEmpty" data-i18n="admin.map.selectAListing">Select a listing on the map to see its details.</div>
      </div>
    </div>
  `;

  document.getElementById('ashMapStatusFilter').innerHTML = `
    <option value="all" data-i18n="admin.filterAll">All</option>
    <option value="active" data-i18n="admin.map.filterStatusActive">Active</option>
    <option value="closed" data-i18n="admin.map.filterStatusClosed">Closed (sold/rented)</option>
  `;
  document.getElementById('ashMapVerifiedFilter').innerHTML = `
    <option value="all" data-i18n="admin.filterAll">All</option>
    <option value="verified" data-i18n="common.verified">Verified</option>
    <option value="unverified" data-i18n="admin.filterUnverified">Unverified</option>
  `;
  document.getElementById('ashMapCityFilter').innerHTML = `
    <option value="all" data-i18n="admin.filterAll">All</option>
    ${KNOWN_CITY_NAMES.map((c) => `<option value="${c}" data-i18n="${CITY_LABEL_KEYS[c]}">${c}</option>`).join('')}
  `;
  document.getElementById('ashMapTypeFilter').innerHTML = `
    <option value="all" data-i18n="admin.filterAll">All</option>
    ${Object.keys(PROPERTY_TYPE_LABEL_KEYS).map((t) => `<option value="${t}" data-i18n="${PROPERTY_TYPE_LABEL_KEYS[t]}">${t}</option>`).join('')}
  `;
  // The site-wide translation sweep only runs at page load and on an
  // explicit language switch (see js/i18n.js) -- this shell is built
  // lazily, on first click, well after DOMContentLoaded, so it needs its
  // own pass over the data-i18n attributes it just added.
  if (window.applyTranslations && window.getLang) window.applyTranslations(window.getLang());

  let searchTimer = null;
  document.getElementById('ashMapSearchInput').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    const val = e.target.value;
    searchTimer = setTimeout(() => { state.filters.search = val; renderMarkers(); }, 180);
  });
  document.getElementById('ashMapStatusFilter').addEventListener('change', (e) => { state.filters.status = e.target.value; renderMarkers(); });
  document.getElementById('ashMapVerifiedFilter').addEventListener('change', (e) => { state.filters.verified = e.target.value; renderMarkers(); });
  document.getElementById('ashMapCityFilter').addEventListener('change', (e) => { state.filters.city = e.target.value; renderMarkers(); });
  document.getElementById('ashMapTypeFilter').addEventListener('change', (e) => { state.filters.type = e.target.value; renderMarkers(); });
  document.getElementById('ashMapBoundariesToggle').addEventListener('change', (e) => { setBoundariesVisible(e.target.checked); });
  document.getElementById('ashMapFilterToggle').addEventListener('click', () => {
    state.filtersOpen = !state.filtersOpen;
    document.getElementById('ashMapFilterRow').classList.toggle('open', state.filtersOpen);
    document.getElementById('ashMapFilterToggle').classList.toggle('active', state.filtersOpen);
    if (state.map) setTimeout(() => state.map.invalidateSize(), 220);
  });
}

// ---------------------------------------------------------------------
// Leaflet map -- same base tiles + administrative boundaries helper
// map.html uses, via window.DarweshLeafletHelpers. Reuses window.L, the
// same Leaflet global instance every other Leaflet surface on this page
// (#requestDetailMap) already reads off `window`.
// ---------------------------------------------------------------------
function initLeafletMap() {
  const L = window.L;
  const map = L.map('ashMapCanvas', { zoomControl: false }).setView([36.35, 44.3], 8);
  L.control.zoom({ position: 'bottomright' }).addTo(map);
  window.DarweshLeafletHelpers.addBaseTiles(L, map, 'light');
  state.map = map;
  state.markerLayer = L.layerGroup().addTo(map);

  let moveTimer = null;
  map.on('moveend zoomend', () => {
    clearTimeout(moveTimer);
    moveTimer = setTimeout(renderMarkers, 120);
  });

  loadBoundaries();
}

async function loadBoundaries() {
  if (state.boundariesLoaded) return;
  state.boundariesLoaded = true;
  const L = window.L;
  const shapes = await window.DarweshLeafletHelpers.fetchAdministrativeBoundaries(KNOWN_CITY_NAMES);
  shapes.forEach((shape) => window.DarweshLeafletHelpers.drawBoundaryShape(L, state.map, shape, state.boundaryLayers));
}
function setBoundariesVisible(visible) {
  state.boundaryLayers.forEach((layer) => {
    if (visible) { if (!state.map.hasLayer(layer)) layer.addTo(state.map); }
    else state.map.removeLayer(layer);
  });
}

// ---------------------------------------------------------------------
// Data -- window.DarweshListingAccess.queryAdminListings(): every listing
// regardless of status/private/verified (a moderation view needs to see
// everything), capped for performance. Never a precise coordinate here.
// ---------------------------------------------------------------------
async function fetchListings() {
  state.loading = true;
  state.error = null;
  renderStatusOverlay();
  try {
    const fns = { collection, query, limit: fsLimit, getDocs };
    const docs = await window.DarweshListingAccess.queryAdminListings(fns, db, {});
    state.listings = docs.map(normalizeListing).filter((l) => l._lat !== null && l._lng !== null);
  } catch (err) {
    state.error = err;
    state.listings = [];
  } finally {
    state.loading = false;
    renderStatusOverlay();
    renderMarkers();
  }
}

function renderStatusOverlay() {
  const el = document.getElementById('ashMapStatusOverlay');
  if (!el) return;
  if (state.loading && !state.listings.length) {
    el.classList.remove('hidden');
    el.innerHTML = `<p class="ash-entity-loading">${esc(tr('admin.entity.loading', 'Loading…'))}</p>`;
    return;
  }
  if (state.error) {
    el.classList.remove('hidden');
    el.innerHTML = `<div class="ash-entity-error">${esc(tr('admin.entity.loadFailedMap', 'Could not load listings for the map.'))}
      <div><button type="button" class="ash-entity-retry" id="ashMapRetryBtn">${esc(tr('admin.entity.retry', 'Retry'))}</button></div></div>`;
    document.getElementById('ashMapRetryBtn')?.addEventListener('click', fetchListings);
    return;
  }
  el.classList.add('hidden');
  el.innerHTML = '';
}

// ---------------------------------------------------------------------
// Filtering + clustering + markers. Clustering reuses map.html's own
// hand-rolled pixel-grid algorithm (window.DarweshMarker.
// buildPixelGridClusters) instead of a second implementation.
// ---------------------------------------------------------------------
function filteredListings() {
  const f = state.filters;
  const q = (f.search || '').trim().toLowerCase();
  return state.listings.filter((l) => {
    if (f.status !== 'all' && l.status !== f.status) return false;
    if (f.verified === 'verified' && !l.verified) return false;
    if (f.verified === 'unverified' && l.verified) return false;
    if (f.city !== 'all' && (l.city || '').toLowerCase() !== f.city.toLowerCase()) return false;
    if (f.type !== 'all' && l.propertyType !== f.type) return false;
    if (q && !((l.title || '').toLowerCase().includes(q) || (l.address || '').toLowerCase().includes(q) ||
                (l.city || '').toLowerCase().includes(q) || (l.agentName || '').toLowerCase().includes(q))) return false;
    return true;
  });
}

function renderMarkers() {
  if (!state.map || !state.markerLayer) return;
  const L = window.L;
  state.markerLayer.clearLayers();
  const visible = filteredListings();
  const countEl = document.getElementById('ashMapCount');
  if (countEl) countEl.textContent = tr('admin.entity.countLabelMap', '{n} listings').replace('{n}', String(visible.length));

  const zoom = state.map.getZoom();
  const compact = zoom < 12;
  const { clusters, solo } = window.DarweshMarker.buildPixelGridClusters(
    state.map,
    visible.map((l) => ({ id: l.id, lat: l._lat, lng: l._lng })),
    { activeId: state.activeId, gridPx: 52 }
  );
  const byId = new Map(visible.map((l) => [l.id, l]));

  solo.forEach((pt) => {
    const l = byId.get(pt.id);
    if (!l) return;
    const marker = L.marker([l._lat, l._lng], {
      icon: window.DarweshMarker.priceIcon(L, l, { active: l.id === state.activeId, compact, private: true })
    });
    marker.on('click', () => openDetail(l.id));
    state.markerLayer.addLayer(marker);
  });
  clusters.forEach((group) => {
    const avgLat = group.reduce((s, g) => s + g.lat, 0) / group.length;
    const avgLng = group.reduce((s, g) => s + g.lng, 0) / group.length;
    const marker = L.marker([avgLat, avgLng], { icon: window.DarweshMarker.clusterIcon(L, group.length, tr('map.clusterOf', 'Group of listings')) });
    marker.on('click', () => state.map.setView([avgLat, avgLng], Math.min(zoom + 2, 17)));
    state.markerLayer.addLayer(marker);
  });

  // The active listing (open in the detail panel) always gets its own
  // marker drawn on top, even mid-cluster, at the best coordinate known
  // right now -- the precise one once loaded, the approximate one before
  // that -- so the panel and the map never show two different points.
  if (state.activeId) {
    const active = byId.get(state.activeId) || state.listings.find((l) => l.id === state.activeId);
    if (active) {
      const lat = active._preciseLat != null ? active._preciseLat : active._lat;
      const lng = active._preciseLng != null ? active._preciseLng : active._lng;
      if (lat != null && lng != null) {
        const marker = L.marker([lat, lng], { icon: window.DarweshMarker.priceIcon(L, active, { active: true, compact: false, private: true }), zIndexOffset: 1000 });
        marker.on('click', () => openDetail(active.id));
        state.markerLayer.addLayer(marker);
      }
    }
  }
}

// ---------------------------------------------------------------------
// Detail panel -- docked beside the map (see css/admin-shell.css's
// .ash-map-* block for why this is NOT the .ash-detail-backdrop modal
// Organizations/Professionals use: the map has to stay clickable while
// this is open, for Edit Location). Every inner element still reuses the
// .ash-detail-* component family.
// ---------------------------------------------------------------------
let locationEditHandle = null;
let editingLocation = false;

function closeDetail() {
  stopLocationEdit();
  state.activeId = null;
  const host = document.getElementById('ashMapDetail');
  if (host) host.innerHTML = `<div class="ash-map-detail-empty" data-i18n="admin.map.selectAListing">${esc(tr('admin.map.selectAListing', 'Select a listing on the map to see its details.'))}</div>`;
  renderMarkers();
}

async function openDetail(id) {
  const listing = state.listings.find((l) => l.id === id);
  if (!listing) return;
  stopLocationEdit();
  state.activeId = id;
  renderMarkers();
  state.map.setView([listing._lat, listing._lng], Math.max(state.map.getZoom(), 14));
  renderDetailPanel(listing);

  // Precise coordinate: fetched ONLY for this one open listing, never in
  // bulk -- the one call site in this whole file, by design.
  try {
    const locationMod = await import('./listing-location.js');
    const precise = await window.DarweshListingAccess.fetchPreciseLocationFor(locationMod, { doc, getDoc }, db, id);
    if (state.activeId !== id) return; // panel moved on while this was in flight
    if (precise) { listing._preciseLat = precise.lat; listing._preciseLng = precise.lng; }
    renderDetailPanel(listing);
    renderMarkers();
  } catch {
    // Precise location genuinely unavailable/unauthorized -- the panel
    // already shows the approximate pair as a fallback, see
    // renderLocationSection(). Never a silent wrong value.
  }
}

function statusBadgeHtml(l) {
  if (l.status === 'closed') {
    const label = l.dealType === 'rent' ? tr('admin.statusRented', 'Rented') : tr('admin.statusSold', 'Sold');
    return `<span class="badge" style="background:#e5e8ee; color:#181c20;">${esc(label)}</span>`;
  }
  return `<span class="badge badge-sale">${esc(tr('admin.map.filterStatusActive', 'Active'))}</span>`;
}

// Every string below is resolved via tr() AT RENDER TIME rather than
// left for a later document-wide applyTranslations() sweep: this panel
// is rebuilt on every marker click/language change, not just once at
// page load, so it has to be correct in the current language the moment
// it's built (data-i18n attributes are still added alongside, so an
// in-place language switch while this exact panel instance is open also
// picks it up via the normal sweep -- belt and suspenders, not a
// substitute for the inline call).
function renderLocationSection(listing) {
  if (editingLocation) {
    return `
      <div class="ash-detail-section-title" data-i18n="admin.map.preciseLocation">${esc(tr('admin.map.preciseLocation', 'Precise location'))}</div>
      <p class="ash-detail-note-text" data-i18n="map.editLocationInstruction">${esc(tr('map.editLocationInstruction', 'Tap the map to place the pin, then drag to fine-tune.'))}</p>
      <p class="ash-detail-note-text" id="ashMapLocEditReadout" style="font-family:'Inter',monospace;"></p>
      <div class="ash-detail-actions">
        <button type="button" class="ash-detail-btn" id="ashMapLocCancelBtn" data-i18n="map.cancelEdit">${esc(tr('map.cancelEdit', 'Cancel'))}</button>
        <button type="button" class="ash-detail-btn ash-detail-btn-primary" id="ashMapLocSaveBtn" disabled data-i18n="map.saveLocation">${esc(tr('map.saveLocation', 'Save Location'))}</button>
      </div>
    `;
  }
  const lat = listing._preciseLat != null ? listing._preciseLat : listing._lat;
  const lng = listing._preciseLng != null ? listing._preciseLng : listing._lng;
  const isPrecise = listing._preciseLat != null;
  // Matches the un-localized "(approx.)" convention admin.html's own
  // listingCoordLabel() already uses for the exact same distinction --
  // one technical marker, not a translated sentence.
  const coordText = lat != null
    ? (isPrecise ? '' : '≈ ') + lat.toFixed(5) + ', ' + lng.toFixed(5) + (isPrecise ? '' : ' (approx.)')
    : tr('admin.map.preciseLocationUnavailable', 'No precise location on file yet.');
  return `
    <div class="ash-detail-section-title" data-i18n="admin.map.preciseLocation">${esc(tr('admin.map.preciseLocation', 'Precise location'))}</div>
    <p class="ash-detail-note-text" style="font-family:'Inter',monospace;">${esc(coordText)}</p>
    <div class="ash-detail-actions">
      <button type="button" class="ash-detail-btn" id="ashMapLocEditBtn" data-i18n="map.editLocation">${esc(tr('map.editLocation', 'Edit Location'))}</button>
    </div>
  `;
}

function renderDetailPanel(listing) {
  const host = document.getElementById('ashMapDetail');
  if (!host) return;
  const priceLabel = listing.priceLabel;
  const kv = [];
  kv.push([tr('map.homeType', 'Property Type'), esc(tr(PROPERTY_TYPE_LABEL_KEYS[listing.propertyType], listing.propertyType || '—'))]);
  kv.push([tr('sell.dealType', 'Deal type'), esc(listing.dealType === 'rent' ? tr('common.forRent', 'For Rent') : tr('common.forSale', 'For Sale'))]);
  kv.push([tr('sell.city', 'City'), esc(listing.city || '—')]);
  kv.push([tr('admin.entity.district', 'District'), esc(listing.district || listing.address || '—')]);
  if (listing.beds !== null) kv.push([tr('common.beds', 'Beds'), String(listing.beds)]);
  if (listing.baths !== null) kv.push([tr('common.baths', 'Baths'), String(listing.baths)]);
  if (listing.sqft !== null) kv.push(['m²', String(listing.sqft)]);
  kv.push([tr('admin.map.agentOwner', 'Agent / Owner'), esc(listing.agentName || listing.agentId || '—')]);
  if (listing.companyId) kv.push([tr('admin.ei.office', 'Office'), esc(listing.companyId)]);
  // Organization ID left un-localized, matching the same convention as
  // admin.html's own Estate Data "Lat/Lng" row -- a raw identifier, not a
  // sentence, and reusing a mismatched key (e.g. the Organizations
  // table's "Name" column header) would read wrong once translated.
  if (listing.publisherOrgId) kv.push(['Organization ID', esc(listing.publisherOrgId)]);
  kv.push([tr('admin.entity.created', 'Created'), esc(fmtDate(listing.createdAt))]);
  kv.push([tr('admin.entity.updated', 'Updated'), esc(fmtDate(listing.updatedAt))]);

  host.innerHTML = `
    <div class="ash-detail-head" style="position:sticky; top:0;">
      <div>
        <div class="ash-detail-title">${esc(listing.title || listing.address || tr('admin.map.untitledListing', 'Listing'))}</div>
        <div class="ash-detail-sub">${esc(listing.address || '')}${listing.address ? ', ' : ''}${esc(listing.city || '')}</div>
      </div>
      <button type="button" class="ash-detail-close" id="ashMapDetailCloseBtn" aria-label="Close"><span class="material-symbols-outlined" aria-hidden="true">close</span></button>
    </div>
    <div class="ash-detail-body">
      ${listing.img ? `<img src="${esc(listing.img)}" alt="" style="width:100%; aspect-ratio:16/10; object-fit:cover; border-radius:12px;">` : ''}
      <div style="display:flex; flex-wrap:wrap; gap:6px; align-items:center;">
        <span class="ash-detail-title" style="font-size:20px;">${esc(priceLabel)}</span>
        ${statusBadgeHtml(listing)}
        ${listing.verified ? `<span class="badge badge-verified">${esc(tr('common.verified', 'Verified'))}</span>` : `<span class="badge badge-private">${esc(tr('admin.filterUnverified', 'Unverified'))}</span>`}
        ${listing.private ? `<span class="badge" style="background:rgba(156,106,222,0.16); color:#7a3fc2;">${esc(tr('admin.legendPrivateListing', 'Private (full access)'))}</span>` : ''}
      </div>
      <div>
        <div class="ash-detail-section-title" data-i18n="admin.entity.sectionOverview">${esc(tr('admin.entity.sectionOverview', 'Overview'))}</div>
        <dl class="ash-detail-kv">
          ${kv.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}
        </dl>
      </div>
      <div id="ashMapLocationSection">${renderLocationSection(listing)}</div>
      ${listing.estateId ? `<details id="ashMapEstateDetails">
        <summary class="ash-detail-section-title" style="cursor:pointer; display:list-item;" data-i18n="admin.map.estateSectionTitle">${esc(tr('admin.map.estateSectionTitle', 'Estate & transaction history'))}</summary>
        <div id="ashMapEstateBody" style="margin-top:10px;"><p class="ash-detail-note-text" style="opacity:.6;">${esc(tr('admin.entity.loading', 'Loading…'))}</p></div>
      </details>` : ''}
      <div>
        <div class="ash-detail-section-title" data-i18n="admin.entity.sectionRelated">${esc(tr('admin.entity.sectionRelated', 'Related records'))}</div>
        <div class="ash-detail-actions">
          <button type="button" class="ash-detail-btn" id="ashMapEditListingBtn" data-i18n="common.edit">${esc(tr('common.edit', 'Edit'))}</button>
          <a class="ash-detail-btn" href="listing.html?id=${encodeURIComponent(listing.id)}" target="_blank" rel="noopener" data-i18n="admin.ei.viewCurrentListing">${esc(tr('admin.ei.viewCurrentListing', 'View Current Listing'))}</a>
          ${listing.sourceSubmissionId ? `<button type="button" class="ash-detail-btn" id="ashMapViewSubmissionBtn" data-i18n="admin.manage">${esc(tr('admin.manage', 'Manage'))}</button>` : ''}
        </div>
      </div>
    </div>
  `;

  document.getElementById('ashMapDetailCloseBtn').addEventListener('click', closeDetail);
  document.getElementById('ashMapEditListingBtn').addEventListener('click', () => {
    if (window.jumpToListingFromMap) window.jumpToListingFromMap(listing.id);
  });
  const subBtn = document.getElementById('ashMapViewSubmissionBtn');
  if (subBtn) subBtn.addEventListener('click', () => { if (window.jumpToSubmissionFromMap) window.jumpToSubmissionFromMap(listing.sourceSubmissionId); });

  wireLocationSection(listing);
  if (listing.estateId) loadEstateSection(listing);
}

// ---------------------------------------------------------------------
// Location edit -- window.DarweshLocationEdit on THIS tab's own live map
// instance (never a second mini-map), same Save/Cancel contract map.html's
// My Properties mode already uses. Writes go through the existing,
// unmodified js/listing-location.js chokepoint (fetchPreciseLocation/
// writePreciseLocation/publicCoordsFrom) -- never a re-implementation.
// ---------------------------------------------------------------------
function wireLocationSection(listing) {
  if (editingLocation) {
    const readout = document.getElementById('ashMapLocEditReadout');
    const saveBtn = document.getElementById('ashMapLocSaveBtn');
    document.getElementById('ashMapLocCancelBtn').addEventListener('click', () => {
      stopLocationEdit();
      renderDetailPanel(listing);
      renderMarkers();
    });
    saveBtn.addEventListener('click', async () => {
      const ll = locationEditHandle && locationEditHandle.getLatLng();
      if (!ll) return;
      saveBtn.disabled = true;
      try {
        const locationMod = await import('./listing-location.js');
        await locationMod.writePreciseLocation({ doc, setDoc, serverTimestamp }, db, listing.id, ll.lat, ll.lng);
        const publicCoords = locationMod.publicCoordsFrom(ll.lat, ll.lng);
        if (publicCoords.publicLat !== undefined) {
          await setDoc(doc(db, 'listings', listing.id), publicCoords, { merge: true });
          listing._lat = publicCoords.publicLat;
          listing._lng = publicCoords.publicLng;
        }
        listing._preciseLat = ll.lat;
        listing._preciseLng = ll.lng;
        toast(tr('map.locationSaved', 'Location saved'), 'success');
        stopLocationEdit();
        renderDetailPanel(listing);
        renderMarkers();
      } catch (err) {
        toast(tr('map.locationSaveFailed', 'Could not save the location — try again'), 'error');
        saveBtn.disabled = false;
      }
    });
    if (!locationEditHandle) {
      const L = window.L;
      const seed = listing._preciseLat != null ? [listing._preciseLat, listing._preciseLng]
        : (listing._lat != null ? [listing._lat, listing._lng] : null);
      locationEditHandle = window.DarweshLocationEdit.start(L, state.map, {
        initialLatLng: seed,
        onChange: (lat, lng) => {
          if (readout) readout.textContent = lat.toFixed(5) + ', ' + lng.toFixed(5);
          if (saveBtn) saveBtn.disabled = false;
        }
      });
      if (seed) readout.textContent = seed[0].toFixed(5) + ', ' + seed[1].toFixed(5);
    }
    return;
  }
  const editBtn = document.getElementById('ashMapLocEditBtn');
  if (editBtn) {
    editBtn.addEventListener('click', () => {
      editingLocation = true;
      renderDetailPanel(listing);
    });
  }
}
function stopLocationEdit() {
  if (locationEditHandle) { locationEditHandle.stop(); locationEditHandle = null; }
  editingLocation = false;
}

// ---------------------------------------------------------------------
// Estate & transaction history -- ported from the old #estateIntelMap
// tab's renderEiSidePanel(). Real Firestore reads only (estates/{id} +
// its transactionHistory subcollection); rendered only when the listing
// actually carries an estateId, and only what those documents really
// contain -- never fabricated when a field is absent.
// ---------------------------------------------------------------------
async function loadEstateSection(listing) {
  const body = document.getElementById('ashMapEstateBody');
  if (!body) return;
  let estate = null, txCount = null, lastTx = null;
  try {
    const estateSnap = await getDoc(doc(db, 'estates', listing.estateId));
    if (estateSnap.exists()) estate = { id: estateSnap.id, ...estateSnap.data() };
    const txSnap = await getDocs(collection(db, 'estates', listing.estateId, 'transactionHistory'));
    txCount = txSnap.size;
    let latest = null;
    txSnap.forEach((d) => { const data = d.data(); if (!latest || (data.createdAt || 0) > (latest.createdAt || 0)) latest = data; });
    lastTx = latest;
  } catch {
    // Admin-only subcollection -- degrade to "no transaction data" rather
    // than breaking the rest of the panel.
  }
  if (state.activeId !== listing.id) return; // panel moved on while this was in flight

  const rows = [
    [tr('admin.ei.estateId', 'Estate ID'), esc(listing.estateId)],
    [tr('common.verified', 'Verified'), estate ? (estate.verified ? esc(tr('common.verified', 'Verified')) : esc(tr('admin.ei.unverified', 'Unverified'))) : '—'],
    [tr('admin.ei.lastVerifiedSale', 'Last Verified Sale'), lastTx ? esc('$' + Number(lastTx.priceAmount).toLocaleString() + ' (' + lastTx.transactionDate + ')') : `<span style="opacity:.7;">${esc(tr('admin.ei.noVerifiedSale', 'No verified transaction on record'))}</span>`],
    [tr('admin.ei.priorTxCount', 'Previous Verified Transactions'), String(txCount ?? 0)],
  ];
  body.innerHTML = `
    <dl class="ash-detail-kv">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>
    <div class="ash-detail-actions" style="margin-top:10px;">
      <button type="button" class="ash-detail-btn" id="ashMapEstateRecordBtn" data-i18n="admin.ei.viewEstateRecord">${esc(tr('admin.ei.viewEstateRecord', 'View Estate Record'))}</button>
    </div>
  `;
  document.getElementById('ashMapEstateRecordBtn')?.addEventListener('click', () => {
    if (window.jumpToEstateData) window.jumpToEstateData(listing.estateId);
  });
}

// ---------------------------------------------------------------------
// Public entry point, called from admin.html's tab-dispatch block --
// same lazy-init-on-first-click pattern as js/admin-orgs-pros.js's
// renderOrgsTab/renderProsTab.
// ---------------------------------------------------------------------
export function renderMapTab() {
  ensureShell();
  if (!state.inited) {
    state.inited = true;
    initLeafletMap();
    fetchListings();
    return;
  }
  setTimeout(() => { if (state.map) state.map.invalidateSize(); }, 50);
}

document.addEventListener('darwesh:langchange', () => {
  // window.setLanguage() already re-swept the whole DOM before this event
  // fires; re-render only the parts built from JS state/logic (marker
  // labels, the open detail panel), which a text-sweep can't reach.
  if (!state.inited) return;
  renderMarkers();
  if (state.activeId) {
    const active = state.listings.find((l) => l.id === state.activeId);
    if (active) renderDetailPanel(active);
  }
});
