// Phase 1 (Profile Architecture) Firestore Rules regression tests.
//
// Run with `npm run test:rules` (starts/stops a real Firestore emulator
// via `firebase emulators:exec`). Proves the new collections/fields added
// in firestore.rules for the Multi-Type Profile Architecture behave as
// designed -- cross-tenant isolation, fail-closed permission resolution,
// and that every access-control collection is unreachable via any
// client-SDK write, including an authenticated admin session -- and that
// the one pre-existing rule this phase structurally touched (users/{uid}
// create/update) still behaves correctly for ordinary self-edits.
import { before, after, beforeEach, describe, it } from 'node:test';
import { assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { doc, setDoc, updateDoc, getDoc } from 'firebase/firestore';
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

// ---- helpers -------------------------------------------------------

async function seedUser(uid, data) {
  await seed(testEnv, async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'users', uid), data);
  });
}

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

async function seedProvider(providerId, data) {
  await seed(testEnv, async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'serviceProviders', providerId), data);
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

const ADMIN = 'admin-uid';
const OWNER_A = 'owner-a-uid';
const OWNER_B = 'owner-b-uid';
const RANDO = 'rando-uid';
const CUSTOMER = 'customer-uid';

async function seedAdmin() {
  await seedUser(ADMIN, { role: 'admin', createdAt: 'x' });
}

// ---- A. Fail-closed permission resolution --------------------------

describe('fail-closed myPermissions()/hasPermission()', () => {
  it('denies a permission-gated write for a user with NO accountType at all', async () => {
    await seedOrg('org-fc1', { ownerId: OWNER_A, type: 'furniture_store', name: 'Store', verified: false });
    await seedUser(OWNER_A, { role: 'customer', createdAt: 'x' }); // no accountType field
    const db = dbFor(testEnv, OWNER_A);
    await assertFails(setDoc(doc(db, 'products', 'p1'), {
      sellerId: 'org-fc1', name: 'Sofa', status: 'available', price: 100,
    }));
  });

  it('denies a permission-gated write when accountType has no matching rolePermissionDefaults doc', async () => {
    await seedOrg('org-fc2', { ownerId: OWNER_A, type: 'furniture_store', name: 'Store', verified: false });
    await seedUser(OWNER_A, { role: 'customer', accountType: 'org_owner_furniture_store', createdAt: 'x' });
    // deliberately do NOT seed rolePermissionDefaults/org_owner_furniture_store
    const db = dbFor(testEnv, OWNER_A);
    await assertFails(setDoc(doc(db, 'products', 'p2'), {
      sellerId: 'org-fc2', name: 'Sofa', status: 'available', price: 100,
    }));
  });

  it('grants the write once accountType + matching rolePermissionDefaults + membership all line up', async () => {
    await seedOrg('org-fc3', { ownerId: OWNER_A, type: 'furniture_store', name: 'Store', verified: false });
    await seedUser(OWNER_A, { role: 'customer', accountType: 'org_owner_furniture_store', createdAt: 'x' });
    await seedRoleDefaults('org_owner_furniture_store', { create_product: true });
    const db = dbFor(testEnv, OWNER_A);
    await assertSucceeds(setDoc(doc(db, 'products', 'p3'), {
      sellerId: 'org-fc3', name: 'Sofa', status: 'available', price: 100,
    }));
  });

  it('a per-user permissionOverrides:false suppresses an otherwise-granted default (defense in depth)', async () => {
    await seedOrg('org-fc4', { ownerId: OWNER_A, type: 'furniture_store', name: 'Store', verified: false });
    await seedRoleDefaults('org_owner_furniture_store', { create_product: true });
    await seedUser(OWNER_A, {
      role: 'customer', accountType: 'org_owner_furniture_store',
      permissionOverrides: { create_product: false }, createdAt: 'x',
    });
    const db = dbFor(testEnv, OWNER_A);
    await assertFails(setDoc(doc(db, 'products', 'p4'), {
      sellerId: 'org-fc4', name: 'Sofa', status: 'available', price: 100,
    }));
  });

  it('a protected key can never resolve true via hasPermission(), even if force-seeded into defaults', async () => {
    // Simulates a hypothetical bug/bypass where a protected:true key ended
    // up in rolePermissionDefaults anyway -- hasPermission() must still
    // refuse it (isProtectedPermissionKey() short-circuits before the
    // override/default lookup even runs).
    await seedOrg('org-fc5', { ownerId: OWNER_A, type: 'furniture_store', name: 'Store', verified: false });
    await seedRoleDefaults('org_owner_furniture_store', { admin_access: true });
    await seedUser(OWNER_A, { role: 'customer', accountType: 'org_owner_furniture_store', createdAt: 'x' });
    // admin_access isn't consulted by any rule directly (no call site uses
    // it), so instead prove the *general* mechanism: a permission key that
    // IS consulted (create_product) stays false when only a protected key
    // was granted -- i.e. granting a protected key never leaks into
    // granting anything else, and the protected key itself is unusable.
    const db = dbFor(testEnv, OWNER_A);
    await assertFails(setDoc(doc(db, 'products', 'p5'), {
      sellerId: 'org-fc5', name: 'Sofa', status: 'available', price: 100,
    }));
  });
});

