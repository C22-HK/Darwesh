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
  // (photos, carousel mechanics, arrows/counter/transitions/mobile behavior)
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
  const pad2 = (n) => String(n).padStart(2, '0');

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
      // Replaces the old row of one-dot-per-city (busy at 8 cities) with a
      // compact "01 / 08" counter over a thin progress line -- still says
      // exactly where you are and how many cities there are, without
      // rendering eight small targets side by side.
      '<div class="w-gallery-progress">' +
        '<span class="w-gallery-count" aria-live="polite">' +
          '<span data-city-current>01</span><span class="w-gallery-count-sep">/</span><span data-city-total>' + pad2(CITIES.length) + '</span>' +
        '</span>' +
        '<span class="w-gallery-track" aria-hidden="true"><span class="w-gallery-fill" data-city-fill></span></span>' +
      '</div>' +
      '<button type="button" class="w-icon-btn" data-city-next aria-label="' + esc(tr('common.next', 'Next')) + '">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 18l6-6-6-6"/></svg>' +
      '</button>' +
    '</div>';

  const planes = Array.prototype.slice.call(mount.querySelectorAll('.w-plane'));
  const currentEl = mount.querySelector('[data-city-current]');
  const fillEl = mount.querySelector('[data-city-fill]');
  // #cityWall is the OUTER '.w-gallery' div (id kept for backward
  // compatibility with this variable name) -- on the desktop cascade it is
  // just the positioning context; on the mobile breakpoint
  // (css/home-world.css) it becomes the real horizontally-scrolling element,
  // so it is also what a native swipe/scrollIntoView acts on there.
  const wall = mount.querySelector('#cityWall');

  const isMobileCarousel = () => window.matchMedia('(max-width: 767px)').matches;
  const prefersReducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // The one write. Everything spatial is derived in CSS from --o, so this
  // touches a few properties per plane and nothing else -- no layout reads,
  // no geometry maths in JS.
  //
  // --o is the CIRCULAR signed offset from focus, wrapped into the shortest
  // arc (e.g. with 8 cities, at focus=0 city 7's raw offset is +7, but its
  // circular offset is -1 -- it IS the previous city, not seven cities
  // away). Without this, index 0's previous and the last index's next had
  // no neighbour to show at all (bug: "only 2 cards visible" at the
  // boundaries) -- go() below wraps focus itself the same way, so clicking
  // prev/next always has somewhere real to land.
  function circularOffset(i, focus, n) {
    let o = i - focus;
    if (o > n / 2) o -= n;
    else if (o < -n / 2) o += n;
    return o;
  }

  function paint() {
    const n = CITIES.length;
    for (let i = 0; i < planes.length; i++) {
      const o = circularOffset(i, focus, n);
      const near = Math.abs(o) <= 1;
      planes[i].style.setProperty('--o', String(o));
      planes[i].setAttribute('data-focus', o === 0 ? '1' : '0');
      // Desktop cascade shows only the focused card and one neighbour on
      // each side -- css/home-world.css's [data-near="0"] rule hides
      // everything past that entirely (not just dims it), so ARIA mirrors
      // the same cutoff rather than the old "hidden past two steps" one.
      // The mobile carousel ignores data-near (every card is real, reachable
      // by scroll) so this only matters on the desktop cascade.
      planes[i].setAttribute('data-near', near ? '1' : '0');
      // Desktop cascade: only the focused plane is in the tab order, since a
      // wall of hidden links behind each other is a keyboard trap and the
      // arrows/dots are the real navigation there. Mobile carousel: every
      // card is a normal, reachable tab stop -- the browser's own
      // scroll-into-view-on-focus is exactly the right behaviour for a real
      // horizontal scroller.
      planes[i].tabIndex = isMobileCarousel() ? 0 : (o === 0 ? 0 : -1);
      planes[i].setAttribute('aria-hidden', (!isMobileCarousel() && !near) ? 'true' : 'false');
    }
    if (currentEl) currentEl.textContent = pad2(focus + 1);
    if (fillEl) fillEl.style.width = ((focus / Math.max(1, CITIES.length - 1)) * 100) + '%';
  }

  // opts.fromScroll: true when this call is only syncing state to a scroll
  // the user already performed (see the mobile scroll listener below) --
  // scrolling the container again there would fight the gesture still
  // settling under the user's finger.
  function go(next, opts) {
    // Wraps circularly (08 -> 01 going next, 01 -> 08 going previous)
    // instead of clamping dead at the ends -- matches paint()'s own
    // circularOffset() above, so prev/next always has a real neighbour to
    // land on. The double-modulo handles a negative `next` correctly (JS's
    // % can return a negative remainder).
    const n = CITIES.length;
    focus = ((next % n) + n) % n;
    paint();
    if (isMobileCarousel() && (!opts || !opts.fromScroll)) {
      planes[focus].scrollIntoView({
        behavior: prefersReducedMotion() ? 'auto' : 'smooth',
        inline: 'center',
        block: 'nearest'
      });
    }
  }

  // Mobile: native scroll-snap is the primary gesture (real touch scroll,
  // not the synthetic swipe below), so arrows/dots/keyboard need to hear
  // back from it -- otherwise the dots and the focused-card styling would
  // silently drift out of sync the moment someone swipes with a finger
  // instead of tapping an arrow. Whichever plane's center sits nearest the
  // container's center after scrolling settles becomes the new focus.
  let scrollSyncRaf = null;
  wall.addEventListener('scroll', () => {
    if (!isMobileCarousel()) return;
    if (scrollSyncRaf) cancelAnimationFrame(scrollSyncRaf);
    scrollSyncRaf = requestAnimationFrame(() => {
      scrollSyncRaf = null;
      const wallRect = wall.getBoundingClientRect();
      const wallCenter = wallRect.left + wallRect.width / 2;
      let nearest = 0, nearestDist = Infinity;
      planes.forEach((p, i) => {
        const r = p.getBoundingClientRect();
        const dist = Math.abs((r.left + r.width / 2) - wallCenter);
        if (dist < nearestDist) { nearestDist = dist; nearest = i; }
      });
      if (nearest !== focus) go(nearest, { fromScroll: true });
    });
  }, { passive: true });

  mount.querySelector('[data-city-prev]').addEventListener('click', () => go(focus - 1));
  mount.querySelector('[data-city-next]').addEventListener('click', () => go(focus + 1));

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

  // Touch: a horizontal swipe moves one city -- but only on the desktop/
  // tablet cascade, where the wall itself does not scroll and this synthetic
  // gesture is the only way a touch drag can move it. The mobile breakpoint
  // is a real native scroll-snap container (css/home-world.css); the browser
  // already handles that drag, and firing go() again on top of an in-flight
  // native snap would fight it and produce a visible stutter. Deliberately
  // only acts once a gesture is clearly horizontal, so vertical page
  // scrolling is never captured -- the CSS sets touch-action: pan-y for the
  // desktop/tablet cascade for the same reason (mobile's real scroller sets
  // its own touch-action via overflow-x:auto).
  let sx = 0, sy = 0, tracking = false;
  wall.addEventListener('touchstart', (e) => {
    if (isMobileCarousel()) return;
    if (e.touches.length !== 1) return;
    sx = e.touches[0].clientX; sy = e.touches[0].clientY; tracking = true;
  }, { passive: true });
  wall.addEventListener('touchend', (e) => {
    if (isMobileCarousel()) return;
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
