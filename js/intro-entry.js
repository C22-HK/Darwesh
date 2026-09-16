// Darwesh Group -- cinematic entry/intro overlay.
//
// Presentation only. This never gates authentication, never blocks a
// signed-in session, and never re-shows itself mid-session -- it is
// purely a first-paint flourish over the homepage, controlled entirely
// by a sessionStorage flag (see the tiny inline script next to the
// overlay markup in index.html, which un-hides the overlay before
// first paint only when that flag is absent, exactly like this
// codebase's existing lang/dir bootstrap script does for language).
//
// A plain click, tap, or Enter/Space (native <button> behavior, no
// extra keyboard wiring needed) enters immediately -- that is the one
// real, always-available path. Holding the pointer down sweeps a
// progress ring as a decorative flourish only; releasing early cancels
// the ring but the click that already fired on release still enters,
// so the control can never feel "stuck."
import { createAudioController } from './audio-controller.js';

(function () {
  'use strict';

  const overlay = document.getElementById('cine-intro');
  if (!overlay) return;

  const SEEN_KEY = 'darwesh_intro_seen';
  // P0-6: cross-session marker, read by the inline bootstrap script next
  // to #cine-intro in index.html -- kept in sync with that literal
  // string by hand, same as SEEN_KEY already is. Bump the ":v2" suffix
  // in BOTH places together when the Welcome changes materially.
  const WELCOME_VERSION_KEY = 'darweshWelcomeSeen:v2';
  const enterBtn = document.getElementById('cineEnterBtn');
  const ringCircle = overlay.querySelector('.cine-enter-ring circle');
  const audioToggle = document.getElementById('cineAudioToggle');
  const audio = createAudioController();

  function tr(key, fallback) { return (window.t && window.t(key)) || fallback; }

  audio.bindToggle(audioToggle, {
    enable: tr('intro.audioEnable', 'Enable ambient sound'),
    disable: tr('intro.audioDisable', 'Mute ambient sound')
  });

  const CIRCUMFERENCE = 377; // 2 * pi * 60, matches the SVG r=60 in the markup
  const HOLD_MS = 700;
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  let holding = false;
  let holdStart = 0;
  let holdRaf = null;
  let entered = false;

  function setRingProgress(fraction) {
    if (!ringCircle) return;
    const offset = CIRCUMFERENCE * (1 - Math.min(1, Math.max(0, fraction)));
    ringCircle.style.strokeDashoffset = String(offset);
  }

  function holdTick(now) {
    if (!holding) return;
    const elapsed = now - holdStart;
    setRingProgress(elapsed / HOLD_MS);
    if (elapsed >= HOLD_MS) {
      holding = false;
      return; // the concurrent native click on release still calls enter()
    }
    holdRaf = requestAnimationFrame(holdTick);
  }

  function startHold() {
    if (reduceMotion) return; // decorative only -- skip entirely under reduced motion
    if (ringDrawRaf) { cancelAnimationFrame(ringDrawRaf); ringDrawRaf = null; } // don't fight the initial reveal-draw
    holding = true;
    holdStart = performance.now();
    enterBtn.setAttribute('data-holding', 'true');
    holdRaf = requestAnimationFrame(holdTick);
  }

  function cancelHold() {
    holding = false;
    if (holdRaf) cancelAnimationFrame(holdRaf);
    holdRaf = null;
    enterBtn.removeAttribute('data-holding');
    setRingProgress(0);
  }

  function markSeen() {
    try { sessionStorage.setItem(SEEN_KEY, '1'); } catch (_err) { /* private mode -- non-fatal, intro just re-shows next load */ }
    try { localStorage.setItem(WELCOME_VERSION_KEY, '1'); } catch (_err) { /* private mode -- non-fatal, intro just re-shows next session too */ }
  }

  // ---- Mobile radial orbit ------------------------------------------
  // Only 3-4 of the 10 platform pillars are ever visible at once on
  // mobile, positioned at fixed top/right/bottom/left slots around the
  // Enter ring (see .cine-mobile-orbit-chip[data-slot] in cinematic.css).
  // This assigns which 4 chips currently hold those slots and, before
  // Enter is pressed, slowly cycles which 4 they are -- a calm "orbital
  // drift" rather than the desktop's ten-at-once diagram. Entirely
  // inert on desktop (mobileChips is still queried, but nothing here
  // renders unless the <=899px breakpoint's CSS is active).
  const MOBILE_SLOT_ORDER = ['top', 'right', 'bottom', 'left'];
  const mobileChips = Array.prototype.slice.call(overlay.querySelectorAll('.cine-mobile-orbit-chip'));
  const isMobileViewport = window.matchMedia('(max-width: 899px)');
  let mobileOrbitCycle = 0;
  let mobileOrbitTimer = null;

  function applyMobileOrbitCycle() {
    if (!mobileChips.length) return;
    mobileChips.forEach((chip) => chip.removeAttribute('data-slot'));
    MOBILE_SLOT_ORDER.forEach((slot, slotIndex) => {
      const chipIndex = (mobileOrbitCycle * MOBILE_SLOT_ORDER.length + slotIndex) % mobileChips.length;
      mobileChips[chipIndex].setAttribute('data-slot', slot);
    });
  }

  function startMobileOrbitDrift() {
    applyMobileOrbitCycle();
    // Reduced motion / desktop: one static, correctly-assigned set of 4
    // slots is enough -- no reason to add a recurring timer that would
    // just reassign the same kind of thing again with no visible change
    // in reduced motion, or run pointlessly off-screen on desktop.
    if (reduceMotion || !isMobileViewport.matches) return;
    mobileOrbitTimer = window.setInterval(() => {
      mobileOrbitCycle += 1;
      applyMobileOrbitCycle();
    }, 5800);
  }

  function stopMobileOrbitDrift() {
    if (mobileOrbitTimer) { window.clearInterval(mobileOrbitTimer); mobileOrbitTimer = null; }
  }

  // ---- Cinematic reveal sequence -----------------------------------
  // Passive scenes (dark -> line -> portal -> points -> core) run once
  // on load and end WAITING for the user -- nothing here ever
  // auto-enters. Classes are additive (never removed) so cinematic.css
  // can read each one as "this scene has been reached", matching how a
  // static stylesheet can't express ">=" on its own. Reduced motion
  // skips straight to the resting "core visible" state, per spec.
  const PASSIVE_TIMINGS = { dark: 400, line: 700, portal: 900, points: 700 };
  let ringDrawRaf = null;

  function addScene(name) { overlay.classList.add('is-' + name); }

  function drawEnterRing(durationMs, onDone) {
    if (!ringCircle) { if (onDone) onDone(); return; }
    if (reduceMotion) { setRingProgress(1); if (onDone) onDone(); return; }
    const start = performance.now();
    function tick(now) {
      const fraction = Math.min(1, (now - start) / durationMs);
      setRingProgress(fraction);
      if (fraction < 1) {
        ringDrawRaf = requestAnimationFrame(tick);
      } else if (onDone) {
        onDone();
      }
    }
    ringDrawRaf = requestAnimationFrame(tick);
  }

  function runIntroSequence() {
    if (reduceMotion) {
      // Scene 01-04 are motion (a sweeping line, sliding panels, flying
      // points) -- spec: "no moving portal panels... simple opacity
      // reveals" under reduced motion, so skip straight to the core
      // reveal at rest (drawEnterRing's own reduced-motion branch sets
      // the ring to fully drawn instantly).
      addScene('core');
      drawEnterRing(0);
      startMobileOrbitDrift();
      return;
    }
    let t = 0;
    window.setTimeout(() => addScene('line'), (t += PASSIVE_TIMINGS.dark));
    window.setTimeout(() => addScene('portal'), (t += PASSIVE_TIMINGS.line));
    window.setTimeout(() => addScene('points'), (t += PASSIVE_TIMINGS.portal));
    window.setTimeout(() => {
      addScene('core');
      drawEnterRing(600);
      startMobileOrbitDrift();
    }, (t += PASSIVE_TIMINGS.points));
  }

  // ---- Exit (shared by the cinematic Enter path and the immediate
  // Skip/Escape path) --------------------------------------------------
  function fadeAndHide() {
    document.body.classList.remove('cine-intro-open');
    overlay.setAttribute('data-leaving', 'true');
    // P0-1: matches #cine-intro's CSS transition duration exactly (see
    // css/cinematic.css) -- 380ms normal, 150ms reduced-motion. Was
    // 650ms here against a 600ms CSS transition even before this pass
    // (a pre-existing, harmless-but-sloppy mismatch); now both numbers
    // are the single source of truth for "how long the exit fade takes."
    const fadeMs = reduceMotion ? 150 : 380;
    window.setTimeout(() => { overlay.hidden = true; }, fadeMs);
  }

  // PERFORMANCE FOUNDATION (P0-1): Enter used to run a four-stage
  // ~4.6s buildup (entering -> expanded -> orbit-sweep -> exiting-depth)
  // before Home ever appeared, regardless of how quickly the user
  // clicked -- a hard violation of "Enter must be immediate" measured
  // directly from this file's own former setTimeout chain (480+900+
  // 1650+950 = 3980ms of forced animation, on top of fadeAndHide's own
  // fade). Enter now does exactly what Skip already did (see
  // skipImmediately() below, which never had this problem): call
  // fadeAndHide() immediately. That function sets data-leaving="true"
  // synchronously, and cinematic.css's `#cine-intro[data-leaving="true"]`
  // rule sets pointer-events:none in that same synchronous style
  // recalculation -- so Home underneath is genuinely interactive within
  // a frame of the click, not after a multi-second sequence. The visible
  // dissolve on top of that is real but decorative and non-blocking (see
  // cinematic.css's tightened 380ms/150ms-reduced-motion #cine-intro
  // transition), matching the brief's ~250-450ms "Enter -> usable Home"
  // target for when the overlay is fully gone, while the *functional*
  // handoff happens far sooner than that.
  //
  // The old four-stage orbit-sweep choreography is intentionally not
  // preserved in any compressed form here: replaying it inside a ~400ms
  // budget would be illegible, and this Welcome's entire visual design
  // (including the orbit/node diagram those stages animated) is already
  // scheduled for full replacement in the separately-approved Phase 02
  // rebuild, not extended here. The matching is-entering/is-expanded/
  // is-orbit-sweep/is-exiting-depth rules in cinematic.css are simply
  // unused now rather than removed -- they cost nothing at runtime since
  // nothing adds those classes anymore, and Phase 02 replaces this
  // file's CSS wholesale rather than editing it in place.
  function enter() {
    if (entered) return;
    entered = true;
    markSeen();
    // Must run synchronously inside this real user-gesture handler --
    // audio-controller.js itself never calls play() from anywhere else.
    audio.startFromUserGesture();
    if (ringDrawRaf) cancelAnimationFrame(ringDrawRaf);
    stopMobileOrbitDrift();
    fadeAndHide();
  }

  // Skip/Escape keep their original meaning -- "let me leave right now"
  // -- and deliberately bypass the multi-second ecosystem reveal so a
  // visitor who wants out isn't forced to sit through it.
  function skipImmediately() {
    if (entered) return;
    entered = true;
    markSeen();
    audio.startFromUserGesture();
    if (ringDrawRaf) cancelAnimationFrame(ringDrawRaf);
    stopMobileOrbitDrift();
    fadeAndHide();
  }

  enterBtn.addEventListener('click', enter);

  // Visible skip -- same immediate-exit action as Escape, just without
  // asking the visitor to discover the key first.
  const skipBtn = document.getElementById('cineSkipBtn');
  if (skipBtn) skipBtn.addEventListener('click', skipImmediately);

  enterBtn.addEventListener('mousedown', startHold);
  enterBtn.addEventListener('mouseup', cancelHold);
  enterBtn.addEventListener('mouseleave', cancelHold);
  enterBtn.addEventListener('touchstart', () => {}, { passive: true }); // no hold gesture on touch, per spec -- tap just clicks

  // Esc is a reasonable, discoverable way to skip for a keyboard user
  // who doesn't want to tab to the button first; it is not the only
  // path (the button itself is reachable and activates on Enter/Space).
  overlay.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') skipImmediately();
  });

  runIntroSequence();
})();
