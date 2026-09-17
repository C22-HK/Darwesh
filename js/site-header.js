// Darwesh shared site header -- the ONE canonical top nav bar (flag
// language selector, wordmark, Home / Properties Map / Sell / MAM AI /
// "Challenge" [the Darwesh Arena entry point, arena.html] / About /
// Profile / notifications) for every public content page. The primary
// nav splits 3 + 3 around the centered brand lockup: LEFT = Home,
// Properties Map, Sell; RIGHT = MAM AI, Challenge, About -- all six use
// the exact same link markup (navClass/ariaCurrent), so every item gets
// identical typography, spacing, hover, focus, and active-underline
// behavior with no special-casing. Notifications and the Login/Profile
// control are a separate utility cluster after the right nav group (a
// vertical divider marks the boundary), not part of the 3+3 balance.
// There is
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
// `data-active` is one of: home, propertiesMap, sell, mamai, about --
// omit/leave blank on a page with no matching nav item (e.g. a detail
// page, listing.html, or services.html now that Services is no longer a
// top-level nav item -- see below), which then highlights nothing as
// current. map.html
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

  var LINK_BASE = 'site-nav-link font-label-caps text-label-caps tracking-wide whitespace-nowrap';
  var LINK_ACTIVE = ' site-nav-link--active';
  var LINK_INACTIVE = ' site-nav-link--inactive';

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
        '<button aria-label="Language" data-i18n-aria="nav.languageLabel" class="lang-toggle-btn inline-flex items-center gap-1.5 ' + pad + ' rounded-full border border-white/10 bg-white/[0.04] text-[#F4EFE7] hover:border-[#C69A4B]/50 transition-colors" type="button">' +
          '<span class="lang-current" data-flag-for="en"><img class="lang-flag" src="images/flags/usa.svg" alt="" width="' + flagW + '" height="' + flagH + '" decoding="async">EN</span>' +
          '<span class="lang-current" data-flag-for="ku"><img class="lang-flag" src="images/flags/kurdistan.svg" alt="" width="' + flagW + '" height="' + flagH + '" decoding="async">KU</span>' +
          '<span class="lang-current" data-flag-for="ar"><img class="lang-flag" src="images/flags/iraq.svg" alt="" width="' + flagW + '" height="' + flagH + '" decoding="async">AR</span>' +
          '<span class="lang-current" data-flag-for="tr"><img class="lang-flag" src="images/flags/turkey.svg" alt="" width="' + flagW + '" height="' + flagH + '" decoding="async">TR</span>' +
        '</button>' +
        '<div class="lang-menu hidden absolute start-0 top-full mt-2 z-50 bg-[#14161A]/95 backdrop-blur-xl border border-white/10 rounded-xl shadow-lg">' +
          '<button class="lang-option rounded-lg text-[#F4EFE7] hover:bg-white/[0.06]" data-lsel data-lang="ku" onclick="setLanguage(\'ku\')" type="button">' +
            '<img class="lang-flag" src="images/flags/kurdistan.svg" alt="" width="20" height="14" decoding="async"><span>کوردی</span>' +
            '<span class="lang-option-check" aria-hidden="true"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m5 13 4 4L19 7"/></svg></span>' +
          '</button>' +
          '<button class="lang-option rounded-lg text-[#F4EFE7] hover:bg-white/[0.06]" data-lsel data-lang="ar" onclick="setLanguage(\'ar\')" type="button">' +
            '<img class="lang-flag" src="images/flags/iraq.svg" alt="" width="20" height="14" decoding="async"><span>العربية</span>' +
            '<span class="lang-option-check" aria-hidden="true"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m5 13 4 4L19 7"/></svg></span>' +
          '</button>' +
          '<button class="lang-option rounded-lg text-[#F4EFE7] hover:bg-white/[0.06]" data-lsel data-lang="tr" onclick="setLanguage(\'tr\')" type="button">' +
            '<img class="lang-flag" src="images/flags/turkey.svg" alt="" width="20" height="14" decoding="async"><span>Türkçe</span>' +
            '<span class="lang-option-check" aria-hidden="true"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m5 13 4 4L19 7"/></svg></span>' +
          '</button>' +
          '<button class="lang-option rounded-lg text-[#F4EFE7] hover:bg-white/[0.06]" data-lsel data-lang="en" onclick="setLanguage(\'en\')" type="button">' +
            '<img class="lang-flag" src="images/flags/usa.svg" alt="" width="20" height="14" decoding="async"><span>English</span>' +
            '<span class="lang-option-check" aria-hidden="true"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m5 13 4 4L19 7"/></svg></span>' +
          '</button>' +
        '</div>' +
      '</div>'
    );
  }

  function notifBell(extraClass) {
    return (
      '<button aria-label="Notifications" data-i18n-aria="nav.notificationsLabel" class="nav-notif-btn ' + (extraClass || '') + ' relative p-2.5 rounded-full hover:bg-white/[0.06] transition-all duration-200 active:scale-95 text-[#F4EFE7]" type="button" style="--notif-dot-ring:#14161A">' +
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
    '<a href="index.html" dir="ltr" class="flex items-center gap-2 whitespace-nowrap" aria-label="Darwesh Group — Home" data-i18n-aria="nav.brandHomeLabel">' +
      '<span class="font-headline-md font-bold tracking-tight text-[#F4EFE7]">Darwesh</span>' +
      '<span class="brand-logo-circle">' +
        // PERFORMANCE FOUNDATION (P0-3): 1254x1254 PNG (1.49MB) replaced
        // with a 192px export -- large enough for 3x DPR at this mark's
        // biggest rendered size (1.65em) -- as lossless WebP (~15KB,
        // pixel-identical to the source) with a same-size PNG <picture>
        // fallback for the rare browser without WebP support.
        '<picture><source srcset="images/brand/darwesh-approved-new-logo-192.webp" type="image/webp"><img src="images/brand/darwesh-approved-new-logo-192.png" alt="" decoding="async" class="hdr-mark object-contain"></picture>' +
      '</span>' +
      '<span class="font-headline-md font-bold tracking-tight text-[#F4EFE7]">Group</span>' +
    '</a>';

  var propertiesMapItem =
    '<div class="relative flex items-center gap-0.5">' +
      '<a class="' + navClass('propertiesMap') + '" href="map.html" data-i18n="nav.propertiesMap"' + ariaCurrent('propertiesMap') + '>Properties Map</a>' +
      '<button class="nav-map-toggle-btn flex items-center p-0.5 rounded ' + (active === 'propertiesMap' ? 'text-[#F4EFE7]' : 'text-[#B8B0A5] hover:text-[#F4EFE7]') + ' transition-colors" type="button" aria-label="Buy or rent" data-i18n-aria="nav.buyOrRentLabel">' +
        '<span class="text-[18px]" aria-hidden="true"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg></span>' +
      '</button>' +
      '<div class="nav-map-menu hidden absolute start-0 top-full mt-2 z-50 min-w-[140px] bg-[#17191B] border border-[#2B2C2A] rounded-xl shadow-lg py-1">' +
        '<a class="nav-map-option block px-4 py-2 font-label-caps text-label-caps text-[#F4EFE7] hover:bg-[#1C1F21] transition-colors" href="map.html?type=sale" data-i18n="nav.buy">Buy</a>' +
        '<a class="nav-map-option block px-4 py-2 font-label-caps text-label-caps text-[#F4EFE7] hover:bg-[#1C1F21] transition-colors" href="map.html?type=rent" data-i18n="nav.rent">Rent</a>' +
      '</div>' +
    '</div>';

  var authGuest =
    '<span id="navAuthGuest" class="flex items-center gap-3">' +
      '<a href="login.html" class="inline-flex items-center h-9 px-4 rounded-full border border-white/12 bg-white/[0.03] text-[#F4EFE7] text-sm font-semibold hover:border-[#C69A4B]/50 transition-colors" data-i18n="nav.login">Login</a>' +
      '<a href="signup.html" class="site-cta inline-flex items-center h-9 px-4 rounded-full text-sm font-bold transition-all" data-i18n="nav.signUp">Sign Up</a>' +
    '</span>';

  var profileChip =
    '<a id="navProfileLink" class="hidden items-center h-9 px-4 rounded-full border border-white/12 bg-white/[0.03] hover:border-[#C69A4B]/50 text-[#F4EFE7] text-sm font-semibold transition-colors" href="login.html" data-i18n="nav.profile">Profile</a>';

  mount.innerHTML =
    '<header class="fixed top-0 left-0 w-full z-50 h-[76px]">' +

      // ---- Desktop / wide-tablet split layout (lg+) ----
      '<div class="site-rail hidden lg:block">' +
        '<div class="relative h-full">' +
          '<div class="h-full flex items-center justify-between px-6 max-w-[1680px] mx-auto">' +
            '<div class="flex items-center gap-2">' +
              langSelect('md') +
              '<a class="' + navClass('home') + '" href="index.html" data-i18n="nav.home"' + ariaCurrent('home') + '>Home</a>' +
              propertiesMapItem +
              '<a class="' + navClass('sell') + '" href="sell.html" data-i18n="nav.sell"' + ariaCurrent('sell') + '>Sell</a>' +
            '</div>' +
            '<div class="flex items-center gap-2">' +
              '<a class="' + navClass('mamai') + '" href="mam-ai.html" data-i18n="mamai.navLabel"' + ariaCurrent('mamai') + '>MAM AI</a>' +
              '<a class="' + navClass('arena') + '" href="arena.html" data-i18n="arena.navLabel"' + ariaCurrent('arena') + '>Challenge</a>' +
              // "Services" was removed as a standalone nav item -- the
              // Darwesh Service Universe carousel on the Home page (and
              // the many in-context links throughout the site) is now how
              // visitors reach services.html and every individual service
              // page. Those pages and URLs are unchanged; only this one
              // top-level nav entry is gone.
              '<a class="' + navClass('about') + '" href="about.html" data-i18n="nav.about"' + ariaCurrent('about') + '>About</a>' +
              '<span class="w-px h-5 bg-white/10 mx-1.5" aria-hidden="true"></span>' +
              notifBell('') +
              authGuest +
              profileChip +
            '</div>' +
          '</div>' +
          '<div class="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 pointer-events-none">' +
            '<div class="pointer-events-auto text-[20px]">' + brandLockup + '</div>' +
          '</div>' +
        '</div>' +
      '</div>' +

      // ---- Compact mobile/tablet bar (below lg) ----
      '<div class="site-rail flex lg:hidden items-center justify-between px-3.5">' +
        '<div class="flex items-center">' + langSelect('sm') + '</div>' +
        '<div class="text-[16px]">' + brandLockup + '</div>' +
        '<div class="flex items-center">' + notifBell('') + '</div>' +
      '</div>' +
    '</header>';

  // hdr-mark: the logo image's own size inside the shared .brand-logo-
  // circle (css/profile-tokens.css) -- sized off its lockup's own font-
  // size (~43px circle / ~36px logo on desktop's 22px lockup, ~33px
  // circle / ~28px logo on mobile's 17px lockup, the logo filling ~85%
  // of the circle) so one shared brandLockup() string works at both
  // sizes without a size parameter -- em-based sizing here, set once, no
  // per-call plumbing.
  // Floating premium smoked-glass rail: the outer <header> stays a plain
  // 76px-tall transparent hit-box (unchanged from the previous solid-bar
  // version) so every page's existing `pt-[76px]` top padding still lines
  // up exactly -- nothing outside this file needed to change. The actual
  // visible bar is this inset .site-rail child: a slim, rounded,
  // backdrop-blurred pill that floats with a visible gap above/below/
  // beside it, rather than a heavy edge-to-edge solid block. Active nav
  // items get the same champagne-glass treatment used site-wide for
  // "selected" state (map.html's #typeSeg), not a hard underline.
  var style = document.createElement('style');
  style.textContent =
    '#siteHeader .brand-logo-circle{width:1.95em;height:1.95em}' +
    '.hdr-mark{height:1.65em;width:1.65em}' +
    /* ===================================================================
       PASS 4 -- APPLE-LEVEL TYPOGRAPHY. The site-wide font-label-caps
       utility (IBM Plex Sans, 12px, .05em tracking, uppercase-adjacent
       feel) is what made this read as an old classic website header --
       overridden here, scoped to #siteHeader only, with a modern UI
       sans stack. Inter is already loaded on most pages that mount this
       header (map/sell/mam-ai/...); where a page doesn't link it, the
       stack falls through to -apple-system/system-ui, which is San
       Francisco on Apple devices -- the fallback chain itself stays
       "Apple-like" rather than silently degrading to a serif or a
       mismatched default. =============================================*/
    '#siteHeader{--nav-font:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;' +
      '--nav-text-primary:rgba(248,248,246,.88);--nav-text-secondary:rgba(248,248,246,.68);--nav-text-muted:rgba(248,248,246,.48);}' +
    '#siteHeader,#siteHeader input,#siteHeader button{font-family:var(--nav-font);}' +
    /* Brand lockup -- same modern stack, tightened tracking so it reads
       architectural rather than the classic-leaning headline face
       (Plus Jakarta Sans, which .font-headline-md set it to). Targets
       both text spans ("Darwesh" and "Group") that carry this class. */
    '#siteHeader .font-headline-md{font-family:var(--nav-font)!important;letter-spacing:-0.015em;color:rgba(250,248,242,.95);}' +
    /* ===================================================================
       VISIONOS SPATIAL GLASS -- PASS 3: the fill was still reading as a
       milky/cream rectangle on bright backgrounds. Fill dropped to
       near-nothing (.010/.004); the "glass" feeling now comes almost
       entirely from the EDGE (three different border colors per side,
       not a uniform stroke) and the backdrop-filter itself, not from
       panel color. The rail's own background/border/shadow are all
       white-based rgba (never a tinted navy/gold fill): whatever color
       you see is the page behind it, through the blur. =================*/
    '#siteHeader .site-rail{position:absolute;left:10px;right:10px;top:9px;height:58px;border-radius:20px;' +
      'background-image:linear-gradient(180deg, rgba(255,255,255,.010), rgba(255,255,255,.004));' +
      'backdrop-filter:blur(26px) saturate(108%) contrast(102%);-webkit-backdrop-filter:blur(26px) saturate(108%) contrast(102%);' +
      'border-style:solid;border-width:1px;' +
      'border-top-color:rgba(255,255,255,.09);border-bottom-color:rgba(0,0,0,.07);' +
      'border-left-color:rgba(255,255,255,.05);border-right-color:rgba(255,255,255,.05);' +
      'box-shadow:0 6px 22px rgba(0,0,0,.09), inset 0 1px 0 rgba(255,255,255,.05);}' +
    /* Top-edge reflection -- a single continuous gradient from top to
       bottom (was a hard fade stopping at 28%), so the light reads as
       one smooth sheet catching the surface rather than a band that
       cuts off partway down. */
    '#siteHeader .site-rail::before{content:"";position:absolute;inset:0;border-radius:inherit;pointer-events:none;' +
      'background:linear-gradient(180deg, rgba(255,255,255,.045) 0%, rgba(255,255,255,.012) 45%, rgba(255,255,255,0) 100%);}' +
    /* ~95vw, centered, ~72px tall with ~14px of top clearance -- as close
       to the requested 94-96vw / 68-78px / 18-28px geometry as the outer
       <header>'s existing 76px hit-box allows without also touching the
       pt-[76px] top offset shared by 33 other pages and map.html's own
       toolbar offset (both explicitly out of scope for this navbar-only
       pass) -- see the completion report for the follow-up this implies. */
    '@media (min-width:1024px){#siteHeader .site-rail{left:2.5vw;right:2.5vw;top:12px;height:60px;border-radius:22px}}' +
    /* Every control below defaults to fully transparent (no fill at
       rest, not even a faint wash) -- only hover/active add a small
       amount of local glass. Nothing in this bar is a filled dark
       rectangle by default; the rail's own blur is what carries it. */
    '#siteHeader .site-nav-link{position:relative;padding:10px 14px;border-radius:999px;border:1px solid transparent;background:transparent;' +
      'font-size:14.5px;font-weight:510;line-height:1;letter-spacing:-0.005em;' +
      'text-shadow:0 1px 2px rgba(0,0,0,.20);' +
      'transition:background-color 200ms cubic-bezier(.2,.8,.2,1),border-color 200ms cubic-bezier(.2,.8,.2,1),color 200ms cubic-bezier(.2,.8,.2,1),transform 200ms cubic-bezier(.2,.8,.2,1);}' +
    '#siteHeader .site-nav-link--inactive{color:var(--nav-text-primary);}' +
    '#siteHeader .site-nav-link--inactive:hover{color:rgba(255,255,255,.96);background-color:rgba(255,255,255,.025);border-color:rgba(255,255,255,.07);transform:translateY(-0.5px);}' +
    '#siteHeader .site-nav-link--inactive:active{transform:translateY(0) scale(.99);}' +
    /* Active state -- transparent, a thin warm trace under the label
       reading as reflected light, never a solid gold pill or a filled
       background. Underline is now a fixed 24px centered under the
       label (was inset-from-edge, which scaled with each label's own
       width) so every active item gets the same precise mark. */
    '#siteHeader .site-nav-link--active{color:rgba(255,255,255,.96);font-weight:600;background:transparent;border-color:transparent;box-shadow:none;}' +
    '#siteHeader .site-nav-link--active::after{content:"";position:absolute;left:50%;transform:translateX(-50%);width:24px;bottom:2px;height:1px;border-radius:2px;' +
      'background:linear-gradient(90deg, rgba(224,190,130,.08), rgba(224,190,130,.55) 35%, rgba(224,190,130,.55) 65%, rgba(224,190,130,.08));' +
      'box-shadow:0 0 5px -1px rgba(224,190,130,.28);}' +
    /* Sign Up -- still transparent glass, not a filled button. The only
       difference from Login is a warm border + a whisper of warm
       specular highlight, never a gold/champagne fill. Slightly
       brighter edge + higher-contrast ivory text than Login, per the
       "primary glass control, not a CTA button" direction. */
    '#siteHeader .site-cta{color:#FAF6EC;background:transparent!important;' +
      'font-family:var(--nav-font);font-size:14.5px;font-weight:560;letter-spacing:-0.005em;' +
      'min-height:38px;display:inline-flex;align-items:center;text-shadow:0 1px 2px rgba(0,0,0,.20);' +
      'border:1px solid rgba(224,190,130,.46)!important;' +
      'box-shadow:inset 0 1px 0 rgba(224,190,130,.16);' +
      'transition:border-color 200ms cubic-bezier(.2,.8,.2,1),background-color 200ms cubic-bezier(.2,.8,.2,1),transform 200ms cubic-bezier(.2,.8,.2,1);}' +
    '#siteHeader .site-cta:hover{background-color:rgba(224,190,130,.05)!important;border-color:rgba(224,190,130,.65)!important;transform:translateY(-0.5px);}' +
    '#siteHeader .site-cta:active{transform:translateY(0) scale(.99);}' +
    /* Profile / Login -- transparent glass at rest, a hair of local
       reflection only on hover. Quieter than Sign Up: neutral border,
       primary (not brightest) text. */
    '#siteHeader #navProfileLink,#siteHeader #navAuthGuest a[href="login.html"]{' +
      'background:transparent!important;border-color:rgba(255,255,255,.14)!important;color:var(--nav-text-primary);' +
      'font-family:var(--nav-font);font-size:14.5px;font-weight:510;letter-spacing:-0.005em;' +
      'min-height:38px;text-shadow:0 1px 2px rgba(0,0,0,.20);' +
      'box-shadow:none;' +
      'transition:border-color 200ms cubic-bezier(.2,.8,.2,1),background-color 200ms cubic-bezier(.2,.8,.2,1),transform 200ms cubic-bezier(.2,.8,.2,1);}' +
    '#siteHeader #navProfileLink:hover,#siteHeader #navAuthGuest a[href="login.html"]:hover{' +
      'color:rgba(255,255,255,.96);background-color:rgba(255,255,255,.025)!important;border-color:rgba(255,255,255,.2)!important;transform:translateY(-0.5px);}' +
    /* Language selector -- same transparent-by-default glass, same type
       scale as the rest of the bar (was inheriting the smaller caps
       scale before this pass). */
    '#siteHeader .lang-toggle-btn{background:transparent!important;min-height:38px;' +
      'font-family:var(--nav-font);font-size:14.5px;font-weight:510;letter-spacing:-0.005em;' +
      'text-shadow:0 1px 2px rgba(0,0,0,.20);' +
      'border-color:rgba(255,255,255,.12)!important;color:var(--nav-text-primary)!important;' +
      'transition:border-color 200ms cubic-bezier(.2,.8,.2,1),background-color 200ms cubic-bezier(.2,.8,.2,1),transform 200ms cubic-bezier(.2,.8,.2,1);}' +
    '#siteHeader .lang-toggle-btn:hover{color:rgba(255,255,255,.96)!important;background-color:rgba(255,255,255,.025)!important;border-color:rgba(224,190,130,.35)!important;transform:translateY(-0.5px);}' +
    /* Keyboard focus -- a thin champagne ring, not the browser default
       blue, on every interactive control in the bar. */
    '#siteHeader .site-nav-link:focus-visible,#siteHeader .lang-toggle-btn:focus-visible,' +
      '#siteHeader .nav-notif-btn:focus-visible,#siteHeader #navProfileLink:focus-visible,' +
      '#siteHeader #navAuthGuest a:focus-visible,#siteHeader .site-cta:focus-visible,' +
      '#siteHeader .nav-map-toggle-btn:focus-visible{' +
      'outline:1.5px solid rgba(224,190,130,.55);outline-offset:2px;}' +
    /* Notification bell -- transparent glass capsule, not a heavy
       square. Targeted by a stable class (not the aria-label value),
       which js/i18n.js overwrites with a translated string on ku/ar/tr. */
    '#siteHeader .nav-notif-btn{border:1px solid rgba(255,255,255,.08);background:transparent;' +
      'min-width:38px;min-height:38px;color:var(--nav-text-primary);' +
      'transition:background-color 200ms cubic-bezier(.2,.8,.2,1),border-color 200ms cubic-bezier(.2,.8,.2,1),transform 200ms cubic-bezier(.2,.8,.2,1),color 200ms cubic-bezier(.2,.8,.2,1);}' +
    '#siteHeader .nav-notif-btn:hover{color:rgba(255,255,255,.96);background-color:rgba(255,255,255,.05)!important;border-color:rgba(255,255,255,.16);transform:translateY(-0.5px);}';
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

// PERFORMANCE FOUNDATION (P0-7/P0-8): intent-based navigation prefetch.
// This site is a true multi-page app (no client-side router -- see
// creative-preview/PERFORMANCE_ARCHITECTURE.md section 6), so every nav
// click is a real document load. The cheapest, lowest-risk way to make
// that feel faster is telling the browser to start fetching the
// destination HTML before the click happens, using the signal a real
// intent-to-navigate already gives: hover on desktop, touch/press on
// mobile. This never prefetches the whole site -- only a same-origin nav
// link the visitor's pointer/finger is already on.
//
// A second, self-contained top-level IIFE (not folded into the one
// above) because it delegates from #siteMobileNav too, a DIFFERENT
// shared component (js/site-mobile-nav.js) -- this stays correct
// regardless of that file's own render timing, and living here means
// every one of the 34 pages that already load js/site-header.js gets it
// with zero additional <script> tags anywhere.
(function () {
  'use strict';
  var prefetched = Object.create(null);

  function isPrefetchable(href) {
    if (!href) return false;
    if (href.charAt(0) === '#') return false;
    if (/^(mailto:|tel:|javascript:)/i.test(href)) return false;
    var a = document.createElement('a');
    a.href = href;
    if (a.origin !== location.origin) return false;
    if (a.pathname === location.pathname && a.search === location.search) return false; // already here
    return true;
  }

  function prefetch(href) {
    if (!isPrefetchable(href) || prefetched[href]) return;
    prefetched[href] = true;
    var link = document.createElement('link');
    link.rel = 'prefetch';
    link.href = href;
    document.head.appendChild(link);
  }

  function targetHref(el) {
    var a = el.closest && el.closest('a[href]');
    return a ? a.getAttribute('href') : null;
  }

  // pointerenter doesn't bubble, but delegating it via the capture phase
  // at the document root is the standard way around that.
  document.addEventListener('pointerenter', function (e) {
    if (!(e.target.closest && e.target.closest('#siteHeader, #siteMobileNav'))) return;
    var href = targetHref(e.target);
    if (href) prefetch(href);
  }, true);

  // pointerdown covers touch (no hover phase) and is a strictly stronger
  // intent signal than hover on desktop too -- a cheap no-op if
  // pointerenter already queued the same href.
  document.addEventListener('pointerdown', function (e) {
    if (!(e.target.closest && e.target.closest('#siteHeader, #siteMobileNav'))) return;
    var href = targetHref(e.target);
    if (href) prefetch(href);
  }, true);
})();
