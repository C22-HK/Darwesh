// Darwesh Listing Access -- the one place that decides, for a given map
// mode (explore / myProperties / admin), which listings to query and what
// coordinate precision is safe to plot. Classic (non-module) script
// attaching window.DarweshListingAccess, matching js/darwesh-marker.js/
// js/leaflet-map-helpers.js's pattern, so both map.html's classic <script>
// (via dynamic import() of its own Firestore functions, passed in here)
// and admin.html's `type="module"` script/js/admin-map.js can call in.
//
// Built entirely on fields/rules that already exist and are already
// enforced server-side -- no new backend or Firestore rules in this
// module. The REAL security boundary for every mode here is
// firestore.rules, not this file: a query this module builds can only
// ever return what the signed-in caller's own auth token already permits
// Firestore to hand back. This module's job is choosing which query to
// run and which coordinate field is honest to plot, not enforcing
// permissions client-side.
//
//   explore      -- public discovery. Every active, non-private listing,
//                    plotted at its rounded publicLat/publicLng only
//                    (see js/listing-location.js's LOC-01 rounding). No
//                    signed-in user required. Zoom is capped (see
//                    MAX_EXPLORE_ZOOM below) so bulk view can never read
//                    as building-level, whatever the base layer.
//   myProperties -- listings the signed-in user can actually manage
//                    today: their own agentId-owned listings, plus (only
//                    when the caller has already resolved that the user
//                    belongs to an org with publish_unit_listing --
//                    js/backend-api.js's listMyOrganizations/
//                    getMyPermissions) that org's published unit-backed
//                    listings. An account with neither legitimately gets
//                    an empty result -- never fabricated. Precise
//                    coordinates are fetched per listing shown (a
//                    person's own properties are a small set), never in
//                    bulk.
//   admin        -- every listing, at approximate coordinates in bulk;
//                    precise coordinates fetched ONLY for the one listing
//                    currently open in a detail panel or location-edit
//                    mode -- replacing the old #dashRequestsMap, which
//                    plotted full precision for everything at once.
(function () {
  // Matches map.html's own MAX_MAP_ZOOM for Explore -- kept here too as
  // the documented single source of truth for any other Explore-mode
  // consumer, without changing map.html's existing constant (Explore
  // stays a behavioral no-op; see the map.html map-consolidation notes).
  const MAX_EXPLORE_ZOOM = 15;

  // Admin's bulk view has no draw-area/pagination-correctness constraint
  // the way Explore does (see map.html's loadListings() for why Explore
  // is deliberately uncapped) -- a generous cap here is a plain
  // performance guard, overridable via opts.cap.
  const ADMIN_LISTINGS_CAP = 500;

  function finiteCoord(v) { return (typeof v === 'number' && Number.isFinite(v)) ? v : null; }

  // publicPinOf(d) -- the one place that decides whether a listing's
  // PUBLIC document carries a plottable coordinate. A listing whose public
  // pair is missing, non-numeric or out of range is dropped by the caller
  // (never plotted at a wrong/coerced point); this never reads
  // private/location. Shared by Explore and Admin bulk view alike, since
  // both must only ever plot the approximate pair, never precise.
  function publicPinOf(d) {
    const pLat = finiteCoord(d.publicLat);
    const pLng = finiteCoord(d.publicLng);
    if (pLat !== null && pLng !== null) {
      if (Math.abs(pLat) > 90 || Math.abs(pLng) > 180) return { lat: null, lng: null, reason: 'out_of_range' };
      return { lat: pLat, lng: pLng, reason: null };
    }
    // Legacy, pre-LOC-01 documents that were never backfilled. Still the
    // PUBLIC document's own fields -- not a private read.
    const lLat = finiteCoord(d.lat);
    const lLng = finiteCoord(d.lng);
    if (lLat !== null && lLng !== null) {
      if (Math.abs(lLat) > 90 || Math.abs(lLng) > 180) return { lat: null, lng: null, reason: 'out_of_range_legacy' };
      return { lat: lLat, lng: lLng, reason: 'legacy_fallback' };
    }
    const hasAny = d.publicLat !== undefined || d.publicLng !== undefined || d.lat !== undefined || d.lng !== undefined;
    return { lat: null, lng: null, reason: hasAny ? 'non_numeric' : 'missing' };
  }

  // queryMyProperties(fns, db, uid, opts) -> Promise<listing[]>
  // fns: { collection, query, where, getDocs } from the caller's own
  // firebase/firestore import (never imported again here, so this module
  // never pulls in a second copy of the SDK).
  // opts: { activeOrgId } -- only included when the caller has already
  // confirmed (via js/backend-api.js) that this org grants
  // publish_unit_listing; this module does not itself check permissions.
  async function queryMyProperties(fns, db, uid, opts) {
    opts = opts || {};
    const { collection, query, where, getDocs } = fns;
    const results = new Map();
    const ownSnap = await getDocs(query(collection(db, 'listings'), where('agentId', '==', uid)));
    ownSnap.forEach((d) => results.set(d.id, { id: d.id, ...d.data() }));
    if (opts.activeOrgId) {
      const orgSnap = await getDocs(query(collection(db, 'listings'), where('publisherOrgId', '==', opts.activeOrgId)));
      orgSnap.forEach((d) => { if (!results.has(d.id)) results.set(d.id, { id: d.id, ...d.data() }); });
    }
    return Array.from(results.values());
  }

  // queryAdminListings(fns, db, opts) -> Promise<listing[]>
  // Every listing regardless of status/private (the moderation view needs
  // pending/suspended/private too, unlike Explore), capped for
  // performance. opts: { cap }.
  async function queryAdminListings(fns, db, opts) {
    opts = opts || {};
    const { collection, query, limit, getDocs } = fns;
    const snap = await getDocs(query(collection(db, 'listings'), limit(opts.cap || ADMIN_LISTINGS_CAP)));
    const docs = [];
    snap.forEach((d) => docs.push({ id: d.id, ...d.data() }));
    return docs;
  }

  // fetchPreciseLocationFor(locationMod, fns, db, listingId) -- the one
  // chokepoint every mode goes through for a precise coordinate, always
  // single-listing (see js/listing-location.js's own N+1 rationale).
  // `locationMod` is the caller's already-imported js/listing-location.js
  // module (`import('./js/listing-location.js')`) -- not re-imported here,
  // so this stays a thin pass-through rather than a second copy of the
  // read.
  async function fetchPreciseLocationFor(locationMod, fns, db, listingId) {
    return locationMod.fetchPreciseLocation(fns, db, listingId);
  }

  window.DarweshListingAccess = {
    MAX_EXPLORE_ZOOM,
    ADMIN_LISTINGS_CAP,
    publicPinOf,
    queryMyProperties,
    queryAdminListings,
    fetchPreciseLocationFor
  };
})();
