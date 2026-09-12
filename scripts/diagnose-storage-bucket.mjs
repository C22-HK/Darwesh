#!/usr/bin/env node
// READ-ONLY diagnostic for one specific question:
//
//   `firebase deploy --only storage:rules` fails with
//   "Firebase Storage has not been set up on project 'darwesh-group'",
//   yet the Firebase Console shows a real, populated bucket at
//   gs://darwesh-group.firebasestorage.app.
//
// firebase-tools 15.28.2 (node_modules/firebase-tools/lib/gcp/storage.js,
// getDefaultBucket) emits that message from exactly one condition:
//
//   GET https://firebasestorage.googleapis.com/v1alpha/projects/{id}/defaultBucket
//   ...
//   catch (err) { if (err?.status === 404) throw new FirebaseError(
//     `Firebase Storage has not been set up on project '...'`) }
//
// So the message means "that endpoint answered 404", and nothing more.
// It does NOT mean the bucket is absent. This script separates the two
// claims by asking the management API and the Cloud Storage API
// independently and printing both answers side by side.
//
// SAFETY PROPERTIES, deliberate and load-bearing:
//   * Every request is a GET. There is no code path here that writes,
//     creates, links, deletes, renames or migrates anything.
//   * The access token is minted with READ-ONLY OAuth scopes
//     (firebase.readonly + devstorage.read_only), so even a bug in this
//     file could not mutate the project: the credential it holds is not
//     authorized to.
//   * The token and the service-account JSON are never printed, logged,
//     written to disk, or included in any output. Response bodies are
//     field-selected rather than dumped, so nothing unexpected is echoed.
//
// Usage:
//   node scripts/diagnose-storage-bucket.mjs --project <id> --bucket <bucket>
//
// Credentials come from FIREBASE_SERVICE_ACCOUNT (the JSON itself) or
// GOOGLE_APPLICATION_CREDENTIALS (a path to it), same as
// scripts/fetch-live-rules.mjs, whose token exchange this reuses.

import crypto from 'node:crypto';
import fs from 'node:fs';

const TOKEN_URI = 'https://oauth2.googleapis.com/token';
// Read-only scopes only. See the safety note above.
const SCOPE = [
  'https://www.googleapis.com/auth/firebase.readonly',
  'https://www.googleapis.com/auth/devstorage.read_only',
].join(' ');

function fail(message) {
  console.error(`diagnose-storage-bucket: ${message}`);
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
  else fail('no credentials (set FIREBASE_SERVICE_ACCOUNT or GOOGLE_APPLICATION_CREDENTIALS)');
  let sa;
  try {
    sa = JSON.parse(raw);
  } catch {
    fail('the service-account credential is not valid JSON');
  }
  for (const field of ['client_email', 'private_key']) {
    if (!sa[field]) fail(`the service-account JSON has no "${field}"`);
  }
  return sa;
}

function base64url(input) {
  return Buffer.from(input).toString('base64url');
}

