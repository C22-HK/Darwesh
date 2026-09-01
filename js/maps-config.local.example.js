// Template for js/maps-config.js -- the file that actually sets
// window.DARWESH_MAPS_CONFIG for js/maps-core.js to read (see that
// file's own header comment, and docs/GOOGLE_MAPS_CONFIGURATION.md for
// the full key-provisioning/restriction requirements).
//
// js/maps-config.js itself is gitignored and is NEVER committed --
// a Google Maps browser key is meant to be client-visible (protected by
// HTTP-referrer + API restrictions, not secrecy), but keeping it out of
// git history is still simple to do and avoids ever needing a commit to
// rotate it. In production (GitHub Pages), this file is generated at
// deploy time by .github/workflows/deploy-pages.yml from the
// GOOGLE_MAPS_BROWSER_KEY repository secret -- see that workflow for
// the generation step.
//
// For local development: copy this file to js/maps-config.js and fill
// in a key restricted to http://localhost:*/* / http://127.0.0.1:*/*
// (never reuse the production key locally -- see
// docs/GOOGLE_MAPS_CONFIGURATION.md §4). If js/maps-config.js is absent
// (e.g. a fresh clone before you've copied this template), every page
// that uses js/maps-core.js degrades gracefully: buy-rent-map.html and
// the Admin Estate Intelligence Map show a "map unavailable" panel, and
// sell.html/agent-dashboard.html's location pickers fall back to their
// original Leaflet/Nominatim implementation -- nothing breaks.
window.DARWESH_MAPS_CONFIG = {
  apiKey: "YOUR_GOOGLE_MAPS_BROWSER_KEY"
};
