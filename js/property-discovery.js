// Darwesh Group -- Property Discovery. The ONE shared engine behind
// buy.html and rent.html, replacing two independently-reinvented pages
// (separate query builders, separate pagination, separate cards, only
// rent.html had real city/price-range filters and full URL state). Same
// pattern already proven in this codebase by js/provider-discovery.js
// (one module, mounted per page with a config object).
//
// mode: 'buy' | 'rent' | 'all'. buy.html mounts {mode:'buy'}, rent.html
// mounts {mode:'rent'}; either may switch mode at runtime via the Liquid
// Glass selector without a page navigation -- the URL's own `mode` param
// (not the filename) is what's authoritative once the page is open, so
// a deep link like buy.html?mode=all still opens correctly.
//
// QUERY STRATEGY. 'buy'/'rent' issue exactly the query buy.html/rent.html
// already issued (dealType equality + optional city/type/price-range,
// matching firestore.indexes.json's existing composite indexes -- no
// index changes needed). 'all' does NOT use a dealType `in` query: it
// runs the SAME two proven per-dealType queries in parallel, each with
// its own real Firestore cursor, and merges the two already-sorted
// result lists client-side. This was the deliberate, safer choice over
// verifying/adding a new index for an `in` query -- see the completion
// report.
//
// FAVORITES. js/rail-favorites.js -- the 'buy-'+id convention, shared
// with every other surface on the site (unchanged).
import { createFavoritesController } from './rail-favorites.js';

const PAGE_SIZE = 12;
const PROPERTY_TYPES = ['house', 'villa', 'apartment', 'land', 'building', 'office', 'shop', 'commercialProperty'];
const CITIES = ['Erbil', 'Sulaymaniyah', 'Duhok', 'Zakho', 'Soran', 'Koya', 'Halabja', 'Kirkuk'];
const SORTS = ['newest', 'price-asc', 'price-desc'];
const MODES = ['buy', 'rent', 'all'];

function tr(key, fallback) { return (window.t && window.t(key)) || fallback; }
function trf(key, fallback, vars) {
  const s = tr(key, fallback);
  return Object.keys(vars || {}).reduce((acc, k) => acc.replace(`{${k}}`, vars[k]), s);
}
function dealTypesFor(mode) { return mode === 'all' ? ['sale', 'rent'] : [mode === 'buy' ? 'sale' : 'rent']; }
function cityLabel(c) { return (window.cityLabel && window.cityLabel(c)) || c || ''; }

const DENSITIES = [3, 4, 5];
const DENSITY_KEY = 'darwesh_property_density';
function readDensity() {
  try {
    const v = Number(localStorage.getItem(DENSITY_KEY));
    if (DENSITIES.includes(v)) return v;
  } catch { /* localStorage unavailable (private mode, etc.) -- fall through to default */ }
  return 4;
}
function writeDensity(v) {
  try { localStorage.setItem(DENSITY_KEY, String(v)); } catch { /* best-effort only */ }
}
function densityGlyph(n) {
  const total = 18, gap = n === 3 ? 3.2 : n === 4 ? 2.4 : 1.8;
  const barW = (total - gap * (n - 1)) / n;
  let x = 0;
  const rects = [];
  for (let i = 0; i < n; i++) {
    rects.push(`<rect x="${x.toFixed(2)}" y="2" width="${barW.toFixed(2)}" height="10" rx="1.1"/>`);
    x += barW + gap;
  }
  return `<svg viewBox="0 0 18 14" width="15" height="12" fill="currentColor" aria-hidden="true">${rects.join('')}</svg>`;
}

// Mobile's own 2/3 chooser -- separate control, separate storage key, and a
// visibly smaller glyph than densityGlyph() above, so it never reads as the
// same control as the desktop 3/4/5 one.
const MOBILE_DENSITIES = [2, 3];
const MOBILE_DENSITY_KEY = 'darwesh_property_mobile_density';
function readMobileDensity() {
  try {
    const v = Number(localStorage.getItem(MOBILE_DENSITY_KEY));
    if (MOBILE_DENSITIES.includes(v)) return v;
  } catch { /* localStorage unavailable -- fall through to default */ }
  return 2;
}
function writeMobileDensity(v) {
  try { localStorage.setItem(MOBILE_DENSITY_KEY, String(v)); } catch { /* best-effort only */ }
}
function densityGlyphSmall(n) {
  const total = 13, gap = n === 2 ? 2.4 : 1.6;
  const barW = (total - gap * (n - 1)) / n;
  let x = 0;
  const rects = [];
  for (let i = 0; i < n; i++) {
    rects.push(`<rect x="${x.toFixed(2)}" y="2" width="${barW.toFixed(2)}" height="8" rx="0.9"/>`);
    x += barW + gap;
  }
  return `<svg viewBox="0 0 13 12" width="11" height="10" fill="currentColor" aria-hidden="true">${rects.join('')}</svg>`;
}

