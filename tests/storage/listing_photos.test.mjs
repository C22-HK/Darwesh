// Storage Rules regression test for listing-photos/{token}/{fileName} --
// site-wide bug hunt fix: this path used to accept a write from ANY
// signed-in user (request.auth != null only), on the stale assumption
// that every signed-in user on this project was already an agent or
// admin. Tightened to a real firestore.get() role cross-check
// (isAgentOrAdmin()), the same pattern already shipped and tested for
// company-logos/{companyId}. Run via `npm run test:storage-rules`.
//
// See tests/storage/helpers.mjs's own header comment for a known,
// pre-existing sandbox limitation: a network-restricted environment
// without outbound access to firebase-public.firebaseio.com makes every
// firestore.get() cross-check inside storage.rules -- including the
// already-shipped isAdmin()/company-logos checks -- throw generically,
// which can make an assertFails() case "pass" for the wrong reason. Not
// specific to this fix.
import { before, after, beforeEach, describe, it } from 'node:test';
import { assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { ref, uploadBytes } from 'firebase/storage';
import { makeTestEnv, seedFirestore, storageFor } from './helpers.mjs';

let testEnv;
const SMALL_JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);

before(async () => {
  testEnv = await makeTestEnv();
});

after(async () => {
  await testEnv.cleanup();
});

beforeEach(async () => {
  await testEnv.clearFirestore();
  await testEnv.clearStorage();
});

describe('listing-photos/{token}/{fileName} -- role-gated write', () => {
  it('an agent can upload a listing photo', async () => {
    await seedFirestore(testEnv, ['users', 'agent-1'], { role: 'agent', companyId: 'co-1' });
    const storage = storageFor(testEnv, 'agent-1');
    await assertSucceeds(uploadBytes(ref(storage, 'listing-photos/tok-1/photo.jpg'), SMALL_JPEG, { contentType: 'image/jpeg' }));
  });

  it('an admin can upload a listing photo', async () => {
    await seedFirestore(testEnv, ['users', 'admin-1'], { role: 'admin' });
    const storage = storageFor(testEnv, 'admin-1');
    await assertSucceeds(uploadBytes(ref(storage, 'listing-photos/tok-2/photo.jpg'), SMALL_JPEG, { contentType: 'image/jpeg' }));
  });

  it('a plain signed-in customer CANNOT upload a listing photo', async () => {
    await seedFirestore(testEnv, ['users', 'customer-1'], { role: 'customer', accountType: 'individual_customer' });
    const storage = storageFor(testEnv, 'customer-1');
    await assertFails(uploadBytes(ref(storage, 'listing-photos/tok-3/photo.jpg'), SMALL_JPEG, { contentType: 'image/jpeg' }));
  });

  it('an unauthenticated caller CANNOT upload a listing photo', async () => {
    const storage = storageFor(testEnv, null);
    await assertFails(uploadBytes(ref(storage, 'listing-photos/tok-4/photo.jpg'), SMALL_JPEG, { contentType: 'image/jpeg' }));
  });
});
