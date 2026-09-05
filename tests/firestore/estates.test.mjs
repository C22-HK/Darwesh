// PRODUCTION REBUILD PHASE 1 OF 3 — Canonical Estate identity Firestore
// Rules regression tests: estates/{estateId} (+ protected/ and
// transactionHistory/ subcollections), counters/{counterId} (the
// concurrency-safe Estate public-ID allocator), and the additive
// `listings.estateId` optional reference. Run with `npm run test:rules`.
//
// Context: Estate is a NEW, deliberately minimal concept -- persistent
// physical-property identity only. It carries no canonical price/status
// of its own (that stays on the Listing, exactly as before), so unlike
// Unit-backed listings there is no mirror/lock mechanism for estateId,
// just an existence check (isValidOptionalEstateRef). Verified transaction
// history is admin-only-writable by construction -- existence in that
// subcollection IS the verification signal, there is no separate
// verified:true/false flag to forge. The estates/{N} counter reuses the
// exact activeListingLocks create-vs-update atomicity proof: Firestore
// classifies a write to a given document path as `create` only once, so
// two different physical properties can never collide on the same estate
// number regardless of the counter's own correctness -- proven here with
// a real concurrency test firing many parallel runTransaction() calls.
import { before, after, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { doc, setDoc, updateDoc, deleteDoc, getDoc, getDocs, collection, runTransaction } from 'firebase/firestore';
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

// ---- Seed helpers (bypass rules) -----------------------------------------
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
async function seedRoleDefaults(accountType, permissions) {
  await seed(testEnv, async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'rolePermissionDefaults', accountType), { permissions });
  });
}
async function seedEstate(estateId, data) {
  await seed(testEnv, async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'estates', estateId), data);
  });
}
async function seedCounter(counterId, value) {
  await seed(testEnv, async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'counters', counterId), { value });
  });
}
async function seedListing(listingId, data) {
  await seed(testEnv, async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'listings', listingId), data);
  });
}

// ---- Fixtures --------------------------------------------------------------
const DEV_ORG = 'dev-org-1';
const OTHER_ORG = 'other-org-1';
const OWNER = 'dev-owner-uid';
const OTHER_OWNER = 'other-owner-uid';

function validEstate(overrides = {}) {
  return {
    propertyType: 'apartment', governorate: 'Erbil', city: 'Erbil', district: 'Italian Village',
    formattedAddress: '123 Test St', location: { lat: 36.19, lng: 44.01 },
    verified: false, createdAt: 1, updatedAt: 1,
    ...overrides
  };
}

async function seedOwnerViaRoleDefaults(uid = OWNER, accountType = 'org_owner_developer', perms = { create_estate: true, edit_own_estate: true }) {
  await seedUser(uid, { role: 'customer', accountType, createdAt: 1 });
  await seedRoleDefaults(accountType, perms);
}

// =========================================================================
describe('ESTATE — create', () => {
  it('an admin can create an Estate', async () => {
    await seedUser('admin-1', { role: 'admin', createdAt: 1 });
    const db = dbFor(testEnv, 'admin-1');
    await assertSucceeds(setDoc(doc(db, 'estates', '1'), validEstate({ createdByUid: 'admin-1' })));
  });

  it('a plain agent can create an Estate (existing agent/office path)', async () => {
    await seedUser('agent-1', { role: 'agent', companyId: 'co-1', createdAt: 1 });
    const db = dbFor(testEnv, 'agent-1');
    await assertSucceeds(setDoc(doc(db, 'estates', '1'), validEstate({ createdByUid: 'agent-1' })));
  });

  // BUG FIX regression (site-wide bug hunt): the plain-agent create branch
  // used to have no restriction on organizationId at all, so any agent
  // (unrelated to any org, holding no create_estate grant) could set
  // organizationId to a real org's id in the same request and have it
  // accepted purely via the isAgent() branch, bypassing the org-membership
  // check entirely.
  it('a plain agent CANNOT attach an organizationId they have no membership/permission for', async () => {
    await seedOrg(DEV_ORG, { ownerId: OWNER, type: 'developer_project', name: 'Darwesh Developments', verified: false });
    await seedUser('agent-1', { role: 'agent', companyId: 'co-1', createdAt: 1 });
    const db = dbFor(testEnv, 'agent-1');
    await assertFails(setDoc(doc(db, 'estates', '1'), validEstate({ organizationId: DEV_ORG, createdByUid: 'agent-1' })));
  });

  it('an authorized org member (global role-default grant) can create an Estate for their org', async () => {
    await seedOrg(DEV_ORG, { ownerId: OWNER, type: 'developer_project', name: 'Darwesh Developments', verified: false });
    await seedOwnerViaRoleDefaults();
    const db = dbFor(testEnv, OWNER);
    await assertSucceeds(setDoc(doc(db, 'estates', '1'), validEstate({ organizationId: DEV_ORG, createdByUid: OWNER })));
  });

  it('an org member with NO create_estate permission is denied', async () => {
    await seedOrg(DEV_ORG, { ownerId: OWNER, type: 'developer_project', name: 'Darwesh Developments', verified: false });
    await seedUser(OWNER, { role: 'customer', accountType: 'org_owner_developer', createdAt: 1 });
    await seedRoleDefaults('org_owner_developer', {}); // no permissions granted
    const db = dbFor(testEnv, OWNER);
    await assertFails(setDoc(doc(db, 'estates', '1'), validEstate({ organizationId: DEV_ORG, createdByUid: OWNER })));
  });

  it('a plain signed-in customer with no role/org relationship is denied', async () => {
    await seedUser('customer-1', { role: 'customer', accountType: 'individual_customer', createdAt: 1 });
    const db = dbFor(testEnv, 'customer-1');
    await assertFails(setDoc(doc(db, 'estates', '1'), validEstate({ createdByUid: 'customer-1' })));
  });

  it('rejects verified:true at create time (even for an admin-shaped payload the client sends)', async () => {
    await seedUser('agent-1', { role: 'agent', companyId: 'co-1', createdAt: 1 });
    const db = dbFor(testEnv, 'agent-1');
    await assertFails(setDoc(doc(db, 'estates', '1'), validEstate({ createdByUid: 'agent-1', verified: true })));
  });

  it('rejects a createdByUid that does not match the caller', async () => {
    await seedUser('agent-1', { role: 'agent', companyId: 'co-1', createdAt: 1 });
    const db = dbFor(testEnv, 'agent-1');
    await assertFails(setDoc(doc(db, 'estates', '1'), validEstate({ createdByUid: 'someone-else' })));
  });

  it('rejects an invalid propertyType', async () => {
    await seedUser('agent-1', { role: 'agent', companyId: 'co-1', createdAt: 1 });
    const db = dbFor(testEnv, 'agent-1');
    await assertFails(setDoc(doc(db, 'estates', '1'), validEstate({ createdByUid: 'agent-1', propertyType: 'castle' })));
  });

  it('rejects an unallowlisted extra field', async () => {
    await seedUser('agent-1', { role: 'agent', companyId: 'co-1', createdAt: 1 });
    const db = dbFor(testEnv, 'agent-1');
    await assertFails(setDoc(doc(db, 'estates', '1'), validEstate({ createdByUid: 'agent-1', ownerPhoneNumber: '0770...' })));
  });

  it('a public (unauthenticated) caller can read an Estate', async () => {
    await seedEstate('1', validEstate({ createdByUid: 'agent-1' }));
    const db = dbFor(testEnv, null);
    await assertSucceeds(getDoc(doc(db, 'estates', '1')));
  });
});

