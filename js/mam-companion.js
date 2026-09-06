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

// THE HALO -- light flowing around the body. STAGE 2.
//
// Two generations died here and both died of the same cause. The first drew
// SVG <ellipse> outlines and read as an atom diagram. The second replaced
// them with real circles in 3D, tilted and projected -- which is a better
// story but the same picture, because THE PROJECTION OF A TILTED CIRCLE IS
// AN ELLIPSE. Perfect, closed, symmetrical about two axes, uniform curvature
// everywhere. The spec rules out exactly that: no mathematical ellipses, no
// orbital rings, no uniform circles, no technical-diagram geometry.
//
// So the strand is no longer a circle. Its radius is a circle plus a couple
// of slow harmonics, and its DEPTH carries harmonics of its own that the
// screen position never sees. The first breaks the closed-form curve -- the
// path wanders in and out, tighter on one shoulder than the other, with no
// axis of symmetry to find. The second means a strand can dip behind the
// body and come back out at a place the outline gives no hint of, which is
// what light on a real surface does and what a ring cannot do.
//
// Because depth now wobbles independently, a strand no longer crosses the
// silhouette at two tidy antipodes. It can cross four or six times, at
// irregular places. So the split is no longer "front half, back half": the
// strand is cut wherever its depth changes sign, and each piece is filed
// into the layer its own depth belongs to. That irregular weaving is most of
// what separates flowing light from an orbit.
//
// Along each piece the half-width follows |depth| and tapers to nothing at
// both cut ends, so light slides under the body's edge rather than stopping
// against it. Bright and quiet runs come out of the geometry, not out of
// hand-placed stops.
//
// THE FACE OUTRANKS THE LIGHT. Any front-layer piece passing over the eye
// region is thinned toward vanishing by faceEase() -- not clipped, which
// would leave a cut edge, but starved, so it reads as light passing behind
// the glow of the face. If the halo pulls the eye before the eyes do, the
// hierarchy is wrong, and this is the mechanism that keeps it right.
//
// Each band is a FILLED path, not a stroke: a stroke has one width for its
// whole length, and varying width is most of what separates light from a
// drawn curve.
//
// Cost is unchanged -- geometry is computed once at construction and never
// again; the living motion is CSS transforms on the groups.
const TAU = Math.PI * 2;
const DEG = Math.PI / 180;
const RIB_SAMPLES = 140;         // over a whole loop; smooth at every shipped size

/**
 * One wandering strand in 3D, projected to the halo's 100x100 box.
 *
 * `alpha` is how far the strand's plane is turned away from the screen: 0
 * faces you (no depth), 90 is edge-on. It stays well under 90 -- an edge-on
 * loop projects to a straight line, which once drew a bright scratch across
 * the face.
 *
 * `rMod` are radius harmonics {k, a, p}: what makes the outline stop being
 * an ellipse. `zMod` are depth harmonics: what makes the weave irregular.
 * `span` cuts an open arc out of the loop instead of closing it.
 */
function strandPoints({ r, cx = 50, cy = 50, tilt, alpha, rMod = [], zMod = [], span }) {
  const [t0, t1] = span || [0, TAU];
  const samples = Math.max(28, Math.round((RIB_SAMPLES * (t1 - t0)) / TAU));
  const a = alpha * DEG;
  const ck = Math.cos(a);        // foreshortening across the strand
  const sk = Math.sin(a);        // how much of the sweep is depth
  const ct = Math.cos(tilt * DEG), st = Math.sin(tilt * DEG);
  const pts = [];
  for (let i = 0; i <= samples; i++) {
    const t = t0 + ((t1 - t0) * i) / samples;
    let rr = r;
    for (const m of rMod) rr += r * m.a * Math.sin(m.k * t + m.p);
    const x0 = rr * Math.cos(t);
    const y0 = rr * Math.sin(t) * ck;
    let z = rr * Math.sin(t) * sk;
    for (const m of zMod) z += r * m.a * Math.sin(m.k * t + m.p);
    pts.push({
      x: cx + x0 * ct - y0 * st,
      y: cy + x0 * st + y0 * ct,
      d: Math.max(-1, Math.min(1, z / r))     // -1 far .. +1 near
    });
  }
  return pts;
}

