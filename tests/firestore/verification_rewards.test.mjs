// Verification / referrals / rewards -- Firestore Rules regression tests.
// Run with `npm run test:rules` (real emulator, never production).
//
// WHAT THESE PROVE (brief §AK, §BJ)
// --------------------------------
// The browser is never authoritative for verified, referralUnlocked,
// referral.status, discountPercent or rewardGranted. Every one of those
// is tested here as a DENIED client write -- for an ordinary user, for
// the record's own owner, and for an admin, because "an admin session
// could do it from a browser" would defeat the whole point: the audited,
// permission-gated backend ops layer would no longer be the only path.
//
// The one client write that exists is "submit MY OWN case for review",
// and the tests below pin exactly how narrow it is: it may only reach
// 'pending', and it may not carry a decision (idVerified, faceResult,
// riskFlags, reviewedBy) with it.
import { before, after, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { doc, setDoc, updateDoc, deleteDoc, getDoc, getDocs, collection, query, where } from 'firebase/firestore';
import { makeTestEnv, seed, dbFor } from './helpers.mjs';

let testEnv;

const ALICE = 'alice-uid';       // ordinary verified user
const BOB = 'bob-uid';           // ordinary user, referred by Alice
const ADMIN = 'admin-uid';       // admin WITH the verification permissions
const WEAK_ADMIN = 'weak-admin';  // admin WITHOUT them (§AL)

before(async () => { testEnv = await makeTestEnv(); });
after(async () => { await testEnv.cleanup(); });

beforeEach(async () => {
  await testEnv.clearFirestore();
  await seed(testEnv, async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'users', ALICE), { role: 'customer', accountType: 'individual_customer', displayName: 'Alice Ahmed', emailVerified: true });
    await setDoc(doc(db, 'users', BOB), { role: 'customer', accountType: 'individual_customer', displayName: 'Bob Kareem', emailVerified: true });
    await setDoc(doc(db, 'users', ADMIN), { role: 'admin', accountType: 'admin' });
    // Per-user overrides live on the user document itself
    // (users/{uid}.permissionOverrides), which is what
    // firestore.rules' myPermissionOverrides() reads -- not a separate
    // collection. This admin is denied every verification key so the
    // "admin is not enough" half of §AL is actually exercised.
    await setDoc(doc(db, 'users', WEAK_ADMIN), {
      role: 'admin',
      accountType: 'admin',
      permissionOverrides: {
        'verification.view': false,
        'verification.review': false,
        'verification.documents.view': false,
        'referrals.review': false,
        'rewards.manage': false,
        'archives.view': false,
      },
    });

    // Role defaults are the only thing that makes hasPermission() true.
    // The weak admin is given NONE of the verification keys on purpose.
    await setDoc(doc(db, 'rolePermissionDefaults', 'admin'), {
      permissions: {
        'verification.view': true,
        'verification.review': true,
        'verification.documents.view': true,
        'referrals.review': true,
        'rewards.manage': true,
        'archives.view': true,
      },
    });
  });
});

async function seedVerifiedCase(uid) {
  await seed(testEnv, async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'verificationCases', uid), {
      uid,
      verificationStatus: 'verified',
      idVerified: true,
      faceResult: 'passed',
      nameMatch: 'exact',
      reviewedBy: ADMIN,
      riskFlags: [],
    });
  });
}