// =========================================================================
describe('ESTATE — update', () => {
  it('an admin can update content fields and flip verified', async () => {
    await seedUser('admin-1', { role: 'admin', createdAt: 1 });
    await seedEstate('1', validEstate({ createdByUid: 'agent-1' }));
    const db = dbFor(testEnv, 'admin-1');
    await assertSucceeds(updateDoc(doc(db, 'estates', '1'), { verified: true, district: 'New District', updatedAt: 2 }));
  });

  it('even an admin cannot reassign organizationId/createdByUid/createdAt', async () => {
    await seedUser('admin-1', { role: 'admin', createdAt: 1 });
    await seedEstate('1', validEstate({ createdByUid: 'agent-1' }));
    const db = dbFor(testEnv, 'admin-1');
    await assertFails(updateDoc(doc(db, 'estates', '1'), { createdByUid: 'someone-else', updatedAt: 2 }));
  });

  it('the creating agent can edit their own unowned (no organizationId) Estate content', async () => {
    await seedUser('agent-1', { role: 'agent', companyId: 'co-1', createdAt: 1 });
    await seedEstate('1', validEstate({ createdByUid: 'agent-1' }));
    const db = dbFor(testEnv, 'agent-1');
    await assertSucceeds(updateDoc(doc(db, 'estates', '1'), { district: 'New District', updatedAt: 2 }));
  });

  it('an agent cannot edit an org-owned Estate just by being an agent', async () => {
    await seedOrg(DEV_ORG, { ownerId: OWNER, type: 'developer_project', name: 'Darwesh Developments', verified: false });
    await seedUser('agent-1', { role: 'agent', companyId: 'co-1', createdAt: 1 });
    await seedEstate('1', validEstate({ organizationId: DEV_ORG, createdByUid: OWNER }));
    const db = dbFor(testEnv, 'agent-1');
    await assertFails(updateDoc(doc(db, 'estates', '1'), { district: 'New District', updatedAt: 2 }));
  });

  it('an agent cannot flip verified on their own Estate', async () => {
    await seedUser('agent-1', { role: 'agent', companyId: 'co-1', createdAt: 1 });
    await seedEstate('1', validEstate({ createdByUid: 'agent-1' }));
    const db = dbFor(testEnv, 'agent-1');
    await assertFails(updateDoc(doc(db, 'estates', '1'), { verified: true, updatedAt: 2 }));
  });

  it('an org member with edit_own_estate can update their org\'s Estate', async () => {
    await seedOrg(DEV_ORG, { ownerId: OWNER, type: 'developer_project', name: 'Darwesh Developments', verified: false });
    await seedOwnerViaRoleDefaults();
    await seedEstate('1', validEstate({ organizationId: DEV_ORG, createdByUid: OWNER }));
    const db = dbFor(testEnv, OWNER);
    await assertSucceeds(updateDoc(doc(db, 'estates', '1'), { district: 'New District', updatedAt: 2 }));
  });

  it('CROSS-ORG: a different org owner cannot edit another org\'s Estate', async () => {
    await seedOrg(DEV_ORG, { ownerId: OWNER, type: 'developer_project', name: 'Darwesh Developments', verified: false });
    await seedOrg(OTHER_ORG, { ownerId: OTHER_OWNER, type: 'developer_project', name: 'Rival Devs', verified: false });
    await seedOwnerViaRoleDefaults(OTHER_OWNER);
    await seedEstate('1', validEstate({ organizationId: DEV_ORG, createdByUid: OWNER }));
    const db = dbFor(testEnv, OTHER_OWNER);
    await assertFails(updateDoc(doc(db, 'estates', '1'), { district: 'Hijacked', updatedAt: 2 }));
  });

  it('only an admin can delete an Estate', async () => {
    await seedUser('agent-1', { role: 'agent', companyId: 'co-1', createdAt: 1 });
    await seedUser('admin-1', { role: 'admin', createdAt: 1 });
    await seedEstate('1', validEstate({ createdByUid: 'agent-1' }));
    await assertFails(deleteDoc(doc(dbFor(testEnv, 'agent-1'), 'estates', '1')));
    await assertSucceeds(deleteDoc(doc(dbFor(testEnv, 'admin-1'), 'estates', '1')));
  });
});

