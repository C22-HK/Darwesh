// Darwesh shared public mobile bottom navigation -- the ONE canonical
// bottom nav bar (Home, MAM AI, Properties Map, Sell, Services, Profile)
// for every public content page at mobile widths. Just ONE map item,
// matching js/site-header.js's own consolidation (see that file's header
// comment) -- a bottom tab bar has no room for Buy/Rent as separate icons
// too, and doesn't need them: map.html opens straight into Buy mode by
// default, its own in-page Buy/Rent/All toggle switches modes in one tap,
// and the MAM AI dock on that page understands "show me rentals" just as
// well.
//
// Sell IS its own item, though, and deliberately so: it is not a mode of
// the map, it is a separate funnel (sell.html), and it had no entry point
// anywhere in global navigation before. Five items sat comfortably at
// 390px; MAM AI (mam-ai.html, the Command Center's own dedicated page --
// distinct from the compact MAM assistant that stays present on every
// page unchanged) is the sixth, verified at 390/430px alongside this
// change rather than assumed to still fit.
// Reuses the exact .home-bottomnav / .home-bottomnav-item classes and
// cine-scope design tokens already proven on index.html rather than
// inventing new styling -- see css/cinematic.css's own .home-bottomnav*
// rules (including the safe-area-aware bottom padding added alongside
// this file).
//
// Same classic-script, early-mount-point contract as js/site-header.js
// (see that file's own header comment for the full reasoning): this must
// run BEFORE the later classic <script src="./js/i18n.js"> data-i18n
// walk, and before the deferred `type="module"` js/nav-auth.js runs its
// one-time query for #navProfileLinkMobile -- neither re-scans the DOM
// later, so this has to already be in the DOM before either runs.
//
// Usage, immediately after the site-header mount+script and before any
// other script tag on the page:
//   <div id="siteMobileNav" data-active="propertiesMap"></div>
//   <script src="./js/site-mobile-nav.js"></script>
// `data-active` uses the same keys as js/site-header.js: home, mamai,
// propertiesMap, sell, services -- omit/leave blank for a page with no
// matching destination. There is no separate "profile" key: Profile's
// real destination is decided dynamically by js/nav-auth.js (which page
// a signed-in user actually lands on), so it never shows as "current".
(function () {
  var mount = document.getElementById('siteMobileNav');
  if (!mount) return;
  var active = mount.getAttribute('data-active') || '';

  function itemClass(key) {
    return 'home-bottomnav-item flex flex-col items-center justify-center px-2 py-1 transition-transform duration-300 ease-in-out active:scale-90' +
      (key === active ? ' is-active' : '');
  }
  function ariaCurrent(key) {
    return key === active ? ' aria-current="page"' : '';
  }

  mount.innerHTML =
    '<nav class="home-bottomnav md:hidden fixed bottom-0 left-0 w-full z-50 flex justify-around items-center px-1" aria-label="Primary mobile">' +
      '<a class="' + itemClass('home') + '" href="index.html"' + ariaCurrent('home') + '>' +
        '<span aria-hidden="true"><svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11l9-8 9 8"/><path d="M5 10v10h14V10"/><path d="M9 20v-6h6v6"/></svg></span>' +
        '<span class="font-label-caps text-label-caps mt-1 text-center leading-tight" data-i18n="nav.home">Home</span>' +
      '</a>' +
      '<a class="' + itemClass('mamai') + '" href="mam-ai.html"' + ariaCurrent('mamai') + '>' +
        '<span aria-hidden="true"><svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v3M12 18v3M3 12h3M18 12h3"/><path d="M12 8a4 4 0 0 0 4 4 4 4 0 0 0-4 4 4 4 0 0 0-4-4 4 4 0 0 0 4-4Z"/></svg></span>' +
        '<span class="font-label-caps text-label-caps mt-1 text-center leading-tight" data-i18n="mamai.navLabel">MAM AI</span>' +
      '</a>' +
      '<a class="' + itemClass('propertiesMap') + '" href="map.html"' + ariaCurrent('propertiesMap') + '>' +
        '<span aria-hidden="true"><svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="m9 4-6 3v13l6-3 6 3 6-3V4l-6 3Z"/><path d="M9 4v13M15 7v13"/></svg></span>' +
        '<span class="font-label-caps text-label-caps mt-1 text-center leading-tight" data-i18n="nav.propertiesMap">Properties Map</span>' +
      '</a>' +
      '<a class="' + itemClass('sell') + '" href="sell.html"' + ariaCurrent('sell') + '>' +
        '<span aria-hidden="true"><svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M20.6 13.4 12 22l-9-9 8.6-8.6A2 2 0 0 1 13 4h6a2 2 0 0 1 2 2v6a2 2 0 0 1-.4 1.4Z"/><circle cx="16.5" cy="7.5" r="1"/></svg></span>' +
        '<span class="font-label-caps text-label-caps mt-1 text-center leading-tight" data-i18n="nav.sell">Sell</span>' +
      '</a>' +
      '<a class="' + itemClass('services') + '" href="services.html"' + ariaCurrent('services') + '>' +
        '<span aria-hidden="true"><svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></span>' +
        '<span class="font-label-caps text-label-caps mt-1 text-center leading-tight" data-i18n="nav.services">Services</span>' +
      '</a>' +
      '<a id="navProfileLinkMobile" class="' + itemClass('') + '" href="login.html" aria-label="Profile">' +
        '<span aria-hidden="true"><svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg></span>' +
        '<span id="navProfileLabelMobile" class="font-label-caps text-label-caps mt-1 text-center leading-tight" data-i18n="nav.profile">Profile</span>' +
      '</a>' +
    '</nav>';
})();
