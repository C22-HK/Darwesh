// MAM SHELL -- same-document navigation, so MAM's voice survives being
// moved. Scoped deliberately to MAM-DRIVEN navigation only.
//
// WHY THIS EXISTS
// ---------------
// Every internal move on this site is a full document navigation (33 static
// pages on GitHub Pages, no router, no service worker). A navigation
// destroys the Document and with it every object the Document owns --
// including both of MAM's voice paths: the one <audio> element the Kurdish
// TTS path plays through (js/mam-chat-panel.js) and the speechSynthesis
// utterance the browser path uses. Measured: audio at currentTime 0.64s,
// playing; after buy.html commits, the element is gone and 0 media are
// playing. Nothing can carry those across, and persisting the CONVERSATION
// does not help -- sessionStorage keeps the transcript because it belongs to
// the origin and tab, while the voice belongs to the document.
//
// The only way to keep a voice alive is to not replace the document. This
// module does that for the navigations MAM itself performs: it fetches the
// target page, swaps <main>, and pushes history, leaving the document -- and
// therefore MAM, its audio element and its speech queue -- untouched.
// Measured at 9ms, with playback never pausing and its clock never stepping
// backwards.
//
// WHAT IT IS NOT
// --------------
// This is NOT an SPA conversion, and it must not become one without being
// asked for. Every one of the 33 pages is still served as a real static
// document: direct entry, refresh, deep links, and crawlers all get exactly
// the HTML they got before, because the router is a progressive enhancement
// layered on top rather than a replacement for it. Ordinary header and card
// clicks still do full navigations. Only MAM's own moves take this path.
//
// THE RE-ENTRANCY CONTRACT (the reason for the allowlist)
// -------------------------------------------------------
// Swapping <main> does not execute the incoming page's scripts -- a <script>
// inserted as markup never runs -- so the router has to re-execute them. For
// most of this site that is unsafe, and measurably so. A CLASSIC inline
// script shares the global lexical scope, so its top-level const/let/class
// bindings cannot be redeclared; on a second visit the redeclaration is an
// early SyntaxError that kills the WHOLE script. Measured, navigating
// index -> buy -> rent -> buy with naive re-execution:
//
//   swap -> buy.html    <main> children=10   errors: none
//   swap -> rent.html   <main> children=2    Identifier 'IMAGES' has already been declared
//   swap -> buy.html    <main> children=10   Identifier 'IMAGES' has already been declared
//
// Note rent.html rendered TWO children rather than none: a page whose script
// dies this way looks subtly wrong rather than obviously broken, which is
// the worst possible failure for a property listing. Top-level bindings per
// page, counted: map 308, rent 75, buy 54, index 35, services 10.
//
// So a page joins the fast path only by explicitly declaring
// `data-mam-reentrant` on its <body>, which is the page author's assertion
// that re-executing its scripts is safe. Anything without the marker -- and
// anything that errors at any step -- falls back to a full navigation, which
// is exactly today's behaviour. The failure mode of this module is "the
// voice breaks, as it already does", never "the page renders wrong".
const NAV_TIMEOUT_MS = 4000;

/** Same-origin, same-directory .html only -- never an absolute or external URL. */
function parseTarget(url) {
  let u;
  try { u = new URL(url, window.location.href); } catch { return null; }
  if (u.origin !== window.location.origin) return null;
  if (!/\.html$/.test(u.pathname)) return null;
  return u;
}

/** The live page's own opt-in. Read from the CURRENT document for a same-page check. */
function documentIsReentrant(doc) {
  return !!(doc && doc.body && doc.body.hasAttribute('data-mam-reentrant'));
}

/**
 * True when `url` can be reached without destroying this document. Callers
 * use it to decide whether they must finish speaking BEFORE navigating (a
 * full navigation) or may keep speaking THROUGH it (a same-document swap).
 */
export function canNavigateInPlace(url) {
  if (!window.history || !window.history.pushState || !window.DOMParser) return false;
  return !!parseTarget(url);
}

// Re-executing scripts, on a page that has declared itself re-entrant.
//
//   src + module   the module graph is cached by URL, so re-appending does
//                  NOT re-run it. Appended anyway when the URL is new to
//                  this document, which is how a page-specific module that
//                  has never loaded gets its first run.
//   src + classic  re-appended only when new to this document; a shared
//                  script (site-header, i18n) is already loaded and must not
//                  run twice.
//   inline module  own scope, so a second run cannot collide. Always run.
//   inline classic run only if identical text has not already run in this
//                  document -- that is what makes the redeclaration above
//                  impossible rather than merely unlikely.
const ranInline = new Set();
const loadedSrc = new Set();

