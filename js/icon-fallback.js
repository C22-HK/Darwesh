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
//   ds-icons-failed   it did not, within IconTimeoutMs -- collapse the
//                     ligature text to font-size 0 and draw a small neutral
//                     placeholder square instead (see css/profile-tokens.css).
//
// PROGRESSIVE ENHANCEMENT, deliberately: the "hidden" CSS is scoped to
// .ds-icons-pending, which only this script can set. If this file fails to
// load or JS is disabled, no class is ever added, no rule matches, and the
// page behaves exactly as it did before -- this can never be the reason an
// icon disappears.
(function () {
  var root = document.documentElement;
  var FAMILY = '"Material Symbols Outlined"';
  var TIMEOUT_MS = 3000;

  function settle(loaded) {
    root.classList.remove('ds-icons-pending');
    root.classList.add(loaded ? 'ds-icons-ready' : 'ds-icons-failed');
  }

  // A browser with no CSS Font Loading API can't be asked whether the font
  // arrived. Assume it did rather than permanently placeholder every icon --
  // that matches the pre-existing behaviour for those browsers.
  if (!document.fonts || typeof document.fonts.load !== 'function') {
    root.classList.add('ds-icons-ready');
    return;
  }

  root.classList.add('ds-icons-pending');

  var settled = false;
  function once(loaded) {
    if (settled) return;
    settled = true;
    settle(loaded);
  }

  var timer = setTimeout(function () { once(false); }, TIMEOUT_MS);

  // load() resolves with the FontFace objects that matched. An empty array
  // means the @font-face was never registered (stylesheet blocked); a
  // rejection means the font file itself failed. Both are "failed" here.
  document.fonts.load('24px ' + FAMILY, 'notifications').then(function (faces) {
    clearTimeout(timer);
    once(!!(faces && faces.length));
  }).catch(function () {
    clearTimeout(timer);
    once(false);
  });
})();
