// MAM PRESENCE -- the living interaction layer.
//
// This owns the part of MAM that is a PRESENCE rather than a chat client:
// how it wakes, where it stands, how contextual actions emerge around it,
// and how it hands you over to a destination. The conversation itself, the
// backend, the transcript and the validated action registry all stay in
// js/mam-chat-panel.js -- none of that is reimplemented here, and none of
// its security properties are bypassed. This module only decides what the
// visitor SEES and in what order.
//
// THE ONE AUTHORITATIVE STATE MACHINE
// -----------------------------------
//   IDLE        present, breathing, at the edge
//   AWAKENING   coming to focus, gathering, about to greet
//   LISTENING   taking a question, body driven by the microphone
//   THINKING    working, energy circulating inward
//   SPEAKING    body driven by MAM's own voice amplitude
//   GUIDING     escorting you to a destination
//   MINIMIZED   small again, still visibly alive
//   ERROR       calm, not alarming
//
// Legal transitions are declared, not implied, so an impossible sequence
// is a caught bug rather than a stuck body. js/mam-chat-panel.js's own
// voice machine (IDLE/LISTENING/PROCESSING/SPEAKING/...) feeds this one
// through adopt(); it is the conversation's view of the same reality, and
// this is the presentation's.
//
// VOICE-FIRST
// -----------
// The first click does NOT open the conversation panel. MAM comes to
// focus, grows, and greets you out loud in the active language. A simple
// question is answered by voice alone. Only an actionable request causes
// small contextual options to emerge, one at a time, from beneath the
// body. The full panel remains reachable -- it is how someone types, reads
// a transcript, or works without audio -- but it is no longer the front
// door.
import { mamNavigate, canNavigateInPlace } from './mam-shell.js';

export const STATES = ['IDLE', 'AWAKENING', 'LISTENING', 'THINKING', 'SPEAKING', 'GUIDING', 'MINIMIZED', 'ERROR'];

// Where each state may go. ERROR is reachable from anywhere (things break
// anywhere); IDLE is reachable from anywhere (a reset must always work).
const ALLOWED = {
  IDLE:      ['AWAKENING', 'LISTENING', 'MINIMIZED'],
  AWAKENING: ['SPEAKING', 'LISTENING', 'MINIMIZED'],
  LISTENING: ['THINKING', 'SPEAKING', 'MINIMIZED'],
  THINKING:  ['SPEAKING', 'GUIDING', 'LISTENING', 'MINIMIZED'],
  SPEAKING:  ['LISTENING', 'GUIDING', 'MINIMIZED', 'IDLE'],
  GUIDING:   ['MINIMIZED', 'SPEAKING', 'IDLE'],
  MINIMIZED: ['IDLE', 'AWAKENING', 'LISTENING', 'SPEAKING'],
  ERROR:     ['IDLE', 'MINIMIZED', 'LISTENING']
};

// Presentation state -> the companion body's visual state.
const BODY = {
  IDLE: 'idle', AWAKENING: 'awakening', LISTENING: 'listening',
  THINKING: 'thinking', SPEAKING: 'speaking', GUIDING: 'guiding',
  MINIMIZED: 'minimized', ERROR: 'error'
};

// How the conversation's own voice machine maps onto this one.
const FROM_VOICE = {
  IDLE: 'IDLE', WAKE_LISTENING: 'IDLE', LISTENING: 'LISTENING',
  PROCESSING: 'THINKING', SPEAKING: 'SPEAKING', INTERRUPTED: 'LISTENING',
  ERROR: 'ERROR'
};

const OPTION_STAGGER_MS = 130;   // options arrive one at a time, not as a menu

function tr(key, fallback) { return (window.t && window.t(key)) || fallback; }

/**
 * @param {Object} opts
 * @param {import('./mam-companion.js').MamCompanion} opts.companion
 * @param {{speak:Function, open:Function, close:Function, toggleHandsFree:Function, isVoiceSupported:boolean}} opts.panel
 * @param {Element} [opts.dockEl] the compact dock, hidden while MAM is in focus
 */
