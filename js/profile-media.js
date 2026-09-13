// Darwesh Group -- profile photo/logo and cover image upload for service
// provider profiles. PHASE 3B.
//
// Uploads to the Phase 3A Storage path, unchanged:
//     professional-media/{providerId}/{photo|cover}/{fileName}
//
// WHAT THIS MODULE DOES NOT DO
// ----------------------------
// It does not decide who may upload. storage.rules does, by cross-checking
// the {providerId} path segment against that serviceProviders document's
// ownerId -- a check this client cannot influence, because the owner uid
// is never sent. Hiding the button for a non-owner is a UX courtesy; the
// server refusing the write is the actual boundary. Both are in place.
//
// It also does not widen the Phase 3A surface. Only 'photo' and 'cover'
// are reachable from here, because those are the only two {kind} values
// storage.rules accepts. 'work' stays closed until the Phase 3C limiter,
// so there is deliberately no code path here that could request it --
// PROFILE_MEDIA_KINDS is imported rather than re-typed so the two cannot
// drift apart.
//
// Everything expensive is reused, not reinvented: js/image-compress.js
// for the downscale (source type preserved, so a transparent PNG logo
// keeps its alpha) and its createUploadGate() so a second file pick while
// an upload is still running cannot orphan a Storage object.

import { storage } from './firebase-init.js';
import { ref as storageRef, uploadBytes, getDownloadURL } from 'https://www.gstatic.com/firebasejs/12.18.0/firebase-storage.js';
import { compressImage, PROFILE_IMAGE, LOGO_IMAGE, createUploadGate } from './image-compress.js';
import { PROFILE_MEDIA_KINDS } from './professional-roles.js';

/** Mirrors storage.rules' allowlist. A client check for fast feedback only. */
export const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
export const MAX_BYTES = 10 * 1024 * 1024;

const UPLOAD_TIMEOUT_MS = 30000;

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Upload timed out')), ms);
    promise.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
  });
}

/**
 * Why the filename is generated and never taken from the user's file:
 * storage.rules constrains {fileName} to ^[A-Za-z0-9._-]{1,120}$, and a
 * real filename routinely contains spaces, parentheses or non-Latin
 * characters that would fail that check. A random name always passes,
 * never collides, and leaks nothing about the uploader's filesystem.
 */
function generatedName(sourceType) {
  const ext = sourceType === 'image/png' ? 'png' : sourceType === 'image/webp' ? 'webp' : 'jpg';
  const rand = (crypto && crypto.randomUUID) ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  return `${rand}.${ext}`;
}

/** Client-side pre-check. Fast feedback; storage.rules re-validates the real bytes. */
export function validateImageFile(file) {
  if (!file) return { ok: false, reason: 'missing' };
  if (!ALLOWED_TYPES.includes(file.type)) return { ok: false, reason: 'type' };
  if (!(file.size > 0) || file.size >= MAX_BYTES) return { ok: false, reason: 'size' };
  return { ok: true };
}

/**
 * Uploads one profile-media image and resolves to its download URL.
 *
 * `kind` must be 'photo' or 'cover' -- anything else throws here rather
 * than being sent, so a future edit cannot quietly start writing into a
 * path storage.rules would reject.
 *
 * The caller owns the progress UI; onProgress is called with a coarse
 * phase so a button can say "Optimising…" before "Uploading…". uploadBytes
 * has no byte-level progress callback (uploadBytesResumable does), and a
 * fake percentage would be a lie, so the phases are real states rather
 * than an invented number.
 */
export async function uploadProfileMedia({ providerId, kind, file, onProgress }) {
  if (!PROFILE_MEDIA_KINDS.includes(kind)) {
    throw new Error(`profile-media: unsupported kind "${kind}" (Phase 3A allows only ${PROFILE_MEDIA_KINDS.join(', ')})`);
  }
  const check = validateImageFile(file);
  if (!check.ok) throw new Error(`profile-media: rejected file (${check.reason})`);

  if (onProgress) onProgress('optimizing');
  // A cover is displayed edge-to-edge and benefits from the larger
  // preset; an avatar never renders above ~112px. LOGO_IMAGE is the
  // higher-quality, alpha-preserving preset -- a provider's logo is
  // frequently a transparent PNG, and flattening it onto a solid
  // background would be a visible regression, not a compression win.
  const preset = kind === 'cover' ? LOGO_IMAGE : PROFILE_IMAGE;
  const upload = await compressImage(file, preset);

  if (onProgress) onProgress('uploading');
  const path = `professional-media/${providerId}/${kind}/${generatedName(upload.type || file.type)}`;
  const fileRef = storageRef(storage, path);
  await withTimeout(uploadBytes(fileRef, upload), UPLOAD_TIMEOUT_MS);
  const url = await withTimeout(getDownloadURL(fileRef), UPLOAD_TIMEOUT_MS);
  if (onProgress) onProgress('done');
  return url;
}

/**
 * Wires a hidden <input type="file"> to an upload, with the in-flight gate
 * and the input reset both handled here so no call site can forget either.
 *
 * onDone receives the real download URL only after Storage has confirmed
 * it -- never optimistically. A profile that claimed to have saved a photo
 * that did not upload would be worse than a slow one.
 */
export function wireMediaInput({ input, providerId, kind, onStart, onDone, onError }) {
  if (!input || input.dataset.mediaWired) return;
  input.dataset.mediaWired = '1';
  const gate = createUploadGate();
  input.addEventListener('change', async function () {
    const file = this.files && this.files[0];
    if (!file) return;
    if (!gate.begin()) return;   // a second pick mid-upload is ignored
    try {
      if (onStart) onStart();
      const url = await uploadProfileMedia({
        providerId, kind, file,
        onProgress: (phase) => { if (onStart) onStart(phase); }
      });
      if (onDone) await onDone(url);
    } catch (err) {
      console.error('[profile-media] upload failed', err);
      if (onError) onError(err);
    } finally {
      gate.end();
      // Cleared so re-picking the SAME file fires `change` again -- without
      // this, a retry after a failure would silently do nothing.
      this.value = '';
    }
  });
}
