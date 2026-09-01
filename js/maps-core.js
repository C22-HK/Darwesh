// Darwesh Maps Core -- the ONE shared Google Maps integration boundary for
// the whole platform (Production Rebuild Phase 1 of 3, Part 1/"Shared
// Google Maps architecture"). Every future map surface (public Buy/Rent
// discovery map, the sell.html/admin.html location picker, the Office/
// Agent map, the Admin Real Estate Intelligence Map) is expected to
// import from THIS module rather than each hand-rolling its own
// <script> injection / key handling -- that duplication is exactly what
// this file exists to prevent.
//
// WIRED INTO: buy-rent-map.html (the public Buy/Rent discovery map,
// Google-only, no Leaflet fallback needed since it has no pre-existing
// implementation to preserve), the Admin Estate Intelligence Map and
// Admin Estate Data tabs in admin.html, and -- as a DUAL-ENGINE
// migration, not a replacement -- the location pickers in sell.html and
// agent-dashboard.html, where the original Leaflet + OpenStreetMap/
// Nominatim implementation still runs unchanged whenever no key is
// configured (isConfigured() below returns false), and continues to run
// even once a key exists, until an operator has verified the Google
// path end-to-end in a real browser (see each of those two pages' own
// initLocationPicker()/initMap() comments, and
// docs/GOOGLE_MAPS_CONFIGURATION.md §6 for the full cutover status).
// map.html and listing.html were never in scope for this and remain
// Leaflet-only. The key itself is supplied by js/maps-config.js, a
// gitignored file generated at deploy time from a GitHub Actions repo
// secret (see js/maps-config.local.example.js and
// .github/workflows/deploy-pages.yml) -- never hardcoded here or
// anywhere else in this repo, per the hard constraint below.
//
// -- Key handling (hard security constraint) --------------------------
// This file NEVER hardcodes a Google Maps API key, and never will -- a
// hardcoded key here would ship to every visitor's browser in this
// repo's source, unrestricted, forever (this codebase's own Storage/
// Firestore rules exist specifically to prevent that class of mistake
// elsewhere). Instead, the key is read at runtime from a page-supplied
// configuration point (see resolveConfig() below): a page that actually
// wants a live map sets `window.DARWESH_MAPS_CONFIG = { apiKey: '...' }`
// (e.g. injected server-side per environment, or via a small inline
// <script> a future deploy step templates in) BEFORE importing this
// module. A Google Maps *browser* key is not secret in the way a server
// credential is -- Google's own model is that it ships in client JS and
// is protected by HTTP-referrer + API restrictions configured in Google
// Cloud Console, never by hiding the string -- but this module still
// refuses to embed one directly, so there is exactly one place
// (deployment config) that ever needs to change per environment, and no
// key of any kind lives in version control. See
// docs/GOOGLE_MAPS_CONFIGURATION.md for the referrer/API-restriction
// requirements that key MUST carry once one is provisioned.
//
// If no key is configured, every function below fails gracefully:
// init functions render a visible "map unavailable" placeholder instead
// of a blank box or a thrown error, and geocode/autocomplete helpers
// resolve to null/empty rather than rejecting -- a page that calls this
// module without a key configured (e.g. local dev, or before Ops
// provisions production's key) still renders and functions for
// everything that doesn't strictly require a live map.

const SCRIPT_ID = 'darwesh-google-maps-script';
const DEFAULT_LIBRARIES = ['places', 'geometry', 'marker', 'drawing'];

let loadPromise = null;

// Resolution order: an explicit window.DARWESH_MAPS_CONFIG object (set by
// the page before importing this module) first, then a
// <meta name="darwesh-google-maps-key" content="..."> tag as a lighter-
// weight alternative for pages that don't want an inline config script.
// Neither is a literal string in THIS file, by design -- see header.
function resolveConfig() {
  const fromWindow = (typeof window !== 'undefined' && window.DARWESH_MAPS_CONFIG) || {};
  const metaKey = typeof document !== 'undefined'
    ? document.querySelector('meta[name="darwesh-google-maps-key"]')?.content
    : null;
  return {
    apiKey: fromWindow.apiKey || metaKey || null,
    mapId: fromWindow.mapId || null, // optional, for cloud-styled/Advanced Markers maps
    libraries: fromWindow.libraries || DEFAULT_LIBRARIES,
  };
}