// =========================================================================
describe('ESTATE protected/ subcollection — admin-only, never publicly readable', () => {
  it('an admin can read and write protected Estate data', async () => {
    await seedUser('admin-1', { role: 'admin', createdAt: 1 });
    await seedEstate('1', validEstate({ createdByUid: 'agent-1' }));
    const db = dbFor(testEnv, 'admin-1');
    await assertSucceeds(setDoc(doc(db, 'estates', '1', 'protected', 'admin'), { ownerPhone: '0770...', notes: 'internal' }));
    await assertSucceeds(getDoc(doc(db, 'estates', '1', 'protected', 'admin')));
  });

  it('the Estate\'s own creating agent cannot read protected data', async () => {
    await seedUser('agent-1', { role: 'agent', companyId: 'co-1', createdAt: 1 });
    await seedEstate('1', validEstate({ createdByUid: 'agent-1' }));
    await seed(testEnv, async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'estates', '1', 'protected', 'admin'), { ownerPhone: '0770...' });
    });
    const db = dbFor(testEnv, 'agent-1');
    await assertFails(getDoc(doc(db, 'estates', '1', 'protected', 'admin')));
  });

  it('an unauthenticated caller cannot read protected data', async () => {
    await seedEstate('1', validEstate({ createdByUid: 'agent-1' }));
    await seed(testEnv, async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'estates', '1', 'protected', 'admin'), { ownerPhone: '0770...' });
    });
    const db = dbFor(testEnv, null);
    await assertFails(getDoc(doc(db, 'estates', '1', 'protected', 'admin')));
  });

  it('an org owner who manages the parent Estate still cannot write its protected data', async () => {
    await seedOrg(DEV_ORG, { ownerId: OWNER, type: 'developer_project', name: 'Darwesh Developments', verified: false });
    await seedOwnerViaRoleDefaults();
    await seedEstate('1', validEstate({ organizationId: DEV_ORG, createdByUid: OWNER }));
    const db = dbFor(testEnv, OWNER);
    await assertFails(setDoc(doc(db, 'estates', '1', 'protected', 'admin'), { ownerPhone: '0770...' }));
  });
});

