// Darwesh Group — forward data-model compatibility fixes.
//
// This module removes two pieces of technical debt without changing page
// layout or permissions:
//   1) Saved searches are stored as language-neutral structured data. The
//      account page derives the visible label from scope + filters in the
//      CURRENT language, so a search never becomes permanently English.
//   2) Map property-type rendering normalizes canonical stored values such
//      as `commercialProperty` (plus the legacy `commercial` alias) before
//      looking up the localized label.
//
// It is loaded from error-monitor.js, which already runs on Buy, Map and
// Account. Existing saved-search documents remain readable and are migrated
// opportunistically when their owner opens Account.

import { auth, db } from './firebase-init.js';
import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/12.18.0/firebase-auth.js';
import {
  addDoc,
  collection,
  deleteDoc,
  deleteField,
  doc,
  getDocs,
  serverTimestamp,
  updateDoc
} from 'https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js';

const SCHEMA_VERSION = 2;

function pageName() {
  return location.pathname.split('/').pop() || 'index.html';
}

function tr(key, fallback) {
  if (typeof window.t !== 'function') return fallback;
  const value = window.t(key);
  return value && value !== key ? value : fallback;
}

function showToastSafe(message, icon) {
  if (typeof window.showToast === 'function') window.showToast(message, icon);
}

function currentLang() {
  return localStorage.getItem('darwesh_lang') || document.documentElement.lang || 'en';
}

const TYPE_KEYS = {
  house: 'map.house',
  villa: 'map.villa',
  apartment: 'map.apartment',
  land: 'map.land',
  building: 'map.building',
  office: 'map.office',
  shop: 'map.shop',
  commercialproperty: 'map.commercialProperty',
  commercial: 'map.commercialProperty'
};

const TYPE_FALLBACKS = {
  house: 'House',
  villa: 'Villa',
  apartment: 'Apartment',
  land: 'Land',
  building: 'Building',
  office: 'Office',
  shop: 'Shop',
  commercialproperty: 'Commercial Property',
  commercial: 'Commercial Property'
};

function normalizePropertyType(value) {
  const compact = String(value || '').trim().replace(/[\s_-]+/g, '').toLowerCase();
  if (compact === 'commercial' || compact === 'commercialproperty') return 'commercialproperty';
  return compact;
}

function localizedPropertyType(value) {
  const normalized = normalizePropertyType(value);
  const key = TYPE_KEYS[normalized];
  if (!key) return String(value || '').trim();
  return tr(key, TYPE_FALLBACKS[normalized] || String(value || '').trim());
}

// ---------------------------------------------------------------------------
// Canonical saved-search writes
// ---------------------------------------------------------------------------
function buildBuySearch() {
  const type = document.getElementById('typeFilter')?.value || 'all';
  const q = document.getElementById('searchInput')?.value.trim() || '';
  const params = new URLSearchParams();
  if (type && type !== 'all') params.set('type', type);
  if (q) params.set('q', q);
  return {
    schemaVersion: SCHEMA_VERSION,
    scope: 'buy',
    url: 'buy.html' + (params.toString() ? '?' + params.toString() : ''),
    filters: { type, q }
  };
}

function buildMapSearch() {
  let params;
  try {
    params = typeof window.buildStateParams === 'function'
      ? window.buildStateParams()
      : new URLSearchParams(location.search);
  } catch {
    params = new URLSearchParams(location.search);
  }
  const city = params.get('city') || document.getElementById('citySearch')?.value.trim() || '';
  const type = params.get('type') || 'sale';
  return {
    schemaVersion: SCHEMA_VERSION,
    scope: 'map',
    url: 'map.html' + (params.toString() ? '?' + params.toString() : ''),
    filters: { type, city }
  };
}

async function saveCanonicalSearch() {
  const page = pageName();
  const user = auth.currentUser;
  if (!user) {
    showToastSafe(tr('map.loginToSaveSearch', 'Log in to save searches'), 'bookmark_add');
    setTimeout(() => { location.href = 'login.html'; }, 900);
    return;
  }

  const payload = page === 'buy.html' ? buildBuySearch() : buildMapSearch();
  await addDoc(collection(db, 'users', user.uid, 'savedSearches'), {
    ...payload,
    createdAt: serverTimestamp()
  });
  showToastSafe(tr('map.searchSavedToAccount', 'Search saved to your account'), 'check_circle');
}