// Safe, non-secret diagnostics -- every field logged here is a boolean or
// a short, fixed error label, NEVER the key's value or any part of it.
// Added after a production incident where "map falls back silently" gave
// no way to tell, from the browser console alone, whether the cause was
// (a) js/maps-config.js never loading/being absent, (b) it loading but
// with an empty apiKey, or (c) the Google script itself failing to load
// (network/CSP/referrer-restriction/billing issue). One line per event,
// prefixed so it's easy to filter for in devtools or a log aggregator.
function logDiagnostic(event, fields) {
  console.log('[darwesh-maps-core] ' + event, fields || '');
}

// Logged exactly once per page load, from whichever of
// isConfigured()/loadGoogleMaps() a caller happens to reach first --
// critically, this means the diagnostic fires even on pages
// (buy-rent-map.html, admin.html's Estate Intelligence Map) that check
// isConfigured() themselves and never call loadGoogleMaps() at all when
// it's false. Without this being in BOTH functions, the exact "map
// isn't showing" scenario this diagnostic exists to help debug would be
// the one case where nothing gets logged.
let configLogged = false;
function logConfigOnce() {
  if (configLogged) return;
  configLogged = true;
  const config = resolveConfig();
  logDiagnostic('config', {
    mapsConfigPresent: typeof window !== 'undefined' && !!window.DARWESH_MAPS_CONFIG,
    mapsApiKeyPresent: !!config.apiKey,
  });
}

/** True only when a page has actually supplied a Google Maps browser key. */
export function isConfigured() {
  logConfigOnce();
  return !!resolveConfig().apiKey;
}

/**
 * Loads the Google Maps JavaScript API exactly once (subsequent calls
 * reuse the same in-flight/resolved promise, so multiple map widgets on
 * one page never inject the script twice). Resolves to `window.google`
 * on success. If no key is configured, resolves to `null` rather than
 * rejecting -- callers are expected to treat `null` as "render the
 * no-map fallback state", not as an exceptional error to surface to the
 * user as a crash.
 */
export function loadGoogleMaps() {
  if (loadPromise) return loadPromise;

  logConfigOnce();
  const config = resolveConfig();

  if (!config.apiKey) {
    // mapsConfigPresent=true but mapsApiKeyPresent=false means
    // js/maps-config.js loaded but its apiKey came back empty -- almost
    // always the GOOGLE_MAPS_BROWSER_KEY repo secret being unset/empty
    // at the deploy that generated it (see .github/workflows/deploy-
    // pages.yml's own ::warning:: for that case). mapsConfigPresent=false
    // means js/maps-config.js itself never set window.DARWESH_MAPS_CONFIG
    // at all -- check whether the file 404'd (Network tab) before
    // suspecting the key.
    loadPromise = Promise.resolve(null);
    return loadPromise;
  }

  logDiagnostic('googleLoaderStarted', { googleLoaderStarted: true });
  loadPromise = new Promise((resolve) => {
    const existing = document.getElementById(SCRIPT_ID);
    if (existing) {
      existing.addEventListener('load', () => resolve(window.google || null), { once: true });
      existing.addEventListener('error', () => {
        logDiagnostic('googleLoaderError', { googleLoaderError: 'script-load-failed-existing-tag' });
        resolve(null);
      }, { once: true });
      return;
    }
    const script = document.createElement('script');
    script.id = SCRIPT_ID;
    script.async = true;
    script.defer = true;
    const params = new URLSearchParams({
      key: config.apiKey,
      libraries: config.libraries.join(','),
      loading: 'async',
      v: 'weekly',
    });
    script.src = `https://maps.googleapis.com/maps/api/js?${params.toString()}`;
    script.addEventListener('load', () => resolve(window.google || null), { once: true });
    // A 'error' event here means the browser could not load the script
    // at all -- CSP script-src blocking maps.googleapis.com, a network
    // failure, or (much less commonly) the URL itself being malformed.
    // It does NOT fire for a key that loads but is then rejected by
    // Google's backend (invalid, wrong referrer, wrong API not enabled,
    // billing issue) -- that case still fires 'load' (the JS bootstrap
    // file itself loaded fine) but google.maps.Map() or similar later
    // throws/logs its own separate, Google-authored console error (e.g.
    // "Google Maps JavaScript API error: ApiNotActivatedMapError" or
    // "RefererNotAllowedMapError") that this module does not and cannot
    // intercept or rewrite -- that error, exactly as Google prints it in
    // devtools, is the next thing to check if googleLoaderStarted=true,
    // no googleLoaderError was logged, and the map still doesn't render.
    script.addEventListener('error', () => {
      logDiagnostic('googleLoaderError', { googleLoaderError: 'script-load-failed' });
      resolve(null);
    }, { once: true });
    document.head.appendChild(script);
  });

  return loadPromise;
}

