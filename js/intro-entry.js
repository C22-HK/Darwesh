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

  function enter() {
    if (entered) return;
    entered = true;
    markSeen();

    // Must run synchronously inside this real user-gesture handler --
    // audio-controller.js itself never calls play() from anywhere else.
    audio.startFromUserGesture();

    document.body.classList.remove('cine-intro-open');
    overlay.setAttribute('data-leaving', 'true');
    const fadeMs = reduceMotion ? 150 : 650;
    window.setTimeout(() => {
      overlay.hidden = true;
    }, fadeMs);
  }

  enterBtn.addEventListener('click', enter);

  // Visible skip -- same action as Enter, just without asking the visitor to
  // discover the Escape key.
  const skipBtn = document.getElementById('cineSkipBtn');
  if (skipBtn) skipBtn.addEventListener('click', enter);

  enterBtn.addEventListener('mousedown', startHold);
  enterBtn.addEventListener('mouseup', cancelHold);
  enterBtn.addEventListener('mouseleave', cancelHold);
  enterBtn.addEventListener('touchstart', () => {}, { passive: true }); // no hold gesture on touch, per spec -- tap just clicks

  // Esc is a reasonable, discoverable way to skip for a keyboard user
  // who doesn't want to tab to the button first; it is not the only
  // path (the button itself is reachable and activates on Enter/Space).
  overlay.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') enter();
  });
})();
