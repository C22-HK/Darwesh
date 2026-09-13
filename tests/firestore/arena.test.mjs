// Darwesh Arena -- Firestore Rules regression tests.
// Run with `npm run test:rules` (real emulator, never production).
//
// WHAT THESE PROVE
// -----------------
// Every Arena collection is server-authoritative: points, ranks,
// leaderboard position, challenge/step config, deal stage and commission
// figures are never client-writable -- not for an ordinary user, not for
// the record's own owner/participant, and not for an admin session, since
// "an admin could do it from a browser" would defeat the whole point (the
// audited, transactional app/arena/arena_ops.py backend would no longer be
// the only path in). Public-read collections (challenges, ranks,
// leaderboard, activity feed, config) are readable by anyone, including
// signed-out visitors, because they are the browsable/competitive surface.
// Everything privacy-sensitive (owner info, buyer info) is scoped to a
// reviewer-only `private` subcollection, never the parent doc.
import { before, after, beforeEach, describe, it } from 'node:test';
import { assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { doc, setDoc, updateDoc, deleteDoc, getDoc, getDocs, collection } from 'firebase/firestore';
import { makeTestEnv, seed, dbFor } from './helpers.mjs';

let testEnv;

const ALICE = 'alice-uid';        // an ordinary participant
const BOB = 'bob-uid';            // another ordinary user, not a participant
const ADMIN = 'admin-uid';        // admin WITH arena.review + arena.manage
const REVIEW_ONLY = 'review-uid'; // admin WITH arena.review only
const WEAK_ADMIN = 'weak-admin';  // admin WITHOUT either arena permission

before(async () => { testEnv = await makeTestEnv(); });
after(async () => { await testEnv.cleanup(); });

beforeEach(async () => {
  await testEnv.clearFirestore();
  await seed(testEnv, async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'users', ALICE), { role: 'customer', accountType: 'individual_customer' });
    await setDoc(doc(db, 'users', BOB), { role: 'customer', accountType: 'individual_customer' });
    await setDoc(doc(db, 'users', ADMIN), { role: 'admin', accountType: 'admin' });
    await setDoc(doc(db, 'users', REVIEW_ONLY), {
      role: 'admin',
      accountType: 'admin',
      permissionOverrides: { 'arena.manage': false },
    });
    await setDoc(doc(db, 'users', WEAK_ADMIN), {
      role: 'admin',
      accountType: 'admin',
      permissionOverrides: { 'arena.review': false, 'arena.manage': false },
    });
    await setDoc(doc(db, 'rolePermissionDefaults', 'admin'), {
      permissions: { 'arena.review': true, 'arena.manage': true },
    });
  });
});

// =====================================================================
describe('public-readable Arena collections -- browsable by anyone', () => {
  beforeEach(async () => {
    await seed(testEnv, async (ctx) => {
      const db = ctx.firestore();
      await setDoc(doc(db, 'arenaChallenges', 'ch1'), { name: 'Kurdistan Property Challenge', status: 'live' });
      await setDoc(doc(db, 'arenaRanks', 'rank1'), { name: 'Starter', minXp: 0, order: 1 });
      await setDoc(doc(db, 'arenaConfig', 'global'), { seasonActive: false });
      await setDoc(doc(db, 'arenaLeaderboardEntries', ALICE), { uid: ALICE, lifetimeXp: 14 });
      await setDoc(doc(db, 'arenaActivityFeed', 'evt1'), { uid: ALICE, type: 'property_verified' });
    });
  });

  it('a signed-out visitor can read challenges, ranks, config, leaderboard, activity', async () => {
    const db = dbFor(testEnv, null);
    await assertSucceeds(getDoc(doc(db, 'arenaChallenges', 'ch1')));
    await assertSucceeds(getDoc(doc(db, 'arenaRanks', 'rank1')));
    await assertSucceeds(getDoc(doc(db, 'arenaConfig', 'global')));
    await assertSucceeds(getDoc(doc(db, 'arenaLeaderboardEntries', ALICE)));
    await assertSucceeds(getDoc(doc(db, 'arenaActivityFeed', 'evt1')));
  });

  it('nobody -- not even an admin -- can write a challenge, rank, config or leaderboard entry from a browser', async () => {
    const admin = dbFor(testEnv, ADMIN);
    await assertFails(setDoc(doc(admin, 'arenaChallenges', 'ch1'), { name: 'Hacked', status: 'live' }, { merge: true }));
    await assertFails(updateDoc(doc(admin, 'arenaChallenges', 'ch1'), { status: 'ended' }));
    await assertFails(updateDoc(doc(admin, 'arenaRanks', 'rank1'), { minXp: 0 }));
    await assertFails(updateDoc(doc(admin, 'arenaConfig', 'global'), { seasonActive: true }));
    await assertFails(setDoc(doc(dbFor(testEnv, ALICE), 'arenaLeaderboardEntries', ALICE), { lifetimeXp: 999999 }, { merge: true }));
    await assertFails(setDoc(doc(admin, 'arenaActivityFeed', 'forged'), { uid: ALICE, type: 'challenge_completed' }));
  });

  it('nobody can delete a challenge, rank or activity entry from a browser', async () => {
    const admin = dbFor(testEnv, ADMIN);
    await assertFails(deleteDoc(doc(admin, 'arenaChallenges', 'ch1')));
    await assertFails(deleteDoc(doc(admin, 'arenaRanks', 'rank1')));
    await assertFails(deleteDoc(doc(admin, 'arenaActivityFeed', 'evt1')));
  });
});

