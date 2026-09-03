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
//   1. computes publicLat/publicLng (rounded to ~111 m, via the same
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
// Usage:
//   GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json \
//   node scripts/backfill-public-coords.mjs --project <projectId> [--apply]
//
// Without --apply it runs as a DRY RUN and only reports what it would do.
import { initializeApp, cert, applicationDefault } from 'firebase-admin/app';
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

initializeApp({
  credential: process.env.GOOGLE_APPLICATION_CREDENTIALS ? applicationDefault() : applicationDefault(),
  projectId: PROJECT_ID,
});
const db = getFirestore();

// Firestore caps a batch at 500 writes; each listing costs 2 (the listing
// update + its private/location set), so 200 listings per batch is safely
// under that.
const LISTINGS_PER_BATCH = 200;

async function main() {
  console.log(`LOC-01 backfill — project=${PROJECT_ID} mode=${APPLY ? 'APPLY' : 'DRY RUN'}`);

  const snap = await db.collection('listings').get();
  console.log(`Found ${snap.size} listing documents.`);

  let migrated = 0, skipped = 0, unfixable = 0;
  let batch = db.batch();
  let opsInBatch = 0;

  for (const docSnap of snap.docs) {
    const d = docSnap.data();
    const hasPrecise = typeof d.lat === 'number' || typeof d.lng === 'number';
    const hasPublic = typeof d.publicLat === 'number' && typeof d.publicLng === 'number';

    if (!hasPrecise && hasPublic) { skipped++; continue; }          // already migrated
    if (!hasPrecise && !hasPublic) { unfixable++; continue; }        // never had a location at all

    const pub = publicCoordsFrom(d.lat, d.lng);
    if (pub.publicLat === undefined) {
      // lat/lng present but not usable numbers — strip them anyway rather
      // than leaving a precise-looking value on a public document, but
      // report it so someone can re-pin the listing.
      console.warn(`  ! ${docSnap.id}: unusable lat/lng (${JSON.stringify(d.lat)}, ${JSON.stringify(d.lng)}) — removing without a public pair`);
      unfixable++;
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

  console.log('---');
  console.log(`migrated : ${migrated}`);
  console.log(`skipped  : ${skipped} (already migrated)`);
  console.log(`no coords: ${unfixable}`);
  if (!APPLY) console.log('\nDRY RUN — nothing was written. Re-run with --apply to perform the migration.');
}

main().catch((err) => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
