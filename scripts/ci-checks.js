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
//   6. Map controls are inline SVG + labelled, and no public page reads a
//      private location field
//   7. Every Leaflet bindTooltip/bindPopup renders escaped or literal text
//   8. No CSS declaration silently swallows the one after it
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

// --- 7. Leaflet tooltip/popup HTML sinks --------------------------------
//
// Leaflet renders a STRING passed to bindTooltip()/bindPopup() with
// `node.innerHTML = content` (DivOverlay._updateContent in leaflet-src.js).
// A tooltip is therefore an HTML sink, not a text node -- which is easy to
// miss, because every OTHER place these pages render Firestore text already
// goes through escapeHtml/escapeAdmin and *looks* like plain text here.
//
// This caught a real stored XSS: map.html bound a neighbourhood tooltip to
// `l.district || l.address` -- agent-writable listing fields that
// firestore.rules validates for type and length but never for content --
// so a listing address containing markup executed for every visitor to the
// public Properties Map.
//
// What this flags is the shape that actually bit: a DATA FIELD handed
// straight to the sink (`g.name`, `l.address`, `poi.name`), or a template
// literal that interpolates one without escaping it.
//
// What it deliberately does not flag: a call to a popup-builder function
// or a variable holding markup that builder produced. Those assemble whole
// cards and escape each field internally (reqMapListingPopup,
// reqMapSubmissionPopup, agent-dashboard's popupHtml, map.html's card()) --
// a static rule cannot follow them, so they stay a review responsibility,
// and the builders themselves are covered by the escaping conventions in
// js/escape-html.js.
const ESCAPED = /(escapeHtml|escapeAdmin|escapeFin|\besc\s*\()/;
const I18N_CALL = /\b(tr|trAdmin|trDash|trf)\s*\(/;
const NUMERIC = /\.(toFixed|toLocaleString|length)\b|^\$\{\s*[\d\s+\-*/().]+\s*\}$/;
// `something.field` / `a.b.c` on its own -- a raw data read.
const BARE_FIELD_READ = /^\s*[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+\s*$/;
let tooltipSinkIssues = false;
htmlFiles.forEach(f => {
  const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
  const re = /\.(bindTooltip|bindPopup)\(/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    // Prose in a `//` comment describing the sink is not a call site.
    const lineStart = src.lastIndexOf('\n', m.index) + 1;
    const before = src.slice(lineStart, m.index);
    if (/^\s*(\/\/|\*)/.test(before)) continue;

    // Argument text up to the first depth-0 comma (or closing paren) --
    // enough to classify without a full JS parse.
    const rest = src.slice(m.index + m[0].length);
    let depth = 0, arg = '';
    for (const ch of rest) {
      if (ch === '(' || ch === '[' || ch === '{') depth++;
      else if (ch === ')' || ch === ']' || ch === '}') { if (depth === 0) break; depth--; }
      else if (ch === ',' && depth === 0) break;
      arg += ch;
      if (arg.length > 400) break;
    }

    let bad = null;
    if (BARE_FIELD_READ.test(arg) && !ESCAPED.test(arg)) {
      bad = arg.trim();
    } else if (/^\s*`/.test(arg)) {
      const unsafe = (arg.match(/\$\{[^}]*\}/g) || []).filter(
        i => !ESCAPED.test(i) && !I18N_CALL.test(i) && !NUMERIC.test(i)
      );
      if (unsafe.length) bad = unsafe.join(' ');
    }
    if (!bad) continue;

    const line = src.slice(0, m.index).split('\n').length;
    fail(`${f}:${line}: ${m[1]}() renders its string content via innerHTML -- escape it (escapeHtml/escapeAdmin), got: ${bad.slice(0, 60)}`);
    tooltipSinkIssues = true;
  }
});
if (!tooltipSinkIssues) ok('every Leaflet bindTooltip/bindPopup renders escaped or literal content');

// --- 8. CSS structural sanity ------------------------------------------
// CSS has no error reporting. A malformed declaration is not a build
// failure and not a console warning -- the browser discards it and the page
// simply renders wrong. Nothing else in this file looks at CSS at all, so
// this class of bug ships green.
//
// It is not hypothetical here. A `background:` list in css/mam-companion.css
// ended in a comma instead of a semicolon; the `mix-blend-mode` on the next
// line was parsed as one more background layer, the whole declaration became
// invalid and was dropped, and MAM lost its entire highlight system. Console
// clean, CI green, and it took a screenshot to notice.
//
// This does NOT parse CSS. It looks for the single shape that fails
// silently and costs a whole declaration: inside an INNERMOST block -- one
// with no nested block, so it can only contain declarations -- a chunk
// between semicolons holding more than one top-level colon. A well-formed
// declaration has exactly one. Two means the semicolon that should have
// ended the first is missing or was typed as a comma, so the second
// property got swallowed into the first one's value.
//
// Colons and semicolons inside parentheses (url(data:...), gradients) or
// inside quotes (content: "a:b") are not top-level and do not count.
function scanCssText(src) {
  // Blank out comments but keep their newlines, so reported lines stay true.
  let text = '';
  for (let i = 0; i < src.length; ) {
    if (src.startsWith('/*', i)) {
      const end = src.indexOf('*/', i + 2);
      if (end === -1) {
        return { unterminated: src.slice(0, i).split('\n').length, issues: [] };
      }
      text += src.slice(i, end + 2).replace(/[^\n]/g, ' ');
      i = end + 2;
    } else {
      text += src[i++];
    }
  }

  const issues = [];
  const opens = (text.match(/\{/g) || []).length;
  const closes = (text.match(/\}/g) || []).length;
  if (opens !== closes) issues.push({ line: 0, kind: 'braces', detail: `${opens} "{" vs ${closes} "}"` });

  const lineOf = (idx) => text.slice(0, idx).split('\n').length;
  const block = /\{([^{}]*)\}/g;
  let m;
  while ((m = block.exec(text)) !== null) {
    const body = m[1];
    const base = m.index + 1;

    // Split the block into declarations on top-level semicolons.
    const chunks = [];
    let depth = 0, quote = '', start = 0;
    for (let k = 0; k <= body.length; k++) {
      const c = body[k];
      if (k === body.length) { chunks.push({ at: start, text: body.slice(start, k) }); break; }
      if (quote) { if (c === quote && body[k - 1] !== '\\') quote = ''; continue; }
      if (c === '"' || c === "'") quote = c;
      else if (c === '(') depth++;
      else if (c === ')') depth = Math.max(0, depth - 1);
      else if (c === ';' && depth === 0) { chunks.push({ at: start, text: body.slice(start, k) }); start = k + 1; }
    }

    for (const ch of chunks) {
      if (!ch.text.trim()) continue;
      let depth2 = 0, quote2 = '', colons = 0, secondAt = -1;
      for (let k = 0; k < ch.text.length; k++) {
        const c = ch.text[k];
        if (quote2) { if (c === quote2 && ch.text[k - 1] !== '\\') quote2 = ''; continue; }
        if (c === '"' || c === "'") quote2 = c;
        else if (c === '(') depth2++;
        else if (c === ')') depth2 = Math.max(0, depth2 - 1);
        else if (c === ':' && depth2 === 0) { colons++; if (colons === 2) secondAt = k; }
      }
      if (colons > 1) {
        issues.push({
          line: lineOf(base + ch.at + secondAt),
          kind: 'swallowed',
          detail: ch.text.trim().replace(/\s+/g, ' ').slice(0, 90)
        });
      }
    }
  }
  return { unterminated: 0, issues };
}

const cssSources = fs.readdirSync(path.join(ROOT, 'css'))
  .filter(f => f.endsWith('.css'))
  .map(f => ['css/' + f, fs.readFileSync(path.join(ROOT, 'css', f), 'utf8')]);
// Inline <style> blocks too -- same failure mode, same silence.
htmlFiles.forEach(f => {
  const html = fs.readFileSync(path.join(ROOT, f), 'utf8');
  [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].forEach((sm, i) => {
    cssSources.push([`${f} <style> #${i}`, sm[1]]);
  });
});

let cssIssues = false;
cssSources.forEach(([name, src]) => {
  const { unterminated, issues } = scanCssText(src);
  if (unterminated) {
    fail(`${name}:${unterminated}: unterminated /* comment -- everything after it is swallowed`);
    cssIssues = true;
  }
  issues.forEach(iss => {
    if (iss.kind === 'braces') fail(`${name}: unbalanced braces (${iss.detail})`);
    else fail(`${name}:${iss.line}: a declaration swallowed the next property -- ` +
              `the one before it is missing its ";" (often typed as ",") so the whole ` +
              `declaration is dropped silently. Got: ${iss.detail}`);
    cssIssues = true;
  });
});
if (!cssIssues) ok(`CSS declarations are structurally sound across ${cssSources.length} stylesheets and inline blocks`);

// --- 9. Account-type / permission vocabulary parity ----------------------
// backend/app/access/constants.py is the canonical source for accountType
// and permission keys; firestore.rules' isValidSelfAccountType(),
// js/permission-catalog.js (admin.html's Role permission defaults panel),
// js/professional-roles.js and signup-professional.html's TYPE_CATALOG
// must all agree with it. This is the drift that let the wizard offer
// `professional_maintenance` while the backend and rules rejected it
// (launch-readiness audit, fix B1) -- a signup type nobody could complete.
{
  const { pathToFileURL } = require('url');
  const pySrc = fs.readFileSync(path.join(ROOT, 'backend/app/access/constants.py'), 'utf8');
  const pySet = (name) => {
    const m = pySrc.match(new RegExp('^' + name + ':\\s*frozenset\\[str\\]\\s*=\\s*frozenset\\(\\s*\\{([\\s\\S]*?)\\}\\s*\\)', 'm'));
    return m ? new Set([...m[1].matchAll(/"([a-z_]+)"/g)].map(x => x[1])) : null;
  };
  const pyTypes = pySet('SELF_ACCOUNT_TYPES');
  const pyKnown = pySet('KNOWN_PERMISSIONS');
  const pyProtected = pySet('PROTECTED_PERMISSIONS');
  const rulesSrc = fs.readFileSync(path.join(ROOT, 'firestore.rules'), 'utf8');
  const rulesMatch = rulesSrc.match(/function isValidSelfAccountType\(v\)\s*\{\s*return v in \[([\s\S]*?)\]/);
  const rulesTypes = rulesMatch ? new Set([...rulesMatch[1].matchAll(/'([a-z_]+)'/g)].map(x => x[1])) : null;
  let catalog = null;
  try {
    const catalogUrl = pathToFileURL(path.join(ROOT, 'js/permission-catalog.js')).href;
    catalog = JSON.parse(execFileSync(process.execPath, [
      '--input-type=module', '-e',
      `import(${JSON.stringify(catalogUrl)}).then(m => console.log(JSON.stringify({ types: m.SELF_ACCOUNT_TYPES, known: m.KNOWN_PERMISSIONS, protectedKeys: m.PROTECTED_PERMISSIONS, recommended: m.RECOMMENDED_ROLE_DEFAULTS })))`
    ], { stdio: 'pipe' }).toString());
  } catch (e) {
    fail('js/permission-catalog.js could not be loaded: ' + (e.stderr ? e.stderr.toString() : e.message));
  }
  const rolesSrc = fs.readFileSync(path.join(ROOT, 'js/professional-roles.js'), 'utf8');
  const roleTypes = [...rolesSrc.matchAll(/accountType:\s*'([a-z_]+)'/g)].map(x => x[1]);
  const wizardSrc = fs.readFileSync(path.join(ROOT, 'signup-professional.html'), 'utf8');
  const wizardMatch = wizardSrc.match(/const TYPE_CATALOG = \{([\s\S]*?)\n {2}\};/);
  const wizardTypes = wizardMatch ? [...wizardMatch[1].matchAll(/^\s{4}([a-z_]+):\s*\{/gm)].map(x => x[1]) : [];

  const sameSet = (a, b) => a && b && a.size === b.size && [...a].every(x => b.has(x));
  const diff = (a, b) => `only in first: [${[...a].filter(x => !b.has(x)).join(', ')}] only in second: [${[...b].filter(x => !a.has(x)).join(', ')}]`;
  let parityFailures = 0;
  if (!pyTypes || !pyKnown || !pyProtected) { fail('could not parse SELF_ACCOUNT_TYPES / KNOWN_PERMISSIONS / PROTECTED_PERMISSIONS from backend/app/access/constants.py'); parityFailures++; }
  if (!rulesTypes) { fail('could not parse isValidSelfAccountType() from firestore.rules'); parityFailures++; }
  if (pyTypes && rulesTypes && !sameSet(pyTypes, rulesTypes)) { fail(`firestore.rules isValidSelfAccountType() drifted from constants.py SELF_ACCOUNT_TYPES -- ${diff(pyTypes, rulesTypes)}`); parityFailures++; }
  if (catalog && pyTypes && !sameSet(pyTypes, new Set(catalog.types))) { fail(`js/permission-catalog.js SELF_ACCOUNT_TYPES drifted from constants.py -- ${diff(pyTypes, new Set(catalog.types))}`); parityFailures++; }
  if (catalog && pyKnown && !sameSet(pyKnown, new Set(catalog.known))) { fail(`js/permission-catalog.js KNOWN_PERMISSIONS drifted from constants.py -- ${diff(pyKnown, new Set(catalog.known))}`); parityFailures++; }
  if (catalog && pyProtected && !sameSet(pyProtected, new Set(catalog.protectedKeys))) { fail(`js/permission-catalog.js PROTECTED_PERMISSIONS drifted from constants.py -- ${diff(pyProtected, new Set(catalog.protectedKeys))}`); parityFailures++; }
  if (catalog && pyKnown) {
    Object.entries(catalog.recommended).forEach(([type, keys]) => {
      if (!pyTypes.has(type)) { fail(`js/permission-catalog.js RECOMMENDED_ROLE_DEFAULTS names unknown accountType '${type}'`); parityFailures++; }
      keys.forEach(k => { if (!pyKnown.has(k)) { fail(`js/permission-catalog.js RECOMMENDED_ROLE_DEFAULTS[${type}] grants unknown/protected key '${k}'`); parityFailures++; } });
    });
    [...pyTypes].forEach(t => { if (!(t in catalog.recommended)) { fail(`js/permission-catalog.js RECOMMENDED_ROLE_DEFAULTS has no entry for '${t}'`); parityFailures++; } });
  }
  if (pyTypes) {
    roleTypes.forEach(t => { if (!pyTypes.has(t)) { fail(`js/professional-roles.js accountType '${t}' is not in constants.py SELF_ACCOUNT_TYPES (signup would be rejected)`); parityFailures++; } });
    if (!wizardMatch) { fail('could not parse TYPE_CATALOG from signup-professional.html'); parityFailures++; }
    wizardTypes.forEach(t => { if (!pyTypes.has(t)) { fail(`signup-professional.html TYPE_CATALOG offers '${t}', which constants.py SELF_ACCOUNT_TYPES rejects`); parityFailures++; } });
  }
  if (parityFailures === 0) ok(`accountType/permission vocabulary in parity: constants.py, firestore.rules, js/permission-catalog.js, js/professional-roles.js (${roleTypes.length} roles), signup-professional.html (${wizardTypes.length} wizard types)`);
}

fs.rmSync(tmpDir, { recursive: true, force: true });

console.log('');
if (failures > 0) {
  console.error(`${failures} check(s) failed.`);
  process.exit(1);
} else {
  console.log('All checks passed.');
}
