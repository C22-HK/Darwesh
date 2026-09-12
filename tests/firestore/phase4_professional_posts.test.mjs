// Firestore Rules regression tests for professionalPosts (DESIGNER
// PUBLISHING phase). Run with `npm run test:rules`.
//
// Context: makes "+ Add Work" on designer.html actually publish, backed
// by the professionalPosts collection proposed in
// docs/PROFESSIONAL_CONTENT_ARCHITECTURE.md and implemented in
// firestore.rules this phase, scoped to profileType=='designer' only.
// Ownership reuses the existing providerOwnerId() cross-reference against
// a real, already-validated serviceProviders document -- never a new
// trust signal, never a client-claimed role/permission flag.
import { before, after, beforeEach, describe, it } from 'node:test';
import { assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { doc, setDoc, updateDoc, deleteDoc, getDoc, getDocs, collection, query, where } from 'firebase/firestore';
import { makeTestEnv, seed, dbFor } from './helpers.mjs';

let testEnv;

before(async () => {
  testEnv = await makeTestEnv();
});

after(async () => {
  await testEnv.cleanup();
});

beforeEach(async () => {
  await testEnv.clearFirestore();
});

const COVER = 'https://firebasestorage.googleapis.com/v0/b/demo-darwesh.appspot.com/o/professional-work%2Fdesigner-a%2Fcover.jpg?alt=media';
const OTHER_URL = 'https://evil.example.com/cover.jpg';

async function seedServiceProvider(uid, overrides = {}) {
  await seed(testEnv, async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'serviceProviders', uid), {
      serviceType: 'designer', providerType: 'individual', ownerId: uid,
      displayName: 'Test Designer', verified: false, createdAt: 1, updatedAt: 1,
      ...overrides
    });
  });
}

async function seedUser(uid, data) {
  await seed(testEnv, async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'users', uid), data);
  });
}

async function seedPost(postId, data) {
  await seed(testEnv, async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'professionalPosts', postId), data);
  });
}

function validPost(overrides = {}) {
  return {
    ownerId: 'designer-a', profileId: 'designer-a', profileType: 'designer',
    status: 'published', title: 'A Living Room', category: 'residential',
    coverImageUrl: COVER, createdAt: 1, updatedAt: 1,
    ...overrides
  };
}

describe('professionalPosts create -- ownership / eligibility', () => {
  it('a Designer owner can create a valid post against their own profile', async () => {
    await seedServiceProvider('designer-a');
    const db = dbFor(testEnv, 'designer-a');
    await assertSucceeds(setDoc(doc(db, 'professionalPosts', 'p1'), validPost()));
  });

  it('a normal customer with no serviceProviders profile cannot publish', async () => {
    await seedUser('customer-1', { role: 'customer', accountType: 'individual_customer', createdAt: 1 });
    const db = dbFor(testEnv, 'customer-1');
    await assertFails(setDoc(doc(db, 'professionalPosts', 'p2'),
      validPost({ ownerId: 'customer-1', profileId: 'customer-1' })));
  });

  it('another Designer cannot publish AS a different Designer (profileId they do not own)', async () => {
    await seedServiceProvider('designer-a');
    await seedServiceProvider('designer-b');
    const db = dbFor(testEnv, 'designer-b');
    // designer-b tries to publish against designer-a's profile
    await assertFails(setDoc(doc(db, 'professionalPosts', 'p3'),
      validPost({ ownerId: 'designer-b', profileId: 'designer-a' })));
  });

  it('ownerId must match the caller even if profileId is correct', async () => {
    await seedServiceProvider('designer-a');
    const db = dbFor(testEnv, 'designer-a');
    await assertFails(setDoc(doc(db, 'professionalPosts', 'p4'),
      validPost({ ownerId: 'someone-else' })));
  });

  it('an Engineer (non-designer service provider) cannot publish -- Designer only this phase', async () => {
    await seedServiceProvider('engineer-a', { serviceType: 'engineer' });
    const db = dbFor(testEnv, 'engineer-a');
    await assertFails(setDoc(doc(db, 'professionalPosts', 'p5'),
      validPost({ ownerId: 'engineer-a', profileId: 'engineer-a', profileType: 'designer' })));
  });

  it('profileType must actually equal the real profile\'s serviceType, not just claim designer', async () => {
    // A provider record whose serviceType is 'engineer' but the post
    // claims profileType 'designer' anyway -- must fail even though the
    // post's own field says 'designer' (the cross-referenced real
    // serviceType is what's checked, not the request's own claim).
    await seedServiceProvider('engineer-b', { serviceType: 'engineer' });
    const db = dbFor(testEnv, 'engineer-b');
    await assertFails(setDoc(doc(db, 'professionalPosts', 'p6'),
      validPost({ ownerId: 'engineer-b', profileId: 'engineer-b', profileType: 'designer' })));
  });

  it('an unauthenticated (anonymous) caller cannot create a post', async () => {
    await seedServiceProvider('designer-a');
    const db = dbFor(testEnv, null);
    await assertFails(setDoc(doc(db, 'professionalPosts', 'p7'), validPost()));
  });
});

