#!/usr/bin/env node
// Launch-readiness audit follow-up: every image the site pulls from
// lh3.googleusercontent.com/aida-public/... instead of hosting itself
// (images/...). External hosting on Google's CDN is not automatically a
// blocker -- but the `aida-public` path is the one Google's AI design/
// image-generation tooling writes to, not a general-purpose asset host,
// so these URLs carry a real risk independent of whether they currently
// respond: they were never meant as permanent production hosting and can
// be rotated or expired without notice. This script only reports what a
// HEAD request actually returns (or that the request couldn't be made at
// all, e.g. a sandboxed network denying the destination outright) -- it
// never assumes "unreachable from here" means "broken in production", and
// never assumes "external" alone means "must migrate".
//
// Usage: node scripts/check-external-assets.mjs
import { readFileSync, readdirSync } from 'node:fs';
import { join, extname } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const SCAN_EXTENSIONS = new Set(['.html', '.js']);
const SKIP_DIRS = new Set(['node_modules', '.git', 'backend', 'tests', 'scripts']);
const URL_PATTERN = /https:\/\/lh3\.googleusercontent\.com\/aida-public\/[^"'`) \s]*/g;

function listFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) out.push(...listFiles(full));
    } else if (SCAN_EXTENSIONS.has(extname(entry.name))) {
      out.push(full);
    }
  }
  return out;
}

function findOccurrences() {
  const occurrences = []; // { url, file, line }
  for (const file of listFiles(ROOT)) {
    const text = readFileSync(file, 'utf8');
    const lines = text.split('\n');
    lines.forEach((lineText, idx) => {
      for (const match of lineText.matchAll(URL_PATTERN)) {
        occurrences.push({ url: match[0], file: file.slice(ROOT.length), line: idx + 1 });
      }
    });
  }
  return occurrences;
}

async function headCheck(url, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: controller.signal });
    return { ok: res.ok, status: res.status, contentType: res.headers.get('content-type') || null };
  } catch (err) {
    // Network-level failure -- could be the image genuinely being gone,
    // or could be this environment's own outbound policy denying the
    // destination before the request ever reaches Google. Report the
    // raw error text and let the caller decide; never collapse this
    // into "unreachable" or "broken" without that distinction visible.
    return { ok: false, status: null, error: err.message || String(err) };
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const occurrences = findOccurrences();
  const byUrl = new Map();
  for (const occ of occurrences) {
    if (!byUrl.has(occ.url)) byUrl.set(occ.url, []);
    byUrl.get(occ.url).push(`${occ.file}:${occ.line}`);
  }

  console.log(`Found ${occurrences.length} occurrence(s) of ${byUrl.size} unique aida-public URL(s).\n`);

  let reachable = 0;
  let unreachable = 0;
  let blocked = 0;
  let i = 0;
  for (const [url, locations] of byUrl) {
    i += 1;
    const result = await headCheck(url);
    let label;
    if (result.error) {
      // A CONNECT/DNS/TLS failure before any HTTP response -- this
      // environment could not even attempt the request. Never reported
      // as "image is broken".
      label = `BLOCKED (network) -- ${result.error}`;
      blocked += 1;
    } else if (result.ok) {
      label = `OK ${result.status} (${result.contentType || 'unknown content-type'})`;
      reachable += 1;
    } else {
      label = `UNREACHABLE ${result.status}`;
      unreachable += 1;
    }
    console.log(`${i}. ${label}`);
    console.log(`   ${url}`);
    console.log(`   used at: ${locations.join(', ')}`);
    console.log('');
  }

  console.log('--- summary ---');
  console.log(`reachable: ${reachable}, unreachable: ${unreachable}, blocked-by-this-environment: ${blocked}, total unique: ${byUrl.size}`);
  if (blocked > 0) {
    console.log(
      '\nSome checks could not reach lh3.googleusercontent.com at all from this ' +
        'environment (a network/outbound-policy failure, not an HTTP response). ' +
        'That is not evidence the images are broken -- re-run this script from an ' +
        'environment that can reach that host to get a real reachability answer.'
    );
  }
}

main();
