// On-device FACE FRAMING readiness for the verification camera.
//
// WHAT THIS IS
// ------------
// It answers one question, a few times a second:
//
//     "Is the person framed inside the oval well enough to take the photo
//      right now, and if not, what is the ONE short thing to say?"
//
// WHAT IT IS NOT
// --------------
// It is NOT liveness. It is NOT face recognition. It is NOT a judgement
// that the person is who they say they are, and a ready verdict here can
// never mean "verified". It is capture assistance and nothing else --
// exactly the same trust boundary verify-doc-detect.js keeps for the card
// (§16, §25 of the brief). Nothing in this file can express authenticity;
// a test asserts none of its reason codes even contains the word.
//
// PRIVACY: every pixel stays in this tab. Frames go to a local canvas,
// become a handful of numbers, and are discarded. No frame, no box, no
// coordinate and no metric is uploaded, logged or handed to analytics.
//
// WHY NOT A FACE MODEL
// --------------------
// The brief is explicit: prefer native/local lightweight techniques, and
// "do not add a multi-megabyte dependency just for decorative
// intelligence". So there are exactly two paths, and neither downloads
// anything:
//
//   NATIVE  -- window.FaceDetector, where the browser already has it.
//              A real face box, so centring, size and clipping are real
//              measurements and the spatial nudges point the right way.
//
//   FRAMING -- everywhere else, which today is almost everywhere: the
//              Shape Detection API never shipped broadly. This measures
//              the OVAL, not a face: how much fine detail is inside it,
//              how that detail is distributed, plus light, focus and
//              stillness. It is honest about what it knows -- it says
//              "centre your face", it never claims to have found one.
//
// A DELIBERATE NON-CHOICE: no skin-tone segmentation. It is the classic
// cheap way to find a face in a webcam frame and it fails people with
// darker skin far more often than lighter -- an identity flow is the last
// place to ship that. Detail and contrast are measured instead, which is
// the same measurement for everybody.

/** Reasons, in reporting order. Exactly one reaches the UI at a time. */
export const FACE_REASONS = Object.freeze({
  NO_FACE: 'no_face',
  OFF_CENTER: 'off_center',
  TOO_FAR: 'too_far',
  TOO_CLOSE: 'too_close',
  CLIPPED: 'clipped',
  TOO_DARK: 'too_dark',
  BLURRY: 'blurry',
  MOVING: 'moving',
  READY: 'ready',
});

/** Which of the two paths above is in use. Reported so the UI can be
 *  honest: directional nudges are only meaningful with a real box. */
export const FACE_MODES = Object.freeze({ NATIVE: 'native', FRAMING: 'framing' });

const ANALYSIS_WIDTH = 224;

// --- Shared quality gates (both paths) --------------------------------
const BRIGHTNESS_MIN = 48;          // 0-255 mean luma inside the oval
const SHARPNESS_MIN = 26;           // variance of the Laplacian
// Mean absolute luma change inside the oval between analyses, 0-255. A
// person sitting still still breathes, and sensor noise is real, so this
// is "not moving the phone", not "frozen". Measured against the synthetic
// subject: holding still reads 0, and a shift of a fifth of an oval
// radius between two analyses reads 16.
const MOTION_MAX = 5.0;

// --- NATIVE path tolerances -------------------------------------------
// Face box centre may sit this far from the oval centre, as a fraction of
// the oval's own width / height.
const CENTER_MAX_OFFSET = 0.18;
// Face box height as a fraction of the oval height.
const NATIVE_FILL_MIN = 0.55;
const NATIVE_FILL_MAX = 1.15;