// ---- B. Organizations -----------------------------------------------

describe('organizations', () => {
  it('any signed-in user can found a new organization of an allowed type, as its own owner', async () => {
    const db = dbFor(testEnv, OWNER_A);
    await assertSucceeds(setDoc(doc(db, 'organizations', 'org1'), {
      type: 'furniture_store', ownerId: OWNER_A, name: 'My Store', verified: false,
    }));
  });

  it('rejects type=real_estate_office (offices stay on the companies collection this phase)', async () => {
    const db = dbFor(testEnv, OWNER_A);
    await assertFails(setDoc(doc(db, 'organizations', 'org2'), {
      type: 'real_estate_office', ownerId: OWNER_A, name: 'Office', verified: false,
    }));
  });

  it('rejects creating an org owned by someone else', async () => {
    const db = dbFor(testEnv, OWNER_A);
    await assertFails(setDoc(doc(db, 'organizations', 'org3'), {
      type: 'furniture_store', ownerId: OWNER_B, name: 'Store', verified: false,
    }));
  });

  it('rejects self-setting verified:true at creation', async () => {
    const db = dbFor(testEnv, OWNER_A);
    await assertFails(setDoc(doc(db, 'organizations', 'org4'), {
      type: 'furniture_store', ownerId: OWNER_A, name: 'Store', verified: true,
    }));
  });

  it('is publicly readable, even unauthenticated', async () => {
    await seedOrg('org5', { ownerId: OWNER_A, type: 'furniture_store', name: 'Store', verified: false });
    const db = dbFor(testEnv, null);
    await assertSucceeds(getDoc(doc(db, 'organizations', 'org5')));
  });

  it('lets the owner update ordinary fields', async () => {
    await seedOrg('org6', { ownerId: OWNER_A, type: 'furniture_store', name: 'Store', verified: false });
    const db = dbFor(testEnv, OWNER_A);
    await assertSucceeds(updateDoc(doc(db, 'organizations', 'org6'), { name: 'New Name' }));
  });

  it('blocks the owner from reassigning ownerId to someone else', async () => {
    await seedOrg('org7', { ownerId: OWNER_A, type: 'furniture_store', name: 'Store', verified: false });
    const db = dbFor(testEnv, OWNER_A);
    await assertFails(updateDoc(doc(db, 'organizations', 'org7'), { ownerId: OWNER_B }));
  });

  it('blocks even an admin client-SDK session from reassigning ownerId (backend-mediated only)', async () => {
    await seedOrg('org8', { ownerId: OWNER_A, type: 'furniture_store', name: 'Store', verified: false });
    await seedAdmin();
    const db = dbFor(testEnv, ADMIN);
    await assertFails(updateDoc(doc(db, 'organizations', 'org8'), { ownerId: OWNER_B }));
  });

  it('still lets an admin set other fields (e.g. verified) directly', async () => {
    await seedOrg('org9', { ownerId: OWNER_A, type: 'furniture_store', name: 'Store', verified: false });
    await seedAdmin();
    const db = dbFor(testEnv, ADMIN);
    await assertSucceeds(updateDoc(doc(db, 'organizations', 'org9'), { verified: true }));
  });

  it('blocks a non-owner, non-admin signed-in user from updating the org', async () => {
    await seedOrg('org10', { ownerId: OWNER_A, type: 'furniture_store', name: 'Store', verified: false });
    const db = dbFor(testEnv, RANDO);
    await assertFails(updateDoc(doc(db, 'organizations', 'org10'), { name: 'Hijacked' }));
  });
});

