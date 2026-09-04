// MAM's action registry -- the ONLY way MAM, or a typed/spoken direct
// command, is ever allowed to move the visitor around this site or touch
// real filter state. Every action here is an explicit, named, validated
// operation against a fixed allowlist -- never eval(), never a model-
// generated selector or URL, never arbitrary DOM/JS execution. Anything
// not on this list simply cannot be done, by construction.
//
// This module is PURE: it validates input and returns plain descriptors
// (a destination page, a translated URL query, a recognized command) --
// it never touches the DOM, never navigates, never calls into
// window.DarweshPropertiesMap. js/mam-chat-panel.js is the one place that
// takes a descriptor from here and actually executes it, since that is
// where the session, the panel and the map hook already live -- this
// keeps the allowlist itself trivially readable and testable on its own,
// with no page or panel needed to exercise it.

// Every real destination this frontend has, keyed by a short page name a
// direct command or a suggested action can name. Extending this list is
// the ONLY way to make a new page reachable -- there is no free-text
// fallback, and no key here maps to anything but a literal, existing,
// same-origin .html file already shipped in this repo.
export const PAGE_MAP = {
  home: 'index.html',
  buy: 'buy.html',
  rent: 'rent.html',
  sell: 'sell.html',
  map: 'map.html',
  services: 'services.html',
  build: 'build.html',
  renovate: 'renovate.html',
  design: 'design.html',
  about: 'about.html'
};

// Common alternate ways a visitor names the same destination -- never
// invents a NEW destination, only points a synonym at one already in
// PAGE_MAP above.
const PAGE_ALIASES = {
  properties: 'map', property: 'map', listings: 'map', listing: 'map',
  purchase: 'buy', buying: 'buy',
  rental: 'rent', renting: 'rent',
  selling: 'sell',
  service: 'services',
  building: 'build', construction: 'build',
  renovation: 'renovate', remodel: 'renovate', remodeling: 'renovate',
  index: 'home'
};

/** @returns {string|null} A real page path, or null if `name` names nothing this frontend has. */
export function resolvePage(name) {
  const key = (name || '').toLowerCase().trim();
  const canonical = PAGE_ALIASES[key] || key;
  return PAGE_MAP[canonical] || null;
}

// Every real Home Type value map.html's own filter bar already offers
// (its `.home-type-check` inputs) -- an action can only ever select one
// of these, never an invented value the backend/model made up.
export const HOME_TYPES = ['house', 'villa', 'apartment', 'land', 'building', 'office', 'shop', 'commercialProperty'];
// Every real sort value map.html's own `.sort-option` buttons offer.
export const SORT_VALUES = ['recommended', 'newest', 'priceAsc', 'priceDesc', 'areaDesc'];

/**
 * Translates the SAME filter vocabulary map.html's own AI hook already
 * uses (backend/app/mam/orchestrator.py's _search_filters_action: deal,
 * q, types, minPrice, maxPrice, beds -- extended here with baths, sort,
 * areaMin/areaMax and verified, every one of them a filter map.html's own
 * bar already has a real control for) into the URL query params
 * map.html's own readUrlStateIntoFilters() already parses on load. This
 * is what lets a filter-setting action work from ANY page: navigating to
 * map.html with these params applies the exact same state a same-page
 * call would have applied directly -- never a second implementation of
 * what any of these filters mean.
 * @param {object} filters
 * @returns {URLSearchParams}
 */
export function filtersToMapUrlParams(filters) {
  const p = new URLSearchParams();
  if (!filters || typeof filters !== 'object') return p;
  if (filters.deal === 'rent') p.set('type', 'rent');
  else if (filters.deal === 'all') p.set('type', 'all');
  if (typeof filters.q === 'string' && filters.q.trim()) p.set('city', filters.q.trim().slice(0, 80));
  const num = (v) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : null; };
  const minPrice = num(filters.minPrice); if (minPrice !== null) p.set('priceMin', String(minPrice));
  const maxPrice = num(filters.maxPrice); if (maxPrice !== null) p.set('priceMax', String(maxPrice));
  const beds = num(filters.beds); if (beds) p.set('beds', String(beds));
  const baths = num(filters.baths); if (baths) p.set('baths', String(baths));
  if (Array.isArray(filters.types) && filters.types.length) {
    const valid = filters.types.filter((t) => HOME_TYPES.includes(t));
    if (valid.length) p.set('types', valid.join(','));
  }
  if (filters.verified) p.set('verified', '1');
  const areaMin = num(filters.areaMin); if (areaMin !== null) p.set('areaMin', String(areaMin));
  const areaMax = num(filters.areaMax); if (areaMax !== null) p.set('areaMax', String(areaMax));
  if (filters.sort && SORT_VALUES.includes(filters.sort)) p.set('sort', filters.sort);
  return p;
}

function normalize(s) {
  return (s || '').toLowerCase().normalize('NFKC').replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
}

// The handful of navigation/tuple-free words a direct command may open
// with -- deliberately narrow phrasing, not a grammar. "open the map",
// "go to rent", "take me to buy", "show me the map page" all match; a
// request that also carries real search content ("show me villas in
// Erbil") does NOT match here (no page word resolves at the end of it),
// and falls through to the real backend conversation instead, exactly as
// intended -- this recognizer's whole job is the reflexive, no-NLU-
// needed cases only.
const NAV_PREFIX = '(?:open|go to|goto|go back to|take me to|navigate to|show me|show)';

/**
 * A tiny, deterministic direct-command recognizer for the small set of
 * requests that need no NLU at all and should execute instantly, offline
 * of the backend, and identically every time: page navigation, "go
 * back", collapsing/opening MAM, clearing every filter. Anything it does
 * not confidently recognize returns null and the caller sends the text to
 * the real backend conversation instead -- this is deliberately narrow,
 * never a second, competing intent parser for the property-search
 * requests MAM's own NLU already handles well.
 * @param {string} text
 * @returns {{type:'navigate', page:string}|{type:'back'}|{type:'clear_filters'}|{type:'collapse_mam'}|{type:'open_mam'}|null}
 */
export function detectDirectCommand(text) {
  const norm = normalize(text);
  if (!norm) return null;

  if (/^go back$/.test(norm)) return { type: 'back' };
  if (/^(clear|reset)( the| all)? filters?$/.test(norm)) return { type: 'clear_filters' };
  if (/^(collapse|close|minimize) mam$/.test(norm)) return { type: 'collapse_mam' };
  if (/^open mam$/.test(norm)) return { type: 'open_mam' };

  const withPrefix = norm.match(new RegExp('^' + NAV_PREFIX + '\\s+(?:the\\s+)?([a-z]+)(?:\\s+page)?$'));
  const bareWord = norm.match(/^([a-z]+)$/);
  const pageWord = withPrefix ? withPrefix[1] : (bareWord ? bareWord[1] : null);
  if (pageWord) {
    const page = resolvePage(pageWord);
    if (page) return { type: 'navigate', page: pageWord };
  }
  return null;
}
