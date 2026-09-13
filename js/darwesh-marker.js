// Darwesh Marker System -- the one marker/icon factory for every map
// surface (public Explore, My Properties, Admin Map Management). A
// classic (non-module) script, matching js/admin-shell.js/js/currency.js's
// existing pattern, so it's consumable both by map.html's classic main
// <script> and by admin.html's `type="module"` inline script (which can
// read window.DarweshMarker without an import, exactly how it already
// reads window.AdminShellToast).
//
// Every function here is pure and parameterized on `L` (the caller's own
// Leaflet global) and plain data -- nothing here holds a map instance or
// reads a zoom level itself. Zoom-based decisions (e.g. "show the compact
// pin below this zoom") stay the CALLER's responsibility, since different
// consumers may reasonably want different thresholds.
//
// Extracted near-verbatim from map.html's own priceIcon()/clusterIcon()/
// neighborhoodIcon()/addApproxHalo()/PROPERTY_TYPE_ICON_PATHS (a pure,
// visual-no-op relocation -- see css/darwesh-marker.css for the matching
// CSS extraction) plus three genuinely new pieces: a `.pin-private`
// modifier, a distinctive draggable edit-mode pin, and an animated
// current-location pulse dot.
(function () {
  const PROPERTY_TYPE_ICON_PATHS = {
    house: '<path d="M3 11l9-8 9 8"/><path d="M5 10v10h14V10"/><path d="M9 20v-6h6v6"/>',
    villa: '<path d="M3 12l9-7 9 7"/><path d="M5 11v9h14v-9"/><circle cx="12" cy="15" r="2"/>',
    apartment: '<rect x="4" y="3" width="16" height="18" rx="1"/><path d="M8 7h2M14 7h2M8 11h2M14 11h2M8 15h2M14 15h2"/>',
    land: '<path d="M3 20h18"/><path d="M6 20V8M10 20V8M14 20V8M18 20V8"/>',
    building: '<rect x="7" y="2" width="10" height="20" rx="1"/><path d="M10 6h1M13 6h1M10 10h1M13 10h1M10 14h1M13 14h1M10 18h1M13 18h1"/>',
    office: '<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M3 12h18"/>',
    shop: '<path d="M3 9l1-5h16l1 5"/><path d="M4 9v11h16V9"/><path d="M9 20v-6h6v6"/>',
    commercialProperty: '<rect x="4" y="4" width="16" height="16" rx="1"/><path d="M12 8v8M9.8 10a2.3 2.3 0 0 1 2.2-1.3c1.3 0 2.3.6 2.3 1.5s-1 1.3-2.3 1.3-2.3.5-2.3 1.5 1 1.5 2.3 1.5a2.3 2.3 0 0 0 2.2-1.3"/>'
  };
  const FALLBACK_PATH = PROPERTY_TYPE_ICON_PATHS.house;

  function propertyTypeIconSvg(propertyType, extraAttrs) {
    const d = PROPERTY_TYPE_ICON_PATHS[propertyType] || FALLBACK_PATH;
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"' + (extraAttrs ? ' ' + extraAttrs : '') + '>' + d + '</svg>';
  }

  // priceIcon(L, listing, { active, compact, private }) -- `listing` needs
  // `.id`, `.propertyType`, `.verified`, `.priceLabel` (only required when
  // not compact).
  function priceIcon(L, listing, opts) {
    opts = opts || {};
    const statusClass = listing.verified ? 'pin-verified' : 'pin-unverified';
    const privateClass = opts.private ? ' pin-private' : '';
    const icon = propertyTypeIconSvg(listing.propertyType, 'class="price-pin-icon"');
    if (opts.compact && !opts.active) {
      return L.divIcon({
        className: '',
        html: '<div class="price-pin price-pin-compact ' + statusClass + privateClass + '" data-id="' + listing.id + '">' + icon + '</div>',
        iconSize: [26, 26],
        iconAnchor: [13, 13]
      });
    }
    return L.divIcon({
      className: '',
      html: '<div class="price-pin ' + statusClass + privateClass + (opts.active ? ' active' : '') + '" data-id="' + listing.id + '">' + icon + '<span class="price-pin-label">' + (listing.priceLabel || '') + '</span></div>',
      iconSize: null,
      iconAnchor: [30, 15]
    });
  }

  function clusterIcon(L, count, label) {
    return L.divIcon({
      className: '',
      html: '<div class="price-cluster" role="img" aria-label="' + (label || 'Group of listings') + ': ' + count + '">' + count + '</div>',
      iconSize: [40, 40],
      iconAnchor: [20, 20]
    });
  }

  function cityBadgeIcon(L, html) {
    return L.divIcon({ className: '', html: '<div class="private-city-badge">' + html + '</div>', iconSize: null, iconAnchor: [20, 14] });
  }

  function neighborhoodIcon(L) {
    return L.divIcon({ className: '', html: '<div class="neighborhood-pin"></div>', iconSize: [16, 16], iconAnchor: [8, 8] });
  }

  // addApproxHalo(L, map, lat, lng, layerBag, opts) -- LOC-01 honesty
  // circle, see js/listing-location.js and map.html's own comment for the
  // full rationale. `radiusM` defaults to the existing 600m constant but
  // is overridable per-consumer.
  function addApproxHalo(L, map, lat, lng, layerBag, opts) {
    opts = opts || {};
    const halo = L.circle([lat, lng], {
      radius: opts.radiusM || 600,
      interactive: false,
      className: 'approx-halo',
      stroke: true, weight: 1, color: '#B89A63', opacity: 0.35,
      fill: true, fillColor: '#B89A63', fillOpacity: 0.07
    });
    halo.addTo(map);
    layerBag.push(halo);
    return halo;
  }

  // buildPixelGridClusters(map, listings, opts) -- hand-rolled pixel-grid
  // clustering (no external library), generalized from map.html's
  // clusterVisibleListings(): takes the map instance + the listings to
  // consider + { activeId, gridPx } instead of reading module-level
  // globals. `listings` items need `.id`, `.lat`, `.lng`.
  function buildPixelGridClusters(map, listings, opts) {
    opts = opts || {};
    const gridPx = opts.gridPx || 56;
    const activeId = opts.activeId;
    const cellOf = (l) => {
      const pt = map.latLngToContainerPoint([l.lat, l.lng]);
      return Math.round(pt.x / gridPx) + ':' + Math.round(pt.y / gridPx);
    };
    const cells = {};
    listings.forEach((l) => {
      if (activeId != null && l.id === activeId) return;
      const key = cellOf(l);
      (cells[key] = cells[key] || []).push(l);
    });
    const clusters = [];
    const solo = [];
    Object.values(cells).forEach((group) => {
      if (group.length > 1) clusters.push(group);
      else solo.push(group[0]);
    });
    return { clusters, solo };
  }

  // editPinIcon(L) -- the distinctive draggable location-edit-mode pin.
  function editPinIcon(L) {
    return L.divIcon({
      className: '',
      html: '<div class="darwesh-edit-pin"><div class="darwesh-edit-pin-body"><svg class="darwesh-edit-pin-crosshair" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><path d="M12 2v6M12 16v6M2 12h6M16 12h6"/><circle cx="12" cy="12" r="2.5"/></svg></div></div>',
      iconSize: [36, 44],
      iconAnchor: [18, 40]
    });
  }

  // currentLocationIcon(L) -- animated pulse-halo current-location dot.
  function currentLocationIcon(L) {
    return L.divIcon({
      className: '',
      html: '<div class="darwesh-locate-dot"></div>',
      iconSize: [16, 16],
      iconAnchor: [8, 8]
    });
  }

  window.DarweshMarker = {
    PROPERTY_TYPE_ICON_PATHS,
    propertyTypeIconSvg,
    priceIcon,
    clusterIcon,
    cityBadgeIcon,
    neighborhoodIcon,
    addApproxHalo,
    buildPixelGridClusters,
    editPinIcon,
    currentLocationIcon
  };
})();
