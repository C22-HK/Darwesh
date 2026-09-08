// MAM AI Command Center -- unified Phase 1 site action registry.
//
// This is the ONE place that names every real action the Command Center
// (mam-ai.html) is allowed to perform, and the ONLY way it is allowed to
// perform one: a fixed, explicit vocabulary, each entry either backed by
// an existing, already-shipped piece of application logic or a small,
// clearly-scoped addition below -- never eval(), never a model-generated
// selector, never arbitrary DOM/JS execution, never a second copy of
// business logic that already lives elsewhere.
//
// Three kinds of entry, by how they're actually carried out:
//
//  - 'navigate'      A pure, deterministic destination this module can
//                     compute and go to directly (same allowlisted pages
//                     js/mam-actions.js already knows about, same filter
//                     vocabulary map.html's own URL-state reader already
//                     parses). No backend round-trip needed.
//  - 'write'         A small, real Firestore write this module performs
//                     directly, using the EXACT SAME collection path and
//                     document-id convention listing.html's own favorite
//                     button already uses -- so a listing saved from here
//                     shows up in "My Favorites" exactly as if the visitor
//                     had clicked the button there, and vice versa.
//  - 'conversational' Not a page and not a write -- search_professionals
//                     has no dedicated results page today (results are
//                     rendered as inline reference cards by the existing
//                     mam-chat-panel.js pipeline). This registry does not
//                     duplicate that pipeline; mam-ai.html mounts the real
//                     panel and sends these through the same
//                     js/mam-api.js -> backend/app/mam/tools.py path every
//                     other MAM surface already uses.
//
// Every entry also carries `confirm`. Per Part 24/26 of the spec, NO
// Phase 1 action needs it -- every one here is read-only, purely
// navigational, or trivially reversible (save <-> unsave, city prefill on
// a step nobody has submitted yet). The field exists now, set to `false`
// everywhere, so Phase 2's side-effect actions (contact request, publish,
// final Sell submit, delete) have a real place to opt into a confirmation
// dialog rather than that mechanism being invented under deadline later.
import { auth, db, getDoc, setDoc, deleteDoc } from './firebase-init.js';
import { doc, serverTimestamp } from 'https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js';
import { PAGE_MAP, resolvePage, filtersToMapUrlParams, HOME_TYPES, SORT_VALUES } from './mam-actions.js';
import { PROFESSIONAL_PAGES } from './mam-chat-panel.js';

// Every real service-category destination this frontend has -- reuses
// PAGE_MAP's own entries plus the per-profession pages already used to
// resolve `open_professional`, never a new/invented page name.
const SERVICE_PAGES = { ...PROFESSIONAL_PAGES, general: PAGE_MAP.services };

// The exact 8 cities sell.html's own Location-step <option> elements
// offer (see js/i18n.js's CITY_KEYS) -- setSellField('city', ...) can only
// ever pick one of these, never an invented value.
export const SELL_CITY_KEYS = ['erbil', 'sulaymaniyah', 'duhok', 'zakho', 'soran', 'koya', 'halabja', 'kirkuk'];

/**
 * The formal registry table the spec asks for: every Phase 1 action,
 * whether it needs confirmation, and how it's actually carried out. Kept
 * separate from the executor functions below on purpose -- code that only
 * needs to answer "does this action exist / does it need confirming"
 * (e.g. a future confirmation-dialog gate) can import this without also
 * importing every executor's dependencies (Firestore, auth, etc).
 */
export const ACTION_REGISTRY = Object.freeze({
  navigate: { confirm: false, kind: 'navigate' },
  searchListings: { confirm: false, kind: 'navigate' },
  setCity: { confirm: false, kind: 'navigate' },
  setListingIntent: { confirm: false, kind: 'navigate' },
  setPropertyType: { confirm: false, kind: 'navigate' },
  setPriceRange: { confirm: false, kind: 'navigate' },
  openListing: { confirm: false, kind: 'navigate' },
  openMap: { confirm: false, kind: 'navigate' },
  saveListing: { confirm: false, kind: 'write' },
  unsaveListing: { confirm: false, kind: 'write' },
  searchProfessionals: { confirm: false, kind: 'conversational' },
  openProfessional: { confirm: false, kind: 'navigate' },
  openService: { confirm: false, kind: 'navigate' },
  changeLanguage: { confirm: false, kind: 'write' },
  openSell: { confirm: false, kind: 'navigate' },
  setSellField: { confirm: false, kind: 'navigate' },
  goBack: { confirm: false, kind: 'navigate' }
});

function go(url) { window.location.assign(url); }

function mapUrl(filters) {
  const params = filtersToMapUrlParams(filters || {});
  const qs = params.toString();
  return 'map.html' + (qs ? '?' + qs : '');
}

// ---- navigate / searchListings / setCity / setListingIntent /
//      setPropertyType / setPriceRange / openMap ------------------------
// All seven of these resolve to the SAME real destination map.html's own
// readUrlStateIntoFilters() already parses on load -- there is no second
// filter implementation here, only different, convenient ways to build
// the one filters object js/mam-actions.js's filtersToMapUrlParams()
// already knows how to turn into a URL.

export function navigate(page) {
  const url = resolvePage(page);
  if (!url) return { ok: false, error: 'unknown_page' };
  go(url);
  return { ok: true };
}