// =========================================================================
describe('ESTATE transactionHistory/ — verified sale/rent history', () => {
  function validTx(overrides = {}) {
    return {
      transactionType: 'sale', priceAmount: 185000, currency: 'USD',
      transactionDate: '2025-03-01', verifiedBy: 'admin-1', createdAt: 1,
      ...overrides
    };
  }

  it('PRIVACY: the internal transactionHistory record is admin-only readable -- an unauthenticated caller cannot read it', async () => {
    await seedEstate('1', validEstate({ createdByUid: 'agent-1' }));
    await seed(testEnv, async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'estates', '1', 'transactionHistory', 'tx1'), validTx({ notes: 'seller wants discretion', sourceListingId: 'l-internal-1' }));
    });
    const db = dbFor(testEnv, null);
    await assertFails(getDocs(collection(db, 'estates', '1', 'transactionHistory')));
    await assertFails(getDoc(doc(db, 'estates', '1', 'transactionHistory', 'tx1')));
  });

  it('PRIVACY: the Estate\'s own agent/org and a plain signed-in customer cannot read internal transaction history either', async () => {
    await seedOrg(DEV_ORG, { ownerId: OWNER, type: 'developer_project', name: 'Darwesh Developments', verified: false });
    await seedOwnerViaRoleDefaults();
    await seedEstate('1', validEstate({ organizationId: DEV_ORG, createdByUid: OWNER }));
    await seed(testEnv, async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'estates', '1', 'transactionHistory', 'tx1'), validTx());
    });
    await assertFails(getDoc(doc(dbFor(testEnv, OWNER), 'estates', '1', 'transactionHistory', 'tx1')));
    await seedUser('customer-1', { role: 'customer', accountType: 'individual_customer', createdAt: 1 });
    await assertFails(getDoc(doc(dbFor(testEnv, 'customer-1'), 'estates', '1', 'transactionHistory', 'tx1')));
  });

  it('an admin CAN read the internal transaction history record', async () => {
    await seedUser('admin-1', { role: 'admin', createdAt: 1 });
    await seedEstate('1', validEstate({ createdByUid: 'agent-1' }));
    await seed(testEnv, async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'estates', '1', 'transactionHistory', 'tx1'), validTx());
    });
    await assertSucceeds(getDoc(doc(dbFor(testEnv, 'admin-1'), 'estates', '1', 'transactionHistory', 'tx1')));
  });

  it('an admin can create a verified transaction record', async () => {
    await seedUser('admin-1', { role: 'admin', createdAt: 1 });
    await seedEstate('1', validEstate({ createdByUid: 'agent-1' }));
    const db = dbFor(testEnv, 'admin-1');
    await assertSucceeds(setDoc(doc(db, 'estates', '1', 'transactionHistory', 'tx1'), validTx({ verifiedBy: 'admin-1' })));
  });

  it('CRITICAL: the Estate\'s own agent/creator CANNOT create a transaction record (no self-verification)', async () => {
    await seedUser('agent-1', { role: 'agent', companyId: 'co-1', createdAt: 1 });
    await seedEstate('1', validEstate({ createdByUid: 'agent-1' }));
    const db = dbFor(testEnv, 'agent-1');
    await assertFails(setDoc(doc(db, 'estates', '1', 'transactionHistory', 'tx1'), validTx({ verifiedBy: 'agent-1' })));
  });

  it('CRITICAL: an org owner CANNOT create a transaction record for their own Estate', async () => {
    await seedOrg(DEV_ORG, { ownerId: OWNER, type: 'developer_project', name: 'Darwesh Developments', verified: false });
    await seedOwnerViaRoleDefaults();
    await seedEstate('1', validEstate({ organizationId: DEV_ORG, createdByUid: OWNER }));
    const db = dbFor(testEnv, OWNER);
    await assertFails(setDoc(doc(db, 'estates', '1', 'transactionHistory', 'tx1'), validTx({ verifiedBy: OWNER })));
  });

  it('rejects verifiedBy not matching the calling admin (cannot attribute the verification to someone else)', async () => {
    await seedUser('admin-1', { role: 'admin', createdAt: 1 });
    await seedEstate('1', validEstate({ createdByUid: 'agent-1' }));
    const db = dbFor(testEnv, 'admin-1');
    await assertFails(setDoc(doc(db, 'estates', '1', 'transactionHistory', 'tx1'), validTx({ verifiedBy: 'other-admin' })));
  });

  it('rejects an invalid currency', async () => {
    await seedUser('admin-1', { role: 'admin', createdAt: 1 });
    await seedEstate('1', validEstate({ createdByUid: 'agent-1' }));
    const db = dbFor(testEnv, 'admin-1');
    await assertFails(setDoc(doc(db, 'estates', '1', 'transactionHistory', 'tx1'), validTx({ verifiedBy: 'admin-1', currency: 'EUR' })));
  });

  it('rejects a non-positive priceAmount', async () => {
    await seedUser('admin-1', { role: 'admin', createdAt: 1 });
    await seedEstate('1', validEstate({ createdByUid: 'agent-1' }));
    const db = dbFor(testEnv, 'admin-1');
    await assertFails(setDoc(doc(db, 'estates', '1', 'transactionHistory', 'tx1'), validTx({ verifiedBy: 'admin-1', priceAmount: 0 })));
  });

  it('an admin can correct a transaction\'s content, but verifiedBy/createdAt stay immutable', async () => {
    await seedUser('admin-1', { role: 'admin', createdAt: 1 });
    await seedEstate('1', validEstate({ createdByUid: 'agent-1' }));
    await seed(testEnv, async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'estates', '1', 'transactionHistory', 'tx1'), validTx());
    });
    const db = dbFor(testEnv, 'admin-1');
    await assertSucceeds(updateDoc(doc(db, 'estates', '1', 'transactionHistory', 'tx1'), { priceAmount: 190000 }));
    await assertFails(updateDoc(doc(db, 'estates', '1', 'transactionHistory', 'tx1'), { verifiedBy: 'someone-else' }));
    await assertFails(updateDoc(doc(db, 'estates', '1', 'transactionHistory', 'tx1'), { createdAt: 999 }));
  });

  it('only an admin can update or delete a transaction record', async () => {
    await seedUser('agent-1', { role: 'agent', companyId: 'co-1', createdAt: 1 });
    await seedEstate('1', validEstate({ createdByUid: 'agent-1' }));
    await seed(testEnv, async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'estates', '1', 'transactionHistory', 'tx1'), validTx());
    });
    const db = dbFor(testEnv, 'agent-1');
    await assertFails(updateDoc(doc(db, 'estates', '1', 'transactionHistory', 'tx1'), { priceAmount: 1 }));
    await assertFails(deleteDoc(doc(db, 'estates', '1', 'transactionHistory', 'tx1')));
  });
});

