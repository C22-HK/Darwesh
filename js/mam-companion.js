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

// THE HALO -- bands of light wound around the body.
//
// The previous version drew SVG <ellipse> outlines. Rendered, they read as
// an atom diagram: hairline mathematical curves, sprawling well past the
// silhouette, all sharing one centre. Rejected, and correctly so -- the
// approved reference has no lines in it at all. It has light WRAPPING a
// sphere.
//
// So the geometry is no longer an ellipse. Each ribbon is a real circle in
// 3D, tilted in its own plane and projected to 2D, then SPLIT AT THE
// SILHOUETTE into the half with positive depth and the half with negative
// depth. The two halves go into different layers -- one painted behind the
// body, one in front. That is what makes light disappear behind MAM and
// emerge again on the other side, which no amount of styling an ellipse can
// fake.
//
// Along each band the half-width and the brightness follow the SAME depth
// value, so a ribbon swells and brightens as it swings toward the viewer
// and thins away as it turns back -- and it tapers to nothing exactly where
// it crosses the silhouette, so it slides under the body's edge instead of
// stopping against it. Bright and quiet stretches along one ribbon come out
// of the geometry rather than being drawn in.
//
// Each band is a FILLED path, not a stroke, because a stroke has one width
// for its whole length and the width variation is most of what separates a
// light ribbon from a drawn curve.
//
// Cost: the geometry is computed once at construction and never again. The
// living motion is CSS transforms on the groups, and it is deliberately
// small and slow -- a few degrees -- so the depth baked into each band stays
// true. That is also exactly the "very slowly and organically" the brief
// asks for.
const RIB_SAMPLES = 34;          // per half-ribbon; smooth at every size shipped

/**
 * One tilted circle, projected. `alpha` is how far the ring's plane is
 * turned away from the screen: 0 faces you (no depth), 90 is edge-on (all
 * depth). Returns the front half and the back half separately, because
 * depth is what the two layers are for.
 */
function ribbonHalves({ r, cx = 50, cy = 50, tilt, alpha }) {
  const th = (tilt * Math.PI) / 180;
  const a = (alpha * Math.PI) / 180;
  const k = Math.cos(a);         // foreshortening across the ring
  const s = Math.sin(a);         // how much of the ring is depth
  const ct = Math.cos(th), st = Math.sin(th);
  const arc = (t0, t1) => {
    const pts = [];
    for (let i = 0; i <= RIB_SAMPLES; i++) {
      const t = t0 + ((t1 - t0) * i) / RIB_SAMPLES;
      const x0 = r * Math.cos(t);
      const y0 = r * Math.sin(t) * k;
      pts.push({
        x: cx + x0 * ct - y0 * st,
        y: cy + x0 * st + y0 * ct,
        d: Math.sin(t) * s        // -1 far .. +1 near
      });
    }
    return pts;
  };
  // sin(t) carries the sign of the depth, so the split is exact at t=0 and
  // t=PI -- precisely where the ring crosses the silhouette.
  return { front: arc(0, Math.PI), back: arc(Math.PI, Math.PI * 2) };
}

/**
 * Serialise an offset band, refusing to emit a coordinate that is not
 * finite. SVG treats a bad number as the end of the path and closes what it
 * has, with no error anywhere -- so a single NaN silently amputates a shape.
 * Better to notice.
 */
function toPath(outer, inner) {
  const f = (v) => {
    if (!Number.isFinite(v)) throw new RangeError('mam-companion: non-finite path coordinate');
    return v.toFixed(2);
  };
  let d = 'M' + f(outer[0][0]) + ' ' + f(outer[0][1]);
  for (let i = 1; i < outer.length; i++) d += 'L' + f(outer[i][0]) + ' ' + f(outer[i][1]);
  for (let i = inner.length - 1; i >= 0; i--) d += 'L' + f(inner[i][0]) + ' ' + f(inner[i][1]);
  return d + 'Z';
}

