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
// as its two modes, never a second or third label. "MAM AI" below is the
// single, site-wide entry point for MAM: every page's old floating
// companion (orb, dock, "Ask MAM" bar) has been removed in favor of this
// one dedicated full-page destination (mam-ai.html, the MAM AI Command
// Center) -- see docs/MAM_V2_ARCHITECTURE.md section 21.
//
// LIGHT-LUXURY HEADER REBUILD (visual composition change, approved).
// White surface (not the previous navy-forward M3 tokens), Darwesh Navy
// text/structure, restrained gold accents. The brand lockup -- "Darwesh
// [official mark] Group" -- is TRUE-centered on the viewport, independent
// of how wide the left/right control groups are: the two groups sit in a
// normal flex row, and the lockup is a separate `position:absolute;
// left:50%; translate(-50%,-50%)` element layered on top of that row, so
// its center is always the header's own center (== the viewport's, since
// the header is full-width) no matter what either side contains. This is
// the standard robust technique for "centered regardless of unequal side
// widths" -- a plain 3-column grid (1fr/auto/1fr) does NOT guarantee that
// on its own, because each 1fr track still grows to fit its own content's
// min-content first and only distributes leftover space proportionally
// after that, so unequal left/right content pulls the center off-axis.
//
// Desktop/wide (lg+, 1024px+) gets the full split layout; below that,
// mobile keeps a compact bar (language + centered brand + notifications)
// rather than forcing the split nav to fit -- the bottom tab bar
// (js/site-mobile-nav.js, already on every page) is the real mobile
// primary nav, so the mobile top bar does not need to repeat it.
//
// Login/Sign Up (guest) vs. a Profile chip (signed in) is a REAL toggle,
// not decoration: both markups exist from first paint, #navAuthGuest
// visible and #navProfileLink hidden, and js/nav-auth.js -- the existing,
// already-wired module that resolves real Firebase auth state and knows
// the real per-accountType destination page -- flips which one shows
// once it knows the real state. Nothing here fakes a signed-in UI.
//
// Before this file existed, every page hand-duplicated its own <header>
// markup and they had drifted: different nav link sets, different
// labels, and only some pages had the flag-based language selector while
// others still had a plain globe icon. This is the single source of
// truth going forward.
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
// `data-active` is one of: home, propertiesMap, sell, mamai, services,
// about -- omit/
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

  var LINK_BASE = 'font-label-caps text-label-caps tracking-wide transition-colors border-b-2 pt-1 pb-[7px] whitespace-nowrap';
  var LINK_ACTIVE = ' text-[#F4EFE7] font-bold border-[#C69A4B]';
  var LINK_INACTIVE = ' text-[#B8B0A5] hover:text-[#F4EFE7] border-transparent hover:border-[#2B2C2A]';

  function navClass(key) {
    return LINK_BASE + (key === active ? LINK_ACTIVE : LINK_INACTIVE);
  }
  function ariaCurrent(key) {
    return key === active ? ' aria-current="page"' : '';
  }

  function langSelect(size) {
    var flagW = size === 'sm' ? 18 : 20, flagH = size === 'sm' ? 13 : 14;
    var pad = size === 'sm' ? 'px-2.5 py-1.5' : 'px-3 py-2';
    return (
      '<div class="relative">' +
        '<button aria-label="Language" class="lang-toggle-btn inline-flex items-center gap-1.5 ' + pad + ' rounded-md border border-[#2B2C2A] bg-[#17191B] text-[#F4EFE7] hover:border-[#C69A4B] transition-colors" type="button">' +
          '<span class="lang-current" data-flag-for="en"><img class="lang-flag" src="images/flags/usa.svg" alt="" width="' + flagW + '" height="' + flagH + '" decoding="async">EN</span>' +
          '<span class="lang-current" data-flag-for="ku"><img class="lang-flag" src="images/flags/kurdistan.svg" alt="" width="' + flagW + '" height="' + flagH + '" decoding="async">KU</span>' +
          '<span class="lang-current" data-flag-for="ar"><img class="lang-flag" src="images/flags/iraq.svg" alt="" width="' + flagW + '" height="' + flagH + '" decoding="async">AR</span>' +
        '</button>' +
        '<div class="lang-menu hidden absolute start-0 top-full mt-2 z-50 bg-[#17191B] border border-[#2B2C2A] rounded-xl shadow-lg">' +
          '<button class="lang-option rounded-lg text-[#F4EFE7] hover:bg-[#1C1F21]" data-lsel data-lang="ku" onclick="setLanguage(\'ku\')" type="button">' +
            '<img class="lang-flag" src="images/flags/kurdistan.svg" alt="" width="20" height="14" decoding="async"><span>کوردی</span>' +
            '<span class="lang-option-check" aria-hidden="true"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m5 13 4 4L19 7"/></svg></span>' +
          '</button>' +
          '<button class="lang-option rounded-lg text-[#F4EFE7] hover:bg-[#1C1F21]" data-lsel data-lang="ar" onclick="setLanguage(\'ar\')" type="button">' +
            '<img class="lang-flag" src="images/flags/iraq.svg" alt="" width="20" height="14" decoding="async"><span>العربية</span>' +
            '<span class="lang-option-check" aria-hidden="true"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m5 13 4 4L19 7"/></svg></span>' +
          '</button>' +
          '<button class="lang-option rounded-lg text-[#F4EFE7] hover:bg-[#1C1F21]" data-lsel data-lang="en" onclick="setLanguage(\'en\')" type="button">' +
            '<img class="lang-flag" src="images/flags/usa.svg" alt="" width="20" height="14" decoding="async"><span>English</span>' +
            '<span class="lang-option-check" aria-hidden="true"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m5 13 4 4L19 7"/></svg></span>' +
          '</button>' +
        '</div>' +
      '</div>'
    );
  }

  function notifBell(extraClass) {
    return (
      '<button aria-label="Notifications" class="' + (extraClass || '') + ' relative p-2.5 rounded-full hover:bg-[#1C1F21] transition-all duration-200 active:scale-95 text-[#F4EFE7]" type="button" style="--notif-dot-ring:#0B0E12">' +
        '<span aria-hidden="true"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8a6 6 0 1 0-12 0c0 7-3 8-3 8h18s-3-1-3-8"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/></svg></span>' +
      '</button>'
    );
  }

  // dir="ltr" pinned deliberately: this splits "Darwesh"/mark/"Group" into
  // three flex children, and a flex row's VISUAL order follows the
  // container's direction -- under the site's RTL languages (Arabic,
  // Kurdish/Sorani) that would silently reverse the lockup to
  // "Group [mark] Darwesh". The brand name is a fixed Latin proper noun,
  // not translated content, so it stays LTR regardless of page direction,
  // same as a logo image would.
  var brandLockup =
    '<a href="index.html" dir="ltr" class="flex items-center gap-2 whitespace-nowrap" aria-label="Darwesh Group — Home">' +
      '<span class="font-headline-md font-bold tracking-tight text-[#F4EFE7]">Darwesh</span>' +
      '<img src="images/brand/darwesh-mark.png" alt="" width="34" height="34" decoding="async" class="hdr-mark object-contain">' +
      '<span class="font-headline-md font-bold tracking-tight text-[#F4EFE7]">Group</span>' +
    '</a>';

  var propertiesMapItem =
    '<div class="relative flex items-center gap-0.5">' +
      '<a class="' + navClass('propertiesMap') + '" href="map.html" data-i18n="nav.propertiesMap"' + ariaCurrent('propertiesMap') + '>Properties Map</a>' +
      '<button class="nav-map-toggle-btn flex items-center p-0.5 rounded ' + (active === 'propertiesMap' ? 'text-[#F4EFE7]' : 'text-[#B8B0A5] hover:text-[#F4EFE7]') + ' transition-colors" type="button" aria-label="Buy or rent">' +
        '<span class="text-[18px]" aria-hidden="true"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg></span>' +
      '</button>' +
      '<div class="nav-map-menu hidden absolute start-0 top-full mt-2 z-50 min-w-[140px] bg-[#17191B] border border-[#2B2C2A] rounded-xl shadow-lg py-1">' +
        '<a class="nav-map-option block px-4 py-2 font-label-caps text-label-caps text-[#F4EFE7] hover:bg-[#1C1F21] transition-colors" href="map.html?type=sale" data-i18n="nav.buy">Buy</a>' +
        '<a class="nav-map-option block px-4 py-2 font-label-caps text-label-caps text-[#F4EFE7] hover:bg-[#1C1F21] transition-colors" href="map.html?type=rent" data-i18n="nav.rent">Rent</a>' +
      '</div>' +
    '</div>';

  var authGuest =
    '<span id="navAuthGuest" class="flex items-center gap-3">' +
      '<a href="login.html" class="inline-flex items-center h-9 px-4 rounded-md border border-[#2B2C2A] text-[#F4EFE7] text-sm font-semibold hover:border-[#C69A4B] transition-colors" data-i18n="nav.login">Login</a>' +
      '<a href="signup.html" class="inline-flex items-center h-9 px-4 rounded-md bg-[#C69A4B] text-[#0B0E12] text-sm font-bold hover:bg-[#D4AF60] transition-colors" data-i18n="nav.signUp">Sign Up</a>' +
    '</span>';

  var profileChip =
    '<a id="navProfileLink" class="hidden items-center h-9 px-4 rounded-full border border-[#2B2C2A] hover:border-[#C69A4B] text-[#F4EFE7] text-sm font-semibold transition-colors" href="login.html" data-i18n="nav.profile">Profile</a>';

  mount.innerHTML =
    '<header class="fixed top-0 left-0 w-full z-50 h-[76px] bg-[#0B0E12] border-b border-[#2B2C2A]">' +

      // ---- Desktop / wide-tablet split layout (lg+) ----
      '<div class="hidden lg:block relative h-full">' +
        '<div class="h-full flex items-center justify-between px-margin-desktop max-w-[1680px] mx-auto">' +
          '<div class="flex items-center gap-6">' +
            langSelect('md') +
            '<a class="' + navClass('home') + '" href="index.html" data-i18n="nav.home"' + ariaCurrent('home') + '>Home</a>' +
            propertiesMapItem +
            '<a class="' + navClass('sell') + '" href="sell.html" data-i18n="nav.sell"' + ariaCurrent('sell') + '>Sell</a>' +
            '<a class="' + navClass('mamai') + '" href="mam-ai.html" data-i18n="mamai.navLabel"' + ariaCurrent('mamai') + '>MAM AI</a>' +
          '</div>' +
          '<div class="flex items-center gap-6">' +
            '<a class="' + navClass('services') + '" href="services.html" data-i18n="nav.services"' + ariaCurrent('services') + '>Services</a>' +
            '<a class="' + navClass('about') + '" href="about.html" data-i18n="nav.about"' + ariaCurrent('about') + '>About</a>' +
            notifBell('') +
            authGuest +
            profileChip +
          '</div>' +
        '</div>' +
        '<div class="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 pointer-events-none">' +
          '<div class="pointer-events-auto text-[22px]">' + brandLockup + '</div>' +
        '</div>' +
      '</div>' +

      // ---- Compact mobile/tablet bar (below lg) ----
      '<div class="flex lg:hidden items-center justify-between h-full px-4">' +
        '<div class="flex items-center">' + langSelect('sm') + '</div>' +
        '<div class="text-[17px]">' + brandLockup + '</div>' +
        '<div class="flex items-center">' + notifBell('') + '</div>' +
      '</div>' +
    '</header>';

  // hdr-mark: the logo mark's pixel size scales with its lockup's own font
  // size (34px on desktop's 22px lockup, ~26px on mobile's 17px lockup) so
  // one shared brandLockup() string works at both sizes without a size
  // parameter -- em-based sizing here, set once, no per-call plumbing.
  var style = document.createElement('style');
  style.textContent = '.hdr-mark{height:1.55em;width:1.55em}';
  document.head.appendChild(style);

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
