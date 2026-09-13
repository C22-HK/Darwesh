// On-device ID document detection for the verification camera.
//
// WHAT THIS IS FOR
// ----------------
// It answers exactly one question, many times a second:
//
//     "Is a card-shaped document sitting in the frame well enough to
//      photograph right now, and if not, what is the ONE thing to say?"
//
// It does NOT answer "is this ID genuine", "whose ID is this", or
// "is this person verified". A ready verdict from this file means
// CAPTURE-READY and nothing else. Authenticity stays a human review
// decision on the backend (§AK, §25 of the brief).
//
// PRIVACY: every pixel stays in this tab. Frames are drawn to a local
// canvas, reduced to numbers, and discarded. No frame, no corner list,
// no metric is uploaded, logged, or handed to analytics. The only bytes
// that ever leave are the final accepted JPEGs, through the existing
// evidence upload path.
//
// WHY NOT OpenCV.js
// -----------------
// The brief prefers a locally vendored OpenCV.js/WASM build and permits
// "another reliable local CV implementation". The real vendored build is
// 10,378,215 bytes -- 9.9 MB, measured, not estimated. That is a blocking
// download before the camera can guide anyone, on exactly the mobile
// connections this flow is for, against a stated target of "about 1-2
// minutes" for the whole journey. The work actually needed here is a
// constrained one: find the four edges of a light rectangle that the
// person is already holding inside a drawn guide. That is a few hundred
// lines, so it is those lines rather than 9.9 MB.
//
// HOW IT WORKS
// ------------
// Per analysed frame, at ANALYSIS_WIDTH (not the capture resolution):
//
//   1. grayscale
//   2. mean luma inside the guide            -> brightness
//   3. variance of the Laplacian             -> sharpness
//   4. Sobel gradients                       -> edge magnitude + direction
//   5. a Hough transform restricted to two narrow angle bands, so only
//      near-horizontal and near-vertical lines can score at all, and a
//      pixel only votes for a line its own gradient is perpendicular to
//   6. top-2 peaks per band, separated far enough apart to be opposite
//      edges of one card rather than two reads of the same edge
//   7. intersect the four lines            -> four corners
//   8. geometry: coverage, clipping, aspect, perspective
//   9. corner movement against the previous frame -> stability
//
// Step 5 is what makes this work on a tilted card: fitting real lines and
// intersecting them recovers true corners, where an axis-aligned
// bounding-box approach would report a square that is not the card.

// Analysis resolution. 256px across is enough to localise a card edge to
// ~1px, which at capture resolution is far finer than the tolerances
// below, and cheap enough to run every frame on a mid-range phone.
const ANALYSIS_WIDTH = 256;

// Angle bands, in degrees away from exactly horizontal / vertical. A card
// held more crooked than this is a "hold it straighter" case, not a
// detection case -- so refusing to fit lines that far off is the correct
// behaviour, not a limitation.
const ANGLE_BAND_DEG = 26;

// Gradient magnitude below this is texture or noise, not a document edge.
const EDGE_MIN_MAGNITUDE = 40;

// Two peaks in the same band must be at least this far apart (as a
// fraction of the image) to count as opposite edges of one card.
const MIN_EDGE_SEPARATION = 0.22;

// A line needs this many votes (as a fraction of the best line's votes)
// before it is believed at all. Stops a faint gradient from becoming a
// phantom card edge.
const MIN_PEAK_RATIO = 0.32;

// One physical edge is not one bin. A Sobel response is 3px wide and a rho
// bin is ~2.9px at the analysis size, so a single card border lands across
// two or three bins and, when the profile dips slightly between them,
// registers as two or three separate local maxima. Candidates this close
// together are therefore treated as ONE edge and collapsed to their
// vote-weighted centroid. See topTwoPeaks for what this fixes.
const PEAK_MERGE_BINS = 2;

// --- Acceptance thresholds -------------------------------------------
// ID-1 (the physical national-ID card format) is 85.6 x 54 mm = 1.586.
// Perspective, the person's hand angle and honest framing all move the
// APPARENT ratio, so this is deliberately generous: the aspect check is
// here to reject things that are not card-shaped at all (a passport page,
// a hand, a table edge), not to grade the photograph.
const ASPECT_NOMINAL = 1.586;
const ASPECT_MIN = 1.25;
const ASPECT_MAX = 2.05;

