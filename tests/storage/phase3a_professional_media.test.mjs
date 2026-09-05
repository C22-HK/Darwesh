// Storage Rules tests for professional-media/{providerId}/{kind}/{fileName}
// (PHASE 3A -- the shared profile-media path for every service-provider
// role). Run with `npm run test:storage-rules`.
//
// READ tests/storage/helpers.mjs FIRST. In a sandbox that cannot reach
// firebase-public.firebaseio.com, every firestore.get() inside
// storage.rules throws, so:
//
//   * assertSucceeds() cases here (the owner/admin ALLOW paths) fail for
//     an environment reason, not a rules reason. They are still written
//     out in full so they pass the moment the suite runs somewhere with
//     that host reachable -- and so a future regression in the allow path
//     is actually caught rather than silently untested.
//   * assertFails() cases that are decided BEFORE ownsProvider() --
//     unauthenticated, bad {kind}, bad filename, bad MIME, oversized --
//     are genuinely verified even in the restricted sandbox, because
//     storage.rules orders those cheap local checks ahead of the
//     cross-service get() and `&&` short-circuits. That ordering is a
//     deliberate property of the rule, not an accident.
//   * the cross-profile assertFails() cases DO pass in the sandbox, but
//     partly for the wrong reason (the get() throws rather than
//     returning a non-matching ownerId). They are not evidence on their
//     own; they become real evidence in a networked run.
import { before, after, beforeEach, describe, it } from 'node:test';
import { assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { ref, uploadBytes, deleteObject, getBytes } from 'firebase/storage';
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

// Same shape as professional_work.test.mjs: a real signed-in caller
// always has a users/{uid} doc, which is what lets storage.rules'
// pre-existing isAdmin() call firestore.get(...).data.role without an
// exists() guard. Seeding both documents keeps the evaluation
// environment faithful to production.
async function seedProvider(uid, overrides = {}) {
  await seedFirestore(testEnv, ['users', uid], { role: 'customer', createdAt: 1 });
  await seedFirestore(testEnv, ['serviceProviders', uid], {
    serviceType: 'designer', providerType: 'individual', ownerId: uid,
    displayName: 'Test Provider', verified: false, createdAt: 1, updatedAt: 1,
    ...overrides
  });
}

async function seedUser(uid, data) {
  await seedFirestore(testEnv, ['users', uid], data);
}

const SMALL_BYTES = new Uint8Array(1024);              // 1KB -- well under the cap
const OVERSIZED_BYTES = new Uint8Array(10 * 1024 * 1024 + 1); // just over 10MB

function mediaPath(providerId, kind = 'photo', name = 'a1b2c3.jpg') {
  return `professional-media/${providerId}/${kind}/${name}`;
}

describe('professional-media -- owner may write their own photo and cover', () => {
  it('the owner can upload an avatar (kind=photo)', async () => {
    await seedProvider('provider-a');
    const storage = storageFor(testEnv, 'provider-a');
    await assertSucceeds(uploadBytes(ref(storage, mediaPath('provider-a', 'photo')), SMALL_BYTES, { contentType: 'image/jpeg' }));
  });

  it('the owner can upload a cover image (kind=cover)', async () => {
    await seedProvider('provider-a');
    const storage = storageFor(testEnv, 'provider-a');
    await assertSucceeds(uploadBytes(ref(storage, mediaPath('provider-a', 'cover', 'c.png')), SMALL_BYTES, { contentType: 'image/png' }));
  });

  it('the owner can upload a WebP', async () => {
    await seedProvider('provider-a');
    const storage = storageFor(testEnv, 'provider-a');
    await assertSucceeds(uploadBytes(ref(storage, mediaPath('provider-a', 'photo', 'p.webp')), SMALL_BYTES, { contentType: 'image/webp' }));
  });

  // The whole point of the shared path: it is keyed on the profile, not
  // on serviceType. A lawyer has no visual portfolio (professional-work/
  // stays Designer-only) but absolutely has an avatar and a cover.
  it('a NON-designer role (lawyer) can upload profile media -- the path is role-agnostic', async () => {
    await seedProvider('lawyer-a', { serviceType: 'lawyer' });
    const storage = storageFor(testEnv, 'lawyer-a');
    await assertSucceeds(uploadBytes(ref(storage, mediaPath('lawyer-a', 'cover')), SMALL_BYTES, { contentType: 'image/jpeg' }));
  });

  it('a maintenance provider can upload profile media', async () => {
    await seedProvider('maint-a', { serviceType: 'maintenance' });
    const storage = storageFor(testEnv, 'maint-a');
    await assertSucceeds(uploadBytes(ref(storage, mediaPath('maint-a')), SMALL_BYTES, { contentType: 'image/jpeg' }));
  });

  it('profile media is publicly readable (it is rendered on a public profile page)', async () => {
    await seedProvider('provider-a');
    const ownerStorage = storageFor(testEnv, 'provider-a');
    await assertSucceeds(uploadBytes(ref(ownerStorage, mediaPath('provider-a')), SMALL_BYTES, { contentType: 'image/jpeg' }));
    await assertSucceeds(getBytes(ref(storageFor(testEnv, null), mediaPath('provider-a'))));
  });
});

describe('professional-media -- cross-profile writes are impossible', () => {
  it('a DIFFERENT provider cannot upload into another provider\'s path', async () => {
    await seedProvider('provider-a');
    await seedProvider('provider-b');
    const storage = storageFor(testEnv, 'provider-b');
    await assertFails(uploadBytes(ref(storage, mediaPath('provider-a')), SMALL_BYTES, { contentType: 'image/jpeg' }));
  });

  it('a plain customer with no serviceProviders profile is denied', async () => {
    await seedUser('customer-1', { role: 'customer', createdAt: 1 });
    const storage = storageFor(testEnv, 'customer-1');
    await assertFails(uploadBytes(ref(storage, mediaPath('customer-1')), SMALL_BYTES, { contentType: 'image/jpeg' }));
  });

  // The client never supplies the owner uid -- {providerId} is a path
  // segment cross-checked against the Firestore document. A caller
  // uploading under their OWN uid still fails if that document's
  // ownerId is someone else's, which is what makes a forged/renamed
  // profile useless.
  it('a caller is denied even under their own uid when the profile document names another owner', async () => {
    await seedProvider('provider-c', { ownerId: 'someone-else' });
    const storage = storageFor(testEnv, 'provider-c');
    await assertFails(uploadBytes(ref(storage, mediaPath('provider-c')), SMALL_BYTES, { contentType: 'image/jpeg' }));
  });

  it('an unauthenticated caller is denied (verified pre-get())', async () => {
    await seedProvider('provider-a');
    const storage = storageFor(testEnv, null);
    await assertFails(uploadBytes(ref(storage, mediaPath('provider-a')), SMALL_BYTES, { contentType: 'image/jpeg' }));
  });
});

// Every case in this block is decided by a cheap local check that runs
// BEFORE the cross-service firestore.get(), so these denials are real
// evidence even where the emulator cannot service that call.
describe('professional-media -- {kind}, filename, MIME and size (all decided pre-get())', () => {
  it('rejects kind=work -- portfolio publishing stays closed until the Phase 3C limiter', async () => {
    await seedProvider('provider-a');
    const storage = storageFor(testEnv, 'provider-a');
    await assertFails(uploadBytes(ref(storage, mediaPath('provider-a', 'work')), SMALL_BYTES, { contentType: 'image/jpeg' }));
  });

  it('rejects an arbitrary invented kind', async () => {
    await seedProvider('provider-a');
    const storage = storageFor(testEnv, 'provider-a');
    await assertFails(uploadBytes(ref(storage, mediaPath('provider-a', 'beforeafter')), SMALL_BYTES, { contentType: 'image/jpeg' }));
  });

  it('rejects an SVG -- public-read path, so an embedded <script> is stored XSS', async () => {
    await seedProvider('provider-a');
    const storage = storageFor(testEnv, 'provider-a');
    await assertFails(uploadBytes(ref(storage, mediaPath('provider-a', 'photo', 'x.svg')), SMALL_BYTES, { contentType: 'image/svg+xml' }));
  });

  it('rejects a non-image content type (PDF)', async () => {
    await seedProvider('provider-a');
    const storage = storageFor(testEnv, 'provider-a');
    await assertFails(uploadBytes(ref(storage, mediaPath('provider-a', 'photo', 'x.pdf')), SMALL_BYTES, { contentType: 'application/pdf' }));
  });

  it('rejects text/html (the other stored-XSS shape)', async () => {
    await seedProvider('provider-a');
    const storage = storageFor(testEnv, 'provider-a');
    await assertFails(uploadBytes(ref(storage, mediaPath('provider-a', 'photo', 'x.html')), SMALL_BYTES, { contentType: 'text/html' }));
  });

  it('rejects a file over 10MB even with an allowed content type', async () => {
    await seedProvider('provider-a');
    const storage = storageFor(testEnv, 'provider-a');
    await assertFails(uploadBytes(ref(storage, mediaPath('provider-a', 'photo', 'huge.jpg')), OVERSIZED_BYTES, { contentType: 'image/jpeg' }));
  });

  it('rejects a filename with characters outside the allowlist', async () => {
    await seedProvider('provider-a');
    const storage = storageFor(testEnv, 'provider-a');
    await assertFails(uploadBytes(ref(storage, mediaPath('provider-a', 'photo', 'a b$c.jpg')), SMALL_BYTES, { contentType: 'image/jpeg' }));
  });

  it('rejects an over-long filename (>120 chars)', async () => {
    await seedProvider('provider-a');
    const storage = storageFor(testEnv, 'provider-a');
    const longName = `${'a'.repeat(121)}.jpg`;
    await assertFails(uploadBytes(ref(storage, mediaPath('provider-a', 'photo', longName)), SMALL_BYTES, { contentType: 'image/jpeg' }));
  });
});

describe('professional-media -- delete', () => {
  it('the owner can delete their own profile media', async () => {
    await seedProvider('provider-a');
    const storage = storageFor(testEnv, 'provider-a');
    const fileRef = ref(storage, mediaPath('provider-a'));
    await assertSucceeds(uploadBytes(fileRef, SMALL_BYTES, { contentType: 'image/jpeg' }));
    await assertSucceeds(deleteObject(fileRef));
  });

  it('a different provider cannot delete another provider\'s profile media', async () => {
    await seedProvider('provider-a');
    await seedProvider('provider-b');
    const ownerStorage = storageFor(testEnv, 'provider-a');
    await assertSucceeds(uploadBytes(ref(ownerStorage, mediaPath('provider-a')), SMALL_BYTES, { contentType: 'image/jpeg' }));
    await assertFails(deleteObject(ref(storageFor(testEnv, 'provider-b'), mediaPath('provider-a'))));
  });

  it('an unauthenticated caller cannot delete (verified pre-get())', async () => {
    await seedProvider('provider-a');
    const ownerStorage = storageFor(testEnv, 'provider-a');
    await assertSucceeds(uploadBytes(ref(ownerStorage, mediaPath('provider-a')), SMALL_BYTES, { contentType: 'image/jpeg' }));
    await assertFails(deleteObject(ref(storageFor(testEnv, null), mediaPath('provider-a'))));
  });
});

// Regression guard: Phase 3A added a path, it did not change one. If a
// future edit to professional-media/ accidentally relaxes or shadows the
// Designer-only professional-work/ block, these fail.
describe('professional-media -- professional-work/ is unchanged', () => {
  it('a non-designer service provider still cannot upload to professional-work/', async () => {
    await seedProvider('lawyer-a', { serviceType: 'lawyer' });
    const storage = storageFor(testEnv, 'lawyer-a');
    await assertFails(uploadBytes(ref(storage, 'professional-work/lawyer-a/x.jpg'), SMALL_BYTES, { contentType: 'image/jpeg' }));
  });

  it('the owning Designer can still upload to professional-work/', async () => {
    await seedProvider('designer-a', { serviceType: 'designer' });
    const storage = storageFor(testEnv, 'designer-a');
    await assertSucceeds(uploadBytes(ref(storage, 'professional-work/designer-a/x.jpg'), SMALL_BYTES, { contentType: 'image/jpeg' }));
  });
});