/** Offset a sampled curve into a closed band whose width follows depth. */
function bandPath(pts, wBase) {
  const n = pts.length;
  const outer = [], inner = [];
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    const prev = pts[i === 0 ? 0 : i - 1];
    const next = pts[i === n - 1 ? n - 1 : i + 1];
    const dx = next.x - prev.x, dy = next.y - prev.y;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len, ny = dx / len;
    const u = i / (n - 1);
    // Full width through the middle of the arc, tapering to nothing at the
    // two silhouette crossings so the band slips under the body's edge.
    // max(0, ...) is load-bearing: sin(PI*u) at u=1 comes out at -3.2e-16
    // rather than 0, and Math.pow of a negative is NaN -- which an SVG path
    // does not report, it just stops parsing there.
    const taper = Math.pow(Math.max(0, Math.sin(Math.PI * u)), 0.45);
    const near = (Math.abs(p.d) + 1) / 2;          // 0.5 at the crossing, 1 at the pole
    const w = wBase * taper * (0.30 + 0.70 * near);
    outer.push([p.x + nx * w, p.y + ny * w]);
    inner.push([p.x - nx * w, p.y - ny * w]);
  }
  return toPath(outer, inner);
}

// Radii sit between 0.95 and 1.20 of the body's own radius: the light HUGS
// MAM. The rejected version reached 1.47, which is what made it sprawl and
// read as orbits around a nucleus rather than as light on a surface. One
// ribbon is deliberately INSIDE the silhouette, so some light reads as
// travelling across the face rather than around it.
// No two share a radius, a centre, a tilt, a plane angle or a weight.
// FOUR strands and a crown. Density was the wrong goal: nine strands made
// the light the first thing you saw, and the face is the identity. These
// support the character instead of competing with it -- if the ribbons pull
// your eye before the eyes do, there are too many or they are too bright.
//
// The crown is deliberately the boldest of the five and sits ABOVE the
// head, because in the reference it is a distinct halo rather than one more
// strand lost in a tangle.
//
// Every plane angle stays between 40 and 68 degrees. Near 90 a ring is
// edge-on, and an edge-on circle projects to a straight line -- which is
// how one strand once drew a bright scratch down the middle of the face.
const RIBBONS = [
  { r: 45, cy: 51, tilt: -17, alpha: 62, w: 0.85 },
  { r: 42, cy: 53, tilt: 36, alpha: 46, w: 0.66 },
  { r: 47, cy: 50, tilt: 58, alpha: 55, w: 0.50 },
  { r: 40, cy: 54, tilt: 8, alpha: 40, w: 0.44 },
  { r: 31, cy: 20, tilt: -6, alpha: 68, w: 0.95 }   // the crown, over the head
];

const RIB_DEFS = (scope) =>
  '<defs>' +
  // Mapped to each band's own bounding box, so every ribbon gets its own
  // run of bright and quiet rather than all of them lighting up together.
  '<linearGradient id="' + scope + '-core" x1="0" y1="0.12" x2="1" y2="0.88">' +
  '<stop offset="0" stop-color="#F6C97E" stop-opacity="0.10"/>' +
  '<stop offset="0.26" stop-color="#FFDFA4" stop-opacity="0.88"/>' +
  '<stop offset="0.5" stop-color="#FFE9BE" stop-opacity="0.62"/>' +
  '<stop offset="0.74" stop-color="#F0BE79" stop-opacity="0.46"/>' +
  '<stop offset="1" stop-color="#C9944B" stop-opacity="0.08"/>' +
  '</linearGradient>' +
  '<linearGradient id="' + scope + '-glow" x1="0" y1="0.12" x2="1" y2="0.88">' +
  '<stop offset="0" stop-color="#E0A85C" stop-opacity="0"/>' +
  '<stop offset="0.3" stop-color="#FFD99A" stop-opacity="0.30"/>' +
  '<stop offset="0.62" stop-color="#E8B571" stop-opacity="0.16"/>' +
  '<stop offset="1" stop-color="#C9944B" stop-opacity="0"/>' +
  '</linearGradient>' +
  '</defs>';

