// MAM Companion -- a decoupled, portable living presence for MAM.
//
// This module owns nothing about chat, network, or Darwesh data. It is a
// small state machine driving one element's appearance, plus a single
// numeric channel for live audio. Any page can construct one and call
// .setState(...) / .setEnergy(...); js/mam-companion-launcher.js is a
// consumer, not a special case baked in here.
//
// Visual language, from the approved reference: a dark translucent glass
// body with warm gold light inside it, two soft gold crescents suspended in
// that light, and thin gold orbits ringing it. Abstract and premium -- a
// small liquid digital being, never a cartoon mascot or a robot. State is
// expressed through motion, weight, light and colour, never by swapping in
// a different graphic (see css/mam-companion.css).
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

// THE HALO -- thin gold orbits that ring the body, and the two small arcs
// that sit just off its left and right edge.
//
// Drawn TWICE, once behind the body and once in front, from the same
// markup. That is not decoration: the back copy is only visible because
// the body is translucent, so the moment you can see a ring passing behind
// the glass, the glass has proved it is glass. The front copy is masked to
// its lower half (see the stylesheet) so each orbit is bright as it comes
// toward you and dim as it goes away -- which is what makes two flat
// ellipses read as two rings turning in space.
//
// Each orbit is two ellipses rather than one with a filter: a wide, faint
// stroke under a narrow, bright one gives the glow for the cost of paint.
// A drop-shadow filter would re-rasterize the whole layer every frame.
const ORBIT = (cls) =>
  `<g class="mamco-orbit ${cls}">` +
  `<ellipse class="mamco-orbit-halo" cx="50" cy="50" rx="47" ry="17"/>` +
  `<ellipse class="mamco-orbit-line" cx="50" cy="50" rx="47" ry="17"/>` +
  `</g>`;

// TWO orbits, not three. Three crossing ellipses read as an atom diagram --
// a completely different and much more generic object than the approved
// one, which carries a single elegant halo system. Two rings at unrelated
// tilts give the depth without the science-fair association.
const ORBITS_SVG =
  `<svg viewBox="0 0 100 100" aria-hidden="true" focusable="false">` +
  ORBIT('mamco-orbit--a') + ORBIT('mamco-orbit--b') +
  `</svg>`;

// The two small arcs off the body's left and right edge. They live in their
// own layer because the orbits' near-half mask would otherwise cut straight
// through them: the ears sit at y 42-58, right inside the mask's ramp, and
// rendered as half-faded grey brackets rather than gold. They are not part
// of the orbit illusion, so they should not inherit its mask.
const EARS_SVG =
  `<svg viewBox="0 0 100 100" aria-hidden="true" focusable="false">` +
  `<path class="mamco-ear" d="M17 44 a6 6 0 0 0 0 12"/>` +
  `<path class="mamco-ear" d="M83 44 a6 6 0 0 1 0 12"/>` +
  `</svg>`;

// THE EYES -- the one element that makes this a being rather than an orb.
// Two soft gold crescents suspended INSIDE the glass (which is why they
// sit under the surface layer, not on top of it), drifting very slightly
// so they never look printed on.
//
// The gap is load-bearing. A first pass put them at 31-47 and 53-69; with
// a 6.4 stroke and round caps each crescent grew 3.2 past both ends, so the
// two met at x=50 and rendered as ONE continuous squiggle -- a moustache,
// not a pair of eyes. Ends at 44 and 56, against a 5.6 stroke, leave about
// 6 units of clear dark glass between the caps at every width used here.
const EYES_SVG =
  `<svg viewBox="0 0 100 100" aria-hidden="true" focusable="false">` +
  `<g class="mamco-eye-pair">` +
  `<path class="mamco-eye" d="M25 47 q9.5 10 19 0"/>` +
  `<path class="mamco-eye" d="M56 47 q9.5 10 19 0"/>` +
  `</g></svg>`;

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

    // Inside the glass, above the internal light, below the surface: the
    // eyes are suspended IN the material, so the specular highlight passes
    // over them the way it would over anything else under the surface.
    const eyes = document.createElement('div');
    eyes.className = 'mamco-eyes';
    eyes.innerHTML = EYES_SVG;
    this._orb.appendChild(eyes);

    // Back half of the halo, then the body, then the front half. Three
    // siblings rather than one layer, because a child can never paint
    // behind its own parent's background -- and the ring passing behind
    // the body is the whole point.
    const haloBack = document.createElement('div');
    haloBack.className = 'mamco-halo mamco-halo--back';
    haloBack.innerHTML = ORBITS_SVG;
    const haloFront = document.createElement('div');
    haloFront.className = 'mamco-halo mamco-halo--front';
    // Orbits are masked to their near half; the ears are not (see EARS_SVG).
    haloFront.innerHTML =
      '<div class="mamco-halo-orbits">' + ORBITS_SVG + '</div>' +
      '<div class="mamco-halo-ears">' + EARS_SVG + '</div>';

    this._float.appendChild(haloBack);
    this._float.appendChild(this._orb);
    this._float.appendChild(haloFront);
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