describe('professionalPosts create -- content validation', () => {
  it('rejects an invalid category', async () => {
    await seedServiceProvider('designer-a');
    const db = dbFor(testEnv, 'designer-a');
    await assertFails(setDoc(doc(db, 'professionalPosts', 'p8'), validPost({ category: 'not-a-real-category' })));
  });

  it('rejects a missing/non-Storage cover image URL', async () => {
    await seedServiceProvider('designer-a');
    const db = dbFor(testEnv, 'designer-a');
    await assertFails(setDoc(doc(db, 'professionalPosts', 'p9'), validPost({ coverImageUrl: OTHER_URL })));
  });

  it('rejects an oversized title', async () => {
    await seedServiceProvider('designer-a');
    const db = dbFor(testEnv, 'designer-a');
    await assertFails(setDoc(doc(db, 'professionalPosts', 'p10'), validPost({ title: 'x'.repeat(201) })));
  });

  it('rejects an empty title', async () => {
    await seedServiceProvider('designer-a');
    const db = dbFor(testEnv, 'designer-a');
    await assertFails(setDoc(doc(db, 'professionalPosts', 'p11'), validPost({ title: '' })));
  });

  it('rejects a media array over the 12-item bound', async () => {
    await seedServiceProvider('designer-a');
    const db = dbFor(testEnv, 'designer-a');
    const media = Array.from({ length: 13 }, (_, i) => ({ url: COVER, type: 'image', order: i }));
    await assertFails(setDoc(doc(db, 'professionalPosts', 'p12'), validPost({ media })));
  });

  it('accepts a media array at exactly the 12-item bound', async () => {
    await seedServiceProvider('designer-a');
    const db = dbFor(testEnv, 'designer-a');
    const media = Array.from({ length: 12 }, (_, i) => ({ url: COVER, type: 'image', order: i }));
    await assertSucceeds(setDoc(doc(db, 'professionalPosts', 'p13'), validPost({ media })));
  });

  it('rejects status "removed" at create time (admin-only value, never self-set)', async () => {
    await seedServiceProvider('designer-a');
    const db = dbFor(testEnv, 'designer-a');
    await assertFails(setDoc(doc(db, 'professionalPosts', 'p14'), validPost({ status: 'removed' })));
  });

  it('rejects an unknown field (e.g. a spoofed "verified" flag -- the schema has no such field at all)', async () => {
    await seedServiceProvider('designer-a');
    const db = dbFor(testEnv, 'designer-a');
    await assertFails(setDoc(doc(db, 'professionalPosts', 'p15'), { ...validPost(), verified: true }));
  });
});

describe('professionalPosts update -- ownership and immutability', () => {
  it('the owner can edit ordinary content fields', async () => {
    await seedServiceProvider('designer-a');
    await seedPost('p20', validPost());
    const db = dbFor(testEnv, 'designer-a');
    await assertSucceeds(updateDoc(doc(db, 'professionalPosts', 'p20'), { title: 'Updated Title', updatedAt: 2 }));
  });

  it('a DIFFERENT Designer cannot edit another owner\'s post', async () => {
    await seedServiceProvider('designer-a');
    await seedServiceProvider('designer-b');
    await seedPost('p21', validPost());
    const db = dbFor(testEnv, 'designer-b');
    await assertFails(updateDoc(doc(db, 'professionalPosts', 'p21'), { title: 'Hijacked' }));
  });

  it('a different Designer cannot delete another owner\'s post', async () => {
    await seedServiceProvider('designer-a');
    await seedServiceProvider('designer-b');
    await seedPost('p22', validPost());
    const db = dbFor(testEnv, 'designer-b');
    await assertFails(deleteDoc(doc(db, 'professionalPosts', 'p22')));
  });

  it('the owner can delete their own post', async () => {
    await seedServiceProvider('designer-a');
    await seedPost('p23', validPost());
    const db = dbFor(testEnv, 'designer-a');
    await assertSucceeds(deleteDoc(doc(db, 'professionalPosts', 'p23')));
  });

  it('the owner cannot change ownerId', async () => {
    await seedServiceProvider('designer-a');
    await seedPost('p24', validPost());
    const db = dbFor(testEnv, 'designer-a');
    await assertFails(updateDoc(doc(db, 'professionalPosts', 'p24'), { ownerId: 'someone-else' }));
  });

  it('the owner cannot change profileId', async () => {
    await seedServiceProvider('designer-a');
    await seedServiceProvider('designer-b');
    await seedPost('p25', validPost());
    const db = dbFor(testEnv, 'designer-a');
    await assertFails(updateDoc(doc(db, 'professionalPosts', 'p25'), { profileId: 'designer-b' }));
  });

  it('the owner cannot change profileType', async () => {
    await seedServiceProvider('designer-a');
    await seedPost('p26', validPost());
    const db = dbFor(testEnv, 'designer-a');
    await assertFails(updateDoc(doc(db, 'professionalPosts', 'p26'), { profileType: 'engineer' }));
  });

  it('the owner cannot change createdAt', async () => {
    await seedServiceProvider('designer-a');
    await seedPost('p27', validPost());
    const db = dbFor(testEnv, 'designer-a');
    await assertFails(updateDoc(doc(db, 'professionalPosts', 'p27'), { createdAt: 999 }));
  });

  it('the owner cannot set status to "removed" (admin-only moderation state)', async () => {
    await seedServiceProvider('designer-a');
    await seedPost('p28', validPost());
    const db = dbFor(testEnv, 'designer-a');
    await assertFails(updateDoc(doc(db, 'professionalPosts', 'p28'), { status: 'removed' }));
  });

  it('the owner cannot introduce a spoofed "verified" field via update either', async () => {
    await seedServiceProvider('designer-a');
    await seedPost('p29', validPost());
    const db = dbFor(testEnv, 'designer-a');
    await assertFails(updateDoc(doc(db, 'professionalPosts', 'p29'), { verified: true }));
  });

  it('the owner cannot update to an invalid category', async () => {
    await seedServiceProvider('designer-a');
    await seedPost('p30', validPost());
    const db = dbFor(testEnv, 'designer-a');
    await assertFails(updateDoc(doc(db, 'professionalPosts', 'p30'), { category: 'not-real' }));
  });
});

