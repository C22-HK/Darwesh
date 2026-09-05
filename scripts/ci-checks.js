#!/usr/bin/env node
// Static checks for this static site -- no build step, no framework, so
// this replaces what a bundler/linter would normally catch. Codifies the
// same ad hoc checks used throughout development into something that runs
// on every push instead of only when someone remembers to run them by hand.
//
// Checks:
//   1. Every inline <script>/<script type="module"> block is valid JS
//   2. js/i18n.js has identical key sets between ku and ar
//   3. Every data-i18n(-placeholder|-title|-aria)="key" and tr()/trDash()/
//      trAdmin() literal call resolves to a real i18n key
//   4. Every internal href="*.html" points at a file that actually exists
//   5. No duplicate id="..." within a single page
//
// Exits non-zero (fails the build) if any check finds a real problem.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const htmlFiles = fs.readdirSync(ROOT).filter(f => f.endsWith('.html'));
let failures = 0;

function fail(msg) {
  console.error('FAIL: ' + msg);
  failures++;
}
function ok(msg) {
  console.log('OK: ' + msg);
}

// --- 1. Inline script syntax -------------------------------------------
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'darwesh-ci-'));
htmlFiles.forEach(f => {
  const html = fs.readFileSync(path.join(ROOT, f), 'utf8');
  const scripts = [...html.matchAll(/<script(?:\s+type="module")?>([\s\S]*?)<\/script>/g)];
  scripts.forEach((m, i) => {
    const isModule = /<script\s+type="module">/.test(html.slice(Math.max(0, m.index - 20), m.index + 20));
    const ext = isModule ? '.mjs' : '.js';
    const tmpFile = path.join(tmpDir, f.replace('.html', '') + '_' + i + ext);
    fs.writeFileSync(tmpFile, m[1]);
    try {
      execFileSync(process.execPath, ['--check', tmpFile], { stdio: 'pipe' });
    } catch (e) {
      fail(`${f}: inline script #${i} has a syntax error:\n${e.stderr ? e.stderr.toString() : e.message}`);
    }
  });
});
if (failures === 0) ok(`inline script syntax valid across ${htmlFiles.length} pages`);

