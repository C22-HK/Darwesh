// Darwesh shared site header -- the ONE canonical top nav bar (flag
// language selector, wordmark, Home / Buy-Rent Map / Explore Map /
// Services / About / Profile / MAM AI / notifications) for every public
// content page. Before this file existed, every page hand-duplicated its
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
//   <div id="siteHeader" data-active="buyRentMap"></div>
//   <script src="./js/site-header.js"></script>
// `data-active` is one of: home, buyRentMap, exploreMap, services, about
// -- omit/leave blank on a page with no matching nav item (e.g.
// mam-ai.html, listing.html), which then highlights nothing as current.
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
      '<nav class="hidden md:flex items-center gap-6" aria-label="Primary">' +
        '<a class="' + navClass('home') + '" href="index.html" data-i18n="nav.home"' + ariaCurrent('home') + '>Home</a>' +
        '<a class="' + navClass('buyRentMap') + '" href="buy-rent-map.html" data-i18n="drm.navLabel"' + ariaCurrent('buyRentMap') + '>Buy/Rent Map</a>' +
        '<a class="' + navClass('exploreMap') + '" href="map.html" data-i18n="nav.exploreMap"' + ariaCurrent('exploreMap') + '>Explore Map</a>' +
        '<a class="' + navClass('services') + '" href="services.html" data-i18n="nav.services"' + ariaCurrent('services') + '>Services</a>' +
        '<a class="' + navClass('about') + '" href="about.html" data-i18n="nav.about"' + ariaCurrent('about') + '>About</a>' +
        '<a id="navProfileLink" class="' + navClass('profile') + '" href="login.html" data-i18n="nav.profile">Profile</a>' +
        '<a class="inline-flex items-center gap-1.5 bg-secondary text-on-secondary px-[18px] py-[9px] rounded-lg font-label-caps text-label-caps hover:opacity-90 transition-opacity" href="mam-ai.html">MAM AI</a>' +
      '</nav>' +
      '<button aria-label="Notifications" class="p-2 rounded-full hover:bg-surface-container-high dark:hover:bg-surface-container-highest transition-all duration-200 active:scale-95 text-on-surface-variant dark:text-on-surface-variant" type="button">' +
        '<span class="material-symbols-outlined" aria-hidden="true">notifications</span>' +
      '</button>' +
    '</header>';
})();
