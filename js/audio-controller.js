// Darwesh Group -- ambient audio architecture.
//
// This is architecture only. AUDIO_SRC is intentionally empty below --
// no copyrighted or downloaded music is embedded here, and none should
// be added to this constant until a locally owned/licensed Darwesh
// ambient audio asset exists. Until then, `init()` still runs (so the
// rest of the intro isn't coupled to whether audio exists) but the
// toggle control stays hidden and every method below is a safe no-op.
//
// Explicitly does NOT attempt to defeat browser autoplay restrictions.
// play() is only ever invoked from inside a real user-gesture handler
// (the intro's Enter control, see js/intro-entry.js) -- never on load,
// never on a timer, never speculatively.
export const AUDIO_SRC = ''; // e.g. 'audio/darwesh-ambient.mp3' once approved

const MUTE_KEY = 'darwesh_ambient_muted';
const FADE_MS = 1800;
const TARGET_VOLUME = 0.12; // "very low" -- ambient, never foreground

function isMutedPreference() {
  try {
    return localStorage.getItem(MUTE_KEY) === '1';
  } catch (_err) {
    return true; // storage unavailable (private mode, etc.) -- default to silent
  }
}

function setMutedPreference(muted) {
  try {
    localStorage.setItem(MUTE_KEY, muted ? '1' : '0');
  } catch (_err) {
    // Non-fatal -- the session still respects the in-memory state below,
    // it just won't be remembered next visit.
  }
}

export function createAudioController() {
  let audioEl = null;
  let fadeRaf = null;
  let userEnabled = false;

  function ensureElement() {
    if (audioEl || !AUDIO_SRC) return audioEl;
    audioEl = document.createElement('audio');
    audioEl.src = AUDIO_SRC;
    audioEl.loop = true;
    audioEl.preload = 'none';
    audioEl.volume = 0;
    // No `controls` attribute, kept out of layout entirely -- this is a
    // background layer, not a media player UI. Not focusable, not
    // announced by screen readers as a result (an <audio> with no
    // `controls` and no visible affordance is not part of the
    // accessible interaction surface; the real, labeled control is the
    // toggle button wired in bindToggle() below).
    audioEl.style.display = 'none';
    document.body.appendChild(audioEl);
    return audioEl;
  }

  function cancelFade() {
    if (fadeRaf) {
      cancelAnimationFrame(fadeRaf);
      fadeRaf = null;
    }
  }

  function fadeTo(target, ms) {
    cancelFade();
    if (!audioEl) return;
    const start = audioEl.volume;
    const startTime = performance.now();
    function step(now) {
      const t = Math.min(1, (now - startTime) / ms);
      audioEl.volume = start + (target - start) * t;
      if (t < 1) {
        fadeRaf = requestAnimationFrame(step);
      } else {
        fadeRaf = null;
        if (target === 0) audioEl.pause();
      }
    }
    fadeRaf = requestAnimationFrame(step);
  }

  // Must be called synchronously from within a real user-gesture event
  // handler (click/keydown on the Enter control) -- browsers reject
  // play() called any other way, and this module makes no attempt to
  // route around that.
  function startFromUserGesture() {
    userEnabled = true;
    if (!AUDIO_SRC) return;
    if (isMutedPreference()) return; // respect a previously saved mute choice
    const el = ensureElement();
    if (!el) return;
    el.volume = 0;
    const playPromise = el.play();
    if (playPromise && typeof playPromise.catch === 'function') {
      playPromise.catch(() => {
        // Autoplay-adjacent rejection even after a gesture (rare, e.g.
        // a browser policy quirk) -- fail silently, never surface an
        // error to the visitor over something this optional.
      });
    }
    fadeTo(TARGET_VOLUME, FADE_MS);
  }

  function mute() {
    setMutedPreference(true);
    fadeTo(0, 250); // "pausing/muting must work instantly" -- fast, not the slow ambient fade-in
  }

  function unmute() {
    setMutedPreference(false);
    if (!userEnabled || !AUDIO_SRC) return; // never starts playback on its own without a prior gesture
    const el = ensureElement();
    if (!el) return;
    if (el.paused) {
      const p = el.play();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    }
    fadeTo(TARGET_VOLUME, FADE_MS);
  }

  function toggle() {
    if (isMutedPreference()) unmute();
    else mute();
  }

  // Binds a single visible on/off control. Hidden entirely when no
  // audio source is configured, so this never renders as a dead
  // button.
  function bindToggle(buttonEl, labels) {
    if (!buttonEl) return;
    if (!AUDIO_SRC) {
      buttonEl.hidden = true;
      return;
    }
    buttonEl.hidden = false;
    function render() {
      const muted = isMutedPreference();
      buttonEl.setAttribute('aria-pressed', muted ? 'false' : 'true');
      buttonEl.setAttribute('aria-label', muted ? (labels && labels.enable) || 'Enable ambient sound' : (labels && labels.disable) || 'Mute ambient sound');
      const icon = buttonEl.querySelector('.material-symbols-outlined');
      if (icon) icon.textContent = muted ? 'volume_off' : 'volume_up';
    }
    render();
    buttonEl.addEventListener('click', () => {
      toggle();
      render();
    });
  }

  // Tab-hidden courtesy pause -- resumes only if the visitor had it
  // playing (userEnabled) and hasn't muted since. Never resumes
  // playback the visitor doesn't already have active.
  document.addEventListener('visibilitychange', () => {
    if (!audioEl) return;
    if (document.hidden) {
      if (!audioEl.paused) audioEl.pause();
    } else if (userEnabled && !isMutedPreference() && audioEl.paused) {
      const p = audioEl.play();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    }
  });

  return { startFromUserGesture, mute, unmute, toggle, bindToggle, isMuted: isMutedPreference };
}
