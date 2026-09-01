# Google Maps — Configuration, API Requirements & Query/Performance Strategy

Status: **foundation only, not yet wired into any live page.** This
document accompanies `js/maps-core.js` (the shared integration boundary)
as part of Production Rebuild Phase 1 of 3. Nothing described here has
been enabled, provisioned, or deployed by this work — this sandbox has no
Google Cloud credentials and cannot enable APIs or create keys. Every
action in this document is a manual step for a human operator with
Google Cloud Console access.

## 1. Current state (as of this phase)

The platform's existing 5 map surfaces (`map.html`, `listing.html`,
`sell.html`, `agent-dashboard.html`, `admin.html`) all run on
**Leaflet 1.9.4 + OpenStreetMap tiles + Nominatim geocoding + Overpass
API** — zero API key, zero cost, all currently working in production.
None of them have been touched or cut over to Google Maps in this phase.
`js/maps-core.js` is a new, separate, unwired module — importing it does
nothing to any existing page.

## 2. Why Google Maps is being introduced at all

The approved architecture calls for Google Maps specifically for the new
Buy/Rent discovery map, the Admin Real Estate Intelligence Map, and the
Office/Agent map — richer basemap quality, Places Autocomplete for
address entry, and a single ecosystem the team can build clustering/
heatmap/drawing tools on top of consistently. Leaflet-based pages are not
being retired this phase; they keep working exactly as they do today
until each is individually, deliberately cut over (see §6).

## 3. Required Google Cloud APIs

Enable these in Google Cloud Console → APIs & Services, on the project
that already hosts `darwesh-backend` (so billing/IAM is unified):

