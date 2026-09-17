// Darwesh Group -- shared inline-SVG icon set for Property Discovery
// (buy.html/rent.html) and Professional Network (build.html/renovate.html).
//
// WHY THIS EXISTS. Both systems previously rendered their functional icons
// (search, filters, favorite, verified, beds/baths/area, ...) as Material
// Symbols ligature text (`<span class="material-symbols-outlined">search</span>`).
// That font loads from fonts.googleapis.com; whenever it's blocked or slow
// (privacy extensions, corporate proxies, offline, China) the ligature text
// renders as its Unicode fallback -- an empty glyph box -- because the
// browser has nothing else to draw for a private-use-area codepoint. This
// module replaces every icon these two systems actually use with a real,
// self-contained SVG path so there is nothing left to fail to load.
//
// SIZING. Every icon is emitted at width="1em" height="1em" on a 24x24
// viewBox, so it inherits whatever font-size the call site already set
// (the existing `text-[Npx]` utility classes and the density-tier CSS in
// css/property-discovery.css / css/professional-network.css all size icons
// via font-size on the wrapping element) -- no markup or CSS size rule
// needed to change on top of the icon swap itself.
//
// STYLE. All icons default to stroke="currentColor" fill="none" (matching
// Material Symbols Outlined's weight); a handful that read better solid
// (the active favorite heart, the tiny dot inside the density glyphs
// elsewhere) pass fill="currentColor" explicitly per-path.
function svg(inner, viewBox = '0 0 24 24') {
  return `<svg width="1em" height="1em" viewBox="${viewBox}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${inner}</svg>`;
}

