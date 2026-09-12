// Storage Rules regression tests for professional-work/{profileId}/{file}
// (DESIGNER PUBLISHING phase). Run with `npm run test:storage-rules`.
//
// storage.rules' professional-work match block cross-checks a real
// Firestore serviceProviders document (ownerId + serviceType=='designer')
// via firestore.get() -- these tests seed that document directly (Admin-
// SDK equivalent) and then exercise the actual rules-enforced Storage
// client contexts, the same way tests/firestore/*.test.mjs exercises
// firestore.rules.
import { before, after, beforeEach, describe, it } from 'node:test';
import { assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { ref, uploadBytes, deleteObject } from 'firebase/storage';
import { makeTestEnv, seedFirestore, storageFor } from './helpers.mjs';

let testEnv;

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

// Every REAL signed-in user always has a users/{uid} doc (created at
// signup -- the whole accountType/role system depends on this, see
// docs/PHASE3_PROFILE_FIELD_CONTRACT.md), which is what lets
// storage.rules' pre-existing isAdmin() call firestore.get(...).data.role
// without an exists() guard -- that get() only throws for a uid with NO
// users/{uid} doc at all, which never happens in production. Seeding
// both documents here (not just serviceProviders) is what makes this
// test's evaluation environment match a real signed-in caller.
async function seedDesignerProfile(uid, overrides = {}) {
  await seedFirestore(testEnv, ['users', uid], { role: 'customer', accountType: 'professional_designer', createdAt: 1 });
  await seedFirestore(testEnv, ['serviceProviders', uid], {
    serviceType: 'designer', providerType: 'individual', ownerId: uid,
    displayName: 'Test Designer', verified: false, createdAt: 1, updatedAt: 1,
    ...overrides
  });
}

async function seedUser(uid, data) {
  await seedFirestore(testEnv, ['users', uid], data);
}

const SMALL_BYTES = new Uint8Array(1024); // 1KB -- well under the cap
const OVERSIZED_BYTES = new Uint8Array(10 * 1024 * 1024 + 1); // just over 10MB

function pathFor(profileId, name = 'photo.jpg') {
  return `professional-work/${profileId}/${name}`;
}

describe('professional-work upload -- ownership', () => {
  it('the owning Designer can upload a JPEG to their own path', async () => {
    await seedDesignerProfile('designer-a');
    const storage = storageFor(testEnv, 'designer-a');
    await assertSucceeds(uploadBytes(ref(storage, pathFor('designer-a')), SMALL_BYTES, { contentType: 'image/jpeg' }));
  });

  it('the owning Designer can upload a PNG', async () => {
    await seedDesignerProfile('designer-a');
    const storage = storageFor(testEnv, 'designer-a');
    await assertSucceeds(uploadBytes(ref(storage, pathFor('designer-a', 'p.png')), SMALL_BYTES, { contentType: 'image/png' }));
  });

  it('the owning Designer can upload a WebP', async () => {
    await seedDesignerProfile('designer-a');
    const storage = storageFor(testEnv, 'designer-a');
    await assertSucceeds(uploadBytes(ref(storage, pathFor('designer-a', 'p.webp')), SMALL_BYTES, { contentType: 'image/webp' }));
  });

  it('a DIFFERENT Designer cannot upload into another Designer\'s path', async () => {
    await seedDesignerProfile('designer-a');
    await seedDesignerProfile('designer-b');
    const storage = storageFor(testEnv, 'designer-b');
    await assertFails(uploadBytes(ref(storage, pathFor('designer-a')), SMALL_BYTES, { contentType: 'image/jpeg' }));
  });

  it('a plain customer (no serviceProviders profile) is denied', async () => {
    await seedUser('customer-1', { role: 'customer', createdAt: 1 });
    const storage = storageFor(testEnv, 'customer-1');
    await assertFails(uploadBytes(ref(storage, pathFor('customer-1')), SMALL_BYTES, { contentType: 'image/jpeg' }));
  });

  it('an Engineer service provider is denied (Designer-only path this phase)', async () => {
    await seedDesignerProfile('engineer-a', { serviceType: 'engineer' });
    const storage = storageFor(testEnv, 'engineer-a');
    await assertFails(uploadBytes(ref(storage, pathFor('engineer-a')), SMALL_BYTES, { contentType: 'image/jpeg' }));
  });

  it('an unauthenticated caller is denied', async () => {
    await seedDesignerProfile('designer-a');
    const storage = storageFor(testEnv, null);
    await assertFails(uploadBytes(ref(storage, pathFor('designer-a')), SMALL_BYTES, { contentType: 'image/jpeg' }));
  });
});

describe('professional-work upload -- MIME type / size', () => {
  it('rejects an SVG (stored-XSS vector -- excluded even though every other path in this codebase allows it)', async () => {
    await seedDesignerProfile('designer-a');
    const storage = storageFor(testEnv, 'designer-a');
    await assertFails(uploadBytes(ref(storage, pathFor('designer-a', 'x.svg')), SMALL_BYTES, { contentType: 'image/svg+xml' }));
  });

  it('rejects a non-image file (e.g. a PDF)', async () => {
    await seedDesignerProfile('designer-a');
    const storage = storageFor(testEnv, 'designer-a');
    await assertFails(uploadBytes(ref(storage, pathFor('designer-a', 'x.pdf')), SMALL_BYTES, { contentType: 'application/pdf' }));
  });

  it('rejects an oversized file (> 10MB) even with an allowed content type', async () => {
    await seedDesignerProfile('designer-a');
    const storage = storageFor(testEnv, 'designer-a');
    await assertFails(uploadBytes(ref(storage, pathFor('designer-a', 'huge.jpg')), OVERSIZED_BYTES, { contentType: 'image/jpeg' }));
  });
});

describe('professional-work delete -- the one path where deletion is allowed', () => {
  it('the owner can delete their own uploaded file', async () => {
    await seedDesignerProfile('designer-a');
    const ownerStorage = storageFor(testEnv, 'designer-a');
    const fileRef = ref(ownerStorage, pathFor('designer-a'));
    await assertSucceeds(uploadBytes(fileRef, SMALL_BYTES, { contentType: 'image/jpeg' }));
    await assertSucceeds(deleteObject(fileRef));
  });

  it('a different user cannot delete another Designer\'s file', async () => {
    await seedDesignerProfile('designer-a');
    await seedDesignerProfile('designer-b');
    const ownerStorage = storageFor(testEnv, 'designer-a');
    await assertSucceeds(uploadBytes(ref(ownerStorage, pathFor('designer-a')), SMALL_BYTES, { contentType: 'image/jpeg' }));

    const attackerStorage = storageFor(testEnv, 'designer-b');
    await assertFails(deleteObject(ref(attackerStorage, pathFor('designer-a'))));
  });

  it('an unauthenticated caller cannot delete', async () => {
    await seedDesignerProfile('designer-a');
    const ownerStorage = storageFor(testEnv, 'designer-a');
    await assertSucceeds(uploadBytes(ref(ownerStorage, pathFor('designer-a')), SMALL_BYTES, { contentType: 'image/jpeg' }));

    const publicStorage = storageFor(testEnv, null);
    await assertFails(deleteObject(ref(publicStorage, pathFor('designer-a'))));
  });
});
