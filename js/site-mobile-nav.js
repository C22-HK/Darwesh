// Darwesh shared public mobile bottom navigation -- the ONE canonical
// bottom nav bar (Home, Buy/Rent Map, Explore Map, Services, Profile) for
// every public content page at mobile widths. Reuses the exact
// .home-bottomnav / .home-bottomnav-item classes and cine-scope design
// tokens already proven on index.html rather than inventing new styling
// -- see css/cinematic.css's own .home-bottomnav* rules (including the
// safe-area-aware bottom padding added alongside this file).
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
//   <div id="siteMobileNav" data-active="buyRentMap"></div>
//   <script src="./js/site-mobile-nav.js"></script>
// `data-active` uses the same keys as js/site-header.js: home,
// buyRentMap, exploreMap, services -- omit/leave blank for a page with no
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
      '<a class="' + itemClass('buyRentMap') + '" href="buy-rent-map.html"' + ariaCurrent('buyRentMap') + '>' +
        '<span class="material-symbols-outlined" aria-hidden="true">map</span>' +
        '<span class="font-label-caps text-label-caps mt-1 text-center leading-tight" data-i18n="drm.navLabel">Buy/Rent Map</span>' +
      '</a>' +
      '<a class="' + itemClass('exploreMap') + '" href="map.html"' + ariaCurrent('exploreMap') + '>' +
        '<span class="material-symbols-outlined" aria-hidden="true">travel_explore</span>' +
        '<span class="font-label-caps text-label-caps mt-1 text-center leading-tight" data-i18n="nav.exploreMap">Explore Map</span>' +
      '</a>' +
      '<a class="' + itemClass('services') + '" href="services.html"' + ariaCurrent('services') + '>' +
        '<span class="material-symbols-outlined" aria-hidden="true">business_center</span>' +
        '<span class="font-label-caps text-label-caps mt-1 text-center leading-tight" data-i18n="nav.services">Services</span>' +
      '</a>' +
      '<a id="navProfileLinkMobile" class="' + itemClass('') + '" href="login.html" aria-label="Profile">' +
        '<span class="material-symbols-outlined" aria-hidden="true">person</span>' +
        '<span id="navProfileLabelMobile" class="font-label-caps text-label-caps mt-1 text-center leading-tight">Profile</span>' +
      '</a>' +
    '</nav>';
})();
