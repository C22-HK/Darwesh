// MAM Companion -- a decoupled, portable living presence for MAM.
//
// This module owns nothing about chat, network, or Darwesh data. It is a
// small state machine driving one element's appearance, plus a single
// numeric channel for live audio. Any page can construct one and call
// .setState(...) / .setEnergy(...); js/mam-companion-launcher.js is a
// consumer, not a special case baked in here.
//
// Visual language: a liquid droplet with weather inside it -- abstract and
// elegant, never a mascot, a robot or a face. State is expressed through
// motion, weight and colour only (see css/mam-companion.css).
//
// Pure CSS animation plus one custom property written from JS. No canvas,
// no WebGL, no animation library, so this is safe to mount on any page
// including a live map.
function ensureStylesheet() {
  const already = Array.from(document.querySelectorAll('link[rel="stylesheet"]'))
    .some((l) => (l.getAttribute('href') || '').includes('mam-companion.css'));
  if (already) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = new URL('../css/mam-companion.css', import.meta.url).href;
  document.head.appendChild(link);
}

// THE EIGHT STATES the product defines, plus two the existing voice flow
// already drives and which stay first-class rather than being collapsed
// into a neighbour:
//   wake-listening  passively waiting for the phrase "MAM AI" -- ambient,
//                   and genuinely different from taking a question
//   result-ready    a momentary bloom that settles itself
export const VALID_STATES = new Set([
  'idle', 'awakening', 'listening', 'thinking', 'speaking',
  'guiding', 'minimized', 'error',
  'wake-listening', 'result-ready'
]);

const STATE_LABELS = {
  idle: { en: 'MAM is ready', ar: 'MAM جاهز', ku: 'MAM ئامادەیە' },
  awakening: { en: 'MAM is waking up', ar: 'MAM يستيقظ', ku: 'MAM هەڵدەستێت' },
  'wake-listening': { en: 'MAM is listening for “MAM AI”', ar: 'MAM بانتظار قول "مام آي"', ku: 'MAM چاوەڕێی وشەی "مام ئای"ـە' },
  listening: { en: 'MAM is listening', ar: 'MAM يستمع', ku: 'MAM گوێ دەگرێت' },
  thinking: { en: 'MAM is thinking', ar: 'MAM يفكر', ku: 'MAM بیر دەکاتەوە' },
  speaking: { en: 'MAM is speaking', ar: 'MAM يتحدث', ku: 'MAM قسە دەکات' },
  guiding: { en: 'MAM is taking you there', ar: 'MAM يأخذك إلى هناك', ku: 'MAM دەتبات بۆ ئەوێ' },
  minimized: { en: 'MAM is here if you need it', ar: 'MAM موجود إذا احتجته', ku: 'MAM لێرەیە ئەگەر پێویستت بێت' },
  'result-ready': { en: 'MAM has an answer', ar: 'MAM لديه إجابة', ku: 'MAM وەڵامێکی هەیە' },
  error: { en: 'MAM ran into a problem', ar: 'واجه MAM مشكلة', ku: 'MAM کێشەیەکی هەبوو' },
};

// Momentary accents that settle back rather than sticking, so the body
// never looks stuck celebrating, erroring or mid-wake.
const MOMENTARY = { 'result-ready': 2400, error: 4200, awakening: 900 };
// Where each momentary state goes when it settles. AWAKENING is a
// transition, not a resting place: it hands over to LISTENING because the
// whole point of waking is that MAM is now waiting for you to speak.
const SETTLES_TO = { 'result-ready': 'idle', error: 'idle', awakening: 'listening' };

export class MamCompanion {
  /**
   * @param {Object} [opts]
   * @param {Element} [opts.mountTarget] Defaults to document.body (the
   *   companion is fixed to the viewport, so body is the natural default).
   * @param {() => string} [opts.getLanguage] Returns 'en'|'ar'|'ku' for the
   *   aria-label. Defaults to always 'en'.
   * @param {boolean} [opts.interactive] True makes the body a real
   *   keyboard-operable control instead of a status indicator. Leave false
   *   when it sits inside something already focusable (js/mam-dock.js), so
   *   the tab order has one entry for one action.
   */
  constructor({ mountTarget, getLanguage, interactive } = {}) {
    ensureStylesheet();
    this._getLanguage = typeof getLanguage === 'function' ? getLanguage : () => 'en';
    this._state = 'idle';
    this._settleTimer = null;
    this._energy = 0;

    this._root = document.createElement('div');
    this._root.className = 'mamco-root';

    // A dedicated float layer so the drift can never collide with the
    // root's positioning transform or the body's breath. Three separate
    // owners for three independent motions is what lets them run on
    // unrelated periods (see the stylesheet header).
    this._float = document.createElement('div');
    this._float.className = 'mamco-float';

    this._orb = document.createElement('div');
    this._orb.className = 'mamco-orb';
    this._orb.dataset.state = 'idle';
    if (interactive) {
      this._orb.setAttribute('role', 'button');
      this._orb.setAttribute('tabindex', '0');
      this._orb.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this._orb.click(); }
      });
    } else {
      this._orb.setAttribute('role', 'img');
    }

    const core = document.createElement('div');
    core.className = 'mamco-core';
    this._orb.appendChild(core);

    this._float.appendChild(this._orb);
    this._root.appendChild(this._float);
    (mountTarget || document.body).appendChild(this._root);
    this._updateLabel();
  }

  /** The element a host should attach a click handler to. */
  get element() { return this._orb; }
  /** The positioned root -- what moves when MAM comes to focus. */
  get root() { return this._root; }

  /** @param {string} state one of VALID_STATES */
  setState(state) {
    if (!VALID_STATES.has(state)) return;
    if (state === this._state) { this._armSettle(state); return; }
    this._state = state;
    this._orb.dataset.state = state;
    // A state that is not driven by live audio must not inherit the last
    // value the previous one left behind, or the body freezes mid-gesture.
    if (state !== 'speaking' && state !== 'listening') this.setEnergy(0);
    this._updateLabel();
    this._armSettle(state);
  }

  getState() { return this._state; }

  /**
   * The live audio channel: 0 (silent) to 1 (loud). Written every frame
   * while SPEAKING (from MAM's own output) or LISTENING (from the
   * microphone) by js/mam-voice-energy.js. Nothing here smooths or fakes
   * it -- silence must look like silence, which is the whole difference
   * between reacting and performing.
   * @param {number} level
   */
  setEnergy(level) {
    const v = Math.max(0, Math.min(1, Number(level) || 0));
    // Skip writes below a perceptible delta: a custom-property write
    // invalidates style for the subtree, and this runs at frame rate.
    if (Math.abs(v - this._energy) < 0.008) return;
    this._energy = v;
    this._root.style.setProperty('--mam-energy', v.toFixed(3));
  }

  /** Bring MAM to its focal position (true) or return it to the edge. */
  setFocus(on) {
    this._root.dataset.focus = on ? '1' : '0';
  }

  destroy() {
    clearTimeout(this._settleTimer);
    this._root.remove();
  }

  _armSettle(state) {
    clearTimeout(this._settleTimer);
    const ms = MOMENTARY[state];
    if (!ms) return;
    this._settleTimer = setTimeout(() => {
      if (this._state === state) this.setState(SETTLES_TO[state] || 'idle');
    }, ms);
  }

  _updateLabel() {
    const lang = this._getLanguage();
    const labels = STATE_LABELS[this._state] || STATE_LABELS.idle;
    this._orb.setAttribute('aria-label', labels[lang] || labels.en);
  }
}
