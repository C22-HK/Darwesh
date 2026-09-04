// Darwesh Group -- shared lightweight horizontal carousel utility.
//
// ONE implementation reused by every horizontal-scroll Home section
// (category rail, city discovery, fast-sale, activity) instead of a
// separate ad-hoc scroller per section, per the "shared carousel system"
// requirement. Wraps a real native scroll-snap container -- touch and
// trackpad already work correctly for free in every direction, including
// RTL, with zero JS -- and adds only what native scrolling doesn't give:
//   - prev/next button wiring (click -> scroll one "page" forward/back
//     in READING order, not raw pixel direction)
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

  function pageAmount(track) {
    // One viewport's worth, held back slightly so the next item is never
    // fully hidden behind the previous page's trailing edge.
    return Math.max(track.clientWidth * 0.85, 220);
  }

  // A signed scrollLeft delta that always means "toward the next item in
  // reading order" (forward=true) or "toward the previous one"
  // (forward=false), regardless of direction or this browser's RTL quirk.
  function readingOrderDelta(track, forward) {
    const amount = pageAmount(track);
    const rtl = getComputedStyle(track).direction === 'rtl';
    if (!rtl) return forward ? amount : -amount;
    const type = detectRtlScrollType();
    const sign = type === 'default' ? 1 : -1;
    return sign * (forward ? amount : -amount);
  }

  function atStart(track) {
    const rtl = getComputedStyle(track).direction === 'rtl';
    if (!rtl) return track.scrollLeft <= 1;
    const type = detectRtlScrollType();
    if (type === 'negative') return track.scrollLeft >= -1;
    if (type === 'reverse') return track.scrollLeft >= track.scrollWidth - track.clientWidth - 1;
    return track.scrollLeft <= 1; // 'default'
  }
  function atEnd(track) {
    const rtl = getComputedStyle(track).direction === 'rtl';
    const max = track.scrollWidth - track.clientWidth;
    if (max <= 1) return true; // nothing to scroll
    if (!rtl) return track.scrollLeft >= max - 1;
    const type = detectRtlScrollType();
    if (type === 'negative') return track.scrollLeft <= -(max - 1);
    if (type === 'reverse') return track.scrollLeft <= 1;
    return track.scrollLeft >= max - 1; // 'default'
  }

  /**
   * @param {Object} opts
   * @param {HTMLElement} opts.track The scrollable element itself
   *   (overflow-x:auto/scroll + scroll-snap already set in CSS).
   * @param {HTMLElement} [opts.prevBtn]
   * @param {HTMLElement} [opts.nextBtn]
   */
  function initCarousel(opts) {
    const track = opts.track;
    if (!track || track.dataset.carouselInit === '1') return null;
    track.dataset.carouselInit = '1';
    const prevBtn = opts.prevBtn || null;
    const nextBtn = opts.nextBtn || null;

    function go(forward) {
      track.scrollBy({ left: readingOrderDelta(track, forward), behavior: reducedMotion() ? 'auto' : 'smooth' });
    }

    function updateEdges() {
      if (prevBtn) prevBtn.disabled = atStart(track);
      if (nextBtn) nextBtn.disabled = atEnd(track);
    }

    if (prevBtn) prevBtn.addEventListener('click', () => go(false));
    if (nextBtn) nextBtn.addEventListener('click', () => go(true));

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
