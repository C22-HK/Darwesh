// Darwesh Group -- cinematic cursor follower.
//
// A decorative halo that trails the real pointer with a little lag and
// then eases back to catch up (linear interpolation each animation
// frame), and gently expands over interactive elements. It never
// receives events itself (pointer-events:none in css/cinematic.css) and
// never touches layout -- every frame writes only `transform` via
// `style.transform`, nothing else, so there is no reflow cost and no
// React/state-style re-render involved.
//
// Auto-disabled (module no-ops entirely) for touch/coarse-pointer
// devices and prefers-reduced-motion, per this task's explicit
// requirement -- checked once at init, not re-evaluated per frame.
(function () {
  'use strict';

  function shouldEnable() {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return false;
    if (window.matchMedia('(hover: none)').matches) return false;
    if (window.matchMedia('(pointer: coarse)').matches) return false;
    return true;
  }

  function init() {
    if (!shouldEnable()) return;

    const halo = document.createElement('div');
    halo.id = 'cine-cursor';
    halo.setAttribute('aria-hidden', 'true');
    document.body.appendChild(halo);

    // Real (target) position vs. rendered (lagging) position.
    let targetX = window.innerWidth / 2;
    let targetY = window.innerHeight / 2;
    let renderX = targetX;
    let renderY = targetY;
    let active = false;
    let rafId = null;

    // How much of the remaining distance to close each frame -- lower
    // = more lag/lazier catch-up, higher = snappier. .18 reads as a
    // soft, premium trail rather than a jittery gaming cursor.
    const LERP = 0.18;

    function onMove(e) {
      targetX = e.clientX;
      targetY = e.clientY;
      if (!active) {
        active = true;
        halo.classList.add('cine-cursor-active');
        renderX = targetX;
        renderY = targetY;
      }
    }

    function onLeaveWindow() {
      active = false;
      halo.classList.remove('cine-cursor-active');
    }

    function onDown() { halo.classList.add('cine-cursor-down'); }
    function onUp() { halo.classList.remove('cine-cursor-down'); }

    // Delegated hover expansion -- one listener, no per-element
    // binding, so adding/removing interactive elements elsewhere on the
    // page (dynamic wizard steps, etc.) needs no extra wiring.
    const HOVER_SELECTOR = 'a, button, input, textarea, select, [role="button"], .type-card, .auth-card';
    function onOver(e) {
      if (e.target.closest && e.target.closest(HOVER_SELECTOR)) {
        halo.classList.add('cine-cursor-hover');
      }
    }
    function onOut(e) {
      const related = e.relatedTarget;
      if (related && related.closest && related.closest(HOVER_SELECTOR)) return;
      halo.classList.remove('cine-cursor-hover');
    }

    function tick() {
      renderX += (targetX - renderX) * LERP;
      renderY += (targetY - renderY) * LERP;
      halo.style.transform = 'translate3d(' + renderX + 'px,' + renderY + 'px,0)';
      rafId = requestAnimationFrame(tick);
    }

    document.addEventListener('mousemove', onMove, { passive: true });
    document.addEventListener('mouseleave', onLeaveWindow);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('mouseup', onUp);
    document.addEventListener('mouseover', onOver, { passive: true });
    document.addEventListener('mouseout', onOut, { passive: true });

    // Pause the rAF loop while the tab is hidden -- no point animating
    // an invisible layer, and it avoids a burst of catch-up motion the
    // moment the tab becomes visible again.
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        if (rafId) cancelAnimationFrame(rafId);
        rafId = null;
      } else if (!rafId) {
        rafId = requestAnimationFrame(tick);
      }
    });

    rafId = requestAnimationFrame(tick);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