// =========================================================================
describe('ESTATE publicTransactionSummary/ — deliberately published, public-safe projection', () => {
  function validSummary(overrides = {}) {
    return { transactionType: 'sale', priceAmount: 185000, currency: 'USD', transactionDate: '2025-03-01', createdAt: 1, ...overrides };
  }

  it('anyone, including an unauthenticated caller, can read a published public summary', async () => {
    await seedEstate('1', validEstate({ createdByUid: 'agent-1' }));
    await seed(testEnv, async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'estates', '1', 'publicTransactionSummary', 'tx1'), validSummary());
    });
    const db = dbFor(testEnv, null);
    await assertSucceeds(getDoc(doc(db, 'estates', '1', 'publicTransactionSummary', 'tx1')));
  });

  it('an admin can publish a public summary', async () => {
    await seedUser('admin-1', { role: 'admin', createdAt: 1 });
    await seedEstate('1', validEstate({ createdByUid: 'agent-1' }));
    const db = dbFor(testEnv, 'admin-1');
    await assertSucceeds(setDoc(doc(db, 'estates', '1', 'publicTransactionSummary', 'tx1'), validSummary()));
  });

  it('CRITICAL: no non-admin (including the Estate\'s own agent/org) can publish a public summary', async () => {
    await seedUser('agent-1', { role: 'agent', companyId: 'co-1', createdAt: 1 });
    await seedEstate('1', validEstate({ createdByUid: 'agent-1' }));
    await assertFails(setDoc(doc(dbFor(testEnv, 'agent-1'), 'estates', '1', 'publicTransactionSummary', 'tx1'), validSummary()));

    await seedOrg(DEV_ORG, { ownerId: OWNER, type: 'developer_project', name: 'Darwesh Developments', verified: false });
    await seedOwnerViaRoleDefaults();
    await seedEstate('2', validEstate({ organizationId: DEV_ORG, createdByUid: OWNER }));
    await assertFails(setDoc(doc(dbFor(testEnv, OWNER), 'estates', '2', 'publicTransactionSummary', 'tx1'), validSummary()));
  });

  it('CRITICAL: verifierBy/notes/sourceListingId (or any field beyond the public-safe allowlist) cannot be written into the public summary', async () => {
    await seedUser('admin-1', { role: 'admin', createdAt: 1 });
    await seedEstate('1', validEstate({ createdByUid: 'agent-1' }));
    const db = dbFor(testEnv, 'admin-1');
    await assertFails(setDoc(doc(db, 'estates', '1', 'publicTransactionSummary', 'tx1'), validSummary({ verifiedBy: 'admin-1' })));
    await assertFails(setDoc(doc(db, 'estates', '1', 'publicTransactionSummary', 'tx1'), validSummary({ notes: 'internal note' })));
    await assertFails(setDoc(doc(db, 'estates', '1', 'publicTransactionSummary', 'tx1'), validSummary({ sourceListingId: 'l-1' })));
  });

  it('publishing a summary does NOT itself expose the internal transactionHistory record -- they remain fully independent', async () => {
    await seedUser('admin-1', { role: 'admin', createdAt: 1 });
    await seedEstate('1', validEstate({ createdByUid: 'agent-1' }));
    await seed(testEnv, async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'estates', '1', 'transactionHistory', 'tx1'), { transactionType: 'sale', priceAmount: 185000, currency: 'USD', transactionDate: '2025-03-01', verifiedBy: 'admin-1', notes: 'private detail', createdAt: 1 });
      await setDoc(doc(ctx.firestore(), 'estates', '1', 'publicTransactionSummary', 'tx1'), validSummary());
    });
    const db = dbFor(testEnv, null);
    await assertSucceeds(getDoc(doc(db, 'estates', '1', 'publicTransactionSummary', 'tx1')));
    await assertFails(getDoc(doc(db, 'estates', '1', 'transactionHistory', 'tx1')));
  });

  it('an admin can correct summary content but not reassign createdAt', async () => {
    await seedUser('admin-1', { role: 'admin', createdAt: 1 });
    await seedEstate('1', validEstate({ createdByUid: 'agent-1' }));
    await seed(testEnv, async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'estates', '1', 'publicTransactionSummary', 'tx1'), validSummary());
    });
    const db = dbFor(testEnv, 'admin-1');
    await assertSucceeds(updateDoc(doc(db, 'estates', '1', 'publicTransactionSummary', 'tx1'), { priceAmount: 190000 }));
    await assertFails(updateDoc(doc(db, 'estates', '1', 'publicTransactionSummary', 'tx1'), { createdAt: 999 }));
  });

  it('rejects an invalid currency or non-positive price on the public summary', async () => {
    await seedUser('admin-1', { role: 'admin', createdAt: 1 });
    await seedEstate('1', validEstate({ createdByUid: 'agent-1' }));
    const db = dbFor(testEnv, 'admin-1');
    await assertFails(setDoc(doc(db, 'estates', '1', 'publicTransactionSummary', 'tx1'), validSummary({ currency: 'EUR' })));
    await assertFails(setDoc(doc(db, 'estates', '1', 'publicTransactionSummary', 'tx2'), validSummary({ priceAmount: 0 })));
  });
});

