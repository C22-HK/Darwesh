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
      return;
    }
    let t = 0;
    window.setTimeout(() => addScene('line'), (t += PASSIVE_TIMINGS.dark));
    window.setTimeout(() => addScene('portal'), (t += PASSIVE_TIMINGS.line));
    window.setTimeout(() => addScene('points'), (t += PASSIVE_TIMINGS.portal));
    window.setTimeout(() => {
      addScene('core');
      drawEnterRing(600);
    }, (t += PASSIVE_TIMINGS.points));
  }

  // ---- Exit (shared by the cinematic Enter path and the immediate
  // Skip/Escape path) --------------------------------------------------
  function fadeAndHide() {
    document.body.classList.remove('cine-intro-open');
    overlay.setAttribute('data-leaving', 'true');
    const fadeMs = reduceMotion ? 150 : 650;
    window.setTimeout(() => { overlay.hidden = true; }, fadeMs);
  }

  // Scenes 07-08: ring reacts, then the ecosystem unfolds from the
  // center, THEN the existing exit fade runs -- see the is-entering/
  // is-expanded rules in cinematic.css for what each stage animates.
  // Reduced motion collapses this to instant opacity reveals (no flying
  // pillars, no long orbital construction), per spec.
  function runExpansionThenExit() {
    if (ringDrawRaf) cancelAnimationFrame(ringDrawRaf);
    addScene('entering');
    const t1 = reduceMotion ? 0 : 480;
    window.setTimeout(() => {
      addScene('expanded');
      const t2 = reduceMotion ? 0 : 1500;
      window.setTimeout(fadeAndHide, t2);
    }, t1);
  }

  function enter() {
    if (entered) return;
    entered = true;
    markSeen();
    // Must run synchronously inside this real user-gesture handler --
    // audio-controller.js itself never calls play() from anywhere else.
    audio.startFromUserGesture();
    runExpansionThenExit();
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
