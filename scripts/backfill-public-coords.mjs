#!/usr/bin/env node
// LOC-01 backfill — migrate every existing listing off the publicly-readable
// precise coordinate.
//
// READ THIS FIRST: deploying the LOC-01 firestore.rules change alone does
// NOT close the exposure. The rules stop any NEW precise lat/lng from being
// written to a listing document, but every listing created before that
// still carries its real `lat`/`lng` on the same document any anonymous
// visitor can read. THIS SCRIPT is what actually removes them.
//
// For each listing it:
//   1. computes publicLat/publicLng (rounded to a ~1.1 km grid, via the same
//      js/listing-location.js helper the app's write paths use, so the
//      rounding can never drift between them),
//   2. writes the real pair to listings/{id}/private/location,
//   3. deletes `lat`/`lng` from the listing document.
//
// Idempotent: rounding is deterministic, and a listing already migrated
// (no lat/lng, has publicLat/publicLng, has a private/location doc) is
// skipped. Safe to re-run after a partial failure.
//
// Runs with the Admin SDK, which bypasses security rules — that is
// required here, since the rules deliberately forbid the very
// lat/lng-carrying documents this script is cleaning up.
//
// Usage — no downloaded key needed, just sign in with the gcloud CLI:
//   gcloud auth application-default login
//   gcloud auth application-default set-quota-project <projectId>
//   node scripts/backfill-public-coords.mjs --project <projectId> [--apply]
//
// Without --apply it runs as a DRY RUN: it only reads, prints the exact
// per-listing plan, and writes nothing.
import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { publicCoordsFrom } from '../js/listing-location.js';

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const projectIdx = args.indexOf('--project');
const PROJECT_ID = projectIdx !== -1 ? args[projectIdx + 1] : process.env.GCLOUD_PROJECT;

if (!PROJECT_ID) {
  console.error('Missing --project <projectId> (or GCLOUD_PROJECT).');
  process.exit(1);
}

// Credentials. Against the emulator (FIRESTORE_EMULATOR_HOST set) the
// Admin SDK needs none at all. Against production it uses Application
// Default Credentials, which resolve in this order:
//
//   1. GOOGLE_APPLICATION_CREDENTIALS -> a service-account key file, if
//      you happen to have one (NOT required),
//   2. the local gcloud user credential written by
//      `gcloud auth application-default login` — the normal path, no
//      downloaded key, no long-lived secret sitting on disk,
//   3. the metadata server, when running on GCP.
//
// (2) is the intended way to run this. A downloaded service-account key
// is a long-lived credential that is easy to leak and awkward to rotate;
// requiring one for a migration a human runs by hand would be a worse
// security posture than the exposure being fixed.
const USING_EMULATOR = !!process.env.FIRESTORE_EMULATOR_HOST;
let credential;
if (!USING_EMULATOR) {
  try {
    credential = applicationDefault();
  } catch (err) {
    console.error('Could not resolve Google Application Default Credentials.\n');
    console.error('Sign in with the gcloud CLI (no key file needed):');
    console.error('    gcloud auth application-default login');
    console.error(`    gcloud auth application-default set-quota-project ${PROJECT_ID}\n`);
    console.error('Or point GOOGLE_APPLICATION_CREDENTIALS at a service-account key,');
    console.error('or set FIRESTORE_EMULATOR_HOST to rehearse against a local emulator.\n');
    console.error(`(underlying error: ${err.message})`);
    process.exit(1);
  }
}
initializeApp({
  ...(credential ? { credential } : {}),
  projectId: PROJECT_ID,
});
const db = getFirestore();

// Firestore caps a batch at 500 writes; each listing costs 2 (the listing
// update + its private/location set), so 200 listings per batch is safely
// under that.
const LISTINGS_PER_BATCH = 200;

