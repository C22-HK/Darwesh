// Storage Rules regression tests for the two U3 (launch-readiness) paths
// added for organization.html: organization-media/{orgId}/{kind}/{fileName}
// (logo/cover) and product-media/{orgId}/{fileName} (furniture_store
// product photos). Same isActiveOrgMember() cross-service ownership check
// as project-media/building-media/floorplan-media/unit-media (see
// project_media.test.mjs) -- these two paths had ZERO test coverage
// before this file. Run with `npm run test:storage-rules`.
//
// KNOWN ENVIRONMENT LIMITATION (same as every other *_media.test.mjs in
// this directory): the Storage emulator's rules-runtime needs outbound
// access to firebase-public.firebaseio.com for the firestore.get()
// cross-service calls both isActiveOrgMember() and isAdmin() make. In a
// network-restricted sandbox that blocks that host, every such call
// throws a generic "Null value error" regardless of actual rule logic --
// assertFails() cases can pass for the wrong reason (a crash also counts
// as "not succeeded"), while assertSucceeds() cases correctly and
// visibly fail. Any assertSucceeds() failure in this file with that
// exact "Null value error" symptom is an environment limitation, not a
// rules defect -- it is NEVER reported as a passing test either way.
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

const OWNER = 'org-owner-uid';
const MEMBER = 'org-member-uid';
const OTHER_OWNER = 'other-org-owner-uid';
const ORG = 'org-1';
const OTHER_ORG = 'other-org-1';

async function seedOrg(orgId = ORG, ownerId = OWNER) {
  await seedFirestore(testEnv, ['organizations', orgId], {
    ownerId,
    type: 'org_owner_furniture_store',
    name: 'Test Org',
    verified: false,
  });
}
async function seedActiveMember(orgId, uid, status = 'active') {
  await seedFirestore(testEnv, ['organizations', orgId, 'members', uid], { status, role: 'member' });
}
async function seedUser(uid, data) {
  await seedFirestore(testEnv, ['users', uid], data);
}

const SMALL_BYTES = new Uint8Array(1024);
const OVERSIZED_BYTES = new Uint8Array(10 * 1024 * 1024 + 1);