export function createPresence({ companion, panel, dockEl }) {
  let state = 'IDLE';
  let awakened = false;
  let optionsEl = null;
  let optionTimers = [];

  const root = companion.root;
  // Publish the STARTING state immediately. go() short-circuits when the
  // requested state is already current, so without this the initial IDLE
  // was never written and the body carried no data-presence attribute at
  // all until its first transition -- invisible until something keyed off
  // it, which is exactly the kind of gap that surfaces as "why is the
  // first state different from the other seven".
  root.dataset.presence = state;

  function reduceMotion() {
    return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  function go(next, { force = false } = {}) {
    if (!STATES.includes(next)) return false;
    if (next === state) return true;
    const legal = next === 'ERROR' || next === 'IDLE' || (ALLOWED[state] || []).includes(next);
    if (!legal && !force) {
      // Not silent: an illegal transition means the two machines have
      // drifted, and that is worth seeing in a console rather than
      // discovering as a body stuck in the wrong mood.
      console.warn('[mam-presence] refused transition', state, '->', next);
      return false;
    }
    state = next;
    companion.setState(BODY[next] || 'idle');
    root.dataset.presence = next;
    return true;
  }

  /** Adopt the conversation layer's voice state. */
  function adopt(voiceState) {
    const mapped = FROM_VOICE[voiceState];
    if (mapped) go(mapped, { force: true });
  }

  // ---- AWAKENING ------------------------------------------------------
  // The first click. MAM moves to a comfortable focal position, grows,
  // the dock's temporary label goes away, and it greets you by voice.
  // Deliberately NOT opening the conversation panel: this is the whole
  // "voice-first" instruction, and a panel appearing here would put a
  // wall of UI between the visitor and a spoken answer.
  function awaken() {
    if (awakened) return false;
    awakened = true;
    go('AWAKENING', { force: true });
    companion.setFocus(true);
    if (dockEl) dockEl.setAttribute('data-mam-quiet', '1');   // labels/actions recede

    const greeting = tr('mam.howCanIHelp', 'How can I help you?');
    // Spoken through the conversation layer so it uses the SAME voice
    // path, language selection and Kurdish TTS the rest of MAM uses --
    // never a second speech implementation.
    if (panel && typeof panel.speak === 'function') {
      panel.speak(greeting, { onDone: () => { if (state === 'AWAKENING' || state === 'SPEAKING') go('LISTENING', { force: true }); } });
    }
    // Hand straight to listening if there is no voice at all, so a browser
    // without speech still reaches a usable state instead of sitting in a
    // transition for ever.
    if (!panel || typeof panel.speak !== 'function') go('LISTENING', { force: true });
    return true;
  }

  // ---- CONTEXTUAL OPTIONS --------------------------------------------
  // Small actions that EMERGE from beneath the body, one at a time. Not a
  // menu that appears: a menu is a UI, a sequence is a thought being
  // formed. Only rendered for an actionable request -- a simple question
  // is answered by voice and nothing appears at all.
  function ensureOptionsHost() {
    if (optionsEl) return optionsEl;
    optionsEl = document.createElement('div');
    optionsEl.className = 'mamp-options';
    optionsEl.setAttribute('role', 'group');
    optionsEl.setAttribute('aria-label', tr('mam.optionsHint', "Here's what I can do:"));
    root.appendChild(optionsEl);
    return optionsEl;
  }

  function clearOptions() {
    optionTimers.forEach(clearTimeout);
    optionTimers = [];
    if (optionsEl) optionsEl.textContent = '';
  }

  /**
   * @param {{label:string, href?:string, onSelect?:Function}[]} options
   */
  function showOptions(options) {
    clearOptions();
    if (!Array.isArray(options) || !options.length) return;
    const host = ensureOptionsHost();
    const stagger = reduceMotion() ? 0 : OPTION_STAGGER_MS;

    options.slice(0, 4).forEach((opt, i) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'mamp-option';
      btn.textContent = opt.label;
      btn.style.setProperty('--i', String(i));
      btn.addEventListener('click', () => select(btn, opt));
      host.appendChild(btn);
      // Emerging one at a time is a timer per chip rather than one CSS
      // delay, so a chip that is chosen mid-sequence can stop the rest.
      optionTimers.push(setTimeout(() => btn.setAttribute('data-in', '1'), stagger * i + 40));
    });
  }

  /** The chosen action comes forward; the others recede; MAM guides. */
  function select(btn, opt) {
    optionTimers.forEach(clearTimeout);
    optionTimers = [];
    if (optionsEl) {
      Array.from(optionsEl.children).forEach((el) => {
        el.setAttribute('data-chosen', el === btn ? '1' : '0');
      });
    }
    go('GUIDING', { force: true });
    // Smaller while guiding: MAM is escorting, so it stops being the
    // subject and the destination becomes it.
    companion.setFocus(false);
    if (dockEl) dockEl.removeAttribute('data-mam-quiet');

    const finish = () => {
      clearOptions();
      if (typeof opt.onSelect === 'function') { opt.onSelect(); return; }
      if (!opt.href) { go('IDLE', { force: true }); return; }
      // THE SAFETY GATE IS NOT BYPASSED. mamNavigate decides for itself
      // whether the destination is provably re-entrant; if it is not, it
      // performs an ordinary full navigation and the voice ends with the
      // document, exactly as it does today. Nothing here weakens that to
      // make the transition look smoother than it is.
      mamNavigate(opt.href);
    };
    // Let the recede read before leaving, unless motion is reduced.
    setTimeout(finish, reduceMotion() ? 0 : 320);
  }

  /** Back to the corner, small and still alive. */
  function minimize() {
    clearOptions();
    companion.setFocus(false);
    if (dockEl) dockEl.removeAttribute('data-mam-quiet');
    awakened = false;
    go('MINIMIZED', { force: true });
    // MINIMIZED is a resting state, not a terminal one: it settles to IDLE
    // so the body returns to its full ambient life rather than staying in
    // a dimmed variant for ever.
    setTimeout(() => { if (state === 'MINIMIZED') go('IDLE', { force: true }); }, 1400);
  }

  return {
    get state() { return state; },
    get hasAwakened() { return awakened; },
    go, adopt, awaken, showOptions, clearOptions, minimize,
    /** True when this destination keeps the voice alive; used for copy, never to fake it. */
    isContinuous: (href) => canNavigateInPlace(href)
  };
}
