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

// Every page approved for publication, named explicitly. This is NOT a
// *.html glob on purpose: a glob publishes any new page at the repo root
// the moment it is committed, with no review step. An unreleased draft
// (scan.html, the QR business-card page, is one today) would go live by
// accident. A page ships when someone adds it to this list, and not
// before.
//
// Matches the 42 root pages tracked at the time of writing, which is the
// same set scripts/ci-checks.js classifies as PUBLIC_PAGES /
// PRIVATE_PAGES / AUTH_PAGES / DETAIL_TEMPLATES. "Private" there means
// noindex + auth-gated, not unpublished -- those pages still have to be
// served for signed-in users to reach them.
const APPROVED_PAGES = [
  'about.html', 'account.html', 'add-work.html', 'admin.html',
  'agent-dashboard.html', 'agent.html', 'arena-challenge.html', 'arena.html',
  'build.html', 'buy.html', 'cleaning.html', 'customer.html',
  'design.html', 'designer.html', 'engineer.html', 'index.html',
  'insights.html', 'installments.html', 'landscaping.html', 'lawyer.html',
  'listing.html', 'login.html', 'maintenance.html', 'mam-ai.html',
  'map.html', 'offer.html', 'office.html', 'org-projects.html',
  'organization.html', 'project.html', 'projects.html', 'promo.html',
  'renovate.html', 'rent.html', 'reset-password.html', 'sell.html',
  'service.html', 'services.html', 'signup-professional.html', 'signup.html',
  'verify.html', 'work.html',
];

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
];

// Paths inside an allowed directory that are still build- or dev-only.
const EXCLUDE_PATHS = new Set([
  'css/tailwind-src.css',              // Tailwind input, not the built CSS
  'js/maps-config.local.example.js',   // local-setup example, not runtime

  // QR business-card page (scan.html), pending sign-off. Excluding the
  // page alone is not enough: css/ and js/ publish wholesale, so its
  // stylesheet and controller would be fetchable at a guessable path
  // while the page itself 404s -- publishing the design without the
  // page. Remove these three lines, and add scan.html to
  // APPROVED_PAGES, when the card is approved.
  'css/scan-card.css',
  'js/scan-card.js',
  'darwesh-group.vcf',
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

// 1. Approved pages only. A page named here but absent from disk is a
// real error -- the site would 404 -- so fail rather than publish a
// partial site.
const missingPages = APPROVED_PAGES.filter((p) => !fs.existsSync(path.join(ROOT, p)));
if (missingPages.length) {
  console.error(`ERROR: ${missingPages.length} approved page(s) missing from the repo:`);
  for (const m of missingPages) console.error(`  - ${m}`);
  console.error('Remove them from APPROVED_PAGES if they were deleted on purpose.');
  process.exit(1);
}
for (const name of APPROVED_PAGES) copyFile(name);

// Report any root page that exists but is not approved, so an
// unpublished draft is visible as a deliberate omission rather than
// silently forgotten. Not an error: drafts in progress are normal.
const unapproved = fs.readdirSync(ROOT)
  .filter((n) => n.endsWith('.html'))
  .filter((n) => fs.statSync(path.join(ROOT, n)).isFile())
  .filter((n) => !APPROVED_PAGES.includes(n));
if (unapproved.length) {
  console.log(`  not published (not in APPROVED_PAGES): ${unapproved.join(', ')}`);
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