// =====================================================================
describe('arenaSubmissions -- owner or a reviewer, never a client write', () => {
  beforeEach(async () => {
    await seed(testEnv, async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'arenaSubmissions', 'ch1__' + ALICE), {
        challengeId: 'ch1', participantUid: ALICE, overallStatus: 'in_progress',
      });
      await setDoc(
        doc(ctx.firestore(), 'arenaSubmissions', 'ch1__' + ALICE, 'private', 'ownerInfo'),
        { ownerFullName: 'Alice Ahmed', ownerPhone: '07701234567', ownershipDocUrls: [] },
      );
    });
  });

  it('the owner can read their own submission', async () => {
    await assertSucceeds(getDoc(doc(dbFor(testEnv, ALICE), 'arenaSubmissions', 'ch1__' + ALICE)));
  });

  it('another ordinary user cannot read someone else\'s submission', async () => {
    await assertFails(getDoc(doc(dbFor(testEnv, BOB), 'arenaSubmissions', 'ch1__' + ALICE)));
  });

  it('an anonymous visitor cannot read a submission', async () => {
    await assertFails(getDoc(doc(dbFor(testEnv, null), 'arenaSubmissions', 'ch1__' + ALICE)));
  });

  it('an admin WITH arena.review can read any submission', async () => {
    await assertSucceeds(getDoc(doc(dbFor(testEnv, ADMIN), 'arenaSubmissions', 'ch1__' + ALICE)));
  });

  it('an admin WITHOUT arena.review cannot read someone else\'s submission', async () => {
    await assertFails(getDoc(doc(dbFor(testEnv, WEAK_ADMIN), 'arenaSubmissions', 'ch1__' + ALICE)));
  });

  it('EVEN the owner cannot write their own submission from the browser -- the step engine is backend-only', async () => {
    const db = dbFor(testEnv, ALICE);
    await assertFails(updateDoc(doc(db, 'arenaSubmissions', 'ch1__' + ALICE), { overallStatus: 'completed' }));
    await assertFails(setDoc(doc(db, 'arenaSubmissions', 'ch2__' + ALICE), {
      challengeId: 'ch2', participantUid: ALICE, overallStatus: 'joined',
    }));
  });

  it('an admin cannot write a submission from the browser either', async () => {
    await assertFails(updateDoc(doc(dbFor(testEnv, ADMIN), 'arenaSubmissions', 'ch1__' + ALICE), { overallStatus: 'completed' }));
  });

  it('owner info is reviewer-only -- not even the submission\'s own owner can read it', async () => {
    await assertFails(getDoc(doc(dbFor(testEnv, ALICE), 'arenaSubmissions', 'ch1__' + ALICE, 'private', 'ownerInfo')));
    await assertFails(getDoc(doc(dbFor(testEnv, BOB), 'arenaSubmissions', 'ch1__' + ALICE, 'private', 'ownerInfo')));
  });

  it('an admin WITH arena.review can read owner info; WITHOUT it cannot', async () => {
    await assertSucceeds(getDoc(doc(dbFor(testEnv, ADMIN), 'arenaSubmissions', 'ch1__' + ALICE, 'private', 'ownerInfo')));
    await assertFails(getDoc(doc(dbFor(testEnv, WEAK_ADMIN), 'arenaSubmissions', 'ch1__' + ALICE, 'private', 'ownerInfo')));
  });

  it('owner info can never be written or deleted from a browser', async () => {
    const admin = dbFor(testEnv, ADMIN);
    await assertFails(updateDoc(doc(admin, 'arenaSubmissions', 'ch1__' + ALICE, 'private', 'ownerInfo'), { ownerPhone: '000' }));
    await assertFails(deleteDoc(doc(admin, 'arenaSubmissions', 'ch1__' + ALICE, 'private', 'ownerInfo')));
  });
});