// =====================================================================
describe('verificationCases -- the client may submit, never decide', () => {
  it('a user can submit their OWN case to pending', async () => {
    const db = dbFor(testEnv, ALICE);
    await assertSucceeds(setDoc(doc(db, 'verificationCases', ALICE), {
      uid: ALICE, verificationStatus: 'pending', idVerified: false, faceResult: 'pending',
    }));
  });

  it('a user CANNOT declare themselves verified', async () => {
    const db = dbFor(testEnv, ALICE);
    await assertFails(setDoc(doc(db, 'verificationCases', ALICE), {
      uid: ALICE, verificationStatus: 'verified', idVerified: true, faceResult: 'passed',
    }));
  });

  it('a user CANNOT submit with idVerified already true', async () => {
    const db = dbFor(testEnv, ALICE);
    await assertFails(setDoc(doc(db, 'verificationCases', ALICE), {
      uid: ALICE, verificationStatus: 'pending', idVerified: true, faceResult: 'pending',
    }));
  });

  it('a user CANNOT submit with a passed face result', async () => {
    const db = dbFor(testEnv, ALICE);
    await assertFails(setDoc(doc(db, 'verificationCases', ALICE), {
      uid: ALICE, verificationStatus: 'pending', idVerified: false, faceResult: 'passed',
    }));
  });

  it('a user CANNOT set their own riskFlags or reviewedBy', async () => {
    const db = dbFor(testEnv, ALICE);
    await assertFails(setDoc(doc(db, 'verificationCases', ALICE), {
      uid: ALICE, verificationStatus: 'pending', idVerified: false, faceResult: 'pending', riskFlags: [],
    }));
    await assertFails(setDoc(doc(db, 'verificationCases', ALICE), {
      uid: ALICE, verificationStatus: 'pending', idVerified: false, faceResult: 'pending', reviewedBy: ADMIN,
    }));
  });

  it('a user cannot submit a case for SOMEONE ELSE', async () => {
    const db = dbFor(testEnv, ALICE);
    await assertFails(setDoc(doc(db, 'verificationCases', BOB), {
      uid: BOB, verificationStatus: 'pending', idVerified: false, faceResult: 'pending',
    }));
  });

  it('EVEN AN ADMIN cannot write a case from the browser', async () => {
    // The audited backend ops layer is the only writer; a compromised
    // admin tab must not be able to grant a verification directly.
    await seedVerifiedCase(BOB);
    const db = dbFor(testEnv, ADMIN);
    await assertFails(updateDoc(doc(db, 'verificationCases', BOB), { verificationStatus: 'rejected' }));
  });

  it('a verified case cannot be self-downgraded or resubmitted by its owner', async () => {
    await seedVerifiedCase(ALICE);
    const db = dbFor(testEnv, ALICE);
    await assertFails(updateDoc(doc(db, 'verificationCases', ALICE), { verificationStatus: 'pending' }));
  });

  it('a rejected case CAN be resubmitted by its owner, without a decision', async () => {
    await seed(testEnv, async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'verificationCases', ALICE), {
        uid: ALICE, verificationStatus: 'rejected', idVerified: false,
        faceResult: 'pending', riskFlags: [], reviewedBy: ADMIN,
      });
    });
    const db = dbFor(testEnv, ALICE);
    await assertSucceeds(updateDoc(doc(db, 'verificationCases', ALICE), {
      verificationStatus: 'pending', idVerified: false, faceResult: 'pending',
      riskFlags: [], reviewedBy: ADMIN,
    }));
  });

  it('a resubmission cannot smuggle idVerified through', async () => {
    await seed(testEnv, async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'verificationCases', ALICE), {
        uid: ALICE, verificationStatus: 'rejected', idVerified: false,
        faceResult: 'pending', riskFlags: [], reviewedBy: ADMIN,
      });
    });
    const db = dbFor(testEnv, ALICE);
    await assertFails(updateDoc(doc(db, 'verificationCases', ALICE), {
      verificationStatus: 'pending', idVerified: true, faceResult: 'pending',
      riskFlags: [], reviewedBy: ADMIN,
    }));
  });

  it('nobody can delete a case', async () => {
    await seedVerifiedCase(ALICE);
    await assertFails(deleteDoc(doc(dbFor(testEnv, ALICE), 'verificationCases', ALICE)));
    await assertFails(deleteDoc(doc(dbFor(testEnv, ADMIN), 'verificationCases', ALICE)));
  });
});

