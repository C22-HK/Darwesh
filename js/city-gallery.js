// Darwesh Home -- CITY DISCOVERY, spatial gallery.
//
// Replaces the rejected composition entirely: a cream rectangle containing a
// row of identical arch cards and a lot of beige emptiness. That version
// read as another carousel section because it WAS one -- a horizontal list
// of equal tiles inside its own coloured box.
//
// This is a curved wall of city planes standing in the world. Every plane's
// position is a pure function of one number: its signed offset from the
// focused city (`--o`). CSS turns that offset into translateX + translateZ +
// rotateY + opacity, so changing focus moves the CAMERA along a wall rather
// than sliding a strip of cards. The nearest neighbours stay visible and
// angled, which is what makes it read as a place rather than a list.
//
// NO ANIMATION LOOP. This adds zero requestAnimationFrame loops and zero
// scroll listeners -- the page already has exactly one of each and that is
// deliberate (see js/cine-scroll-3d.js). Focus changes are discrete events
// (click, key, swipe, wheel-intent); the motion between states is done by a
// CSS transition on transform/opacity, which is compositor work.
//
// ON IMAGERY -- each plane now carries a real, verified photograph of its
// own named landmark (images/cities/*.jpg): Kirkuk, Erbil Citadel,
// Sulaymaniyah, Duhok Dam, the Zakho Delal Bridge, the Halabja Martyrs
// Monument, the Rawanduz/Bekhal canyon near Soran, and historic Koya --
// never one city's photo standing in for another. Set via the `--img`
// custom property, which css/home-world.css already layers as the
// frontmost background of `.w-plane-face` (`background-size: cover`), so a
// plane with no `img` (should one ever be removed) falls back to the
// original abstract light-field untouched.
(function () {
  const mount = document.getElementById('cityGallery');
  if (!mount) return;

  // The city set is unchanged. Destination updated: a city plane now opens
  // projects.html?city=X (that city's Projects listing) instead of
  // buy.html's raw apartment search -- everything else about this section
  // (photos, carousel mechanics, arrows/dots/transitions/mobile behavior)
  // is untouched. Kirkuk leads (and is the default focused/active card)
  // per the approved brief; the rest keep their previous relative order.
  // Root-relative (`/images/...`), not `images/...`: a url() inside a CSS
  // custom property resolves against wherever the var() consuming it
  // lives (css/home-world.css's `.w-plane-face` rule), not against this
  // page's own URL or this script's -- a page-relative path here would
  // silently resolve to a nonexistent css/images/cities/ and 404.
  const CITIES = [
    { key: 'Kirkuk',       h: 36, s: 22, l: 20, img: '/images/cities/kirkuk-citadel.jpg' },
    { key: 'Erbil',        h: 26, s: 22, l: 30, img: '/images/cities/erbil-citadel.jpg' },
    { key: 'Sulaymaniyah', h: 34, s: 18, l: 26, img: '/images/cities/sulaymaniyah-city.jpg' },
    { key: 'Duhok',        h: 18, s: 20, l: 32, img: '/images/cities/duhok-city.jpg' },
    { key: 'Zakho',        h: 40, s: 16, l: 24, img: '/images/cities/zakho-delal-bridge.jpg' },
    { key: 'Soran',        h: 12, s: 24, l: 28, img: '/images/cities/soran-bekhal-waterfall.jpg' },
    { key: 'Koya',         h: 30, s: 20, l: 22, img: '/images/cities/koya-town.jpg' },
    { key: 'Halabja',      h: 22, s: 18, l: 34, img: '/images/cities/halabja-monument.jpg' }
  ];

  const tr = (k, fallback) => (window.t && window.t(k)) || fallback;
  const esc = (s) => (window.escapeHtml ? window.escapeHtml(s) : String(s));

  let focus = 0;

  const arrow =
    '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" ' +
    'stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M5 12h14"/><path d="m13 6 6 6-6 6"/></svg>';

  mount.innerHTML =
    '<div class="w-gallery" id="cityWall">' +
      '<div class="w-wall">' +
        CITIES.map((c, i) =>
          '<a class="w-plane" href="projects.html?city=' + encodeURIComponent(c.key) + '"' +
             ' data-i="' + i + '" style="--h:' + c.h + ';--s:' + c.s + ';--l:' + c.l +
             (c.img ? ';--img:url(' + c.img + ')' : '') + '">' +
            '<span class="w-plane-face" aria-hidden="true"></span>' +
            '<span class="w-plane-scrim" aria-hidden="true"></span>' +
            '<span class="w-plane-body">' +
              '<span class="w-plane-name">' + esc(c.key) + '</span>' +
              '<span class="w-plane-note" data-city-note></span>' +
              '<span class="w-plane-go">' + esc(tr('index.cityOpen', 'Explore projects')) + arrow + '</span>' +
            '</span>' +
          '</a>').join('') +
      '</div>' +
    '</div>' +
    '<div class="w-gallery-nav">' +
      '<button type="button" class="w-icon-btn" data-city-prev aria-label="' + esc(tr('common.previous', 'Previous')) + '">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg>' +
      '</button>' +
      '<span class="w-gallery-dots" role="tablist" aria-label="' + esc(tr('index.browseByCityTitle', 'Cities')) + '">' +
        CITIES.map((c, i) =>
          '<button type="button" class="w-dot" role="tab" data-city-dot="' + i + '"' +
          ' aria-label="' + esc(c.key) + '" aria-current="' + (i === 0 ? 'true' : 'false') + '"></button>').join('') +
      '</span>' +
      '<button type="button" class="w-icon-btn" data-city-next aria-label="' + esc(tr('common.next', 'Next')) + '">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 18l6-6-6-6"/></svg>' +
      '</button>' +
    '</div>';

  const planes = Array.prototype.slice.call(mount.querySelectorAll('.w-plane'));
  const dots = Array.prototype.slice.call(mount.querySelectorAll('.w-dot'));
  const wall = mount.querySelector('#cityWall');

  // The one write. Everything spatial is derived in CSS from --o, so this
  // touches two properties per plane and nothing else -- no layout reads,
  // no geometry maths in JS.
  function paint() {
    for (let i = 0; i < planes.length; i++) {
      const o = i - focus;
      planes[i].style.setProperty('--o', String(o));
      planes[i].setAttribute('data-focus', o === 0 ? '1' : '0');
      // Only the focused plane is in the tab order: a wall of eight links
      // behind each other is a keyboard trap, and the arrows/dots are the
      // real navigation.
      planes[i].tabIndex = o === 0 ? 0 : -1;
      planes[i].setAttribute('aria-hidden', Math.abs(o) > 2 ? 'true' : 'false');
    }
    for (let i = 0; i < dots.length; i++) {
      dots[i].setAttribute('aria-current', i === focus ? 'true' : 'false');
    }
  }

  function go(next) {
    focus = Math.max(0, Math.min(CITIES.length - 1, next));
    paint();
  }

  mount.querySelector('[data-city-prev]').addEventListener('click', () => go(focus - 1));
  mount.querySelector('[data-city-next]').addEventListener('click', () => go(focus + 1));
  dots.forEach((d, i) => d.addEventListener('click', () => go(i)));

  // Keyboard: the gallery is one control, arrow keys move along the wall.
  wall.tabIndex = 0;
  wall.setAttribute('role', 'group');
  wall.addEventListener('keydown', (e) => {
    const rtl = document.documentElement.getAttribute('dir') === 'rtl';
    if (e.key === 'ArrowRight') { e.preventDefault(); go(focus + (rtl ? -1 : 1)); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); go(focus + (rtl ? 1 : -1)); }
    else if (e.key === 'Home') { e.preventDefault(); go(0); }
    else if (e.key === 'End') { e.preventDefault(); go(CITIES.length - 1); }
  });

  // Touch: a horizontal swipe moves one city. Deliberately only acts once a
  // gesture is clearly horizontal, so vertical page scrolling is never
  // captured -- the CSS sets touch-action: pan-y for the same reason.
  let sx = 0, sy = 0, tracking = false;
  wall.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return;
    sx = e.touches[0].clientX; sy = e.touches[0].clientY; tracking = true;
  }, { passive: true });
  wall.addEventListener('touchend', (e) => {
    if (!tracking) return;
    tracking = false;
    const t = e.changedTouches[0];
    const dx = t.clientX - sx, dy = t.clientY - sy;
    if (Math.abs(dx) < 40 || Math.abs(dx) < Math.abs(dy) * 1.4) return;
    const rtl = document.documentElement.getAttribute('dir') === 'rtl';
    go(focus + ((dx < 0) === !rtl ? 1 : -1));
  }, { passive: true });

  // Real counts only. The previous version rendered "0" for every city
  // while the query was in flight, which reads as "Darwesh has nothing in
  // Erbil" -- a claim about inventory. index.html owns the counts and calls
  // this when they actually resolve; until then the note stays empty.
  window.DarweshCityGallery = {
    setCounts(counts) {
      planes.forEach((p, i) => {
        const note = p.querySelector('[data-city-note]');
        if (!note) return;
        const n = counts && counts[CITIES[i].key];
        note.textContent = typeof n === 'number' && n > 0
          ? n + ' ' + tr('index.cityApartments', 'apartments')
          : '';
      });
    },
    focusIndex: () => focus
  };

  paint();
})();
