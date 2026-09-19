#!/usr/bin/env node
// Darwesh Group -- production exposure check.
//
// scripts/verify-public-build.mjs proves the ARTIFACT is clean. It cannot
// prove the LIVE SITE serves that artifact. Those are different claims,
// and the gap between them is exactly how Deploy Pages run #259 reported
// success while darweshgroup.com still served backend/app/main.py: the
// build was correct and the deployment succeeded, but the origin serving
// the domain was not the artifact.
//
// This fetches the real site over HTTP and fails if private material
// comes back. Run it AFTER deploying.
//
// Uses GET, not HEAD: a HEAD can return 200 with no body, or be handled
// by a different path on the CDN, so it does not prove what a visitor
// actually receives. We read the body and look at it.

const HOSTS = ['https://www.darweshgroup.com', 'https://darweshgroup.com'];

// Each entry: the path, and a signature that identifies the real private
// content. Status alone is not enough -- a custom 404 page returns 200 on
// some hosts, so we check that the body actually looks like the file.
const MUST_NOT_BE_EXPOSED = [
  { path: '/backend/app/main.py',          signature: /^\s*(import|from|def|class|#)/m, what: 'Python backend source' },
  { path: '/backend/app/access/handlers.py', signature: /^\s*(import|from|def|class|#)/m, what: 'Python backend source' },
  { path: '/SECURITY_ARCHITECTURE.md',     signature: /#|security/i, what: 'internal security document' },
  { path: '/ATTACK_SURFACE.md',            signature: /#|attack|surface/i, what: 'internal security document' },
  { path: '/firestore.rules',              signature: /rules_version|service cloud\.firestore|allow read/i, what: 'Firestore rules' },
  { path: '/storage.rules',                signature: /rules_version|service firebase\.storage|allow read/i, what: 'Storage rules' },
  { path: '/.env',                         signature: /=/, what: 'environment file' },

  // Jekyll variants. If GitHub Pages is serving the repository root in
  // classic "Deploy from a branch" mode, Jekyll consumes *.md and
  // publishes it as *.html -- so the .md path 404s (which looks like the
  // file is protected) while the same content is served at .html. That
  // asymmetry is what made run #259's failure hard to read, so both
  // spellings are checked.
  { path: '/SECURITY_ARCHITECTURE.html',   signature: /attack|threat|firestore|authorization/i, what: 'internal security document (Jekyll-rendered)' },
  { path: '/ATTACK_SURFACE.html',          signature: /attack|threat|surface|endpoint/i, what: 'internal security document (Jekyll-rendered)' },
];

// If the site itself is down, every private path 404s and the check would
// "pass" for the wrong reason. Require a known-public page first.
const MUST_BE_SERVED = { path: '/index.html', signature: /<html|<!doctype/i };

async function fetchText(url) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 20000);
  try {
    const res = await fetch(url, {
      signal: ctl.signal,
      redirect: 'follow',
      headers: { 'User-Agent': 'darwesh-exposure-check', 'Cache-Control': 'no-cache' },
    });
    const body = await res.text();
    return { status: res.status, body, ok: true };
  } catch (err) {
    return { status: 0, body: '', ok: false, error: String(err && err.message || err) };
  } finally {
    clearTimeout(t);
  }
}

let failures = 0;
let checked = 0;
const unreachable = [];

for (const host of HOSTS) {
  console.log(`\n=== ${host} ===`);

  const live = await fetchText(host + MUST_BE_SERVED.path);
  if (!live.ok) {
    console.log(`  SKIP: ${MUST_BE_SERVED.path} unreachable (${live.error}) -- cannot assess this host`);
    unreachable.push(host);
    continue;
  }
  if (live.status !== 200 || !MUST_BE_SERVED.signature.test(live.body)) {
    console.error(`  FAIL: ${MUST_BE_SERVED.path} returned ${live.status} and does not look like a page.`);
    console.error('        The site may be down. Refusing to report "no exposure" from a dead origin.');
    failures += 1;
    continue;
  }
  console.log(`  ok   ${MUST_BE_SERVED.path} -> 200 (site is live)`);

  for (const { path, signature, what } of MUST_NOT_BE_EXPOSED) {
    const res = await fetchText(host + path);
    checked += 1;
    if (!res.ok) {
      console.log(`  ??   ${path} -> unreachable (${res.error})`);
      continue;
    }
    const looksReal = res.status === 200 && signature.test(res.body);
    if (looksReal) {
      failures += 1;
      const preview = res.body.slice(0, 120).replace(/\s+/g, ' ');
      console.error(`  LEAK ${path} -> ${res.status}, body looks like ${what}`);
      console.error(`         first bytes: ${preview}`);
    } else {
      console.log(`  ok   ${path} -> ${res.status}${res.status === 200 ? ' (200 but not the private content)' : ''}`);
    }
  }
}

console.log('');
if (unreachable.length === HOSTS.length) {
  console.error('FAIL: no host was reachable. This check proves nothing; treat as unverified.');
  process.exit(1);
}
if (failures) {
  console.error(`FAIL: ${failures} exposure finding(s) across ${checked} checks.`);
  console.error('');
  console.error('If the artifact is known clean, the live origin is probably not the');
  console.error('artifact. Check Settings -> Pages -> Build and deployment -> Source.');
  console.error('It must be "GitHub Actions". In "Deploy from a branch" mode the');
  console.error('repository root is served directly and Actions deployments are inert.');
  process.exit(1);
}
console.log(`PASS: ${checked} checks, no private content served.`);
