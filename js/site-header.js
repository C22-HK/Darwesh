// Darwesh shared site header -- the ONE canonical top nav bar (flag
// language selector, wordmark, Home / Buy / Rent / Properties Map /
// Services / About / Profile / notifications) for every public
// content page. There is deliberately ONE public property map
// (map.html) -- the earlier "Buy/Rent Map" + "Explore Map" pairing
// competed for the same job and has been consolidated; Buy/Rent are
// now global nav actions that land on that same map already in the
// matching mode (?type=sale / ?type=rent), not separate pages or a
// second map. MAM is not a standalone nav destination -- it lives
// inside this one map (js/mam-properties-map.js) instead, see
// docs/MAM_V2_ARCHITECTURE.md section 21. Before this file existed, every
// page hand-duplicated its
// own <header> markup and they had drifted: different nav link sets,
// different labels, and only some pages had the flag-based language
// selector while others still had a plain globe icon. This is the single
// source of truth going forward.
//
// Deliberately a CLASSIC script, not `type="module"`: it must inject its
// markup into the DOM SYNCHRONOUSLY, before the later classic
// <script src="./js/i18n.js"> tag runs its one-time data-i18n /
// .lang-toggle-btn wiring pass, and before the deferred `type="module"`
// scripts (js/notification-bell.js, js/nav-auth.js) run their own
// one-time querySelectorAll passes over the page -- none of those
// scripts re-scan the DOM later (no MutationObserver), so if this ran
// after them, the header elements they exist to wire up would simply
// never be found. A classic script placed as the FIRST <script> tag in
// <body>, right after the mount point, blocks HTML parsing and runs
// immediately -- guaranteeing every later script (classic or deferred
// module) sees the real header markup already in the DOM, exactly like
// every other page-authored header did before this file existed.
//
// Usage, as the very first thing inside <body>, before any other script
// tag on the page:
//   <div id="siteHeader" data-active="propertiesMap"></div>
//   <script src="./js/site-header.js"></script>
// `data-active` is one of: home, buy, rent, propertiesMap, services, about
// -- omit/leave blank on a page with no matching nav item (e.g.
// mam-ai.html, listing.html), which then highlights nothing as current.
// buy/rent are for buy.html/rent.html specifically (their own separate
// browse pages, distinct from the map) -- map.html itself always
// highlights as propertiesMap regardless of its own ?type= query param,
// since Buy/Rent/Properties Map are three nav entries into that map, not
// three different pages to distinguish by URL.
//
// No dynamic/user-supplied data is ever interpolated into this markup
// (every string here is a fixed literal), so this file has no escaping
// concern.
(function () {
  var mount = document.getElementById('siteHeader');
  if (!mount) return;
  var active = mount.getAttribute('data-active') || '';

  function navClass(key) {
    return key === active
      ? 'font-label-caps text-label-caps text-primary dark:text-primary-fixed-dim font-bold transition-colors'
      : 'font-label-caps text-label-caps text-on-surface-variant dark:text-on-surface-variant hover:text-primary transition-colors';
  }
  function ariaCurrent(key) {
    return key === active ? ' aria-current="page"' : '';
  }

  mount.innerHTML =
    '<header class="fixed top-0 left-0 w-full z-50 flex justify-between items-center px-gutter h-16 bg-surface-bright dark:bg-surface-dim border-b border-outline-variant dark:border-outline">' +
      '<div class="flex items-center gap-4">' +
        '<div class="relative">' +
          '<button aria-label="Language" class="lang-toggle-btn" type="button">' +
            '<span class="lang-current" data-flag-for="en"><img class="lang-flag" src="images/flags/usa.svg" alt="" width="20" height="14">EN</span>' +
            '<span class="lang-current" data-flag-for="ku"><img class="lang-flag" src="images/flags/kurdistan.svg" alt="" width="20" height="14">KU</span>' +
            '<span class="lang-current" data-flag-for="ar"><img class="lang-flag" src="images/flags/iraq.svg" alt="" width="20" height="14">AR</span>' +
          '</button>' +
          '<div class="lang-menu hidden absolute start-0 top-full mt-2 z-50">' +
            '<button class="lang-option" data-lsel data-lang="ku" onclick="setLanguage(\'ku\')" type="button">' +
              '<img class="lang-flag" src="images/flags/kurdistan.svg" alt="" width="20" height="14"><span>کوردی</span>' +
              '<span class="lang-option-check material-symbols-outlined" aria-hidden="true">check</span>' +
            '</button>' +
            '<button class="lang-option" data-lsel data-lang="ar" onclick="setLanguage(\'ar\')" type="button">' +
              '<img class="lang-flag" src="images/flags/iraq.svg" alt="" width="20" height="14"><span>العربية</span>' +
              '<span class="lang-option-check material-symbols-outlined" aria-hidden="true">check</span>' +
            '</button>' +
            '<button class="lang-option" data-lsel data-lang="en" onclick="setLanguage(\'en\')" type="button">' +
              '<img class="lang-flag" src="images/flags/usa.svg" alt="" width="20" height="14"><span>English</span>' +
              '<span class="lang-option-check material-symbols-outlined" aria-hidden="true">check</span>' +
            '</button>' +
          '</div>' +
        '</div>' +
        '<a class="font-headline-md text-headline-md font-bold text-primary dark:text-primary-fixed-dim" href="index.html">Darwesh Group</a>' +
      '</div>' +
      '<nav class="hidden md:flex items-center gap-5" aria-label="Primary">' +
        '<a class="' + navClass('home') + '" href="index.html" data-i18n="nav.home"' + ariaCurrent('home') + '>Home</a>' +
        '<a class="' + navClass('buy') + '" href="map.html?type=sale" data-i18n="nav.buy"' + ariaCurrent('buy') + '>Buy</a>' +
        '<a class="' + navClass('rent') + '" href="map.html?type=rent" data-i18n="nav.rent"' + ariaCurrent('rent') + '>Rent</a>' +
        '<a class="' + navClass('propertiesMap') + '" href="map.html" data-i18n="nav.propertiesMap"' + ariaCurrent('propertiesMap') + '>Properties Map</a>' +
        '<a class="' + navClass('services') + '" href="services.html" data-i18n="nav.services"' + ariaCurrent('services') + '>Services</a>' +
        '<a class="' + navClass('about') + '" href="about.html" data-i18n="nav.about"' + ariaCurrent('about') + '>About</a>' +
        '<a id="navProfileLink" class="' + navClass('profile') + '" href="login.html" data-i18n="nav.profile">Profile</a>' +
      '</nav>' +
      '<button aria-label="Notifications" class="p-2 rounded-full hover:bg-surface-container-high dark:hover:bg-surface-container-highest transition-all duration-200 active:scale-95 text-on-surface-variant dark:text-on-surface-variant" type="button">' +
        '<span class="material-symbols-outlined" aria-hidden="true">notifications</span>' +
      '</button>' +
    '</header>';
})();
