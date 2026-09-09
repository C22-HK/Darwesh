// U5 (launch-readiness) + the account.html "My Requests" tab: both read
// serviceProviders/{id}/requests/{id} documents across every provider at
// once. That can NOT be a client-side collectionGroup('requests') query
// for either the admin's unfiltered view or a customer's own
// customerUid-filtered view:
//   - an ADMIN's unfiltered (or even status-filtered) list is reliably
//     rejected by Cloud Firestore's query-safety check -- the read rule
//     (isAdmin() || own customerUid || owning provider) has OTHER OR
//     branches that stay unconstrained by the query, and Firestore will
//     not grant the list just because ONE branch (isAdmin()) happens to
//     be unconditionally true for this caller. Reproduced reliably here.
//   - a CUSTOMER's own customerUid-filtered list is the textbook-safe
//     shape (an equality filter on exactly the field the rule compares
//     against request.auth.uid), and was observed to pass in isolation
//     -- but flipped to "No matching allow statements" once run
//     alongside the rest of this repo's rules suite, with an unchanged
//     rules file in between. That is not conclusively a rules defect
//     (it may be an artifact of this local emulator's list-safety
//     analysis under load), but it is not something to build a real
//     "see my own data" feature on, so it is not asserted here as a
//     passing case, and the app does not rely on it -- both views now go
//     through PermissionOps.list_service_requests (Admin SDK), scoped
//     in Python from the caller's verified identity. See that method's
//     own docstring and js/backend-api.js's listServiceRequests.
//
// What THIS file still proves, reliably, as a regression guard: the
// underlying rule keeps denying every read shape the app does NOT rely
// on, so a future change can't quietly widen client access to this
// collection without a rules test noticing.
// Run with `npm run test:rules`.
import { before, after, beforeEach, describe, it } from 'node:test';
import { assertFails } from '@firebase/rules-unit-testing';
import { setDoc, doc, collection, getDocs, collectionGroup, query, where, orderBy } from 'firebase/firestore';
import { makeTestEnv, seed, dbFor } from './helpers.mjs';

let testEnv;
const ADMIN = 'admin-uid';
const CUSTOMER_A = 'customer-a-uid';
const CUSTOMER_B = 'customer-b-uid';
const PROVIDER_1 = 'provider-1-uid';
const PROVIDER_2 = 'provider-2-uid';

before(async () => { testEnv = await makeTestEnv(); });
after(async () => { await testEnv.cleanup(); });
beforeEach(async () => {
  await testEnv.clearFirestore();
  await seed(testEnv, async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'users', ADMIN), { role: 'admin', createdAt: 1 });
    await setDoc(doc(db, 'serviceProviders', PROVIDER_1), { serviceType: 'engineer', providerType: 'individual', ownerId: PROVIDER_1, displayName: 'Provider One', verified: false, createdAt: 1 });
    await setDoc(doc(db, 'serviceProviders', PROVIDER_2), { serviceType: 'cleaning', providerType: 'individual', ownerId: PROVIDER_2, displayName: 'Provider Two', verified: false, createdAt: 1 });
    await setDoc(doc(db, 'serviceProviders', PROVIDER_1, 'requests', 'req-a1'), { customerUid: CUSTOMER_A, status: 'pending', message: 'Need a quote', createdAt: 2 });
    await setDoc(doc(db, 'serviceProviders', PROVIDER_2, 'requests', 'req-a2'), { customerUid: CUSTOMER_A, status: 'accepted', message: 'Deep clean please', createdAt: 3 });
    await setDoc(doc(db, 'serviceProviders', PROVIDER_1, 'requests', 'req-b1'), { customerUid: CUSTOMER_B, status: 'declined', message: 'Foundation check', createdAt: 4 });
  });
});

describe('collectionGroup(\'requests\') client reads stay denied -- neither view is client-side', () => {
  it('even an admin cannot list unfiltered across every provider from the client', async () => {
    const db = dbFor(testEnv, ADMIN);
    await assertFails(getDocs(query(collectionGroup(db, 'requests'), orderBy('createdAt', 'desc'))));
  });
  it('a customer cannot widen the query to read another customer\'s requests', async () => {
    const db = dbFor(testEnv, CUSTOMER_A);
    await assertFails(getDocs(query(collectionGroup(db, 'requests'), where('customerUid', '==', CUSTOMER_B))));
  });
  it('a signed-out visitor gets nothing at all', async () => {
    const db = dbFor(testEnv, null);
    await assertFails(getDocs(query(collectionGroup(db, 'requests'), where('customerUid', '==', CUSTOMER_A))));
  });
  it('the owning provider still only reaches their own subcollection directly (regression: B2 unaffected)', async () => {
    const db = dbFor(testEnv, PROVIDER_1);
    const snap = await getDocs(collection(db, 'serviceProviders', PROVIDER_1, 'requests'));
    if (snap.size !== 2) throw new Error(`expected provider-1 to see exactly their own 2 requests via a direct subcollection read, got ${snap.size}`);
  });
});
