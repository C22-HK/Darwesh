// Storage Rules regression tests for the new Phase 1 real-estate paths:
// project-media/{projectId}/{file}, building-media/{projectId}/{buildingId}/{file},
// floorplan-media/{projectId}/{planId}/{file}, unit-media/{unitId}/{file}.
// Run with `npm run test:storage-rules`.
//
// Each path cross-checks a real Firestore projects/organizations (or
// units/organizations) document via firestore.get() -- same pattern as
// the pre-existing professional-work/{profileId} block, which this file
// deliberately never touches or weakens (see professional_work.test.mjs's
// own describe blocks re-asserted unchanged at the bottom of this file).
//
// KNOWN ENVIRONMENT LIMITATION (same as professional_work.test.mjs): the
// Storage emulator's rules-runtime needs outbound access to
// firebase-public.firebaseio.com for firestore.get() cross-service calls.
// In this sandbox that host is blocked, so every firestore.get() inside
// storage.rules throws a generic "Null value error" regardless of actual
// rule logic -- assertFails() cases still pass (a crash is "not
// succeeded"), assertSucceeds() cases correctly and visibly fail. This is
// not a bug in these tests or in storage.rules.
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

const OWNER = 'dev-owner-uid';
const OTHER_OWNER = 'other-owner-uid';
const DEV_ORG = 'dev-org-1';
const OTHER_ORG = 'other-org-1';

async function seedOwnerContext(uid = OWNER, orgId = DEV_ORG) {
  await seedFirestore(testEnv, ['users', uid], { role: 'customer', accountType: 'org_owner_developer', createdAt: 1 });
  await seedFirestore(testEnv, ['organizations', orgId], { ownerId: uid, type: 'developer_project', name: 'Darwesh Developments', verified: false });
}
async function seedProject(projectId, organizationId = DEV_ORG) {
  await seedFirestore(testEnv, ['projects', projectId], { organizationId, name: 'Zaytoon Hills', createdAt: 1, updatedAt: 1 });
}
async function seedUnit(unitId, organizationId = DEV_ORG, projectId = 'proj-1') {
  await seedFirestore(testEnv, ['units', unitId], { organizationId, projectId, unitNumber: 'A-101', createdAt: 1, updatedAt: 1 });
}
async function seedUser(uid, data) {
  await seedFirestore(testEnv, ['users', uid], data);
}

const SMALL_BYTES = new Uint8Array(1024);
const OVERSIZED_BYTES = new Uint8Array(10 * 1024 * 1024 + 1);

describe('project-media upload — ownership', () => {
  it('an authorized org owner can upload a JPEG to their own project', async () => {
    await seedOwnerContext();
    await seedProject('proj-1');
    const storage = storageFor(testEnv, OWNER);
    await assertSucceeds(uploadBytes(ref(storage, 'project-media/proj-1/cover.jpg'), SMALL_BYTES, { contentType: 'image/jpeg' }));
  });

  it('a different org cannot upload into another org\'s project', async () => {
    await seedOwnerContext();
    await seedProject('proj-1');
    await seedOwnerContext(OTHER_OWNER, OTHER_ORG);
    const storage = storageFor(testEnv, OTHER_OWNER);
    await assertFails(uploadBytes(ref(storage, 'project-media/proj-1/cover.jpg'), SMALL_BYTES, { contentType: 'image/jpeg' }));
  });

  it('an unauthenticated caller is denied', async () => {
    await seedOwnerContext();
    await seedProject('proj-1');
    const storage = storageFor(testEnv, null);
    await assertFails(uploadBytes(ref(storage, 'project-media/proj-1/cover.jpg'), SMALL_BYTES, { contentType: 'image/jpeg' }));
  });

  it('rejects an oversized file', async () => {
    await seedOwnerContext();
    await seedProject('proj-1');
    const storage = storageFor(testEnv, OWNER);
    await assertFails(uploadBytes(ref(storage, 'project-media/proj-1/huge.jpg'), OVERSIZED_BYTES, { contentType: 'image/jpeg' }));
  });

  it('rejects an SVG', async () => {
    await seedOwnerContext();
    await seedProject('proj-1');
    const storage = storageFor(testEnv, OWNER);
    await assertFails(uploadBytes(ref(storage, 'project-media/proj-1/x.svg'), SMALL_BYTES, { contentType: 'image/svg+xml' }));
  });

  it('rejects a PDF (brochures deferred this phase)', async () => {
    await seedOwnerContext();
    await seedProject('proj-1');
    const storage = storageFor(testEnv, OWNER);
    await assertFails(uploadBytes(ref(storage, 'project-media/proj-1/brochure.pdf'), SMALL_BYTES, { contentType: 'application/pdf' }));
  });
});

describe('building-media upload — ownership', () => {
  it('an authorized org owner can upload to a building under their project', async () => {
    await seedOwnerContext();
    await seedProject('proj-1');
    const storage = storageFor(testEnv, OWNER);
    await assertSucceeds(uploadBytes(ref(storage, 'building-media/proj-1/b1/photo.jpg'), SMALL_BYTES, { contentType: 'image/jpeg' }));
  });

  it('a different org is denied', async () => {
    await seedOwnerContext();
    await seedProject('proj-1');
    await seedOwnerContext(OTHER_OWNER, OTHER_ORG);
    const storage = storageFor(testEnv, OTHER_OWNER);
    await assertFails(uploadBytes(ref(storage, 'building-media/proj-1/b1/photo.jpg'), SMALL_BYTES, { contentType: 'image/jpeg' }));
  });
});

