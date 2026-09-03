// LOC-01 — the one place that decides how precise a listing's coordinate is
// allowed to be on the publicly-readable document, plus the helpers that
// read and write the exact pin.
//
// Why this split exists: Firestore security rules are DOCUMENT-level for
// reads. A rule can allow or deny reading a listing, but it can never hand
// that listing back with one field stripped out. `listings` is
// `allow read: if true` (see firestore.rules) because map.html, buy.html and
// listing.html all serve anonymous visitors. So a public listing document
// simply must not CONTAIN a building-level coordinate — there is no rule
// that could hide it after the fact. Instead:
//
//   listings/{id}                  -> publicLat/publicLng, rounded to a
//                                     ~1.1 km grid (see below)
//   listings/{id}/private/location -> { lat, lng }, the real surveyed pin,
//                                     readable only by the listing's own
//                                     agent or an admin (see
//                                     firestore.rules'
//                                     canAccessListingPreciseLocation).
//
// Imported by admin.html and agent-dashboard.html (the only two listing
// write paths), by listing.html and map.html (the public render paths), and
// by scripts/backfill-public-coords.mjs, so the rounding rule can never
// drift between them.

// 2 decimal places. Across the Kurdistan Region (~lat 35-37°) that is a grid
// cell of roughly 1.11 km north-south by 0.90 km east-west, so a public
// point can sit up to ~715 m from the real one. That is an APPROXIMATE AREA
// — a district or a neighbourhood — never a building, which is the whole
// point: the public map is a discovery surface, and the exact address is
// something a buyer gets from the agent, not from an anonymous page scrape.
//
// Deliberately plain rounding, never random jitter:
//   - Deterministic. The same input always yields the same public point, so
//     the backfill is idempotent and re-running it is safe.
//   - Structural. The guarantee comes from the value that gets STORED, not
//     from anything the client does at render time — a jittered display over
//     a precise stored value would leak the moment someone read the document
//     directly, which is exactly the bug being fixed.
//   - Averaging-resistant. Jitter re-rolled per read can be averaged out
//     across repeated reads to recover the true point; a fixed grid cannot.
// The cost is that near-neighbours collapse onto a shared grid point, which
// map.html's existing neighbourhood grouping already renders sensibly.
export const PUBLIC_COORD_DECIMALS = 2;

const FACTOR = Math.pow(10, PUBLIC_COORD_DECIMALS);

/** Half the diagonal of one 2 dp cell at Kurdistan latitudes, in metres.
 *  listing.html draws a circle this size so the shape a visitor sees is
 *  honest about the precision actually stored, rather than implying a
 *  pinpoint. */
export const PUBLIC_COORD_RADIUS_M = 600;

/**
 * Round one coordinate to the public precision. Returns null for junk.
 *
 * Deliberately NOT a bare Number() coercion: Number(null), Number(''),
 * Number(false) and Number([]) are all 0, which would turn a listing with a
 * missing coordinate into a public pin at 0,0 — a real point in the Gulf of
 * Guinea — instead of being reported as unusable. Only real numbers, and
 * strings that actually parse as numbers (sell.html stores its pin as a
 * .toFixed(5) string), are accepted.
 */
export function toPublicCoord(value) {
  const n = (typeof value === 'number') ? value
    : (typeof value === 'string' && value.trim() !== '') ? Number(value)
    : NaN;
  if (!Number.isFinite(n)) return null;
  return Math.round(n * FACTOR) / FACTOR;
}

/**
 * Build the public-safe coordinate pair for a listing document.
 * Returns `{}` when EITHER coordinate is missing/invalid — a half pair is
 * never usable, and writing one lone axis would be worse than writing
 * nothing. Callers spread the result into a document, so `{}` simply omits
 * both fields rather than writing nulls.
 */
export function publicCoordsFrom(lat, lng) {
  const publicLat = toPublicCoord(lat);
  const publicLng = toPublicCoord(lng);
  if (publicLat === null || publicLng === null) return {};
  return { publicLat, publicLng };
}

/**
 * The approximate point to render for a listing, from whatever shape its
 * document is currently in. Returns `{ lat, lng }` or null.
 *
 * The `lat`/`lng` fallback is deliberate and load-bearing during the
 * migration window: firestore.rules stops NEW precise coordinates from
 * being written, but listings created before the backfill ran still carry
 * their old `lat`/`lng` until scripts/backfill-public-coords.mjs strips
 * them. Without this fallback, deploying the frontend ahead of the backfill
 * would blank every marker on the map. Once the backfill has run in
 * production the fallback is dead weight and can be removed.
 */
export function publicListingCoords(listing) {
  if (!listing) return null;
  const lat = (typeof listing.publicLat === 'number') ? listing.publicLat : toPublicCoord(listing.lat);
  const lng = (typeof listing.publicLng === 'number') ? listing.publicLng : toPublicCoord(listing.lng);
  if (lat === null || lng === null || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng };
}

/**
 * Read a single listing's exact pin. Only succeeds for the listing's own
 * agent or an admin — every other caller gets a permission error from the
 * rules layer, which is the point. Returns null when unreadable or absent,
 * so callers fall back to the approximate public pair rather than breaking.
 *
 * Deliberately single-listing: fetching this for a whole map's worth of
 * listings would be an N+1 read per render. The admin intel map and the
 * agent Team Map plot the approximate pair; this is for re-seeding the
 * edit form's pin on the one listing being edited.
 *
 * @param {object} fns - { doc, getDoc } from the caller's firestore import
 * @param {object} db  - Firestore instance
 * @param {string} listingId
 */
export async function fetchPreciseLocation(fns, db, listingId) {
  try {
    const snap = await fns.getDoc(fns.doc(db, 'listings', listingId, 'private', 'location'));
    if (!snap.exists()) return null;
    const d = snap.data();
    if (typeof d.lat !== 'number' || typeof d.lng !== 'number') return null;
    return { lat: d.lat, lng: d.lng };
  } catch {
    return null; // not authorized, or offline -- caller falls back to the public pair
  }
}

/**
 * Write a listing's exact pin. Must run AFTER the listing document itself
 * exists: the rules check ownership by reading the parent listing, so a
 * location doc written first (or in the same batch) is denied.
 *
 * @param {object} fns - { doc, setDoc, serverTimestamp } from the caller's firestore import
 */
export async function writePreciseLocation(fns, db, listingId, lat, lng) {
  const latN = (typeof lat === 'number') ? lat
    : (typeof lat === 'string' && lat.trim() !== '') ? Number(lat) : NaN;
  const lngN = (typeof lng === 'number') ? lng
    : (typeof lng === 'string' && lng.trim() !== '') ? Number(lng) : NaN;
  if (!Number.isFinite(latN) || !Number.isFinite(lngN)) return;
  await fns.setDoc(fns.doc(db, 'listings', listingId, 'private', 'location'), {
    lat: latN,
    lng: lngN,
    updatedAt: fns.serverTimestamp(),
  });
}