function installSaveSearchOverride() {
  const page = pageName();
  if (page !== 'buy.html' && page !== 'map.html') return;

  // Capture phase intentionally runs before the page's older target-phase
  // click handler. We stop that legacy handler so only the structured,
  // language-neutral document is written.
  document.addEventListener('click', async (event) => {
    const button = event.target instanceof Element ? event.target.closest('#saveSearchBtn') : null;
    if (!button) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (button.dataset.canonicalSaveBusy === '1') return;
    button.dataset.canonicalSaveBusy = '1';
    button.disabled = true;
    try {
      await saveCanonicalSearch();
    } catch (err) {
      console.error('[saved-search] save failed', err);
      showToastSafe(tr('map.saveSearchFailed', 'Could not save this search. Please try again.'), 'error');
    } finally {
      button.disabled = false;
      delete button.dataset.canonicalSaveBusy;
    }
  }, true);

  // New Buy saved-search URLs carry ?q=. The original Buy page already
  // knows how to react to its input event, so hydrate the field and reuse
  // that existing render path instead of duplicating filter logic here.
  if (page === 'buy.html') {
    const q = new URLSearchParams(location.search).get('q');
    const input = document.getElementById('searchInput');
    if (q && input) {
      input.value = q;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }
}

// ---------------------------------------------------------------------------
// Account: derive labels from structured data, never from persisted prose.
// ---------------------------------------------------------------------------
function inferScope(search) {
  if (search?.scope === 'buy' || search?.scope === 'map') return search.scope;
  const url = String(search?.url || '');
  if (/^buy\.html(?:\?|$)/.test(url)) return 'buy';
  if (/^map\.html(?:\?|$)/.test(url)) return 'map';
  return null;
}

function cityLabel(value) {
  if (!value) return '';
  if (typeof window.cityLabel === 'function') return window.cityLabel(value) || value;
  return value;
}

function savedSearchTitle(search) {
  const scope = inferScope(search);
  const filters = search?.filters && typeof search.filters === 'object' ? search.filters : {};

  if (scope === 'buy') {
    const type = String(filters.type || 'all');
    const typeLabel = type === 'all'
      ? tr('buy.allHomeTypes', 'All Home Types')
      : (localizedPropertyType(type) || type);
    const q = String(filters.q || '').trim();
    const buy = tr('nav.buy', 'Buy');
    return `${typeLabel}${q ? ` — “${q}”` : ''} · ${buy}`;
  }

  if (scope === 'map') {
    const urlParams = (() => {
      try { return new URLSearchParams(String(search.url || '').split('?')[1] || ''); }
      catch { return new URLSearchParams(); }
    })();
    const type = String(filters.type || urlParams.get('type') || 'sale');
    const city = cityLabel(String(filters.city || urlParams.get('city') || '').trim());
    const map = tr('nav.propertiesMap', 'Properties Map');
    const mode = type === 'rent' ? tr('nav.rent', 'Rent') : type === 'sale' ? tr('nav.buy', 'Buy') : '';
    return [map, mode, city].filter(Boolean).join(' · ');
  }

  return String(search?.label || tr('acct.savedSearch', 'Saved search'));
}

function canonicalSearchUrl(search) {
  const scope = inferScope(search);
  const filters = search?.filters && typeof search.filters === 'object' ? search.filters : {};
  if (scope === 'buy') {
    const params = new URLSearchParams();
    const type = String(filters.type || 'all');
    const q = String(filters.q || '').trim();
    if (type && type !== 'all') params.set('type', type);
    if (q) params.set('q', q);
    return 'buy.html' + (params.toString() ? '?' + params.toString() : '');
  }
  return String(search?.url || (scope === 'map' ? 'map.html' : '#'));
}

let accountUid = null;
let accountSearchDocs = [];
let accountObserver = null;
let accountRenderInProgress = false;

function accountActionLabel(key, fallback) {
  return tr(key, fallback);
}

function renderAccountSearches() {
  if (pageName() !== 'account.html' || !accountUid) return;
  const list = document.getElementById('searchesList');
  const empty = document.getElementById('searchesEmpty');
  if (!list || !empty) return;

  accountRenderInProgress = true;
  list.innerHTML = '';
  empty.classList.toggle('hidden', accountSearchDocs.length > 0);

  for (const item of accountSearchDocs) {
    const row = document.createElement('div');
    row.className = 'fav-card p-4 flex items-center justify-between';
    row.dataset.canonicalSavedSearch = '1';

    const left = document.createElement('div');
    const title = document.createElement('p');
    title.className = 'font-body-md text-[14px] text-on-surface font-medium';
    title.textContent = savedSearchTitle(item.data);
    left.appendChild(title);

    const openLink = document.createElement('a');
    openLink.className = 'font-label-caps text-label-caps text-secondary hover:underline';
    openLink.href = canonicalSearchUrl(item.data);
    openLink.textContent = accountActionLabel('common.open', 'Open');

    const removeBtn = document.createElement('button');
    removeBtn.className = 'ml-4 font-label-caps text-label-caps text-error hover:underline';
    removeBtn.type = 'button';
    removeBtn.textContent = accountActionLabel('common.remove', 'Remove');
    removeBtn.addEventListener('click', async () => {
      await deleteDoc(doc(db, 'users', accountUid, 'savedSearches', item.id));
      await loadAccountSearches(accountUid);
    });

    const right = document.createElement('div');
    right.className = 'flex items-center gap-2';
    right.append(openLink, removeBtn);
    row.append(left, right);
    list.appendChild(row);
  }

  requestAnimationFrame(() => { accountRenderInProgress = false; });
}

async function migrateSearchDocument(uid, item) {
  const scope = inferScope(item.data);
  if (!scope) return;
  const patch = {};
  if (item.data.schemaVersion !== SCHEMA_VERSION) patch.schemaVersion = SCHEMA_VERSION;
  if (item.data.scope !== scope) patch.scope = scope;
  if (Object.prototype.hasOwnProperty.call(item.data, 'label')) patch.label = deleteField();
  if (!Object.keys(patch).length) return;
  try {
    await updateDoc(doc(db, 'users', uid, 'savedSearches', item.id), patch);
  } catch (err) {
    // Migration is best-effort. A display should never fail because cleanup
    // of an old derived label could not be written.
    console.warn('[saved-search] legacy migration skipped', item.id, err?.code || err?.name || 'error');
  }
}

async function loadAccountSearches(uid) {
  const snap = await getDocs(collection(db, 'users', uid, 'savedSearches'));
  accountSearchDocs = snap.docs.map((d) => ({ id: d.id, data: d.data() }));
  renderAccountSearches();
  // Remove old persisted prose after rendering. Structured filters/url stay
  // untouched, so old searches keep exactly the same meaning and target.
  void Promise.allSettled(accountSearchDocs.map((item) => migrateSearchDocument(uid, item)));
}

function installAccountSearchRenderer() {
  if (pageName() !== 'account.html') return;
  onAuthStateChanged(auth, async (user) => {
    if (!user) return;
    accountUid = user.uid;
    try {
      await loadAccountSearches(user.uid);
    } catch (err) {
      console.error('[saved-search] account load failed', err);
    }
  });

  document.addEventListener('darwesh:langchange', renderAccountSearches);

  const attachObserver = () => {
    const list = document.getElementById('searchesList');
    if (!list || accountObserver) return;
    accountObserver = new MutationObserver(() => {
      if (accountRenderInProgress || !accountUid) return;
      const children = Array.from(list.children);
      // account.html's legacy renderer may finish after ours. If any row is
      // not canonical, restore the structured renderer immediately.
      if (children.some((row) => row.dataset.canonicalSavedSearch !== '1')) {
        renderAccountSearches();
      }
    });
    accountObserver.observe(list, { childList: true });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', attachObserver, { once: true });
  else attachObserver();
}

// ---------------------------------------------------------------------------
// Map: canonical property-type normalization at the rendering function.
// ---------------------------------------------------------------------------
function installMapPropertyTypeNormalizer() {
  if (pageName() !== 'map.html') return;

  const install = () => {
    if (typeof window.propertyTypeLabel !== 'function') return false;
    if (window.propertyTypeLabel.__darweshCanonical) return true;
    const original = window.propertyTypeLabel;
    const fixed = function propertyTypeLabelCanonical(listing) {
      const raw = String(listing?.propertyType || '').trim();
      const localized = localizedPropertyType(raw);
      if (localized) return localized;
      return original(listing);
    };
    fixed.__darweshCanonical = true;
    window.propertyTypeLabel = fixed;
    if (typeof window.refresh === 'function') window.refresh();
    return true;
  };

  if (!install()) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install, { once: true });
    setTimeout(install, 0);
  }
  document.addEventListener('darwesh:langchange', () => {
    install();
    if (typeof window.refresh === 'function') window.refresh();
  });
}

installSaveSearchOverride();
installAccountSearchRenderer();
installMapPropertyTypeNormalizer();