// --- FRAMING path tolerances ------------------------------------------
//
// WHAT THIS PATH DELIBERATELY DOES NOT CLAIM
//
// The brief allows exactly this trade (§25): where reliable face
// detection is unavailable without a large dependency, keep oval
// positioning, a stability timer and manual capture. So the framing path
// asserts only what its measurements actually support, and the synthetic
// subject tests are what decided which of those survived:
//
//   KEPT -- light, presence, horizontal centring, "much too small",
//           focus, stillness. The horizontal centroid is clean: a
//           centred subject reads 0.00, one shifted 0.42 of a radius
//           reads -0.29, and a small subject, an overflowing subject and
//           a blurred subject all stay within 0.02 of zero. That is a
//           real signal with no confound.
//
//   DROPPED -- vertical centring and "too close". The vertical centroid
//           carries a +0.24 bias for a correctly framed person, because
//           their neck and shoulders are legitimately below the oval's
//           centre, and the bias reverses as the subject overflows and
//           the shoulders leave the measured field. So a fitting subject
//           and an overflowing one are not separable this way, and
//           guessing would produce exactly the wrong instruction. Both
//           are reported by the NATIVE path, which has a real face box.
//
// A slightly off-centre or slightly close face still produces a usable
// photo, and nothing is ever accepted without the person pressing "Use
// photo" -- so declining to guess costs a retake at worst, while guessing
// wrong costs trust in every instruction the guide gives.

// Mean Sobel magnitude over the measured field. A blank wall, a ceiling
// or a palm over the lens measures 0-2; every synthetic subject, at every
// size and focus tested, measures 3.8 or more. Paired with the tonal
// spread below, which a flat surface also fails, and both must pass.
const DETAIL_MIN = 2.5;
// Standard deviation of luma inside the oval. A flat surface has almost
// none (a blank room reads 0.0); anything with real form has plenty
// (every subject tested reads 33 or more).
const SPREAD_MIN = 17;
// Detail-weighted mean radius, in units of the OVAL's radii. A subject
// far too small for the oval concentrates its detail near the centre and
// reads 0.35; every correctly-sized subject reads 0.77 or more. There is
// no upper bound here on purpose -- see DROPPED above.
const REACH_MIN = 0.55;
// Horizontal detail-centroid offset from the oval centre, in units of the
// oval's half-width.
const FRAMING_CENTER_MAX = 0.2;

/**
 * Reports which path this browser will take, without opening a camera.
 * Used by the QA harness and by nothing user-facing: both paths produce
 * the same set of short messages, so the person never sees a difference.
 */
export function faceDetectionMode() {
  return typeof globalThis.FaceDetector === 'function' ? FACE_MODES.NATIVE : FACE_MODES.FRAMING;
}

/**
 * Creates a face-framing readiness detector. One per camera session: it
 * owns the analysis canvas and remembers the previous frame, so stillness
 * can be measured without the caller tracking anything.
 */
export function createFaceReadiness() {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const mode = faceDetectionMode();

  let native = null;
  if (mode === FACE_MODES.NATIVE) {
    try {
      native = new globalThis.FaceDetector({ maxDetectedFaces: 1, fastMode: true });
    } catch {
      native = null;                 // constructed but unusable: fall through
    }
  }

  let previous = null;               // downsampled luma of the last analysis
  let steadyFrames = 0;

  /**
   * Analyses one frame. Async because the native detector is async; the
   * framing path resolves immediately.
   *
   * @param {HTMLVideoElement} source
   * @param {{x:number,y:number,w:number,h:number}} oval
   *        the drawn oval in NORMALISED (0-1) coordinates of the displayed
   *        frame, so readiness is judged against the shape the person can
   *        actually see.
   * @returns {Promise<{found:boolean, ready:boolean, reason:string,
   *                    nudge:string|null, metrics:object}>}
   *          `nudge` is a direction for the guide to lean toward
   *          ('left'|'right'|'up'|'down'|'in'|'out'), or null. It is
   *          PURELY visual guidance -- no depth sensing is implied or
   *          claimed.
   */
  async function analyse(source, oval) {
    const vw = source.videoWidth || source.width;
    const vh = source.videoHeight || source.height;
    if (!vw || !vh) return miss(FACE_REASONS.NO_FACE);

    const w = ANALYSIS_WIDTH;
    const h = Math.max(1, Math.round((vh / vw) * w));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    ctx.drawImage(source, 0, 0, w, h);

    let pixels;
    try {
      pixels = ctx.getImageData(0, 0, w, h).data;
    } catch {
      // A tainted canvas cannot be read. Readiness is an assist, so its
      // absence degrades to the manual shutter, never breaks capture.
      return miss(FACE_REASONS.NO_FACE);
    }

    const gray = toGray(pixels, w, h);
    const o = ovalRect(oval, w, h);
    const stats = ovalStats(gray, previous, w, h, o);
    const motion = stats.motion;
    previous = gray;

    // A real box beats every proxy, so try it first and fall back quietly.
    let box = null;
    if (native) {
      try {
        const faces = await native.detect(canvas);
        box = faces && faces.length ? faces[0].boundingBox : null;
      } catch {
        box = null;
      }
    }

    const verdict = box
      ? judgeNative(box, o, stats, motion, w, h)
      : judgeFraming(stats, motion);

    if (verdict.reason === FACE_REASONS.READY) steadyFrames += 1;
    else steadyFrames = 0;

    return {
      found: verdict.found,
      ready: verdict.reason === FACE_REASONS.READY,
      reason: verdict.reason,
      nudge: verdict.nudge || null,
      metrics: {
        mode: box ? FACE_MODES.NATIVE : FACE_MODES.FRAMING,
        brightness: stats.brightness,
        sharpness: stats.sharpness,
        detail: stats.detail,
        spread: stats.spread,
        reach: stats.reach,
        offsetX: verdict.offsetX,
        offsetY: verdict.offsetY,
        motion: motion === Infinity ? null : motion,
        steadyFrames,
      },
    };
  }

  function reset() {
    previous = null;
    steadyFrames = 0;
  }

  return { analyse, reset, mode };
}