// Share of the guide area the card must fill. Under MIN the ID number
// will not be readable; over MAX the card is about to overflow the frame.
const COVERAGE_MIN = 0.40;
const COVERAGE_MAX = 1.28;

// A clipped quad this large is an overflowing card, not a drifting one.
const CLIPPED_IS_TOO_CLOSE_COVERAGE = 0.75;

// Share of an image border line that must be document-bright before the
// document counts as running off that border.
const BORDER_RUN_FRACTION = 0.45;

// A corner this close to the image edge (fraction of the short side)
// means a corner is probably already outside it.
const CLIP_MARGIN = 0.012;

// Perspective: how far the quad may depart from a parallelogram. Measured
// as the worst disagreement between opposite side lengths.
const PERSPECTIVE_MAX_SKEW = 0.30;

// A right angle at every corner, within this many degrees.
const CORNER_ANGLE_TOLERANCE_DEG = 22;

// In-plane rotation. This is a SEPARATE thing from perspective: a card
// rotated 20 degrees on the table is still a perfect rectangle, so the
// corner-angle and skew checks above pass it happily, and it is genuinely
// no harder to read. It is still worth asking for an upright card -- a
// reviewer comparing a crooked photo to an upright one is doing avoidable
// work -- so it gets its own, looser limit and its own message.
const ROTATION_MAX_DEG = 14;

const BRIGHTNESS_MIN = 55;          // 0-255 mean luma inside the guide
const SHARPNESS_MIN = 42;           // variance of the Laplacian

// Mean corner movement, as a fraction of image width, that still counts
// as holding still.
const STABILITY_MAX_DRIFT = 0.012;

/** Reasons, in the order they are reported. Exactly one reaches the UI at
 *  a time -- a person given six corrections at once fixes none of them. */
export const REASONS = Object.freeze({
  NO_DOCUMENT: 'no_document',
  CLIPPED: 'clipped',
  TOO_FAR: 'too_far',
  TOO_CLOSE: 'too_close',
  NOT_STRAIGHT: 'not_straight',
  TOO_DARK: 'too_dark',
  BLURRY: 'blurry',
  MOVING: 'moving',
  READY: 'ready',
});

const DEG = Math.PI / 180;

/**
 * Creates a detector. One per camera session: it keeps the analysis
 * canvas and the previous frame's corners, so stability can be measured
 * without the caller tracking anything.
 */