describe('professionalPosts read -- public discovery visibility', () => {
  it('the public (unauthenticated) can read a published post', async () => {
    await seedServiceProvider('designer-a');
    await seedPost('p40', validPost({ status: 'published' }));
    const db = dbFor(testEnv, null);
    await assertSucceeds(getDoc(doc(db, 'professionalPosts', 'p40')));
  });

  it('the public cannot read a hidden post', async () => {
    await seedServiceProvider('designer-a');
    await seedPost('p41', validPost({ status: 'hidden' }));
    const db = dbFor(testEnv, null);
    await assertFails(getDoc(doc(db, 'professionalPosts', 'p41')));
  });

  it('the public cannot read a removed post', async () => {
    await seedServiceProvider('designer-a');
    await seedPost('p42', validPost({ status: 'removed' }));
    const db = dbFor(testEnv, null);
    await assertFails(getDoc(doc(db, 'professionalPosts', 'p42')));
  });

  it('a signed-in customer (not the owner) cannot read a hidden post either', async () => {
    await seedServiceProvider('designer-a');
    await seedUser('customer-2', { role: 'customer', createdAt: 1 });
    await seedPost('p43', validPost({ status: 'hidden' }));
    const db = dbFor(testEnv, 'customer-2');
    await assertFails(getDoc(doc(db, 'professionalPosts', 'p43')));
  });

  it('the owner CAN read their own hidden post', async () => {
    await seedServiceProvider('designer-a');
    await seedPost('p44', validPost({ status: 'hidden' }));
    const db = dbFor(testEnv, 'designer-a');
    await assertSucceeds(getDoc(doc(db, 'professionalPosts', 'p44')));
  });

  it('the owner CAN read their own removed post (so it does not just silently vanish)', async () => {
    await seedServiceProvider('designer-a');
    await seedPost('p45', validPost({ status: 'removed' }));
    const db = dbFor(testEnv, 'designer-a');
    await assertSucceeds(getDoc(doc(db, 'professionalPosts', 'p45')));
  });

  it('a published-only list query does not require an index error and returns only published docs', async () => {
    await seedServiceProvider('designer-a');
    await seedPost('p46', validPost({ status: 'published', profileId: 'designer-a' }));
    await seedPost('p47', validPost({ status: 'hidden', profileId: 'designer-a' }));
    const db = dbFor(testEnv, null);
    const q = query(collection(db, 'professionalPosts'), where('status', '==', 'published'), where('profileType', '==', 'designer'));
    const snap = await assertSucceeds(getDocs(q));
    const ids = snap.docs.map((d) => d.id);
    if (!ids.includes('p46') || ids.includes('p47')) {
      throw new Error(`expected only p46 in results, got: ${ids.join(',')}`);
    }
  });
});

describe('professionalPosts -- admin moderation', () => {
  it('an admin can set status to "removed"', async () => {
    await seedServiceProvider('designer-a');
    await seedUser('admin-1', { role: 'admin', createdAt: 1 });
    await seedPost('p50', validPost());
    const db = dbFor(testEnv, 'admin-1');
    await assertSucceeds(updateDoc(doc(db, 'professionalPosts', 'p50'), { status: 'removed' }));
  });

  it('an admin can delete any post', async () => {
    await seedServiceProvider('designer-a');
    await seedUser('admin-2', { role: 'admin', createdAt: 1 });
    await seedPost('p51', validPost());
    const db = dbFor(testEnv, 'admin-2');
    await assertSucceeds(deleteDoc(doc(db, 'professionalPosts', 'p51')));
  });

  it('a non-admin cannot moderate (set status to "removed") someone else\'s post', async () => {
    await seedServiceProvider('designer-a');
    await seedServiceProvider('designer-b');
    await seedPost('p52', validPost());
    const db = dbFor(testEnv, 'designer-b');
    await assertFails(updateDoc(doc(db, 'professionalPosts', 'p52'), { status: 'removed' }));
  });
});
