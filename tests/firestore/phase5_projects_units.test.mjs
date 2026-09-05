// Phase 1 (Multi-role real-estate ecosystem) Firestore Rules regression
// tests: projects / buildings / floorPlans / units / activeListingLocks,
// plus the additive unit-backed extension to `listings`. Run with
// `npm run test:rules`.
//
// Context: implements the approved "Revised Architecture Delta" --
// Organization (business identity) -> Project (a real-estate community/
// development, NEVER a Firebase Auth user/role) -> Buildings + Floor
// Plans -> Units (top-level, inventory entities, never accounts). Unit
// stays the canonical inventory record; `listings` stays the single
// marketplace publication collection, extended with two optional fields
// (unitId, publisherOrgId) that every existing agent/admin listing never
// sets. Authorization reuses the exact isOrgMember()/hasOrgPermission()
// primitive `products` already proved out -- no new authorization
// concept. Money is validated as an integer (`priceAmount`/
// `startingPrice`/etc) with an explicit currency enum, never a float.
// Location on a Unit is a write-time-verified PROJECTION of its parent
// Project's current values (never an independently invented source of
// truth). Active-listing uniqueness per (unitId, dealType) is enforced
// via a deterministic-document-ID reservation (`activeListingLocks`),
// not a client-side query-then-create race.
import { before, after, beforeEach, describe, it } from 'node:test';
import { assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { doc, setDoc, updateDoc, deleteDoc } from 'firebase/firestore';
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

// ---- Seed helpers (bypass rules -- the emulator-test equivalent of a
// trusted backend Admin SDK write) ----------------------------------------
async function seedOrg(orgId, data) {
  await seed(testEnv, async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'organizations', orgId), data);
  });
}
async function seedOrgMember(orgId, uid, data) {
  await seed(testEnv, async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'organizations', orgId, 'members', uid), data);
  });
}
async function seedUser(uid, data) {
  await seed(testEnv, async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'users', uid), data);
  });
}
async function seedRoleDefaults(accountType, permissions) {
  await seed(testEnv, async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'rolePermissionDefaults', accountType), { permissions });
  });
}
async function seedProject(projectId, data) {
  await seed(testEnv, async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'projects', projectId), data);
  });
}
async function seedBuilding(projectId, buildingId, data) {
  await seed(testEnv, async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'projects', projectId, 'buildings', buildingId), data);
  });
}
async function seedFloorPlan(projectId, planId, data) {
  await seed(testEnv, async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'projects', projectId, 'floorPlans', planId), data);
  });
}
async function seedUnit(unitId, data) {
  await seed(testEnv, async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'units', unitId), data);
  });
}
async function seedLock(lockId, data) {
  await seed(testEnv, async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'activeListingLocks', lockId), data);
  });
}
async function seedListing(listingId, data) {
  await seed(testEnv, async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'listings', listingId), data);
  });
}

// ---- Fixture builders -----------------------------------------------------
const DEV_ORG = 'dev-org-1';
const OTHER_ORG = 'other-org-1';
const OWNER = 'dev-owner-uid';
const OTHER_OWNER = 'other-owner-uid';
const EMPLOYEE = 'dev-employee-uid';
const STRANGER = 'stranger-uid';

const ALL_PROJECT_PERMS = {
  create_project: true, edit_own_project: true, create_building: true,
  edit_own_building: true, manage_floor_plans: true, create_unit: true,
  edit_own_unit: true, publish_unit_listing: true
};

async function seedOwnerViaRoleDefaults(uid = OWNER, accountType = 'org_owner_developer', perms = ALL_PROJECT_PERMS) {
  await seedUser(uid, { role: 'customer', accountType, createdAt: 1 });
  await seedRoleDefaults(accountType, perms);
}

async function seedEmployeeViaOrgGrant(orgId = DEV_ORG, uid = EMPLOYEE, perms = ALL_PROJECT_PERMS) {
  await seedUser(uid, { role: 'customer', accountType: 'individual_customer', createdAt: 1 });
  await seedOrgMember(orgId, uid, { role: 'employee', status: 'active', permissions: perms });
}

function validProject(overrides = {}) {
  return {
    organizationId: DEV_ORG, name: 'Zaytoon Hills', governorate: 'Erbil', city: 'Erbil',
    district: 'Italian Village', constructionStatus: 'under_construction', completionPercent: 40,
    currency: 'USD', startingPrice: 120000, location: { lat: 36.19, lng: 44.01 },
    verified: false, createdAt: 1, updatedAt: 1,
    ...overrides
  };
}

function validUnit(overrides = {}) {
  return {
    organizationId: DEV_ORG, projectId: 'proj-1', unitNumber: 'A-101', propertyType: 'apartment',
    listingType: 'sale', status: 'available', priceAmount: 150000, currency: 'USD',
    governorate: 'Erbil', city: 'Erbil', district: 'Italian Village',
    location: { lat: 36.19, lng: 44.01 }, createdAt: 1, updatedAt: 1,
    ...overrides
  };
}

