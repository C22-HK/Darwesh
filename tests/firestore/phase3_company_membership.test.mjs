// Phase 3 (Profile UI/UX) Firestore Rules regression tests -- the
// additive `companies` schema extension (ownerId, logo/description/
// verified/contactInfo, and the employees subcollection) that mirrors
// organizations/{orgId}'s ownership/membership pattern. Proves: the
// legacy admin.html "Add Agent" flow (creates a company doc with no
// ownerId at all) keeps working completely unchanged; a self-registering
// office owner can found a brand-new office as its own owner; ownerId is
// locked for every client-SDK update including admin, the SAME way it's
// locked for a legacy ownerless doc (so it can never be silently self-
// claimed); and the employees subcollection is never client-writable by
// anyone, mirroring organizations/{orgId}/members exactly.
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

async function seedUser(uid, data) {
  await seed(testEnv, async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'users', uid), data);
  });
}

async function seedCompany(companyId, data) {
  await seed(testEnv, async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'companies', companyId), data);
  });
}

async function seedEmployee(companyId, uid, data) {
  await seed(testEnv, async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'companies', companyId, 'employees', uid), data);
  });
}

const ADMIN = 'admin-uid';
const OWNER_A = 'owner-a-uid';
const OWNER_B = 'owner-b-uid';
const RANDO = 'rando-uid';

async function seedAdmin() {
  await seedUser(ADMIN, { role: 'admin', createdAt: 'x' });
}

// ---- A. Companies: create -------------------------------------------

describe('companies (Phase 3 additive schema)', () => {
  it('a signed-in user can found a brand-new office as its own owner', async () => {
    const db = dbFor(testEnv, OWNER_A);
    await assertSucceeds(setDoc(doc(db, 'companies', 'co1'), {
      ownerId: OWNER_A, name: 'Acme Realty', verified: false,
    }));
  });

  it('the legacy admin.html "Add Agent" flow (no ownerId at all) still works unchanged', async () => {
    await seedAdmin();
    const db = dbFor(testEnv, ADMIN);
    await assertSucceeds(setDoc(doc(db, 'companies', 'co2'), { name: 'Legacy Office' }));
  });

  it('rejects creating an office owned by someone else', async () => {
    const db = dbFor(testEnv, OWNER_A);
    await assertFails(setDoc(doc(db, 'companies', 'co3'), {
      ownerId: OWNER_B, name: 'Acme Realty', verified: false,
    }));
  });

  it('rejects self-setting verified:true at creation', async () => {
    const db = dbFor(testEnv, OWNER_A);
    await assertFails(setDoc(doc(db, 'companies', 'co4'), {
      ownerId: OWNER_A, name: 'Acme Realty', verified: true,
    }));
  });

  it('rejects an unknown field at creation', async () => {
    const db = dbFor(testEnv, OWNER_A);
    await assertFails(setDoc(doc(db, 'companies', 'co5'), {
      ownerId: OWNER_A, name: 'Acme Realty', verified: false, isAdmin: true,
    }));
  });

  it('rejects a second create for an already-existing company id', async () => {
    await seedCompany('co6', { name: 'Existing Office', createdAt: 'x' });
    const db = dbFor(testEnv, OWNER_A);
    await assertFails(setDoc(doc(db, 'companies', 'co6'), { ownerId: OWNER_A, name: 'Hijack' }));
  });

  it('is readable by any signed-in user', async () => {
    await seedCompany('co7', { ownerId: OWNER_A, name: 'Acme Realty' });
    const db = dbFor(testEnv, RANDO);
    await assertSucceeds(getDoc(doc(db, 'companies', 'co7')));
  });
});

// ---- B. Companies: update ---------------------------------------------