/** @param {'front'|'back'} side */
function ribbonLayer(scope, side) {
  let out = '<svg viewBox="0 0 100 100" aria-hidden="true" focusable="false">' + RIB_DEFS(scope);
  RIBBONS.forEach((cfg, i) => {
    const pts = ribbonHalves(cfg)[side];
    // Two passes: a wide soft bloom under a narrower bright core. Cheaper
    // and steadier than a blur filter, which would re-rasterize the layer on
    // every animation frame.
    out += '<g class="mamco-ribbon mamco-ribbon--' + i + '">' +
      '<path class="mamco-ribbon-glow" d="' + bandPath(pts, cfg.w * 2.0) + '" fill="url(#' + scope + '-glow)"/>' +
      '<path class="mamco-ribbon-core" d="' + bandPath(pts, cfg.w) + '" fill="url(#' + scope + '-core)"/>' +
      '</g>';
  });
  return out + '</svg>';
}

// THE SIDE CUPS. Sculpted forms, not outlined ovals.
//
// A thin gold rim around a flat dark ellipse reads as a drawn ring sitting
// on the body. What makes a form solid is that it has its OWN light: a fill
// that lifts where the key strikes it and deepens away, a rim that is bright
// on the lit shoulder and fades around the back, and a small specular of its
// own. All three run off the same upper-left key as the body, or the cups
// look pasted in from a different scene.
const CUPS_SVG = (scope) =>
  '<svg viewBox="0 0 100 100" aria-hidden="true" focusable="false">' +
  '<defs>' +
  '<radialGradient id="' + scope + '-cupL" cx="0.34" cy="0.24" r="0.95">' +
  '<stop offset="0" stop-color="#3C352C"/><stop offset="0.42" stop-color="#15130F"/>' +
  '<stop offset="1" stop-color="#040403"/></radialGradient>' +
  '<radialGradient id="' + scope + '-cupR" cx="0.30" cy="0.24" r="0.95">' +
  '<stop offset="0" stop-color="#342E26"/><stop offset="0.42" stop-color="#131210"/>' +
  '<stop offset="1" stop-color="#040403"/></radialGradient>' +
  '<linearGradient id="' + scope + '-cupRim" x1="0.12" y1="0" x2="0.88" y2="1">' +
  '<stop offset="0" stop-color="#FFE6B8" stop-opacity="0.9"/>' +
  '<stop offset="0.42" stop-color="#C99D60" stop-opacity="0.44"/>' +
  '<stop offset="1" stop-color="#6B5230" stop-opacity="0.14"/>' +
  '</linearGradient>' +
  '</defs>' +
  '<g class="mamco-cup">' +
  '<ellipse class="mamco-cup-body" cx="9" cy="50" rx="7" ry="13.5" fill="url(#' + scope + '-cupL)"/>' +
  '<ellipse class="mamco-cup-rim" cx="9" cy="50" rx="7" ry="13.5" stroke="url(#' + scope + '-cupRim)"/>' +
  '<ellipse class="mamco-cup-spec" cx="7.3" cy="43" rx="2.2" ry="3.2"/>' +
  '</g>' +
  '<g class="mamco-cup">' +
  '<ellipse class="mamco-cup-body" cx="91" cy="50" rx="7" ry="13.5" fill="url(#' + scope + '-cupR)"/>' +
  '<ellipse class="mamco-cup-rim" cx="91" cy="50" rx="7" ry="13.5" stroke="url(#' + scope + '-cupRim)"/>' +
  '<ellipse class="mamco-cup-spec" cx="89.3" cy="43" rx="2" ry="3"/>' +
  '</g>' +
  '</svg>';

// Gradient ids have to be unique per document, and a page may mount more
// than one companion (the specimen sheet mounts thirteen). A per-instance
// counter keeps every gradient addressable by exactly the bands that use it.
let instanceUid = 0;

