// Darwesh shared public mobile bottom navigation -- the ONE canonical
// bottom nav bar (Home, Properties Map, Sell, Services, Profile) for every
// public content page at mobile widths. Just ONE map item, matching
// js/site-header.js's own consolidation (see that file's header comment)
// -- a bottom tab bar has no room for Buy/Rent as separate icons too, and
// doesn't need them: map.html opens straight into Buy mode by default,
// its own in-page Buy/Rent/All toggle switches modes in one tap, and the
// MAM AI dock on that page understands "show me rentals" just as well.
//
// Sell IS its own item, though, and deliberately so: it is not a mode of
// the map, it is a separate funnel (sell.html), and it had no entry point
// anywhere in global navigation before. Five items still sit comfortably
// at 390px; Buy/Rent as two more would not, which is why they stay with
// the map where the in-page toggle already covers them.
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
// `data-active` uses the same keys as js/site-header.js: home,
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
        '<span class="material-symbols-outlined" aria-hidden="true">home</span>' +
        '<span class="font-label-caps text-label-caps mt-1 text-center leading-tight" data-i18n="nav.home">Home</span>' +
      '</a>' +
      '<a class="' + itemClass('propertiesMap') + '" href="map.html"' + ariaCurrent('propertiesMap') + '>' +
        '<span class="material-symbols-outlined" aria-hidden="true">map</span>' +
        '<span class="font-label-caps text-label-caps mt-1 text-center leading-tight" data-i18n="nav.propertiesMap">Properties Map</span>' +
      '</a>' +
      '<a class="' + itemClass('sell') + '" href="sell.html"' + ariaCurrent('sell') + '>' +
        '<span class="material-symbols-outlined" aria-hidden="true">sell</span>' +
        '<span class="font-label-caps text-label-caps mt-1 text-center leading-tight" data-i18n="nav.sell">Sell</span>' +
      '</a>' +
      '<a class="' + itemClass('services') + '" href="services.html"' + ariaCurrent('services') + '>' +
        '<span class="material-symbols-outlined" aria-hidden="true">business_center</span>' +
        '<span class="font-label-caps text-label-caps mt-1 text-center leading-tight" data-i18n="nav.services">Services</span>' +
      '</a>' +
      '<a id="navProfileLinkMobile" class="' + itemClass('') + '" href="login.html" aria-label="Profile">' +
        '<span class="material-symbols-outlined" aria-hidden="true">person</span>' +
        '<span id="navProfileLabelMobile" class="font-label-caps text-label-caps mt-1 text-center leading-tight" data-i18n="nav.profile">Profile</span>' +
      '</a>' +
    '</nav>';
})();