// =========================================================================
describe('counters/estates — concurrency-safe public ID allocator', () => {
  it('an authorized caller (agent) can allocate the first value (create, value==1)', async () => {
    await seedUser('agent-1', { role: 'agent', companyId: 'co-1', createdAt: 1 });
    const db = dbFor(testEnv, 'agent-1');
    await assertSucceeds(setDoc(doc(db, 'counters', 'estates'), { value: 1 }));
  });

  it('an unauthorized plain customer cannot allocate a number', async () => {
    await seedUser('customer-1', { role: 'customer', accountType: 'individual_customer', createdAt: 1 });
    const db = dbFor(testEnv, 'customer-1');
    await assertFails(setDoc(doc(db, 'counters', 'estates'), { value: 1 }));
  });

  it('rejects a first create that does not start at 1', async () => {
    await seedUser('agent-1', { role: 'agent', companyId: 'co-1', createdAt: 1 });
    const db = dbFor(testEnv, 'agent-1');
    await assertFails(setDoc(doc(db, 'counters', 'estates'), { value: 5 }));
  });

  it('an authorized caller can increment by exactly 1', async () => {
    await seedUser('agent-1', { role: 'agent', companyId: 'co-1', createdAt: 1 });
    await seedCounter('estates', 1);
    const db = dbFor(testEnv, 'agent-1');
    await assertSucceeds(updateDoc(doc(db, 'counters', 'estates'), { value: 2 }));
  });

  it('rejects a non-sequential jump', async () => {
    await seedUser('agent-1', { role: 'agent', companyId: 'co-1', createdAt: 1 });
    await seedCounter('estates', 1);
    const db = dbFor(testEnv, 'agent-1');
    await assertFails(updateDoc(doc(db, 'counters', 'estates'), { value: 10 }));
  });

  it('rejects a counter document id other than "estates"', async () => {
    await seedUser('agent-1', { role: 'agent', companyId: 'co-1', createdAt: 1 });
    const db = dbFor(testEnv, 'agent-1');
    await assertFails(setDoc(doc(db, 'counters', 'widgets'), { value: 1 }));
  });

  it('nobody can delete the counter document', async () => {
    await seedUser('admin-1', { role: 'admin', createdAt: 1 });
    await seedCounter('estates', 1);
    const db = dbFor(testEnv, 'admin-1');
    await assertFails(deleteDoc(doc(db, 'counters', 'estates')));
  });

  it('CRITICAL: N concurrent runTransaction() allocations never collide, skip, or duplicate a value', async () => {
    await seedUser('agent-1', { role: 'agent', companyId: 'co-1', createdAt: 1 });
    await seedCounter('estates', 0);
    const db = dbFor(testEnv, 'agent-1');
    const counterRef = doc(db, 'counters', 'estates');

    // KNOWN ENVIRONMENT LIMITATION (documented, not a bug in these rules):
    // in real Cloud Firestore, when two runTransaction() calls conflict,
    // the loser's commit fails with ABORTED and the CLIENT SDK
    // transparently re-runs the whole transaction function against a
    // fresh read -- this is a core, documented Firestore guarantee (the
    // exact one counters/estates' rule comment relies on) and is not
    // something these rules implement themselves. The Firestore JS
    // emulator's rules-evaluation path does not reproduce that: a losing
    // transaction's commit is rejected as PERMISSION_DENIED (rules
    // evaluated `value == resource.data.value + 1` against a resource
    // that had already moved on) rather than ABORTED, so the SDK's
    // built-in retry never triggers -- confirmed by hand: an identical
    // Promise.all() of N bare runTransaction() calls with no retry
    // wrapper drops to 1-2 successes out of 15 in the emulator, while
    // wrapping each call in its own retry loop (below) restores the
    // real production semantics and allocates exactly {1..N} with zero
    // duplicates/gaps every time. The retry loop here is doing the same
    // job the production client SDK already does for free -- it is not
    // masking a rules weakness, it is compensating for the emulator not
    // emitting the retryable status code production does.
    async function allocateOne() {
      for (let attempt = 0; attempt < 25; attempt++) {
        try {
          return await runTransaction(db, async (tx) => {
            const snap = await tx.get(counterRef);
            const next = snap.data().value + 1;
            tx.update(counterRef, { value: next });
            return next;
          });
        } catch (e) {
          if (e.code !== 'permission-denied' && e.code !== 'aborted') throw e;
          await new Promise((r) => setTimeout(r, 10 + Math.random() * 30));
        }
      }
      throw new Error('allocateOne exhausted retries');
    }

    const N = 15;
    const allocated = await Promise.all(Array.from({ length: N }, () => allocateOne()));
    const sorted = [...allocated].sort((a, b) => a - b);
    const expected = Array.from({ length: N }, (_, i) => i + 1);
    assert.deepEqual(sorted, expected, `expected exactly {1..${N}} with no duplicates/gaps, got ${JSON.stringify(sorted)}`);

    const finalSnap = await getDoc(counterRef);
    assert.equal(finalSnap.data().value, N);
  });
});