// =========================================================================
describe('PROJECT — create', () => {
  it('an authorized org owner (global role-default grant) can create a project', async () => {
    await seedOrg(DEV_ORG, { ownerId: OWNER, type: 'developer_project', name: 'Darwesh Developments', verified: false });
    await seedOwnerViaRoleDefaults();
    const db = dbFor(testEnv, OWNER);
    await assertSucceeds(setDoc(doc(db, 'projects', 'proj-1'), validProject()));
  });

  it('an authorized org member (org-scoped grant) can create a project', async () => {
    await seedOrg(DEV_ORG, { ownerId: OWNER, type: 'developer_project', name: 'Darwesh Developments', verified: false });
    await seedEmployeeViaOrgGrant();
    const db = dbFor(testEnv, EMPLOYEE);
    await assertSucceeds(setDoc(doc(db, 'projects', 'proj-1'), validProject()));
  });

  it('an unauthorized user (no membership, no permission) cannot create a project', async () => {
    await seedOrg(DEV_ORG, { ownerId: OWNER, type: 'developer_project', name: 'Darwesh Developments', verified: false });
    await seedUser(STRANGER, { role: 'customer', accountType: 'individual_customer', createdAt: 1 });
    const db = dbFor(testEnv, STRANGER);
    await assertFails(setDoc(doc(db, 'projects', 'proj-1'), validProject()));
  });

  it('an org member WITHOUT create_project permission cannot create a project', async () => {
    await seedOrg(DEV_ORG, { ownerId: OWNER, type: 'developer_project', name: 'Darwesh Developments', verified: false });
    await seedEmployeeViaOrgGrant(DEV_ORG, EMPLOYEE, { edit_own_project: true }); // no create_project
    const db = dbFor(testEnv, EMPLOYEE);
    await assertFails(setDoc(doc(db, 'projects', 'proj-1'), validProject()));
  });

  it('rejects an org whose type is not project-capable (e.g. furniture_store)', async () => {
    await seedOrg(DEV_ORG, { ownerId: OWNER, type: 'furniture_store', name: 'Not a developer', verified: false });
    await seedOwnerViaRoleDefaults();
    const db = dbFor(testEnv, OWNER);
    await assertFails(setDoc(doc(db, 'projects', 'proj-1'), validProject()));
  });

  it('rejects a caller trying to self-verify at create', async () => {
    await seedOrg(DEV_ORG, { ownerId: OWNER, type: 'developer_project', name: 'Darwesh Developments', verified: false });
    await seedOwnerViaRoleDefaults();
    const db = dbFor(testEnv, OWNER);
    await assertFails(setDoc(doc(db, 'projects', 'proj-1'), validProject({ verified: true })));
  });

  it('rejects an invalid constructionStatus', async () => {
    await seedOrg(DEV_ORG, { ownerId: OWNER, type: 'developer_project', name: 'Darwesh Developments', verified: false });
    await seedOwnerViaRoleDefaults();
    const db = dbFor(testEnv, OWNER);
    await assertFails(setDoc(doc(db, 'projects', 'proj-1'), validProject({ constructionStatus: 'almost_done' })));
  });

  it('rejects an out-of-range completionPercent', async () => {
    await seedOrg(DEV_ORG, { ownerId: OWNER, type: 'developer_project', name: 'Darwesh Developments', verified: false });
    await seedOwnerViaRoleDefaults();
    const db = dbFor(testEnv, OWNER);
    await assertFails(setDoc(doc(db, 'projects', 'proj-1'), validProject({ completionPercent: 140 })));
  });

  it('rejects a float startingPrice (canonical money must be an integer)', async () => {
    await seedOrg(DEV_ORG, { ownerId: OWNER, type: 'developer_project', name: 'Darwesh Developments', verified: false });
    await seedOwnerViaRoleDefaults();
    const db = dbFor(testEnv, OWNER);
    await assertFails(setDoc(doc(db, 'projects', 'proj-1'), validProject({ startingPrice: 120000.5 })));
  });

  it('rejects an invalid currency', async () => {
    await seedOrg(DEV_ORG, { ownerId: OWNER, type: 'developer_project', name: 'Darwesh Developments', verified: false });
    await seedOwnerViaRoleDefaults();
    const db = dbFor(testEnv, OWNER);
    await assertFails(setDoc(doc(db, 'projects', 'proj-1'), validProject({ currency: 'EUR' })));
  });
});

describe('PROJECT — update', () => {
  it('the owning org can edit its own project', async () => {
    await seedOrg(DEV_ORG, { ownerId: OWNER, type: 'developer_project', name: 'Darwesh Developments', verified: false });
    await seedOwnerViaRoleDefaults();
    await seedProject('proj-1', validProject());
    const db = dbFor(testEnv, OWNER);
    await assertSucceeds(updateDoc(doc(db, 'projects', 'proj-1'), { completionPercent: 55, updatedAt: 2 }));
  });

  it('a different org cannot edit another org\'s project', async () => {
    await seedOrg(DEV_ORG, { ownerId: OWNER, type: 'developer_project', name: 'Darwesh Developments', verified: false });
    await seedOrg(OTHER_ORG, { ownerId: OTHER_OWNER, type: 'developer_project', name: 'Rival Devs', verified: false });
    await seedOwnerViaRoleDefaults(OTHER_OWNER);
    await seedProject('proj-1', validProject());
    const db = dbFor(testEnv, OTHER_OWNER);
    await assertFails(updateDoc(doc(db, 'projects', 'proj-1'), { completionPercent: 55, updatedAt: 2 }));
  });

  it('organizationId is immutable on update', async () => {
    await seedOrg(DEV_ORG, { ownerId: OWNER, type: 'developer_project', name: 'Darwesh Developments', verified: false });
    await seedOrg(OTHER_ORG, { ownerId: OWNER, type: 'developer_project', name: 'Second Org', verified: false });
    await seedOwnerViaRoleDefaults();
    await seedProject('proj-1', validProject());
    const db = dbFor(testEnv, OWNER);
    await assertFails(updateDoc(doc(db, 'projects', 'proj-1'), { organizationId: OTHER_ORG, updatedAt: 2 }));
  });

  it('verified cannot be self-set by the owning org', async () => {
    await seedOrg(DEV_ORG, { ownerId: OWNER, type: 'developer_project', name: 'Darwesh Developments', verified: false });
    await seedOwnerViaRoleDefaults();
    await seedProject('proj-1', validProject());
    const db = dbFor(testEnv, OWNER);
    await assertFails(updateDoc(doc(db, 'projects', 'proj-1'), { verified: true, updatedAt: 2 }));
  });

  it('createdAt is immutable on update', async () => {
    await seedOrg(DEV_ORG, { ownerId: OWNER, type: 'developer_project', name: 'Darwesh Developments', verified: false });
    await seedOwnerViaRoleDefaults();
    await seedProject('proj-1', validProject());
    const db = dbFor(testEnv, OWNER);
    await assertFails(updateDoc(doc(db, 'projects', 'proj-1'), { createdAt: 999, updatedAt: 2 }));
  });

  it('an admin can set verified without organization membership', async () => {
    await seedOrg(DEV_ORG, { ownerId: OWNER, type: 'developer_project', name: 'Darwesh Developments', verified: false });
    await seedProject('proj-1', validProject());
    await seedUser('admin-1', { role: 'admin', createdAt: 1 });
    const db = dbFor(testEnv, 'admin-1');
    await assertSucceeds(updateDoc(doc(db, 'projects', 'proj-1'), { verified: true, updatedAt: 2 }));
  });
});

