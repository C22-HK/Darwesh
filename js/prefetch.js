// Darwesh Group -- opt-in navigation prefetch.
//
// WHAT THIS DOES, AND THE ONE THING IT DELIBERATELY DOES NOT
// ---------------------------------------------------------
// It warms the DOCUMENT (HTML, CSS, JS) of a likely next page, using the
// browser's own <link rel="prefetch">. It does NOT prefetch Firestore
// data.
//
// That restriction is the whole design. On every page where a card links
// somewhere, the card's own data ALREADY came from a query that page ran
// -- js/data-cache.js seeds it, and the destination paints from that seed
// with no network call at all. Issuing a Firestore read on hover would
// spend a brand-new billed read to fetch a document the browser is
// already holding: strictly more reads, strictly no faster. "Do not
// create excessive Firestore reads" and "prefetch on hover" point in
// opposite directions here, and the seed already collected the win.
//
// What a seed cannot cover is the destination's own HTML/CSS/JS, which on
// a multi-page site must be fetched before anything renders at all. That
// is what this warms, and on a cold link it is the larger cost of the two.
//
// BUDGETS. A grid of 60 cards must not trigger 60 prefetches, so:
//   * at most MAX_PREFETCH distinct documents per page load;
//   * each URL is prefetched at most once (deduplicated by href);
//   * only same-origin URLs, so this can never reach a third party;
//   * nothing at all on a metered connection or with Save-Data set;
//   * viewport prefetching applies only to elements explicitly opted in,
//     never to every link on the page.

const MAX_PREFETCH = 8;
const prefetched = new Set();
let budget = MAX_PREFETCH;

function saveDataOrMetered() {
  const c = navigator.connection;
  if (!c) return false;
  if (c.saveData) return true;
  return c.effectiveType === 'slow-2g' || c.effectiveType === '2g';
}

/** Same-origin only: a prefetch must never reach off this site. */
function sameOriginUrl(href) {
  try {
    const u = new URL(href, window.location.href);
    return u.origin === window.location.origin ? u.href : null;
  } catch {
    return null;
  }
}

/**
 * Warms one destination document. Cheap, idempotent, and budgeted --
 * calling it repeatedly for the same href does nothing after the first.
 */
export function prefetchPage(href) {
  if (budget <= 0 || saveDataOrMetered()) return;
  const url = sameOriginUrl(href);
  if (!url || prefetched.has(url) || url === window.location.href) return;
  prefetched.add(url);
  budget -= 1;
  const link = document.createElement('link');
  link.rel = 'prefetch';
  link.as = 'document';
  link.href = url;
  document.head.appendChild(link);
}

/**
 * Wires prefetch-on-intent to a container, via ONE delegated listener per
 * event rather than a listener per card -- so a grid that re-renders (map
 * filters, buy.html sorting) never accumulates handlers, and cards added
 * later are covered without re-wiring.
 *
 * Intent signals, in the order they fire in real use:
 *   pointerenter  desktop hover -- typically 100-300ms of warning
 *   touchstart    the moment a finger lands, before the tap completes
 *   focusin       keyboard tabbing, which is also the accessible path
 *
 * touchstart is passive: it only reads, never calls preventDefault, so it
 * cannot interfere with scrolling.
 */
export function wirePrefetch(root, selector = 'a[href]') {
  const container = root || document.body;
  if (!container || container.dataset && container.dataset.prefetchWired) return;
  if (container.dataset) container.dataset.prefetchWired = '1';

  const onIntent = (e) => {
    const a = e.target && e.target.closest ? e.target.closest(selector) : null;
    if (a && a.getAttribute('href')) prefetchPage(a.getAttribute('href'));
  };
  container.addEventListener('pointerenter', onIntent, { capture: true, passive: true });
  container.addEventListener('touchstart', onIntent, { capture: true, passive: true });
  container.addEventListener('focusin', onIntent, { passive: true });
}

/**
 * Prefetches a destination when an opted-in element scrolls into view.
 * Applied only to elements the caller passes in, never to every link --
 * "every link in the viewport" on a long grid is exactly the excessive
 * behaviour the budget above exists to prevent.
 */
export function prefetchOnVisible(elements) {
  if (typeof IntersectionObserver !== 'function' || saveDataOrMetered()) return;
  const list = Array.from(elements || []);
  if (!list.length) return;
  const io = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const href = entry.target.getAttribute && entry.target.getAttribute('href');
      if (href) prefetchPage(href);
      io.unobserve(entry.target);
    }
  }, { rootMargin: '200px' });
  list.forEach((el) => io.observe(el));
}