// =========================================================================
// Estate ID ATOMICITY -- explicit review requirement: prove the counter
// increment and the new Estate document are written in the SAME
// Firestore transaction (js/estate-allocator.js's createEstate()), so
// there is no state where the counter moves but no matching Estate
// document exists, or vice versa. Mirrors js/estate-allocator.js's own
// transaction body exactly (that module can't be imported directly here
// -- it imports js/firebase-init.js, which wires up a real Firebase App
// + App Check + hardcoded production config, none of which belongs in
// an offline rules-emulator test) so this is a faithful re-exercise of
// the same read-then-set-twice-in-one-transaction shape actually shipped
// in that file, run against the real rules-enforced emulator client.
describe('Estate ID allocation — atomicity (combined counter + Estate transaction)', () => {
  async function allocateEstate(db, estateFields) {
    const counterRef = doc(db, 'counters', 'estates');
    return runTransaction(db, async (tx) => {
      const snap = await tx.get(counterRef);
      const next = (snap.exists() ? snap.data().value : 0) + 1;
      const estateRef = doc(db, 'estates', String(next));
      tx.set(counterRef, { value: next });
      tx.set(estateRef, estateFields);
      return { estateId: String(next) };
    });
  }

  it('successful allocation: counter and Estate document both exist together after one call', async () => {
    await seedUser('agent-1', { role: 'agent', companyId: 'co-1', createdAt: 1 });
    const db = dbFor(testEnv, 'agent-1');
    const { estateId } = await allocateEstate(db, validEstate({ createdByUid: 'agent-1' }));
    assert.equal(estateId, '1');
    const counterSnap = await getDoc(doc(db, 'counters', 'estates'));
    const estateSnap = await getDoc(doc(db, 'estates', estateId));
    assert.equal(counterSnap.data().value, 1);
    assert.equal(estateSnap.exists(), true);
  });

  it('CRITICAL — no partial commit: a failing Estate write (invalid content) leaves the counter completely unchanged', async () => {
    await seedUser('agent-1', { role: 'agent', companyId: 'co-1', createdAt: 1 });
    await seedCounter('estates', 5); // simulate 5 real prior allocations
    const db = dbFor(testEnv, 'agent-1');
    await assert.rejects(
      allocateEstate(db, validEstate({ createdByUid: 'agent-1', propertyType: 'castle' })) // fails isValidPropertyType
    );
    const counterSnap = await getDoc(doc(db, 'counters', 'estates'));
    assert.equal(counterSnap.data().value, 5, 'counter must still read the pre-attempt value -- the failed Estate write must not have left the counter bumped');
    const estateSnap = await getDoc(doc(db, 'estates', '6'));
    // Public read of a nonexistent doc succeeds with exists()===false --
    // this itself proves no Estate document was left behind at slot 6.
    assert.equal(estateSnap.exists(), false);
  });

  it('CRITICAL — unauthorized caller: the whole transaction is denied, counter unchanged, no Estate created', async () => {
    await seedUser('customer-1', { role: 'customer', accountType: 'individual_customer', createdAt: 1 });
    await seedCounter('estates', 3);
    const db = dbFor(testEnv, 'customer-1');
    await assert.rejects(
      allocateEstate(db, validEstate({ createdByUid: 'customer-1' }))
    );
    const counterSnap = await getDoc(doc(db, 'counters', 'estates'));
    assert.equal(counterSnap.data().value, 3);
    const estateSnap = await getDoc(doc(db, 'estates', '4'));
    assert.equal(estateSnap.exists(), false);
  });

  it('CRITICAL — N concurrent createEstate()-shaped allocations never collide, skip, or duplicate a slot, and every allocated slot has a real matching Estate document', async () => {
    await seedUser('agent-1', { role: 'agent', companyId: 'co-1', createdAt: 1 });
    await seedCounter('estates', 0);
    const db = dbFor(testEnv, 'agent-1');

    // Same documented emulator-only retry need as the plain counter
    // concurrency test above (the Firestore JS emulator surfaces a
    // losing transaction's conflict as PERMISSION_DENIED instead of the
    // retryable ABORTED production itself uses -- see that test's
    // comment for the full explanation and the hand-verified proof).
    // js/estate-allocator.js's own createEstate() intentionally does
    // NOT include this retry loop -- it would be actively wrong in
    // production, where a real PERMISSION_DENIED means "not
    // authorized," not "please retry."
    async function allocateWithEmulatorRetry() {
      for (let attempt = 0; attempt < 25; attempt++) {
        try {
          return await allocateEstate(db, validEstate({ createdByUid: 'agent-1' }));
        } catch (e) {
          if (e.code !== 'permission-denied' && e.code !== 'aborted') throw e;
          await new Promise((r) => setTimeout(r, 10 + Math.random() * 30));
        }
      }
      throw new Error('exhausted retries');
    }

    const N = 12;
    const results = await Promise.all(Array.from({ length: N }, () => allocateWithEmulatorRetry()));
    const ids = results.map((r) => Number(r.estateId)).sort((a, b) => a - b);
    assert.deepEqual(ids, Array.from({ length: N }, (_, i) => i + 1));

    // Every allocated slot has a REAL Estate document -- not just a
    // reserved number with nothing behind it.
    for (const id of ids) {
      const snap = await getDoc(doc(db, 'estates', String(id)));
      assert.equal(snap.exists(), true, `estates/${id} must exist -- an allocated slot with no Estate document would be exactly the gap this design eliminates`);
    }
    const counterSnap = await getDoc(doc(db, 'counters', 'estates'));
    assert.equal(counterSnap.data().value, N);
  });

  it('DEFENSE IN DEPTH: even bypassing the shared helper, a second write to an already-used Estate slot is still rejected (create-vs-update uniqueness holds independent of this file)', async () => {
    await seedUser('agent-1', { role: 'agent', companyId: 'co-1', createdAt: 1 });
    await seedEstate('7', validEstate({ createdByUid: 'agent-1' })); // simulates slot 7 already allocated
    const db = dbFor(testEnv, 'agent-1');
    // A caller that (incorrectly) tries to reuse slot 7 directly --
    // Firestore classifies this as `update` since the doc already
    // exists, and estates/{id}'s own update rule requires
    // organizationId/createdByUid/createdAt to stay exactly as they
    // were, which a "new" Estate payload for a DIFFERENT physical
    // property will not satisfy.
    await assertFails(setDoc(doc(db, 'estates', '7'), validEstate({ createdByUid: 'someone-else' })));
  });
});