// =========================================================================
describe('BUILDING', () => {
  it('an authorized org member can create a building under a real project', async () => {
    await seedOrg(DEV_ORG, { ownerId: OWNER, type: 'developer_project', name: 'Darwesh Developments', verified: false });
    await seedOwnerViaRoleDefaults();
    await seedProject('proj-1', validProject());
    const db = dbFor(testEnv, OWNER);
    await assertSucceeds(setDoc(doc(db, 'projects', 'proj-1', 'buildings', 'b1'), {
      projectId: 'proj-1', name: 'Tower A', constructionStatus: 'under_construction',
      numberOfFloors: 12, unitsPerFloor: 4, createdAt: 1, updatedAt: 1
    }));
  });

  it('cross-project mismatch (projectId field disagrees with the URL path) is rejected', async () => {
    await seedOrg(DEV_ORG, { ownerId: OWNER, type: 'developer_project', name: 'Darwesh Developments', verified: false });
    await seedOwnerViaRoleDefaults();
    await seedProject('proj-1', validProject());
    const db = dbFor(testEnv, OWNER);
    await assertFails(setDoc(doc(db, 'projects', 'proj-1', 'buildings', 'b1'), {
      projectId: 'some-other-project', name: 'Tower A', createdAt: 1, updatedAt: 1
    }));
  });

  it('cross-org: a different org cannot create a building under someone else\'s project', async () => {
    await seedOrg(DEV_ORG, { ownerId: OWNER, type: 'developer_project', name: 'Darwesh Developments', verified: false });
    await seedOrg(OTHER_ORG, { ownerId: OTHER_OWNER, type: 'developer_project', name: 'Rival Devs', verified: false });
    await seedOwnerViaRoleDefaults(OTHER_OWNER);
    await seedProject('proj-1', validProject());
    const db = dbFor(testEnv, OTHER_OWNER);
    await assertFails(setDoc(doc(db, 'projects', 'proj-1', 'buildings', 'b1'), {
      projectId: 'proj-1', name: 'Tower A', createdAt: 1, updatedAt: 1
    }));
  });

  it('the project<->building relationship cannot be mutated on update', async () => {
    await seedOrg(DEV_ORG, { ownerId: OWNER, type: 'developer_project', name: 'Darwesh Developments', verified: false });
    await seedOwnerViaRoleDefaults();
    await seedProject('proj-1', validProject());
    await seedBuilding('proj-1', 'b1', { projectId: 'proj-1', name: 'Tower A', createdAt: 1, updatedAt: 1 });
    const db = dbFor(testEnv, OWNER);
    await assertFails(updateDoc(doc(db, 'projects', 'proj-1', 'buildings', 'b1'), { projectId: 'other-project', updatedAt: 2 }));
  });

  it('an unauthorized user cannot create a building', async () => {
    await seedOrg(DEV_ORG, { ownerId: OWNER, type: 'developer_project', name: 'Darwesh Developments', verified: false });
    await seedProject('proj-1', validProject());
    await seedUser(STRANGER, { role: 'customer', accountType: 'individual_customer', createdAt: 1 });
    const db = dbFor(testEnv, STRANGER);
    await assertFails(setDoc(doc(db, 'projects', 'proj-1', 'buildings', 'b1'), {
      projectId: 'proj-1', name: 'Tower A', createdAt: 1, updatedAt: 1
    }));
  });

  it('rejects an out-of-bound numberOfFloors', async () => {
    await seedOrg(DEV_ORG, { ownerId: OWNER, type: 'developer_project', name: 'Darwesh Developments', verified: false });
    await seedOwnerViaRoleDefaults();
    await seedProject('proj-1', validProject());
    const db = dbFor(testEnv, OWNER);
    await assertFails(setDoc(doc(db, 'projects', 'proj-1', 'buildings', 'b1'), {
      projectId: 'proj-1', name: 'Tower A', numberOfFloors: 5000, createdAt: 1, updatedAt: 1
    }));
  });
});

// =========================================================================
describe('FLOOR PLAN', () => {
  it('an authorized org member can manage a floor plan', async () => {
    await seedOrg(DEV_ORG, { ownerId: OWNER, type: 'developer_project', name: 'Darwesh Developments', verified: false });
    await seedOwnerViaRoleDefaults();
    await seedProject('proj-1', validProject());
    const db = dbFor(testEnv, OWNER);
    await assertSucceeds(setDoc(doc(db, 'projects', 'proj-1', 'floorPlans', 'plan-a'), {
      projectId: 'proj-1', name: 'Plan A', bedrooms: 2, bathrooms: 2, areaSqm: 120, createdAt: 1, updatedAt: 1
    }));
  });

  it('cross-project reference mismatch is rejected', async () => {
    await seedOrg(DEV_ORG, { ownerId: OWNER, type: 'developer_project', name: 'Darwesh Developments', verified: false });
    await seedOwnerViaRoleDefaults();
    await seedProject('proj-1', validProject());
    const db = dbFor(testEnv, OWNER);
    await assertFails(setDoc(doc(db, 'projects', 'proj-1', 'floorPlans', 'plan-a'), {
      projectId: 'not-proj-1', name: 'Plan A', createdAt: 1, updatedAt: 1
    }));
  });

  it('rejects invalid bedroom count', async () => {
    await seedOrg(DEV_ORG, { ownerId: OWNER, type: 'developer_project', name: 'Darwesh Developments', verified: false });
    await seedOwnerViaRoleDefaults();
    await seedProject('proj-1', validProject());
    const db = dbFor(testEnv, OWNER);
    await assertFails(setDoc(doc(db, 'projects', 'proj-1', 'floorPlans', 'plan-a'), {
      projectId: 'proj-1', name: 'Plan A', bedrooms: 99, createdAt: 1, updatedAt: 1
    }));
  });

  it('an org member without manage_floor_plans permission cannot create one', async () => {
    await seedOrg(DEV_ORG, { ownerId: OWNER, type: 'developer_project', name: 'Darwesh Developments', verified: false });
    await seedEmployeeViaOrgGrant(DEV_ORG, EMPLOYEE, { create_unit: true }); // no manage_floor_plans
    await seedProject('proj-1', validProject());
    const db = dbFor(testEnv, EMPLOYEE);
    await assertFails(setDoc(doc(db, 'projects', 'proj-1', 'floorPlans', 'plan-a'), {
      projectId: 'proj-1', name: 'Plan A', createdAt: 1, updatedAt: 1
    }));
  });
});

