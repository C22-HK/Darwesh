#!/usr/bin/env node
// Fetches the rulesets CURRENTLY LIVE in a Firebase project.
//
// WHY THIS EXISTS
// ---------------
// `firebase deploy --only firestore:rules` REPLACES the entire live
// ruleset with the repository's file. It does not merge. So if anyone
// has edited rules in the Firebase Console, that edit is silently lost
// on the next deploy, and nothing in the deploy output says so.
//
// This script answers that question before the deploy instead of after:
// it pulls what is actually live, so the workflow can diff it against
// the repository file and keep a copy as a rollback artifact.
//
// Deliberately dependency-free. It mints a service-account access token
// with Node's own crypto (the standard RS256 JWT-bearer flow) rather
// than pulling in google-auth-library, because this runs in CI before
// anything else is installed and a deploy guard that itself needs an
// install step is a guard with one more way to fail.
//
// Usage:
//   node scripts/fetch-live-rules.mjs --project <id> --out <dir>
//
// Credentials come from GOOGLE_APPLICATION_CREDENTIALS (path to a
// service-account JSON) or FIREBASE_SERVICE_ACCOUNT (the JSON itself).
// Nothing is read from a user's login session: this is a CI tool.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const TOKEN_URI = 'https://oauth2.googleapis.com/token';
const RULES_API = 'https://firebaserules.googleapis.com/v1';
// Read-only on purpose. The same service account also needs write access
// to deploy, but this step has no business holding it.
const SCOPE = 'https://www.googleapis.com/auth/firebase.readonly';

// Which release name maps to which local file. A Storage release is
// named `firebase.storage/<bucket>`, so it is matched by prefix rather
// than equality -- the bucket is not knowable from the project id alone.
const RELEASES = [
  { key: 'firestore', match: (n) => n.endsWith('/releases/cloud.firestore'), file: 'firestore.rules' },
  { key: 'storage', match: (n) => n.includes('/releases/firebase.storage'), file: 'storage.rules' },
];

function fail(message) {
  console.error(`fetch-live-rules: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    if (!key || !key.startsWith('--')) fail(`unexpected argument: ${key}`);
    out[key.slice(2)] = argv[i + 1];
  }
  return out;
}

function loadServiceAccount() {
  const inline = process.env.FIREBASE_SERVICE_ACCOUNT;
  const file = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  let raw;
  if (inline && inline.trim()) raw = inline;
  else if (file && fs.existsSync(file)) raw = fs.readFileSync(file, 'utf8');
  else {
    fail(
      'no credentials. Set GOOGLE_APPLICATION_CREDENTIALS to a service-account '
      + 'JSON path, or FIREBASE_SERVICE_ACCOUNT to the JSON itself.',
    );
  }
  let sa;
  try {
    sa = JSON.parse(raw);
  } catch {
    fail('the service-account credential is not valid JSON');
  }
  // Named explicitly so a wrong-shaped secret (an API key, an OAuth
  // client, a truncated paste) says what is missing instead of failing
  // later inside the signing call.
  for (const field of ['client_email', 'private_key']) {
    if (!sa[field]) fail(`the service-account JSON has no "${field}" -- is this a service-account key?`);
  }
  return sa;
}

function base64url(input) {
  return Buffer.from(input).toString('base64url');
}

/** Standard RS256 JWT-bearer grant (RFC 7523), the same exchange every
 *  Google client library performs. */
async function accessToken(sa) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64url(JSON.stringify({
    iss: sa.client_email,
    scope: SCOPE,
    aud: sa.token_uri || TOKEN_URI,
    iat: now,
    exp: now + 3600,
  }));
  const signingInput = `${header}.${claims}`;
  const signature = crypto.createSign('RSA-SHA256').update(signingInput).sign(sa.private_key);
  const assertion = `${signingInput}.${signature.toString('base64url')}`;

  const res = await fetch(sa.token_uri || TOKEN_URI, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });
  const body = await res.text();
  if (!res.ok) fail(`token exchange failed (${res.status}): ${body.slice(0, 300)}`);
  const token = JSON.parse(body).access_token;
  if (!token) fail('token exchange returned no access_token');
  return token;
}

async function apiGet(url, token) {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const body = await res.text();
  if (!res.ok) {
    const hint = res.status === 403
      ? ' -- the service account needs the "Firebase Rules Viewer" role (roles/firebaserules.viewer) to read, and "Firebase Rules Admin" to deploy'
      : '';
    fail(`GET ${url} failed (${res.status})${hint}: ${body.slice(0, 300)}`);
  }
  return JSON.parse(body);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const project = args.project;
  const outDir = args.out || '.live-rules';
  if (!project) fail('--project <id> is required');

  const token = await accessToken(loadServiceAccount());
  const { releases = [] } = await apiGet(`${RULES_API}/projects/${encodeURIComponent(project)}/releases`, token);

  fs.mkdirSync(outDir, { recursive: true });
  const summary = [];

  for (const target of RELEASES) {
    // A project with several Storage buckets has one release per bucket,
    // each able to carry different rules. `firebase deploy` writes the
    // default bucket, so that is what is captured -- but say so rather
    // than quietly reporting one bucket's rules as "the" live ruleset.
    const matches = releases.filter((r) => target.match(r.name || ''));
    const release = matches[0];
    if (matches.length > 1) {
      console.warn(
        `${target.key}: ${matches.length} live releases (${matches.map((r) => r.name).join(', ')}); `
        + `captured the first. Deploying writes the default bucket only.`,
      );
    }
    if (!release) {
      // A project with no Storage release yet is normal, not an error --
      // report it so the workflow can say "nothing to overwrite".
      summary.push({ key: target.key, status: 'no-live-release' });
      continue;
    }
    const ruleset = await apiGet(`${RULES_API}/${release.rulesetName}`, token);
    const files = (ruleset.source && ruleset.source.files) || [];
    if (!files.length) {
      summary.push({ key: target.key, status: 'empty-ruleset', rulesetName: release.rulesetName });
      continue;
    }
    // A ruleset can technically hold several files; these projects use
    // one per service, and joining keeps the diff readable either way.
    const content = files.map((f) => f.content).join('\n');
    const dest = path.join(outDir, target.file);
    fs.writeFileSync(dest, content);
    summary.push({
      key: target.key,
      status: 'fetched',
      file: dest,
      rulesetName: release.rulesetName,
      // The live ruleset's own timestamp -- the single most useful fact
      // for "has someone edited this outside the repository?"
      updateTime: release.updateTime || release.createTime || null,
      bytes: content.length,
      liveReleaseCount: matches.length,
    });
  }

  fs.writeFileSync(path.join(outDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  for (const row of summary) {
    console.log(
      row.status === 'fetched'
        ? `${row.key}: fetched ${row.bytes} bytes, live since ${row.updateTime} -> ${row.file}`
        : `${row.key}: ${row.status}`,
    );
  }
}

main().catch((err) => fail(err && err.stack ? err.stack : String(err)));