// The shared "map isn't available" state -- every page that calls
// initMap() and gets `null` back is expected to leave the container in
// this state rather than an empty/broken box. Kept intentionally plain
// (no external CSS dependency) so this module has zero coupling to any
// page's stylesheet; a page is free to restyle the produced element via
// its own CSS targeting `.darwesh-map-unavailable`.
// English-only fallback text: this is a LAST-RESORT default, not what a
// real visitor is expected to see -- every current caller (buy-rent-
// map.html, admin.html's Estate Intelligence Map) checks isConfigured()
// itself first and renders its own translated "map unavailable" markup
// before ever calling initMap(), so this default only fires if a future
// caller skips that pre-check or the script fails to load despite a key
// being present. Because of that, there is no i18n dictionary entry for
// it (js/i18n.js is CI-checked for exact ku/ar parity of every key
// actually referenced from HTML -- adding one here for a string real
// users essentially never see would be dead weight). A future caller
// that DOES want this default shown is expected to either pass its own
// translated `message`, or re-run its i18n pass over the produced
// `.darwesh-map-unavailable` element the same way it already does for
// any other dynamically inserted content.
function renderUnavailable(container, message) {
  if (!container) return;
  container.innerHTML = '';
  const el = document.createElement('div');
  el.className = 'darwesh-map-unavailable';
  el.style.cssText = 'display:flex;align-items:center;justify-content:center;'
    + 'width:100%;height:100%;min-height:200px;padding:1.5rem;text-align:center;'
    + 'background:#11151c;color:#8a93a3;border-radius:12px;font-size:0.9rem;';
  el.textContent = message || 'Map unavailable — configuration required.';
  container.appendChild(el);
}

/**
 * Creates a google.maps.Map inside `container` (an existing DOM element).
 * Returns the Map instance, or `null` (with the container left in the
 * graceful "unavailable" state) if no key is configured or the script
 * failed to load.
 *
 * `options` accepts anything google.maps.MapOptions accepts, plus this
 * module's own `center`/`zoom` shorthands. `mapId` (for Advanced Markers
 * / cloud styling) falls back to the config's own mapId if not passed
 * explicitly.
 */
export async function initMap(container, options = {}) {
  const google = await loadGoogleMaps();
  if (!google || !container) {
    renderUnavailable(container);
    return null;
  }
  const config = resolveConfig();
  return new google.maps.Map(container, {
    center: options.center || { lat: 36.19, lng: 44.01 }, // Erbil, sane default center
    zoom: options.zoom ?? 11,
    mapId: options.mapId || config.mapId || undefined,
    streetViewControl: false,
    fullscreenControl: false,
    ...options,
  });
}