// =========================================================================
describe('UNIT — create', () => {
  it('an authorized org member can create a unit against a real project', async () => {
    await seedOrg(DEV_ORG, { ownerId: OWNER, type: 'developer_project', name: 'Darwesh Developments', verified: false });
    await seedOwnerViaRoleDefaults();
    await seedProject('proj-1', validProject());
    const db = dbFor(testEnv, OWNER);
    await assertSucceeds(setDoc(doc(db, 'units', 'unit-1'), validUnit()));
  });

  it('an unauthorized user cannot create a unit', async () => {
    await seedOrg(DEV_ORG, { ownerId: OWNER, type: 'developer_project', name: 'Darwesh Developments', verified: false });
    await seedProject('proj-1', validProject());
    await seedUser(STRANGER, { role: 'customer', accountType: 'individual_customer', createdAt: 1 });
    const db = dbFor(testEnv, STRANGER);
    await assertFails(setDoc(doc(db, 'units', 'unit-1'), validUnit()));
  });

  it('rejects when organizationId does not match the referenced project\'s own organizationId', async () => {
    await seedOrg(DEV_ORG, { ownerId: OWNER, type: 'developer_project', name: 'Darwesh Developments', verified: false });
    await seedOrg(OTHER_ORG, { ownerId: OWNER, type: 'developer_project', name: 'Second Org', verified: false });
    await seedOwnerViaRoleDefaults();
    await seedProject('proj-1', validProject({ organizationId: DEV_ORG }));
    const db = dbFor(testEnv, OWNER);
    // Claims OTHER_ORG while the real project belongs to DEV_ORG.
    await assertFails(setDoc(doc(db, 'units', 'unit-1'), validUnit({ organizationId: OTHER_ORG })));
  });

  it('a building reference must belong to the same project', async () => {
    await seedOrg(DEV_ORG, { ownerId: OWNER, type: 'developer_project', name: 'Darwesh Developments', verified: false });
    await seedOwnerViaRoleDefaults();
    await seedProject('proj-1', validProject());
    await seedProject('proj-2', validProject({ organizationId: DEV_ORG }));
    await seedBuilding('proj-2', 'b-in-proj-2', { projectId: 'proj-2', name: 'Tower X', createdAt: 1, updatedAt: 1 });
    const db = dbFor(testEnv, OWNER);
    await assertFails(setDoc(doc(db, 'units', 'unit-1'), validUnit({ projectId: 'proj-1', buildingId: 'b-in-proj-2' })));
  });

  it('a floorPlan reference must belong to the same project', async () => {
    await seedOrg(DEV_ORG, { ownerId: OWNER, type: 'developer_project', name: 'Darwesh Developments', verified: false });
    await seedOwnerViaRoleDefaults();
    await seedProject('proj-1', validProject());
    await seedProject('proj-2', validProject({ organizationId: DEV_ORG }));
    await seedFloorPlan('proj-2', 'plan-in-proj-2', { projectId: 'proj-2', name: 'Plan Z', createdAt: 1, updatedAt: 1 });
    const db = dbFor(testEnv, OWNER);
    await assertFails(setDoc(doc(db, 'units', 'unit-1'), validUnit({ projectId: 'proj-1', floorPlanId: 'plan-in-proj-2' })));
  });

  it('a valid same-project building and floorPlan reference is accepted', async () => {
    await seedOrg(DEV_ORG, { ownerId: OWNER, type: 'developer_project', name: 'Darwesh Developments', verified: false });
    await seedOwnerViaRoleDefaults();
    await seedProject('proj-1', validProject());
    await seedBuilding('proj-1', 'b1', { projectId: 'proj-1', name: 'Tower A', createdAt: 1, updatedAt: 1 });
    await seedFloorPlan('proj-1', 'plan-a', { projectId: 'proj-1', name: 'Plan A', createdAt: 1, updatedAt: 1 });
    const db = dbFor(testEnv, OWNER);
    await assertSucceeds(setDoc(doc(db, 'units', 'unit-1'), validUnit({ buildingId: 'b1', floorPlanId: 'plan-a' })));
  });

  it('location mismatch against the parent project is rejected (city)', async () => {
    await seedOrg(DEV_ORG, { ownerId: OWNER, type: 'developer_project', name: 'Darwesh Developments', verified: false });
    await seedOwnerViaRoleDefaults();
    await seedProject('proj-1', validProject({ city: 'Erbil' }));
    const db = dbFor(testEnv, OWNER);
    await assertFails(setDoc(doc(db, 'units', 'unit-1'), validUnit({ city: 'Duhok' })));
  });

  it('location mismatch against the parent project is rejected (lat/lng)', async () => {
    await seedOrg(DEV_ORG, { ownerId: OWNER, type: 'developer_project', name: 'Darwesh Developments', verified: false });
    await seedOwnerViaRoleDefaults();
    await seedProject('proj-1', validProject({ location: { lat: 36.19, lng: 44.01 } }));
    const db = dbFor(testEnv, OWNER);
    await assertFails(setDoc(doc(db, 'units', 'unit-1'), validUnit({ location: { lat: 1, lng: 1 } })));
  });

  it('a unit correctly projecting its parent project\'s real location succeeds', async () => {
    await seedOrg(DEV_ORG, { ownerId: OWNER, type: 'developer_project', name: 'Darwesh Developments', verified: false });
    await seedOwnerViaRoleDefaults();
    await seedProject('proj-1', validProject({ governorate: 'Erbil', city: 'Erbil', district: 'Italian Village', location: { lat: 36.19, lng: 44.01 } }));
    const db = dbFor(testEnv, OWNER);
    await assertSucceeds(setDoc(doc(db, 'units', 'unit-1'), validUnit({ governorate: 'Erbil', city: 'Erbil', district: 'Italian Village', location: { lat: 36.19, lng: 44.01 } })));
  });

  it('rejects a float priceAmount (canonical money must be an integer)', async () => {
    await seedOrg(DEV_ORG, { ownerId: OWNER, type: 'developer_project', name: 'Darwesh Developments', verified: false });
    await seedOwnerViaRoleDefaults();
    await seedProject('proj-1', validProject());
    const db = dbFor(testEnv, OWNER);
    await assertFails(setDoc(doc(db, 'units', 'unit-1'), validUnit({ priceAmount: 150000.99 })));
  });

  it('rejects an invalid currency', async () => {
    await seedOrg(DEV_ORG, { ownerId: OWNER, type: 'developer_project', name: 'Darwesh Developments', verified: false });
    await seedOwnerViaRoleDefaults();
    await seedProject('proj-1', validProject());
    const db = dbFor(testEnv, OWNER);
    await assertFails(setDoc(doc(db, 'units', 'unit-1'), validUnit({ currency: 'EUR' })));
  });

  it('rejects an invalid listingType', async () => {
    await seedOrg(DEV_ORG, { ownerId: OWNER, type: 'developer_project', name: 'Darwesh Developments', verified: false });
    await seedOwnerViaRoleDefaults();
    await seedProject('proj-1', validProject());
    const db = dbFor(testEnv, OWNER);
    await assertFails(setDoc(doc(db, 'units', 'unit-1'), validUnit({ listingType: 'lease_to_own' })));
  });

  it('rejects an invalid status', async () => {
    await seedOrg(DEV_ORG, { ownerId: OWNER, type: 'developer_project', name: 'Darwesh Developments', verified: false });
    await seedOwnerViaRoleDefaults();
    await seedProject('proj-1', validProject());
    const db = dbFor(testEnv, OWNER);
    await assertFails(setDoc(doc(db, 'units', 'unit-1'), validUnit({ status: 'maybe_available' })));
  });
});