describe('organization-media upload — ownership + shape', () => {
  it('the org owner can upload a logo', async () => {
    await seedOrg();
    const storage = storageFor(testEnv, OWNER);
    await assertSucceeds(
      uploadBytes(ref(storage, `organization-media/${ORG}/logo/logo.jpg`), SMALL_BYTES, { contentType: 'image/jpeg' })
    );
  });

  it('the org owner can upload a cover image', async () => {
    await seedOrg();
    const storage = storageFor(testEnv, OWNER);
    await assertSucceeds(
      uploadBytes(ref(storage, `organization-media/${ORG}/cover/cover.png`), SMALL_BYTES, { contentType: 'image/png' })
    );
  });

  it('an active (non-owner) member can also upload', async () => {
    await seedOrg();
    await seedActiveMember(ORG, MEMBER);
    const storage = storageFor(testEnv, MEMBER);
    await assertSucceeds(
      uploadBytes(ref(storage, `organization-media/${ORG}/logo/logo.webp`), SMALL_BYTES, { contentType: 'image/webp' })
    );
  });

  it('a pending (not-yet-approved) member is denied', async () => {
    await seedOrg();
    await seedActiveMember(ORG, MEMBER, 'pending');
    const storage = storageFor(testEnv, MEMBER);
    await assertFails(
      uploadBytes(ref(storage, `organization-media/${ORG}/logo/logo.jpg`), SMALL_BYTES, { contentType: 'image/jpeg' })
    );
  });

  it('a member of a DIFFERENT organization cannot upload into this one (cross-org denial)', async () => {
    await seedOrg(ORG, OWNER);
    await seedOrg(OTHER_ORG, OTHER_OWNER);
    const storage = storageFor(testEnv, OTHER_OWNER);
    await assertFails(
      uploadBytes(ref(storage, `organization-media/${ORG}/logo/logo.jpg`), SMALL_BYTES, { contentType: 'image/jpeg' })
    );
  });

  it('a plain signed-in user with no relationship to the org is denied', async () => {
    await seedOrg();
    await seedUser('customer-1', { role: 'customer', createdAt: 1 });
    const storage = storageFor(testEnv, 'customer-1');
    await assertFails(
      uploadBytes(ref(storage, `organization-media/${ORG}/logo/logo.jpg`), SMALL_BYTES, { contentType: 'image/jpeg' })
    );
  });

  it('an unauthenticated caller cannot upload', async () => {
    await seedOrg();
    const storage = storageFor(testEnv, null);
    await assertFails(
      uploadBytes(ref(storage, `organization-media/${ORG}/logo/logo.jpg`), SMALL_BYTES, { contentType: 'image/jpeg' })
    );
  });

  it('an admin can upload without any organization membership', async () => {
    await seedOrg();
    await seedUser('admin-1', { role: 'admin', createdAt: 1 });
    const storage = storageFor(testEnv, 'admin-1');
    await assertSucceeds(
      uploadBytes(ref(storage, `organization-media/${ORG}/cover/cover.jpg`), SMALL_BYTES, { contentType: 'image/jpeg' })
    );
  });

  it('rejects a "kind" outside logo/cover', async () => {
    await seedOrg();
    const storage = storageFor(testEnv, OWNER);
    await assertFails(
      uploadBytes(ref(storage, `organization-media/${ORG}/banner/x.jpg`), SMALL_BYTES, { contentType: 'image/jpeg' })
    );
  });

  it('rejects a fileName containing characters outside the allowlist (e.g. spaces)', async () => {
    await seedOrg();
    const storage = storageFor(testEnv, OWNER);
    await assertFails(
      uploadBytes(ref(storage, `organization-media/${ORG}/logo/evil file!.jpg`), SMALL_BYTES, { contentType: 'image/jpeg' })
    );
  });

  it('rejects a fileName over 120 characters', async () => {
    await seedOrg();
    const storage = storageFor(testEnv, OWNER);
    const longName = `${'a'.repeat(117)}.jpg`; // 121 chars total
    await assertFails(
      uploadBytes(ref(storage, `organization-media/${ORG}/logo/${longName}`), SMALL_BYTES, { contentType: 'image/jpeg' })
    );
  });

  it('rejects an oversized file', async () => {
    await seedOrg();
    const storage = storageFor(testEnv, OWNER);
    await assertFails(
      uploadBytes(ref(storage, `organization-media/${ORG}/logo/huge.jpg`), OVERSIZED_BYTES, { contentType: 'image/jpeg' })
    );
  });

  it('rejects an SVG (stored-XSS surface, same reasoning as professional-work/)', async () => {
    await seedOrg();
    const storage = storageFor(testEnv, OWNER);
    await assertFails(
      uploadBytes(ref(storage, `organization-media/${ORG}/logo/x.svg`), SMALL_BYTES, { contentType: 'image/svg+xml' })
    );
  });

  it('rejects a PDF', async () => {
    await seedOrg();
    const storage = storageFor(testEnv, OWNER);
    await assertFails(
      uploadBytes(ref(storage, `organization-media/${ORG}/logo/doc.pdf`), SMALL_BYTES, { contentType: 'application/pdf' })
    );
  });
});

