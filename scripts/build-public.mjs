#!/usr/bin/env node
// Darwesh Group -- public website build.
//
// Produces dist/ containing ONLY files a browser needs. This is an
// allowlist: nothing reaches dist/ unless a rule below names it. It is
// deliberately not "copy everything, then delete the secret bits" --
// that inverts the failure mode, so a newly added private file would
// silently ship until someone remembered to add a delete for it. Here a
// new private file is excluded by default and a new *public* file has to
// be opted in, which is the direction we want to fail in.
//
// Companion: scripts/verify-public-build.mjs re-checks the output and
// fails the build if anything prohibited slipped through. Run both.

import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const OUT = path.join(ROOT, 'dist');

// Whole directories that are public browser assets by nature.
const ALLOWED_DIRS = ['css', 'js', 'images', 'fonts', 'vendor'];

// Root files the platform or browser needs but nothing links to, so a
// dependency crawl would never discover them. CNAME in particular is
// what binds darweshgroup.com to GitHub Pages -- dropping it detaches
// the custom domain.
const ALLOWED_ROOT_FILES = [
  'CNAME',
  'robots.txt',
  'sitemap.xml',
  'manifest.json',
  'favicon.ico',
  'darwesh-group.vcf',
];

// Paths inside an allowed directory that are still build- or dev-only.
const EXCLUDE_PATHS = new Set([
  'css/tailwind-src.css',              // Tailwind input, not the built CSS
  'js/maps-config.local.example.js',   // local-setup example, not runtime
]);

// Excluded by pattern inside allowed dirs. Vendor LICENSE files are kept
// on purpose -- redistributing those libraries requires shipping them.
const EXCLUDE_PATTERNS = [
  /(^|\/)README\.md$/i,
  /(^|\/)\.DS_Store$/,
  /(^|\/)Thumbs\.db$/,
];

function isExcluded(rel) {
  if (EXCLUDE_PATHS.has(rel)) return true;
  return EXCLUDE_PATTERNS.some((re) => re.test(rel));
}

let copied = 0;
const manifest = [];

function copyFile(rel) {
  const from = path.join(ROOT, rel);
  const to = path.join(OUT, rel);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
  copied += 1;
  manifest.push(rel);
}

function copyDir(relDir) {
  const abs = path.join(ROOT, relDir);
  if (!fs.existsSync(abs)) return;
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    const rel = path.posix.join(relDir, entry.name);
    if (isExcluded(rel)) continue;
    if (entry.isDirectory()) copyDir(rel);
    else if (entry.isFile()) copyFile(rel);
  }
}

// Start clean so a removed source file cannot linger in a stale dist/.
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

// 1. Every page at the repo root.
for (const name of fs.readdirSync(ROOT)) {
  if (!name.endsWith('.html')) continue;
  if (!fs.statSync(path.join(ROOT, name)).isFile()) continue;
  copyFile(name);
}

// 2. Named root files.
for (const name of ALLOWED_ROOT_FILES) {
  if (fs.existsSync(path.join(ROOT, name))) copyFile(name);
  else console.warn(`  note: ${name} not present, skipping`);
}

// 3. Public asset directories.
for (const dir of ALLOWED_DIRS) copyDir(dir);

fs.writeFileSync(
  path.join(OUT, '.build-manifest.json'),
  JSON.stringify({ generatedAt: new Date().toISOString(), fileCount: copied, files: manifest.sort() }, null, 2)
);

console.log(`public build: ${copied} files -> dist/`);
const byDir = {};
for (const f of manifest) {
  const d = f.includes('/') ? f.split('/')[0] : 'ROOT';
  byDir[d] = (byDir[d] || 0) + 1;
}
for (const [d, n] of Object.entries(byDir).sort()) console.log(`  ${d}: ${n}`);