export function createDocumentDetector() {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  let previous = null;
  let steadyFrames = 0;

  /**
   * Analyses one frame.
   *
   * @param {HTMLVideoElement} source  the live preview
   * @param {{x:number,y:number,w:number,h:number}} guide
   *        the drawn guide in NORMALISED coordinates (0-1) of the
   *        displayed frame, so the detector judges the card against what
   *        the person can actually see rather than a hidden rectangle.
   * @returns {{found:boolean, ready:boolean, reason:string,
   *            corners:Array<{x:number,y:number}>|null, metrics:object}}
   */
  function analyse(source, guide) {
    const vw = source.videoWidth || source.width;
    const vh = source.videoHeight || source.height;
    if (!vw || !vh) return miss(REASONS.NO_DOCUMENT);

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
      // A tainted canvas cannot be read. Detection is an assist, so its
      // absence must degrade to the manual shutter, never break capture.
      return miss(REASONS.NO_DOCUMENT);
    }

    const gray = toGray(pixels, w, h);
    const g = guideRect(guide, w, h);
    const brightness = meanLuma(gray, w, h, g);
    const sharpness = laplacianVariance(gray, w, h, g);
    // Measured from the pixels, INDEPENDENTLY of quad fitting. It has to
    // be: once a card edge crosses the image boundary there is no longer
    // an opposite pair of parallel edges to fit, so the quad search
    // honestly finds nothing -- and a card hanging half out of frame
    // would then be reported as "no document", which is true but not the
    // useful thing to say. This is what makes "keep all four corners
    // visible" reachable at all.
    const touching = bordersTouched(gray, w, h, g);
    const quad = findQuad(gray, w, h);

    if (!quad) {
      previous = null;
      steadyFrames = 0;
      return {
        found: touching > 0,
        ready: false,
        reason: touching > 0 ? REASONS.CLIPPED : REASONS.NO_DOCUMENT,
        corners: null,
        metrics: { brightness, sharpness, bordersTouched: touching },
      };
    }

    const geo = describeQuad(quad, w, h, g);
    const drift = previous ? meanDrift(quad, previous, w) : Infinity;
    previous = quad;

    // Order matters. Geometry first, because "move closer" is actionable
    // even in bad light, while "more light" is confusing when the card is
    // not really in frame yet. Stability last: it is the only one that
    // resolves by doing nothing.
    let reason = REASONS.READY;
    // too_close is tested BEFORE clipped, and the order is the whole
    // message. A card overflowing the frame is both oversized and
    // cornerless, but only one of those is the thing to do about it:
    // "move slightly farther away" fixes it, "keep all four corners
    // visible" just describes it.
    if (geo.coverage > COVERAGE_MAX) reason = REASONS.TOO_CLOSE;
    // Clipped splits into two different problems with two different
    // remedies, and the detected size tells them apart. A quad filling
    // most of the frame AND touching its edge is a card held too close --
    // backing off fixes it, and its true size cannot even be measured
    // while it overflows. A normal-sized quad touching the edge is a card
    // that has drifted out of frame, which is a different instruction.
    else if (geo.clipped && geo.coverage > CLIPPED_IS_TOO_CLOSE_COVERAGE) reason = REASONS.TOO_CLOSE;
    else if (geo.clipped) reason = REASONS.CLIPPED;
    else if (geo.coverage < COVERAGE_MIN) reason = REASONS.TOO_FAR;
    else if (geo.aspect < ASPECT_MIN || geo.aspect > ASPECT_MAX
             || geo.skew > PERSPECTIVE_MAX_SKEW
             || geo.worstAngleError > CORNER_ANGLE_TOLERANCE_DEG
             || geo.rotationDeg > ROTATION_MAX_DEG) reason = REASONS.NOT_STRAIGHT;
    else if (brightness < BRIGHTNESS_MIN) reason = REASONS.TOO_DARK;
    else if (sharpness < SHARPNESS_MIN) reason = REASONS.BLURRY;
    else if (drift > STABILITY_MAX_DRIFT) reason = REASONS.MOVING;

    if (reason === REASONS.READY) steadyFrames += 1;
    else steadyFrames = 0;

    return {
      found: true,
      ready: reason === REASONS.READY,
      reason,
      corners: quad.map((p) => ({ x: p.x / w, y: p.y / h })),
      metrics: {
        brightness,
        sharpness,
        coverage: geo.coverage,
        aspect: geo.aspect,
        skew: geo.skew,
        worstAngleError: geo.worstAngleError,
        rotationDeg: geo.rotationDeg,
        drift: drift === Infinity ? null : drift,
        steadyFrames,
      },
    };
  }

  /** Forgets the previous frame, so stability restarts from scratch. */
  function reset() {
    previous = null;
    steadyFrames = 0;
  }

  return { analyse, reset };
}

function miss(reason) {
  return { found: false, ready: false, reason, corners: null, metrics: {} };
}

function guideRect(guide, w, h) {
  const gx = guide && Number.isFinite(guide.x) ? guide.x : 0.05;
  const gy = guide && Number.isFinite(guide.y) ? guide.y : 0.2;
  const gw = guide && Number.isFinite(guide.w) ? guide.w : 0.9;
  const gh = guide && Number.isFinite(guide.h) ? guide.h : 0.6;
  return { x: gx * w, y: gy * h, w: gw * w, h: gh * h };
}

// --- Pixel stages -----------------------------------------------------

function toGray(rgba, w, h) {
  const gray = new Uint8ClampedArray(w * h);
  for (let i = 0, p = 0; i < gray.length; i++, p += 4) {
    // Rec. 601 luma: matches how a reviewer perceives the brightness of
    // the photo they will be shown.
    gray[i] = (rgba[p] * 0.299 + rgba[p + 1] * 0.587 + rgba[p + 2] * 0.114) | 0;
  }
  return gray;
}

