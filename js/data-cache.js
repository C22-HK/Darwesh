// Darwesh Group -- shared client data cache, request deduplication, and
// stale-while-revalidate seeding.
//
// WHY THIS EXISTS
// ---------------
// Every page in this site is a separate HTML document; there is no SPA
// router. So a click from buy.html to listing.html is a full navigation
// and every in-memory JS structure dies with it -- even though buy.html
// had ALREADY downloaded the exact listing document that listing.html is
// about to re-fetch. That round trip is pure waste, and it is what makes
// a click feel slow: the destination page renders a skeleton and waits
// on a network request for data the browser held one moment earlier.
//
// The fix here is deliberately NOT "prefetch on hover". Hover-prefetching
// listings/{id} would spend a NEW Firestore read for a document the
// listing grid already has in hand -- more reads, more cost, no better
// result. Instead the grid pages SEED what they already downloaded, and
// the detail page renders from that seed at once and revalidates in the
// background. Zero additional reads; the instant paint is free.
//
// SECURITY INVARIANT -- read before adding a collection here.
// ----------------------------------------------------------
// A seed is written to sessionStorage, which is readable by any script on
// this origin and survives until the tab closes. Only data that is
// ALREADY world-readable may ever be seeded. Three structural guards
// enforce that, in isSeedablePath():
//
//   1. An allowlist of collections whose documents are `allow read: if
//      true` in firestore.rules. Nothing else is seedable, ever.
//   2. Exactly two path segments -- `collection/docId`. A subcollection
//      cannot be expressed in two segments, so listings/{id}/private/
//      location (LOC-01's exact coordinates) and serviceProviders/{id}/
//      private/contact (Phase 3A's real phone number) are structurally
//      unreachable by this module. Not "we remembered not to seed them"
//      -- they cannot be named.
//   3. users/ is refused explicitly even though it is not on the
//      allowlist, so that adding it later takes a deliberate edit past a
//      comment saying not to.
//
// The public listing document carries only publicLat/publicLng, already
// rounded to a ~600m grid by LOC-01. Seeding it exposes nothing that
// buy.html did not already render on screen.
//
// This module NEVER changes what a caller is allowed to read. Firestore
// rules remain the only authority; a cache hit is just a copy of a
// document the server already agreed to hand this client.

// SEED FORMAT HAZARD -- read before consuming a seed.
// -----------------------------------------------------
// A seed round-trips through JSON, so Firestore's own classes do NOT
// survive it. A Timestamp comes back as a plain { seconds, nanoseconds }
// object and a GeoPoint as a plain { latitude, longitude }; neither has
// its prototype, so .toMillis(), .toDate() and .isEqual() are gone.
//
// That means a render function driven by swrDoc() is called with a plain
// object on the cache path and a real Firestore object on the server
// path, and it must work with both. Reading `.seconds` directly is fine
// (identical either way); calling a Timestamp METHOD is not, and will
// throw on the cached first paint only -- a bug that hides completely in
// any test that skips the cache.
//
// If you need a Timestamp method on a value that may be seeded, guard it
// the way map.html already does:
//     typeof v.toMillis === 'function' ? v.toMillis() : (v.seconds * 1000)
// Verified at the time of writing: listing.html, the only swrDoc()
// consumer, calls no Timestamp method on listing data at all.
const SEED_KEY_PREFIX = 'dw:seed:';

// 5 minutes. Long enough that a browse -> open -> back -> open-another
// session is all instant, short enough that a price edit surfaces on the
// next visit even if the revalidation fetch fails. A seed is never the
// final word regardless: every consumer revalidates against the server
// and re-renders on a real change.
export const DEFAULT_SEED_TTL_MS = 5 * 60 * 1000;

// Collections whose documents are publicly readable. Mirrors
// firestore.rules. Adding one means re-checking that its rule really is
// `allow read: if true` for the shape being seeded.
const SEEDABLE_COLLECTIONS = ['listings', 'serviceProviders', 'companies', 'professionalPosts'];

/**
 * The one gate on what may be cached to sessionStorage. See the security
 * invariant above -- this is the enforcement point for all three guards.
 */