| API | Why | Required this phase? |
|---|---|---|
| **Maps JavaScript API** | Renders the map itself (`js/maps-core.js`'s `initMap()`) | Yes, once any page is cut over |
| **Places API (New)** | Address autocomplete (`attachAddressAutocomplete()`) | Yes, once the location picker is cut over |
| **Geocoding API** | Forward/reverse geocoding (`geocodeAddress()`/`reverseGeocode()`) | Yes, once the location picker is cut over |
| **Maps Static API** | NOT used by this module — deliberately skipped (dynamic map only, no need for static image markers) | No |
| **Directions/Distance Matrix API** | NOT used — no routing/travel-time feature exists in the approved scope | No |

Do not enable more than this list. Each enabled API is billable attack
surface and cost surface; adding one "just in case" is exactly the kind
of speculative expansion this phase's constraints ask to avoid.

## 4. API key requirements (hard constraints)

Google Maps browser keys are, by Google's own design, meant to ship in
client-side JavaScript — the protection model is **HTTP referrer
restriction + API restriction**, not secrecy of the string. This project
still never hardcodes the key into source (see `js/maps-core.js`'s
header comment) so that per-environment keys never touch version control
and there is exactly one place (deployment config) to change per
environment.

When an operator provisions the key in Google Cloud Console → Credentials:

1. **API restrictions**: restrict the key to exactly the APIs in §3 that
   are actually in use at that time — never "don't restrict".
2. **Application restrictions → HTTP referrers**: allowlist only the
   real Darwesh domains, e.g.:
   - `https://darwesh.example/*` (production — replace with the real
     production domain once assigned)
   - `https://*.darwesh.example/*` (subdomains, if used)
   - For local development: a separate, second key restricted to
     `http://localhost:*/*` / `http://127.0.0.1:*/*` — **never reuse the
     production key for local dev**, and never commit either key's raw
     value to this repository (matches this project's existing
     `docs/APP_CHECK.md` guidance for Firebase's own web config).
3. **Billing alert**: set a budget alert on the Google Cloud project
   covering Maps usage specifically, since a referrer-restricted key can
   still be called at volume from an allowed origin (e.g. a traffic
   spike, or a scraping bot hitting an allowed page) — the referrer
   restriction limits *where* it can be used, not *how much*.
4. Rotate the key (generate a new one, update deployment config, delete
   the old one) if it is ever accidentally committed, logged, or leaked
   through a channel outside the browsers it's meant for.

## 5. How `js/maps-core.js` consumes the key (dev vs. prod)

The module reads the key at runtime from, in order:

1. `window.DARWESH_MAPS_CONFIG.apiKey` — a page sets this via a small
   inline `<script>` *before* importing `maps-core.js`. In production
   this would be templated in by whatever step already exists for
   per-environment values (this static site currently has no build step
   — see `js/backend-config.js`'s hostname-detection pattern as the
   nearest existing precedent; a maps key would likely follow the same
   "detect environment, pick the matching restricted key" shape once a
   real deploy pipeline exists).
2. `<meta name="darwesh-google-maps-key" content="...">` — a lighter-
   weight alternative for pages that would rather not add an inline
   script.

If neither is present (**exactly the case in this sandbox, and in any
environment before an operator provisions a key**), `isConfigured()`
returns `false`, `loadGoogleMaps()` resolves to `null` instead of
throwing, and every `init`/`geocode`/`autocomplete` helper degrades to a
visible "map unavailable — configuration required" placeholder (or a
plain, still-fully-usable text input for the autocomplete case) rather
than a blank box or an uncaught error. This was verified by exercising
the module with no `DARWESH_MAPS_CONFIG` set — every exported function
returns its documented fallback value.

**Dev vs. prod behavior**: identical code path — the only difference is
which key (if any) is configured. A developer running locally with no
key configured sees the graceful fallback everywhere; there is no
separate "mock maps" mode to maintain.

## 6. Planned page-by-page cutover (NOT done this phase)

Explicitly deferred, in this order, each its own reviewable change once
a real key exists to test against:

1. Public Buy/Rent discovery map (new page/section, replaces nothing
   existing — additive).
2. `sell.html` / `admin.html` location pickers (replace the Nominatim/
   Leaflet pin picker with `attachAddressAutocomplete()` +
   `initMap()`) — currently working Leaflet code stays in place and
   untouched until a real key is available to validate the swap.
3. Office/Agent map (`agent-dashboard.html`'s team map).
4. Admin Real Estate Intelligence Map (new admin surface).

`listing.html`'s single-marker display map is the lowest-risk, lowest-
priority candidate for cutover (or may simply stay on Leaflet
indefinitely — a single static marker has no real Google-Maps-specific
benefit).

---

## 7. Map query & performance strategy

This section is architecture/documentation only — no query code from
this section has been built into any page yet, since no discovery UI
exists yet to issue these queries (see §6, item 1, still pending).
Recorded here so the eventual discovery-map implementation has an
already-reviewed plan to build against, per the explicit constraint:
**do not download all Firestore listings and filter client-side; no
unlimited realtime listeners.**

### 7.1 The core anti-pattern this design avoids

`onSnapshot(collection(db, 'listings'))` with no `where`/`limit` — an
unbounded realtime listener over the entire collection — is explicitly
out of bounds. It does not scale past a few hundred documents (every
client downloads every listing on every change, forever, for the life of
the tab), and duplicates work the server should be doing via indexed
queries.

### 7.2 Query shape for the map

- **Bounds-scoped reads, not a live listener, while panning/zooming**: on
  map idle (debounced, e.g. 300ms after the last pan/zoom event — not on
  every frame), issue a single `getDocs()` query scoped to the current
  viewport, not `onSnapshot()`. A live listener is reserved for a much
  narrower case (e.g. "notify me if a new listing appears in my saved
  search area"), never the general map-browsing case.
- **Geographic filtering approach**: Firestore has no native geo-radius/
  bounding-box query operator across two independent range fields (a
  `where('lat', ...) && where('lng', ...)` compound range query is not
  supported — Firestore only allows range filters on one field per
  query, or requires a geohash). Two workable approaches, in order of
  recommended adoption:
  1. **Geohash-prefix range query** (recommended): store a `geohash`
     string field on each listing (client-computed at write time from
     `lat`/`lng`, e.g. via a small geohash utility — no new backend
     dependency needed for encoding), then query
     `where('geohash', '>=', minHash) && where('geohash', '<=', maxHash)`
     for the covering cell(s) of the current viewport, client-side
     filtering the (small) over-fetched edge afterward for exact bounds.
     This is the standard, well-documented Firestore geo-query pattern
     and needs only ONE new indexed field, not a new service.
  2. **City/district-bucketed fallback** (simpler, coarser): since every
     listing already has denormalized `city`/`district` fields, a first
     cut can query `where('city', '==', selectedCity)` and rely on the
     existing admin-boundary polygon (already fetched via Overpass on
     `map.html`/`admin.html`) purely for client-side visual clipping,
     deferring true radius/bounds queries to the geohash approach once
     listing volume in one city grows large enough to need it.
- **Always paginated**: every query carries an explicit `limit()` (e.g.
  200 results per viewport load) plus cursor-based
  `startAfter()`/`endBefore()` for "load more" — never an unbounded
  fetch, matching this codebase's existing conservative-by-default
  posture (e.g. `hasSaneListingNumbers()`'s bounded-value checks in
  `firestore.rules`).
- **Denormalized, indexed filter fields**: `dealType`, `propertyType`,
  `city`, `district`, `price` (already present on `listings`) are the
  fields a map's filter panel would compound-query on. Composite indexes
  for the actual query shapes get added in `firestore.indexes.json` at
  the point the discovery-map query code is actually written (§6, item
  1) — not speculatively now, per this phase's own "no speculative index
  explosion" instruction. No new indexes are added in this pass.
- **Clustering**: client-side marker clustering (e.g. a lightweight
  grid/supercluster-style algorithm run on the current viewport's
  already-fetched, already-paginated result set) — clustering is a
  rendering concern over data already fetched under the above limits,
  not a substitute for bounding the query itself.

### 7.3 Scaling implications (10K / 100K properties, 700K users)

- **10K properties**: the geohash-range-query + `limit(200)` +
  city/district compound-filter approach comfortably serves this
  scale directly from Firestore — a viewport query returns a small,
  indexed slice, never the whole collection. No additional
  infrastructure needed.
- **100K properties**: the same approach still holds structurally
  (Firestore's query performance is a function of result-set size and
  index selectivity, not total collection size), but two things become
  load-bearing at this scale and should be revisited when volume
  approaches it, not built preemptively now: (a) geohash bucket
  granularity may need tuning (coarser buckets in sparse areas, finer in
  dense ones) to keep the over-fetch/re-filter ratio reasonable in dense
  cities; (b) read cost (Firestore bills per document read) becomes
  worth actively monitoring — the `limit()` ceiling directly caps this,
  but it is the first metric to watch as data grows.
- **700K users**: this is a *read concurrency* concern, not a data-volume
  one — the design above already avoids the failure mode that would hurt
  here (no unbounded realtime listener per user), since every user's map
  interaction is bounded, cursor-paginated, one-shot reads rather than a
  standing subscription. Firestore's own infrastructure scales read
  throughput horizontally; the discipline this document imposes (bounded
  queries, no unlimited listeners) is what keeps 700K concurrent map
  users from each holding an open, ever-growing subscription.
- **A future search-service boundary** (e.g. Algolia, Typesense,
  Elasticsearch, or a Cloud Function-maintained secondary index) becomes
  worth introducing if/when: full-text search across listing titles/
  descriptions is needed (Firestore has no native full-text search), or
  compound filter+sort combinations exceed what composite indexes can
  reasonably cover, or true radius search (not geohash-bucket
  approximation) becomes a hard product requirement. **None of these
  conditions are met today** — this phase deliberately does not
  introduce a search-service dependency, per the explicit instruction
  not to add a large search dependency now. This paragraph exists so the
  decision is revisited with real usage data, not forgotten.

### 7.4 Realtime listener policy (explicit, to prevent future drift)

- Allowed: a narrowly-scoped `onSnapshot()` on a single document a user
  is actively viewing (e.g. `listing.html`'s own listing, to reflect a
  live price/status change), or a small, already-`limit()`-ed saved-
  search subscription a user explicitly opted into.
- Not allowed: any `onSnapshot()` over an unbounded or map-viewport-sized
  query. Viewport data is fetched via one-shot `getDocs()` on pan/zoom
  idle, per §7.2 — a moving viewport is not something a listener should
  ever be attached to.
