// Darwesh Location Edit -- the one location-edit-mode interaction: a
// draggable pin the caller can click-to-place and drag-to-refine, used
// identically by map.html's My Properties "Edit Location" action and
// admin.html's Map Management detail panel "Edit Location" action.
// Classic (non-module) script attaching window.DarweshLocationEdit,
// matching js/darwesh-marker.js/js/leaflet-map-helpers.js's pattern.
// Replaces #adminPinMap entirely -- there is now exactly one place a
// precise pin gets placed/dragged, not a second copy per host page.
//
// This module owns only the MAP interaction (the pin, click-to-place,
// drag-to-refine, cursor affordance). It deliberately does NOT own the
// Save/Cancel buttons or the lat/lng readout text -- map.html's future My
// Properties panel and admin.html's detail panel have very different
// surrounding chrome, so the caller renders those itself and is told the
// current coordinate through onChange().
(function () {
  // start(L, map, opts) -> handle
  //   opts.initialLatLng: [lat, lng] | null -- null means "await a first
  //     click/tap to place the pin" (e.g. a listing with no location yet);
  //     given a pair means "seed the pin there, already draggable" (e.g.
  //     editing an existing precise location).
  //   opts.onChange(lat, lng): called after every placement/drag/move.
  // handle:
  //   getLatLng() -> {lat, lng} | null
  //   setLatLng(lat, lng) -- move the pin programmatically (e.g. the
  //     caller's own "use my current location" action), placing it if not
  //     already placed.
  //   stop() -- removes the pin and the click listener, restores the
  //     map's default cursor. Always call this on Save AND on Cancel; it
  //     does not itself decide which one happened.
  function start(L, map, opts) {
    opts = opts || {};
    const onChange = opts.onChange || function () {};
    let marker = null;
    let placed = false;

    function applyCursor() {
      map.getContainer().style.cursor = placed ? '' : 'crosshair';
    }

    function place(lat, lng) {
      placed = true;
      if (marker) {
        marker.setLatLng([lat, lng]);
      } else {
        marker = L.marker([lat, lng], {
          icon: window.DarweshMarker.editPinIcon(L),
          draggable: true,
          zIndexOffset: 2000
        }).addTo(map);
        marker.on('dragend', () => {
          const ll = marker.getLatLng();
          onChange(ll.lat, ll.lng);
        });
      }
      applyCursor();
      onChange(lat, lng);
    }

    function onMapClick(e) {
      place(e.latlng.lat, e.latlng.lng);
    }
    map.on('click', onMapClick);

    if (opts.initialLatLng) {
      place(opts.initialLatLng[0], opts.initialLatLng[1]);
    } else {
      applyCursor();
    }

    return {
      getLatLng() {
        if (!marker) return null;
        const ll = marker.getLatLng();
        return { lat: ll.lat, lng: ll.lng };
      },
      setLatLng(lat, lng) {
        place(lat, lng);
      },
      stop() {
        map.off('click', onMapClick);
        if (marker) { map.removeLayer(marker); marker = null; }
        placed = false;
        map.getContainer().style.cursor = '';
      }
    };
  }

  window.DarweshLocationEdit = { start };
})();