export function openMap(filters) { go(mapUrl(filters)); return { ok: true }; }
export function searchListings(filters) { return openMap(filters); }
export function setCity(city) { return openMap({ q: city }); }
export function setListingIntent(intent) { return openMap({ deal: intent }); }
export function setPropertyType(types) { return openMap({ types: Array.isArray(types) ? types : [types] }); }
export function setPriceRange({ minPrice, maxPrice } = {}) { return openMap({ minPrice, maxPrice }); }

export { HOME_TYPES, SORT_VALUES };

export function openListing(listingId) {
  if (!listingId) return { ok: false, error: 'missing_listing_id' };
  go('listing.html?id=' + encodeURIComponent(listingId));
  return { ok: true };
}

export function openProfessional(professionalId, serviceType) {
  const page = PROFESSIONAL_PAGES[serviceType];
  if (!page || !professionalId) return { ok: false, error: 'unknown_professional' };
  go(page + '?id=' + encodeURIComponent(professionalId));
  return { ok: true };
}

export function openService(category) {
  const page = SERVICE_PAGES[category] || PAGE_MAP.services;
  go(page);
  return { ok: true };
}

export function openSell() { go(PAGE_MAP.sell); return { ok: true }; }

/**
 * Phase 1's only Sell field: prefills the Location step's city <select>
 * (see sell.html's own prefillCityFromMam()) -- a FORM PREFILL, not a
 * submission, so nothing here needs confirmation. Any field beyond city,
 * and stepping through the wizard, is explicitly Phase 2 (goToSellStep).
 */
export function setSellField(field, value) {
  if (field !== 'city') return { ok: false, error: 'unsupported_field' };
  const key = String(value || '').toLowerCase();
  if (!SELL_CITY_KEYS.includes(key)) return { ok: false, error: 'unknown_city' };
  go('sell.html?prefillCity=' + encodeURIComponent(key));
  return { ok: true };
}

export function goBack() { window.history.back(); return { ok: true }; }

export function changeLanguage(lang) {
  if (typeof window.setLanguage !== 'function') return { ok: false, error: 'i18n_unavailable' };
  window.setLanguage(lang);
  return { ok: true };
}

// ---- saveListing / unsaveListing ---------------------------------------
// Replicates listing.html's OWN favorite-button Firestore call exactly --
// same `users/{uid}/favorites/buy-{listingId}` path, same doc shape, same
// setDoc/deleteDoc calls (imported the same way listing.html itself
// imports them: js/firebase-init.js's app-check-gated wrappers) -- so a
// listing saved from the Command Center shows up in "My Favorites"
// exactly as if the visitor had clicked the existing button on
// listing.html/buy.html/map.html, and vice versa. Deliberately NOT the
// backend's save_property/remove_saved_property tools: those write to
// `users/{uid}/favorites/{listingId}` (no 'buy-' prefix) -- a different
// doc id the frontend's own favorites reader does not look for. Calling
// through the tool here would "save" a listing MAM believes is saved
// while every other Favorites UI on the site kept showing it as not
// saved. Using the client's own real path is what keeps this one real
// favorites list, not two.
function requireSignedIn() {
  const user = auth.currentUser;
  if (!user) return null;
  return user;
}

export async function isListingSaved(listingId) {
  const user = requireSignedIn();
  if (!user || !listingId) return false;
  const snap = await getDoc(doc(db, 'users', user.uid, 'favorites', 'buy-' + listingId));
  return snap.exists();
}

export async function saveListing(listingId, listingSummary = {}) {
  const user = requireSignedIn();
  if (!user) return { ok: false, error: 'auth_required' };
  if (!listingId) return { ok: false, error: 'missing_listing_id' };
  await setDoc(doc(db, 'users', user.uid, 'favorites', 'buy-' + listingId), {
    listingId: 'buy-' + listingId,
    address: listingSummary.address || null,
    city: listingSummary.city || null,
    priceLabel: listingSummary.priceLabel || null,
    img: listingSummary.img || null,
    savedAt: serverTimestamp()
  });
  return { ok: true, saved: true };
}

export async function unsaveListing(listingId) {
  const user = requireSignedIn();
  if (!user) return { ok: false, error: 'auth_required' };
  if (!listingId) return { ok: false, error: 'missing_listing_id' };
  await deleteDoc(doc(db, 'users', user.uid, 'favorites', 'buy-' + listingId));
  return { ok: true, saved: false };
}

// ---- searchProfessionals ------------------------------------------------
// Not a navigation: today's frontend has no dedicated professional-search
// results page (search_professionals results render as inline reference
// cards inside the existing chat pipeline -- see js/mam-chat-panel.js's
// buildRefCard()). Dispatch stays real: mam-ai.html mounts that SAME
// panel and sends the visitor's own words through js/mam-api.js's
// sendMamChat() -> backend/app/mam/tools.py's search_professionals, so
// this function only builds the equivalent, well-formed request text --
// it never talks to the backend itself, and never a second implementation
// of what the tool already does.
export function describeProfessionalSearch({ category, city } = {}) {
  const parts = [];
  if (category) parts.push(category);
  parts.push(city ? `in ${city}` : '');
  return `Find a ${parts.filter(Boolean).join(' ')}`.replace(/\s+/g, ' ').trim();
}