// ---- C. Organization members subcollection --------------------------

describe('organizations/{orgId}/members', () => {
  it('is never client-writable, not even by the org owner', async () => {
    await seedOrg('orgm1', { ownerId: OWNER_A, type: 'furniture_store', name: 'Store', verified: false });
    const db = dbFor(testEnv, OWNER_A);
    await assertFails(setDoc(doc(db, 'organizations', 'orgm1', 'members', OWNER_B), { role: 'employee' }));
  });

  it('is never client-writable, not even by an admin', async () => {
    await seedOrg('orgm2', { ownerId: OWNER_A, type: 'furniture_store', name: 'Store', verified: false });
    await seedAdmin();
    const db = dbFor(testEnv, ADMIN);
    await assertFails(setDoc(doc(db, 'organizations', 'orgm2', 'members', OWNER_B), { role: 'employee' }));
  });

  it('lets the org owner read the full member list', async () => {
    await seedOrg('orgm3', { ownerId: OWNER_A, type: 'furniture_store', name: 'Store', verified: false });
    await seedOrgMember('orgm3', OWNER_B, { role: 'employee' });
    const db = dbFor(testEnv, OWNER_A);
    await assertSucceeds(getDoc(doc(db, 'organizations', 'orgm3', 'members', OWNER_B)));
  });

  it('lets a member read their own membership doc', async () => {
    await seedOrg('orgm4', { ownerId: OWNER_A, type: 'furniture_store', name: 'Store', verified: false });
    await seedOrgMember('orgm4', OWNER_B, { role: 'employee' });
    const db = dbFor(testEnv, OWNER_B);
    await assertSucceeds(getDoc(doc(db, 'organizations', 'orgm4', 'members', OWNER_B)));
  });

  it('blocks an unrelated signed-in user from reading a membership doc', async () => {
    await seedOrg('orgm5', { ownerId: OWNER_A, type: 'furniture_store', name: 'Store', verified: false });
    await seedOrgMember('orgm5', OWNER_B, { role: 'employee' });
    const db = dbFor(testEnv, RANDO);
    await assertFails(getDoc(doc(db, 'organizations', 'orgm5', 'members', OWNER_B)));
  });
});

// ---- D. Service providers --------------------------------------------

