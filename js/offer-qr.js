// Dynamic QR generation for Offers & Discounts.
//
// The brief is explicit: never upload a static QR image per percentage.
// A QR here is always computed from the offer's live destination URL, so
// changing that URL in Admin changes every QR on the next render with no
// asset to re-upload and no chance of a stale code pointing somewhere
// wrong.
//
// WHY A VENDORED ENCODER, NOT A CDN. The site's CSP allows scripts from
// unpkg, but pulling the encoder over the network would make the QR --
// the one element a printed/scanned offer depends on -- fail exactly
// when the network is unreliable. vendor/qrcode/ is the MIT-licensed
// qrcode-generator (Kazuhiko Arase), loaded from our own origin, and
// imported lazily so pages that never show an offer pay nothing for it.
//
// WHY SVG FOR DISPLAY. An SVG QR stays razor-sharp at any size and at
// any device pixel ratio, which is what actually matters for scanning;
// a raster at a guessed size does not. The PNG path below exists only
// for the Admin "download" affordance, where a file is the point.

let encoderPromise = null;

/** Loads the vendored encoder once, on first use. */
function loadEncoder() {
  if (!encoderPromise) {
    encoderPromise = import('../vendor/qrcode/qrcode.mjs').then((m) => m.default);
  }
  return encoderPromise;
}

/**
 * Builds the QR model for `text`.
 * typeNumber 0 lets the library pick the smallest version that fits.
 * Level 'M' (~15% recovery) is the usual choice for screen and print:
 * enough tolerance for a scuffed printout without inflating the module
 * count -- and a denser code is a harder code to scan.
 */
async function makeModel(text) {
  const qrcode = await loadEncoder();
  const qr = qrcode(0, 'M');
  qr.addData(String(text));
  qr.make();
  return qr;
}

/**
 * Inline SVG string for `text`.
 *
 * Drawn as ONE <path> of module squares rather than thousands of <rect>
 * elements: far fewer DOM nodes, and no hairline seams between adjacent
 * modules at fractional zoom levels (those seams are a real scanning
 * hazard, not just a cosmetic one).
 *
 * `quietZone` is in modules and defaults to the spec-mandated 4. Do not
 * lower it to reclaim space -- the quiet zone is part of what makes a QR
 * findable, and a code without one often will not scan at all.
 */
export async function qrToSvg(text, opts = {}) {
  const { size = 220, quietZone = 4, dark = '#0b2239', light = '#ffffff' } = opts;
  const qr = await makeModel(text);
  const count = qr.getModuleCount();
  const total = count + quietZone * 2;

  let d = '';
  for (let row = 0; row < count; row += 1) {
    for (let col = 0; col < count; col += 1) {
      if (qr.isDark(row, col)) {
        d += `M${col + quietZone} ${row + quietZone}h1v1h-1z`;
      }
    }
  }

  // viewBox in module units + a unit-square path keeps the geometry
  // integral, so the browser rasterizes crisp edges at any size.
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" `
    + `viewBox="0 0 ${total} ${total}" shape-rendering="crispEdges" role="img" `
    + `aria-label="${escapeAttr(opts.label || 'QR code')}">`
    + `<rect width="${total}" height="${total}" fill="${escapeAttr(light)}"/>`
    + `<path d="${d}" fill="${escapeAttr(dark)}"/>`
    + '</svg>';
}

/**
 * PNG data URL, for the Admin download button.
 * `scale` is pixels per module, so the output is always an exact integer
 * multiple of the module grid -- no resampling, no blurred edges.
 */
export async function qrToPngDataUrl(text, opts = {}) {
  const { scale = 8, quietZone = 4, dark = '#0b2239', light = '#ffffff' } = opts;
  const qr = await makeModel(text);
  const count = qr.getModuleCount();
  const total = (count + quietZone * 2) * scale;

  const canvas = document.createElement('canvas');
  canvas.width = total;
  canvas.height = total;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.fillStyle = light;
  ctx.fillRect(0, 0, total, total);
  ctx.fillStyle = dark;
  for (let row = 0; row < count; row += 1) {
    for (let col = 0; col < count; col += 1) {
      if (qr.isDark(row, col)) {
        ctx.fillRect((col + quietZone) * scale, (row + quietZone) * scale, scale, scale);
      }
    }
  }
  return canvas.toDataURL('image/png');
}

/**
 * Renders a QR for `text` into `el`.
 *
 * Guards against out-of-order renders: if the URL changes while an
 * encode is in flight (a fast typist in the Admin editor), only the
 * newest request is allowed to paint. Without this the box can settle
 * on a QR for a URL the admin already moved past -- which would be a
 * silently wrong code, the worst possible failure for this feature.
 */
export async function renderQrInto(el, text, opts = {}) {
  if (!el) return;
  const token = (el.__qrToken || 0) + 1;
  el.__qrToken = token;
  if (!text) { el.innerHTML = ''; return; }
  try {
    const svg = await qrToSvg(text, opts);
    if (el.__qrToken !== token) return;
    el.innerHTML = svg;
  } catch (_) {
    if (el.__qrToken !== token) return;
    // No fabricated fallback image: an unscannable placeholder that
    // looks like a QR is worse than an honest empty box.
    el.innerHTML = '';
  }
}

function escapeAttr(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