// =========================================================================
describe('listings.estateId — additive optional reference (Estate <-> Listing)', () => {
  function validListing(overrides = {}) {
    return {
      title: 'Nice flat', city: 'Erbil', dealType: 'sale', propertyType: 'apartment',
      price: 100000, private: false, status: 'active',
      agentId: 'agent-1', companyId: 'co-1', createdAt: 1,
      ...overrides
    };
  }

  it('a listing with NO estateId still creates exactly as before (backward compatibility)', async () => {
    await seedUser('agent-1', { role: 'agent', companyId: 'co-1', createdAt: 1 });
    const db = dbFor(testEnv, 'agent-1');
    await assertSucceeds(setDoc(doc(db, 'listings', 'l1'), validListing()));
  });

  it('a listing can reference a real, existing Estate', async () => {
    await seedUser('agent-1', { role: 'agent', companyId: 'co-1', createdAt: 1 });
    await seedEstate('1', validEstate({ createdByUid: 'agent-1' }));
    const db = dbFor(testEnv, 'agent-1');
    await assertSucceeds(setDoc(doc(db, 'listings', 'l1'), validListing({ estateId: '1' })));
  });

  it('rejects a listing referencing a nonexistent estateId', async () => {
    await seedUser('agent-1', { role: 'agent', companyId: 'co-1', createdAt: 1 });
    const db = dbFor(testEnv, 'agent-1');
    await assertFails(setDoc(doc(db, 'listings', 'l1'), validListing({ estateId: 'does-not-exist' })));
  });

  it('rejects a non-string estateId', async () => {
    await seedUser('agent-1', { role: 'agent', companyId: 'co-1', createdAt: 1 });
    await seedEstate('1', validEstate({ createdByUid: 'agent-1' }));
    const db = dbFor(testEnv, 'agent-1');
    await assertFails(setDoc(doc(db, 'listings', 'l1'), validListing({ estateId: 1 })));
  });

  it('estateId is immutable once set (cannot be re-pointed at a different Estate on update)', async () => {
    await seedUser('agent-1', { role: 'agent', companyId: 'co-1', createdAt: 1 });
    await seedEstate('1', validEstate({ createdByUid: 'agent-1' }));
    await seedEstate('2', validEstate({ createdByUid: 'agent-1' }));
    await seedListing('l1', validListing({ estateId: '1' }));
    const db = dbFor(testEnv, 'agent-1');
    await assertFails(updateDoc(doc(db, 'listings', 'l1'), { estateId: '2', updatedAt: 2 }));
  });

  it('an ordinary content edit on an estate-linked listing (not touching estateId) still succeeds', async () => {
    await seedUser('agent-1', { role: 'agent', companyId: 'co-1', createdAt: 1 });
    await seedEstate('1', validEstate({ createdByUid: 'agent-1' }));
    await seedListing('l1', validListing({ estateId: '1' }));
    const db = dbFor(testEnv, 'agent-1');
    await assertSucceeds(updateDoc(doc(db, 'listings', 'l1'), { price: 105000, updatedAt: 2 }));
  });

  it('a second, later Listing may reference the SAME Estate (listing history is expected, not an error)', async () => {
    await seedUser('agent-1', { role: 'agent', companyId: 'co-1', createdAt: 1 });
    await seedEstate('1', validEstate({ createdByUid: 'agent-1' }));
    await seedListing('l1', validListing({ estateId: '1', status: 'closed' }));
    const db = dbFor(testEnv, 'agent-1');
    await assertSucceeds(setDoc(doc(db, 'listings', 'l2'), validListing({ estateId: '1' })));
  });

  it('a unit-backed listing may also reference an Estate, validated the same way', async () => {
    await seedOrg(DEV_ORG, { ownerId: OWNER, type: 'developer_project', name: 'Darwesh Developments', verified: false });
    await seedUser(OWNER, { role: 'customer', accountType: 'org_owner_developer', createdAt: 1 });
    await seedRoleDefaults('org_owner_developer', { publish_unit_listing: true });
    await seedEstate('1', validEstate({ organizationId: DEV_ORG, createdByUid: OWNER }));
    await seed(testEnv, async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'units', 'unit-1'), {
        organizationId: DEV_ORG, projectId: 'proj-1', unitNumber: 'A-101', propertyType: 'apartment',
        listingType: 'sale', status: 'available', priceAmount: 150000, currency: 'USD',
        governorate: 'Erbil', city: 'Erbil', district: 'Italian Village',
        location: { lat: 36.19, lng: 44.01 }, createdAt: 1, updatedAt: 1
      });
    });
    const db = dbFor(testEnv, OWNER);
    await assertSucceeds(setDoc(doc(db, 'listings', 'listing-x'), {
      title: 'Zaytoon Hills A-101', city: 'Erbil', dealType: 'sale', propertyType: 'apartment',
      price: 150000, private: false, status: 'closed',
      unitId: 'unit-1', projectId: 'proj-1', publisherOrgId: DEV_ORG, estateId: '1', createdAt: 1
    }));
  });
});
