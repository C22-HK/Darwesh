// LOC-01 — the one place that decides how precise a listing's coordinate
// is allowed to be on the publicly-readable document, and the one helper
// that writes/reads the precise pin.
//
// Why this split exists: Firestore security rules are DOCUMENT-level for
// reads. A rule can allow or deny reading a listing, but it can never
// return that listing with one field stripped out. So a public listing
// document simply must not contain a building-level coordinate — there
// is no rule that could hide it after the fact. Instead:
//
//   listings/{id}                  -> publicLat/publicLng, rounded to a
//                                     ~1.1 km grid (see below)
//   listings/{id}/private/location -> { lat, lng }, the real surveyed pin,
//                                     readable only by the listing's own
//                                     agent, an authorized org member, or
//                                     an admin (see firestore.rules'
//                                     canAccessListingPreciseLocation).
//
// Imported by admin.html and agent-dashboard.html (the two write paths)
// and by scripts/backfill-public-coords.mjs, so the rounding rule can
// never drift between them.

// 2 decimal places. Across the Kurdistan Region (~lat 35-37°) that is a
// grid cell of roughly 1.11 km north-south by 0.90 km east-west, so a
// public point can sit up to ~715 m from the real one and averages a few
// hundred metres out. That is an APPROXIMATE AREA — a district or a
// neighbourhood — never a building, which is the whole point: the public
// map is a discovery surface, and the exact address is something a buyer
// gets from the agent, not from an anonymous page scrape.
//
// (For reference, the 3 dp this started at was a ~111 m cell — still
// tight enough to single out a building on most streets, which is why it
// was widened.)
//
// Deliberately plain rounding, never random jitter:
//   - Deterministic. The same input always yields the same public point,
//     so the backfill is idempotent and re-running it is safe.
//   - Structural. The guarantee comes from the value that gets STORED,
//     not from anything the client does at render time — a jittered
//     display over a precise stored value would leak the moment someone
//     read the document directly, which is exactly the bug being fixed.
//   - Averaging-resistant. Jitter re-rolled per read can be averaged out
//     across repeated reads to recover the true point; a fixed grid
//     cannot.
// The cost is that near-neighbours collapse onto a shared grid point,
// which the map's clustering already renders sensibly.
export const PUBLIC_COORD_DECIMALS = 2;

const FACTOR = Math.pow(10, PUBLIC_COORD_DECIMALS);

/**
 * Round one coordinate to the public precision. Returns null for junk.
 *
 * Deliberately NOT a bare Number() coercion: Number(null), Number(''),
 * Number(false) and Number([]) are all 0, which would turn a listing with
 * a missing coordinate into a public pin at 0,0 — a real point in the
 * Gulf of Guinea — instead of being reported as unusable. Only real
 * numbers, and strings that actually parse as numbers (sell.html stores
 * its pin as a .toFixed(5) string), are accepted.
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
 * Returns `{}` when either coordinate is missing/invalid, so a caller can
 * spread it into a document without writing null fields.
 */
export function publicCoordsFrom(lat, lng) {
  const publicLat = toPublicCoord(lat);
  const publicLng = toPublicCoord(lng);
  if (publicLat === null || publicLng === null) return {};
  return { publicLat, publicLng };
}

/**
 * Read a single listing's precise pin. Only succeeds for the listing's
 * own agent / authorized org member / admin — every other caller gets a
 * permission error from the rules layer, which is the point. Returns null
 * when unreadable or absent, so callers can fall back to the approximate
 * public pair rather than breaking.
 *
 * Deliberately single-listing: fetching this for a whole map's worth of
 * listings would be an N+1 read per render. Bulk admin/agent map views
 * plot the approximate pair; this is for "open one property" detail and
 * for re-seeding the edit form's pin.
 *
 * @param {object} fns - { doc, getDoc } from the caller's firebase/firestore import
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
 * Write a listing's precise pin. Must run AFTER the listing document
 * itself exists: the rules check ownership by reading the parent listing,
 * so a location doc written first (or in the same batch) is denied.
 *
 * @param {object} fns - { doc, setDoc, serverTimestamp } from the caller's firestore import
 */
export async function writePreciseLocation(fns, db, listingId, lat, lng) {
  const latN = Number(lat);
  const lngN = Number(lng);
  if (!Number.isFinite(latN) || !Number.isFinite(lngN)) return;
  await fns.setDoc(fns.doc(db, 'listings', listingId, 'private', 'location'), {
    lat: latN,
    lng: lngN,
    updatedAt: fns.serverTimestamp(),
  });
}
