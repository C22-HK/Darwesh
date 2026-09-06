// Darwesh Group -- lightweight cinematic 3D scroll-depth controller.
//
// ONE centralized scroll controller for the whole page (never one
// listener per section) that computes a 0->1 "how far through the
// viewport is this section" progress value for every element carrying
// `data-cine3d`, and writes it to that element's `--section-progress`
// custom property. All the actual visual recipe (translate3d, scale,
// rotateX, opacity) lives in CSS keyed off that one variable -- see
// css/cinematic.css's `[data-cine3d]` rules -- so tuning the look never
// needs a script change, and different `data-cine3d="hero|rail|city|
// cards|promo"` values can each carry their own CSS formula while
// sharing this one JS engine.
//
// Performance, per the "no layout thrashing / one controller" brief:
//   - a single passive `scroll` listener flips a dirty flag; the actual
//     work happens in ONE requestAnimationFrame callback per frame, never
//     one per section and never synchronously inside the scroll handler
//   - every section's `getBoundingClientRect()` (a layout READ) happens
//     first, in one batch; every `style.setProperty` (a WRITE) happens
//     after, in a second batch -- reads and writes are never interleaved
//   - paused entirely while the tab is hidden (`visibilitychange`)
//   - paused entirely under `prefers-reduced-motion: reduce` -- CSS's own
//     reduced-motion block also forces --section-progress:1 so sections
//     render in their natural resting position with no JS involvement
//   - re-tiers between "desktop" and "mobile" intensity on resize
//     (matchMedia), never runs a second parallel loop for mobile
(function () {
  const SELECTOR = '[data-cine3d]';
  const MOBILE_QUERY = '(max-width: 767px)';

  function prefersReducedMotion() {
    return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  function applyTier() {
    const mobile = window.matchMedia && window.matchMedia(MOBILE_QUERY).matches;
    document.documentElement.classList.toggle('cine3d-mobile', !!mobile);
  }

  function progressFor(rect, viewportH) {
    // 0   = section's top edge just entered the bottom of the viewport
    // 0.5 = section is vertically centered in the viewport
    // 1   = section's top edge has reached the top of the viewport
    // Clamped so a very tall section (taller than the viewport) still
    // settles at a real value instead of overshooting past 1.
    const span = viewportH + rect.height;
    if (span <= 0) return 1;
    const raw = (viewportH - rect.top) / span;
    return Math.min(1, Math.max(0, raw));
  }

  function start() {
    const els = Array.from(document.querySelectorAll(SELECTOR));
    if (!els.length) return;

    // Which of these are SCENES (siblings in the page's vertical flow) and
    // which are LAYERS INSIDE a scene. Only scenes take part in occlusion
    // ordering. A layer -- the hero's background media plate, say -- is
    // positioned within its scene's own stacking context and already has a
    // deliberate z-index there; overwriting it lifts the background over the
    // foreground. That is exactly the regression this guard exists to stop:
    // hero-media was being given z-index 46 and painting the plate on top of
    // the hero headline and the search field.
    const isScene = els.map((el) => !el.parentElement.closest(SELECTOR));

    if (prefersReducedMotion()) {
      // Settled, natural position -- no depth offset -- and never attach
      // a scroll listener at all. The world still gets an atmosphere: it is
      // parked at the warm station rather than left at night, so a
      // reduced-motion visitor gets a composed, deliberate environment
      // instead of the unlit start of a journey they will never travel.
      els.forEach((el) => el.style.setProperty('--section-progress', '1'));
      document.documentElement.style.setProperty('--journey', '0.34');
      return;
    }

    applyTier();
    window.addEventListener('resize', applyTier, { passive: true });

    let dirty = true; // run once on load to set initial state
    let hidden = false;
    let rafId = null;

    function frame() {
      rafId = null;
      if (!dirty || hidden) return;
      dirty = false;
      const vh = window.innerHeight;
      // Batch 1: reads.
      const values = els.map((el) => progressFor(el.getBoundingClientRect(), vh));
      // ONE more read, for the whole-document journey: 0 at the top, 1 at
      // the bottom. Every atmospheric property of the persistent world is a
      // function of this single number, which is what makes the tonal
      // evolution continuous -- there is no per-section value anywhere, so
      // there is no scroll position at which the world can step.
      const doc = document.documentElement;
      const span = doc.scrollHeight - vh;
      const journey = span > 0 ? Math.min(1, Math.max(0, window.scrollY / span)) : 0;
      // Batch 2: writes.
      doc.style.setProperty('--journey', journey.toFixed(4));
      // The header's own state rides the same frame rather than adding a
      // second scroll listener.
      document.body.classList.toggle('w-scrolled', window.scrollY > 40);
      for (let i = 0; i < els.length; i++) {
        els[i].style.setProperty('--section-progress', values[i].toFixed(4));
        // OCCLUSION ORDER. Occlusion -- one thing visibly covering another
        // -- is the strongest depth cue human vision has, and it is the one
        // the earlier passes never used: the scenes all sat in their own
        // vertical bands and no plane ever crossed another, so nothing was
        // ever "in front". Paint order now follows distance from the centre
        // of the viewport, so the scene the user is actually looking at
        // overlaps the ones leaving above and arriving below.
        //
        // Written here rather than derived in CSS because z-index needs an
        // integer and calc() on a custom property is only reliable behind
        // @property registration. It costs one extra style write per scene
        // per frame, inside the existing write batch -- no extra layout
        // read, no second loop.
        //
        // APERTURE. A movement containing one opens its shutters as it
        // advances, uncovering the world behind the previous composition
        // rather than starting a new section below it. Driven from the same
        // progress value in the same write batch -- no extra listener, no
        // second loop. Mapped so the opening completes early (by 45% of the
        // movement's travel) and then simply stays open, which keeps the
        // reveal a moment rather than a thing that tracks your scrollbar.
        const ap = els[i].querySelector('.w-aperture');
        if (ap) ap.style.setProperty('--ap', Math.min(1, values[i] / 0.45).toFixed(4));

        // Scenes only: a layer nested inside a scene keeps whatever z-index
        // its own scene gave it (see isScene above).
        if (!isScene[i]) continue;
        const centred = 1 - Math.abs(values[i] - 0.5) * 2;
        els[i].style.zIndex = String(10 + Math.round(centred * 40));
      }
    }

    function schedule() {
      dirty = true;
      if (rafId == null) rafId = requestAnimationFrame(frame);
    }

    window.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule, { passive: true });
    document.addEventListener('visibilitychange', () => {
      hidden = document.hidden;
      if (!hidden) schedule();
    });

    schedule();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})();