/**
 * How many image borders the document is lying across.
 *
 * The card is the brightest large thing in frame, so a threshold halfway
 * between the guide area's median and its brightest pixel separates card
 * from background without needing to know either in advance. A border
 * line made mostly of above-threshold pixels is a border the card is
 * running off.
 *
 * @returns {number} 0-4
 */
function bordersTouched(gray, w, h, g) {
  const x0 = clamp(Math.round(g.x), 0, w - 1);
  const x1 = clamp(Math.round(g.x + g.w), 1, w);
  const y0 = clamp(Math.round(g.y), 0, h - 1);
  const y1 = clamp(Math.round(g.y + g.h), 1, h);

  const sample = [];
  for (let y = y0; y < y1; y += 2) {
    for (let x = x0; x < x1; x += 2) sample.push(gray[y * w + x]);
  }
  if (sample.length < 16) return 0;
  sample.sort((a, b) => a - b);
  const median = sample[sample.length >> 1];
  const bright = sample[Math.floor(sample.length * 0.98)];
  // Nothing distinctly bright in frame: no document to be clipped.
  if (bright - median < 40) return 0;
  const threshold = (median + bright) / 2;

  const frac = (count, total) => (total ? count / total : 0);
  let touched = 0;
  // Inset by one pixel: the outermost row can carry camera edge artefacts.
  const rowFrac = (y) => {
    let n = 0;
    for (let x = 0; x < w; x++) if (gray[y * w + x] > threshold) n++;
    return frac(n, w);
  };
  const colFrac = (x) => {
    let n = 0;
    for (let y = 0; y < h; y++) if (gray[y * w + x] > threshold) n++;
    return frac(n, h);
  };
  if (rowFrac(1) > BORDER_RUN_FRACTION) touched++;
  if (rowFrac(h - 2) > BORDER_RUN_FRACTION) touched++;
  if (colFrac(1) > BORDER_RUN_FRACTION) touched++;
  if (colFrac(w - 2) > BORDER_RUN_FRACTION) touched++;
  return touched;
}

function meanLuma(gray, w, h, g) {
  const x0 = clamp(Math.round(g.x), 0, w - 1);
  const x1 = clamp(Math.round(g.x + g.w), 1, w);
  const y0 = clamp(Math.round(g.y), 0, h - 1);
  const y1 = clamp(Math.round(g.y + g.h), 1, h);
  let sum = 0;
  let n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) { sum += gray[y * w + x]; n++; }
  }
  return n ? sum / n : 0;
}

/** Variance of the Laplacian -- the standard readable-vs-blurred proxy,
 *  and the same measure verification-model.js already uses, so "blurry"
 *  means the same thing in the camera as it does at review. */
function laplacianVariance(gray, w, h, g) {
  const x0 = clamp(Math.round(g.x) + 1, 1, w - 2);
  const x1 = clamp(Math.round(g.x + g.w) - 1, 2, w - 1);
  const y0 = clamp(Math.round(g.y) + 1, 1, h - 2);
  const y1 = clamp(Math.round(g.y + g.h) - 1, 2, h - 1);
  let sum = 0;
  let sqSum = 0;
  let n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = y * w + x;
      const lap = 4 * gray[i] - gray[i - 1] - gray[i + 1] - gray[i - w] - gray[i + w];
      sum += lap;
      sqSum += lap * lap;
      n++;
    }
  }
  if (!n) return 0;
  const mean = sum / n;
  return sqSum / n - mean * mean;
}

/**
 * Finds the card as four fitted lines rather than a bounding box.
 *
 * Two Hough accumulators, each restricted to a narrow band of angles, and
 * a pixel only votes for lines its own gradient is perpendicular to. The
 * restriction is the whole trick: it makes the accumulators small enough
 * to run every frame, and it means a table edge at 45 degrees cannot
 * outvote the card.
 */