function miss(reason) {
  return { found: false, ready: false, reason, nudge: null, metrics: {} };
}

/**
 * NATIVE path: a real face box, so these are measurements rather than
 * proxies. Order is the message -- position before size before light,
 * because "centre your face" is actionable even in poor light, while
 * "more light" is confusing when the face is not in the oval yet.
 */
function judgeNative(box, o, stats, motion, w, h) {
  const fx = box.x + box.width / 2;
  const fy = box.y + box.height / 2;
  const cx = o.x + o.w / 2;
  const cy = o.y + o.h / 2;
  const offsetX = (fx - cx) / o.w;
  const offsetY = (fy - cy) / o.h;
  const fill = box.height / o.h;
  // Clipped: the box runs off the frame, so part of the face is missing.
  const clipped = box.x <= 1 || box.y <= 1
    || box.x + box.width >= w - 1 || box.y + box.height >= h - 1;

  const base = { found: true, offsetX, offsetY };

  if (clipped) return { ...base, reason: FACE_REASONS.CLIPPED, nudge: 'out' };
  if (Math.abs(offsetX) > CENTER_MAX_OFFSET || Math.abs(offsetY) > CENTER_MAX_OFFSET) {
    return { ...base, reason: FACE_REASONS.OFF_CENTER, nudge: nudgeFor(offsetX, offsetY) };
  }
  if (fill < NATIVE_FILL_MIN) return { ...base, reason: FACE_REASONS.TOO_FAR, nudge: 'in' };
  if (fill > NATIVE_FILL_MAX) return { ...base, reason: FACE_REASONS.TOO_CLOSE, nudge: 'out' };
  if (stats.brightness < BRIGHTNESS_MIN) return { ...base, reason: FACE_REASONS.TOO_DARK, nudge: null };
  if (stats.sharpness < SHARPNESS_MIN) return { ...base, reason: FACE_REASONS.BLURRY, nudge: null };
  if (motion > MOTION_MAX) return { ...base, reason: FACE_REASONS.MOVING, nudge: null };
  return { ...base, reason: FACE_REASONS.READY, nudge: null };
}

/**
 * FRAMING path: no box, so nothing here claims to have found a face.
 *
 * What it can say truthfully is whether the oval currently contains a
 * SUBJECT with real form -- fine detail and a wide spread of brightness,
 * neither of which a wall, a ceiling or a palm over the lens produces --
 * and whether that subject is centred, filling the oval, lit, in focus
 * and still. Every one of those is something the person can act on, and
 * the message shown is the same short line the native path would show.
 */
