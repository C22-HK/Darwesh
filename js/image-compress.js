// Darwesh Group -- shared client-side image downscale/re-encode used
// before every Storage upload.
//
// WHY: a modern phone camera produces a 12-50MP JPEG of 3-8MB. Uploading
// that raw is the single largest source of upload latency on mobile, and
// none of it is useful -- the largest place any of these images is ever
// displayed is a full-width hero a few hundred CSS pixels tall. sell.html
// had solved this locally with its own compressImage(); this module is
// that logic, corrected and generalised, in one place so the other upload
// sites stop shipping raw camera files.
//
// ---------------------------------------------------------------------
// OUTPUT TYPE POLICY -- why this is not "always JPEG"
// ---------------------------------------------------------------------
// Re-encoding everything to JPEG would be smaller, and would also be a
// visible QUALITY REGRESSION for the two paths that carry company logos
// (office.html and signup-professional.html). JPEG has no alpha channel,
// so a transparent PNG logo re-encoded as JPEG gains a hard black or
// white box behind it wherever it is composited. That is a worse product
// than the slow upload it replaced.
//
// So the source type is preserved:
//     image/jpeg  -> image/jpeg   (lossy re-encode; the big win)
//     image/png   -> image/png    (lossless; alpha survives)
//     image/webp  -> image/webp   (alpha survives, compresses well)
//     anything else -> returned untouched
//
// Even for PNG, capping the dimensions is most of the saving, because a
// camera-resolution PNG is dominated by pixel count rather than by
// encoder settings.
//
// Returning the original untouched for any other type is deliberate: it
// guarantees this module can never turn an upload the Storage rules
// would have accepted into one they reject. Callers that restrict types
// (js/professional-content.js' isAllowedImageFile) still run their own
// check first, and storage.rules independently re-validates the bytes'
// real contentType regardless of anything decided here.
//
// ---------------------------------------------------------------------
// SECURITY: this module changes nothing about authorization.
// ---------------------------------------------------------------------
// It resizes bytes before they are handed to an upload call that is
// otherwise unchanged -- same path, same auth, same rules. It is not a
// validation layer and must never be treated as one: storage.rules is
// the only thing that decides whether an upload is allowed.

/** Listing/property photos -- shown large, so they keep the most detail. */
export const LISTING_IMAGE = { maxDimension: 1600, quality: 0.82, skipUnderBytes: 600 * 1024 };

/** Avatars and profile photos -- never displayed above a few hundred px. */
export const PROFILE_IMAGE = { maxDimension: 1024, quality: 0.85, skipUnderBytes: 250 * 1024 };

/**
 * Company logos. Higher quality factor and a lower skip threshold than a
 * photo: logos contain hard edges and flat colour, where JPEG artefacts
 * are far more visible than they are in a photograph, and a logo that is
 * already small should simply be left alone.
 */
export const LOGO_IMAGE = { maxDimension: 1024, quality: 0.92, skipUnderBytes: 200 * 1024 };

/** Portfolio/work images -- a designer's own work, shown large. */
export const PORTFOLIO_IMAGE = { maxDimension: 1600, quality: 0.85, skipUnderBytes: 600 * 1024 };

const RE_ENCODABLE = ['image/jpeg', 'image/png', 'image/webp'];

/**
 * Downscales and re-encodes an image File, returning a Blob to upload.
 *
 * Falls back to the ORIGINAL file on absolutely any problem -- an
 * undecodable file, a missing canvas API, a toBlob that returns null, or
 * a result that came out larger than the input. Compression is a speed
 * optimization; it is never a reason to lose or degrade a user's photo.
 *
 * @param {File|Blob} file
 * @param {{maxDimension:number, quality:number, skipUnderBytes:number}} preset
 * @returns {Promise<File|Blob>}
 */
export async function compressImage(file, preset = LISTING_IMAGE) {
  if (!file || typeof file.type !== 'string') return file;
  if (!RE_ENCODABLE.includes(file.type)) return file;
  if (typeof createImageBitmap !== 'function' || typeof document === 'undefined') return file;

  let bitmap = null;
  try {
    // imageOrientation:'from-image' applies the EXIF orientation tag while
    // decoding. Without it a portrait phone photo can come out of the
    // canvas rotated, because the tag lives in metadata that re-encoding
    // discards -- the image would upload sideways. Browsers have moved to
    // this as the default, but stating it explicitly is what makes the
    // behaviour actually guaranteed rather than version-dependent.
    try {
      bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch {
      // Older engines reject the options argument outright.
      bitmap = await createImageBitmap(file);
    }

    const longEdge = Math.max(bitmap.width, bitmap.height);
    const scale = Math.min(1, preset.maxDimension / longEdge);

    // Already small enough in both dimensions and bytes: re-encoding could
    // only lose quality for no gain.
    if (scale >= 1 && file.size < preset.skipUnderBytes) {
      bitmap.close();
      return file;
    }

    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) { bitmap.close(); return file; }
    // Best available resampling -- the default is a cheap filter that
    // makes a large downscale look noticeably soft.
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    bitmap = null;

    const blob = await new Promise((resolve) => {
      try {
        // PNG ignores the quality argument; passing it is harmless.
        canvas.toBlob(resolve, file.type, preset.quality);
      } catch {
        resolve(null);
      }
    });

    // Never upload something bigger than what the user picked. A small
    // or already-optimised PNG can genuinely re-encode larger.
    if (!blob || blob.size >= file.size) return file;
    return blob;
  } catch (err) {
    console.error('[image-compress] compression failed -- uploading the original', err);
    return file;
  } finally {
    try { if (bitmap) bitmap.close(); } catch { /* already closed */ }
  }
}

/**
 * Guards a file-input upload handler against overlapping runs.
 *
 * Every upload site in this codebase clears its input in a `finally`, so
 * re-picking the same file is already handled. What is NOT handled is
 * picking a file again while the previous upload is still in flight:
 * each attempt mints a fresh Storage path (a timestamp or a UUID), so two
 * overlapping runs upload twice and leave one object orphaned, and the
 * two Firestore writes race over which URL wins.
 *
 * Returns false when a run is already active, so the caller can return
 * early. Retry safety is unaffected: because each attempt builds its own
 * path, a FAILED upload retried later writes a new object rather than
 * half-overwriting the previous one.
 */
export function createUploadGate() {
  let busy = false;
  return {
    get busy() { return busy; },
    begin() {
      if (busy) return false;
      busy = true;
      return true;
    },
    end() { busy = false; }
  };
}