describe('companies update -- ownerId lock', () => {
  it('lets the owner update ordinary fields', async () => {
    await seedCompany('co8', { ownerId: OWNER_A, name: 'Acme Realty' });
    const db = dbFor(testEnv, OWNER_A);
    await assertSucceeds(updateDoc(doc(db, 'companies', 'co8'), { description: 'A great office' }));
  });

  it('blocks the owner from reassigning ownerId to someone else', async () => {
    await seedCompany('co9', { ownerId: OWNER_A, name: 'Acme Realty' });
    const db = dbFor(testEnv, OWNER_A);
    await assertFails(updateDoc(doc(db, 'companies', 'co9'), { ownerId: OWNER_B }));
  });

  it('blocks even an admin client-SDK session from reassigning ownerId (backend-mediated only)', async () => {
    await seedCompany('co10', { ownerId: OWNER_A, name: 'Acme Realty' });
    await seedAdmin();
    const db = dbFor(testEnv, ADMIN);
    await assertFails(updateDoc(doc(db, 'companies', 'co10'), { ownerId: OWNER_B }));
  });

  it('blocks self-claiming ownership of a legacy, ownerless company via a normal update', async () => {
    await seedCompany('co11', { name: 'Legacy Office', createdAt: 'x' }); // no ownerId at all
    const db = dbFor(testEnv, RANDO);
    await assertFails(updateDoc(doc(db, 'companies', 'co11'), { ownerId: RANDO }));
  });

  it('still lets an admin edit a legacy ownerless company\'s ordinary fields (e.g. address)', async () => {
    // Exact regression proof for admin.html's existing edit-address flow
    // (admin.html:2760, updateDoc(doc(db,'companies',id), { address })) --
    // must keep working unchanged for companies with no ownerId field.
    await seedCompany('co12', { name: 'Legacy Office', createdAt: 'x' });
    await seedAdmin();
    const db = dbFor(testEnv, ADMIN);
    await assertSucceeds(updateDoc(doc(db, 'companies', 'co12'), { address: '123 Main St' }));
  });

  it('still lets an admin set verified directly', async () => {
    await seedCompany('co13', { ownerId: OWNER_A, name: 'Acme Realty', verified: false });
    await seedAdmin();
    const db = dbFor(testEnv, ADMIN);
    await assertSucceeds(updateDoc(doc(db, 'companies', 'co13'), { verified: true }));
  });

  it('blocks the owner from self-setting verified directly', async () => {
    await seedCompany('co14', { ownerId: OWNER_A, name: 'Acme Realty', verified: false });
    const db = dbFor(testEnv, OWNER_A);
    await assertFails(updateDoc(doc(db, 'companies', 'co14'), { verified: true }));
  });

  it('blocks a non-owner, non-admin signed-in user from updating the office', async () => {
    await seedCompany('co15', { ownerId: OWNER_A, name: 'Acme Realty' });
    const db = dbFor(testEnv, RANDO);
    await assertFails(updateDoc(doc(db, 'companies', 'co15'), { name: 'Hijacked' }));
  });
});

// ---- C. companies/{id}/employees subcollection -------------------------

describe('companies/{companyId}/employees', () => {
  it('is never client-writable, not even by the office owner', async () => {
    await seedCompany('coe1', { ownerId: OWNER_A, name: 'Acme Realty' });
    const db = dbFor(testEnv, OWNER_A);
    await assertFails(setDoc(doc(db, 'companies', 'coe1', 'employees', OWNER_B), { status: 'active' }));
  });

  it('is never client-writable, not even by an admin', async () => {
    await seedCompany('coe2', { ownerId: OWNER_A, name: 'Acme Realty' });
    await seedAdmin();
    const db = dbFor(testEnv, ADMIN);
    await assertFails(setDoc(doc(db, 'companies', 'coe2', 'employees', OWNER_B), { status: 'active' }));
  });

  it('lets the office owner read an employee record', async () => {
    await seedCompany('coe3', { ownerId: OWNER_A, name: 'Acme Realty' });
    await seedEmployee('coe3', OWNER_B, { status: 'active', uid: OWNER_B });
    const db = dbFor(testEnv, OWNER_A);
    await assertSucceeds(getDoc(doc(db, 'companies', 'coe3', 'employees', OWNER_B)));
  });

  it('lets an employee read their own membership doc', async () => {
    await seedCompany('coe4', { ownerId: OWNER_A, name: 'Acme Realty' });
    await seedEmployee('coe4', OWNER_B, { status: 'active', uid: OWNER_B });
    const db = dbFor(testEnv, OWNER_B);
    await assertSucceeds(getDoc(doc(db, 'companies', 'coe4', 'employees', OWNER_B)));
  });

  it('blocks an unrelated signed-in user from reading an employee record', async () => {
    await seedCompany('coe5', { ownerId: OWNER_A, name: 'Acme Realty' });
    await seedEmployee('coe5', OWNER_B, { status: 'active', uid: OWNER_B });
    const db = dbFor(testEnv, RANDO);
    await assertFails(getDoc(doc(db, 'companies', 'coe5', 'employees', OWNER_B)));
  });
});
