// Phase 2.1 Firestore Rules regression tests: org-scoped permission
// reconciliation (hasOrgPermission()/orgMemberPermissions()) and the
// isOrgMember() status-check fix. Run with `npm run test:rules`.
//
// Context: Phase 2 built organizations/{orgId}/members/{uid}.permissions
// (via the backend's update_member_permissions) but nothing in
// firestore.rules ever consulted it -- an org owner's grant to a
// specific employee was recorded and silently ignored at write time.
// Phase 2.1 fixes that (products' create/update/delete now check
// hasOrgPermission() instead of the bare global hasPermission()) and
// fixes a related gap this work surfaced: isOrgMember() previously
// returned true for ANY member doc, including a still-'pending'
// self-request or a not-yet-accepted 'invited' record, letting a mere
// applicant pass the org-membership gate before ever being approved.
import { before, after, beforeEach, describe, it } from 'node:test';
import { assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { doc, setDoc, updateDoc } from 'firebase/firestore';
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

async function seedProduct(productId, data) {
  await seed(testEnv, async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'products', productId), data);
  });
}

const OWNER = 'owner-uid';
const EMPLOYEE = 'employee-uid';

describe('isOrgMember() requires an ACTIVE membership record', () => {
  it('a PENDING (self-requested, not yet approved) member does not satisfy the membership gate', async () => {
    await seedOrg('org1', { ownerId: OWNER, type: 'furniture_store', name: 'Store', verified: false });
    await seedOrgMember('org1', EMPLOYEE, { role: 'employee', status: 'pending', permissions: { create_product: true } });
    await seedUser(EMPLOYEE, { role: 'customer', createdAt: 'x' }); // no accountType/global permission
    const db = dbFor(testEnv, EMPLOYEE);
    await assertFails(setDoc(doc(db, 'products', 'p1'), {
      sellerId: 'org1', name: 'Sofa', status: 'available', price: 100,
    }));
  });

  it('an INVITED (not yet accepted) member does not satisfy the membership gate', async () => {
    await seedOrg('org2', { ownerId: OWNER, type: 'furniture_store', name: 'Store', verified: false });
    await seedOrgMember('org2', EMPLOYEE, { role: 'employee', status: 'invited', permissions: { create_product: true } });
    await seedUser(EMPLOYEE, { role: 'customer', createdAt: 'x' });
    const db = dbFor(testEnv, EMPLOYEE);
    await assertFails(setDoc(doc(db, 'products', 'p2'), {
      sellerId: 'org2', name: 'Sofa', status: 'available', price: 100,
    }));
  });

  it('an ACTIVE member satisfies the membership gate', async () => {
    await seedOrg('org3', { ownerId: OWNER, type: 'furniture_store', name: 'Store', verified: false });
    await seedOrgMember('org3', EMPLOYEE, { role: 'employee', status: 'active', permissions: { create_product: true } });
    await seedUser(EMPLOYEE, { role: 'customer', createdAt: 'x' });
    const db = dbFor(testEnv, EMPLOYEE);
    await assertSucceeds(setDoc(doc(db, 'products', 'p3'), {
      sellerId: 'org3', name: 'Sofa', status: 'available', price: 100,
    }));
  });
});