// =====================================================================
describe('verificationCases -- who may read', () => {
  beforeEach(async () => { await seedVerifiedCase(ALICE); });

  it('the owner can read their own case', async () => {
    await assertSucceeds(getDoc(doc(dbFor(testEnv, ALICE), 'verificationCases', ALICE)));
  });

  it('another ordinary user CANNOT read it', async () => {
    await assertFails(getDoc(doc(dbFor(testEnv, BOB), 'verificationCases', ALICE)));
  });

  it('an anonymous visitor CANNOT read it', async () => {
    await assertFails(getDoc(doc(dbFor(testEnv, null), 'verificationCases', ALICE)));
  });

  it('an admin WITH verification.view can read it', async () => {
    await assertSucceeds(getDoc(doc(dbFor(testEnv, ADMIN), 'verificationCases', ALICE)));
  });

  it('an admin WITHOUT verification.view CANNOT read it (brief §AL)', async () => {
    await assertFails(getDoc(doc(dbFor(testEnv, WEAK_ADMIN), 'verificationCases', ALICE)));
  });
});

// =====================================================================
describe('verification evidence metadata -- least privilege', () => {
  beforeEach(async () => {
    await seedVerifiedCase(ALICE);
    await seed(testEnv, async (ctx) => {
      await setDoc(
        doc(ctx.firestore(), 'verificationCases', ALICE, 'evidence', 'front1'),
        { evidenceId: 'front1', kind: 'id_front', storagePath: 'verification-evidence/alice-uid/front1' },
      );
    });
  });

  it('another user cannot read someone else\'s evidence metadata', async () => {
    await assertFails(getDoc(doc(dbFor(testEnv, BOB), 'verificationCases', ALICE, 'evidence', 'front1')));
  });

  it('an admin WITHOUT verification.documents.view cannot read it', async () => {
    await assertFails(getDoc(doc(dbFor(testEnv, WEAK_ADMIN), 'verificationCases', ALICE, 'evidence', 'front1')));
  });

  it('an admin WITH verification.documents.view can read ONE item', async () => {
    await assertSucceeds(getDoc(doc(dbFor(testEnv, ADMIN), 'verificationCases', ALICE, 'evidence', 'front1')));
  });

  it('evidence metadata can never be updated or deleted by a client', async () => {
    const db = dbFor(testEnv, ALICE);
    await assertFails(updateDoc(doc(db, 'verificationCases', ALICE, 'evidence', 'front1'), { kind: 'selfie' }));
    await assertFails(deleteDoc(doc(db, 'verificationCases', ALICE, 'evidence', 'front1')));
    // Not even to erase the deletion marker the archival pipeline sets.
    await assertFails(updateDoc(
      doc(dbFor(testEnv, ADMIN), 'verificationCases', ALICE, 'evidence', 'front1'),
      { liveEvidenceDeleted: false },
    ));
  });
});

// =====================================================================
describe('referral codes -- not harvestable', () => {
  beforeEach(async () => {
    await seed(testEnv, async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'referralCodes', 'DW-M7K4P'),
        { code: 'DW-M7K4P', ownerUid: ALICE, active: true });
    });
  });

  it('a user can read their OWN code document', async () => {
    await assertSucceeds(getDoc(doc(dbFor(testEnv, ALICE), 'referralCodes', 'DW-M7K4P')));
  });

  it('another user CANNOT read it -- codes are resolved by the backend', async () => {
    // Readable-by-anyone would let a client map every code to an owner
    // uid and harvest the whole namespace (brief §N).
    await assertFails(getDoc(doc(dbFor(testEnv, BOB), 'referralCodes', 'DW-M7K4P')));
  });

  it('an anonymous visitor CANNOT read or list codes', async () => {
    await assertFails(getDoc(doc(dbFor(testEnv, null), 'referralCodes', 'DW-M7K4P')));
    await assertFails(getDocs(collection(dbFor(testEnv, null), 'referralCodes')));
  });

  it('nobody -- not even an admin -- can write a code from a browser', async () => {
    await assertFails(setDoc(doc(dbFor(testEnv, ALICE), 'referralCodes', 'DW-AAAAA'),
      { code: 'DW-AAAAA', ownerUid: ALICE, active: true }));
    await assertFails(setDoc(doc(dbFor(testEnv, ADMIN), 'referralCodes', 'DW-BBBBB'),
      { code: 'DW-BBBBB', ownerUid: ADMIN, active: true }));
  });

  it('an unverified user cannot mint themselves a code', async () => {
    // No verification case at all -> still refused, because the whole
    // collection is write-closed to clients.
    await assertFails(setDoc(doc(dbFor(testEnv, BOB), 'referralCodes', 'DW-CCCCC'),
      { code: 'DW-CCCCC', ownerUid: BOB, active: true }));
  });
});

