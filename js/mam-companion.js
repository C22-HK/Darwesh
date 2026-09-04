// MAM Companion -- a decoupled, portable visual identity for MAM.
//
// This module owns nothing about chat, network, or Darwesh data -- it is
// a small state machine driving one DOM element's appearance. Any page
// can `import { MamCompanion } from './mam-companion.js'`, construct one,
// and call `.setState(...)` -- js/mam-companion-launcher.js is the consumer, not a
// special case baked into this file. Keeping it decoupled is what lets a
// later phase mount the same companion as a site-wide launcher without
// touching this module.
//
// Visual language: a luminous orb with a soft inner "gaze" point -- an
// abstract, elegant mark, never a mascot/robot/emoji face. State is
// expressed through motion, glow and color only (see css/mam-companion.css).
// Pure CSS animation -- no canvas/WebGL/Three.js, so this is safe to mount
// on any page without a rendering-budget cost.

const VALID_STATES = new Set(['idle', 'listening', 'thinking', 'speaking', 'result-ready', 'error']);

const STATE_LABELS = {
  idle: { en: 'MAM is ready', ar: 'MAM جاهز', ku: 'MAM ئامادەیە' },
  listening: { en: 'MAM is listening', ar: 'MAM يستمع', ku: 'MAM گوێ دەگرێت' },
  thinking: { en: 'MAM is thinking', ar: 'MAM يفكر', ku: 'MAM بیر دەکاتەوە' },
  speaking: { en: 'MAM is speaking', ar: 'MAM يتحدث', ku: 'MAM قسە دەکات' },
  'result-ready': { en: 'MAM has an answer', ar: 'MAM لديه إجابة', ku: 'MAM وەڵامێکی هەیە' },
  error: { en: 'MAM ran into a problem', ar: 'واجه MAM مشكلة', ku: 'MAM کێشەیەکی هەبوو' },
};

// Momentary accents that settle back to idle rather than sticking, so the
// companion never looks "stuck" celebrating or erroring indefinitely.
const MOMENTARY_STATES = new Set(['result-ready', 'error']);
const MOMENTARY_DURATION_MS = 2400;

export class MamCompanion {
  /**
   * @param {Object} [opts]
   * @param {Element} [opts.mountTarget] Element to append the companion
   *   into. Defaults to document.body (the companion positions itself
   *   fixed to the viewport, so body is the natural default).
   * @param {() => string} [opts.getLanguage] Returns the current 'en'|'ar'|'ku'
   *   language code for the aria-label. Defaults to always 'en'.
   * @param {boolean} [opts.interactive] When true, the orb is a real
   *   keyboard-operable control (role="button", tabindex, Enter/Space
   *   activation) instead of a pure status indicator (role="img", not
   *   focusable) -- set this wherever the host page actually wires a
   *   click handler onto the orb (see js/mam-properties-map.js and
   *   js/mam-companion-launcher.js); leave it false on a page like
   *   a host page where the orb is ambient status only and the page
   *   itself is already the full interactive surface.
   */
  constructor({ mountTarget, getLanguage, interactive } = {}) {
    this._getLanguage = typeof getLanguage === 'function' ? getLanguage : () => 'en';
    this._state = 'idle';
    this._settleTimer = null;

    this._root = document.createElement('div');
    this._root.className = 'mamco-root';

    this._orb = document.createElement('div');
    this._orb.className = 'mamco-orb';
    this._orb.dataset.state = 'idle';
    if (interactive) {
      this._orb.setAttribute('role', 'button');
      this._orb.setAttribute('tabindex', '0');
      this._orb.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          this._orb.click();
        }
      });
    } else {
      this._orb.setAttribute('role', 'img');
    }

    const core = document.createElement('div');
    core.className = 'mamco-core';
    this._orb.appendChild(core);

    this._root.appendChild(this._orb);
    (mountTarget || document.body).appendChild(this._root);
    this._updateLabel();
  }

  /** @param {'idle'|'listening'|'thinking'|'speaking'|'result-ready'|'error'} state */
  setState(state) {
    if (!VALID_STATES.has(state) || state === this._state) {
      if (VALID_STATES.has(state)) this._armSettle(state);
      return;
    }
    this._state = state;
    this._orb.dataset.state = state;
    this._updateLabel();
    this._armSettle(state);
  }

  getState() {
    return this._state;
  }

  destroy() {
    clearTimeout(this._settleTimer);
    this._root.remove();
  }

  _armSettle(state) {
    clearTimeout(this._settleTimer);
    if (!MOMENTARY_STATES.has(state)) return;
    this._settleTimer = setTimeout(() => {
      if (this._state === state) this.setState('idle');
    }, MOMENTARY_DURATION_MS);
  }

  _updateLabel() {
    const lang = this._getLanguage();
    const labels = STATE_LABELS[this._state] || STATE_LABELS.idle;
    this._orb.setAttribute('aria-label', labels[lang] || labels.en);
  }
}