export function mountPropertyDiscovery(root, opts) {
  if (!root) return;
  const defaultMode = MODES.includes(opts.mode) ? opts.mode : 'buy';
  let density = readDensity();
  let mobileDensity = readMobileDensity();

  root.innerHTML = `
    <section class="pd-hero">
      <p class="pd-eyebrow" data-i18n="discover.eyebrow">Darwesh Property Discovery</p>
      <h1 class="pd-headline" data-i18n="discover.headline">Find the place that fits your life.</h1>
      <p class="pd-subhead" data-i18n="discover.subhead">Every verified listing across Kurdistan, for sale or for rent, in one place.</p>
      <div class="pd-mode-row">
        <div class="dw-mode-switch glass-spatial" role="tablist" aria-label="${trf('discover.modeLabel', 'Property mode', {})}">
          <button type="button" class="dw-mode-switch-btn" data-mode="all" role="tab" aria-selected="false" data-i18n="discover.modeAll">All</button>
          <button type="button" class="dw-mode-switch-btn" data-mode="buy" role="tab" aria-selected="false" data-i18n="discover.modeBuy">Buy</button>
          <button type="button" class="dw-mode-switch-btn" data-mode="rent" role="tab" aria-selected="false" data-i18n="discover.modeRent">Rent</button>
        </div>
      </div>
    </section>

    <section class="pd-search-surface">
      <div class="pd-search-row glass-spatial">
        <span class="material-symbols-outlined pd-search-icon" aria-hidden="true">search</span>
        <input id="pdSearchInput" class="pd-search-input" type="text" data-i18n-placeholder-manual="discover.searchPlaceholder" placeholder="Search city, neighborhood or property" aria-label="${trf('discover.searchPlaceholder', 'Search city, neighborhood or property', {})}"/>
      </div>
      <div class="pd-controls-row">
        <select id="pdTypeFilter" class="pd-select glass-light" aria-label="${trf('discover.propertyType', 'Property type', {})}">
          <option value="all" data-i18n="buy.allHomeTypes">All Home Types</option>
          <option value="house" data-i18n="map.house">House</option>
          <option value="villa" data-i18n="map.villa">Villa</option>
          <option value="apartment" data-i18n="map.apartment">Apartment</option>
          <option value="land" data-i18n="map.land">Land</option>
          <option value="building" data-i18n="map.building">Building</option>
          <option value="office" data-i18n="map.office">Office</option>
          <option value="shop" data-i18n="map.shop">Shop</option>
          <option value="commercialProperty" data-i18n="map.commercialProperty">Commercial Property</option>
        </select>
        <select id="pdCityFilter" class="pd-select glass-light" aria-label="${trf('discover.cityLabel', 'City', {})}">
          <option value="" data-i18n="buy.allCities">All Cities</option>
          <option value="Erbil" data-i18n="cities.erbil">Erbil</option>
          <option value="Sulaymaniyah" data-i18n="cities.sulaymaniyah">Sulaymaniyah</option>
          <option value="Duhok" data-i18n="cities.duhok">Duhok</option>
          <option value="Zakho" data-i18n="cities.zakho">Zakho</option>
          <option value="Soran" data-i18n="cities.soran">Soran</option>
          <option value="Koya" data-i18n="cities.koya">Koya</option>
          <option value="Halabja" data-i18n="cities.halabja">Halabja</option>
          <option value="Kirkuk" data-i18n="cities.kirkuk">Kirkuk</option>
        </select>
        <div class="pd-price-group glass-light">
          <input id="pdMinPrice" type="number" min="0" inputmode="numeric" class="pd-price-input" data-i18n-placeholder-manual="map.minPrice" placeholder="Min" aria-label="${trf('map.minPrice', 'Min Price', {})}"/>
          <span class="pd-price-sep" aria-hidden="true">&ndash;</span>
          <input id="pdMaxPrice" type="number" min="0" inputmode="numeric" class="pd-price-input" data-i18n-placeholder-manual="map.maxPrice" placeholder="Max" aria-label="${trf('map.maxPrice', 'Max Price', {})}"/>
        </div>
        <select id="pdBedsFilter" class="pd-select glass-light" aria-label="${trf('discover.bedsLabel', 'Beds', {})}">
          <option value="0" data-i18n="map.any">Any Beds</option>
          <option value="1">1+</option><option value="2">2+</option><option value="3">3+</option><option value="4">4+</option><option value="5">5+</option>
        </select>
        <button id="pdMoreFiltersBtn" type="button" class="pd-btn-outline glass-light" aria-controls="pdFilterDrawer">
          <span class="material-symbols-outlined text-[18px]" aria-hidden="true">tune</span>
          <span data-i18n="discover.moreFilters">More Filters</span>
        </button>
      </div>
      <div class="pd-actions-row">
        <a id="pdMapLink" class="pd-btn-ghost glass-light" href="map.html?type=sale">
          <span class="material-symbols-outlined text-[18px]" aria-hidden="true">map</span>
          <span data-i18n="buy.viewOnMap">View on Map</span>
        </a>
        <button id="pdSaveSearchBtn" type="button" class="pd-btn-ghost glass-light">
          <span class="material-symbols-outlined text-[18px]" aria-hidden="true">bookmark_add</span>
          <span data-i18n="map.saveSearch">Save Search</span>
        </button>
        <select id="pdSortFilter" class="pd-select glass-light pd-sort-select" aria-label="${trf('discover.sortLabel', 'Sort', {})}">
          <option value="newest" data-i18n="buy.newest">Newest</option>
          <option value="price-asc" data-i18n="buy.priceLowHigh">Price: Low to High</option>
          <option value="price-desc" data-i18n="buy.priceHighLow">Price: High to Low</option>
        </select>
      </div>
    </section>

    <div class="pd-toolbar-row">
      <p id="pdResultCount" class="pd-result-count" role="status" aria-live="polite"></p>
      <div id="pdDensitySwitch" class="dw-density-switch glass-light" role="group" aria-label="${trf('discover.densityLabel', 'View density', {})}">
        <button type="button" class="dw-density-switch-btn ${density === 3 ? 'is-active' : ''}" data-density="3" aria-pressed="${density === 3}" title="${trf('discover.densitySpacious', 'Spacious', {})}" aria-label="${trf('discover.densitySpacious', 'Spacious', {})}">${densityGlyph(3)}</button>
        <button type="button" class="dw-density-switch-btn ${density === 4 ? 'is-active' : ''}" data-density="4" aria-pressed="${density === 4}" title="${trf('discover.densityBalanced', 'Balanced', {})}" aria-label="${trf('discover.densityBalanced', 'Balanced', {})}">${densityGlyph(4)}</button>
        <button type="button" class="dw-density-switch-btn ${density === 5 ? 'is-active' : ''}" data-density="5" aria-pressed="${density === 5}" title="${trf('discover.densityCompact', 'Compact', {})}" aria-label="${trf('discover.densityCompact', 'Compact', {})}">${densityGlyph(5)}</button>
      </div>
      <div id="pdMobileDensitySwitch" class="dw-density-switch-sm glass-light" role="group" aria-label="${trf('discover.densityLabel', 'View density', {})}">
        <button type="button" class="dw-density-switch-sm-btn ${mobileDensity === 2 ? 'is-active' : ''}" data-mobile-density="2" aria-pressed="${mobileDensity === 2}" title="${trf('discover.densityBalanced', 'Balanced', {})}" aria-label="${trf('discover.densityBalanced', 'Balanced', {})}">${densityGlyphSmall(2)}</button>
        <button type="button" class="dw-density-switch-sm-btn ${mobileDensity === 3 ? 'is-active' : ''}" data-mobile-density="3" aria-pressed="${mobileDensity === 3}" title="${trf('discover.densityCompact', 'Compact', {})}" aria-label="${trf('discover.densityCompact', 'Compact', {})}">${densityGlyphSmall(3)}</button>
      </div>
    </div>
    <section id="pdGrid" class="pd-grid" data-density="${density}" data-mobile-density="${mobileDensity}" aria-live="polite"></section>

    <div id="pdEmptyState" class="pd-state hidden">
      <span class="material-symbols-outlined pd-state-icon" aria-hidden="true">search_off</span>
      <h2 class="pd-state-title" data-i18n="discover.emptyTitle">No properties match yet</h2>
      <p class="pd-state-body" data-i18n="discover.emptyBody">Try a different city, price range or property type.</p>
    </div>
    <p id="pdNoLocalMatches" class="pd-state-inline hidden" data-i18n="rent.noLocalMatches">No loaded listings match these filters yet. Try Load More or adjust your filters.</p>
    <div id="pdErrorState" class="pd-state hidden">
      <span class="material-symbols-outlined pd-state-icon pd-state-icon--error" aria-hidden="true">error</span>
      <h2 class="pd-state-title" data-i18n="discover.errorTitle">Couldn't load listings</h2>
      <p class="pd-state-body" data-i18n="discover.errorBody">Please check your connection and try again.</p>
      <button id="pdRetryBtn" type="button" class="pd-btn-primary" data-i18n="common.retry">Retry</button>
    </div>

    <div class="pd-pagination">
      <button id="pdLoadMoreBtn" type="button" class="pd-btn-outline glass-light hidden">
        <span id="pdLoadMoreSpinner" class="hidden material-symbols-outlined text-[18px] animate-spin" aria-hidden="true">progress_activity</span>
        <span data-i18n="rent.loadMore">Load More</span>
      </button>
      <p id="pdExhaustedNote" class="pd-exhausted-note hidden" data-i18n="rent.allLoaded">You've reached the end of the list.</p>
    </div>

    <div id="pdFilterDrawer" class="pd-drawer hidden">
      <div class="pd-drawer-panel glass-spatial">
        <div class="pd-drawer-head">
          <h3 class="pd-drawer-title" data-i18n="common.filters">Filters</h3>
          <button id="pdFilterCloseBtn" type="button" class="pd-drawer-close" aria-label="Close"><span class="material-symbols-outlined">close</span></button>
        </div>
        <div class="pd-drawer-grid">
          <div>
            <label for="pdBathsFilter" class="pd-drawer-label" data-i18n="common.baths">Baths</label>
            <select id="pdBathsFilter" class="pd-select glass-light w-full">
              <option value="0" data-i18n="map.any">Any</option><option value="1">1+</option><option value="2">2+</option><option value="3">3+</option><option value="4">4+</option>
            </select>
          </div>
          <div></div>
          <div>
            <label for="pdMinArea" class="pd-drawer-label" data-i18n="drm.minArea">Min Area (m²)</label>
            <input id="pdMinArea" type="number" min="0" class="pd-select glass-light w-full"/>
          </div>
          <div>
            <label for="pdMaxArea" class="pd-drawer-label" data-i18n="drm.maxArea">Max Area (m²)</label>
            <input id="pdMaxArea" type="number" min="0" class="pd-select glass-light w-full"/>
          </div>
          <div class="pd-drawer-checks">
            <label class="pd-check"><input type="checkbox" id="pdFurnished"/> <span data-i18n="rent.furnishedOnly">Furnished only</span></label>
            <label class="pd-check"><input type="checkbox" id="pdVerified"/> <span data-i18n="discover.verifiedOnly">Verified only</span></label>
          </div>
        </div>
        <div class="pd-drawer-actions">
          <button id="pdFilterApplyBtn" type="button" class="pd-btn-primary flex-1" data-i18n="map.apply">Apply</button>
          <button id="pdFilterClearBtn" type="button" class="pd-btn-outline glass-light" data-i18n="common.clear">Clear</button>
        </div>
      </div>
    </div>

    <div class="pd-toast" id="pdToast"></div>
  `;

  const $ = (id) => root.querySelector('#' + id);
  const show = (n) => n && n.classList.remove('hidden');
  const hide = (n) => n && n.classList.add('hidden');

  let mode = defaultMode;
  const state = { city: '', type: 'all', minPrice: 0, maxPrice: 0, sort: 'newest' };
  const pagination = { sale: mkBucket(), rent: mkBucket() };
  let loading = false, queryGeneration = 0, firstLoadDone = false, loadError = false;
  function mkBucket() { return { cursor: null, exhausted: false, loaded: [] }; }

  const fbReady = (async () => {
    const [{ auth, db, getDocs }, storeMod] = await Promise.all([
      import('./firebase-init.js'),
      import('https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js')
    ]);
    return {
      auth, db, getDocs,
      collection: storeMod.collection, query: storeMod.query, where: storeMod.where,
      orderBy: storeMod.orderBy, limit: storeMod.limit, startAfter: storeMod.startAfter,
      documentId: storeMod.documentId
    };
  })();

  function mapListingDoc(dealType, d) {
    return {
      id: d.id,
      dealType,
      title: d.title || d.address || 'Property',
      city: d.city || '',
      address: d.address || '',
      type: d.propertyType || '',
      price: Number(d.price) || 0,
      beds: Number(d.beds) || 0,
      baths: Number(d.baths) || 0,
      sqft: Number(d.sqft) || 0,
      img: listingImageUrl(d),
      verified: !!d.verified,
      furnished: Array.isArray(d.amenities) && d.amenities.includes('furnished'),
      createdAtMs: tsMillis(d.createdAt)
    };
  }
  function tsMillis(t) {
    if (!t) return 0;
    if (typeof t.toMillis === 'function') return t.toMillis();
    if (typeof t.seconds === 'number') return t.seconds * 1000;
    return 0;
  }

  function buildQuery(fb, dealType, cursor, pageSize) {
    const { collection, query, where, orderBy, limit, startAfter, documentId, db } = fb;
    const clauses = [
      where('private', '==', false),
      where('status', '==', 'active'),
      where('dealType', '==', dealType)
    ];
    if (state.city) clauses.push(where('city', '==', state.city));
    if (state.type !== 'all') clauses.push(where('propertyType', '==', state.type));
    if (state.minPrice > 0) clauses.push(where('price', '>=', state.minPrice));
    if (state.maxPrice > 0) clauses.push(where('price', '<=', state.maxPrice));
    if (state.sort === 'price-asc') clauses.push(orderBy('price', 'asc'));
    else if (state.sort === 'price-desc') clauses.push(orderBy('price', 'desc'));
    else clauses.push(orderBy('createdAt', 'desc'));
    clauses.push(orderBy(documentId()));
    if (cursor) clauses.push(startAfter(cursor));
    clauses.push(limit(pageSize));
    return query(collection(db, 'listings'), ...clauses);
  }

  async function fetchPage({ reset }) {
    if (loading) return;
    const active = dealTypesFor(mode);
    if (!reset && active.every((t) => pagination[t].exhausted)) return;

    const myGen = reset ? ++queryGeneration : queryGeneration;
    loading = true;
    updatePaginationUi();

    if (reset) {
      active.forEach((t) => { pagination[t] = mkBucket(); });
      loadError = false;
      $('pdGrid').innerHTML = Array.from({ length: PAGE_SIZE }).map(skeletonCard).join('');
      $('pdResultCount').textContent = tr('map.loadingListings', 'Loading listings…');
      hide($('pdEmptyState')); hide($('pdErrorState')); hide($('pdNoLocalMatches'));
    }

    try {
      const fb = await fbReady;
      const perType = Math.max(4, Math.ceil(PAGE_SIZE / active.length));
      await Promise.all(active.map(async (dealType) => {
        const bucket = pagination[dealType];
        if (!reset && bucket.exhausted) return;
        const snap = await fb.getDocs(buildQuery(fb, dealType, bucket.cursor, perType));
        if (myGen !== queryGeneration) return;
        const mapped = snap.docs.map((d) => mapListingDoc(dealType, { id: d.id, ...d.data() }));
        bucket.loaded = bucket.loaded.concat(mapped);
        if (snap.docs.length) bucket.cursor = snap.docs[snap.docs.length - 1];
        bucket.exhausted = snap.docs.length < perType;
      }));
      if (myGen !== queryGeneration) return;
      firstLoadDone = true;
      renderVisible();
    } catch (e) {
      if (myGen !== queryGeneration) return;
      if (reset || active.every((t) => pagination[t].loaded.length === 0)) {
        loadError = true;
        $('pdGrid').innerHTML = '';
        show($('pdErrorState'));
        hide($('pdEmptyState'));
      }
    }
    loading = false;
    updatePaginationUi();
  }

  function combinedListings() {
    const active = dealTypesFor(mode);
    let list = [];
    active.forEach((t) => { list = list.concat(pagination[t].loaded); });
    if (state.sort === 'price-asc') list.sort((a, b) => a.price - b.price);
    else if (state.sort === 'price-desc') list.sort((a, b) => b.price - a.price);
    else list.sort((a, b) => b.createdAtMs - a.createdAtMs);
    return list;
  }

  function updatePaginationUi() {
    const btn = $('pdLoadMoreBtn'), spinner = $('pdLoadMoreSpinner'), note = $('pdExhaustedNote');
    if (!btn) return;
    btn.disabled = loading;
    spinner.classList.toggle('hidden', !loading);
    const active = dealTypesFor(mode);
    const hasResults = active.some((t) => pagination[t].loaded.length > 0);
    const allExhausted = active.every((t) => pagination[t].exhausted);
    btn.classList.toggle('hidden', !(hasResults && !allExhausted));
    note.classList.toggle('hidden', !(hasResults && allExhausted));
  }

  // ---- Favorites -----------------------------------------------------
  const fav = createFavoritesController({
    onChange: renderVisible,
    showToast: (msg, icon) => showToast(msg, icon)
  });
  fav.init();

  function showToast(msg, icon) {
    const el = $('pdToast');
    el.innerHTML = `${icon ? `<span class="material-symbols-outlined text-[18px]">${icon}</span>` : ''}<span>${msg}</span>`;
    el.classList.add('show');
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => el.classList.remove('show'), 2600);
  }

  function fmtPrice(l) { return l.dealType === 'rent' ? '$' + l.price.toLocaleString() + tr('discover.perMonthSuffix', '/mo') : '$' + l.price.toLocaleString(); }

  function stateChip(l) {
    if (mode !== 'all') return '';
    const isRent = l.dealType === 'rent';
    return `<span class="pd-card-state ${isRent ? 'pd-card-state--rent' : 'pd-card-state--sale'}">${isRent ? esc(tr('discover.rentChip', 'Rent')) : esc(tr('discover.saleChip', 'Sale'))}</span>`;
  }

  function esc(s) { return escapeHtml(s); }

  function card(l) {
    const badge = l.verified ? `<div class="pd-verified-badge">
        <span class="material-symbols-outlined" aria-hidden="true">verified</span>
        <span>${esc(tr('common.verified', 'Verified'))}</span>
      </div>` : '';
    const favActive = fav.isFavorite(l.id);
    const favLabel = favActive ? tr('discover.removeFavoriteAria', 'Remove from favorites') : tr('discover.saveFavoriteAria', 'Save to favorites');
    const favBtn = `<button type="button" onclick="event.preventDefault(); event.stopPropagation(); window.__pdToggleFavorite('${l.id}');" class="pd-fav-btn ${favActive ? 'is-active' : ''}" aria-label="${esc(favLabel)}">
        <span class="material-symbols-outlined" style="font-variation-settings: 'FILL' ${favActive ? 1 : 0};" aria-hidden="true">favorite</span>
      </button>`;
    const img = l.img ? esc(l.img) : null;
    const noImage = `<span class="material-symbols-outlined text-[32px]" aria-hidden="true">home_work</span><span class="font-body-md text-[11px] px-3 text-center">${listingNoImageLabel()}</span>`;
    return `
    <a href="listing.html?id=${encodeURIComponent(l.id)}" class="pd-card glass-spatial relative overflow-hidden group block">
      <div class="pd-card-media relative overflow-hidden">
        ${img ? `<img loading="lazy" class="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500" src="${img}" alt="${esc(l.title)}" decoding="async"
          onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';"/>
        <div class="pd-card-media-fallback absolute inset-0 flex-col items-center justify-center gap-1" style="display:none;">${noImage}</div>` : `<div class="pd-card-media-fallback absolute inset-0 flex flex-col items-center justify-center gap-1">${noImage}</div>`}
        ${stateChip(l)}
        ${favBtn}
        ${badge}
      </div>
      <div class="pd-card-body">
        <h3 class="pd-card-title">${esc(l.title)}</h3>
        <p class="pd-card-loc"><span class="material-symbols-outlined text-[15px]" aria-hidden="true">location_on</span>${l.address ? esc(l.address) + ', ' : ''}${esc(cityLabel(l.city))}</p>
        <div class="pd-card-foot">
          <div class="pd-card-meta">
            <span><span class="material-symbols-outlined text-[16px]" aria-hidden="true">bed</span>${l.beds}</span>
            <span><span class="material-symbols-outlined text-[16px]" aria-hidden="true">bathtub</span>${l.baths}</span>
            <span><span class="material-symbols-outlined text-[16px]" aria-hidden="true">square_foot</span>${l.sqft}m²</span>
          </div>
          <span class="pd-card-price-wrap">
            <span class="pd-card-price">${fmtPrice(l)}</span>
            <span class="pd-card-arrow" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg></span>
          </span>
        </div>
      </div>
    </a>`;
  }
  window.__pdToggleFavorite = (id) => {
    const l = combinedListings().find((x) => x.id === id);
    if (l) fav.toggle(id, l, () => fmtPrice(l));
  };

  function skeletonCard() {
    return `<div class="pd-card glass-spatial pd-card--skeleton" aria-hidden="true">
      <div class="pd-card-media"><div class="ps-skeleton" style="position:absolute;inset:0"></div></div>
      <div class="pd-card-body space-y-2">
        <div class="ps-skeleton h-4 w-4/5"></div>
        <div class="ps-skeleton h-3 w-3/5"></div>
        <div class="ps-skeleton h-3 w-2/5"></div>
      </div>
    </div>`;
  }

  function renderVisible() {
    if (loading && !firstLoadDone) return;
    if (loadError) return;

    const keyword = $('pdSearchInput').value.trim().toLowerCase();
    const bedsMin = Number($('pdBedsFilter').value) || 0;
    const bathsMin = Number($('pdBathsFilter').value) || 0;
    const minArea = Number($('pdMinArea').value) || 0;
    const maxArea = Number($('pdMaxArea').value) || 0;
    const furnishedOnly = $('pdFurnished').checked;
    const verifiedOnly = $('pdVerified').checked;

    const all = combinedListings();
    const visible = all.filter((l) => {
      if (keyword && !(l.title.toLowerCase().includes(keyword) || l.address.toLowerCase().includes(keyword) || l.city.toLowerCase().includes(keyword))) return false;
      if (bedsMin && l.beds < bedsMin) return false;
      if (bathsMin && l.baths < bathsMin) return false;
      if (minArea && l.sqft < minArea) return false;
      if (maxArea && l.sqft > maxArea) return false;
      if (furnishedOnly && !l.furnished) return false;
      if (verifiedOnly && !l.verified) return false;
      return true;
    });

    $('pdGrid').innerHTML = visible.map(card).join('');
    import('./prefetch.js')
      .then((m) => m.wirePrefetch($('pdGrid'), 'a[href^="listing.html"]'))
      .catch(() => {});

    $('pdResultCount').textContent = visible.length
      ? trf('discover.resultCount', '{n} properties', { n: visible.length })
      : '';

    const trulyEmpty = firstLoadDone && all.length === 0;
    $('pdEmptyState').classList.toggle('hidden', !trulyEmpty);
    $('pdNoLocalMatches').classList.toggle('hidden', !(!trulyEmpty && all.length > 0 && visible.length === 0));
    updatePaginationUi();
  }

  // ---- Mode switch -----------------------------------------------------
  function setMode(newMode, { fromUrl = false } = {}) {
    mode = MODES.includes(newMode) ? newMode : mode;
    root.querySelectorAll('.dw-mode-switch-btn').forEach((b) => {
      const active = b.dataset.mode === mode;
      b.classList.toggle('is-active', active);
      b.setAttribute('aria-selected', String(active));
    });
    $('pdMapLink').setAttribute('href', 'map.html?type=' + (mode === 'buy' ? 'sale' : mode === 'rent' ? 'rent' : 'all'));
    if (!fromUrl) writeUrlState();
    fetchPage({ reset: true });
  }
  root.querySelectorAll('.dw-mode-switch-btn').forEach((btn) => {
    btn.addEventListener('click', () => setMode(btn.dataset.mode));
  });

  // ---- View density (desktop-only 3/4/5 grid, persisted locally) --------
  function setDensity(newDensity) {
    density = DENSITIES.includes(newDensity) ? newDensity : density;
    $('pdGrid').dataset.density = String(density);
    root.querySelectorAll('.dw-density-switch-btn').forEach((b) => {
      const active = Number(b.dataset.density) === density;
      b.classList.toggle('is-active', active);
      b.setAttribute('aria-pressed', String(active));
    });
    writeDensity(density);
  }
  root.querySelectorAll('.dw-density-switch-btn').forEach((btn) => {
    btn.addEventListener('click', () => setDensity(Number(btn.dataset.density)));
  });

  // ---- View density (mobile-only 2/3 grid, independent of the desktop
  // 3/4/5 preference above -- own storage key, own control). ---------------
  function setMobileDensity(newDensity) {
    mobileDensity = MOBILE_DENSITIES.includes(newDensity) ? newDensity : mobileDensity;
    $('pdGrid').dataset.mobileDensity = String(mobileDensity);
    root.querySelectorAll('.dw-density-switch-sm-btn').forEach((b) => {
      const active = Number(b.dataset.mobileDensity) === mobileDensity;
      b.classList.toggle('is-active', active);
      b.setAttribute('aria-pressed', String(active));
    });
    writeMobileDensity(mobileDensity);
  }
  root.querySelectorAll('.dw-density-switch-sm-btn').forEach((btn) => {
    btn.addEventListener('click', () => setMobileDensity(Number(btn.dataset.mobileDensity)));
  });

  // ---- Filter wiring -----------------------------------------------------
  function applyServerFilters() {
    state.city = $('pdCityFilter').value;
    state.type = $('pdTypeFilter').value;
    state.minPrice = Number($('pdMinPrice').value) || 0;
    state.maxPrice = Number($('pdMaxPrice').value) || 0;
    state.sort = $('pdSortFilter').value;
    if ((state.minPrice > 0 || state.maxPrice > 0) && state.sort === 'newest') {
      state.sort = 'price-asc';
      $('pdSortFilter').value = 'price-asc';
    }
    writeUrlState();
    fetchPage({ reset: true });
  }

  let keywordDebounce;
  $('pdSearchInput').addEventListener('input', () => {
    clearTimeout(keywordDebounce);
    keywordDebounce = setTimeout(() => { writeUrlState(); renderVisible(); }, 250);
  });
  let priceDebounce;
  ['pdMinPrice', 'pdMaxPrice'].forEach((id) => {
    $(id).addEventListener('input', () => { clearTimeout(priceDebounce); priceDebounce = setTimeout(applyServerFilters, 500); });
  });
  ['pdCityFilter', 'pdTypeFilter', 'pdSortFilter'].forEach((id) => $(id).addEventListener('change', applyServerFilters));
  $('pdBedsFilter').addEventListener('change', () => { writeUrlState(); renderVisible(); });
  $('pdRetryBtn').addEventListener('click', () => fetchPage({ reset: true }));
  $('pdLoadMoreBtn').addEventListener('click', () => fetchPage({ reset: false }));

  function openDrawer() { show($('pdFilterDrawer')); }
  function closeDrawer() { hide($('pdFilterDrawer')); }
  $('pdMoreFiltersBtn').addEventListener('click', openDrawer);
  $('pdFilterCloseBtn').addEventListener('click', closeDrawer);
  $('pdFilterDrawer').addEventListener('click', (e) => { if (e.target.id === 'pdFilterDrawer') closeDrawer(); });
  $('pdFilterApplyBtn').addEventListener('click', () => { closeDrawer(); writeUrlState(); renderVisible(); });
  $('pdFilterClearBtn').addEventListener('click', () => {
    $('pdBathsFilter').value = '0'; $('pdMinArea').value = ''; $('pdMaxArea').value = '';
    $('pdFurnished').checked = false; $('pdVerified').checked = false;
    writeUrlState(); renderVisible();
  });

  // ---- Save search -----------------------------------------------------
  $('pdSaveSearchBtn').addEventListener('click', async () => {
    const fb = await fbReady;
    if (!fb.auth.currentUser) {
      showToast(tr('listing.loginToSave', 'Log in to save searches'), 'bookmark_add');
      setTimeout(() => { window.location.href = 'login.html'; }, 900);
      return;
    }
    const { collection, addDoc } = await import('https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js');
    const modeLabel = tr('discover.mode' + mode.charAt(0).toUpperCase() + mode.slice(1), mode);
    const q = $('pdSearchInput').value.trim();
    const label = `${modeLabel}${q ? ' — "' + q + '"' : ''}`;
    await addDoc(collection(fb.db, 'users', fb.auth.currentUser.uid, 'savedSearches'), {
      label, url: root.ownerDocument === document ? (mode === 'rent' ? 'rent.html' : 'buy.html') : 'buy.html',
      filters: { mode, ...state }, createdAt: new Date()
    });
    showToast(tr('discover.searchSaved', 'Search saved to your account'), 'check_circle');
  });

  // ---- URL state -----------------------------------------------------
  function readUrlState() {
    const p = new URLSearchParams(window.location.search);
    const m = p.get('mode');
    if (m && MODES.includes(m)) mode = m;
    const city = p.get('city'); if (city && CITIES.includes(city)) $('pdCityFilter').value = city;
    const type = p.get('type'); if (type && PROPERTY_TYPES.includes(type)) $('pdTypeFilter').value = type;
    const sort = p.get('sort'); if (sort && SORTS.includes(sort)) $('pdSortFilter').value = sort;
    const minPrice = Number(p.get('minPrice')); if (minPrice > 0) $('pdMinPrice').value = String(minPrice);
    const maxPrice = Number(p.get('maxPrice')); if (maxPrice > 0) $('pdMaxPrice').value = String(maxPrice);
    const beds = Number(p.get('beds')); if (beds > 0) $('pdBedsFilter').value = String(Math.min(beds, 5));
    const baths = Number(p.get('baths')); if (baths > 0) $('pdBathsFilter').value = String(Math.min(baths, 4));
    const minArea = Number(p.get('minArea')); if (minArea > 0) $('pdMinArea').value = String(minArea);
    const maxArea = Number(p.get('maxArea')); if (maxArea > 0) $('pdMaxArea').value = String(maxArea);
    const q = p.get('q'); if (q) $('pdSearchInput').value = q;
    if (p.get('furnished') === '1') $('pdFurnished').checked = true;
    if (p.get('verified') === '1') $('pdVerified').checked = true;
    // City-deep-link convenience -- same intent as buy.html's old ?city=.
    if (city && !p.get('q')) $('pdSearchInput').value = '';
  }
  function writeUrlState() {
    const p = new URLSearchParams();
    if (mode !== defaultMode) p.set('mode', mode);
    const city = $('pdCityFilter').value; if (city) p.set('city', city);
    const type = $('pdTypeFilter').value; if (type !== 'all') p.set('type', type);
    const sort = $('pdSortFilter').value; if (sort !== 'newest') p.set('sort', sort);
    const minPrice = $('pdMinPrice').value; if (minPrice) p.set('minPrice', minPrice);
    const maxPrice = $('pdMaxPrice').value; if (maxPrice) p.set('maxPrice', maxPrice);
    const beds = $('pdBedsFilter').value; if (beds !== '0') p.set('beds', beds);
    const baths = $('pdBathsFilter').value; if (baths !== '0') p.set('baths', baths);
    const minArea = $('pdMinArea').value; if (minArea) p.set('minArea', minArea);
    const maxArea = $('pdMaxArea').value; if (maxArea) p.set('maxArea', maxArea);
    const q = $('pdSearchInput').value.trim(); if (q) p.set('q', q);
    if ($('pdFurnished').checked) p.set('furnished', '1');
    if ($('pdVerified').checked) p.set('verified', '1');
    const qs = p.toString();
    history.replaceState(null, '', window.location.pathname + (qs ? '?' + qs : ''));
  }

  readUrlState();
  setMode(mode, { fromUrl: true });
  document.addEventListener('darwesh:langchange', renderVisible);
}
