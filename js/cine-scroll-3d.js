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

    if (prefersReducedMotion()) {
      // Settled, natural position -- no depth offset -- and never attach
      // a scroll listener at all.
      els.forEach((el) => el.style.setProperty('--section-progress', '1'));
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
      // Batch 2: writes.
      for (let i = 0; i < els.length; i++) {
        els[i].style.setProperty('--section-progress', values[i].toFixed(4));
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