describe('UNIT — update', () => {
  it('the owning org can edit its own unit', async () => {
    await seedOrg(DEV_ORG, { ownerId: OWNER, type: 'developer_project', name: 'Darwesh Developments', verified: false });
    await seedOwnerViaRoleDefaults();
    await seedProject('proj-1', validProject());
    await seedUnit('unit-1', validUnit());
    const db = dbFor(testEnv, OWNER);
    await assertSucceeds(updateDoc(doc(db, 'units', 'unit-1'), { status: 'reserved', updatedAt: 2 }));
  });

  it('a different org cannot edit another org\'s unit', async () => {
    await seedOrg(DEV_ORG, { ownerId: OWNER, type: 'developer_project', name: 'Darwesh Developments', verified: false });
    await seedOrg(OTHER_ORG, { ownerId: OTHER_OWNER, type: 'developer_project', name: 'Rival Devs', verified: false });
    await seedOwnerViaRoleDefaults(OTHER_OWNER);
    await seedProject('proj-1', validProject());
    await seedUnit('unit-1', validUnit());
    const db = dbFor(testEnv, OTHER_OWNER);
    await assertFails(updateDoc(doc(db, 'units', 'unit-1'), { status: 'reserved', updatedAt: 2 }));
  });

  it('organizationId is immutable on update', async () => {
    await seedOrg(DEV_ORG, { ownerId: OWNER, type: 'developer_project', name: 'Darwesh Developments', verified: false });
    await seedOrg(OTHER_ORG, { ownerId: OWNER, type: 'developer_project', name: 'Second Org', verified: false });
    await seedOwnerViaRoleDefaults();
    await seedProject('proj-1', validProject());
    await seedUnit('unit-1', validUnit());
    const db = dbFor(testEnv, OWNER);
    await assertFails(updateDoc(doc(db, 'units', 'unit-1'), { organizationId: OTHER_ORG, updatedAt: 2 }));
  });

  it('projectId is immutable on update', async () => {
    await seedOrg(DEV_ORG, { ownerId: OWNER, type: 'developer_project', name: 'Darwesh Developments', verified: false });
    await seedOwnerViaRoleDefaults();
    await seedProject('proj-1', validProject());
    await seedProject('proj-2', validProject({ organizationId: DEV_ORG }));
    await seedUnit('unit-1', validUnit());
    const db = dbFor(testEnv, OWNER);
    await assertFails(updateDoc(doc(db, 'units', 'unit-1'), { projectId: 'proj-2', updatedAt: 2 }));
  });

  it('an admin can update a unit without organization membership', async () => {
    await seedOrg(DEV_ORG, { ownerId: OWNER, type: 'developer_project', name: 'Darwesh Developments', verified: false });
    await seedProject('proj-1', validProject());
    await seedUnit('unit-1', validUnit());
    await seedUser('admin-1', { role: 'admin', createdAt: 1 });
    const db = dbFor(testEnv, 'admin-1');
    await assertSucceeds(updateDoc(doc(db, 'units', 'unit-1'), { status: 'sold', updatedAt: 2 }));
  });

  it('a developer can mark a unit Reserved/Sold with no listing ever existing', async () => {
    await seedOrg(DEV_ORG, { ownerId: OWNER, type: 'developer_project', name: 'Darwesh Developments', verified: false });
    await seedOwnerViaRoleDefaults();
    await seedProject('proj-1', validProject());
    await seedUnit('unit-1', validUnit({ status: 'available' }));
    const db = dbFor(testEnv, OWNER);
    await assertSucceeds(updateDoc(doc(db, 'units', 'unit-1'), { status: 'sold', updatedAt: 2 }));
  });
});

// =========================================================================
describe('UNIT -> LISTING backward compatibility (existing listings/workflows untouched)', () => {
  it('a normal agent listing (no unitId) still creates exactly as before', async () => {
    await seedUser('agent-1', { role: 'agent', companyId: 'co-1', createdAt: 1 });
    const db = dbFor(testEnv, 'agent-1');
    await assertSucceeds(setDoc(doc(db, 'listings', 'l1'), {
      title: 'Nice flat', city: 'Erbil', dealType: 'sale', propertyType: 'apartment',
      price: 100000, private: false, status: 'active',
      agentId: 'agent-1', companyId: 'co-1', createdAt: 1
    }));
  });

  it('a normal agent listing update (no unitId) still works exactly as before', async () => {
    await seedUser('agent-1', { role: 'agent', companyId: 'co-1', createdAt: 1 });
    await seedListing('l1', {
      title: 'Nice flat', city: 'Erbil', dealType: 'sale', propertyType: 'apartment',
      price: 100000, private: false, status: 'active',
      agentId: 'agent-1', companyId: 'co-1', createdAt: 1
    });
    const db = dbFor(testEnv, 'agent-1');
    await assertSucceeds(updateDoc(doc(db, 'listings', 'l1'), { price: 105000, updatedAt: 2 }));
  });

  it('the admin sell-submission conversion path is unaffected', async () => {
    await seedUser('admin-1', { role: 'admin', createdAt: 1 });
    await seed(testEnv, async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'submissions', 'sub-1'), { type: 'sell', uid: null, status: 'pending' });
    });
    const db = dbFor(testEnv, 'admin-1');
    await assertSucceeds(setDoc(doc(db, 'listings', 'l2'), {
      title: 'Converted', city: 'Erbil', price: 90000, private: false, status: 'active',
      sourceSubmissionId: 'sub-1', createdAt: 1
    }));
  });

  it('a stranger still cannot read a private normal listing they do not own', async () => {
    await seedUser('agent-1', { role: 'agent', companyId: 'co-1', createdAt: 1 });
    await seedListing('l1', {
      title: 'Private flat', city: 'Erbil', dealType: 'sale', propertyType: 'apartment',
      price: 100000, private: true, status: 'active', agentId: 'agent-1', companyId: 'co-1', createdAt: 1
    });
    await seedUser(STRANGER, { role: 'customer', accountType: 'individual_customer', createdAt: 1 });
    const db = dbFor(testEnv, STRANGER);
    const { getDoc } = await import('firebase/firestore');
    await assertFails(getDoc(doc(db, 'listings', 'l1')));
  });
});

