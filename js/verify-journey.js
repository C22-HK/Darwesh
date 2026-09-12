// The identity verification journey (§D, §E, §F).
//
// Four screens: Start (with consent), National ID, Face, Submitted. The
// person is told what to do next in one sentence per screen and never
// shown a score, a confidence percentage or a risk flag.
//
// THREE RULES THIS FILE EXISTS TO KEEP
// ------------------------------------
//  * It never decides an outcome. Capture quality is assessed here only
//    so someone can retake a blurry photo before a reviewer wastes a
//    day on it -- a "usable" image is not an approved one, and the word
//    "verified" is never rendered as a result of anything on this page.
//  * It never claims a submission that did not happen (§BI). If the
//    endpoint is not deployed, the page says exactly that and stays on
//    the review screen; it does not show the success state.
//  * It never sends image bytes to the backend. Bytes go to the
//    person's OWN private Storage prefix, which storage.rules scopes to
//    their uid; the backend is told only the object id, the kind, a
//    content hash and any readability issues.

import {
  assessCaptureQuality,
  MIN_CAPTURE_WIDTH,
  MIN_CAPTURE_HEIGHT,
} from './verification-model.js';
import { formatPercentLabel, normalizeRewardConfig } from './rewards.js';
import { submitVerification, isEndpointUnavailable } from './backend-api.js';

function tr(key, fallback) {
  return (window.t && window.t(key)) || fallback;
}

// Matches storage.rules: verification-evidence/{uid}/{fileName} accepts
// only these types, under 12MB, with a simple filename.
export const ACCEPTED_TYPES = Object.freeze(['image/jpeg', 'image/png', 'image/webp']);
export const MAX_BYTES = 12 * 1024 * 1024;
export const CONSENT_VERSION = 'identity-2026-01';
const EVIDENCE_PREFIX = 'verification-evidence';

/** A filename storage.rules will accept, unique per upload, carrying no
 *  personal information (§AQ: never the person's name). */