// --- 2 & 3. i18n coverage -------------------------------------------
const i18nPath = path.join(ROOT, 'js/i18n.js');
const i18nSrc = fs.readFileSync(i18nPath, 'utf8');
const kuMatch = i18nSrc.match(/ku:\s*\{([\s\S]*?)\r?\n {2}\},\r?\n {2}ar:/);
const arMatch = i18nSrc.match(/ar:\s*\{([\s\S]*?)\r?\n {2}\}\s*\};/);
if (!kuMatch || !arMatch) {
  fail('js/i18n.js: could not locate ku/ar dictionary blocks (structure changed?)');
} else {
  const kuKeys = new Set([...kuMatch[1].matchAll(/'([a-zA-Z0-9_.]+)':/g)].map(m => m[1]));
  const arKeys = new Set([...arMatch[1].matchAll(/'([a-zA-Z0-9_.]+)':/g)].map(m => m[1]));
  const onlyKu = [...kuKeys].filter(k => !arKeys.has(k));
  const onlyAr = [...arKeys].filter(k => !kuKeys.has(k));
  if (onlyKu.length) fail(`js/i18n.js: keys present in ku but missing from ar: ${onlyKu.join(', ')}`);
  if (onlyAr.length) fail(`js/i18n.js: keys present in ar but missing from ku: ${onlyAr.join(', ')}`);
  if (!onlyKu.length && !onlyAr.length) ok(`i18n key parity (${kuKeys.size} keys each in ku/ar)`);

  const definedKeys = new Set([...i18nSrc.matchAll(/'([a-zA-Z0-9_.]+)':\s*'/g)].map(m => m[1]));
  // Keys built by string concatenation at runtime (e.g. 'auth.pro.svc.' + x)
  // can't be statically resolved -- allowlist known dynamic-key prefixes
  // rather than false-failing on them.
  const DYNAMIC_PREFIXES = ['auth.pro.svc.'];
  let missingAny = false;
  htmlFiles.forEach(f => {
    const html = fs.readFileSync(path.join(ROOT, f), 'utf8');
    const used = new Set();
    [...html.matchAll(/data-i18n(?:-placeholder|-title|-aria)?="([a-zA-Z0-9_.]+)"/g)].forEach(m => used.add(m[1]));
    [...html.matchAll(/\b(?:tr|trDash|trAdmin)\(['"]([a-zA-Z0-9_.]+)['"]/g)].forEach(m => used.add(m[1]));
    const missing = [...used].filter(k => !definedKeys.has(k) && !DYNAMIC_PREFIXES.some(p => k.startsWith(p)));
    if (missing.length) {
      fail(`${f}: i18n key(s) used but not defined in js/i18n.js: ${missing.join(', ')}`);
      missingAny = true;
    }
  });
  if (!missingAny) ok('every data-i18n / tr() key used across all pages resolves to a real i18n key');
}

// --- 4. Broken internal links -------------------------------------------
const existing = new Set(htmlFiles);
let brokenLinks = false;
htmlFiles.forEach(f => {
  const html = fs.readFileSync(path.join(ROOT, f), 'utf8');
  const hrefs = new Set([...html.matchAll(/href="([a-zA-Z0-9_-]+\.html)(?:[?#][^"]*)?"/g)].map(m => m[1]));
  hrefs.forEach(h => {
    if (!existing.has(h)) {
      fail(`${f}: links to "${h}" which does not exist in this repo`);
      brokenLinks = true;
    }
  });
});
if (!brokenLinks) ok('no broken internal page links');

// --- 5. Duplicate IDs -------------------------------------------
let dupeIds = false;
htmlFiles.forEach(f => {
  const html = fs.readFileSync(path.join(ROOT, f), 'utf8');
  const ids = [...html.matchAll(/\bid="([a-zA-Z0-9_-]+)"/g)].map(m => m[1]);
  const counts = {};
  ids.forEach(id => { counts[id] = (counts[id] || 0) + 1; });
  const dupes = Object.keys(counts).filter(id => counts[id] > 1);
  if (dupes.length) {
    fail(`${f}: duplicate id attribute(s): ${dupes.join(', ')}`);
    dupeIds = true;
  }
});
if (!dupeIds) ok('no duplicate element IDs within any page');

// --- 6. Map controls + approximate-location invariants ------------------
// These guard three things that were live production defects and would be
// silent regressions if reintroduced:
//
//   a) The right-side controls rendered as empty squares whenever the
//      Material Symbols webfont was unavailable. They are inline SVG now,
//      so a ligature <span> reappearing inside one is the regression.
//   b) Icon-only controls with no accessible name are unusable with a
//      screen reader and unexplained on hover.
//   c) A public map page must never read or plot a private coordinate.
//      This is the cheap textual half of that guarantee (firestore.rules
//      is the enforcing half) -- it catches an accidental
//      private/location read being added to a public page at review time.
let mapChecks = false;
const mapHtml = fs.readFileSync(path.join(ROOT, 'map.html'), 'utf8');
const controlIds = [
  'fullscreenBtn', 'resetViewBtn', 'drawSearchBtn',
  'myLocationBtn', 'searchThisAreaBtn', 'clearSearchAreaBtn',
  'redrawSearchAreaBtn'
];
controlIds.forEach(id => {
  // The element's own tag, from id="..." to the closing </button>.
  const m = mapHtml.match(new RegExp(`<button[^>]*\\bid="${id}"[\\s\\S]*?</button>`));
  if (!m) { fail(`map.html: expected map control #${id} to exist`); mapChecks = true; return; }
  const el = m[0];
  if (!/<svg\b/.test(el)) {
    fail(`map.html: control #${id} must use an inline <svg> icon (webfont ligatures render as empty squares when fonts.googleapis.com is blocked)`);
    mapChecks = true;
  }
  if (/material-symbols-outlined/.test(el)) {
    fail(`map.html: control #${id} still contains a material-symbols ligature span`);
    mapChecks = true;
  }
  // Every control needs an accessible name, from EITHER a visible text
  // label or an aria-label -- not necessarily both. Adding aria-label to
  // a button that already shows its name is redundant, and when the two
  // drift apart it is the invisible one a screen reader announces.
  const hasVisibleLabel = /<span[^>]*class="[^"]*tool-label/.test(el);
  if (!hasVisibleLabel && !/\baria-label="/.test(el)) {
    fail(`map.html: icon-only control #${id} has no aria-label and no visible label`);
    mapChecks = true;
  }
});
// The edge handle is the ONLY map control outside the drawer (plus
// Leaflet's own zoom buttons). If a floating control stack comes back,
// this catches it.
if (!/id="mapEdgeHandle"/.test(mapHtml)) {
  fail('map.html: expected the map-tools edge handle #mapEdgeHandle');
  mapChecks = true;
}
if (/class="map-overlay-controls"/.test(mapHtml)) {
  fail('map.html: the old floating .map-overlay-controls stack is back -- tools belong in the edge drawer');
  mapChecks = true;
}
controlIds.forEach(id => {
  const inDrawer = new RegExp(`<aside[^>]*id="mapDrawer"[\\s\\S]*?\\bid="${id}"[\\s\\S]*?</aside>`);
  if (!inDrawer.test(mapHtml)) {
    fail(`map.html: control #${id} must live inside the #mapDrawer edge drawer`);
    mapChecks = true;
  }
});

// Draw is a mode, not a one-shot action, so its pressed state must be
// both declared in markup and kept in sync from setDrawMode().
if (!/id="drawSearchBtn"[^>]*aria-pressed="false"/.test(mapHtml)) {
  fail('map.html: #drawSearchBtn must start with aria-pressed="false"');
  mapChecks = true;
}
if (!/drawSearchBtn\.setAttribute\('aria-pressed'/.test(mapHtml)) {
  fail('map.html: #drawSearchBtn aria-pressed is never updated in JS');
  mapChecks = true;
}
// ---- Area search is a CIRCLE, and its filter is geographic ------------
// The polygon tool it replaced is a real regression risk: it was itself a
// deliberate change once (circle -> polygon), so "restore the polygon"
// is a plausible future edit rather than an impossible one. These pin the
// three properties that actually matter.
//
// 1. No polygon machinery may come back. Each of these names belonged
//    only to the multi-vertex tool. `L.polygon(` deliberately is NOT on
//    this list: drawBoundaryShape() draws OSM administrative city
//    boundaries with it, which has nothing to do with area search, so
//    matching it would fail for the wrong reason.
['searchPolygonPoints', 'drawPreviewPoints', 'drawVertexMarkers', 'pointInPolygon']
  .forEach(token => {
    if (mapHtml.includes(token)) {
      fail(`map.html: polygon draw-area machinery is back (found "${token}") -- area search is a single centre+radius circle`);
      mapChecks = true;
    }
  });
// 2. The filter must compare geographic metres, not screen pixels, or the
//    selection silently changes meaning when the user zooms.
const spatialFn = mapHtml.match(/function spatialMatch\([\s\S]*?\n\}/);
if (!spatialFn) {
  fail('map.html: expected a spatialMatch() function for the area filter');
  mapChecks = true;
} else if (!/map\.distance\(/.test(spatialFn[0]) || !/searchCircle\.radius/.test(spatialFn[0])) {
  fail('map.html: spatialMatch() must filter by map.distance(centre, listing) <= searchCircle.radius -- a pixel/bounds approximation is not zoom-stable');
  mapChecks = true;
}
// 3. The circle is an overlay describing the filter, not a control; if it
//    were interactive it would swallow clicks meant for the markers
//    inside it -- the same defect the halo below avoids.
const circleFn = mapHtml.match(/function drawCircleLayer\([\s\S]*?\n\}/);
if (!circleFn) {
  fail('map.html: expected a drawCircleLayer() function -- the single place a search circle is created');
  mapChecks = true;
} else if (!/interactive:\s*false/.test(circleFn[0])) {
  fail('map.html: the search circle must be created with interactive: false, or it swallows clicks meant for the markers inside it');
  mapChecks = true;
}

// The halo communicates that the pin is approximate. It must not be
// clickable, or it would swallow clicks meant for the marker beneath it.
// Scoped to addApproxHalo's own body: `interactive: false` now appears on
// the search circle and the draw-centre dot too, so a whole-file match
// would pass even after the halo itself lost the option.
const haloFn = mapHtml.match(/function addApproxHalo\([\s\S]*?\n\}/);
if (!haloFn) {
  fail('map.html: expected an addApproxHalo() function for the approximate-location halo');
  mapChecks = true;
} else if (!/interactive:\s*false/.test(haloFn[0])) {
  fail('map.html: the approximate-location halo must be created with interactive: false, or it swallows clicks meant for the marker beneath it');
  mapChecks = true;
}
// LOC-01: no public page may read the private coordinate document.
['map.html', 'listing.html', 'index.html', 'buy.html'].forEach(f => {
  const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
  // Only a real path expression counts -- prose in a comment explaining
  // that the page deliberately does NOT read it is the intended state.
  if (/['"`]private\/location['"`]|,\s*['"]private['"]\s*,\s*['"]location['"]/.test(src)) {
    fail(`${f}: public page appears to reference listings/{id}/private/location`);
    mapChecks = true;
  }
});
if (!mapChecks) ok('map controls are inline-SVG + labelled, and no public page reads private/location');

fs.rmSync(tmpDir, { recursive: true, force: true });

console.log('');
if (failures > 0) {
  console.error(`${failures} check(s) failed.`);
  process.exit(1);
} else {
  console.log('All checks passed.');
}