describe('hasOrgPermission(): org-scoped grant reconciliation', () => {
  it('an active member with NEITHER a global NOR an org-scoped grant is denied', async () => {
    await seedOrg('org4', { ownerId: OWNER, type: 'furniture_store', name: 'Store', verified: false });
    await seedOrgMember('org4', EMPLOYEE, { role: 'employee', status: 'active', permissions: {} });
    await seedUser(EMPLOYEE, { role: 'customer', createdAt: 'x' });
    const db = dbFor(testEnv, EMPLOYEE);
    await assertFails(setDoc(doc(db, 'products', 'p4'), {
      sellerId: 'org4', name: 'Sofa', status: 'available', price: 100,
    }));
  });

  it('an org-scoped grant alone (no global permission) is sufficient', async () => {
    await seedOrg('org5', { ownerId: OWNER, type: 'furniture_store', name: 'Store', verified: false });
    await seedOrgMember('org5', EMPLOYEE, { role: 'employee', status: 'active', permissions: { create_product: true } });
    await seedUser(EMPLOYEE, { role: 'customer', createdAt: 'x' }); // no accountType at all
    const db = dbFor(testEnv, EMPLOYEE);
    await assertSucceeds(setDoc(doc(db, 'products', 'p5'), {
      sellerId: 'org5', name: 'Sofa', status: 'available', price: 100,
    }));
  });

  it('a global (accountType-level) grant alone is still sufficient (union, not a narrowing)', async () => {
    await seedOrg('org6', { ownerId: OWNER, type: 'furniture_store', name: 'Store', verified: false });
    await seedOrgMember('org6', EMPLOYEE, { role: 'employee', status: 'active', permissions: {} }); // no org-scoped grant
    await seedRoleDefaults('professional_engineer', { create_product: true });
    await seedUser(EMPLOYEE, { role: 'customer', accountType: 'professional_engineer', createdAt: 'x' });
    const db = dbFor(testEnv, EMPLOYEE);
    await assertSucceeds(setDoc(doc(db, 'products', 'p6'), {
      sellerId: 'org6', name: 'Sofa', status: 'available', price: 100,
    }));
  });

  it('an org-scoped grant in Org A does not apply when acting on Org B (no cross-org bleed)', async () => {
    await seedOrg('org7-a', { ownerId: OWNER, type: 'furniture_store', name: 'Store A', verified: false });
    await seedOrg('org7-b', { ownerId: 'owner-b', type: 'furniture_store', name: 'Store B', verified: false });
    await seedOrgMember('org7-a', EMPLOYEE, { role: 'employee', status: 'active', permissions: { create_product: true } });
    await seedUser(EMPLOYEE, { role: 'customer', createdAt: 'x' });
    const db = dbFor(testEnv, EMPLOYEE);
    // EMPLOYEE has create_product in org7-a but is not a member of org7-b at all
    await assertFails(setDoc(doc(db, 'products', 'p7'), {
      sellerId: 'org7-b', name: 'Sofa', status: 'available', price: 100,
    }));
  });

  it('a protected key force-seeded into an org member permissions map never becomes usable', async () => {
    await seedOrg('org8', { ownerId: OWNER, type: 'furniture_store', name: 'Store', verified: false });
    // Simulates a hypothetical bug elsewhere writing a protected key
    // into this map -- update_member_permissions itself already
    // rejects this (Phase 2), this proves the RULES layer is
    // independently defensive too, same reasoning as the Phase 1
    // "protected key never resolves" tests for hasPermission().
    await seedOrgMember('org8', EMPLOYEE, { role: 'employee', status: 'active', permissions: { admin_access: true } });
    await seedUser(EMPLOYEE, { role: 'customer', createdAt: 'x' });
    const db = dbFor(testEnv, EMPLOYEE);
    await assertFails(setDoc(doc(db, 'products', 'p8'), {
      sellerId: 'org8', name: 'Sofa', status: 'available', price: 100,
    }));
  });

  it('the org owner needs no member doc at all -- their own global grant covers their own store', async () => {
    await seedOrg('org9', { ownerId: OWNER, type: 'furniture_store', name: 'Store', verified: false });
    await seedRoleDefaults('org_owner_furniture_store', { create_product: true });
    await seedUser(OWNER, { role: 'customer', accountType: 'org_owner_furniture_store', createdAt: 'x' });
    const db = dbFor(testEnv, OWNER);
    await assertSucceeds(setDoc(doc(db, 'products', 'p9'), {
      sellerId: 'org9', name: 'Sofa', status: 'available', price: 100,
    }));
  });

  it('update: an active member with an org-scoped edit_own_product grant can edit the store\'s product', async () => {
    await seedOrg('org10', { ownerId: OWNER, type: 'furniture_store', name: 'Store', verified: false });
    await seedOrgMember('org10', EMPLOYEE, { role: 'employee', status: 'active', permissions: { edit_own_product: true } });
    await seedUser(EMPLOYEE, { role: 'customer', createdAt: 'x' });
    await seedProduct('p10', { sellerId: 'org10', name: 'Sofa', status: 'available', price: 100 });
    const db = dbFor(testEnv, EMPLOYEE);
    await assertSucceeds(updateDoc(doc(db, 'products', 'p10'), { price: 150 }));
  });

  it('update: an active member WITHOUT edit_own_product (org-scoped or global) is denied', async () => {
    await seedOrg('org11', { ownerId: OWNER, type: 'furniture_store', name: 'Store', verified: false });
    await seedOrgMember('org11', EMPLOYEE, { role: 'employee', status: 'active', permissions: { create_product: true } });
    await seedUser(EMPLOYEE, { role: 'customer', createdAt: 'x' });
    await seedProduct('p11', { sellerId: 'org11', name: 'Sofa', status: 'available', price: 100 });
    const db = dbFor(testEnv, EMPLOYEE);
    await assertFails(updateDoc(doc(db, 'products', 'p11'), { price: 150 }));
  });
});