// =====================================================================
describe('arenaLedger -- append-only point history, owner or arena.manage read', () => {
  beforeEach(async () => {
    await seed(testEnv, async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'arenaLedger', 'entry1'), {
        uid: ALICE, pointsDelta: 3, reason: 'step_completed',
      });
    });
  });

  it('the owner can read their own ledger entry', async () => {
    await assertSucceeds(getDoc(doc(dbFor(testEnv, ALICE), 'arenaLedger', 'entry1')));
  });

  it('another user cannot read someone else\'s ledger entry', async () => {
    await assertFails(getDoc(doc(dbFor(testEnv, BOB), 'arenaLedger', 'entry1')));
  });

  it('an admin WITH arena.manage can read any ledger entry', async () => {
    await assertSucceeds(getDoc(doc(dbFor(testEnv, ADMIN), 'arenaLedger', 'entry1')));
  });

  it('an admin WITH only arena.review (not arena.manage) cannot read someone else\'s ledger entry', async () => {
    await assertFails(getDoc(doc(dbFor(testEnv, REVIEW_ONLY), 'arenaLedger', 'entry1')));
  });

  it('the ledger is never client-written -- not by its own owner, not by an admin', async () => {
    await assertFails(updateDoc(doc(dbFor(testEnv, ALICE), 'arenaLedger', 'entry1'), { pointsDelta: 999 }));
    await assertFails(deleteDoc(doc(dbFor(testEnv, ADMIN), 'arenaLedger', 'entry1')));
    await assertFails(setDoc(doc(dbFor(testEnv, ALICE), 'arenaLedger', 'forged'), { uid: ALICE, pointsDelta: 100000 }));
  });
});

// =====================================================================
describe('users/{uid}/private/arenaState -- recomputed cache, never client-written', () => {
  beforeEach(async () => {
    await seed(testEnv, async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'users', ALICE, 'private', 'arenaState'), {
        lifetimeXp: 14, currentRankId: 'starter', currentRankOrder: 1,
      });
    });
  });

  it('the owner can read their own arena state', async () => {
    await assertSucceeds(getDoc(doc(dbFor(testEnv, ALICE), 'users', ALICE, 'private', 'arenaState')));
  });

  it('another user cannot read someone else\'s arena state', async () => {
    await assertFails(getDoc(doc(dbFor(testEnv, BOB), 'users', ALICE, 'private', 'arenaState')));
  });

  it('an admin WITH arena.manage can read any user\'s arena state', async () => {
    await assertSucceeds(getDoc(doc(dbFor(testEnv, ADMIN), 'users', ALICE, 'private', 'arenaState')));
  });

  it('an admin WITHOUT arena.manage (and without rewards.manage) cannot read it', async () => {
    await assertFails(getDoc(doc(dbFor(testEnv, WEAK_ADMIN), 'users', ALICE, 'private', 'arenaState')));
  });

  it('a user cannot inflate their own lifetimeXp from the browser', async () => {
    await assertFails(setDoc(doc(dbFor(testEnv, ALICE), 'users', ALICE, 'private', 'arenaState'),
      { lifetimeXp: 999999 }, { merge: true }));
  });

  it('not even an admin can write arena state from a browser', async () => {
    await assertFails(updateDoc(doc(dbFor(testEnv, ADMIN), 'users', ALICE, 'private', 'arenaState'), { lifetimeXp: 999999 }));
  });
});