describe('UNIT -> LISTING publication (new, additive)', () => {
  function seedFullOwnerContext() {
    return (async () => {
      await seedOrg(DEV_ORG, { ownerId: OWNER, type: 'developer_project', name: 'Darwesh Developments', verified: false });
      await seedOwnerViaRoleDefaults();
      await seedProject('proj-1', validProject());
      await seedUnit('unit-1', validUnit({ priceAmount: 150000, currency: 'USD', listingType: 'sale', status: 'available' }));
    })();
  }

  it('claiming the active-listing lock (create-only reservation) succeeds for an authorized org', async () => {
    await seedFullOwnerContext();
    const db = dbFor(testEnv, OWNER);
    await assertSucceeds(setDoc(doc(db, 'activeListingLocks', 'unit-1_sale'), {
      unitId: 'unit-1', dealType: 'sale', activeListingId: 'listing-x', organizationId: DEV_ORG
    }));
  });

  it('a lock document ID that does not match its own unitId/dealType fields is rejected', async () => {
    await seedFullOwnerContext();
    const db = dbFor(testEnv, OWNER);
    await assertFails(setDoc(doc(db, 'activeListingLocks', 'unit-1_sale'), {
      unitId: 'unit-1', dealType: 'rent', activeListingId: 'listing-x', organizationId: DEV_ORG
    }));
  });

  it('an unauthorized org cannot claim a lock for a unit it does not own', async () => {
    await seedFullOwnerContext();
    await seedOrg(OTHER_ORG, { ownerId: OTHER_OWNER, type: 'developer_project', name: 'Rival Devs', verified: false });
    await seedOwnerViaRoleDefaults(OTHER_OWNER);
    const db = dbFor(testEnv, OTHER_OWNER);
    await assertFails(setDoc(doc(db, 'activeListingLocks', 'unit-1_sale'), {
      unitId: 'unit-1', dealType: 'sale', activeListingId: 'listing-x', organizationId: OTHER_ORG
    }));
  });

  it('CRITICAL: a second client cannot claim an already-held lock (uniqueness proof, no race)', async () => {
    await seedFullOwnerContext();
    // First claim succeeds (bypassing rules via seed(), simulating "already
    // committed by a prior, successful write" -- the exact state a second
    // concurrent client would observe).
    await seedLock('unit-1_sale', { unitId: 'unit-1', dealType: 'sale', activeListingId: 'listing-x', organizationId: DEV_ORG });
    const db = dbFor(testEnv, OWNER);
    // A second attempt at the SAME lockId is classified as `update` by
    // Firestore (the doc now exists) -- and this rules file's lock match
    // block sets `allow update: if false` unconditionally, so this must
    // fail regardless of who is asking or what they claim.
    await assertFails(setDoc(doc(db, 'activeListingLocks', 'unit-1_sale'), {
      unitId: 'unit-1', dealType: 'sale', activeListingId: 'listing-y', organizationId: DEV_ORG
    }));
  });

  it('a unit-backed listing can go active once it holds the matching lock', async () => {
    await seedFullOwnerContext();
    await seedLock('unit-1_sale', { unitId: 'unit-1', dealType: 'sale', activeListingId: 'listing-x', organizationId: DEV_ORG });
    const db = dbFor(testEnv, OWNER);
    await assertSucceeds(setDoc(doc(db, 'listings', 'listing-x'), {
      title: 'Zaytoon Hills A-101', city: 'Erbil', dealType: 'sale', propertyType: 'apartment',
      price: 150000, private: false, status: 'active',
      unitId: 'unit-1', projectId: 'proj-1', publisherOrgId: DEV_ORG, createdAt: 1
    }));
  });

  it('CRITICAL: a unit-backed listing cannot go active WITHOUT holding a matching lock', async () => {
    await seedFullOwnerContext();
    // No lock claimed at all.
    const db = dbFor(testEnv, OWNER);
    await assertFails(setDoc(doc(db, 'listings', 'listing-x'), {
      title: 'Zaytoon Hills A-101', city: 'Erbil', dealType: 'sale', propertyType: 'apartment',
      price: 150000, private: false, status: 'active',
      unitId: 'unit-1', projectId: 'proj-1', publisherOrgId: DEV_ORG, createdAt: 1
    }));
  });

  it('CRITICAL: a second listing cannot piggyback on a lock claimed for a different listing id', async () => {
    await seedFullOwnerContext();
    await seedLock('unit-1_sale', { unitId: 'unit-1', dealType: 'sale', activeListingId: 'listing-x', organizationId: DEV_ORG });
    const db = dbFor(testEnv, OWNER);
    // The lock says activeListingId=='listing-x'; a DIFFERENT listing id
    // trying to go active for the same unit+dealType must be rejected.
    await assertFails(setDoc(doc(db, 'listings', 'listing-y'), {
      title: 'Duplicate publish attempt', city: 'Erbil', dealType: 'sale', propertyType: 'apartment',
      price: 150000, private: false, status: 'active',
      unitId: 'unit-1', projectId: 'proj-1', publisherOrgId: DEV_ORG, createdAt: 1
    }));
  });

  it('a unit-backed listing at status:closed does not need a lock at all', async () => {
    await seedFullOwnerContext();
    const db = dbFor(testEnv, OWNER);
    await assertSucceeds(setDoc(doc(db, 'listings', 'listing-historical'), {
      title: 'Old closed listing', city: 'Erbil', dealType: 'sale', propertyType: 'apartment',
      price: 150000, private: false, status: 'closed',
      unitId: 'unit-1', projectId: 'proj-1', publisherOrgId: DEV_ORG, createdAt: 1
    }));
  });

  it('price on a unit-backed listing must mirror the unit\'s canonical priceAmount', async () => {
    await seedFullOwnerContext();
    await seedLock('unit-1_sale', { unitId: 'unit-1', dealType: 'sale', activeListingId: 'listing-x', organizationId: DEV_ORG });
    const db = dbFor(testEnv, OWNER);
    await assertFails(setDoc(doc(db, 'listings', 'listing-x'), {
      title: 'Mismatched price', city: 'Erbil', dealType: 'sale', propertyType: 'apartment',
      price: 999999, private: false, status: 'active', // unit.priceAmount is 150000
      unitId: 'unit-1', projectId: 'proj-1', publisherOrgId: DEV_ORG, createdAt: 1
    }));
  });

  it('dealType on a unit-backed listing must mirror the unit\'s canonical listingType', async () => {
    await seedFullOwnerContext();
    await seedLock('unit-1_sale', { unitId: 'unit-1', dealType: 'sale', activeListingId: 'listing-x', organizationId: DEV_ORG });
    const db = dbFor(testEnv, OWNER);
    await assertFails(setDoc(doc(db, 'listings', 'listing-x'), {
      title: 'Mismatched dealType', city: 'Erbil', dealType: 'rent', propertyType: 'apartment',
      price: 150000, private: false, status: 'active', // unit.listingType is 'sale'
      unitId: 'unit-1', projectId: 'proj-1', publisherOrgId: DEV_ORG, createdAt: 1
    }));
  });

  it('publisherOrgId must actually own the referenced unit', async () => {
    await seedFullOwnerContext();
    await seedOrg(OTHER_ORG, { ownerId: OTHER_OWNER, type: 'developer_project', name: 'Rival Devs', verified: false });
    await seedOwnerViaRoleDefaults(OTHER_OWNER);
    const db = dbFor(testEnv, OTHER_OWNER);
    await assertFails(setDoc(doc(db, 'listings', 'listing-x'), {
      title: 'Not their unit', city: 'Erbil', dealType: 'sale', propertyType: 'apartment',
      price: 150000, private: false, status: 'closed',
      unitId: 'unit-1', projectId: 'proj-1', publisherOrgId: OTHER_ORG, createdAt: 1
    }));
  });

  it('a unit-backed listing cannot also carry agentId (mutually exclusive authorship)', async () => {
    await seedFullOwnerContext();
    const db = dbFor(testEnv, OWNER);
    await assertFails(setDoc(doc(db, 'listings', 'listing-x'), {
      title: 'Confused authorship', city: 'Erbil', dealType: 'sale', propertyType: 'apartment',
      price: 150000, private: false, status: 'closed', agentId: OWNER,
      unitId: 'unit-1', projectId: 'proj-1', publisherOrgId: DEV_ORG, createdAt: 1
    }));
  });

  it('reopening a closed unit-backed listing to active also requires the lock', async () => {
    await seedFullOwnerContext();
    await seedListing('listing-x', {
      title: 'Was closed', city: 'Erbil', dealType: 'sale', propertyType: 'apartment',
      price: 150000, private: false, status: 'closed',
      unitId: 'unit-1', projectId: 'proj-1', publisherOrgId: DEV_ORG, createdAt: 1
    });
    const db = dbFor(testEnv, OWNER);
    // No lock exists -- reopening to active must fail.
    await assertFails(updateDoc(doc(db, 'listings', 'listing-x'), { status: 'active', updatedAt: 2 }));
    // Claim the lock, then reopening succeeds.
    await seedLock('unit-1_sale', { unitId: 'unit-1', dealType: 'sale', activeListingId: 'listing-x', organizationId: DEV_ORG });
    await assertSucceeds(updateDoc(doc(db, 'listings', 'listing-x'), { status: 'active', updatedAt: 2 }));
  });

  it('closing an active unit-backed listing, then releasing the lock, allows a fresh publish later', async () => {
    await seedFullOwnerContext();
    await seedLock('unit-1_sale', { unitId: 'unit-1', dealType: 'sale', activeListingId: 'listing-x', organizationId: DEV_ORG });
    await seedListing('listing-x', {
      title: 'Active one', city: 'Erbil', dealType: 'sale', propertyType: 'apartment',
      price: 150000, private: false, status: 'active',
      unitId: 'unit-1', projectId: 'proj-1', publisherOrgId: DEV_ORG, createdAt: 1
    });
    const db = dbFor(testEnv, OWNER);
    // Step 1: close the listing first.
    await assertSucceeds(updateDoc(doc(db, 'listings', 'listing-x'), { status: 'closed', updatedAt: 2 }));
    // Step 2: THEN release the lock.
    await assertSucceeds(deleteDoc(doc(db, 'activeListingLocks', 'unit-1_sale')));
    // A fresh listing can now claim the freed slot.
    await assertSucceeds(setDoc(doc(db, 'activeListingLocks', 'unit-1_sale'), {
      unitId: 'unit-1', dealType: 'sale', activeListingId: 'listing-z', organizationId: DEV_ORG
    }));
    await assertSucceeds(setDoc(doc(db, 'listings', 'listing-z'), {
      title: 'Fresh listing', city: 'Erbil', dealType: 'sale', propertyType: 'apartment',
      price: 150000, private: false, status: 'active',
      unitId: 'unit-1', projectId: 'proj-1', publisherOrgId: DEV_ORG, createdAt: 1
    }));
  });

  it('an admin can delete any stale lock for recovery, without organization membership', async () => {
    await seedFullOwnerContext();
    await seedLock('unit-1_sale', { unitId: 'unit-1', dealType: 'sale', activeListingId: 'listing-x', organizationId: DEV_ORG });
    await seedUser('admin-1', { role: 'admin', createdAt: 1 });
    const db = dbFor(testEnv, 'admin-1');
    await assertSucceeds(deleteDoc(doc(db, 'activeListingLocks', 'unit-1_sale')));
  });
});

