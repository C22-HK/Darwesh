// Darwesh Leaflet Map Helpers -- shared, non-visual map plumbing consumed
// by every Leaflet page (map.html, admin.html's Customer Services request-
// detail map, and the Admin Map Management tab). Classic (non-module)
// script attaching window.DarweshLeafletHelpers, matching the same pattern
// as js/darwesh-marker.js/js/admin-shell.js/js/currency.js, so both a
// classic <script> (map.html) and a `type="module"` script (admin.html's
// inline module, js/admin-map.js) can call in without an import.
//
// Extracted from real duplication, not speculatively: addBaseTiles/
// loadNearbyAmenities/clearAmenityLayers previously lived only in
// admin.html with a `= adminPinMap` default parameter -- once #adminPinMap
// is removed (see the Admin Map consolidation plan) that default is
// meaningless, and both remaining consumers (the untouched
// #requestDetailMap and the new Map Management tab, a separate
// `type="module"` file) need the SAME implementation without either one
// reaching into the other's script scope. fetchAdministrativeBoundaries
// replaces map.html's loadAdminBoundaries() and admin.html's near-
// identical loadReqMapBoundaries() -- the same Overpass query against the
// same known-city allowlist, genuinely one function rather than two
// hand-copies of it (the standalone visual constants below intentionally
// settle on map.html's already on-brand weight/opacity/CSS-class choice
// rather than preserving both call sites' slightly different tuning).
//
// Deliberately NOT included here: the draw-area/search-this-area pointer
// gesture tool. It is not actually duplicated anywhere today (admin's old
// Estate Intelligence map used a separate, simpler Google Maps
// DrawingManager, itself being removed, not reused) and it is tightly
// coupled to map.html's own filter/toast/URL-state machinery -- pulling it
// apart now, before the Admin Map tab exists to say whether it even needs
// the same interaction, would be speculative extraction rather than real
// duplication removal. Revisit if/when that tab needs it.
(function () {
  // ---- Base tiles --------------------------------------------------------
  // CartoDB's free basemaps (no key needed) -- "Positron" (silver/minimal)
  // for panels sitting on a light surface, "Dark Matter" (midnight) for
  // panels sitting on the dashboard's dark surface.
  const TILE_LIGHT = { url: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', attribution: '&copy; OpenStreetMap contributors &copy; <a href="https://carto.com/attributions">CARTO</a>' };
  const TILE_DARK = { url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', attribution: '&copy; OpenStreetMap contributors &copy; <a href="https://carto.com/attributions">CARTO</a>' };
  function addBaseTiles(L, map, style) {
    const t = style === 'dark' ? TILE_DARK : TILE_LIGHT;
    L.tileLayer(t.url, { attribution: t.attribution, maxZoom: 19, subdomains: 'abcd' }).addTo(map);
  }

  // ---- Nearby amenities (Overpass) ---------------------------------------
  // Draws lines from a single point to the nearest hospital/market/school/
  // mosque, live from OpenStreetMap's public Overpass API -- a visual aid
  // when reviewing or pricing a listing, nothing stored. `translate(key,
  // fallback)` and the POI category labels are passed in by the caller
  // (admin.html's own trAdmin()) rather than assumed, so this module makes
  // no assumption about which i18n namespace/key set is loading it.
  const POI_CATEGORIES = {
    hospital: { labelKey: 'admin.catHospital', label: 'Hospital', icon: 'local_hospital', color: '#ba1a1a' },
    market:   { labelKey: 'admin.catMarket',   label: 'Market',   icon: 'storefront',     color: '#8a6a38' },
    school:   { labelKey: 'admin.catSchool',   label: 'School',   icon: 'school',         color: '#0b1d2d' },
    mosque:   { labelKey: 'admin.catMosque',   label: 'Mosque',   icon: 'mosque',         color: '#00a656' }
  };
  const AMENITY_RADIUS_M = 3000;

  function classifyPOI(tags) {
    if (!tags) return null;
    if (['hospital', 'clinic', 'pharmacy'].includes(tags.amenity)) return 'hospital';
    if (['supermarket', 'mall', 'convenience', 'greengrocer'].includes(tags.shop) || tags.amenity === 'marketplace') return 'market';
    if (['school', 'university', 'college', 'kindergarten'].includes(tags.amenity)) return 'school';
    if (tags.amenity === 'place_of_worship' && tags.religion === 'muslim') return 'mosque';
    return null;
  }

  function escapeHtml(str) {
    return String(str == null ? '' : str).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  function clearAmenityLayers(map, layers) {
    layers.forEach((layer) => map.removeLayer(layer));
    layers.length = 0;
  }

  let amenityRequestId = 0;

  // loadNearbyAmenities(L, map, lat, lng, opts) -- opts: { layers,
  // statusEl, translate(key, fallback), onEmpty }. `statusEl` is the
  // element this renders its own status/result rows into (the caller owns
  // showing/hiding it); `translate` defaults to a passthrough of the
  // fallback string if the caller doesn't supply one.
  async function loadNearbyAmenities(L, map, lat, lng, opts) {
    opts = opts || {};
    const layers = opts.layers || [];
    const statusEl = opts.statusEl;
    const translate = opts.translate || ((key, fallback) => fallback);
    const myRequestId = ++amenityRequestId;
    clearAmenityLayers(map, layers);
    if (statusEl) {
      statusEl.innerHTML = `<div class="amenity-row-chip"><span class="material-symbols-outlined" style="color:#d9b76a;">explore</span><span class="name">${translate('admin.nearbyFinding', 'Finding nearby important places...')}</span></div>`;
    }

    const query = `[out:json][timeout:15];(` +
      `node["amenity"~"^(hospital|clinic|pharmacy)$"](around:${AMENITY_RADIUS_M},${lat},${lng});` +
      `node["shop"~"^(supermarket|mall|convenience|greengrocer)$"](around:${AMENITY_RADIUS_M},${lat},${lng});` +
      `node["amenity"="marketplace"](around:${AMENITY_RADIUS_M},${lat},${lng});` +
      `node["amenity"~"^(school|university|college|kindergarten)$"](around:${AMENITY_RADIUS_M},${lat},${lng});` +
      `node["amenity"="place_of_worship"]["religion"="muslim"](around:${AMENITY_RADIUS_M},${lat},${lng});` +
      `);out body;`;

    let elements;
    try {
      const res = await fetch('https://overpass-api.de/api/interpreter', {
        method: 'POST',
        body: 'data=' + encodeURIComponent(query)
      });
      if (!res.ok) throw new Error('bad response');
      const data = await res.json();
      elements = data.elements || [];
    } catch (err) {
      if (myRequestId !== amenityRequestId) return;
      if (statusEl) statusEl.innerHTML = `<div class="amenity-row-chip"><span class="material-symbols-outlined" style="color:#ffb4ab;">error</span><span class="name">${translate('admin.nearbyFailed', "Couldn't load nearby places — try again.")}</span></div>`;
      return;
    }
    if (myRequestId !== amenityRequestId) return;

    const origin = L.latLng(lat, lng);
    const nearest = {};
    elements.forEach((el) => {
      const cat = classifyPOI(el.tags);
      if (!cat || el.lat == null || el.lon == null) return;
      const dist = origin.distanceTo(L.latLng(el.lat, el.lon));
      if (!nearest[cat] || dist < nearest[cat].dist) {
        nearest[cat] = { dist, name: (el.tags && el.tags.name) || POI_CATEGORIES[cat].label, lat: el.lat, lon: el.lon };
      }
    });

    const cats = Object.keys(POI_CATEGORIES).filter((c) => nearest[c]);
    if (cats.length === 0) {
      if (statusEl) statusEl.innerHTML = `<div class="amenity-row-chip"><span class="material-symbols-outlined" style="color:#8192a7;">info</span><span class="name">${translate('admin.nearbyNone', 'No important places found within 3 km.')}</span></div>`;
      return;
    }

    if (statusEl) {
      statusEl.innerHTML = `<div class="flex flex-col gap-1.5">` + cats.map((cat) => {
        const cfg = POI_CATEGORIES[cat];
        const poi = nearest[cat];
        const km = (poi.dist / 1000).toFixed(2);
        return `<div class="amenity-row-chip">
        <span class="material-symbols-outlined" style="color:${cfg.color};">${cfg.icon}</span>
        <strong>${translate(cfg.labelKey, cfg.label)}</strong>
        <span class="name">${escapeHtml(poi.name)}</span>
        <span class="km">${km} km</span>
      </div>`;
      }).join('') + `</div>`;
    }

    const originPulse = L.marker(origin, {
      icon: L.divIcon({ className: '', html: `<div class="amenity-origin-pulse"></div>`, iconSize: [16, 16], iconAnchor: [8, 8] }),
      interactive: false, zIndexOffset: 500
    }).addTo(map);
    layers.push(originPulse);

    cats.forEach((cat) => {
      const cfg = POI_CATEGORIES[cat];
      const poi = nearest[cat];
      const poiLatLng = L.latLng(poi.lat, poi.lon);

      const glow = L.polyline([origin, poiLatLng], { color: cfg.color, weight: 7, opacity: 0.16, lineCap: 'round' }).addTo(map);
      layers.push(glow);
      const line = L.polyline([origin, poiLatLng], { color: cfg.color, weight: 2.5, opacity: 0.9, lineCap: 'round' }).addTo(map);
      layers.push(line);

      const marker = L.marker(poiLatLng, {
        icon: L.divIcon({
          className: '',
          html: `<div style="width:24px;height:24px;border-radius:999px;background:${cfg.color};display:flex;align-items:center;justify-content:center;box-shadow:0 2px 8px rgba(7,27,47,0.45);border:2px solid #ffffff;"><span class="material-symbols-outlined" style="font-size:14px;color:#fff;">${cfg.icon}</span></div>`,
          iconSize: [24, 24],
          iconAnchor: [12, 12]
        })
      }).addTo(map);
      // poi.name comes from Overpass/OpenStreetMap -- third-party data any
      // OSM contributor can edit -- and a STRING tooltip is rendered by
      // Leaflet via innerHTML, so it is escaped like any other untrusted
      // string.
      marker.bindTooltip(`${escapeHtml(poi.name)} — ${(poi.dist / 1000).toFixed(2)} km`);
      layers.push(marker);

      const label = L.marker([(origin.lat + poiLatLng.lat) / 2, (origin.lng + poiLatLng.lng) / 2], {
        icon: L.divIcon({
          className: '',
          html: `<div class="amenity-dist-chip"><span class="dot" style="background:${cfg.color};"></span>${(poi.dist / 1000).toFixed(2)} km</div>`,
          iconSize: null
        }),
        interactive: false
      }).addTo(map);
      layers.push(label);
    });
  }

  // ---- Administrative boundaries (Overpass) ------------------------------
  // Real OSM district/city boundary lines (admin_level=8), the same public
  // Overpass API used for nearby-amenities. Returns plain shape
  // descriptors rather than drawing directly, so a caller can fetch once
  // and draw into whichever map it owns. A city with no boundary data in
  // OSM is simply skipped -- no fabricated outline is drawn in its place.
  function ringFromGeometry(geometry) {
    return (geometry || []).map((pt) => [pt.lat, pt.lon]);
  }

  // fetchAdministrativeBoundaries(cityNames, opts) -> Promise<Array<{
  //   coords: [lat,lng][], label: string|null, labelLatLng: [lat,lng]|null
  // }>>. `cityNames` is the caller's own known-city allowlist (never
  // fabricated -- a name with no match in this list is never drawn).
  async function fetchAdministrativeBoundaries(cityNames, opts) {
    opts = opts || {};
    const bbox = opts.bbox || '34.9,42.0,37.5,46.2';
    const query = `[out:json][timeout:25];(way["boundary"="administrative"]["admin_level"="8"](${bbox});relation["boundary"="administrative"]["admin_level"="8"](${bbox}););out geom;`;
    const isKnownCity = (tags) => {
      const name = (tags && (tags.name || tags['name:en'])) || '';
      return cityNames.some((c) => name.toLowerCase() === c.toLowerCase());
    };
    const shapes = [];
    try {
      const res = await fetch('https://overpass-api.de/api/interpreter', {
        method: 'POST',
        body: 'data=' + encodeURIComponent(query)
      });
      if (!res.ok) return shapes;
      const data = await res.json();
      (data.elements || []).forEach((el) => {
        if (!isKnownCity(el.tags)) return;
        const label = (el.tags && (el.tags.name || el.tags['name:en'])) || null;
        if (el.type === 'way' && el.geometry) {
          const coords = ringFromGeometry(el.geometry);
          shapes.push({ coords, label, labelLatLng: coords[Math.floor(coords.length / 2)] || null });
        } else if (el.type === 'relation' && el.members) {
          let labelPlaced = false;
          (el.members || []).forEach((m) => {
            if (m.type !== 'way' || m.role !== 'outer' || !m.geometry) return;
            const coords = ringFromGeometry(m.geometry);
            shapes.push({ coords, label: labelPlaced ? null : label, labelLatLng: labelPlaced ? null : (coords[Math.floor(coords.length / 2)] || null) });
            labelPlaced = true;
          });
        }
      });
    } catch (e) {
      // Overpass unreachable or slow -- boundaries are a purely decorative
      // layer, so an empty array (no shapes drawn) is the correct silent
      // fallback rather than surfacing an error.
    }
    return shapes;
  }

  // drawBoundaryShape(L, map, shape, layerBag) -- draws one descriptor from
  // fetchAdministrativeBoundaries() using the shared .admin-boundary-label
  // style (css/darwesh-marker.css).
  function drawBoundaryShape(L, map, shape, layerBag) {
    const coords = shape.coords;
    if (!coords || coords.length < 2) return;
    const isClosedRing = coords.length > 2 &&
      Math.abs(coords[0][0] - coords[coords.length - 1][0]) < 1e-6 &&
      Math.abs(coords[0][1] - coords[coords.length - 1][1]) < 1e-6;
    const shapeLayer = isClosedRing
      ? L.polygon(coords, { color: '#8b0000', weight: 2.5, opacity: 0.85, fillColor: '#8b0000', fillOpacity: 0.05 })
      : L.polyline(coords, { color: '#8b0000', weight: 2.5, opacity: 0.85, dashArray: '6 4' });
    shapeLayer.addTo(map);
    layerBag.push(shapeLayer);
    if (shape.label && shape.labelLatLng) {
      const labelMarker = L.marker(shape.labelLatLng, {
        icon: L.divIcon({ className: '', html: `<div class="admin-boundary-label">${shape.label}</div>`, iconSize: null, iconAnchor: [0, 0] }),
        interactive: false
      });
      labelMarker.addTo(map);
      layerBag.push(labelMarker);
    }
  }

  window.DarweshLeafletHelpers = {
    addBaseTiles,
    clearAmenityLayers,
    loadNearbyAmenities,
    fetchAdministrativeBoundaries,
    drawBoundaryShape
  };
})();