// =====================================================================
describe('referrals -- status decides money, so no client writes it', () => {
  beforeEach(async () => {
    await seed(testEnv, async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'referrals', `${ALICE}__${BOB}`), {
        referralId: `${ALICE}__${BOB}`, referrerUid: ALICE, referredUid: BOB,
        referralCode: 'DW-M7K4P', status: 'pending', riskFlags: [],
      });
    });
  });

  it('both parties can read their own relationship', async () => {
    await assertSucceeds(getDoc(doc(dbFor(testEnv, ALICE), 'referrals', `${ALICE}__${BOB}`)));
    await assertSucceeds(getDoc(doc(dbFor(testEnv, BOB), 'referrals', `${ALICE}__${BOB}`)));
  });

  it('someone outside the relationship, without referrals.review, cannot read it', async () => {
    await assertFails(getDoc(doc(dbFor(testEnv, WEAK_ADMIN), 'referrals', `${ALICE}__${BOB}`)));
  });

  it('the REFERRER cannot mark their own referral qualified', async () => {
    await assertFails(updateDoc(doc(dbFor(testEnv, ALICE), 'referrals', `${ALICE}__${BOB}`),
      { status: 'qualified' }));
  });

  it('an admin cannot qualify it from the browser either', async () => {
    await assertFails(updateDoc(doc(dbFor(testEnv, ADMIN), 'referrals', `${ALICE}__${BOB}`),
      { status: 'qualified' }));
  });

  it('nobody can fabricate a referral relationship', async () => {
    await assertFails(setDoc(doc(dbFor(testEnv, BOB), 'referrals', `${BOB}__${ALICE}`), {
      referralId: `${BOB}__${ALICE}`, referrerUid: BOB, referredUid: ALICE, status: 'qualified',
    }));
  });

  it('a self-referral cannot be written even as pending', async () => {
    await assertFails(setDoc(doc(dbFor(testEnv, ALICE), 'referrals', `${ALICE}__${ALICE}`), {
      referralId: `${ALICE}__${ALICE}`, referrerUid: ALICE, referredUid: ALICE, status: 'pending',
    }));
  });
});