function judgeFraming(stats, motion) {
  const base = { found: stats.detail >= DETAIL_MIN && stats.spread >= SPREAD_MIN,
                 offsetX: stats.offsetX, offsetY: stats.offsetY };

  // LIGHT COMES FIRST, before presence. In a dark room there is no detail
  // and no tonal spread to find, so a presence test run first reports "no
  // subject" -- true, useless, and unfixable by the person, who is
  // standing right there. "More light" is the one instruction that
  // actually changes the situation, and it is honest: too dark to assess
  // is exactly what the numbers say.
  if (stats.brightness < BRIGHTNESS_MIN) {
    return { ...base, found: false, reason: FACE_REASONS.TOO_DARK, nudge: null };
  }

  // Nothing with form in the oval. "Centre your face" is the honest and
  // useful thing to say -- not "no face detected", which would claim a
  // capability this path does not have. Both gates must pass: detail
  // rules out a flat surface, tonal spread rules out an evenly-textured
  // one, and a wall fails both.
  if (!base.found) return { ...base, reason: FACE_REASONS.NO_FACE, nudge: null };

  // Horizontal only. The vertical centroid cannot tell a correctly framed
  // person from one who is too close -- see the note above the constants.
  if (Math.abs(stats.offsetX) > FRAMING_CENTER_MAX) {
    return { ...base, reason: FACE_REASONS.OFF_CENTER, nudge: nudgeFor(stats.offsetX, 0) };
  }
  if (stats.reach < REACH_MIN) return { ...base, reason: FACE_REASONS.TOO_FAR, nudge: 'in' };
  if (stats.sharpness < SHARPNESS_MIN) return { ...base, reason: FACE_REASONS.BLURRY, nudge: null };
  if (motion > MOTION_MAX) return { ...base, reason: FACE_REASONS.MOVING, nudge: null };
  return { ...base, reason: FACE_REASONS.READY, nudge: null };
}

/**
 * The dominant correction only. Two arrows at once is two instructions,
 * and the whole point of the guide is that there is one.
 *
 * The value is the direction to MOVE, not where the subject currently is.
 * A face sitting left of centre returns 'right', and the guide emphasises
 * its right edge -- the correction is shown where the person should go.
 */
function nudgeFor(offsetX, offsetY) {
  if (Math.abs(offsetX) >= Math.abs(offsetY)) return offsetX > 0 ? 'left' : 'right';
  return offsetY > 0 ? 'up' : 'down';
}

function ovalRect(oval, w, h) {
  const x = oval && Number.isFinite(oval.x) ? oval.x : 0.18;
  const y = oval && Number.isFinite(oval.y) ? oval.y : 0.14;
  const ow = oval && Number.isFinite(oval.w) ? oval.w : 0.64;
  const oh = oval && Number.isFinite(oval.h) ? oval.h : 0.72;
  return { x: x * w, y: y * h, w: ow * w, h: oh * h };
}

function toGray(rgba, w, h) {
  const gray = new Uint8ClampedArray(w * h);
  for (let i = 0, p = 0; i < gray.length; i++, p += 4) {
    // Rec. 601 luma, the same weighting the document detector and the
    // upload-time quality measurement use, so "too dark" means one thing
    // everywhere in this flow.
    gray[i] = (rgba[p] * 0.299 + rgba[p + 1] * 0.587 + rgba[p + 2] * 0.114) | 0;
  }
  return gray;
}

/**
 * Every measurement this module needs, in ONE pass.
 *
 * TWO REGIONS, and the difference between them is not a detail.
 *
 * The CORE is the oval itself, and light and focus are judged there --
 * they are about the subject, and including the box corners would drag
 * both toward whatever is behind the person.
 *
 * The FIELD is the oval grown by REGION_SCALE, and everything positional
 * is judged there. Measuring position inside the oval alone does not
 * work, and the first version of this file got it wrong in exactly that
 * way: as the subject drifts out, the part of it that left stops being
 * counted and the background that replaced it contributes no detail, so
 * the centroid barely moves. A subject shifted almost half an oval-radius
 * to the left reported an offset of 0.07 -- well inside "centred" -- and
 * the guide cheerfully auto-captured a face against the edge of the
 * frame. The same clipping flattened the size measure: a subject
 * overflowing the oval had most of its detail cut away and read as
 * SMALLER than one that fitted. Looking slightly outside the oval is what
 * makes "move closer", "move back" and the directional nudges mean
 * anything at all.
 *
 *   brightness  mean luma                              (core)
 *   spread      standard deviation of luma             (core)
 *   sharpness   variance of the Laplacian              (core)
 *   detail      mean Sobel magnitude                   (field)
 *   reach       detail-weighted mean normalised radius (field)
 *   offsetX/Y   detail-weighted centroid               (field)
 *   motion      mean |luma change| since the last pass (field)
 *
 * `reach` and the offsets stay in units of the OVAL's radii, so a reach
 * above 1 means the subject's detail extends past the oval -- which is
 * precisely the "too close" case.
 */
