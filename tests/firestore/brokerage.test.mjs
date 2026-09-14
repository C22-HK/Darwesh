// Brokerage Fee Discount system (Phase 1) -- Firestore Rules regression
// tests. Run with `npm run test:rules` (real emulator, never production).
//
// WHAT THESE PROVE
// -----------------
// 1. Field-level split on users/{uid}/privateProfile/main: the owner's
//    existing commissionRate write keeps working (regression) but the
//    four new brokerageDiscount* fields are admin(+brokerage.manage)-
//    write-only -- never the owner, whether written alone or bundled
//    into the SAME call as a commissionRate write.
// 2. brokerageDiscountHistory/brokerageFeeSnapshots are Pattern B:
//    readable only by an admin holding brokerage.manage, and
//    `allow write: if false` for EVERY caller -- including that same
//    admin -- because the only writer that may ever exist is the
//    backend's Admin SDK (app.brokerage.brokerage_ops).
import { before, after, beforeEach, describe, it } from 'node:test';
import { assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { doc, setDoc, updateDoc, getDoc } from 'firebase/firestore';
import { makeTestEnv, seed, dbFor } from './helpers.mjs';

let testEnv;

const ALICE = 'alice-uid';              // owns the privateProfile/main doc
const BOB = 'bob-uid';                  // another ordinary user
const ADMIN_WITH = 'admin-with-uid';    // admin WITH brokerage.manage
const ADMIN_WITHOUT = 'admin-without-uid'; // admin WITHOUT brokerage.manage

before(async () => { testEnv = await makeTestEnv(); });
after(async () => { await testEnv.cleanup(); });

beforeEach(async () => {
  await testEnv.clearFirestore();
  await seed(testEnv, async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'users', ALICE), { role: 'customer', accountType: 'individual_customer' });
    await setDoc(doc(db, 'users', BOB), { role: 'customer', accountType: 'individual_customer' });
    await setDoc(doc(db, 'users', ADMIN_WITH), { role: 'admin', accountType: 'admin' });
    await setDoc(doc(db, 'users', ADMIN_WITHOUT), {
      role: 'admin',
      accountType: 'admin',
      permissionOverrides: { 'brokerage.manage': false },
    });
    await setDoc(doc(db, 'rolePermissionDefaults', 'admin'), {
      permissions: { 'brokerage.manage': true },
    });
  });
});

// =====================================================================
describe('privateProfile/main -- brokerage discount fields are admin(+brokerage.manage)-write-only', () => {
  beforeEach(async () => {
    await seed(testEnv, async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'users', ALICE, 'privateProfile', 'main'), {
        commissionRate: 5,
        updatedAt: new Date(),
      });
    });
  });

  it('the owner can still write commissionRate alone -- unaffected regression check', async () => {
    await assertSucceeds(updateDoc(
      doc(dbFor(testEnv, ALICE), 'users', ALICE, 'privateProfile', 'main'),
      { commissionRate: 12, updatedAt: new Date() },
    ));
  });

  it('the owner cannot write brokerageDiscountPercent alone', async () => {
    await assertFails(updateDoc(
      doc(dbFor(testEnv, ALICE), 'users', ALICE, 'privateProfile', 'main'),
      { brokerageDiscountPercent: 20 },
    ));
  });

  it('the owner cannot write brokerageDiscountActive alone', async () => {
    await assertFails(updateDoc(
      doc(dbFor(testEnv, ALICE), 'users', ALICE, 'privateProfile', 'main'),
      { brokerageDiscountActive: false },
    ));
  });

  it('the owner cannot write brokerageDiscountPercent combined with a commissionRate write in the same call', async () => {
    await assertFails(updateDoc(
      doc(dbFor(testEnv, ALICE), 'users', ALICE, 'privateProfile', 'main'),
      { commissionRate: 12, brokerageDiscountPercent: 20 },
    ));
  });

  it('an admin WITH brokerage.manage CAN write the discount fields', async () => {
    await assertSucceeds(updateDoc(
      doc(dbFor(testEnv, ADMIN_WITH), 'users', ALICE, 'privateProfile', 'main'),
      { brokerageDiscountPercent: 30, brokerageDiscountActive: true, brokerageDiscountUpdatedBy: ADMIN_WITH },
    ));
  });

  it('an admin WITHOUT brokerage.manage cannot write the discount fields', async () => {
    await assertFails(updateDoc(
      doc(dbFor(testEnv, ADMIN_WITHOUT), 'users', ALICE, 'privateProfile', 'main'),
      { brokerageDiscountPercent: 30 },
    ));
  });
});