/**
 * Start a closed loop at a depth crossing.
 *
 * Sampling starts wherever t=0 happens to land, which is almost never a
 * crossing -- so the first and last pieces of the loop are one continuous
 * run of light that would get tapered to nothing at both ends and leave a
 * dark notch at an arbitrary angle. Rotating the array so it begins just
 * after a sign change puts that seam exactly where the strand passes under
 * the silhouette, where it is invisible by construction.
 */
function rotateToCrossing(pts) {
  const n = pts.length - 1;      // last point duplicates the first
  for (let i = 0; i < n; i++) {
    if ((pts[i].d >= 0) !== (pts[(i + 1) % n].d >= 0)) {
      const out = [];
      for (let j = 0; j <= n; j++) out.push(pts[(i + 1 + j) % n]);
      return out;
    }
  }
  return pts;                    // never crosses; one piece, one layer
}

/**
 * Cut a strand wherever its depth changes sign, interpolating the exact
 * crossing so each piece ends ON the silhouette rather than near it.
 */
function depthSegments(pts) {
  const segs = [];
  let cur = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    if ((a.d >= 0) !== (b.d >= 0)) {
      const f = Math.abs(a.d) / (Math.abs(a.d) + Math.abs(b.d) || 1);
      const cross = { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, d: 0 };
      segs.push(cur.concat([cross]));
      cur = [cross, b];
    } else {
      cur.push(b);
    }
  }
  segs.push(cur);
  // Slivers of three points or fewer are sampling noise around a crossing,
  // not light. They would render as specks.
  return segs.filter((s) => s.length > 3);
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

// THE FACE'S RIGHT OF WAY.
//
// Measured off the shipped body: the eyes span x 22.1..78.0 (55.9% of the
// body) and y 47.6..61.6 (14%), centred at y 54.6%. This ellipse is that
// block plus a small margin -- rx 29, ry 9 -- and any front strand inside
// it is starved rather than cut, so light thins toward the eye row rather
// than stopping at a hard edge.
//
// An earlier pass set ry to 13.5 -- 27% of body height, almost double the
// eyes' own 14%. That band reached from the crown nearly to the cups, so
// most of every front strand's length fell inside it and the whole halo
// read as barely there. Protecting only the eyes' own row, not the whole
// lower face, is what lets the crown and the falls either side of it stay
// visible while the eyes still win wherever a strand actually crosses them.
const FACE = { cx: 50, cy: 54.6, rx: 29, ry: 9 };
function faceEase(p) {
  const q = ((p.x - FACE.cx) / FACE.rx) ** 2 + ((p.y - FACE.cy) / FACE.ry) ** 2;
  return q >= 1 ? 1 : 0.16 + 0.84 * Math.pow(q, 0.6);
}

/**
 * Offset one piece into a closed band. Width follows depth and tapers to
 * nothing at the piece's own ends, which are silhouette crossings.
 */
function bandPath(pts, wBase, isFront) {
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
    // max(0, ...) is load-bearing: sin(PI*u) at u=1 comes out at -3.2e-16
    // rather than 0, and Math.pow of a negative is NaN -- which an SVG path
    // does not report, it just stops parsing there.
    // The floor was 0.30 -- near a depth crossing (|d| close to 0) a piece
    // thinned to less than a third of wBase even at the middle of its own
    // taper, and stacked with the taper curve itself that was most of why
    // the halo read as a set of faint curls rather than light: too much of
    // every piece's length sat below a third strength before the specular
    // gradient and opacity even got a turn at it. 0.48 keeps the depth cue
    // -- a piece still swells toward the pole and thins toward the crossing
    // -- without so much of it disappearing first.
    const taper = Math.pow(Math.max(0, Math.sin(Math.PI * u)), 0.4);
    let w = wBase * taper * (0.48 + 0.52 * Math.abs(p.d));
    if (isFront) w *= faceEase(p);
    outer.push([p.x + nx * w, p.y + ny * w]);
    inner.push([p.x - nx * w, p.y - ny * w]);
  }
  return toPath(outer, inner);
}