function findQuad(gray, w, h) {
  const diag = Math.hypot(w, h);
  const rhoBins = 220;
  const thetaBins = 27;                       // odd, so one bin is exact
  const rhoScale = rhoBins / (2 * diag);

  // theta is the angle of the line's NORMAL. 0 deg normal = vertical
  // line; 90 deg normal = horizontal line.
  const vertical = new Float32Array(rhoBins * thetaBins);
  const horizontal = new Float32Array(rhoBins * thetaBins);
  const band = ANGLE_BAND_DEG * DEG;
  const thetaStep = (2 * band) / (thetaBins - 1);

  const cosT = new Float32Array(thetaBins);
  const sinT = new Float32Array(thetaBins);
  const cosTH = new Float32Array(thetaBins);
  const sinTH = new Float32Array(thetaBins);
  for (let t = 0; t < thetaBins; t++) {
    const a = -band + t * thetaStep;          // near-vertical lines
    cosT[t] = Math.cos(a);
    sinT[t] = Math.sin(a);
    const b = a + Math.PI / 2;                // near-horizontal lines
    cosTH[t] = Math.cos(b);
    sinTH[t] = Math.sin(b);
  }

  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      // Sobel.
      const gx = (gray[i - w + 1] + 2 * gray[i + 1] + gray[i + w + 1])
               - (gray[i - w - 1] + 2 * gray[i - 1] + gray[i + w - 1]);
      const gy = (gray[i + w - 1] + 2 * gray[i + w] + gray[i + w + 1])
               - (gray[i - w - 1] + 2 * gray[i - w] + gray[i - w + 1]);
      const mag = Math.hypot(gx, gy);
      if (mag < EDGE_MIN_MAGNITUDE) continue;

      // A near-vertical edge has a mostly horizontal gradient, and the
      // other way round. Sorting each pixel into one accumulator only
      // keeps both of them clean.
      const toVertical = Math.abs(gx) > Math.abs(gy);
      const acc = toVertical ? vertical : horizontal;
      const ca = toVertical ? cosT : cosTH;
      const sa = toVertical ? sinT : sinTH;

      for (let t = 0; t < thetaBins; t++) {
        const rho = x * ca[t] + y * sa[t];
        const r = ((rho + diag) * rhoScale) | 0;
        if (r >= 0 && r < rhoBins) acc[r * thetaBins + t] += mag;
      }
    }
  }

  const vPair = topTwoPeaks(vertical, rhoBins, thetaBins, diag, rhoScale, w);
  const hPair = topTwoPeaks(horizontal, rhoBins, thetaBins, diag, rhoScale, h);
  if (!vPair || !hPair) return null;

  const lines = [
    line(vPair[0], cosT, sinT, thetaStep, band),
    line(vPair[1], cosT, sinT, thetaStep, band),
    line(hPair[0], cosTH, sinTH, thetaStep, band),
    line(hPair[1], cosTH, sinTH, thetaStep, band),
  ];

  // Corner = intersection of one vertical-ish and one horizontal-ish line.
  const corners = [
    intersect(lines[0], lines[2]),
    intersect(lines[1], lines[2]),
    intersect(lines[1], lines[3]),
    intersect(lines[0], lines[3]),
  ];
  if (corners.some((c) => !c)) return null;
  return orderCorners(corners);
}

/**
 * Picks the two lines that bound the document, which is NOT the same as
 * the two highest-scoring lines.
 *
 * A real ID card is covered in print: a dark photo box and rows of text
 * put strong, clean, perfectly straight edges INSIDE the card. Taking the
 * strongest peaks finds those instead of the border, and the card then
 * measures too short -- which is exactly what the synthetic test card
 * showed before this was written (aspect 1.92 against a true 1.586).
 *
 * The border is the OUTERMOST edge pair. So: keep every peak that is
 * credible at all, then take the widest-separated credible pair.
 */