// THE EYES -- soft tapered crescents, not uniform strokes.
//
// A stroked path has ONE width for its whole length, and round caps end it
// with a blunt semicircle. That is a sausage. A drawn crescent is thick
// through the belly and thins to a point at each tip, and that difference is
// most of what "softer" means here.
//
// So each eye is a FILLED shape: the centreline is sampled and offset by a
// half-width following sin(t)^0.62. The exponent is below 1 on purpose --
// it keeps the belly full across most of the arc and spends the taper near
// the ends, where a plain sine would thin the eye far too early and leave it
// looking weak.
//
// Sized from the reference: the pair spans about 63% of the body, each eye
// about 25%, the belly about 12% of the body's height. The 12-unit gap
// between them is load-bearing -- at an earlier size the two nearly met and
// the pair read as one wide band rather than as two eyes.
//
// THE BELLY MUST STAY WELL UNDER THE SAG. A crescent's upper edge is the
// centreline lifted by the half-width, so its curvature is (sag - w) while
// the lower edge's is (sag + w). Both have to read as curves or the shape
// is not a crescent.
//   sag 7,  w 6.0  ->  top 1.0 / bottom 13.0  -- a HALF-DISC, flat on top
//   sag 8.6, w 3.9 ->  top 4.7 / bottom 12.5  -- still reads flat-topped
//   sag 12, w 3.3  ->  top 8.7 / bottom 15.3  -- a crescent
// The ratio is what matters, not either number alone: the upper edge needs
// to keep something like two thirds of the lower edge's curvature. Total
// height is (sag + w), which is what sets how much of the face it fills.
const EYE_SAMPLES = 26;

function quadPoints(x0, y0, cx, cy, x1, y1) {
  const pts = [];
  for (let i = 0; i <= EYE_SAMPLES; i++) {
    const t = i / EYE_SAMPLES, u = 1 - t;
    pts.push({
      x: u * u * x0 + 2 * u * t * cx + t * t * x1,
      y: u * u * y0 + 2 * u * t * cy + t * t * y1
    });
  }
  return pts;
}

function crescentPath(pts, wMax) {
  const n = pts.length;
  const outer = [], inner = [];
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    const prev = pts[i === 0 ? 0 : i - 1];
    const next = pts[i === n - 1 ? n - 1 : i + 1];
    const dx = next.x - prev.x, dy = next.y - prev.y;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len, ny = dx / len;
    // See bandPath: sin() at the final sample is a hair BELOW zero, and
    // Math.pow(negative, fractional) is NaN.
    const w = wMax * Math.pow(Math.max(0, Math.sin((Math.PI * i) / (n - 1))), 0.62);
    outer.push([p.x + nx * w, p.y + ny * w]);
    inner.push([p.x - nx * w, p.y - ny * w]);
  }
  return toPath(outer, inner);
}

const EYES_SVG =
  '<svg viewBox="0 0 100 100" aria-hidden="true" focusable="false">' +
  '<g class="mamco-eye-pair">' +
  '<path class="mamco-eye" d="' + crescentPath(quadPoints(18.5, 42, 31.25, 66, 44, 42), 3.3) + '"/>' +
  '<path class="mamco-eye" d="' + crescentPath(quadPoints(56, 42, 68.75, 66, 81.5, 42), 3.3) + '"/>' +
  '</g></svg>';

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


    // Back half of the halo, then the body, then the front half. Three
    // siblings rather than one layer, because a child can never paint
    // behind its own parent's background -- and the ring passing behind
    // the body is the whole point.
    const uid = 'mamco' + (++instanceUid);
    // Behind the body: the half of every ribbon whose depth is negative.
    // In front: the half whose depth is positive, plus the side cups.
    // No mask anywhere -- the split IS the depth, so there is nothing left
    // for a screen-space gradient to approximate.
    const haloBack = document.createElement('div');
    haloBack.className = 'mamco-halo mamco-halo--back';
    haloBack.innerHTML = ribbonLayer(uid + 'b', 'back');
    const haloFront = document.createElement('div');
    haloFront.className = 'mamco-halo mamco-halo--front';
    haloFront.innerHTML = ribbonLayer(uid + 'f', 'front');

    // The eyes ride ABOVE the front ribbons. Nothing may cross the face:
    // a band drawn over them cost the character its expression, which is
    // the one thing the whole object exists to carry.
    const eyes = document.createElement('div');
    eyes.className = 'mamco-eyes';
    // The cups share the face's layer because they are the same thing: the
    // parts that make this a character rather than a sphere, and the parts
    // that must survive with every ribbon switched off.
    eyes.innerHTML = CUPS_SVG(uid + 'c') + EYES_SVG;

    this._float.appendChild(haloBack);
    this._float.appendChild(this._orb);
    this._float.appendChild(haloFront);
    this._float.appendChild(eyes);
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