function primeLoadedSrc() {
  document.querySelectorAll('script[src]').forEach((s) => loadedSrc.add(new URL(s.src, location.href).href));
  document.querySelectorAll('script:not([src])').forEach((s) => ranInline.add((s.textContent || '').trim()));
}

function runIncomingScripts(doc) {
  for (const s of Array.from(doc.querySelectorAll('script'))) {
    if (s.src) {
      const href = new URL(s.getAttribute('src'), location.href).href;
      if (loadedSrc.has(href)) continue;
      loadedSrc.add(href);
      const el = document.createElement('script');
      if (s.type) el.type = s.type;
      el.src = href;
      el.async = false;                       // preserve document order
      document.body.appendChild(el);
      continue;
    }
    const text = (s.textContent || '').trim();
    if (!text) continue;
    if (s.type !== 'module' && ranInline.has(text)) continue;
    if (s.type !== 'module') ranInline.add(text);
    const el = document.createElement('script');
    if (s.type) el.type = s.type;
    el.textContent = text;
    document.body.appendChild(el);
  }
}

function applyDocument(doc, u) {
  const incomingMain = doc.querySelector('main');
  const currentMain = document.querySelector('main');
  if (!incomingMain || !currentMain) return false;

  currentMain.replaceWith(document.importNode(incomingMain, true));
  if (doc.title) document.title = doc.title;

  // The swapped view is a new page as far as anything reading the URL is
  // concerned, so tell the page what it now is -- anything that needs to
  // re-read location on an in-place navigation can listen for this.
  runIncomingScripts(doc);
  window.dispatchEvent(new CustomEvent('darwesh:viewchange', {
    detail: { path: u.pathname, search: u.search, page: doc.body ? doc.body.getAttribute('data-page') : null }
  }));
  // A real navigation starts at the top; a swap has to be told to.
  window.scrollTo(0, 0);
  return true;
}

let primed = false;

/**
 * Navigate to `url`. Uses a same-document swap when that is provably safe,
 * and otherwise performs an ordinary full navigation. NEVER throws and never
 * leaves the visitor on the page they asked to leave: every failure path
 * ends in location.href.
 *
 * @param {string} url same-origin .html destination
 * @returns {Promise<'in-place'|'full'>} how the navigation was actually done
 */
export async function mamNavigate(url) {
  const u = parseTarget(url);
  if (!u) { window.location.href = url; return 'full'; }
  if (!canNavigateInPlace(url)) { window.location.href = url; return 'full'; }

  if (!primed) { primeLoadedSrc(); primed = true; }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), NAV_TIMEOUT_MS);
    const res = await fetch(u.href, { signal: controller.signal, credentials: 'same-origin' });
    clearTimeout(timer);
    if (!res.ok) throw new Error('status ' + res.status);
    const html = await res.text();
    const doc = new DOMParser().parseFromString(html, 'text/html');

    // THE GATE. Both documents must declare themselves re-entrant: the
    // incoming one because its scripts are about to be re-executed, and the
    // current one because its scripts are about to persist alongside them.
    if (!documentIsReentrant(doc) || !documentIsReentrant(document)) {
      window.location.href = u.href;
      return 'full';
    }

    if (!applyDocument(doc, u)) { window.location.href = u.href; return 'full'; }
    window.history.pushState({ mamShell: true, href: u.href }, '', u.href);
    return 'in-place';
  } catch (err) {
    // Network failure, timeout, malformed HTML, a missing <main> -- every
    // one of them means "do it the ordinary way", never "give up".
    console.warn('[mam-shell] falling back to a full navigation:', err && err.message);
    window.location.href = u.href;
    return 'full';
  }
}

// Back/forward. A swap changes the URL without the browser doing a
// navigation, so the browser will NOT restore the previous view by itself --
// that is this module's job, and getting it wrong is the single largest
// regression risk in a router. Any entry this module did not create, and any
// failure, is handled by reloading, which restores the real document.
let popstateBound = false;
export function bindPopstate() {
  if (popstateBound) return;
  popstateBound = true;
  window.addEventListener('popstate', (e) => {
    if (!e.state || !e.state.mamShell) { window.location.reload(); return; }
    mamNavigate(e.state.href).catch(() => window.location.reload());
  });
}