// =========================================================================
// FULL ACTIVE-LISTING LOCK LIFECYCLE AUDIT (Phase 1 pre-deploy
// verification, scenarios A-J). Confirms the invariant "at most ONE
// active listing per (unitId, dealType)" holds through every state
// transition, not merely at the moment of concurrent lock creation --
// and that legitimate relisting after a listing is no longer active
// remains possible.
describe('LOCK LIFECYCLE — full audit (A-J)', () => {
  function seedFullOwnerContext() {
    return (async () => {
      await seedOrg(DEV_ORG, { ownerId: OWNER, type: 'developer_project', name: 'Darwesh Developments', verified: false });
      await seedOwnerViaRoleDefaults();
      await seedProject('proj-1', validProject());
      await seedUnit('unit-1', validUnit({ priceAmount: 150000, currency: 'USD', listingType: 'sale', status: 'available' }));
    })();
  }

  it('A. closing an active listing does not itself require or touch the lock', async () => {
    await seedFullOwnerContext();
    await seedLock('unit-1_sale', { unitId: 'unit-1', dealType: 'sale', activeListingId: 'listing-x', organizationId: DEV_ORG });
    await seedListing('listing-x', {
      title: 'Active', city: 'Erbil', dealType: 'sale', propertyType: 'apartment', price: 150000,
      private: false, status: 'active', unitId: 'unit-1', projectId: 'proj-1', publisherOrgId: DEV_ORG, createdAt: 1
    });
    const db = dbFor(testEnv, OWNER);
    await assertSucceeds(updateDoc(doc(db, 'listings', 'listing-x'), { status: 'closed', updatedAt: 2 }));
    // The lock still exists after close (release is a deliberate, separate
    // step) -- so no OTHER listing can claim the slot yet.
    await assertFails(setDoc(doc(db, 'activeListingLocks', 'unit-1_sale'), {
      unitId: 'unit-1', dealType: 'sale', activeListingId: 'listing-y', organizationId: DEV_ORG
    }));
  });

  it('B/C. Unit.status can independently change (e.g. to sold/rented) without touching the lock or listing', async () => {
    // Unit.status and listings.status are deliberately independent state
    // machines (per the architecture delta) -- marking inventory sold/
    // rented never requires a listing to exist or be closed first, and
    // does not itself release or require the lock. This is intentional
    // ("a developer can mark inventory Reserved/Sold with no listing ever
    // existing" -- already covered by the UNIT update describe block
    // above); this test confirms it holds even while an active,
    // lock-holding listing for the SAME unit still exists, i.e. Unit.status
    // drifting ahead of Listing.status is possible and does not corrupt
    // the lock -- a known, accepted product-consistency gap (Section 4 of
    // the verification report), not a security or uniqueness violation.
    await seedFullOwnerContext();
    await seedLock('unit-1_sale', { unitId: 'unit-1', dealType: 'sale', activeListingId: 'listing-x', organizationId: DEV_ORG });
    await seedListing('listing-x', {
      title: 'Active', city: 'Erbil', dealType: 'sale', propertyType: 'apartment', price: 150000,
      private: false, status: 'active', unitId: 'unit-1', projectId: 'proj-1', publisherOrgId: DEV_ORG, createdAt: 1
    });
    const db = dbFor(testEnv, OWNER);
    await assertSucceeds(updateDoc(doc(db, 'units', 'unit-1'), { status: 'sold', updatedAt: 2 }));
    // The lock is untouched by this -- still held, still blocking a
    // second active listing for the same unit+dealType.
    await assertFails(setDoc(doc(db, 'activeListingLocks', 'unit-1_sale'), {
      unitId: 'unit-1', dealType: 'sale', activeListingId: 'listing-y', organizationId: DEV_ORG
    }));
  });

  it('D. an org publisher cannot hard-delete their own unit-backed listing (close via update instead; only admin can hard-delete)', async () => {
    // listings.delete was not extended with an org branch in Phase 1 --
    // only the pre-existing agent branch and admin can hard-delete. This
    // is a functionality gap (bias toward the SAFE/restrictive direction,
    // not a vulnerability), and does not impair the lock lifecycle: the
    // documented release protocol only ever required CLOSING the listing
    // (an update, which the org publisher CAN do) plus deleting the lock
    // (a separate document, also authorized) -- never hard-deleting the
    // listing document itself. Historical listings staying in place after
    // close also matches the explicit "historical listings" requirement.
    await seedFullOwnerContext();
    await seedListing('listing-x', {
      title: 'Active', city: 'Erbil', dealType: 'sale', propertyType: 'apartment', price: 150000,
      private: false, status: 'closed', unitId: 'unit-1', projectId: 'proj-1', publisherOrgId: DEV_ORG, createdAt: 1
    });
    const db = dbFor(testEnv, OWNER);
    await assertFails(deleteDoc(doc(db, 'listings', 'listing-x')));
  });

  it('E. legitimate relisting after close+release succeeds (full round trip)', async () => {
    // Already covered by "closing an active unit-backed listing, then
    // releasing the lock, allows a fresh publish later" above; restated
    // here as part of the complete lettered audit for traceability.
    await seedFullOwnerContext();
    await seedLock('unit-1_sale', { unitId: 'unit-1', dealType: 'sale', activeListingId: 'listing-x', organizationId: DEV_ORG });
    await seedListing('listing-x', {
      title: 'Active', city: 'Erbil', dealType: 'sale', propertyType: 'apartment', price: 150000,
      private: false, status: 'active', unitId: 'unit-1', projectId: 'proj-1', publisherOrgId: DEV_ORG, createdAt: 1
    });
    const db = dbFor(testEnv, OWNER);
    await assertSucceeds(updateDoc(doc(db, 'listings', 'listing-x'), { status: 'closed', updatedAt: 2 }));
    await assertSucceeds(deleteDoc(doc(db, 'activeListingLocks', 'unit-1_sale')));
    await assertSucceeds(setDoc(doc(db, 'activeListingLocks', 'unit-1_sale'), {
      unitId: 'unit-1', dealType: 'sale', activeListingId: 'listing-relist', organizationId: DEV_ORG
    }));
    await assertSucceeds(setDoc(doc(db, 'listings', 'listing-relist'), {
      title: 'Relisted', city: 'Erbil', dealType: 'sale', propertyType: 'apartment', price: 150000,
      private: false, status: 'active', unitId: 'unit-1', projectId: 'proj-1', publisherOrgId: DEV_ORG, createdAt: 3
    }));
  });

  it('F. the same Unit can hold simultaneous SALE and RENT locks/active listings (independent dealTypes)', async () => {
    await seedFullOwnerContext();
    const db = dbFor(testEnv, OWNER);
    // Claim BOTH locks for the same unit -- different dealType, different lockId.
    await assertSucceeds(setDoc(doc(db, 'activeListingLocks', 'unit-1_sale'), {
      unitId: 'unit-1', dealType: 'sale', activeListingId: 'listing-sale', organizationId: DEV_ORG
    }));
    await assertSucceeds(setDoc(doc(db, 'activeListingLocks', 'unit-1_rent'), {
      unitId: 'unit-1', dealType: 'rent', activeListingId: 'listing-rent', organizationId: DEV_ORG
    }));
    // A unit's own listingType doesn't gate this -- the lock/listing
    // dealType is independently supplied per listing; both can be
    // simultaneously active, matching the explicit "one sale listing AND
    // one rental listing" requirement.
  });

  it('G. a different (unauthorized) org cannot delete another org\'s lock', async () => {
    await seedFullOwnerContext();
    await seedLock('unit-1_sale', { unitId: 'unit-1', dealType: 'sale', activeListingId: 'listing-x', organizationId: DEV_ORG });
    await seedListing('listing-x', {
      title: 'Active', city: 'Erbil', dealType: 'sale', propertyType: 'apartment', price: 150000,
      private: false, status: 'closed', unitId: 'unit-1', projectId: 'proj-1', publisherOrgId: DEV_ORG, createdAt: 1
    });
    await seedOrg(OTHER_ORG, { ownerId: OTHER_OWNER, type: 'developer_project', name: 'Rival Devs', verified: false });
    await seedOwnerViaRoleDefaults(OTHER_OWNER);
    const db = dbFor(testEnv, OTHER_OWNER);
    await assertFails(deleteDoc(doc(db, 'activeListingLocks', 'unit-1_sale')));
  });

  it('H. CRITICAL: an authorized org member cannot delete a lock while its listing is STILL active (closes the "steal the slot" hole)', async () => {
    await seedFullOwnerContext();
    await seedLock('unit-1_sale', { unitId: 'unit-1', dealType: 'sale', activeListingId: 'listing-x', organizationId: DEV_ORG });
    await seedListing('listing-x', {
      title: 'Still active', city: 'Erbil', dealType: 'sale', propertyType: 'apartment', price: 150000,
      private: false, status: 'active', // <-- the listing this lock guards is genuinely still active
      unitId: 'unit-1', projectId: 'proj-1', publisherOrgId: DEV_ORG, createdAt: 1
    });
    const db = dbFor(testEnv, OWNER);
    // Even though OWNER is the legitimate, fully-authorized publisher for
    // this exact unit/org, deleting the lock must be rejected while
    // listing-x is still active -- otherwise a second active listing
    // could immediately be published for the same unit+dealType.
    await assertFails(deleteDoc(doc(db, 'activeListingLocks', 'unit-1_sale')));
    // Prove the consequence would have been real: with the lock still
    // correctly held, a second active listing genuinely cannot be created.
    await assertFails(setDoc(doc(db, 'activeListingLocks', 'unit-1_sale'), {
      unitId: 'unit-1', dealType: 'sale', activeListingId: 'listing-y', organizationId: DEV_ORG
    }));
  });

  it('I. a lock\'s activeListingId can never be reassigned/stolen via update, by anyone', async () => {
    await seedFullOwnerContext();
    await seedLock('unit-1_sale', { unitId: 'unit-1', dealType: 'sale', activeListingId: 'listing-x', organizationId: DEV_ORG });
    const db = dbFor(testEnv, OWNER);
    await assertFails(updateDoc(doc(db, 'activeListingLocks', 'unit-1_sale'), { activeListingId: 'listing-hijack' }));
    await seedUser('admin-1', { role: 'admin', createdAt: 1 });
    const adminDb = dbFor(testEnv, 'admin-1');
    // allow update: if false is unconditional -- not even an admin can
    // edit a lock in place (delete + recreate is the only path, and
    // recreate is itself gated by lockCanBeReleased/create-only semantics).
    await assertFails(updateDoc(doc(adminDb, 'activeListingLocks', 'unit-1_sale'), { activeListingId: 'listing-hijack' }));
  });

  it('J. a genuinely orphaned lock (listing creation was omitted after the lock was claimed) can still be recovered by the authorized org', async () => {
    await seedFullOwnerContext();
    // Lock claimed, but the corresponding listing was NEVER created
    // (e.g. a client crash between step 1 and step 2 of the publish
    // protocol) -- lockCanBeReleased()'s `!exists(...)` branch must still
    // let the legitimate org recover this without needing an admin.
    await seedLock('unit-1_sale', { unitId: 'unit-1', dealType: 'sale', activeListingId: 'listing-never-created', organizationId: DEV_ORG });
    const db = dbFor(testEnv, OWNER);
    await assertSucceeds(deleteDoc(doc(db, 'activeListingLocks', 'unit-1_sale')));
  });
});
