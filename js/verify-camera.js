// One in-page camera for the whole verification journey.
//
// WHY A CUSTOM CAMERA AND NOT JUST <input capture>
// -----------------------------------------------
// `capture="environment"` is a HINT. Every browser is free to ignore it,
// and several do: desktop browsers always show a file picker, and some
// Android browsers open a chooser with the gallery pre-selected. For an
// identity document that is a real failure -- people submit a screenshot
// or an old photo of someone else's card, a reviewer rejects it, and the
// person has to start over without understanding why.
//
// So the primary path is getUserMedia: a live preview with a frame to line
// the document up inside, a shutter, and an explicit confirm. The file
// input stays as a genuine fallback (it keeps its own `capture` hint), but
// it is no longer the first thing offered.
//
// WHAT THIS MODULE DOES NOT DO
// ----------------------------
// It does not decide anything. It returns a File and nothing else -- no
// scoring, no "looks good", no auto-accept. Whether a document is
// acceptable is a reviewer's judgement, never this page's (§AA).
//
//   const file = await openCamera({ facing: 'environment', guide: 'card' });
//   if (file) picked.id_front = file;   // straight into the existing flow
//
// Resolves with a File on confirm, or null if the person backed out or the
// camera could not be used. The caller handles null by showing the upload
// fallback -- no camera must never mean no verification.

import { createDocumentDetector, REASONS } from './verify-doc-detect.js';

// How long the card must stay continuously capture-ready before the
// camera takes the photo itself. Long enough that a hand passing through
// a good position does not trigger it, short enough that someone holding
// a card steady is not left waiting and wondering.
const AUTO_CAPTURE_MS = 2500;

// Detection cadence. Every frame is wasted work -- a person cannot move a
// card meaningfully in 16ms -- and on a mid-range phone it competes with
// the preview itself for the main thread.
const DETECT_INTERVAL_MS = 120;

const JPEG_QUALITY = 0.92;

// Capture at sensor resolution and a 48 MP phone hands back a frame that
// can encode to more than the 12 MB storage.rules allows, so the photo is
// rejected after the person has already taken it. Downscaling first also
// makes three uploads over mobile data finish in a fraction of the time.
//
// 2048px on the long edge is the trade: an ID card filling the guide still
// lands ~1300-1900px across, far more than a reviewer needs to read an ID
// number, while a typical frame encodes to well under a megabyte. Never
// upscale -- a small frame is left exactly as it is.
const MAX_EDGE = 2048;

// Budget, not the limit. storage.rules rejects at 12 MB and the client
// mirrors that; encoding to 8 MB leaves room for the multipart overhead
// and for the limit to be lowered later without this silently sitting on
// the boundary.
const MAX_BYTES = 8 * 1024 * 1024;

// Tried in order until one fits the budget. In practice the first entry
// always wins at 2048px; the rest exist so an unusual sensor or a very
// noisy scene degrades gracefully instead of failing the capture.
const ENCODE_STEPS = [
  { edge: MAX_EDGE, quality: JPEG_QUALITY },
  { edge: MAX_EDGE, quality: 0.82 },
  { edge: 1600, quality: 0.8 },
  { edge: 1280, quality: 0.75 },
];

/** Promise wrapper around the callback-style toBlob. */
function toBlob(canvas, quality) {
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
}

/**
 * Draws the frame scaled to fit `edge` on its longest side.
 *
 * `source` is the live <video>, or an ImageBitmap decoded from a file the
 * person picked. Anything else drawable works too, which is how the tests
 * feed it resolutions no fake capture device will produce.
 */
function drawScaled(source, edge) {
  const w = source.videoWidth || source.width;
  const h = source.videoHeight || source.height;
  // min(...,1) is what stops a 720p front camera being blown up to 2048
  // and encoded as a bigger file with no extra detail in it.
  const scale = Math.min(edge / Math.max(w, h), 1);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas;
}

