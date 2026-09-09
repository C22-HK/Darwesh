// U1 (launch-readiness audit): private agent fields live in
// users/{uid}/privateProfile/main, never on the world-readable users/{uid}
// document. Proves the rules side of that split:
//   1. nobody but the owner / an admin can read the private document
//   2. only an admin can run the collection-group query the admin
//      dashboard uses
//   3. the owner may only ever change commissionRate (0-100) there --
//      never their verified email/phone
//   4. a client can no longer put email/phone/commissionRate onto the
//      public users document at create or update time
//   5. the public agent document stays readable by a guest (agent.html,
//      listing cards) -- the split must not break public profiles
// Run with `npm run test:rules`.
import { before, after, beforeEach, describe, it } from 'node:test';
import { assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { doc, setDoc, updateDoc, getDoc, getDocs, collectionGroup } from 'firebase/firestore';
import { makeTestEnv, seed, dbFor } from './helpers.mjs';

let testEnv;
const ADMIN = 'admin-uid';
const AGENT = 'agent-uid';
const OTHER = 'other-uid';
const CUSTOMER = 'customer-uid';

before(async () => { testEnv = await makeTestEnv(); });
after(async () => { await testEnv.cleanup(); });
beforeEach(async () => {
  await testEnv.clearFirestore();
  await seed(testEnv, async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'users', ADMIN), { role: 'admin', createdAt: 1 });
    await setDoc(doc(db, 'users', AGENT), { role: 'agent', displayName: 'Agent A', companyId: 'co-1', createdAt: 1 });
    await setDoc(doc(db, 'users', AGENT, 'privateProfile', 'main'), { email: 'agent@example.com', phone: '+9647500000001', commissionRate: 2, emailVerified: true });
    await setDoc(doc(db, 'users', OTHER), { role: 'customer', createdAt: 1 });
    await setDoc(doc(db, 'users', CUSTOMER), { role: 'customer', createdAt: 1 });
    await setDoc(doc(db, 'users', CUSTOMER, 'privateProfile', 'main'), { email: 'customer@example.com', phone: '+9647500000002' });
  });
});

describe('U1 / privateProfile read access', () => {
  it('a guest can read the public agent document but NOT its private profile', async () => {
    const db = dbFor(testEnv, null);
    const pub = await assertSucceeds(getDoc(doc(db, 'users', AGENT)));
    if (!pub.exists() || pub.data().displayName !== 'Agent A') throw new Error('public agent doc should still be readable');
    await assertFails(getDoc(doc(db, 'users', AGENT, 'privateProfile', 'main')));
  });
  it('another signed-in user cannot read an agent\'s private profile', async () => {
    await assertFails(getDoc(doc(dbFor(testEnv, OTHER), 'users', AGENT, 'privateProfile', 'main')));
  });
  it('the owner and an admin can read it', async () => {
    await assertSucceeds(getDoc(doc(dbFor(testEnv, AGENT), 'users', AGENT, 'privateProfile', 'main')));
    await assertSucceeds(getDoc(doc(dbFor(testEnv, ADMIN), 'users', AGENT, 'privateProfile', 'main')));
  });
  it('the admin dashboard\'s collection-group query works for an admin only', async () => {
    const snap = await assertSucceeds(getDocs(collectionGroup(dbFor(testEnv, ADMIN), 'privateProfile')));
    if (snap.size !== 2) throw new Error(`expected 2 private profiles, got ${snap.size}`);
    await assertFails(getDocs(collectionGroup(dbFor(testEnv, AGENT), 'privateProfile')));
    await assertFails(getDocs(collectionGroup(dbFor(testEnv, null), 'privateProfile')));
  });
});

describe('U1 / privateProfile writes', () => {
  it('the owner may update commissionRate (0-100) and nothing else', async () => {
    const db = dbFor(testEnv, AGENT);
    await assertSucceeds(updateDoc(doc(db, 'users', AGENT, 'privateProfile', 'main'), { commissionRate: 3.5, updatedAt: 2 }));
    await assertFails(updateDoc(doc(db, 'users', AGENT, 'privateProfile', 'main'), { commissionRate: 150 }));
    await assertFails(updateDoc(doc(db, 'users', AGENT, 'privateProfile', 'main'), { email: 'new@example.com' }));
    await assertFails(updateDoc(doc(db, 'users', AGENT, 'privateProfile', 'main'), { emailVerified: false }));
  });
  it('an owner without a private document yet (pre-migration account) can create it with commissionRate only', async () => {
    await seed(testEnv, async (ctx) => { await setDoc(doc(ctx.firestore(), 'users', 'agent-b'), { role: 'agent', createdAt: 1 }); });
    const db = dbFor(testEnv, 'agent-b');
    await assertSucceeds(setDoc(doc(db, 'users', 'agent-b', 'privateProfile', 'main'), { commissionRate: 2, updatedAt: 1 }));
    await assertFails(setDoc(doc(db, 'users', 'agent-b', 'privateProfile', 'other'), { commissionRate: 2 }));
    await assertFails(setDoc(doc(db, 'users', 'agent-b', 'privateProfile', 'main'), { commissionRate: 2, email: 'x@example.com' }));
  });
  it('another user cannot write to an agent\'s private profile; an admin can', async () => {
    await assertFails(updateDoc(doc(dbFor(testEnv, OTHER), 'users', AGENT, 'privateProfile', 'main'), { commissionRate: 1 }));
    await assertSucceeds(setDoc(doc(dbFor(testEnv, ADMIN), 'users', AGENT, 'privateProfile', 'main'), { email: 'agent@example.com', phone: '+9647500000001', emailVerified: true }, { merge: true }));
  });
});

describe('U1 / public users document can no longer carry private fields (client side)', () => {
  it('a signup self-create with email/phone on the public document is rejected; without them it succeeds', async () => {
    const db = dbFor(testEnv, 'new-uid');
    await assertFails(setDoc(doc(db, 'users', 'new-uid'), { role: 'customer', email: 'new@example.com', createdAt: 1 }));
    await assertFails(setDoc(doc(db, 'users', 'new-uid'), { role: 'customer', phone: '+964750', createdAt: 1 }));
    await assertSucceeds(setDoc(doc(db, 'users', 'new-uid'), { role: 'customer', displayName: 'New', accountType: 'individual_customer', createdAt: 1 }));
  });
  it('an agent cannot put commissionRate back onto their public document', async () => {
    await assertFails(updateDoc(doc(dbFor(testEnv, AGENT), 'users', AGENT), { commissionRate: 2 }));
    await assertSucceeds(updateDoc(doc(dbFor(testEnv, AGENT), 'users', AGENT), { displayName: 'Agent A.' }));
  });
});
