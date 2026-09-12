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

const JPEG_QUALITY = 0.92;

/** getUserMedia needs a secure context. On http:// (other than localhost)
 *  the API is simply absent, so the caller must be able to ask BEFORE
 *  offering a camera button it cannot honour. */
export function cameraSupported() {
  return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
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
  head.append(el('h2', 'vjc-title', labels.title));
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
  const hint = el('p', 'vjc-hint', labels.hint);

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
  return { root, sheet, video, shot, frame, hint, status, shutter, retake, confirm, close, fallback };
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
export function openCamera({ facing = 'environment', guide = 'card', labels, filename = 'capture.jpg' }) {
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

    function cleanup() {
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

    ui.shutter.addEventListener('click', () => {
      const v = ui.video;
      const w = v.videoWidth;
      const h = v.videoHeight;
      if (!w || !h) return;               // stream not ready yet: ignore, don't capture black
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      canvas.getContext('2d').drawImage(v, 0, 0, w, h);
      canvas.toBlob((blob) => {
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
      }, 'image/jpeg', JPEG_QUALITY);
    });

    ui.retake.addEventListener('click', () => {
      ui.shot.hidden = true;
      ui.video.hidden = false;
      ui.frame.hidden = false;
      ui.retake.hidden = true;
      ui.confirm.hidden = true;
      ui.shutter.hidden = false;
      ui.hint.textContent = labels.hint;
      if (blobUrl) { URL.revokeObjectURL(blobUrl); blobUrl = null; }
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
    }).catch((err) => {
      const name = err && err.name;
      if (name === 'NotAllowedError' || name === 'SecurityError') fail(labels.errDenied);
      else if (name === 'NotFoundError' || name === 'OverconstrainedError') fail(labels.errNoCamera);
      else fail(labels.errGeneric);
    });
  });
}