/**
 * Encodes a frame as a JPEG that fits the budget, stepping down only as
 * far as it has to. Returns null if even the smallest step failed to
 * encode, so the caller can say so rather than hand an empty file to the
 * upload.
 */
export async function encodeFrame(source) {
  let last = null;
  for (const step of ENCODE_STEPS) {
    const blob = await toBlob(drawScaled(source, step.edge), step.quality);
    if (!blob) continue;
    last = blob;
    if (blob.size <= MAX_BYTES) return blob;
  }
  // Every step overshot (or all encodes failed). Returning the smallest
  // attempt is still better than nothing: validateFile then gives the
  // person the real "too large" message instead of a silent no-op.
  return last;
}

/**
 * Brings a picked file within the same limits as a capture.
 *
 * Photos chosen from the gallery come straight off the same sensor, so a
 * 48 MP original hits the 12 MB ceiling exactly as a capture would -- and
 * unlike a capture there is no "take it again smaller" available: the
 * photo already exists at that size. Downscaling is the only way through.
 *
 * A file already inside the limits is returned UNTOUCHED. Re-encoding an
 * acceptable photo would only cost it a generation of JPEG loss, and a
 * PNG or WebP that fits has no reason to become a JPEG. The same guard
 * applies to the result: if re-encoding somehow produced something
 * larger, the original is kept.
 *
 * Anything this can't decode (a corrupt file, or a HEIC on a browser that
 * won't take it) is passed through unchanged so validateFile gives its
 * own, accurate message rather than this inventing one.
 *
 * @param {File} file      what the person picked
 * @param {string} filename  name for the result IF it has to be re-encoded
 * @returns {Promise<File>}
 */
export async function prepareFile(file, filename = 'photo.jpg') {
  if (!file || !/^image\//.test(file.type)) return file;

  let bitmap = null;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return file;
  }

  try {
    if (Math.max(bitmap.width, bitmap.height) <= MAX_EDGE && file.size <= MAX_BYTES) return file;
    const blob = await encodeFrame(bitmap);
    if (!blob || blob.size >= file.size) return file;
    return new File([blob], filename, { type: 'image/jpeg' });
  } catch {
    return file;
  } finally {
    if (bitmap.close) bitmap.close();
  }
}

/** getUserMedia needs a secure context. On http:// (other than localhost)
 *  the API is simply absent, so the caller must be able to ask BEFORE
 *  offering a camera button it cannot honour. */
export function cameraSupported() {
  return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
}

/**
 * Turns a detector verdict into the ONE sentence to show.
 *
 * Exactly one, never a list: someone handed six corrections at once fixes
 * none of them. The detector already ranked them, so this is a plain
 * lookup with no logic of its own -- and every state has TEXT, because
 * the guide colour alone is not a message a colour-blind person, or a
 * screen reader, can read.
 */