// =====================================================================
describe('arenaDeals -- the buyer/deal CRM, stricter than arenaSubmissions', () => {
  beforeEach(async () => {
    await seed(testEnv, async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'arenaDeals', 'deal1'), {
        challengeId: 'ch1', submissionId: 'ch1__' + ALICE, participantUid: ALICE, stage: 'qualified',
      });
      await setDoc(
        doc(ctx.firestore(), 'arenaDeals', 'deal1', 'private', 'buyerInfo'),
        { buyerName: 'Real Buyer', buyerPhone: '07709876543' },
      );
    });
  });

  it('the participant can read their own deal\'s coarse stage', async () => {
    await assertSucceeds(getDoc(doc(dbFor(testEnv, ALICE), 'arenaDeals', 'deal1')));
  });

  it('another ordinary user cannot read someone else\'s deal', async () => {
    await assertFails(getDoc(doc(dbFor(testEnv, BOB), 'arenaDeals', 'deal1')));
  });

  it('an admin WITH arena.review can read any deal', async () => {
    await assertSucceeds(getDoc(doc(dbFor(testEnv, ADMIN), 'arenaDeals', 'deal1')));
  });

  it('an admin WITHOUT arena.review cannot read someone else\'s deal', async () => {
    await assertFails(getDoc(doc(dbFor(testEnv, WEAK_ADMIN), 'arenaDeals', 'deal1')));
  });

  it('buyer PII is reviewer-only -- not even the deal\'s own participant can read it', async () => {
    await assertFails(getDoc(doc(dbFor(testEnv, ALICE), 'arenaDeals', 'deal1', 'private', 'buyerInfo')));
  });

  it('an admin WITH arena.review can read buyer PII; WITHOUT it cannot', async () => {
    await assertSucceeds(getDoc(doc(dbFor(testEnv, ADMIN), 'arenaDeals', 'deal1', 'private', 'buyerInfo')));
    await assertFails(getDoc(doc(dbFor(testEnv, WEAK_ADMIN), 'arenaDeals', 'deal1', 'private', 'buyerInfo')));
  });

  it('a participant cannot self-advance their own deal to "closed" from the browser', async () => {
    // The whole point of server/admin-controlled qualification and sale
    // verification: not even the deal's own participant may write ANY
    // field on it, closed-stage or otherwise, from a client session.
    await assertFails(updateDoc(doc(dbFor(testEnv, ALICE), 'arenaDeals', 'deal1'), { stage: 'closed', saleValue: 500000 }));
  });

  it('an admin cannot write a deal or its buyer info from the browser either', async () => {
    const admin = dbFor(testEnv, ADMIN);
    await assertFails(updateDoc(doc(admin, 'arenaDeals', 'deal1'), { stage: 'closed' }));
    await assertFails(updateDoc(doc(admin, 'arenaDeals', 'deal1', 'private', 'buyerInfo'), { buyerPhone: '000' }));
    await assertFails(deleteDoc(doc(admin, 'arenaDeals', 'deal1')));
  });
});

// =====================================================================
describe('arenaCommissionRules -- business-sensitive, arena.manage read only', () => {
  beforeEach(async () => {
    await seed(testEnv, async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'arenaCommissionRules', 'Erbil'), {
        city: 'Erbil', minPercent: 1, maxPercent: 3, defaultPercent: 2,
      });
    });
  });

  it('an ordinary participant cannot read commission rules at all', async () => {
    await assertFails(getDoc(doc(dbFor(testEnv, ALICE), 'arenaCommissionRules', 'Erbil')));
  });

  it('a signed-out visitor cannot read or list commission rules', async () => {
    await assertFails(getDoc(doc(dbFor(testEnv, null), 'arenaCommissionRules', 'Erbil')));
    await assertFails(getDocs(collection(dbFor(testEnv, null), 'arenaCommissionRules')));
  });

  it('an admin WITH arena.manage can read commission rules', async () => {
    await assertSucceeds(getDoc(doc(dbFor(testEnv, ADMIN), 'arenaCommissionRules', 'Erbil')));
  });

  it('an admin WITH only arena.review (not arena.manage) cannot read commission rules', async () => {
    await assertFails(getDoc(doc(dbFor(testEnv, REVIEW_ONLY), 'arenaCommissionRules', 'Erbil')));
  });

  it('nobody -- not even an admin WITH arena.manage -- can write commission rules from a browser', async () => {
    const admin = dbFor(testEnv, ADMIN);
    await assertFails(updateDoc(doc(admin, 'arenaCommissionRules', 'Erbil'), { defaultPercent: 50 }));
    await assertFails(setDoc(doc(admin, 'arenaCommissionRules', 'Sulaymaniyah'), { city: 'Sulaymaniyah', defaultPercent: 2.5 }));
    await assertFails(deleteDoc(doc(admin, 'arenaCommissionRules', 'Erbil')));
  });
});