describe('organization-media read + delete', () => {
  it('the uploaded logo is publicly readable, including by a signed-out visitor', async () => {
    await seedOrg();
    const ownerStorage = storageFor(testEnv, OWNER);
    const fileRef = ref(ownerStorage, `organization-media/${ORG}/logo/logo.jpg`);
    await assertSucceeds(uploadBytes(fileRef, SMALL_BYTES, { contentType: 'image/jpeg' }));

    const anonStorage = storageFor(testEnv, null);
    await assertSucceeds(getBytes(ref(anonStorage, `organization-media/${ORG}/logo/logo.jpg`)));
  });

  it('the org owner can delete their own logo', async () => {
    await seedOrg();
    const storage = storageFor(testEnv, OWNER);
    const fileRef = ref(storage, `organization-media/${ORG}/logo/logo.jpg`);
    await assertSucceeds(uploadBytes(fileRef, SMALL_BYTES, { contentType: 'image/jpeg' }));
    await assertSucceeds(deleteObject(fileRef));
  });

  it('a member of a different organization cannot delete this org\'s logo', async () => {
    await seedOrg(ORG, OWNER);
    await seedOrg(OTHER_ORG, OTHER_OWNER);
    const ownerStorage = storageFor(testEnv, OWNER);
    const fileRef = ref(ownerStorage, `organization-media/${ORG}/logo/logo.jpg`);
    await assertSucceeds(uploadBytes(fileRef, SMALL_BYTES, { contentType: 'image/jpeg' }));

    const otherStorage = storageFor(testEnv, OTHER_OWNER);
    await assertFails(deleteObject(ref(otherStorage, `organization-media/${ORG}/logo/logo.jpg`)));
  });
});

describe('product-media upload — ownership + shape', () => {
  it('the org owner can upload a product photo', async () => {
    await seedOrg();
    const storage = storageFor(testEnv, OWNER);
    await assertSucceeds(
      uploadBytes(ref(storage, `product-media/${ORG}/sofa.jpg`), SMALL_BYTES, { contentType: 'image/jpeg' })
    );
  });

  it('an active member can also upload a product photo', async () => {
    await seedOrg();
    await seedActiveMember(ORG, MEMBER);
    const storage = storageFor(testEnv, MEMBER);
    await assertSucceeds(
      uploadBytes(ref(storage, `product-media/${ORG}/chair.png`), SMALL_BYTES, { contentType: 'image/png' })
    );
  });

  it('a member of a DIFFERENT organization cannot upload into this one (cross-org denial)', async () => {
    await seedOrg(ORG, OWNER);
    await seedOrg(OTHER_ORG, OTHER_OWNER);
    const storage = storageFor(testEnv, OTHER_OWNER);
    await assertFails(
      uploadBytes(ref(storage, `product-media/${ORG}/sofa.jpg`), SMALL_BYTES, { contentType: 'image/jpeg' })
    );
  });

  it('an unauthenticated caller cannot upload', async () => {
    await seedOrg();
    const storage = storageFor(testEnv, null);
    await assertFails(
      uploadBytes(ref(storage, `product-media/${ORG}/sofa.jpg`), SMALL_BYTES, { contentType: 'image/jpeg' })
    );
  });

  it('an admin can upload without any organization membership', async () => {
    await seedOrg();
    await seedUser('admin-1', { role: 'admin', createdAt: 1 });
    const storage = storageFor(testEnv, 'admin-1');
    await assertSucceeds(
      uploadBytes(ref(storage, `product-media/${ORG}/sofa.jpg`), SMALL_BYTES, { contentType: 'image/jpeg' })
    );
  });

  it('rejects a fileName containing characters outside the allowlist (e.g. spaces)', async () => {
    await seedOrg();
    const storage = storageFor(testEnv, OWNER);
    await assertFails(
      uploadBytes(ref(storage, `product-media/${ORG}/evil file!.jpg`), SMALL_BYTES, { contentType: 'image/jpeg' })
    );
  });

  it('rejects an oversized file', async () => {
    await seedOrg();
    const storage = storageFor(testEnv, OWNER);
    await assertFails(
      uploadBytes(ref(storage, `product-media/${ORG}/huge.jpg`), OVERSIZED_BYTES, { contentType: 'image/jpeg' })
    );
  });

  it('rejects an SVG', async () => {
    await seedOrg();
    const storage = storageFor(testEnv, OWNER);
    await assertFails(uploadBytes(ref(storage, `product-media/${ORG}/x.svg`), SMALL_BYTES, { contentType: 'image/svg+xml' }));
  });
});

