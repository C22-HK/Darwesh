// Darwesh Group -- shared lightweight horizontal carousel utility.
//
// ONE implementation reused by every horizontal-scroll Home section
// (category rail, city discovery, fast-sale, activity) instead of a
// separate ad-hoc scroller per section, per the "shared carousel system"
// requirement. Wraps a real native scroll-snap container -- touch and
// trackpad already work correctly for free in every direction, including
// RTL, with zero JS -- and adds only what native scrolling doesn't give:
//   - prev/next button wiring (click -> scroll exactly ONE item forward/
//     back in READING order, not raw pixel direction)
//   - keyboard (ArrowLeft/ArrowRight while the track has focus)
//   - RTL-aware scroll direction (browsers disagree on the sign of
//     scrollLeft under dir="rtl"; feature-detected once, not guessed)
//   - disabled state on prev/next at each scroll edge
//   - prefers-reduced-motion (instant jump instead of smooth glide)
//
// No dependency, no build step -- a plain global (window.DarweshCarousel)
// like every other small module already on this page (window.cityLabel,
// window.t, etc.).
(function () {
  // Feature-detects this browser's RTL scrollLeft convention once, not
  // per-carousel. Three real behaviors exist across browsers:
  //   'default'  scrollLeft still increases 0 -> max towards the END
  //              (same sign as LTR, only the visual direction differs)
  //   'negative' scrollLeft decreases 0 -> -max towards the END
  //   'reverse'  scrollLeft starts at +max (the START) and decreases
  //              towards 0 at the END
  // Only testing tells you which one a given engine uses.
  let rtlScrollType = null;
  function detectRtlScrollType() {
    if (rtlScrollType) return rtlScrollType;
    const el = document.createElement('div');
    el.setAttribute('dir', 'rtl');
    el.style.cssText = 'position:absolute;top:-9999px;left:-9999px;width:1px;height:1px;overflow:scroll;';
    el.innerHTML = '<div style="width:2px;height:1px;"></div>';
    document.body.appendChild(el);
    if (el.scrollLeft > 0) {
      rtlScrollType = 'default';
    } else {
      el.scrollLeft = 1;
      rtlScrollType = el.scrollLeft === 0 ? 'negative' : 'reverse';
    }
    document.body.removeChild(el);
    return rtlScrollType;
  }

  function reducedMotion() {
    return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  // Exactly one item: the first child's laid-out width plus the flex gap.
  // Measured live rather than hard-coded, because the same track holds
  // cards at 320px on mobile and 380px from md up, and the gap is a clamp().
  //
  // This used to step ~85% of the track's width instead. With
  // `scroll-snap-type: x mandatory` that lands the track BETWEEN two snap
  // points, so the browser then yanks it to the nearest one -- the visible
  // "sudden jump" after every arrow click, and the reason a click could
  // advance one card or three depending on viewport width. Stepping by an
  // exact multiple of the item pitch lands on a snap point already, so the
  // snap has nothing left to correct and the glide is continuous.
  function stepAmount(track) {
    const item = track.firstElementChild;
    if (!item) return Math.max(track.clientWidth * 0.85, 220);
    const cs = getComputedStyle(track);
    const gap = parseFloat(cs.columnGap) || 0;
    const step = item.getBoundingClientRect().width + gap;
    if (!(step > 1)) return Math.max(track.clientWidth * 0.85, 220);
    // An item wider than the track (never true today) would otherwise skip
    // past content it never showed.
    return Math.min(step, track.clientWidth);
  }

  // A signed scrollLeft delta that always means "toward the next item in
  // reading order" (forward=true) or "toward the previous one"
  // (forward=false), regardless of direction or this browser's RTL quirk.
  function readingOrderDelta(track, forward) {
    const amount = stepAmount(track);
    const rtl = getComputedStyle(track).direction === 'rtl';
    if (!rtl) return forward ? amount : -amount;
    const type = detectRtlScrollType();
    const sign = type === 'default' ? 1 : -1;
    return sign * (forward ? amount : -amount);
  }

  // A snapped-at-rest track's scrollLeft is not reliably exactly 0/max --
  // measured in this exact markup at ~7px off (scroll-snap settling +
  // sub-pixel layout rounding between getBoundingClientRect() and the
  // integer scrollLeft), so a 1px tolerance left Previous/Next reading as
  // "not at the edge yet" while sitting at the true first/last card, and a
  // click there landed exactly where it started (scrollBy clamps) with no
  // disabled state to explain why. 8px comfortably covers that drift
  // without masking a real step, which is never under ~200px in practice.
  const EDGE_TOL = 8;

  function atStart(track) {
    const rtl = getComputedStyle(track).direction === 'rtl';
    if (!rtl) return track.scrollLeft <= EDGE_TOL;
    const type = detectRtlScrollType();
    if (type === 'negative') return track.scrollLeft >= -EDGE_TOL;
    if (type === 'reverse') return track.scrollLeft >= track.scrollWidth - track.clientWidth - EDGE_TOL;
    return track.scrollLeft <= EDGE_TOL; // 'default'
  }
  function atEnd(track) {
    const rtl = getComputedStyle(track).direction === 'rtl';
    const max = track.scrollWidth - track.clientWidth;
    if (max <= EDGE_TOL) return true; // nothing to scroll
    if (!rtl) return track.scrollLeft >= max - EDGE_TOL;
    const type = detectRtlScrollType();
    if (type === 'negative') return track.scrollLeft <= -(max - EDGE_TOL);
    if (type === 'reverse') return track.scrollLeft <= EDGE_TOL;
    return track.scrollLeft >= max - EDGE_TOL; // 'default'
  }

  /**
   * @param {Object} opts
   * @param {HTMLElement} opts.track The scrollable element itself
   *   (overflow-x:auto/scroll + scroll-snap already set in CSS).
   * @param {HTMLElement} [opts.prevBtn] Reading-order "backward" button.
   * @param {HTMLElement} [opts.nextBtn] Reading-order "forward" button.
   * @param {HTMLElement} [opts.leftBtn] Physically-left-positioned button
   *   (visual chevron always points left). Which scroll direction it
   *   performs is resolved from the track's CURRENT computed direction on
   *   every click and on every updateEdges() call -- not baked in once --
   *   so a live language switch (LTR<->RTL, no page reload) is correct
   *   immediately: in LTR, physical-left is "backward" (Previous); in RTL,
   *   reading order runs right-to-left, so physical-left is "forward"
   *   (Next). Use this pair instead of prevBtn/nextBtn for controls whose
   *   chevrons are fixed to a screen side rather than to a logical role.
   * @param {HTMLElement} [opts.rightBtn] Physically-right-positioned
   *   button; the mirror image of leftBtn.
   * @param {boolean} [opts.depth] Opt-in "center-forward" depth tracking:
   *   writes a `--depth` custom property (0 = centered on the track, 1 =
   *   at the horizontal edge) onto each direct child, read by
   *   css/cinematic.css to drive the focused-card-forward /
   *   neighbors-recede look. Piggybacks on this same scroll/resize
   *   listener (no second listener, no extra rAF loop) -- only carousels
   *   that ask for it pay the extra getBoundingClientRect() cost per item.
   */
  function initCarousel(opts) {
    const track = opts.track;
    if (!track || track.dataset.carouselInit === '1') return null;
    track.dataset.carouselInit = '1';
    const prevBtn = opts.prevBtn || null;
    const nextBtn = opts.nextBtn || null;
    const leftBtn = opts.leftBtn || null;
    const rightBtn = opts.rightBtn || null;
    const depthEnabled = !!opts.depth;

    function isRtl() { return getComputedStyle(track).direction === 'rtl'; }

    function go(forward) {
      track.scrollBy({ left: readingOrderDelta(track, forward), behavior: reducedMotion() ? 'auto' : 'smooth' });
    }

    function updateDepth() {
      if (!depthEnabled) return;
      const items = track.children;
      if (!items.length) return;
      const trackRect = track.getBoundingClientRect();
      const centerX = trackRect.left + trackRect.width / 2;
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const r = item.getBoundingClientRect();
        const itemCenter = r.left + r.width / 2;
        const reach = trackRect.width / 2 + r.width / 2;
        const dist = reach > 0 ? Math.min(1, Math.abs(itemCenter - centerX) / reach) : 0;
        item.style.setProperty('--depth', dist.toFixed(3));
      }
    }

    function updateEdges() {
      if (prevBtn) prevBtn.disabled = atStart(track);
      if (nextBtn) nextBtn.disabled = atEnd(track);
      // A physical button is disabled at whichever logical edge (start/end)
      // it currently resolves to -- swapped from prevBtn/nextBtn's fixed
      // mapping because leftBtn/rightBtn's OWN meaning swaps under RTL.
      if (leftBtn) leftBtn.disabled = isRtl() ? atEnd(track) : atStart(track);
      if (rightBtn) rightBtn.disabled = isRtl() ? atStart(track) : atEnd(track);
      updateDepth();
    }

    if (prevBtn) prevBtn.addEventListener('click', () => go(false));
    if (nextBtn) nextBtn.addEventListener('click', () => go(true));
    if (leftBtn) leftBtn.addEventListener('click', () => go(isRtl()));
    if (rightBtn) rightBtn.addEventListener('click', () => go(!isRtl()));

    // ArrowLeft/ArrowRight are physical-direction keys, not reading-order
    // ones (this is what every OS/browser does for horizontal scroll
    // regions), so RTL swaps which arrow means "forward".
    track.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      const rtl = getComputedStyle(track).direction === 'rtl';
      const forward = rtl ? e.key === 'ArrowLeft' : e.key === 'ArrowRight';
      e.preventDefault();
      go(forward);
    });

    let ticking = false;
    track.addEventListener('scroll', () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => { updateEdges(); ticking = false; });
    }, { passive: true });

    window.addEventListener('resize', updateEdges, { passive: true });
    updateEdges();

    return { update: updateEdges };
  }

  window.DarweshCarousel = { init: initCarousel };
})();