/**
 * Places a marker on `map` at `position` ({lat, lng}). Uses the modern
 * AdvancedMarkerElement when the `marker` library loaded successfully
 * (requires a mapId), falling back to the classic google.maps.Marker
 * otherwise -- callers do not need to know which one they got back for
 * simple add/remove use (both expose `.map = null` to remove).
 */
export function createMarker(google, map, position, options = {}) {
  if (!google || !map) return null;
  if (google.maps.marker?.AdvancedMarkerElement && (map.get('mapId') || options.forceAdvanced)) {
    return new google.maps.marker.AdvancedMarkerElement({ map, position, title: options.title, content: options.content });
  }
  return new google.maps.Marker({ map, position, title: options.title, icon: options.icon });
}

/**
 * Forward-geocodes a free-text address into {lat, lng} + a normalized
 * formatted address, or `null` if unavailable/not found. Mirrors the
 * shape sell.html's existing Nominatim-based picker already returns, so
 * a future cutover can swap the implementation without reshaping every
 * caller.
 */
export async function geocodeAddress(address) {
  const google = await loadGoogleMaps();
  if (!google || !address) return null;
  const geocoder = new google.maps.Geocoder();
  try {
    const { results } = await geocoder.geocode({ address });
    const first = results?.[0];
    if (!first) return null;
    return {
      lat: first.geometry.location.lat(),
      lng: first.geometry.location.lng(),
      formattedAddress: first.formatted_address,
    };
  } catch {
    return null;
  }
}

/**
 * Reverse-geocodes {lat, lng} into a formatted address string, or `null`.
 */
export async function reverseGeocode(lat, lng) {
  const google = await loadGoogleMaps();
  if (!google) return null;
  const geocoder = new google.maps.Geocoder();
  try {
    const { results } = await geocoder.geocode({ location: { lat, lng } });
    return results?.[0]?.formatted_address || null;
  } catch {
    return null;
  }
}

/**
 * Wires the Places Autocomplete widget onto a text `<input>` element,
 * invoking `onPlaceSelected({lat, lng, formattedAddress})` when the
 * visitor picks a suggestion. No-op (returns `null`) if maps are not
 * configured -- the input remains a plain text field, which is still
 * fully usable (matches this codebase's existing "manual address entry
 * always works, autocomplete is an enhancement" pattern already used by
 * sell.html's Nominatim search box).
 *
 * KNOWN LIMITATION: this uses the LEGACY `google.maps.places.Autocomplete`
 * widget, which calls Places API endpoints gated by the legacy "Places
 * API" toggle in Cloud Console -- a project with ONLY "Places API (New)"
 * enabled (not the legacy one) will load this widget without error but
 * get no results back when a visitor types, since the New API is a
 * separate product with its own enablement and its own client surface
 * (`google.maps.places.PlaceAutocompleteElement`, a web component with a
 * materially different DOM/event model than this legacy input-binding
 * widget). Migrating to it is a real, separate follow-up -- not folded
 * in here since it would change sell.html's tested search-box markup/
 * behavior, which is out of scope for a map-loading bugfix. Until then:
 * either enable the legacy "Places API" alongside "Places API (New)" on
 * the browser key (Cloud Console -> APIs & Services -> Library), or
 * treat autocomplete-not-returning-results as a known gap distinct from
 * the map itself failing to load.
 */
export async function attachAddressAutocomplete(inputEl, onPlaceSelected) {
  const google = await loadGoogleMaps();
  if (!google || !inputEl) return null;
  if (google.maps.places?.Autocomplete) {
    const autocomplete = new google.maps.places.Autocomplete(inputEl, { fields: ['geometry', 'formatted_address'] });
    autocomplete.addListener('place_changed', () => {
      const place = autocomplete.getPlace();
      const loc = place?.geometry?.location;
      if (!loc) return;
      onPlaceSelected?.({ lat: loc.lat(), lng: loc.lng(), formattedAddress: place.formatted_address });
    });
    return autocomplete;
  }
  return null;
}

export const _internal = { resolveConfig, renderUnavailable };