describe('floorplan-media upload — ownership', () => {
  it('an authorized org owner can upload a floor plan image', async () => {
    await seedOwnerContext();
    await seedProject('proj-1');
    const storage = storageFor(testEnv, OWNER);
    await assertSucceeds(uploadBytes(ref(storage, 'floorplan-media/proj-1/plan-a/diagram.png'), SMALL_BYTES, { contentType: 'image/png' }));
  });

  it('a different org is denied', async () => {
    await seedOwnerContext();
    await seedProject('proj-1');
    await seedOwnerContext(OTHER_OWNER, OTHER_ORG);
    const storage = storageFor(testEnv, OTHER_OWNER);
    await assertFails(uploadBytes(ref(storage, 'floorplan-media/proj-1/plan-a/diagram.png'), SMALL_BYTES, { contentType: 'image/png' }));
  });
});

describe('unit-media upload — ownership', () => {
  it('an authorized org owner can upload a unit photo', async () => {
    await seedOwnerContext();
    await seedProject('proj-1');
    await seedUnit('unit-1');
    const storage = storageFor(testEnv, OWNER);
    await assertSucceeds(uploadBytes(ref(storage, 'unit-media/unit-1/cover.webp'), SMALL_BYTES, { contentType: 'image/webp' }));
  });

  it('a different org is denied', async () => {
    await seedOwnerContext();
    await seedProject('proj-1');
    await seedUnit('unit-1');
    await seedOwnerContext(OTHER_OWNER, OTHER_ORG);
    const storage = storageFor(testEnv, OTHER_OWNER);
    await assertFails(uploadBytes(ref(storage, 'unit-media/unit-1/cover.webp'), SMALL_BYTES, { contentType: 'image/webp' }));
  });

  it('a plain customer with no org relationship is denied', async () => {
    await seedOwnerContext();
    await seedProject('proj-1');
    await seedUnit('unit-1');
    await seedUser('customer-1', { role: 'customer', createdAt: 1 });
    const storage = storageFor(testEnv, 'customer-1');
    await assertFails(uploadBytes(ref(storage, 'unit-media/unit-1/cover.webp'), SMALL_BYTES, { contentType: 'image/webp' }));
  });

  it('an admin can upload without organization membership', async () => {
    await seedOwnerContext();
    await seedProject('proj-1');
    await seedUnit('unit-1');
    await seedUser('admin-1', { role: 'admin', createdAt: 1 });
    const storage = storageFor(testEnv, 'admin-1');
    await assertSucceeds(uploadBytes(ref(storage, 'unit-media/unit-1/cover.webp'), SMALL_BYTES, { contentType: 'image/webp' }));
  });

  it('delete is allowed for the authorized org (project/building/floorplan/unit media is owner-manageable)', async () => {
    await seedOwnerContext();
    await seedProject('proj-1');
    await seedUnit('unit-1');
    const storage = storageFor(testEnv, OWNER);
    const fileRef = ref(storage, 'unit-media/unit-1/cover.webp');
    await assertSucceeds(uploadBytes(fileRef, SMALL_BYTES, { contentType: 'image/webp' }));
    await assertSucceeds(deleteObject(fileRef));
  });
});

describe('professional-work/ remains untouched by this phase (regression guard)', () => {
  async function seedDesignerProfile(uid, overrides = {}) {
    await seedFirestore(testEnv, ['users', uid], { role: 'customer', accountType: 'professional_designer', createdAt: 1 });
    await seedFirestore(testEnv, ['serviceProviders', uid], {
      serviceType: 'designer', providerType: 'individual', ownerId: uid,
      displayName: 'Test Designer', verified: false, createdAt: 1, updatedAt: 1,
      ...overrides
    });
  }
  it('the owning Designer can still upload to their own professional-work path', async () => {
    await seedDesignerProfile('designer-a');
    const storage = storageFor(testEnv, 'designer-a');
    await assertSucceeds(uploadBytes(ref(storage, 'professional-work/designer-a/photo.jpg'), SMALL_BYTES, { contentType: 'image/jpeg' }));
  });
  it('a different Designer is still denied on professional-work', async () => {
    await seedDesignerProfile('designer-a');
    await seedDesignerProfile('designer-b');
    const storage = storageFor(testEnv, 'designer-b');
    await assertFails(uploadBytes(ref(storage, 'professional-work/designer-a/photo.jpg'), SMALL_BYTES, { contentType: 'image/jpeg' }));
  });
  it('SVG is still rejected on professional-work', async () => {
    await seedDesignerProfile('designer-a');
    const storage = storageFor(testEnv, 'designer-a');
    await assertFails(uploadBytes(ref(storage, 'professional-work/designer-a/x.svg'), SMALL_BYTES, { contentType: 'image/svg+xml' }));
  });
});