export function makeObjectId(kind, ext) {
  const rand = new Uint8Array(8);
  (globalThis.crypto || {}).getRandomValues?.(rand);
  const hex = Array.from(rand, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${kind}-${Date.now().toString(36)}-${hex}.${ext}`;
}

export function extensionFor(mimeType) {
  if (mimeType === 'image/png') return 'png';
  if (mimeType === 'image/webp') return 'webp';
  return 'jpg';
}

/** sha256 hex of the exact bytes uploaded, so a reviewer can tell that
 *  two submissions are the same file. Never a substitute for looking. */
export async function hashBytes(arrayBuffer) {
  const subtle = (globalThis.crypto || {}).subtle;
  if (!subtle) return '';
  const digest = await subtle.digest('SHA-256', arrayBuffer);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Measures readability from the decoded pixels.
 *
 * Downsamples to at most 480px on the long edge first: the measurements
 * are statistical, and running them over a 12-megapixel image would
 * block the main thread for no extra accuracy.
 */
export async function measureImage(blob) {
  const bitmap = await createImageBitmap(blob);
  const { width, height } = bitmap;
  const scale = Math.min(1, 480 / Math.max(width, height));
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close?.();

  const { data } = ctx.getImageData(0, 0, w, h);
  const gray = new Float32Array(w * h);
  let sum = 0;
  let blown = 0;
  for (let i = 0, p = 0; i < data.length; i += 4, p += 1) {
    // Rec. 601 luma -- the same weighting every "is this too dark"
    // heuristic uses, not a naive channel average.
    const g = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    gray[p] = g;
    sum += g;
    if (g > 250) blown += 1;
  }
  const brightness = sum / gray.length;

  // Variance of the Laplacian: the standard readable-vs-blurred proxy,
  // computed on the downsampled image and rescaled so the threshold in
  // verification-model.js means the same thing at any input size.
  let lapSum = 0;
  let lapSqSum = 0;
  let n = 0;
  for (let y = 1; y < h - 1; y += 1) {
    for (let x = 1; x < w - 1; x += 1) {
      const i = y * w + x;
      const lap = 4 * gray[i] - gray[i - 1] - gray[i + 1] - gray[i - w] - gray[i + w];
      lapSum += lap;
      lapSqSum += lap * lap;
      n += 1;
    }
  }
  const mean = n ? lapSum / n : 0;
  const sharpness = n ? lapSqSum / n - mean * mean : 0;

  return {
    // The ORIGINAL dimensions decide resolution, not the downsample.
    width,
    height,
    sharpness,
    brightness,
    blownHighlightRatio: blown / gray.length,
  };
}

/**
 * Validates one chosen file against the same limits storage.rules
 * enforces, so a rejection is explained here rather than surfacing as an
 * opaque upload failure -- plus the one thing those limits cannot
 * express: that the bytes are an image at all.
 *
 * The MIME type is only a label the file picker attached; nothing checks
 * it against the contents. Anything at all named .jpg passed the old
 * type-and-size test, uploaded cleanly, and reached a reviewer as a
 * broken thumbnail -- a wasted review and a person left waiting on a
 * submission that was never going to work. Decoding is the only way to
 * know, so it happens here, at the moment the person can still fix it.
 *
 * This rejects a NON-IMAGE, never an unflattering one. Resolution,
 * focus, lighting and glare stay advisory issues recorded at upload
 * (assessCaptureQuality) for a human to weigh: whether a document is
 * acceptable is a reviewer's judgement, never this page's.
 *
 * @returns {Promise<'missing'|'type'|'size'|'unreadable'|null>}
 */
export async function validateFile(file) {
  if (!file) return 'missing';
  if (!ACCEPTED_TYPES.includes(file.type)) return 'type';
  if (file.size > MAX_BYTES) return 'size';

  // No decoder here means this check cannot run -- it must not therefore
  // reject everything. The upload-time measurement and the reviewer are
  // still downstream; failing closed would lock such a browser out of
  // verification entirely over a check it simply cannot perform.
  if (typeof createImageBitmap !== 'function') return null;

  try {
    const bitmap = await createImageBitmap(file);
    if (bitmap.close) bitmap.close();
  } catch {
    return 'unreadable';
  }
  return null;
}

/**
 * Uploads one image to the signed-in user's own private evidence prefix
 * and returns the METADATA the backend will be told about it.
 *
 * `storagePath` is deliberately not returned: the backend rebuilds it
 * from the verified uid, and sending one would only invite trusting it.
 */
export async function uploadEvidence(storage, storageApi, uid, kind, file) {
  const { ref, uploadBytes } = storageApi;
  const objectId = makeObjectId(kind, extensionFor(file.type));
  const bytes = await file.arrayBuffer();
  const [contentHash, metrics] = await Promise.all([
    hashBytes(bytes),
    measureImage(file).catch(() => null),
  ]);
  const quality = metrics ? assessCaptureQuality(metrics) : { usable: true, issues: [] };

  await uploadBytes(ref(storage, `${EVIDENCE_PREFIX}/${uid}/${objectId}`), bytes, {
    contentType: file.type,
  });

  return { objectId, kind, contentHash, quality };
}

/**
 * Sends the case for review.
 *
 * Returns {ok:true} only when the backend actually accepted it. An
 * undeployed endpoint returns {ok:false, unavailable:true} so the caller
 * can say so plainly instead of rendering a success screen (§BI).
 */
export async function submitCase(user, evidence, idName) {
  try {
    await submitVerification(user, {
      track: 'identity',
      consentVersion: CONSENT_VERSION,
      idName: idName || null,
      evidence: evidence.map((e) => {
        const item = {
          kind: e.kind,
          objectId: e.objectId,
          quality: { issues: e.quality.issues },
        };
        // OMITTED, never sent empty. The backend validates contentHash as
        // a sha256 hex digest and rejects the WHOLE submission for '',
        // but accepts the field being absent. hashBytes() returns ''
        // whenever SubtleCrypto is missing (any insecure context), so
        // sending it would upload all three images and then fail the
        // submit with an error no retry could ever clear.
        if (e.contentHash) item.contentHash = e.contentHash;
        return item;
      }),
    });
    return { ok: true };
  } catch (err) {
    if (isEndpointUnavailable(err)) {
      return { ok: false, unavailable: true, error: err };
    }
    return { ok: false, unavailable: false, error: err };
  }
}

/** The reward line on the hero, sourced from the live config so it says
 *  3.5% because the config says 3.5% -- never because a number was typed
 *  into a template (§A). */
export function rewardBadgeText(configDoc) {
  // formatPercentLabel already carries the '%', so the template must NOT
  // add a second one -- that is what produced "3.5%%".
  const config = normalizeRewardConfig(configDoc);
  return tr('verify.rewardBadge', 'Earn {n} off once verified')
    .replace('{n}', formatPercentLabel(config.verificationReward));
}

export const CAPTURE_HINTS = Object.freeze({
  minWidth: MIN_CAPTURE_WIDTH,
  minHeight: MIN_CAPTURE_HEIGHT,
});
