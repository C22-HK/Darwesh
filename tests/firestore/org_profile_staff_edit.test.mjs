// Launch-readiness fix: "organization profile editing... with proper
// ownership/staff permissions" was half-built -- an active staff member
// granted 'manage_organization_profile' (Phase 2.1's org-scoped grant)
// could already edit organizations/{orgId}/private/contact with it, but
// the public organizations/{orgId} document's own update rule only ever
// checked isOrgOwnerNow() or isAdmin(). This proves the extended rule:
//   1. the owner can still edit exactly as before (regression guard)
//   2. an active staff member WITH the grant can edit the same fields
//   3. an active staff member WITHOUT the grant is denied
//   4. a pending/invited (not yet active) member is denied
//   5. staff -- granted or not -- can never touch type/verified/ownerId
// Run with `npm run test:rules`.
import { before, after, beforeEach, describe, it } from 'node:test';
import { assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { doc, setDoc, updateDoc } from 'firebase/firestore';
import { makeTestEnv, seed, dbFor } from './helpers.mjs';

let testEnv;
const OWNER = 'org-owner-uid';
const GRANTED_STAFF = 'granted-staff-uid';
const UNGRANTED_STAFF = 'ungranted-staff-uid';
const PENDING_STAFF = 'pending-staff-uid';
const OUTSIDER = 'outsider-uid';
const ORG_ID = 'org-1';

before(async () => { testEnv = await makeTestEnv(); });
after(async () => { await testEnv.cleanup(); });
beforeEach(async () => {
  await testEnv.clearFirestore();
  await seed(testEnv, async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'organizations', ORG_ID), {
      type: 'developer_project', ownerId: OWNER, name: 'Darwesh Homes',
      description: 'Original description', verified: false, createdAt: 1
    });
    await setDoc(doc(db, 'organizations', ORG_ID, 'members', GRANTED_STAFF), {
      status: 'active', permissions: { manage_organization_profile: true }
    });
    await setDoc(doc(db, 'organizations', ORG_ID, 'members', UNGRANTED_STAFF), {
      status: 'active', permissions: { manage_organization_profile: false }
    });
    await setDoc(doc(db, 'organizations', ORG_ID, 'members', PENDING_STAFF), {
      status: 'pending', permissions: { manage_organization_profile: true }
    });
  });
});

describe('organizations/{orgId} update: owner + granted staff', () => {
  it('the owner can still edit name/description/logoUrl/city/district/location/details (regression)', async () => {
    const db = dbFor(testEnv, OWNER);
    await assertSucceeds(updateDoc(doc(db, 'organizations', ORG_ID), {
      name: 'Darwesh Homes Ltd.', description: 'Updated by owner', city: 'Erbil',
      district: 'Ainkawa', location: { lat: 36.2, lng: 44.0 },
      details: { downPayment: 20 }, updatedAt: 2
    }));
  });
  it('an active staff member WITH manage_organization_profile can edit the same public fields', async () => {
    const db = dbFor(testEnv, GRANTED_STAFF);
    await assertSucceeds(updateDoc(doc(db, 'organizations', ORG_ID), {
      description: 'Updated by granted staff', updatedAt: 2
    }));
  });
  it('an active staff member WITHOUT the grant is denied', async () => {
    const db = dbFor(testEnv, UNGRANTED_STAFF);
    await assertFails(updateDoc(doc(db, 'organizations', ORG_ID), { description: 'Should not land' }));
  });
  it('a pending (not yet active) member is denied even though their eventual grant is true', async () => {
    const db = dbFor(testEnv, PENDING_STAFF);
    await assertFails(updateDoc(doc(db, 'organizations', ORG_ID), { description: 'Should not land' }));
  });
  it('an outsider with no membership record is denied', async () => {
    const db = dbFor(testEnv, OUTSIDER);
    await assertFails(updateDoc(doc(db, 'organizations', ORG_ID), { description: 'Should not land' }));
  });
  it('granted staff can never change type, verified, or ownerId', async () => {
    const db = dbFor(testEnv, GRANTED_STAFF);
    await assertFails(updateDoc(doc(db, 'organizations', ORG_ID), { type: 'furniture_store' }));
    await assertFails(updateDoc(doc(db, 'organizations', ORG_ID), { verified: true }));
    await assertFails(updateDoc(doc(db, 'organizations', ORG_ID), { ownerId: GRANTED_STAFF }));
  });
  it('the owner can never self-verify or change their own org type either (regression)', async () => {
    const db = dbFor(testEnv, OWNER);
    await assertFails(updateDoc(doc(db, 'organizations', ORG_ID), { verified: true }));
    await assertFails(updateDoc(doc(db, 'organizations', ORG_ID), { type: 'furniture_store' }));
  });
});
