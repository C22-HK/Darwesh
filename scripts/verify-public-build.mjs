#!/usr/bin/env node
// Darwesh Group -- public build verifier.
//
// Independent re-check of dist/ after scripts/build-public.mjs runs. The
// builder's allowlist is the control; this is the assertion that the
// control worked. Exits non-zero on any violation so CI refuses to
// publish rather than shipping a leak.
//
// Two directions are checked, and both matter:
//   PROHIBITED -- private material that must never be published.
//   REQUIRED   -- public files nothing links to, which a dependency
//                 crawl would silently drop (CNAME detaches the custom
//                 domain; js/i18n/{ku,ar,tr}.js are loaded by string
//                 concatenation in js/i18n.js, so no static analysis
//                 finds them, and losing them breaks those languages).

import fs from 'node:fs';
import path from 'node:path';

const OUT = path.join(process.cwd(), 'dist');

const PROHIBITED_DIRS = [
  'backend', 'docs', 'tests', 'scripts', 'qa-fixture',
  'creative-preview', 'design-preview', 'node_modules',
  '.git', '.github', '.claude', 'scratchpad-qa', '.firebase',
];

const PROHIBITED_FILES = new Set([
  'firestore.rules', 'storage.rules', 'firestore.indexes.json',
  'firebase.json', 'firebase.emulators.json', 'package.json',
  'package-lock.json', 'tailwind.config.js', '.gitignore',
]);

const PROHIBITED_PATTERNS = [
  { re: /\.md$/i,                 why: 'markdown (internal documentation / security report)' },
  { re: /\.py$/i,                 why: 'Python backend source' },
  { re: /(^|\/)\.env($|\.)/i,     why: 'environment file' },
  { re: /\.(pem|p12|pfx|key|keystore|jks)$/i, why: 'key material' },
  { re: /service[-_]?account.*\.json$/i,      why: 'service account credential' },
  { re: /\.map$/i,                why: 'source map' },
  { re: /\.(log|bak|orig|swp)$/i, why: 'log/backup artifact' },
  { re: /\.(sql|dump|sqlite3?|db)$/i, why: 'database export' },
  { re: /(^|\/)(test|spec)[-_.].*\.(js|mjs)$/i, why: 'test file' },
];

// Content scan -- catches a real credential pasted into an otherwise
// allowed file. Kept narrow to avoid firing on the public Firebase
// browser config, which is a project identifier, not a secret.
const CONTENT_RULES = [
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/,        why: 'private key block' },
  { re: /"type"\s*:\s*"service_account"/,            why: 'service account JSON' },
  { re: /\bsk-[A-Za-z0-9]{20,}/,                     why: 'API secret key' },
  { re: /\bghp_[A-Za-z0-9]{30,}/,                    why: 'GitHub token' },
  { re: /\bAIza[0-9A-Za-z_-]{35}\b(?![\s\S]{0,200}firebaseapp\.com)/, why: 'Google API key outside the known Firebase browser config' },
];

const REQUIRED = [
  'CNAME', 'index.html', 'robots.txt', 'sitemap.xml',
  'js/i18n.js', 'js/i18n/ku.js', 'js/i18n/ar.js', 'js/i18n/tr.js',
  'js/firebase-init.js',
];

// Mirror of APPROVED_PAGES in scripts/build-public.mjs. Duplicated on
// purpose: this file is the independent check on the builder, so it has
// to carry its own copy of the expectation rather than import the
// builder's and agree with itself by construction. A page reaching
// dist/ that is not listed here fails the deploy -- that is what stops
// an unreleased draft (scan.html today) from going live because a glob
// picked it up.
const APPROVED_PAGES = new Set([
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
]);

if (!fs.existsSync(OUT)) {
  console.error('FAIL: dist/ does not exist. Run scripts/build-public.mjs first.');
  process.exit(1);
}

function walk(dir, base = '') {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? path.posix.join(base, e.name) : e.name;
    if (e.isDirectory()) out.push(...walk(path.join(dir, e.name), rel));
    else out.push(rel);
  }
  return out;
}

const files = walk(OUT).filter((f) => f !== '.build-manifest.json');
const violations = [];

for (const rel of files) {
  const top = rel.split('/')[0];
  if (PROHIBITED_DIRS.includes(top)) {
    violations.push(`${rel} -- inside prohibited directory "${top}/"`);
    continue;
  }
  if (PROHIBITED_FILES.has(rel)) {
    violations.push(`${rel} -- prohibited configuration file`);
    continue;
  }
  for (const { re, why } of PROHIBITED_PATTERNS) {
    if (re.test(rel)) { violations.push(`${rel} -- ${why}`); break; }
  }
}

// Content scan over text files only.
for (const rel of files) {
  if (!/\.(html|js|mjs|css|json|txt|xml|vcf)$/i.test(rel)) continue;
  let text;
  try { text = fs.readFileSync(path.join(OUT, rel), 'utf8'); } catch { continue; }
  for (const { re, why } of CONTENT_RULES) {
    if (re.test(text)) violations.push(`${rel} -- contains ${why}`);
  }
}

// Any page in dist/ must be one someone approved for publication.
const unapprovedPages = files.filter(
  (f) => f.endsWith('.html') && !f.includes('/') && !APPROVED_PAGES.has(f)
);
const missingPages = [...APPROVED_PAGES].filter((p) => !fs.existsSync(path.join(OUT, p)));

const missing = REQUIRED.filter((r) => !fs.existsSync(path.join(OUT, r)));

let failed = false;

if (violations.length) {
  failed = true;
  console.error(`\nFAIL: ${violations.length} prohibited file(s) in dist/:`);
  for (const v of violations) console.error(`  - ${v}`);
}

if (unapprovedPages.length) {
  failed = true;
  console.error(`\nFAIL: ${unapprovedPages.length} page(s) in dist/ are not approved for publication:`);
  for (const p of unapprovedPages) console.error(`  - ${p}`);
  console.error('\n  Add the page to APPROVED_PAGES in scripts/build-public.mjs AND');
  console.error('  scripts/verify-public-build.mjs to publish it deliberately.');
}

if (missingPages.length) {
  failed = true;
  console.error(`\nFAIL: ${missingPages.length} approved page(s) missing from dist/:`);
  for (const p of missingPages) console.error(`  - ${p}`);
}

if (missing.length) {
  failed = true;
  console.error(`\nFAIL: ${missing.length} required public file(s) missing from dist/:`);
  for (const m of missing) console.error(`  - ${m}`);
  console.error('\n  These are not reachable by link-following. If the build started');
  console.error('  deriving its file list from a dependency crawl, that is the cause.');
}

if (failed) process.exit(1);

console.log(`public build verified: ${files.length} files, 0 violations, all ${REQUIRED.length} required files present.`);
