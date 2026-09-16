// Darwesh shared public mobile bottom navigation -- the ONE canonical
// mobile nav for every public content page: a floating "Darwesh Spatial
// Glass" capsule with 5 primary actions (Home, AI, Map, Sell, More) plus
// a More panel that opens ABOVE the bar for the 4 secondary destinations
// (Services, Challenge, About Us, Profile).
//
// Replaces the older 7-icon-across-the-bar design in full: Services,
// Challenge (Darwesh Arena, arena.html) and Profile no longer sit on the
// bar itself -- there wasn't room to keep them readable at phone width
// (see the old version's own header comment / mobile-RTL-polish pass for
// that history) -- they now live as rows inside the More panel, which has
// enough width to use the same full desktop label strings (nav.services,
// arena.navLabel, nav.profile) instead of needing shorter mobile-only
// translations.
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
// `data-active` values:
//   Primary (highlights a bar item): home, mamai, propertiesMap, sell
//   Secondary (highlights the More button itself, since that item now
//   lives inside the panel): services, arena, about
//   Leave blank for a page with no matching destination (e.g. account
//   pages) -- nothing on the bar or the More button is marked current.
// There is no separate "profile" active key: Profile's real destination
// is decided dynamically by js/nav-auth.js (which page a signed-in user
// actually lands on), so it never shows as "current" here either.
(function () {
  var mount = document.getElementById('siteMobileNav');
  if (!mount) return;
  var active = mount.getAttribute('data-active') || '';

  var PRIMARY_KEYS = { home: 1, mamai: 1, propertiesMap: 1, sell: 1 };
  var SECONDARY_KEYS = { services: 1, arena: 1, about: 1 };
  var isSecondaryActive = !!SECONDARY_KEYS[active];

  function itemClass(key) {
    return 'dmnav-item' + (key === active ? ' is-active' : '');
  }
  function ariaCurrent(key) {
    return key === active ? ' aria-current="page"' : '';
  }

  var CHEVRON = '<svg class="dmnav-row-chevron" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 5 7 7-7 7"/></svg>';

  mount.innerHTML =
    '<nav class="dmnav-bar md:hidden" aria-label="Primary mobile">' +
      '<a class="' + itemClass('home') + '" href="index.html"' + ariaCurrent('home') + '>' +
        '<span class="dmnav-content">' +
          '<span class="dmnav-icon" aria-hidden="true"><svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11l9-8 9 8"/><path d="M5 10v10h14V10"/><path d="M9 20v-6h6v6"/></svg></span>' +
          '<span class="dmnav-label" data-i18n="nav.home">Home</span>' +
        '</span>' +
      '</a>' +
      '<a class="' + itemClass('mamai') + '" href="mam-ai.html"' + ariaCurrent('mamai') + '>' +
        '<span class="dmnav-content">' +
          '<span class="dmnav-icon" aria-hidden="true"><svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.5c.4 2.4 1 4 1.9 4.9.9.9 2.5 1.5 4.9 1.9-2.4.4-4 1-4.9 1.9-.9.9-1.5 2.5-1.9 4.9-.4-2.4-1-4-1.9-4.9-.9-.9-2.5-1.5-4.9-1.9 2.4-.4 4-1 4.9-1.9.9-.9 1.5-2.5 1.9-4.9Z"/></svg></span>' +
          '<span class="dmnav-label" data-i18n="nav.aiShort">AI</span>' +
        '</span>' +
      '</a>' +
      '<a class="' + itemClass('propertiesMap') + '" href="map.html"' + ariaCurrent('propertiesMap') + '>' +
        '<span class="dmnav-content">' +
          '<span class="dmnav-icon" aria-hidden="true"><svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m9 4-6 3v13l6-3 6 3 6-3V4l-6 3Z"/><path d="M9 4v13M15 7v13"/></svg></span>' +
          '<span class="dmnav-label" data-i18n="nav.map">Map</span>' +
        '</span>' +
      '</a>' +
      '<a class="' + itemClass('sell') + '" href="sell.html"' + ariaCurrent('sell') + '>' +
        '<span class="dmnav-content">' +
          '<span class="dmnav-icon" aria-hidden="true"><svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20.6 13.4 12 22l-9-9 8.6-8.6A2 2 0 0 1 13 4h6a2 2 0 0 1 2 2v6a2 2 0 0 1-.4 1.4Z"/><circle cx="16.5" cy="7.5" r="1"/></svg></span>' +
          '<span class="dmnav-label" data-i18n="nav.sell">Sell</span>' +
        '</span>' +
      '</a>' +
      '<button type="button" class="dmnav-item dmnav-more' + (isSecondaryActive ? ' is-active' : '') + '" id="dmnavMoreBtn" aria-haspopup="true" aria-expanded="false" aria-controls="dmnavPanel">' +
        '<span class="dmnav-content">' +
          '<span class="dmnav-icon" aria-hidden="true">' +
            '<svg class="dmnav-icon-dots" viewBox="0 0 24 24" width="19" height="19" fill="currentColor"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>' +
            '<svg class="dmnav-icon-close" viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>' +
          '</span>' +
          '<span class="dmnav-label" data-i18n="nav.more">More</span>' +
        '</span>' +
      '</button>' +
    '</nav>' +
    '<div class="dmnav-backdrop" id="dmnavBackdrop"></div>' +
    '<div class="dmnav-panel" id="dmnavPanel" role="menu" aria-hidden="true" aria-label="More navigation">' +
      '<a class="dmnav-row" href="services.html" role="menuitem">' +
        '<span class="dmnav-row-icon" aria-hidden="true"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></span>' +
        '<span class="dmnav-row-label" data-i18n="nav.services">Services</span>' +
        CHEVRON +
      '</a>' +
      '<a class="dmnav-row" href="arena.html" role="menuitem">' +
        '<span class="dmnav-row-icon" aria-hidden="true"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M7 4h10v4a5 5 0 0 1-5 5 5 5 0 0 1-5-5V4Z"/><path d="M7 6H4a1 1 0 0 0-1 1c0 2.5 1.8 4.5 4.2 4.9M17 6h3a1 1 0 0 1 1 1c0 2.5-1.8 4.5-4.2 4.9"/><path d="M12 13v4M8.5 20c0-1.7 1.6-3 3.5-3s3.5 1.3 3.5 3M9 20h6"/></svg></span>' +
        '<span class="dmnav-row-label" data-i18n="arena.navLabel">Challenge</span>' +
        CHEVRON +
      '</a>' +
      '<a class="dmnav-row" href="about.html" role="menuitem">' +
        '<span class="dmnav-row-icon" aria-hidden="true"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 11v5.5"/><path d="M12 7.75v.01"/></svg></span>' +
        '<span class="dmnav-row-label" data-i18n="nav.about">About Us</span>' +
        CHEVRON +
      '</a>' +
      '<a id="navProfileLinkMobile" class="dmnav-row" href="login.html" role="menuitem" aria-label="Profile">' +
        '<span class="dmnav-row-icon" aria-hidden="true"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg></span>' +
        '<span id="navProfileLabelMobile" class="dmnav-row-label" data-i18n="nav.profile">Profile</span>' +
        CHEVRON +
      '</a>' +
    '</div>';

  var moreBtn = document.getElementById('dmnavMoreBtn');
  var panel = document.getElementById('dmnavPanel');
  var backdrop = document.getElementById('dmnavBackdrop');
  if (!moreBtn || !panel || !backdrop) return;

  var isOpen = false;

  function focusableRows() {
    return Array.prototype.slice.call(panel.querySelectorAll('.dmnav-row'));
  }

  function openPanel() {
    if (isOpen) return;
    isOpen = true;
    moreBtn.setAttribute('aria-expanded', 'true');
    panel.classList.add('is-open');
    panel.setAttribute('aria-hidden', 'false');
    panel.inert = false;
    backdrop.classList.add('is-open');
  }

  function closePanel(returnFocus) {
    if (!isOpen) return;
    isOpen = false;
    moreBtn.setAttribute('aria-expanded', 'false');
    panel.classList.remove('is-open');
    panel.setAttribute('aria-hidden', 'true');
    panel.inert = true;
    backdrop.classList.remove('is-open');
    if (returnFocus) moreBtn.focus();
  }

  moreBtn.addEventListener('click', function () {
    if (isOpen) { closePanel(false); } else { openPanel(); }
  });

  backdrop.addEventListener('click', function () {
    closePanel(false);
  });

  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape' || !isOpen) return;
    closePanel(true);
  });

  panel.addEventListener('keydown', function (e) {
    if (e.key !== 'Tab' || !isOpen) return;
    var rows = focusableRows();
    if (!rows.length) return;
    var first = rows[0];
    var last = rows[rows.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  });

  panel.inert = true;
})();