function topTwoPeaks(acc, rhoBins, thetaBins, diag, rhoScale, span) {
  // STEP 1 -- one orientation for the whole pair.
  //
  // The two long edges of a rectangle are parallel, so in (rho, theta)
  // they sit at the SAME theta and differ only in rho. Searching each rho
  // row for its own best theta ignores that, and the first version of
  // this function did exactly that: it picked lines at opposite ends of
  // the angle band, because a single physical edge smears across many rho
  // bins as theta varies, and that smear reaches rho values far outside
  // the card. The well-framed test card came back at 26 degrees of
  // rotation with 30 degrees of corner error -- a quad that was not the
  // card at all.
  //
  // Committing to one theta first removes the smear by construction.
  let bestT = 0;
  let bestV = 0;
  for (let t = 0; t < thetaBins; t++) {
    let colBest = 0;
    for (let r = 0; r < rhoBins; r++) {
      const v = acc[r * thetaBins + t];
      if (v > colBest) colBest = v;
    }
    if (colBest > bestV) { bestV = colBest; bestT = t; }
  }
  if (!bestV) return null;

  // STEP 2 -- the rho profile at that orientation, +/- one bin so a card
  // a fraction of a degree off the bin centre is not penalised.
  const profile = new Float32Array(rhoBins);
  let peak = 0;
  for (let r = 0; r < rhoBins; r++) {
    let s = 0;
    for (let t = Math.max(0, bestT - 1); t <= Math.min(thetaBins - 1, bestT + 1); t++) {
      s += acc[r * thetaBins + t];
    }
    profile[r] = s;
    if (s > peak) peak = s;
  }

  // STEP 3 -- local maxima above the credibility floor.
  const floor = peak * MIN_PEAK_RATIO;
  const candidates = [];
  for (let r = 1; r < rhoBins - 1; r++) {
    if (profile[r] >= floor && profile[r] >= profile[r - 1] && profile[r] >= profile[r + 1]) {
      candidates.push(r);
    }
  }
  if (candidates.length < 2) return null;

  // STEP 4 -- collapse each PHYSICAL edge to one position.
  //
  // A single card border is wider than a rho bin, so it arrives as two or
  // three neighbouring local maxima with a shallow dip between them, and
  // the outermost of those sits a couple of pixels beyond the real edge.
  // With the outermost-pair rule below, that error lands on BOTH sides and
  // doubles: measured against a still test card the height came back 58.1
  // analysis pixels against a true 53, and the aspect read 1.33 against a
  // true 1.586 -- enough to over-report coverage by about 12% and to tell
  // a correctly-held card to move back early.
  //
  // The vote-weighted centroid of the neighbours is the sub-bin position
  // of the edge itself: the same card then measures 52.2 against 53, and
  // 1.55 against 1.586. Merging only reaches PEAK_MERGE_BINS, so printed
  // rows inside the card stay separate candidates and the outermost rule
  // below still has real interior peaks to reject.
  //
  // The span is measured from the START of the cluster, never from its
  // last member. Chaining "within 2 bins of the previous one" instead
  // swallows a whole card: printed rows on a small card sit about 2 bins
  // apart, so every row links to the next and the top border, the photo
  // box and all five text rows collapse into one cluster -- at which
  // point there is no second cluster and the card reports as no document
  // at all. Capping the span keeps a cluster to one edge's real width.
  const clusters = [];
  let group = [candidates[0]];
  for (let i = 1; i < candidates.length; i++) {
    if (candidates[i] - group[0] <= PEAK_MERGE_BINS) group.push(candidates[i]);
    else { clusters.push(group); group = [candidates[i]]; }
  }
  clusters.push(group);
  if (clusters.length < 2) return null;

  const centre = (bins) => {
    let wSum = 0;
    let rSum = 0;
    bins.forEach((r) => { wSum += profile[r]; rSum += r * profile[r]; });
    return wSum > 0 ? rSum / wSum : bins[0];
  };

  // STEP 5 -- the OUTERMOST credible pair, not the strongest.
  //
  // A real ID card is covered in print: a dark photo box and rows of text
  // put strong, clean, straight edges INSIDE the card. The strongest
  // peaks are often those, and the card then measures too short. The
  // border is the outermost pair.
  const minGap = MIN_EDGE_SEPARATION * span * rhoScale;
  const lo = centre(clusters[0]);
  const hi = centre(clusters[clusters.length - 1]);
  if (hi - lo < minGap) return null;

  const toRho = (r) => (r + 0.5) / rhoScale - diag;
  return [{ rho: toRho(lo), t: bestT }, { rho: toRho(hi), t: bestT }];
}

function line(peak, ca, sa, thetaStep, band) {
  return { a: ca[peak.t], b: sa[peak.t], c: peak.rho, theta: -band + peak.t * thetaStep };
}

/** Intersection of a1*x + b1*y = c1 and a2*x + b2*y = c2. */
function intersect(l1, l2) {
  const det = l1.a * l2.b - l2.a * l1.b;
  if (Math.abs(det) < 1e-6) return null;       // parallel: no corner
  return {
    x: (l1.c * l2.b - l2.c * l1.b) / det,
    y: (l1.a * l2.c - l2.a * l1.c) / det,
  };
}