// NOTHING HERE CLOSES.
//
// The first attempt at this stage kept the strands as closed loops and
// tried to make them organic by wobbling the radius. Rendered with the body
// dimmed away it was still, unmistakably, an atom: five circuits sharing
// one centre. That is the lesson -- a strand that completes a full circuit
// IS an orbit no matter what its radius does along the way, because the
// closure is what the eye reads, not the curvature. And a shared centre is
// what turns a group of them into a nucleus.
//
// So every strand is an OPEN ARC, and a short one: it comes up out of
// nothing, sweeps, and dissolves. No span reaches even three quarters of a
// circuit, so there is never a closing half for the eye to complete. No two
// share a centre, a radius, a length, a tilt, a plane angle, a weight or a
// set of harmonics. That is flowing light; the previous version was
// geometry.
//
// The body's radius in this box is 39.1 (the halo is inset -14%). Radii sit
// near 0.85-1.15 of it, so the light HUGS MAM -- an early version reached
// 1.47 and sprawled.
//
// Plane angles stay between 38 and 60. Near 90 a strand is edge-on, and an
// edge-on arc projects to a straight line -- which is how one once drew a
// bright scratch across the face.
//
// COMPOSITION, not scatter. `span` runs in the strand's own parameter,
// where t near 0 is the right of the body, PI/2 below it, PI the left and
// 3PI/2 above. Placed with that in hand the five read as one arrangement:
// the crown over the head, a fall down each side, one quiet arc grounding
// the chin, and a single brief glint. Left and right carry different
// weights and different lengths, so it balances without being symmetrical.
//
// A first pass placed them by feel and put three of the five across the
// bottom -- the light pooled under the chin like a collar and the crown,
// the one place the reference actually gathers light, had none.
//
// zMod amplitudes are large on purpose. They have to beat sin(t)*sin(alpha)
// somewhere in the span or the strand never changes sign, stays in one
// layer and never weaves -- which is what left the crown wholly behind the
// body and invisible.
// Weights (w) and lengths (span) both went up a step from the pass before
// this one. Rendered with the body dimmed away, that pass measured out at
// under 26% of a full 5-strand budget and it SHOWED: two of the five barely
// registered next to the crown and the right fall. Wider strands and a
// little more arc length close that gap without touching what made the
// earlier version read as light rather than rings -- open ends, no shared
// centre, independent harmonics.
const RIBBONS = [
  // The crown flow. Boldest of the five, and the only one over the brow:
  // it rises at one temple, gathers over the head, dissolves at the other.
  { r: 34, cx: 50, cy: 35, tilt: -8, alpha: 46, w: 1.05,
    span: [Math.PI * 1.06, Math.PI * 1.98],
    rMod: [{ k: 1, a: 0.12, p: 1.9 }, { k: 2, a: 0.07, p: 0.6 }],
    zMod: [{ k: 2, a: 0.58, p: 2.2 }] },
  // The fall down the right, carrying on from where the crown lets go.
  { r: 41, cx: 49, cy: 52, tilt: 10, alpha: 52, w: 0.72,
    span: [Math.PI * 1.66, Math.PI * 2.30],
    rMod: [{ k: 1, a: 0.11, p: 0.4 }, { k: 2, a: 0.06, p: 2.1 }],
    zMod: [{ k: 1, a: 0.62, p: 0.9 }] },
  // The fall down the left -- thinner and longer than its opposite number.
  // The span starts high enough that part of it surfaces in FRONT of the
  // body: an earlier placement left the whole strand behind MAM, and a side
  // with nothing on it but occluded light reads as a side that was
  // forgotten rather than one deliberately kept quiet.
  { r: 43, cx: 51, cy: 51, tilt: -14, alpha: 42, w: 0.56,
    span: [Math.PI * 0.62, Math.PI * 1.32],
    rMod: [{ k: 1, a: 0.14, p: 1.3 }, { k: 3, a: 0.05, p: 2.7 }],
    zMod: [{ k: 1, a: 0.55, p: 2.6 }] },
  // One quiet arc under the chin. One, not three: it grounds the figure
  // without hanging a collar on it.
  { r: 40, cx: 48, cy: 54, tilt: 8, alpha: 38, w: 0.50,
    span: [Math.PI * 0.26, Math.PI * 0.82],
    rMod: [{ k: 2, a: 0.10, p: 0.5 }],
    zMod: [{ k: 1, a: 0.44, p: 1.7 }] },
  // A brief glint low on the left. The shortest span here -- it exists to
  // break the regularity of the other four, nothing more. It sits opposite
  // the right-hand fall rather than alongside it: put here first, the two
  // landed on top of each other and tied a bright knot over the right cup.
  { r: 38, cx: 47, cy: 53, tilt: -20, alpha: 50, w: 0.64,
    span: [Math.PI * 0.48, Math.PI * 0.88],
    rMod: [{ k: 1, a: 0.16, p: 0.8 }],
    zMod: [{ k: 2, a: 0.40, p: 1.1 }] }
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

/**
 * One layer of the halo. A strand contributes every piece whose depth
 * belongs to this side -- which may be none, one, or several, since the
 * depth harmonics decide where it dives and surfaces.
 *
 * One <g> per strand per layer regardless, so the per-strand animation
 * classes stay stable no matter how the geometry happens to cut.
 *
 * @param {'front'|'back'} side
 */
function ribbonLayer(scope, side) {
  const wantFront = side === 'front';
  let out = '<svg viewBox="0 0 100 100" aria-hidden="true" focusable="false">' + RIB_DEFS(scope);
  RIBBONS.forEach((cfg, i) => {
    let pts = strandPoints(cfg);
    if (!cfg.span) pts = rotateToCrossing(pts);
    out += '<g class="mamco-ribbon mamco-ribbon--' + i + '">';
    for (const seg of depthSegments(pts)) {
      const mid = seg[seg.length >> 1];
      if ((mid.d >= 0) !== wantFront) continue;
      // Two passes: a wide soft bloom under a narrower bright core. Cheaper
      // and steadier than a blur filter, which would re-rasterize the layer
      // on every animation frame.
      out += '<path class="mamco-ribbon-glow" d="' + bandPath(seg, cfg.w * 2.0, wantFront) +
        '" fill="url(#' + scope + '-glow)"/>' +
        '<path class="mamco-ribbon-core" d="' + bandPath(seg, cfg.w, wantFront) +
        '" fill="url(#' + scope + '-core)"/>';
    }
    out += '</g>';
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
// PART OF THE FORM, NOT ATTACHED TO IT.
//
// Two things made these read as headphone earcups clamped onto a sphere.
// They were 36 tall -- a third of the body's height, taller than they were
// wide by two and a half times, which is the proportion of a headphone
// driver. And they sat in the FACE's layer, painted on top of the body,
// with 82% of each cup outside the silhouette: nothing occluded them, so
// nothing tied them to the mass.
//
// Now they are 23 tall against 16 wide -- close to round, a pod rather than
// a driver -- and they are drawn BEHIND the body. The silhouette cuts
// across each one, so what shows is an outer curve emerging from the mass,
// which is what makes a form read as part of a sculpture instead of an
// accessory bolted to it. Only about 9% of the body's width protrudes,
// against 11.8 before, and the rim now catches light only on the outer arc
// because the inner half is behind the stone.
//
// The rim is also dimmer than it was (0.72 peak, not 0.9). Sitting behind
// the body it no longer has to hold its own against the face, and a bright
// outline is the other half of what said "accessory".
const CUPS_SVG = (scope) =>
  '<svg viewBox="0 0 100 100" aria-hidden="true" focusable="false">' +
  '<defs>' +
  '<radialGradient id="' + scope + '-cupL" cx="0.30" cy="0.22" r="0.98">' +
  '<stop offset="0" stop-color="#332E27"/><stop offset="0.45" stop-color="#141210"/>' +
  '<stop offset="1" stop-color="#040404"/></radialGradient>' +
  '<radialGradient id="' + scope + '-cupR" cx="0.30" cy="0.22" r="0.98">' +
  '<stop offset="0" stop-color="#2C2721"/><stop offset="0.45" stop-color="#121110"/>' +
  '<stop offset="1" stop-color="#040404"/></radialGradient>' +
  '<linearGradient id="' + scope + '-cupRim" x1="0.10" y1="0" x2="0.90" y2="1">' +
  '<stop offset="0" stop-color="#FFE6B8" stop-opacity="0.72"/>' +
  '<stop offset="0.44" stop-color="#C99D60" stop-opacity="0.30"/>' +
  '<stop offset="1" stop-color="#6B5230" stop-opacity="0.10"/>' +
  '</linearGradient>' +
  '</defs>' +
  '<g class="mamco-cup">' +
  '<rect class="mamco-cup-body" x="-9" y="38.5" width="16" height="23" rx="8" fill="url(#' + scope + '-cupL)"/>' +
  '<rect class="mamco-cup-rim" x="-9" y="38.5" width="16" height="23" rx="8" stroke="url(#' + scope + '-cupRim)"/>' +
  '<ellipse class="mamco-cup-spec" cx="-4.6" cy="45" rx="1.7" ry="3.1"/>' +
  '</g>' +
  '<g class="mamco-cup">' +
  '<rect class="mamco-cup-body" x="93" y="38.5" width="16" height="23" rx="8" fill="url(#' + scope + '-cupR)"/>' +
  '<rect class="mamco-cup-rim" x="93" y="38.5" width="16" height="23" rx="8" stroke="url(#' + scope + '-cupRim)"/>' +
  '<ellipse class="mamco-cup-spec" cx="104.6" cy="45" rx="1.6" ry="3"/>' +
  '</g>' +
  '</svg>';

// Gradient ids have to be unique per document, and a page may mount more
// than one companion (the specimen sheet mounts thirteen). A per-instance
// counter keeps every gradient addressable by exactly the bands that use it.
let instanceUid = 0;

// THE EYES.
//
// The reference's eyes ARCH -- peak in the middle, both ends coming down --
// and hold a near-uniform thickness with rounded ends. Two things every
// earlier version got wrong: they bowed downward as smiles, which is a
// different expression entirely; and the last pass tapered them sharply,
// which rendered as check-marks, thick on one shoulder and pointed on the
// other. Uniform width IS the reference here. The softness comes from the
// bloom around them, not from thinning the ends.
//
// The geometry follows from wanting a specific painted box:
//     visual width  = chord + stroke   -> 21.6% of the body
//     visual height = sag   + stroke   -> 14%
// A 6.5 stroke puts the chord at 15.1 and the sag at 7.5, and a quadratic
// reaches its sag at half the control offset. Ends at y=58.75 centre the
// painted shape on 55% down; the pair spans 56% with a 13% gap. Every one
// of those numbers is measured off the reference sheet.
const EYES_SVG =
  '<svg viewBox="0 0 100 100" aria-hidden="true" focusable="false">' +
  '<g class="mamco-eye-pair">' +
  '<path class="mamco-eye" d="M25.15 58.75 Q32.7 43.75 40.25 58.75"/>' +
  '<path class="mamco-eye" d="M59.75 58.75 Q67.3 43.75 74.85 58.75"/>' +
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

    // The cups sit BEHIND the body, between the back ribbons and the stone.
    // They used to share the face's layer, painted over the body, and that
    // is most of why they read as clamped-on headphones: nothing occluded
    // them, so nothing tied them to the mass. Behind it, the silhouette
    // cuts across each pod and they become part of the form.
    const cups = document.createElement('div');
    cups.className = 'mamco-cups';
    cups.innerHTML = CUPS_SVG(uid + 'c');

    // The eyes ride ABOVE the front ribbons. Nothing may cross the face:
    // a band drawn over them cost the character its expression, which is
    // the one thing the whole object exists to carry.
    const eyes = document.createElement('div');
    eyes.className = 'mamco-eyes';
    eyes.innerHTML = EYES_SVG;

    this._float.appendChild(haloBack);
    this._float.appendChild(cups);
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