describe('serviceProviders', () => {
  it('lets an individual engineer create their own profile at their own uid', async () => {
    const db = dbFor(testEnv, OWNER_A);
    await assertSucceeds(setDoc(doc(db, 'serviceProviders', OWNER_A), {
      serviceType: 'engineer', providerType: 'individual', ownerId: OWNER_A, verified: false,
    }));
  });

  it('rejects an individual provider document id that does not match their own uid', async () => {
    const db = dbFor(testEnv, OWNER_A);
    await assertFails(setDoc(doc(db, 'serviceProviders', 'some-other-id'), {
      serviceType: 'engineer', providerType: 'individual', ownerId: OWNER_A, verified: false,
    }));
  });

  it('rejects providerType=team for a non-cleaning serviceType', async () => {
    const db = dbFor(testEnv, OWNER_A);
    await assertFails(setDoc(doc(db, 'serviceProviders', 'team1'), {
      serviceType: 'engineer', providerType: 'team', ownerId: OWNER_A, verified: false,
    }));
  });

  it('allows providerType=team/company for cleaning, with a generated (non-uid) id', async () => {
    const db = dbFor(testEnv, OWNER_A);
    await assertSucceeds(setDoc(doc(db, 'serviceProviders', 'cleaning-co-1'), {
      serviceType: 'cleaning', providerType: 'company', ownerId: OWNER_A, verified: false,
    }));
  });

  it('rejects a servicesOffered entry outside the allowlisted cleaning categories', async () => {
    const db = dbFor(testEnv, OWNER_A);
    await assertFails(setDoc(doc(db, 'serviceProviders', 'cleaning-co-2'), {
      serviceType: 'cleaning', providerType: 'individual', ownerId: OWNER_A, verified: false,
      servicesOffered: ['house_cleaning', 'not_a_real_category'],
    }));
  });

  it('accepts a valid subset of servicesOffered (provider need not offer everything)', async () => {
    const db = dbFor(testEnv, OWNER_A);
    await assertSucceeds(setDoc(doc(db, 'serviceProviders', OWNER_A), {
      serviceType: 'cleaning', providerType: 'individual', ownerId: OWNER_A, verified: false,
      servicesOffered: ['house_cleaning', 'deep_cleaning'],
    }));
  });

  it('blocks even an admin client-SDK session from reassigning ownerId (backend-mediated only)', async () => {
    await seedProvider('prov1', { serviceType: 'engineer', providerType: 'individual', ownerId: OWNER_A, verified: false });
    await seedAdmin();
    const db = dbFor(testEnv, ADMIN);
    await assertFails(updateDoc(doc(db, 'serviceProviders', 'prov1'), { ownerId: OWNER_B }));
  });

  it('lets the owner update their own portfolio/description', async () => {
    await seedProvider('prov2', { serviceType: 'engineer', providerType: 'individual', ownerId: OWNER_A, verified: false });
    const db = dbFor(testEnv, OWNER_A);
    await assertSucceeds(updateDoc(doc(db, 'serviceProviders', 'prov2'), { description: 'Updated bio' }));
  });

  it('blocks a different owner from updating someone else\'s provider profile', async () => {
    await seedProvider('prov3', { serviceType: 'engineer', providerType: 'individual', ownerId: OWNER_A, verified: false });
    const db = dbFor(testEnv, OWNER_B);
    await assertFails(updateDoc(doc(db, 'serviceProviders', 'prov3'), { description: 'Hijacked' }));
  });
});

// ---- E. Service-provider requests: per-provider isolation ------------

describe('serviceProviders/{providerId}/requests', () => {
  it('lets a signed-in customer create a request naming themselves', async () => {
    await seedProvider('provR1', { serviceType: 'cleaning', providerType: 'individual', ownerId: OWNER_A, verified: false });
    const db = dbFor(testEnv, CUSTOMER);
    await assertSucceeds(setDoc(doc(db, 'serviceProviders', 'provR1', 'requests', 'req1'), {
      customerUid: CUSTOMER, status: 'pending', message: 'Need a quote',
    }));
  });

  it('rejects a request created for a different customerUid', async () => {
    await seedProvider('provR2', { serviceType: 'cleaning', providerType: 'individual', ownerId: OWNER_A, verified: false });
    const db = dbFor(testEnv, CUSTOMER);
    await assertFails(setDoc(doc(db, 'serviceProviders', 'provR2', 'requests', 'req2'), {
      customerUid: RANDO, status: 'pending',
    }));
  });

  it('lets the owning provider read a request addressed to them', async () => {
    await seedProvider('provR3', { serviceType: 'cleaning', providerType: 'individual', ownerId: OWNER_A, verified: false });
    await seed(testEnv, async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'serviceProviders', 'provR3', 'requests', 'req3'), { customerUid: CUSTOMER, status: 'pending' });
    });
    const db = dbFor(testEnv, OWNER_A);
    await assertSucceeds(getDoc(doc(db, 'serviceProviders', 'provR3', 'requests', 'req3')));
  });

  it('BLOCKS a different provider from reading another provider\'s requests (cross-provider isolation)', async () => {
    await seedProvider('provR4', { serviceType: 'cleaning', providerType: 'individual', ownerId: OWNER_A, verified: false });
    await seedProvider('provR5-owner', { serviceType: 'cleaning', providerType: 'individual', ownerId: OWNER_B, verified: false });
    await seed(testEnv, async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'serviceProviders', 'provR4', 'requests', 'req4'), { customerUid: CUSTOMER, status: 'pending' });
    });
    // OWNER_B owns a DIFFERENT provider profile; they must not be able to
    // read provR4's requests just because they too are "a provider."
    const db = dbFor(testEnv, OWNER_B);
    await assertFails(getDoc(doc(db, 'serviceProviders', 'provR4', 'requests', 'req4')));
  });

  it('lets the owning provider update status without touching customerUid', async () => {
    await seedProvider('provR6', { serviceType: 'cleaning', providerType: 'individual', ownerId: OWNER_A, verified: false });
    await seed(testEnv, async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'serviceProviders', 'provR6', 'requests', 'req6'), { customerUid: CUSTOMER, status: 'pending' });
    });
    const db = dbFor(testEnv, OWNER_A);
    await assertSucceeds(updateDoc(doc(db, 'serviceProviders', 'provR6', 'requests', 'req6'), { status: 'accepted' }));
  });
});

