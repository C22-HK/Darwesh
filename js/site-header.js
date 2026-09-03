// Darwesh shared site header -- the ONE canonical top nav bar (flag
// language selector, wordmark, Home / Properties Map / Services / About /
// Profile / notifications) for every public content page. There is
// deliberately ONE public property map (map.html) -- the earlier
// "Buy/Rent Map" + "Explore Map" pairing competed for the same job and
// was consolidated into one "Properties Map" link; a follow-up pass then
// found that having Buy/Rent ALSO sit next to it as their own top-level
// items recreated the same "three destinations" impression one level up
// (three labels, one underlying page). Buy/Rent are now a small dropdown
// hung off the Properties Map item itself (nav-map-toggle-btn/
// nav-map-menu, same open/close/keyboard-nav shape as the language
// selector's lang-toggle-btn/lang-menu, just not sharing its class names
// since this is a different menu, not another language surface) -- there
// is exactly one clickable nav LABEL for the map, with Buy/Rent reachable
// as its two modes, never a second or third label. MAM is not a
// standalone nav destination -- it lives inside this one map
// (js/mam-properties-map.js) instead, see docs/MAM_V2_ARCHITECTURE.md
// section 21. Before this file existed, every page hand-duplicated its
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
// `data-active` is one of: home, propertiesMap, services, about -- omit/
// leave blank on a page with no matching nav item (e.g. a detail page,
// listing.html), which then highlights nothing as current. map.html
// itself always highlights as propertiesMap regardless of its own
// ?type= query param -- Buy and Rent are modes of that one page, not
// separate pages, so there is nothing else to distinguish by URL.
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
        '<div class="relative flex items-center gap-0.5">' +
          '<a class="' + navClass('propertiesMap') + '" href="map.html" data-i18n="nav.propertiesMap"' + ariaCurrent('propertiesMap') + '>Properties Map</a>' +
          '<button class="nav-map-toggle-btn flex items-center p-0.5 rounded ' + (active === 'propertiesMap' ? 'text-primary dark:text-primary-fixed-dim' : 'text-on-surface-variant dark:text-on-surface-variant hover:text-primary') + ' transition-colors" type="button" aria-label="Buy or rent">' +
            '<span class="material-symbols-outlined text-[18px]" aria-hidden="true">expand_more</span>' +
          '</button>' +
          '<div class="nav-map-menu hidden absolute start-0 top-full mt-2 z-50 min-w-[140px] bg-surface-bright dark:bg-surface-dim border border-outline-variant dark:border-outline rounded-xl shadow-lg py-1">' +
            '<a class="nav-map-option block px-4 py-2 font-label-caps text-label-caps text-on-surface hover:bg-surface-container-high dark:hover:bg-surface-container-highest transition-colors" href="map.html?type=sale" data-i18n="nav.buy">Buy</a>' +
            '<a class="nav-map-option block px-4 py-2 font-label-caps text-label-caps text-on-surface hover:bg-surface-container-high dark:hover:bg-surface-container-highest transition-colors" href="map.html?type=rent" data-i18n="nav.rent">Rent</a>' +
          '</div>' +
        '</div>' +
        // Sell is a top-level destination, not a map mode. Buy and Rent are
        // two views of map.html (see the dropdown above), but selling starts
        // a different funnel entirely -- sell.html -- and until now that
        // 1900-line funnel had no entry point in the global nav at all.
        '<a class="' + navClass('sell') + '" href="sell.html" data-i18n="nav.sell"' + ariaCurrent('sell') + '>Sell</a>' +
        '<a class="' + navClass('services') + '" href="services.html" data-i18n="nav.services"' + ariaCurrent('services') + '>Services</a>' +
        '<a class="' + navClass('about') + '" href="about.html" data-i18n="nav.about"' + ariaCurrent('about') + '>About</a>' +
        '<a id="navProfileLink" class="' + navClass('profile') + '" href="login.html" data-i18n="nav.profile">Profile</a>' +
      '</nav>' +
      '<button aria-label="Notifications" class="p-2 rounded-full hover:bg-surface-container-high dark:hover:bg-surface-container-highest transition-all duration-200 active:scale-95 text-on-surface-variant dark:text-on-surface-variant" type="button">' +
        '<span class="material-symbols-outlined" aria-hidden="true">notifications</span>' +
      '</button>' +
    '</header>';

  // Buy/Rent dropdown wiring -- deliberately its own small implementation
  // (own class names, own listeners) rather than reusing js/i18n.js's
  // .lang-toggle-btn/.lang-menu wiring: that pair is specifically the
  // language switcher (window.setLanguage() closes every .lang-menu on
  // language change), and this is an unrelated menu -- reusing its class
  // names would work by accident today but read as "this is a language
  // control" to the next person searching the codebase. Same open/close/
  // keyboard-nav shape by design, just not the same implementation.
  var mapToggleBtn = mount.querySelector('.nav-map-toggle-btn');
  var mapMenu = mount.querySelector('.nav-map-menu');
  if (mapToggleBtn && mapMenu) {
    mapToggleBtn.setAttribute('aria-haspopup', 'menu');
    mapToggleBtn.setAttribute('aria-expanded', 'false');
    mapMenu.setAttribute('role', 'menu');
    var mapOptions = Array.prototype.slice.call(mapMenu.querySelectorAll('.nav-map-option'));
    mapOptions.forEach(function (opt) { opt.setAttribute('role', 'menuitem'); });

    var closeMapMenu = function (focusTrigger) {
      mapMenu.classList.add('hidden');
      mapToggleBtn.setAttribute('aria-expanded', 'false');
      if (focusTrigger) mapToggleBtn.focus();
    };
    var openMapMenu = function () {
      mapMenu.classList.remove('hidden');
      mapToggleBtn.setAttribute('aria-expanded', 'true');
      (mapOptions[0] || mapToggleBtn).focus();
    };

    mapToggleBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      if (mapMenu.classList.contains('hidden')) openMapMenu(); else closeMapMenu(false);
    });
    mapMenu.addEventListener('keydown', function (e) {
      var i = mapOptions.indexOf(document.activeElement);
      if (e.key === 'Escape') { e.preventDefault(); closeMapMenu(true); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); mapOptions[(i + 1 + mapOptions.length) % mapOptions.length].focus(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); mapOptions[(i - 1 + mapOptions.length) % mapOptions.length].focus(); }
    });
    mapMenu.addEventListener('focusout', function () {
      requestAnimationFrame(function () {
        if (!mapMenu.contains(document.activeElement) && document.activeElement !== mapToggleBtn) closeMapMenu(false);
      });
    });
    document.addEventListener('click', function () { closeMapMenu(false); });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !mapMenu.classList.contains('hidden')) closeMapMenu(false);
    });
  }
})();