/** Standard RS256 JWT-bearer grant (RFC 7523). Identical to
 *  fetch-live-rules.mjs, which this workflow already runs successfully. */
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
  const res = await fetch(sa.token_uri || TOKEN_URI, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${signingInput}.${signature.toString('base64url')}`,
    }),
  });
  const body = await res.text();
  // Note the slice: a failed exchange echoes Google's error, never the
  // assertion or the key.
  if (!res.ok) fail(`token exchange failed (${res.status}): ${body.slice(0, 200)}`);
  const token = JSON.parse(body).access_token;
  if (!token) fail('token exchange returned no access_token');
  return token;
}

/** GET and return {status, json, text} without throwing -- a 404 or 403
 *  IS the finding here, not an error to abort on. */
async function probe(url, token) {
  let res;
  try {
    res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  } catch (err) {
    return { status: 0, json: null, text: `network error: ${err?.message || err}` };
  }
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch { /* non-JSON body; `text` is kept */ }
  return { status: res.status, json, text };
}

/** Google's error envelope, reduced to the three fields that identify it. */
function errorSummary(result) {
  const e = result.json?.error;
  if (!e) return result.text ? `body: ${result.text.slice(0, 200)}` : '(empty body)';
  return `code=${e.code ?? '-'} status=${e.status ?? '-'} message="${String(e.message ?? '').slice(0, 200)}"`;
}

function line(label, value) {
  console.log(`  ${label.padEnd(22)} ${value}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const project = args.project;
  const bucket = args.bucket;
  if (!project || !bucket) fail('usage: --project <id> --bucket <bucket>');

  const token = await accessToken(loadServiceAccount());
  console.log(`project: ${project}`);
  console.log(`bucket under test: ${bucket}`);
  console.log('all requests below are GET; the token carries read-only scopes\n');

  // ---- 1. The exact call firebase-tools makes ----------------------
  const dbUrl = `https://firebasestorage.googleapis.com/v1alpha/projects/${encodeURIComponent(project)}/defaultBucket`;
  const db = await probe(dbUrl, token);
  console.log('[1] firebasestorage v1alpha defaultBucket  (the call firebase-tools makes)');
  line('GET', dbUrl);
  line('HTTP status', String(db.status));
  const dbBucketName = db.json?.bucket?.name ?? null;
  if (db.status === 200) {
    line('resource name', db.json?.name ?? '(absent)');
    line('bucket.name', dbBucketName ?? '(absent)');
    line('location', db.json?.location ?? db.json?.bucket?.location ?? '(absent)');
    line('storageClass', db.json?.storageClass ?? '(absent)');
  } else {
    line('error', errorSummary(db));
  }
  console.log('');

  // ---- 2. Which buckets does Firebase Storage management know? -----
  const listUrl = `https://firebasestorage.googleapis.com/v1beta/projects/${encodeURIComponent(project)}/buckets`;
  const list = await probe(listUrl, token);
  console.log('[2] firebasestorage v1beta buckets.list  (Firebase-linked buckets)');
  line('HTTP status', String(list.status));
  const linked = Array.isArray(list.json?.buckets)
    ? list.json.buckets.map((b) => String(b?.name ?? '')).filter(Boolean)
    : [];
  if (list.status === 200) {
    line('bucket count', String(linked.length));
    linked.forEach((n, i) => line(`bucket[${i}]`, n));
  } else {
    line('error', errorSummary(list));
  }
  console.log('');

  // ---- 3. The same API, addressed at this bucket directly ----------
  const getUrl = `https://firebasestorage.googleapis.com/v1beta/projects/${encodeURIComponent(project)}/buckets/${encodeURIComponent(bucket)}`;
  const linkedOne = await probe(getUrl, token);
  console.log('[3] firebasestorage v1beta buckets.get  (is THIS bucket Firebase-linked?)');
  line('HTTP status', String(linkedOne.status));
  if (linkedOne.status === 200) line('name', linkedOne.json?.name ?? '(absent)');
  else line('error', errorSummary(linkedOne));
  console.log('');

  // ---- 4. Does the physical bucket exist at all? -------------------
  // Cloud Storage JSON API, a different service from the Firebase
  // management API above. This is the claim "the bucket exists".
  const gcsUrl = `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}`
    + '?fields=name,location,locationType,projectNumber,storageClass,timeCreated';
  const gcs = await probe(gcsUrl, token);
  console.log('[4] Cloud Storage JSON API buckets.get  (does the physical bucket exist?)');
  line('HTTP status', String(gcs.status));
  if (gcs.status === 200) {
    line('exists', 'yes');
    line('name', gcs.json?.name ?? '(absent)');
    line('projectNumber', gcs.json?.projectNumber ?? '(absent)');
    line('location', gcs.json?.location ?? '(absent)');
    line('locationType', gcs.json?.locationType ?? '(absent)');
    line('storageClass', gcs.json?.storageClass ?? '(absent)');
    line('timeCreated', gcs.json?.timeCreated ?? '(absent)');
  } else {
    line('exists', gcs.status === 404 ? 'no (404 from Cloud Storage)' : 'not determinable from here');
    line('error', errorSummary(gcs));
  }
  console.log('');

  // ---- 5. What bucket does the Rules service think it releases to? -
  // Independent of both APIs above: a Storage rules release is named
  // `firebase.storage/<bucket>`. Run #5 fetched a live storage ruleset
  // successfully, so a release exists -- this prints which bucket it
  // names. Names and timestamps only; no ruleset source.
  const relUrl = `https://firebaserules.googleapis.com/v1/projects/${encodeURIComponent(project)}/releases`;
  const rel = await probe(relUrl, token);
  console.log('[5] firebaserules v1 releases.list  (which bucket has a live ruleset?)');
  line('HTTP status', String(rel.status));
  const releases = Array.isArray(rel.json?.releases) ? rel.json.releases : [];
  const storageReleases = releases.filter((r) => String(r?.name || '').includes('/releases/firebase.storage'));
  if (rel.status === 200) {
    line('releases total', String(releases.length));
    line('storage releases', String(storageReleases.length));
    storageReleases.forEach((r, i) => {
      line(`storage[${i}] name`, String(r?.name || '(absent)'));
      line(`storage[${i}] updated`, String(r?.updateTime || r?.createTime || '(absent)'));
    });
  } else {
    line('error', errorSummary(rel));
  }
  console.log('');

  // ---- Classification ---------------------------------------------
  // Stated as A-E, with the evidence each rests on, so a reader can
  // disagree with the label without losing the data.
  const releaseNamesBucket = storageReleases.some((r) => String(r?.name || '').includes(bucket));
  const physicalYes = gcs.status === 200;
  const physicalNo = gcs.status === 404;
  const firebaseKnowsBucket = linkedOne.status === 200 || linked.some((n) => n.includes(bucket));

  let verdict;
  if (db.status === 200 && dbBucketName) {
    verdict = `A -- defaultBucket = 200, bucket ${dbBucketName}. firebase-tools should not be failing; look elsewhere.`;
  } else if (db.status === 403) {
    verdict = 'C -- defaultBucket = 403. This is an IAM/permission result on the deployer identity, not a missing bucket.';
  } else if (db.status === 404 && physicalNo && !firebaseKnowsBucket && !releaseNamesBucket) {
    verdict = 'D -- the physical bucket is genuinely absent (Cloud Storage also says 404).';
  } else if (db.status === 404 && (physicalYes || firebaseKnowsBucket || releaseNamesBucket)) {
    verdict = 'B -- defaultBucket = 404 WHILE the bucket demonstrably exists. '
      + 'A Firebase default-bucket registration/metadata inconsistency, NOT a missing Cloud Storage bucket.';
  } else if (db.status === 404) {
    verdict = 'B (unconfirmed from here) -- defaultBucket = 404, and this credential could not independently '
      + 'confirm or refute the bucket. Console evidence stands on its own; nothing here contradicts it.';
  } else {
    verdict = `E -- defaultBucket returned HTTP ${db.status}. See the error above; none of A-D fits.`;
  }

  console.log('CLASSIFICATION');
  console.log(`  ${verdict}`);
  console.log('');
  console.log('EVIDENCE USED');
  line('defaultBucket status', String(db.status));
  line('physical bucket', physicalYes ? 'confirmed present' : physicalNo ? 'confirmed absent' : `not determinable (HTTP ${gcs.status})`);
  line('firebase-linked', firebaseKnowsBucket ? 'yes' : `not shown (HTTP ${linkedOne.status})`);
  line('rules release names it', releaseNamesBucket ? 'yes' : 'no');
  console.log('');
  console.log('NO MUTATION PERFORMED. Every request above was a GET, issued with a read-only token.');
}

main().catch((err) => fail(err?.message || String(err)));