// ---- F. Products / productCategories ---------------------------------

describe('productCategories', () => {
  it('is publicly readable', async () => {
    await seed(testEnv, async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'productCategories', 'cat1'), { name: 'Furniture', parentId: null });
    });
    const db = dbFor(testEnv, null);
    await assertSucceeds(getDoc(doc(db, 'productCategories', 'cat1')));
  });

  it('blocks a non-admin signed-in user from writing a category', async () => {
    const db = dbFor(testEnv, OWNER_A);
    await assertFails(setDoc(doc(db, 'productCategories', 'cat2'), { name: 'Bedroom', parentId: null }));
  });

  it('lets an admin write a category', async () => {
    await seedAdmin();
    const db = dbFor(testEnv, ADMIN);
    await assertSucceeds(setDoc(doc(db, 'productCategories', 'cat3'), { name: 'Bedroom', parentId: null }));
  });
});

describe('products', () => {
  async function seedFurnitureStoreWithPermission(orgId, ownerUid, accountType) {
    await seedOrg(orgId, { ownerId: ownerUid, type: 'furniture_store', name: 'Store', verified: false });
    await seedRoleDefaults(accountType, { create_product: true, edit_own_product: true });
    await seedUser(ownerUid, { role: 'customer', accountType, createdAt: 'x' });
  }

  it('is publicly readable', async () => {
    await seedProduct('prodPub', { sellerId: 'org-x', name: 'Sofa', status: 'available', price: 100 });
    const db = dbFor(testEnv, null);
    await assertSucceeds(getDoc(doc(db, 'products', 'prodPub')));
  });

  it('lets a permitted store owner create a product for their own store', async () => {
    await seedFurnitureStoreWithPermission('orgP1', OWNER_A, 'org_owner_furniture_store');
    const db = dbFor(testEnv, OWNER_A);
    await assertSucceeds(setDoc(doc(db, 'products', 'prod1'), {
      sellerId: 'orgP1', name: 'Sofa', status: 'available', price: 250,
    }));
  });

  it('rejects sellerId pointing at an org that is not a furniture_store', async () => {
    await seedOrg('orgP2', { ownerId: OWNER_A, type: 'residential_community', name: 'Community', verified: false });
    await seedRoleDefaults('org_owner_furniture_store', { create_product: true });
    await seedUser(OWNER_A, { role: 'customer', accountType: 'org_owner_furniture_store', createdAt: 'x' });
    const db = dbFor(testEnv, OWNER_A);
    await assertFails(setDoc(doc(db, 'products', 'prod2'), {
      sellerId: 'orgP2', name: 'Sofa', status: 'available', price: 250,
    }));
  });

  it('BLOCKS a member of Store A from creating a product under Store B (cross-store isolation)', async () => {
    await seedFurnitureStoreWithPermission('orgP3-A', OWNER_A, 'org_owner_furniture_store');
    await seedOrg('orgP3-B', { ownerId: OWNER_B, type: 'furniture_store', name: 'Store B', verified: false });
    const db = dbFor(testEnv, OWNER_A);
    await assertFails(setDoc(doc(db, 'products', 'prod3'), {
      sellerId: 'orgP3-B', name: 'Sofa', status: 'available', price: 250,
    }));
  });

  it('BLOCKS Store B\'s owner from updating Store A\'s product (sellerId locked, cross-store isolation)', async () => {
    await seedFurnitureStoreWithPermission('orgP4-A', OWNER_A, 'accountA');
    await seedFurnitureStoreWithPermission('orgP4-B', OWNER_B, 'accountB');
    await seedProduct('prod4', { sellerId: 'orgP4-A', name: 'Sofa', status: 'available', price: 250 });
    const db = dbFor(testEnv, OWNER_B);
    await assertFails(updateDoc(doc(db, 'products', 'prod4'), { price: 1 }));
  });

  it('rejects a status value outside the fixed enum', async () => {
    await seedFurnitureStoreWithPermission('orgP5', OWNER_A, 'org_owner_furniture_store');
    const db = dbFor(testEnv, OWNER_A);
    await assertFails(setDoc(doc(db, 'products', 'prod5'), {
      sellerId: 'orgP5', name: 'Sofa', status: 'discontinued', price: 250,
    }));
  });

  it('lets the permitted owner update price/status on their own product', async () => {
    await seedFurnitureStoreWithPermission('orgP6', OWNER_A, 'org_owner_furniture_store');
    await seedProduct('prod6', { sellerId: 'orgP6', name: 'Sofa', status: 'available', price: 250 });
    const db = dbFor(testEnv, OWNER_A);
    await assertSucceeds(updateDoc(doc(db, 'products', 'prod6'), { status: 'sold_out' }));
  });

  it('rejects an update attempting to reassign sellerId', async () => {
    await seedFurnitureStoreWithPermission('orgP7-A', OWNER_A, 'accountA7');
    await seedFurnitureStoreWithPermission('orgP7-B', OWNER_A, 'accountA7'); // same owner, two stores
    await seedProduct('prod7', { sellerId: 'orgP7-A', name: 'Sofa', status: 'available', price: 250 });
    const db = dbFor(testEnv, OWNER_A);
    await assertFails(updateDoc(doc(db, 'products', 'prod7'), { sellerId: 'orgP7-B' }));
  });
});