// How far the rounded public point sits from the real one -- reported in
// the dry run so the precision loss is a visible number, not an assumption.
function haversineMetres(lat1, lng1, lat2, lng2) {
  const R = 6371000, toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

async function main() {
  console.log(`LOC-01 backfill — project=${PROJECT_ID} mode=${APPLY ? 'APPLY' : 'DRY RUN'}`);

  const snap = await db.collection('listings').get();
  console.log(`Found ${snap.size} listing documents.`);

  let migrated = 0, skipped = 0, unfixable = 0;
  let batch = db.batch();
  let opsInBatch = 0;
  const plan = [];   // dry-run: the exact per-listing before -> after
  const noCoords = []; // ids with no usable coordinate at all

  for (const docSnap of snap.docs) {
    const d = docSnap.data();
    const hasPrecise = typeof d.lat === 'number' || typeof d.lng === 'number';
    const hasPublic = typeof d.publicLat === 'number' && typeof d.publicLng === 'number';

    if (!hasPrecise && hasPublic) { skipped++; continue; }          // already migrated
    if (!hasPrecise && !hasPublic) { unfixable++; noCoords.push(docSnap.id); continue; } // never had a location

    const pub = publicCoordsFrom(d.lat, d.lng);
    if (pub.publicLat === undefined) {
      // lat/lng present but not usable numbers — strip them anyway rather
      // than leaving a precise-looking value on a public document, but
      // report it so someone can re-pin the listing.
      console.warn(`  ! ${docSnap.id}: unusable lat/lng (${JSON.stringify(d.lat)}, ${JSON.stringify(d.lng)}) — would remove without a public pair`);
      unfixable++;
      noCoords.push(docSnap.id + ' (invalid)');
      if (APPLY) {
        batch.update(docSnap.ref, { lat: FieldValue.delete(), lng: FieldValue.delete() });
        opsInBatch++;
      }
      continue;
    }

    if (APPLY) {
      batch.set(docSnap.ref.collection('private').doc('location'), {
        lat: Number(d.lat),
        lng: Number(d.lng),
        updatedAt: FieldValue.serverTimestamp(),
      });
      batch.update(docSnap.ref, {
        publicLat: pub.publicLat,
        publicLng: pub.publicLng,
        lat: FieldValue.delete(),
        lng: FieldValue.delete(),
      });
      opsInBatch += 2;
    }
    migrated++;
    plan.push({
      id: docSnap.id,
      from: `${d.lat}, ${d.lng}`,
      publicPair: `${pub.publicLat}, ${pub.publicLng}`,
      shiftMetres: Math.round(haversineMetres(d.lat, d.lng, pub.publicLat, pub.publicLng)),
    });

    if (opsInBatch >= LISTINGS_PER_BATCH * 2) {
      await batch.commit();
      console.log(`  committed ${opsInBatch} writes`);
      batch = db.batch();
      opsInBatch = 0;
    }
  }

  if (APPLY && opsInBatch > 0) {
    await batch.commit();
    console.log(`  committed ${opsInBatch} writes`);
  }

  if (!APPLY && plan.length) {
    console.log('\nPLANNED MIGRATION (per listing)');
    console.log('  listing id                    precise lat/lng  ->  public pair        moved');
    console.log('  ' + '-'.repeat(84));
    for (const row of plan) {
      console.log(
        '  ' + row.id.padEnd(28) +
        row.from.padEnd(18) + ' ->  ' + row.publicPair.padEnd(18) +
        ' ~' + row.shiftMetres + ' m'
      );
    }
  }
  if (noCoords.length) {
    console.log('\nNO USABLE COORDINATE (left for manual re-pinning):');
    noCoords.forEach((id) => console.log('  - ' + id));
  }

  console.log('\n--- SUMMARY ---');
  console.log(`total listings scanned : ${snap.size}`);
  console.log(`will be changed        : ${migrated}`);
  console.log(`already migrated       : ${skipped}`);
  console.log(`missing/invalid coords : ${unfixable}`);
  console.log(`writes required        : ${migrated * 2}${migrated ? ' (1 listing update + 1 private/location set each)' : ''}`);
  if (!APPLY) console.log('\nDRY RUN — nothing was written to Firestore. Re-run with --apply to perform the migration.');
}

main().catch((err) => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
