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
const kuMatch = i18nSrc.match(/ku:\s*\{([\s\S]*?)\n {2}\},\n {2}ar:/);
const arMatch = i18nSrc.match(/ar:\s*\{([\s\S]*?)\n {2}\}\s*\};/);
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
  // Keys built by string concatenation at runtime (e.g. 'mamai.type_' + x)
  // can't be statically resolved -- allowlist known dynamic-key prefixes
  // rather than false-failing on them.
  const DYNAMIC_PREFIXES = ['mamai.type_'];
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

fs.rmSync(tmpDir, { recursive: true, force: true });

console.log('');
if (failures > 0) {
  console.error(`${failures} check(s) failed.`);
  process.exit(1);
} else {
  console.log('All checks passed.');
}