function guidanceFor(reason, labels) {
  switch (reason) {
    case REASONS.CLIPPED: return labels.gCorners;
    case REASONS.TOO_FAR: return labels.gCloser;
    case REASONS.TOO_CLOSE: return labels.gFarther;
    case REASONS.NOT_STRAIGHT: return labels.gStraighter;
    case REASONS.TOO_DARK: return labels.gLight;
    case REASONS.BLURRY: return labels.gStill;
    case REASONS.MOVING: return labels.gStill;
    case REASONS.READY: return labels.holdSteady;
    default: return labels.gPlace;
  }
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/** Text comes from the caller so this module owns no copy and needs no
 *  i18n import; verify.html already has tr() bound to the page language. */
function buildModal(labels, guide) {
  const root = el('div', 'vjc');
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.setAttribute('aria-label', labels.title);

  const sheet = el('div', 'vjc-sheet');

  const head = el('div', 'vjc-head');
  const ident = el('div', 'vjc-ident');
  ident.append(el('span', 'vjc-brand', labels.brand));
  ident.append(el('h2', 'vjc-title', labels.title));
  head.append(ident);
  const close = el('button', 'vjc-close');
  close.type = 'button';
  close.setAttribute('aria-label', labels.close);
  // Inline SVG, not a Material Symbols ligature. When that webfont is
  // slow or blocked, ligature icons render as the literal word or an
  // empty box -- this codebase has already shipped that bug once on the
  // map controls. The one way out of a camera must never be a blank square.
  close.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false">'
    + '<path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
  head.append(close);

  const stage = el('div', `vjc-stage vjc-stage-${guide}`);
  const video = el('video', 'vjc-video');
  video.playsInline = true;          // iOS: without this the video goes fullscreen
  video.muted = true;
  video.setAttribute('playsinline', '');
  video.setAttribute('muted', '');
  const shot = el('img', 'vjc-shot');
  shot.alt = '';
  shot.hidden = true;
  // The frame is guidance drawn OVER the preview, never a crop: the whole
  // frame is captured, so a document slightly outside the guide is still
  // in the photo rather than silently cut in half.
  const frame = el('div', 'vjc-frame');
  frame.setAttribute('aria-hidden', 'true');
  // The auto-capture progress ring. An outline that fills over the
  // stability window, not a 3-2-1 countdown: the brief asks for a bank
  // scanner recognising a card, and a scanner does not count at you.
  const progress = el('div', 'vjc-progress');
  progress.setAttribute('aria-hidden', 'true');
  frame.append(progress);

  const hint = el('p', 'vjc-hint', labels.hint);
  // The guidance text is the assistive channel too: colour alone never
  // carries a state (WCAG 1.4.1), and a screen reader gets the same one
  // sentence a sighted person reads.
  hint.setAttribute('role', 'status');
  hint.setAttribute('aria-live', 'polite');

  stage.append(video, shot, frame);

  const status = el('p', 'vjc-status');
  status.setAttribute('role', 'status');
  status.hidden = true;

  const actions = el('div', 'vjc-actions');
  const shutter = el('button', 'vjc-shutter');
  shutter.type = 'button';
  shutter.setAttribute('aria-label', labels.capture);
  shutter.innerHTML = '<span class="vjc-shutter-ring" aria-hidden="true"></span>';

  const retake = el('button', 'vjc-btn', labels.retake);
  retake.type = 'button';
  retake.hidden = true;
  const confirm = el('button', 'vjc-btn vjc-btn-primary', labels.confirm);
  confirm.type = 'button';
  confirm.hidden = true;

  actions.append(retake, shutter, confirm);

  const fallback = el('button', 'vjc-fallback', labels.fallback);
  fallback.type = 'button';
  fallback.hidden = true;

  sheet.append(head, stage, hint, status, actions, fallback);
  root.append(sheet);
  return { root, sheet, stage, video, shot, frame, progress, hint, status, shutter, retake, confirm, close, fallback };
}

/**
 * Opens the camera modal.
 *
 * @param {object} options
 * @param {'environment'|'user'} options.facing  rear for documents, front for a face
 * @param {'card'|'face'} options.guide          shape of the framing outline
 * @param {object} options.labels                all user-facing strings, already translated
 * @param {string} options.filename              name for the produced File
 * @returns {Promise<File|null>}
 */
export function openCamera({ facing = 'environment', guide = 'card', labels, filename = 'capture.jpg', detect = false }) {
  return new Promise((resolve) => {
    const ui = buildModal(labels, guide);
    let stream = null;
    let blobUrl = null;
    let settled = false;

    // Mirror the PREVIEW for the front camera, because an unmirrored
    // selfie preview feels broken to use. The captured frame is never
    // mirrored: a reviewer comparing a face to an ID should see the face
    // the right way round, and text in shot must stay readable.
    if (facing === 'user') ui.video.classList.add('is-mirrored');

    // --- Smart document detection -------------------------------------
    // Entirely local. Frames are read into a canvas, reduced to a verdict,
    // and dropped; nothing here is uploaded, logged or measured remotely.
    // A ready verdict means CAPTURE-READY, never "this ID is genuine".
    const detector = detect ? createDocumentDetector() : null;
    let detectTimer = 0;
    let readySince = 0;

    // The guide rectangle in normalised coordinates, matching what
    // css/verify.css draws, so the detector judges the card against the
    // outline the person can actually see.
    function guideBox() {
      const stage = ui.stage.getBoundingClientRect();
      const box = ui.frame.getBoundingClientRect();
      if (!stage.width || !stage.height) return { x: 0.05, y: 0.2, w: 0.9, h: 0.6 };
      return {
        x: (box.left - stage.left) / stage.width,
        y: (box.top - stage.top) / stage.height,
        w: box.width / stage.width,
        h: box.height / stage.height,
      };
    }

    function setGuideState(state, message) {
      ui.stage.dataset.vjcState = state;
      if (message != null && ui.hint.textContent !== message) ui.hint.textContent = message;
    }

    function setProgress(fraction) {
      ui.progress.style.setProperty('--vjc-progress', String(Math.max(0, Math.min(1, fraction))));
      ui.progress.classList.toggle('is-active', fraction > 0);
    }

    function stopDetecting() {
      if (detectTimer) { clearInterval(detectTimer); detectTimer = 0; }
      readySince = 0;
      setProgress(0);
    }

    function startDetecting() {
      if (!detector || detectTimer) return;
      detectTimer = setInterval(() => {
        if (settled || capturing || !ui.video.videoWidth || ui.video.hidden) return;
        let verdict;
        try {
          verdict = detector.analyse(ui.video, guideBox());
        } catch {
          // Detection is an ASSIST. If it throws for any reason, stop it
          // and leave the person with a working manual shutter rather
          // than a camera that has died around a helper feature.
          stopDetecting();
          setGuideState('idle', labels.hint);
          return;
        }

        if (verdict.ready) {
          if (!readySince) readySince = Date.now();
          const held = Date.now() - readySince;
          setGuideState('ready', labels.holdSteady);
          setProgress(held / AUTO_CAPTURE_MS);
          if (held >= AUTO_CAPTURE_MS) {
            stopDetecting();
            capture();               // the bank scanner "recognised the card"
          }
          return;
        }

        // Any drop in quality resets the timer immediately: the 2.5s must
        // be 2.5s of CONTINUOUS readiness, not 2.5s of mostly-ready.
        readySince = 0;
        setProgress(0);
        setGuideState(verdict.found ? 'adjust' : 'idle', guidanceFor(verdict.reason, labels));
      }, DETECT_INTERVAL_MS);
    }

    function cleanup() {
      stopDetecting();
      if (stream) {
        stream.getTracks().forEach((t) => t.stop());
        stream = null;
      }
      if (blobUrl) { URL.revokeObjectURL(blobUrl); blobUrl = null; }
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('pagehide', onPageHide);
      ui.root.remove();
      document.body.classList.remove('vjc-open');
    }

    // Navigating away with the modal open must release the camera, or the
    // indicator light can stay on after the page is gone (bfcache keeps
    // the document alive). The camera owns this rather than the page,
    // so no caller can forget it.
    function onPageHide() { finish(null); }

    function finish(file) {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(file);
    }

    function onKey(e) { if (e.key === 'Escape') finish(null); }

    function fail(message) {
      ui.status.textContent = message;
      ui.status.hidden = false;
      ui.shutter.hidden = true;
      ui.hint.hidden = true;
      ui.fallback.hidden = false;
    }

    ui.close.addEventListener('click', () => finish(null));
    ui.fallback.addEventListener('click', () => finish(null));
    ui.root.addEventListener('click', (e) => { if (e.target === ui.root) finish(null); });
    document.addEventListener('keydown', onKey);
    window.addEventListener('pagehide', onPageHide);

    // Encoding is async and can take a moment on a large frame, so the
    // shutter is latched for the duration. Without it a double-tap starts
    // a second encode whose result lands after the first and quietly
    // replaces the photo the person is already looking at.
    let capturing = false;

    // ONE capture path for both the shutter and auto-capture. They must
    // not drift: an auto-captured photo is the same photo, reviewed the
    // same way, and nothing downstream can tell which button pressed it.
    async function capture() {
      if (capturing) return;
      const v = ui.video;
      if (!v.videoWidth || !v.videoHeight) return;  // stream not ready: ignore, don't capture black
      capturing = true;
      ui.shutter.disabled = true;
      stopDetecting();

      let blob = null;
      try {
        blob = await encodeFrame(v);
      } finally {
        capturing = false;
        ui.shutter.disabled = false;
      }

      // The sheet can be dismissed mid-encode (Escape, backdrop, pagehide).
      // Touching the DOM after that would resurrect a modal that is gone.
      if (settled) return;
      if (!blob) { fail(labels.errCapture); return; }

      if (blobUrl) URL.revokeObjectURL(blobUrl);
      blobUrl = URL.createObjectURL(blob);
      ui.shot.src = blobUrl;
      ui.shot.hidden = false;
      ui.video.hidden = true;
      // The guide exists to help aim. Over a still it is just clutter
      // between the person and the photo they are judging.
      ui.frame.hidden = true;
      ui.shutter.hidden = true;
      ui.retake.hidden = false;
      ui.confirm.hidden = false;
      ui.hint.textContent = labels.reviewHint;
      ui.confirm.dataset.blob = '1';
      ui.confirm.onclick = () => {
        finish(new File([blob], filename, { type: 'image/jpeg' }));
      };
    }

    // Manual capture always exists. Auto-capture is an assist for the
    // common case; an unusual card, an awkward light or a detector that
    // simply cannot see it must never leave someone unable to take a
    // photo they can plainly see is fine.
    ui.shutter.addEventListener('click', capture);

    ui.retake.addEventListener('click', () => {
      ui.shot.hidden = true;
      ui.video.hidden = false;
      ui.frame.hidden = false;
      ui.retake.hidden = true;
      ui.confirm.hidden = true;
      ui.shutter.hidden = false;
      ui.hint.textContent = labels.hint;
      if (blobUrl) { URL.revokeObjectURL(blobUrl); blobUrl = null; }
      if (detector) detector.reset();
      setGuideState('idle', labels.hint);
      startDetecting();
    });

    document.body.classList.add('vjc-open');
    document.body.appendChild(ui.root);
    ui.close.focus();

    if (!cameraSupported()) {
      fail(labels.errUnsupported);
      return;
    }

    // `ideal`, not `exact`: a device with only one camera should still open
    // it rather than throw OverconstrainedError and leave the person with
    // no camera at all. Preference, not requirement.
    navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: facing }, width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false,
    }).then((s) => {
      if (settled) { s.getTracks().forEach((t) => t.stop()); return; }
      stream = s;
      ui.video.srcObject = s;
      const play = ui.video.play();
      if (play && play.catch) play.catch(() => {});

      // A granted stream is not a working preview. iOS can reject play()
      // for its own reasons, and the symptom is a black rectangle with a
      // shutter that does nothing when pressed, because the capture guard
      // sees videoWidth 0. Rather than leave that silent, say so and offer
      // the upload route. Cleared as soon as a real frame arrives.
      const watchdog = setTimeout(() => {
        if (!settled && (!ui.video.videoWidth || !ui.video.videoHeight)) fail(labels.errNoPreview);
      }, 4000);
      const clear = () => { clearTimeout(watchdog); startDetecting(); };
      ui.video.addEventListener('loadeddata', clear, { once: true });
      ui.video.addEventListener('playing', clear, { once: true });
    }).catch((err) => {
      const name = err && err.name;
      if (name === 'NotAllowedError' || name === 'SecurityError') fail(labels.errDenied);
      else if (name === 'NotFoundError' || name === 'OverconstrainedError') fail(labels.errNoCamera);
      else fail(labels.errGeneric);
    });
  });
}
