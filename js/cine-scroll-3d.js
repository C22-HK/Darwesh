// Darwesh Group -- scroll choreography controller.
//
// THE RULE THIS FILE EXISTS TO ENFORCE: sections are never animated.
// Elements inside them are.
//
// The previous version animated whole scenes. It gave every `[data-cine3d]`
// section a scroll-driven z-index so the centred one painted over its
// neighbours, and CSS moved entire copy blocks 34px up and 140px back in Z
// as a unit. Both were deliberate, and together they produced exactly the
// thing this rewrite deletes: rectangular panels visibly sliding over one
// another, a shop-shutter rolling up, content stacked behind content. A
// section is a box; anything that animates a section animates a box, and a
// moving box reads as a door however softly it is eased.
//
// So this controller writes no z-index at all, and knows nothing about
// "sections" as animated objects. It writes two things:
//
//   --journey   ONE number on <html>, 0 at the top of the document to 1 at
//               the bottom. The persistent world's atmosphere is a pure
//               function of it (css/home-world.css's .world-field), which
//               is what keeps the background continuous: there is no
//               per-section value anywhere, so there is no scroll position
//               at which the ground can step.
//
//   --fp        ONE number per `[data-flow]` ELEMENT -- a headline, a
//               photograph, a paragraph -- describing that element's own
//               travel through the viewport, 0 entering from the bottom to
//               1 leaving past the top. Because it is derived from the
//               element's own box, a headline and the image beside it hold
//               DIFFERENT values at the same instant, and they desynchronise
//               on their own. That is the whole mechanism: nothing shares a
//               progress value, so nothing can move as a block.
//
// CSS turns --fp into role-specific motion (see home-world.css section 3),
// so tuning the feel never needs a script change.
//
// It no longer writes --section-progress at all. That value existed only to
// feed css/cinematic.css's [data-cine3d] SECTION recipe, and index.html is
// the only page in this repository that carries a data-cine3d attribute or
// loads this controller (checked, not assumed -- login.html and signup.html
// load cinematic.css for its palette and use none of its scroll rules). So
// with Home's sections neutralised the value had no reader anywhere, and
// computing it was a layout read plus a style write per section per frame
// for nothing. The rules themselves are left in cinematic.css rather than
// deleted: removing them is a bigger change than this pass is scoped to.
//
// Performance, unchanged from the previous version and still load-bearing:
//   - ONE passive scroll listener for the whole page, flipping a dirty
//     flag; the work happens in ONE requestAnimationFrame callback, never
//     one per element and never synchronously inside the scroll handler
//   - every getBoundingClientRect() (a layout READ) happens first, in one
//     batch; every style write happens after, in a second batch -- reads
//     and writes are never interleaved
//   - a write is skipped entirely when the value has not moved enough to
//     be seen, which is most elements on most frames
//   - paused while the tab is hidden; never attached at all under
//     prefers-reduced-motion
(function () {
  const FLOW_SELECTOR = '[data-flow]';
  const MOBILE_QUERY = '(max-width: 767px)';

  // Below this delta a rewrite is invisible, so it is not made. Custom
  // property writes invalidate style for the subtree, and at 60fps most
  // elements move a fraction of this between frames.
  const EPSILON = 0.0015;

  function prefersReducedMotion() {
    return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  // The `cine3d-mobile` tier exists for css/cinematic.css's SECTION recipe:
  //
  //   .cine3d-mobile [data-cine3d] {
  //     transform: translate3d(0, calc(var(--d, 0) * 12px), 0) !important;
  //     opacity: calc(1 - var(--d, 0) * 0.22) !important; }
  //
  // It is a lighter phone version of the same whole-section movement, and
  // on Home it is still whole-section movement -- 12px of travel and a 22%
  // fade applied to a <section>. Because it is !important it also wins
  // against Home's own neutralisation, which is exactly how it survived the
  // first pass of this rewrite: desktop measured clean while every mobile
  // section still carried a transform.
  //
  // Home does not use the cinematic section recipe at any width any more,
  // so it does not get the tier that lightens it. The toggle itself is kept
  // rather than deleted so that any future page adopting [data-cine3d]
  // still tiers correctly; today Home is the only page that loads this
  // controller at all.
  function applyTier() {
    const worldPage = document.body && document.body.classList.contains('world');
    const mobile = !worldPage && window.matchMedia && window.matchMedia(MOBILE_QUERY).matches;
    document.documentElement.classList.toggle('cine3d-mobile', !!mobile);
  }

  function clamp01(n) { return n < 0 ? 0 : n > 1 ? 1 : n; }

  // An ELEMENT's own travel through the viewport.
  //   0    its top edge is at the bottom of the viewport
  //   0.5  it is around the middle
  //   1    its bottom edge has passed the top
  //
  // The element's height is capped before it enters the span so that a tall
  // block and a one-line headline travel at comparable rates. Without the
  // cap a 900px grid would still be easing in long after the reader had
  // arrived at it, which is the "waiting for an animation" feeling this is
  // supposed to avoid.
  function flowProgress(rect, viewportH) {
    const h = Math.min(rect.height, viewportH * 0.6);
    const span = viewportH + h;
    if (span <= 0) return 0.5;
    return clamp01((viewportH - rect.top) / span);
  }

  function start() {
    const flows = Array.from(document.querySelectorAll(FLOW_SELECTOR));
    if (!flows.length) return;

    if (prefersReducedMotion()) {
      // Everything at its designed resting position, and no listener at
      // all. --fp 0.5 is mid-hold: fully entered, not yet leaving. The
      // world still gets an atmosphere -- parked at the warm station rather
      // than left at the unlit start of a journey this visitor will never
      // travel.
      flows.forEach((el) => el.style.setProperty('--fp', '0.5'));
      document.documentElement.style.setProperty('--journey', '0.34');
      return;
    }

    applyTier();
    window.addEventListener('resize', applyTier, { passive: true });

    // Last value actually written, so an unchanged element costs one
    // subtraction instead of a style invalidation.
    const lastFlow = new Array(flows.length).fill(-1);

    let dirty = true;   // run once on load to set the initial state
    let hidden = false;
    let rafId = null;

    function frame() {
      rafId = null;
      if (!dirty || hidden) return;
      dirty = false;
      const vh = window.innerHeight;
      const doc = document.documentElement;

      // ---- Batch 1: reads. Nothing is written before this completes. ----
      const flowValues = flows.map((el) => flowProgress(el.getBoundingClientRect(), vh));
      const span = doc.scrollHeight - vh;
      const journey = span > 0 ? clamp01(window.scrollY / span) : 0;
      const scrolled = window.scrollY > 40;

      // ---- Batch 2: writes. ----
      doc.style.setProperty('--journey', journey.toFixed(4));
      // The header's own state rides this frame rather than adding a
      // second scroll listener.
      document.body.classList.toggle('w-scrolled', scrolled);

      for (let i = 0; i < flows.length; i++) {
        if (Math.abs(flowValues[i] - lastFlow[i]) < EPSILON) continue;
        lastFlow[i] = flowValues[i];
        flows[i].style.setProperty('--fp', flowValues[i].toFixed(4));
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