const REGION_SCALE = 1.35;

function ovalStats(gray, previous, w, h, o) {
  const cx = o.x + o.w / 2;
  const cy = o.y + o.h / 2;
  const rx = Math.max(1, o.w / 2);
  const ry = Math.max(1, o.h / 2);
  const field2 = REGION_SCALE * REGION_SCALE;

  const x0 = clamp(Math.round(cx - rx * REGION_SCALE), 1, w - 2);
  const x1 = clamp(Math.round(cx + rx * REGION_SCALE), 2, w - 1);
  const y0 = clamp(Math.round(cy - ry * REGION_SCALE), 1, h - 2);
  const y1 = clamp(Math.round(cy + ry * REGION_SCALE), 2, h - 1);

  let n = 0;
  let sum = 0;
  let sqSum = 0;
  let lapSum = 0;
  let lapSqSum = 0;
  let fieldN = 0;
  let magSum = 0;
  let magRadiusSum = 0;
  let magXSum = 0;
  let magYSum = 0;
  let diffSum = 0;

  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const nx = (x - cx) / rx;
      const ny = (y - cy) / ry;
      const r2 = nx * nx + ny * ny;
      if (r2 > field2) continue;
      const i = y * w + x;
      const v = gray[i];

      if (r2 <= 1) {
        n++;
        sum += v;
        sqSum += v * v;
        const lap = 4 * v - gray[i - 1] - gray[i + 1] - gray[i - w] - gray[i + w];
        lapSum += lap;
        lapSqSum += lap * lap;
      }

      fieldN++;
      if (previous) diffSum += Math.abs(v - previous[i]);
      const gx = (gray[i - w + 1] + 2 * gray[i + 1] + gray[i + w + 1])
               - (gray[i - w - 1] + 2 * gray[i - 1] + gray[i + w - 1]);
      const gy = (gray[i + w - 1] + 2 * gray[i + w] + gray[i + w + 1])
               - (gray[i - w - 1] + 2 * gray[i - w] + gray[i - w + 1]);
      // /4 brings a Sobel magnitude back onto the 0-255 scale the
      // thresholds above are written in.
      const mag = Math.hypot(gx, gy) / 4;
      magSum += mag;
      magRadiusSum += mag * Math.sqrt(r2);
      magXSum += mag * nx;
      magYSum += mag * ny;
    }
  }

  if (!n || !fieldN) {
    return { brightness: 0, spread: 0, sharpness: 0, detail: 0, reach: 0,
             offsetX: 0, offsetY: 0, motion: Infinity };
  }
  const mean = sum / n;
  const lapMean = lapSum / n;
  return {
    brightness: mean,
    spread: Math.sqrt(Math.max(0, sqSum / n - mean * mean)),
    sharpness: Math.max(0, lapSqSum / n - lapMean * lapMean),
    detail: magSum / fieldN,
    reach: magSum > 0 ? magRadiusSum / magSum : 0,
    offsetX: magSum > 0 ? magXSum / magSum : 0,
    offsetY: magSum > 0 ? magYSum / magSum : 0,
    // Measured where the subject is, not across the whole frame. A person
    // turning their head moves a small part of a full frame and averages
    // away to almost nothing; inside the oval it is the majority of what
    // is there.
    motion: previous ? diffSum / fieldN : Infinity,
  };
}

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

// Exported for the QA harness, so the numbers a test asserts against are
// the constants the detector actually uses.
export const FACE_THRESHOLDS = Object.freeze({
  ANALYSIS_WIDTH,
  BRIGHTNESS_MIN,
  SHARPNESS_MIN,
  MOTION_MAX,
  CENTER_MAX_OFFSET,
  NATIVE_FILL_MIN,
  NATIVE_FILL_MAX,
  DETAIL_MIN,
  SPREAD_MIN,
  REACH_MIN,
  FRAMING_CENTER_MAX,
  REGION_SCALE,
});