const ICONS = {
  search: '<circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>',
  tune: '<line x1="4" y1="6" x2="20" y2="6"/><circle cx="9" cy="6" r="2" fill="currentColor" stroke="none"/>'
    + '<line x1="4" y1="12" x2="20" y2="12"/><circle cx="15" cy="12" r="2" fill="currentColor" stroke="none"/>'
    + '<line x1="4" y1="18" x2="20" y2="18"/><circle cx="12" cy="18" r="2" fill="currentColor" stroke="none"/>',
  map: '<path d="M9 4v14M15 6v14M4 7l5-2 6 2 5-2v13l-5 2-6-2-5 2V7z"/>',
  bookmark_add: '<path d="M6 4h12v16l-6-4-6 4V4z"/><line x1="12" y1="7.5" x2="12" y2="11.5"/><line x1="10" y1="9.5" x2="14" y2="9.5"/>',
  search_off: '<circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="3" y1="3" x2="21" y2="21"/>',
  error: '<circle cx="12" cy="12" r="9"/><line x1="12" y1="7.5" x2="12" y2="13"/><circle cx="12" cy="16.3" r="1" fill="currentColor" stroke="none"/>',
  progress_activity: '<circle cx="12" cy="12" r="9" stroke-dasharray="42 14"/>',
  close: '<line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/>',
  verified: '<circle cx="12" cy="12" r="9"/><path d="M8.3 12.3l2.6 2.6 5-5"/>',
  check_circle: '<circle cx="12" cy="12" r="9"/><path d="M8.3 12.3l2.6 2.6 5-5"/>',
  favorite: '<path d="M12 20.5s-6.9-4.2-9.2-8.6C1.2 8.7 2.6 5 6.3 5c2 0 3.4 1.1 4.3 2.6C11.5 6.1 12.9 5 14.9 5c3.7 0 5.1 3.7 3.5 6.9-2.3 4.4-9.2 8.6-9.2 8.6z"/>',
  favorite_filled: '<path d="M12 20.5s-6.9-4.2-9.2-8.6C1.2 8.7 2.6 5 6.3 5c2 0 3.4 1.1 4.3 2.6C11.5 6.1 12.9 5 14.9 5c3.7 0 5.1 3.7 3.5 6.9-2.3 4.4-9.2 8.6-9.2 8.6z" fill="currentColor"/>',
  home_work: '<path d="M4 11.5L12 4l8 7.5"/><path d="M6 10v10h12V10"/><rect x="10" y="14" width="4" height="6" fill="currentColor" stroke="none"/>',
  location_on: '<path d="M12 21s7-7.58 7-12a7 7 0 1 0-14 0c0 4.42 7 12 7 12z"/><circle cx="12" cy="9" r="2.4"/>',
  bed: '<path d="M2.5 17v-5a2 2 0 0 1 2-2h6.5v6"/><path d="M2.5 17h19v-3a3 3 0 0 0-3-3H12"/><line x1="2.5" y1="20" x2="2.5" y2="17"/><line x1="21.5" y1="20" x2="21.5" y2="17"/>',
  bathtub: '<path d="M4 12h16a1 1 0 0 1 1 1v2a5 5 0 0 1-5 5H8a5 5 0 0 1-5-5v-2a1 1 0 0 1 1-1z"/><path d="M6.2 12V6.3a2 2 0 0 1 3.4-1.4"/><line x1="4" y1="20" x2="4" y2="22"/><line x1="20" y1="20" x2="20" y2="22"/>',
  square_foot: '<path d="M3 21L21 3"/><path d="M7 17l2-2"/><path d="M11 13l2-2"/><path d="M15 9l2-2"/>',
  arrow_forward: '<line x1="5" y1="12" x2="19" y2="12"/><path d="M13 6l6 6-6 6"/>',
  // Provider role fallback avatar glyphs (professionalNetworkCard /
  // mountProviderDiscovery's toolbar chips, when a provider has no photo).
  architecture: '<path d="M12 3v4"/><circle cx="12" cy="9" r="2"/><path d="M9.5 10.5L4 21"/><path d="M14.5 10.5L20 21"/><path d="M8 21h8"/>',
  palette: '<path d="M12 3a9 9 0 1 0 0 18c1.4 0 2-.9 2-1.8 0-.5-.2-1-.6-1.4-.4-.4-.6-.9-.6-1.4 0-1.1.9-2 2-2H17a4 4 0 0 0 4-4c0-4.4-4-8-9-8z"/>'
    + '<circle cx="8" cy="10.5" r="1.15" fill="currentColor" stroke="none"/><circle cx="8.8" cy="14.5" r="1.15" fill="currentColor" stroke="none"/><circle cx="15" cy="8" r="1.15" fill="currentColor" stroke="none"/>',
  yard: '<path d="M12 21V10"/><path d="M12 10C12 6 9 4 5 4c0 4 3 7 7 7z"/><path d="M12 13c0-3.5 2.5-5.5 6-5.5 0 3.5-2.5 6-6 6z"/>',
  cleaning_services: '<rect x="9" y="8.5" width="6" height="11.5" rx="1"/><path d="M11 8.5V5.5h2v3"/><path d="M10 5.5h4"/><path d="M4.5 6.5l1.7 1.7"/><path d="M4 3l1.3 1.3"/>',
  handyman: '<path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.8 2.8-2-2z"/>',
  gavel: '<path d="M13 4l7 7"/><path d="M5 12l7 7"/><path d="M8.5 4.5l4 4"/><path d="M16.5 12.5l4 4"/><path d="M3 21l4-4"/><line x1="10" y1="10" x2="15" y2="15"/>',
};

/**
 * @param {string} name  one of the keys in ICONS above
 * @param {object} [opts]
 * @param {boolean} [opts.filled]  use the solid variant (currently only
 *   'favorite' has one -- resolves to 'favorite_filled')
 * @returns {string} a complete `<svg>` element as a markup string, sized
 *   1em square so it inherits the call site's font-size.
 */
export function dwIcon(name, opts) {
  const key = (opts && opts.filled && name === 'favorite') ? 'favorite_filled' : name;
  const inner = ICONS[key];
  if (!inner) return '';
  return svg(inner);
}
