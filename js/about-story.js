// Darwesh Group -- About page scroll choreography.
//
// Exactly two mechanisms, matching css/about-story.css's header comment:
//
//   1. The hero's `--hp` (0..1): the ONE scroll-scrubbed "camera" moment on
//      the page. Computed from `.ab2-hero-pin`'s own bounding rect (the
//      same "read every rect first, write every style after, one rAF,
//      dirty-flag gated" discipline as js/cine-scroll-3d.js) rather than
//      importing that engine -- this page has exactly one flowed element,
//      not a document-wide `[data-flow]` system, so a dozen lines here
//      replace what would otherwise be a second, unrelated dependency.
//   2. Each of the 12 `.ab2-scene` elements gets `.is-active` ONCE, the
//      first time it is ~30% into the viewport, via a single shared
//      IntersectionObserver -- never re-triggered, never one observer per
//      scene. Text itself is revealed by the page's existing
//      js/reveal.js (.cine-reveal / window.DarweshReveal), already loaded
//      by about.html; this file only drives each scene's own graphic.
//
// Never calls preventDefault on wheel/touch and never calls scrollTo --
// native scrolling is untouched throughout. Under prefers-reduced-motion,
// this script does the least possible: the hero's `--hp` is set once to
// its resting value and no listener is attached at all; the CSS's own
// `@media (prefers-reduced-motion: reduce)` block already forces every
// scene to its finished state with plain selectors (no `.is-active`
// needed), so skipping the observer there loses nothing.
(function () {
  function reducedMotion() {
    return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  function clamp01(n) { return n < 0 ? 0 : n > 1 ? 1 : n; }

  function initHero() {
    const pin = document.querySelector('.ab2-hero-pin');
    const stage = document.querySelector('.ab2-hero-stage');
    if (!pin || !stage) return;

    if (reducedMotion()) {
      stage.style.setProperty('--hp', '0.62');
      return;
    }

    let dirty = true;
    let hidden = false;
    let rafId = null;
    let last = -1;
    const EPSILON = 0.002;

    function frame() {
      rafId = null;
      if (!dirty || hidden) return;
      dirty = false;
      const rect = pin.getBoundingClientRect();
      const vh = window.innerHeight;
      const span = rect.height - vh;
      const p = span > 0 ? clamp01(-rect.top / span) : 0;
      if (Math.abs(p - last) >= EPSILON) {
        last = p;
        stage.style.setProperty('--hp', p.toFixed(4));
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

  function initScenes() {
    const scenes = Array.from(document.querySelectorAll('.ab2-scene'));
    if (!scenes.length) return;

    if (reducedMotion() || !('IntersectionObserver' in window)) {
      scenes.forEach((el) => el.classList.add('is-active'));
      return;
    }

    const io = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-active');
          io.unobserve(entry.target);
        }
      });
    }, { rootMargin: '0px 0px -15% 0px', threshold: 0.3 });

    scenes.forEach((el) => io.observe(el));
  }

  function start() {
    initHero();
    initScenes();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})();
