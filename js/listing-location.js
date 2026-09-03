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
//   listings/{id}                  -> publicLat/publicLng, rounded (~111 m)
//   listings/{id}/private/location -> { lat, lng }, the real surveyed pin,
//                                     readable only by the listing's own
//                                     agent, an authorized org member, or
//                                     an admin (see firestore.rules'
//                                     canAccessListingPreciseLocation).
//
// Imported by admin.html and agent-dashboard.html (the two write paths)
// and by scripts/backfill-public-coords.mjs, so the rounding rule can
// never drift between them.

// 3 decimal places ≈ 111 m at the equator, and less than that in latitude
// terms this far north — enough to place a listing in its neighbourhood
// and street block, not enough to point at one building. Deliberately
// plain rounding rather than random jitter: it is deterministic (the same
// input always yields the same public point, so re-running the backfill
// is idempotent) and it collapses near-neighbours onto a shared grid
// point, which the map's clustering already renders sensibly.
export const PUBLIC_COORD_DECIMALS = 3;

const FACTOR = Math.pow(10, PUBLIC_COORD_DECIMALS);

/** Round one coordinate to the public precision. Returns null for junk. */
export function toPublicCoord(value) {
  const n = Number(value);
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