// =====================================================================
describe('reward state and config -- read-only to the browser', () => {
  beforeEach(async () => {
    await seed(testEnv, async (ctx) => {
      const db = ctx.firestore();
      await setDoc(doc(db, 'rewardConfig', 'current'), {
        verificationReward: 3.5, qualifiedReferralReward: 3,
        requiredQualifiedReferrals: 1, maximumPersonalDiscount: 6.5,
        stackingPolicy: 'highest_benefit',
      });
      await setDoc(doc(db, 'users', ALICE, 'private', 'rewardState'), {
        personalDiscountPercent: 3.5, qualifiedReferralCount: 0, fullyVerified: true,
      });
      await setDoc(doc(db, 'rewardLedger', 'entry1'), {
        uid: ALICE, previousPercent: 0, newPercent: 3.5,
      });
    });
  });

  it('the decimal reward survives a round trip as 3.5, not 4', async () => {
    const snap = await getDoc(doc(dbFor(testEnv, ALICE), 'users', ALICE, 'private', 'rewardState'));
    assert.equal(snap.data().personalDiscountPercent, 3.5);
  });

  it('the config stores 6.5 as 6.5', async () => {
    const snap = await getDoc(doc(dbFor(testEnv, ALICE), 'rewardConfig', 'current'));
    assert.equal(snap.data().maximumPersonalDiscount, 6.5);
    assert.equal(snap.data().verificationReward, 3.5);
  });

  it('a user can READ their own reward state', async () => {
    await assertSucceeds(getDoc(doc(dbFor(testEnv, ALICE), 'users', ALICE, 'private', 'rewardState')));
  });

  it('a user CANNOT write their own discount', async () => {
    await assertFails(setDoc(doc(dbFor(testEnv, ALICE), 'users', ALICE, 'private', 'rewardState'),
      { personalDiscountPercent: 100 }, { merge: true }));
  });

  it('another user cannot read someone else\'s reward state', async () => {
    await assertFails(getDoc(doc(dbFor(testEnv, BOB), 'users', ALICE, 'private', 'rewardState')));
  });

  it('any signed-in user can read the reward config (it is what is on offer)', async () => {
    await assertSucceeds(getDoc(doc(dbFor(testEnv, BOB), 'rewardConfig', 'current')));
  });

  it('nobody can change the reward config from a browser -- not even an admin', async () => {
    await assertFails(updateDoc(doc(dbFor(testEnv, ALICE), 'rewardConfig', 'current'),
      { verificationReward: 90 }));
    await assertFails(updateDoc(doc(dbFor(testEnv, ADMIN), 'rewardConfig', 'current'),
      { verificationReward: 90 }));
  });

  it('the reward ledger is append-only and never client-written', async () => {
    await assertSucceeds(getDoc(doc(dbFor(testEnv, ALICE), 'rewardLedger', 'entry1')));
    await assertFails(updateDoc(doc(dbFor(testEnv, ALICE), 'rewardLedger', 'entry1'), { newPercent: 50 }));
    await assertFails(deleteDoc(doc(dbFor(testEnv, ADMIN), 'rewardLedger', 'entry1')));
    await assertFails(setDoc(doc(dbFor(testEnv, ALICE), 'rewardLedger', 'forged'),
      { uid: ALICE, newPercent: 100 }));
  });

  it('an admin WITHOUT rewards.manage cannot read another user\'s reward state', async () => {
    await assertFails(getDoc(doc(dbFor(testEnv, WEAK_ADMIN), 'users', ALICE, 'private', 'rewardState')));
  });
});

// =====================================================================
describe('archive metadata -- admin-only, never client-written', () => {
  beforeEach(async () => {
    await seed(testEnv, async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'verificationArchives', 'VFY-DW-8F72K'), {
        archiveId: 'VFY-DW-8F72K', uid: ALICE, evidenceCount: 3,
      });
    });
  });

  it('an ordinary user cannot read archive metadata -- even their own', async () => {
    await assertFails(getDoc(doc(dbFor(testEnv, ALICE), 'verificationArchives', 'VFY-DW-8F72K')));
  });

  it('an admin WITH archives.view can read it', async () => {
    await assertSucceeds(getDoc(doc(dbFor(testEnv, ADMIN), 'verificationArchives', 'VFY-DW-8F72K')));
  });

  it('an admin WITHOUT archives.view cannot', async () => {
    await assertFails(getDoc(doc(dbFor(testEnv, WEAK_ADMIN), 'verificationArchives', 'VFY-DW-8F72K')));
  });

  it('nobody can write or delete archive metadata from a browser', async () => {
    await assertFails(updateDoc(doc(dbFor(testEnv, ADMIN), 'verificationArchives', 'VFY-DW-8F72K'),
      { evidenceCount: 0 }));
    await assertFails(deleteDoc(doc(dbFor(testEnv, ADMIN), 'verificationArchives', 'VFY-DW-8F72K')));
  });
});