export function isSeedablePath(path) {
  if (typeof path !== 'string' || !path) return false;
  const parts = path.split('/');
  // Guard 2: exactly collection/docId. Blocks every subcollection,
  // including /private/ ones, by construction rather than by blocklist.
  if (parts.length !== 2) return false;
  if (!parts[0] || !parts[1]) return false;
  // Guard 3: personal documents are never seeded, allowlist or not.
  if (parts[0] === 'users') return false;
  // Guard 1.
  return SEEDABLE_COLLECTIONS.includes(parts[0]);
}

// ---------------------------------------------------------------------
// Seed store (survives navigation, per-tab)
// ---------------------------------------------------------------------

// In-memory mirror so repeated reads within one page never pay the
// sessionStorage JSON.parse cost.
const memory = new Map();

function safeSessionStorage() {
  // A private window, a storage-disabled browser, or a quota failure must
  // degrade to "no seed", never throw into a render path.
  try {
    if (typeof sessionStorage === 'undefined') return null;
    return sessionStorage;
  } catch {
    return null;
  }
}

/**
 * Records a publicly-readable document so a later page can paint it
 * instantly. Silently ignores anything isSeedablePath() refuses -- a
 * caller passing a private path gets no cache, not an exception, so a
 * mistake degrades to today's behaviour rather than breaking a page.
 */
export function seedDoc(path, data) {
  if (!isSeedablePath(path) || !data || typeof data !== 'object') return;
  const entry = { t: Date.now(), d: data };
  memory.set(path, entry);
  const store = safeSessionStorage();
  if (!store) return;
  try {
    store.setItem(SEED_KEY_PREFIX + path, JSON.stringify(entry));
  } catch {
    // Quota exceeded. The in-memory copy still serves this page; the
    // next page simply falls back to a network read. Not worth evicting
    // other entries over.
  }
}

/** Seeds every document of a query snapshot in one pass. Zero extra reads. */
export function seedQuerySnapshot(collectionName, snap) {
  if (!snap || typeof snap.forEach !== 'function') return;
  snap.forEach((d) => seedDoc(`${collectionName}/${d.id}`, d.data()));
}

/**
 * Returns { data, ageMs } for a fresh-enough seed, else null.
 * Callers render this immediately and then revalidate.
 */
export function readSeed(path, ttlMs = DEFAULT_SEED_TTL_MS) {
  if (!isSeedablePath(path)) return null;
  let entry = memory.get(path);
  if (!entry) {
    const store = safeSessionStorage();
    if (!store) return null;
    try {
      const raw = store.getItem(SEED_KEY_PREFIX + path);
      if (!raw) return null;
      entry = JSON.parse(raw);
      if (!entry || typeof entry.t !== 'number' || !entry.d) return null;
      memory.set(path, entry);
    } catch {
      return null;
    }
  }
  const ageMs = Date.now() - entry.t;
  if (ageMs > ttlMs) return null;
  return { data: entry.d, ageMs };
}

/** Drops a seed after a write, so the next read cannot paint stale data. */
export function invalidateSeed(path) {
  memory.delete(path);
  const store = safeSessionStorage();
  if (!store) return;
  try {
    store.removeItem(SEED_KEY_PREFIX + path);
  } catch {
    /* nothing useful to do */
  }
}

/** Clears every seed. Called on sign-out so nothing survives into the next session. */
export function clearAllSeeds() {
  memory.clear();
  const store = safeSessionStorage();
  if (!store) return;
  try {
    const doomed = [];
    for (let i = 0; i < store.length; i++) {
      const k = store.key(i);
      if (k && k.startsWith(SEED_KEY_PREFIX)) doomed.push(k);
    }
    doomed.forEach((k) => store.removeItem(k));
  } catch {
    /* nothing useful to do */
  }
}

// ---------------------------------------------------------------------
// Change detection
// ---------------------------------------------------------------------