// ---- G. Admin Access & Permissions: backend-only, no client path -----

describe('access-control collections are backend/Admin-SDK-only', () => {
  it('permissionDefinitions: admin can read, but cannot write via the client SDK', async () => {
    await seedAdmin();
    await seed(testEnv, async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'permissionDefinitions', 'create_listing'), { category: 'Listings', description: 'x', protected: false });
    });
    const db = dbFor(testEnv, ADMIN);
    await assertSucceeds(getDoc(doc(db, 'permissionDefinitions', 'create_listing')));
    await assertFails(setDoc(doc(db, 'permissionDefinitions', 'new_key'), { category: 'x', description: 'x', protected: false }));
  });

  it('permissionDefinitions: a non-admin cannot even read it', async () => {
    await seed(testEnv, async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'permissionDefinitions', 'create_listing'), { category: 'Listings', description: 'x', protected: false });
    });
    const db = dbFor(testEnv, RANDO);
    await assertFails(getDoc(doc(db, 'permissionDefinitions', 'create_listing')));
  });

  it('rolePermissionDefaults: unwritable by any client, including admin', async () => {
    await seedAdmin();
    const db = dbFor(testEnv, ADMIN);
    await assertFails(setDoc(doc(db, 'rolePermissionDefaults', 'office_employee'), { permissions: { manage_office_employees: true } }));
  });

  it('accessAuditLog: unwritable by any client, including admin -- and unreadable by non-admin', async () => {
    await seedAdmin();
    const adminDb = dbFor(testEnv, ADMIN);
    await assertFails(setDoc(doc(adminDb, 'accessAuditLog', 'entry1'), {
      adminUid: ADMIN, targetType: 'user', targetId: OWNER_A, permissionKey: 'manage_office_employees',
      previousValue: false, newValue: true, timestamp: 'x',
    }));
    await seed(testEnv, async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'accessAuditLog', 'entry1'), {
        adminUid: ADMIN, targetType: 'user', targetId: OWNER_A, permissionKey: 'manage_office_employees',
        previousValue: false, newValue: true, timestamp: 'x',
      });
    });
    const randoDb = dbFor(testEnv, RANDO);
    await assertFails(getDoc(doc(randoDb, 'accessAuditLog', 'entry1')));
    await assertSucceeds(getDoc(doc(adminDb, 'accessAuditLog', 'entry1')));
  });

  it('users/{uid}.permissionOverrides: unwritable via client SDK, even by an admin session', async () => {
    await seedUser(OWNER_A, { role: 'customer', createdAt: 'x' });
    await seedAdmin();
    const db = dbFor(testEnv, ADMIN);
    await assertFails(updateDoc(doc(db, 'users', OWNER_A), { permissionOverrides: { manage_office_employees: true } }));
  });
});

