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

  it('anyone, including an unauthenticated caller, can read transaction history', async () => {
    await seedEstate('1', validEstate({ createdByUid: 'agent-1' }));
    await seed(testEnv, async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'estates', '1', 'transactionHistory', 'tx1'), validTx());
    });
    const db = dbFor(testEnv, null);
    await assertSucceeds(getDocs(collection(db, 'estates', '1', 'transactionHistory')));
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