// Firestore Timestamps, GeoPoints and nested maps do not survive
// JSON.stringify comparison reliably (key order is insertion order, and
// a Timestamp stringifies to {seconds,nanoseconds} either way), so this
// walks the structure instead. Used to answer exactly one question: did
// the revalidation actually change anything the UI would show? If not,
// the caller must NOT re-render -- a needless re-render is a visible
// flicker and undoes the instant-feel this module exists for.
export function shallowChanged(a, b) {
  if (a === b) return false;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return a !== b;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return true;
  for (const k of ka) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return true;
    const va = a[k];
    const vb = b[k];
    if (va === vb) continue;
    // Firestore Timestamp / any object exposing toMillis().
    if (va && vb && typeof va.toMillis === 'function' && typeof vb.toMillis === 'function') {
      if (va.toMillis() !== vb.toMillis()) return true;
      continue;
    }
    if (va && vb && typeof va === 'object' && typeof vb === 'object') {
      if (shallowChanged(va, vb)) return true;
      continue;
    }
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------
// In-flight request deduplication
// ---------------------------------------------------------------------
//
// Two concurrent callers asking for the same thing share one network
// request and one Promise. index.html demonstrated why this matters: its
// city-counts loader and its featured-listings loader fired the IDENTICAL
// unbounded `listings where private==false and status==active` query at
// the same moment on every single page load, downloading the whole active
// collection twice.
//
// Entries are removed as soon as the request settles, so this is a
// concurrency dedupe, not a result cache -- a later call still goes to
// the network and still sees fresh data. That keeps it safe to apply
// blanket-wide to reads whose freshness other code may depend on.

const inflightDocs = new Map();

export function dedupeDocRequest(path, run) {
  if (!path) return run();
  const existing = inflightDocs.get(path);
  if (existing) return existing;
  const p = run().finally(() => {
    if (inflightDocs.get(path) === p) inflightDocs.delete(path);
  });
  inflightDocs.set(path, p);
  return p;
}

// Queries have no public serializable identity, so instead of reaching
// into SDK internals (which would break on a CDN version bump) this keeps
// a short list and compares with the SDK's own public queryEqual(). The
// list only ever holds queries currently in flight -- in practice one or
// two -- so the linear scan is cheaper than building a key would be.
const inflightQueries = [];

export function dedupeQueryRequest(queryObj, queryEqual, run) {
  if (!queryObj || typeof queryEqual !== 'function') return run();
  for (const entry of inflightQueries) {
    try {
      if (queryEqual(entry.q, queryObj)) return entry.p;
    } catch {
      // A non-Query argument, or a future SDK that throws on mismatched
      // types: fall through and just issue the request.
    }
  }
  const entry = { q: queryObj, p: null };
  entry.p = run().finally(() => {
    const i = inflightQueries.indexOf(entry);
    if (i !== -1) inflightQueries.splice(i, 1);
  });
  inflightQueries.push(entry);
  return entry.p;
}

// ---------------------------------------------------------------------
// Stale-while-revalidate helper
// ---------------------------------------------------------------------

/**
 * The canonical instant-paint pattern for a detail page.
 *
 *   1. If a fresh seed exists, call render(data, 'cache') SYNCHRONOUSLY --
 *      before any await -- so the first paint costs no network at all.
 *   2. Fetch from the server regardless.
 *   3. Call render(data, 'server') only if the data actually differs.
 *
 * onMiss() runs when there was no seed, which is the only case where a
 * skeleton should ever appear.
 *
 * Returns the fetched document data (or null if it does not exist), so a
 * caller can continue its own flow on the authoritative value.
 */
export async function swrDoc({ path, fetchDoc, render, onMiss, onError, ttlMs = DEFAULT_SEED_TTL_MS }) {
  let painted = null;
  const seed = readSeed(path, ttlMs);
  if (seed) {
    painted = seed.data;
    try {
      render(seed.data, 'cache');
    } catch (err) {
      console.error('[data-cache] cached render failed', err);
      painted = null;
    }
  }
  if (!painted && typeof onMiss === 'function') onMiss();

  try {
    const fresh = await fetchDoc();
    if (fresh === null || fresh === undefined) {
      invalidateSeed(path);
      return null;
    }
    seedDoc(path, fresh);
    if (!painted || shallowChanged(painted, fresh)) render(fresh, 'server');
    return fresh;
  } catch (err) {
    // A failed revalidation must not blank out content already on screen.
    // With nothing painted, the caller's error path is the honest answer.
    if (!painted && typeof onError === 'function') onError(err);
    return painted;
  }
}