/** Clockwise from top-left, so side lengths and angles mean the same
 *  thing on every frame regardless of which line won which peak. */
function orderCorners(pts) {
  const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
  const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
  const sorted = pts.slice().sort((p, q) =>
    Math.atan2(p.y - cy, p.x - cx) - Math.atan2(q.y - cy, q.x - cx));
  // Rotate so the corner nearest the top-left is first.
  let k = 0;
  let bestD = Infinity;
  sorted.forEach((p, i) => {
    const d = p.x * p.x + p.y * p.y;
    if (d < bestD) { bestD = d; k = i; }
  });
  return sorted.slice(k).concat(sorted.slice(0, k));
}

function describeQuad(q, w, h, g) {
  const side = (i, j) => Math.hypot(q[j].x - q[i].x, q[j].y - q[i].y);
  const top = side(0, 1);
  const right = side(1, 2);
  const bottom = side(2, 3);
  const left = side(3, 0);

  const longSide = (top + bottom) / 2;
  const shortSide = (left + right) / 2;
  const aspect = shortSide > 0 ? longSide / shortSide : 0;

  // Opposite sides of a card photographed head-on are equal. How unequal
  // they are is how much perspective is in the shot.
  const skew = Math.max(
    relDiff(top, bottom),
    relDiff(left, right),
  );

  const worstAngleError = Math.max(
    ...[0, 1, 2, 3].map((i) => Math.abs(90 - cornerAngle(q, i))),
  );

  // In-plane rotation, from the top edge's angle off horizontal.
  const rotationDeg = Math.abs(
    Math.atan2(q[1].y - q[0].y, q[1].x - q[0].x) / DEG,
  );

  const area = polygonArea(q);
  const guideArea = Math.max(1, g.w * g.h);
  const coverage = area / guideArea;

  const mx = CLIP_MARGIN * Math.min(w, h);
  const clipped = q.some((p) => p.x < mx || p.y < mx || p.x > w - mx || p.y > h - mx);

  return {
    aspect, skew, worstAngleError, rotationDeg, coverage, clipped,
    nominalAspect: ASPECT_NOMINAL,
  };
}

function cornerAngle(q, i) {
  const prev = q[(i + 3) % 4];
  const next = q[(i + 1) % 4];
  const v1x = prev.x - q[i].x;
  const v1y = prev.y - q[i].y;
  const v2x = next.x - q[i].x;
  const v2y = next.y - q[i].y;
  const n1 = Math.hypot(v1x, v1y);
  const n2 = Math.hypot(v2x, v2y);
  if (!n1 || !n2) return 0;
  const cos = clamp((v1x * v2x + v1y * v2y) / (n1 * n2), -1, 1);
  return Math.acos(cos) / DEG;
}

function polygonArea(q) {
  let a = 0;
  for (let i = 0; i < q.length; i++) {
    const j = (i + 1) % q.length;
    a += q[i].x * q[j].y - q[j].x * q[i].y;
  }
  return Math.abs(a) / 2;
}

function meanDrift(a, b, w) {
  let sum = 0;
  for (let i = 0; i < 4; i++) sum += Math.hypot(a[i].x - b[i].x, a[i].y - b[i].y);
  return sum / 4 / w;
}

function relDiff(a, b) {
  const m = Math.max(a, b);
  return m > 0 ? Math.abs(a - b) / m : 0;
}

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

// Exported for the test harness, so the thresholds a QA run asserts
// against are the same constants the detector uses.
export const THRESHOLDS = Object.freeze({
  ANALYSIS_WIDTH,
  ASPECT_NOMINAL,
  ASPECT_MIN,
  ASPECT_MAX,
  COVERAGE_MIN,
  COVERAGE_MAX,
  BRIGHTNESS_MIN,
  SHARPNESS_MIN,
  STABILITY_MAX_DRIFT,
  PERSPECTIVE_MAX_SKEW,
  CORNER_ANGLE_TOLERANCE_DEG,
  ROTATION_MAX_DEG,
  BORDER_RUN_FRACTION,
});