// =====================================================================
describe('brokerageDiscountHistory -- admin(+brokerage.manage) read only, never client-written', () => {
  beforeEach(async () => {
    await seed(testEnv, async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'brokerageDiscountHistory', 'h1'), {
        uid: ALICE, previousPercent: null, newPercent: 10, previousActive: null, newActive: true,
        action: 'set', changedBy: ADMIN_WITH,
      });
    });
  });

  it('an admin WITH brokerage.manage can read history entries', async () => {
    await assertSucceeds(getDoc(doc(dbFor(testEnv, ADMIN_WITH), 'brokerageDiscountHistory', 'h1')));
  });

  it('a plain admin WITHOUT brokerage.manage cannot read history entries', async () => {
    await assertFails(getDoc(doc(dbFor(testEnv, ADMIN_WITHOUT), 'brokerageDiscountHistory', 'h1')));
  });

  it('a non-admin cannot read history entries at all -- not even the account owner', async () => {
    await assertFails(getDoc(doc(dbFor(testEnv, ALICE), 'brokerageDiscountHistory', 'h1')));
    await assertFails(getDoc(doc(dbFor(testEnv, BOB), 'brokerageDiscountHistory', 'h1')));
  });

  it('history is never client-written -- not by a plain admin, and not even by an admin holding brokerage.manage', async () => {
    await assertFails(updateDoc(doc(dbFor(testEnv, ADMIN_WITHOUT), 'brokerageDiscountHistory', 'h1'), { reason: 'tampered' }));
    await assertFails(updateDoc(doc(dbFor(testEnv, ADMIN_WITH), 'brokerageDiscountHistory', 'h1'), { reason: 'tampered' }));
    await assertFails(setDoc(doc(dbFor(testEnv, ADMIN_WITH), 'brokerageDiscountHistory', 'forged'), {
      uid: ALICE, newPercent: 100, action: 'set', changedBy: ADMIN_WITH,
    }));
  });
});

// =====================================================================
describe('brokerageFeeSnapshots -- admin(+brokerage.manage) read only, never client-written', () => {
  beforeEach(async () => {
    await seed(testEnv, async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'brokerageFeeSnapshots', 's1'), {
        uid: ALICE, originalFee: 1000, currency: 'USD', discountPercent: 30, discountAmount: 300, finalFee: 700,
        computedBy: ADMIN_WITH,
      });
    });
  });

  it('an admin WITH brokerage.manage can read a fee snapshot', async () => {
    await assertSucceeds(getDoc(doc(dbFor(testEnv, ADMIN_WITH), 'brokerageFeeSnapshots', 's1')));
  });

  it('a plain admin WITHOUT brokerage.manage cannot read a fee snapshot', async () => {
    await assertFails(getDoc(doc(dbFor(testEnv, ADMIN_WITHOUT), 'brokerageFeeSnapshots', 's1')));
  });

  it('a non-admin cannot read a fee snapshot at all -- not even the account it was computed for', async () => {
    await assertFails(getDoc(doc(dbFor(testEnv, ALICE), 'brokerageFeeSnapshots', 's1')));
    await assertFails(getDoc(doc(dbFor(testEnv, BOB), 'brokerageFeeSnapshots', 's1')));
  });

  it('a snapshot is never client-written -- not by a plain admin, and not even by an admin holding brokerage.manage (immutability: only the Admin SDK may ever write one)', async () => {
    await assertFails(updateDoc(doc(dbFor(testEnv, ADMIN_WITHOUT), 'brokerageFeeSnapshots', 's1'), { finalFee: 0 }));
    await assertFails(updateDoc(doc(dbFor(testEnv, ADMIN_WITH), 'brokerageFeeSnapshots', 's1'), { finalFee: 0 }));
    await assertFails(setDoc(doc(dbFor(testEnv, ADMIN_WITH), 'brokerageFeeSnapshots', 'forged'), {
      uid: ALICE, originalFee: 1, discountPercent: 100, discountAmount: 1, finalFee: 0, computedBy: ADMIN_WITH,
    }));
  });
});