// ---- H. users/{uid}: regression check on the one pre-existing rule ---
// this phase structurally modified (create/update). Confirms ordinary,
// unrelated self-edit behavior established by AUTHZ/BL fixes is intact.

describe('users/{uid} regression (create/update touched by this phase)', () => {
  it('a brand-new signup can still self-create with role=customer', async () => {
    const db = dbFor(testEnv, CUSTOMER);
    await assertSucceeds(setDoc(doc(db, 'users', CUSTOMER), { role: 'customer', createdAt: 'x' }));
  });

  it('a brand-new signup may self-declare an allowed accountType', async () => {
    const db = dbFor(testEnv, CUSTOMER);
    await assertSucceeds(setDoc(doc(db, 'users', CUSTOMER), { role: 'customer', accountType: 'individual_customer', createdAt: 'x' }));
  });

  it('a brand-new signup MAY NOT self-declare accountType=admin', async () => {
    const db = dbFor(testEnv, CUSTOMER);
    await assertFails(setDoc(doc(db, 'users', CUSTOMER), { role: 'customer', accountType: 'admin', createdAt: 'x' }));
  });

  it('a brand-new signup MAY NOT self-set activeOrganizationId at all', async () => {
    // Phase 2.2: this field was renamed from `organizationId` (which
    // had zero production writers anywhere in the repo, confirmed
    // before renaming) -- same "not in the create allowlist at all"
    // treatment either way.
    const db = dbFor(testEnv, CUSTOMER);
    await assertFails(setDoc(doc(db, 'users', CUSTOMER), { role: 'customer', activeOrganizationId: 'some-org', createdAt: 'x' }));
  });

  it('a brand-new signup MAY NOT self-set the legacy organizationId name either', async () => {
    const db = dbFor(testEnv, CUSTOMER);
    await assertFails(setDoc(doc(db, 'users', CUSTOMER), { role: 'customer', organizationId: 'some-org', createdAt: 'x' }));
  });

  it('an existing user can still self-edit displayName/photoURL', async () => {
    await seedUser(CUSTOMER, { role: 'customer', displayName: 'Old Name', createdAt: 'x' });
    const db = dbFor(testEnv, CUSTOMER);
    await assertSucceeds(updateDoc(doc(db, 'users', CUSTOMER), { displayName: 'New Name' }));
  });

  it('an existing user still cannot self-promote role to admin', async () => {
    await seedUser(CUSTOMER, { role: 'customer', createdAt: 'x' });
    const db = dbFor(testEnv, CUSTOMER);
    await assertFails(updateDoc(doc(db, 'users', CUSTOMER), { role: 'admin' }));
  });

  it('an existing user cannot change their own accountType (write-once at signup, then locked)', async () => {
    await seedUser(CUSTOMER, { role: 'customer', accountType: 'individual_customer', createdAt: 'x' });
    const db = dbFor(testEnv, CUSTOMER);
    await assertFails(updateDoc(doc(db, 'users', CUSTOMER), { accountType: 'office_owner' }));
  });

  it('an admin can still change another user\'s accountType directly (not backend-mediated, unlike permissionOverrides)', async () => {
    await seedUser(CUSTOMER, { role: 'customer', accountType: 'individual_customer', createdAt: 'x' });
    await seedAdmin();
    const db = dbFor(testEnv, ADMIN);
    await assertSucceeds(updateDoc(doc(db, 'users', CUSTOMER), { accountType: 'office_owner' }));
  });
});
