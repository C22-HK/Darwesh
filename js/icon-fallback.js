// Darwesh Group -- Material Symbols load guard.
//
// THE PROBLEM: every icon on this site is a ligature span --
// `<span class="material-symbols-outlined">notifications</span>`. The word
// inside is only an icon once the Material Symbols font has loaded. Until
// then (or forever, if fonts.googleapis.com is slow or blocked -- a real
// condition for users in Iraq/Kurdistan) the browser renders the raw word,
// so the header reads "expand_more" and the mobile bar reads
// "home map business_center person".
//
// THE FIX, in three states, driven by a class on <html>:
//
//   ds-icons-pending  icons are hidden but still occupy their box, so
//                     nothing reflows when they appear. Set synchronously.
//   ds-icons-ready    the font really loaded -- show the icons.
//   ds-icons-failed   it did not -- collapse the ligature text to font-size
//                     0 and draw a small neutral placeholder square instead
//                     (see css/profile-tokens.css).
//
// ---------------------------------------------------------------------
// TWO BUGS FIXED HERE. Both produced the SAME visible symptom: every icon
// on the page rendered as a small empty rounded square -- the
// ds-icons-failed placeholder -- even though the font was perfectly
// reachable. Reported from the live Properties Map, where the right-side
// controls are icon-only and so the damage was most obvious.
//
// BUG 1 -- the probe ran before the font could possibly be registered.
// This script is a plain <script> in <head>, and on 29 of 31 pages it sits
// BEFORE the <link> that loads the Material Symbols stylesheet. A classic
// script executes when the parser reaches it, so at that moment the
// browser has not yet seen -- let alone fetched and parsed -- the
// stylesheet carrying the @font-face rule. document.fonts.load() matches
// against faces already in the FontFaceSet; with none registered it
// resolves with an EMPTY array, which the old code read as "the font
// failed" and latched permanently. Asking whether a font has loaded before
// the rule that defines it exists can only ever answer "no".
//
// BUG 2 -- the verdict was irreversible. `settled` latched on the first
// answer, so a 3s timeout on a slow connection -- entirely ordinary on
// mobile in the region, and likeliest exactly where this page is heaviest
// (Leaflet + Firebase + Google Maps + a Firestore query all competing) --
// condemned the page to placeholder squares for its whole lifetime, even
// though the font arrived moments later and every icon would have
// rendered.
//
// The fix addresses both: wait until the font could actually be known
// about, and treat "not yet" as provisional rather than final. A page that
// starts in the failed state now RECOVERS the moment the font arrives.
//
// PROGRESSIVE ENHANCEMENT, deliberately: the "hidden" CSS is scoped to
// .ds-icons-pending, which only this script can set. If this file fails to
// load or JS is disabled, no class is ever added, no rule matches, and the
// page behaves exactly as it did before -- this can never be the reason an
// icon disappears.
(function () {
  var root = document.documentElement;
  var FONT_SPEC = '24px "Material Symbols Outlined"';
  // Generous, because being wrong in this direction is cheap: until the
  // timeout the icons are merely invisible (holding their space), whereas
  // a premature "failed" used to be permanent. 3s was too tight for a
  // cold cache on a slow mobile connection.
  var TIMEOUT_MS = 10000;
  // Recovery keeps working well past the timeout, but not forever -- an
  // unbounded listener on a long-lived map session is a leak.
  var GIVE_UP_MS = 30000;

  function setState(name) {
    root.classList.remove('ds-icons-pending', 'ds-icons-ready', 'ds-icons-failed');
    root.classList.add(name);
  }

  // A browser with no CSS Font Loading API can't be asked whether the font
  // arrived. Assume it did rather than permanently placeholder every icon --
  // that matches the pre-existing behaviour for those browsers.
  if (!document.fonts || typeof document.fonts.check !== 'function') {
    root.classList.add('ds-icons-ready');
    return;
  }

  root.classList.add('ds-icons-pending');

  var done = false;      // ready reached -- terminal, nothing left to watch
  var timedOut = false;  // showed placeholders, but still watching

  // check() asks whether the font is loaded AND available for use right
  // now. Unlike load(), it does not kick off a fetch, so calling it
  // repeatedly is free.
  function fontIsAvailable() {
    try {
      return document.fonts.check(FONT_SPEC, 'notifications');
    } catch (err) {
      // A malformed font shorthand would throw; treat as "can't tell" and
      // let the timeout decide rather than crashing the page.
      return false;
    }
  }

  function succeed() {
    if (done) return;
    done = true;
    setState('ds-icons-ready');   // also recovers from ds-icons-failed
    cleanup();
  }

  function onLoadingDone() { if (fontIsAvailable()) succeed(); }

  function cleanup() {
    try { document.fonts.removeEventListener('loadingdone', onLoadingDone); } catch (err) { /* older engines */ }
    clearTimeout(timeoutTimer);
    clearTimeout(giveUpTimer);
  }

  // Every signal that the font set may have changed feeds the same check,
  // so whichever fires first wins and the rest are harmless.
  try { document.fonts.addEventListener('loadingdone', onLoadingDone); } catch (err) { /* older engines */ }

  // fonts.ready resolves once the document's pending font loads settle. It
  // can resolve BEFORE the stylesheet is parsed (bug 1), so it is treated
  // as one hint among several, never as the final word.
  if (document.fonts.ready && typeof document.fonts.ready.then === 'function') {
    document.fonts.ready.then(function () { if (fontIsAvailable()) succeed(); });
  }

  // The decisive fix for bug 1: explicitly request the family only once the
  // stylesheet has actually had a chance to register it. Requesting it also
  // triggers the fetch on browsers that lazily load unused faces -- these
  // are ligature spans, and the text is present, so this is not a
  // speculative download.
  function requestFont() {
    if (done || typeof document.fonts.load !== 'function') return;
    document.fonts.load(FONT_SPEC, 'notifications').then(function () {
      if (fontIsAvailable()) succeed();
    }).catch(function () { /* the timeout path handles this */ });
  }

  if (document.readyState === 'complete') {
    requestFont();
  } else {
    // 'load' rather than DOMContentLoaded: stylesheets are guaranteed
    // fetched and applied by load, which is precisely the condition bug 1
    // violated.
    window.addEventListener('load', requestFont, { once: true });
    // A cheap earlier attempt too, so a warm cache shows icons without
    // waiting for every image on the page.
    document.addEventListener('DOMContentLoaded', function () {
      if (fontIsAvailable()) succeed(); else requestFont();
    }, { once: true });
  }

  // Provisional, NOT final: placeholders appear so the UI is not blank,
  // and the listeners above stay live so a late arrival still recovers.
  var timeoutTimer = setTimeout(function () {
    if (done) return;
    timedOut = true;
    if (fontIsAvailable()) { succeed(); return; }
    setState('ds-icons-failed');
  }, TIMEOUT_MS);

  var giveUpTimer = setTimeout(function () {
    if (done) return;
    if (fontIsAvailable()) succeed();
    else { if (!timedOut) setState('ds-icons-failed'); cleanup(); }
  }, GIVE_UP_MS);
})();