describe('product-media read + delete', () => {
  it('a product photo is publicly readable, including by a signed-out visitor', async () => {
    await seedOrg();
    const ownerStorage = storageFor(testEnv, OWNER);
    const fileRef = ref(ownerStorage, `product-media/${ORG}/sofa.jpg`);
    await assertSucceeds(uploadBytes(fileRef, SMALL_BYTES, { contentType: 'image/jpeg' }));

    const anonStorage = storageFor(testEnv, null);
    await assertSucceeds(getBytes(ref(anonStorage, `product-media/${ORG}/sofa.jpg`)));
  });

  it('the org owner can delete their own product photo', async () => {
    await seedOrg();
    const storage = storageFor(testEnv, OWNER);
    const fileRef = ref(storage, `product-media/${ORG}/sofa.jpg`);
    await assertSucceeds(uploadBytes(fileRef, SMALL_BYTES, { contentType: 'image/jpeg' }));
    await assertSucceeds(deleteObject(fileRef));
  });

  it('a plain customer cannot delete a product photo', async () => {
    await seedOrg();
    const ownerStorage = storageFor(testEnv, OWNER);
    const fileRef = ref(ownerStorage, `product-media/${ORG}/sofa.jpg`);
    await assertSucceeds(uploadBytes(fileRef, SMALL_BYTES, { contentType: 'image/jpeg' }));

    await seedUser('customer-1', { role: 'customer', createdAt: 1 });
    const customerStorage = storageFor(testEnv, 'customer-1');
    await assertFails(deleteObject(ref(customerStorage, `product-media/${ORG}/sofa.jpg`)));
  });
});

// Regression guard: these two new PUBLIC-read paths must not have loosened
// anything about sell-verification/{token}/{fileName}, the one path in this
// entire file that is deliberately NOT public (admin-only read -- see
// storage.rules' own comment on it). This is the "protected private
// content stays protected" check -- proving the new match blocks are
// additive and isolated, not a rule-ordering change that widens an
// unrelated, genuinely private path.
describe('sell-verification/ (private content) remains protected after adding organization-media/product-media', () => {
  it('a non-admin, even the org owner used throughout this file, cannot read a verification photo', async () => {
    await seedOrg();
    const anyStorage = storageFor(testEnv, OWNER);
    // write is intentionally open (guest sell-submission flow, unrelated
    // to this file) -- write it directly to set up the read check.
    const fileRef = ref(anyStorage, 'sell-verification/tok-1/selfie.jpg');
    await assertSucceeds(uploadBytes(fileRef, SMALL_BYTES, { contentType: 'image/jpeg' }));
    await assertFails(getBytes(ref(anyStorage, 'sell-verification/tok-1/selfie.jpg')));
  });

  it('an unauthenticated caller cannot read a verification photo', async () => {
    const writerStorage = storageFor(testEnv, 'someone');
    await assertSucceeds(
      uploadBytes(ref(writerStorage, 'sell-verification/tok-2/selfie.jpg'), SMALL_BYTES, { contentType: 'image/jpeg' })
    );
    const anonStorage = storageFor(testEnv, null);
    await assertFails(getBytes(ref(anonStorage, 'sell-verification/tok-2/selfie.jpg')));
  });

  it('an admin can still read it (unchanged)', async () => {
    const writerStorage = storageFor(testEnv, 'someone');
    await assertSucceeds(
      uploadBytes(ref(writerStorage, 'sell-verification/tok-3/selfie.jpg'), SMALL_BYTES, { contentType: 'image/jpeg' })
    );
    await seedUser('admin-1', { role: 'admin', createdAt: 1 });
    const adminStorage = storageFor(testEnv, 'admin-1');
    await assertSucceeds(getBytes(ref(adminStorage, 'sell-verification/tok-3/selfie.jpg')));
  });
});
