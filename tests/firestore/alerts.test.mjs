// Property Watch / Area Alerts -- Firestore Rules regression tests.
// Run with `npm run test:rules` (real emulator, never production).
//
// WHAT THESE PROVE
// -----------------
// A saved alert, its matches and a user's notifications are exactly as
// private as a saved search: owner-read only (plus an admin holding
// alerts.review for areaAlerts/areaAlertMatches -- the rare support
// case; notifications get no admin exception at all, since nobody else
// legitimately needs to read what someone's bell shows them). None of
// the three collections is ever client-writable -- not by an ordinary
// user, not by the record's own owner, not by an admin session -- since
// the whole point of app/alerts/alerts_ops.py being the only writer is
// that "an admin could do it from a browser" would defeat it.
import { before, after, beforeEach, describe, it } from 'node:test';
import { assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { doc, setDoc, updateDoc, deleteDoc, getDoc } from 'firebase/firestore';
import { makeTestEnv, seed, dbFor } from './helpers.mjs';

let testEnv;

const ALICE = 'alice-uid';        // owns the alert/match/notification
const BOB = 'bob-uid';            // another ordinary user
const ADMIN = 'admin-uid';        // admin WITH alerts.review
const WEAK_ADMIN = 'weak-admin';  // admin WITHOUT alerts.review

before(async () => { testEnv = await makeTestEnv(); });
after(async () => { await testEnv.cleanup(); });

beforeEach(async () => {
  await testEnv.clearFirestore();
  await seed(testEnv, async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'users', ALICE), { role: 'customer', accountType: 'individual_customer' });
    await setDoc(doc(db, 'users', BOB), { role: 'customer', accountType: 'individual_customer' });
    await setDoc(doc(db, 'users', ADMIN), { role: 'admin', accountType: 'admin' });
    await setDoc(doc(db, 'users', WEAK_ADMIN), {
      role: 'admin',
      accountType: 'admin',
      permissionOverrides: { 'alerts.review': false },
    });
    await setDoc(doc(db, 'rolePermissionDefaults', 'admin'), {
      permissions: { 'alerts.review': true },
    });
  });
});

// =====================================================================
describe('areaAlerts -- owner or alerts.review read, never client-written', () => {
  beforeEach(async () => {
    await seed(testEnv, async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'areaAlerts', 'alert1'), {
        uid: ALICE, name: 'My alert', status: 'active',
        area: { type: 'city', city: 'Erbil' }, filters: {},
      });
    });
  });

  it('the owner can read their own alert', async () => {
    await assertSucceeds(getDoc(doc(dbFor(testEnv, ALICE), 'areaAlerts', 'alert1')));
  });

  it('another user cannot read someone else\'s alert', async () => {
    await assertFails(getDoc(doc(dbFor(testEnv, BOB), 'areaAlerts', 'alert1')));
  });

  it('an admin WITH alerts.review can read any alert', async () => {
    await assertSucceeds(getDoc(doc(dbFor(testEnv, ADMIN), 'areaAlerts', 'alert1')));
  });

  it('an admin WITHOUT alerts.review cannot read someone else\'s alert', async () => {
    await assertFails(getDoc(doc(dbFor(testEnv, WEAK_ADMIN), 'areaAlerts', 'alert1')));
  });

  it('an alert is never client-written -- not by its own owner, not by an admin', async () => {
    await assertFails(updateDoc(doc(dbFor(testEnv, ALICE), 'areaAlerts', 'alert1'), { status: 'paused' }));
    await assertFails(deleteDoc(doc(dbFor(testEnv, ADMIN), 'areaAlerts', 'alert1')));
    await assertFails(setDoc(doc(dbFor(testEnv, ALICE), 'areaAlerts', 'forged'), { uid: ALICE, status: 'active' }));
  });
});

// =====================================================================
describe('areaAlertMatches -- owner or alerts.review read, never client-written', () => {
  beforeEach(async () => {
    await seed(testEnv, async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'areaAlertMatches', 'match1'), {
        uid: ALICE, alertId: 'alert1', listingId: 'listing1', city: 'Erbil',
      });
    });
  });

  it('the owner can read their own match', async () => {
    await assertSucceeds(getDoc(doc(dbFor(testEnv, ALICE), 'areaAlertMatches', 'match1')));
  });

  it('another user cannot read someone else\'s match', async () => {
    await assertFails(getDoc(doc(dbFor(testEnv, BOB), 'areaAlertMatches', 'match1')));
  });

  it('an admin WITH alerts.review can read any match', async () => {
    await assertSucceeds(getDoc(doc(dbFor(testEnv, ADMIN), 'areaAlertMatches', 'match1')));
  });

  it('an admin WITHOUT alerts.review cannot read someone else\'s match', async () => {
    await assertFails(getDoc(doc(dbFor(testEnv, WEAK_ADMIN), 'areaAlertMatches', 'match1')));
  });

  it('a match is never client-written -- not by its own owner, not by an admin', async () => {
    await assertFails(updateDoc(doc(dbFor(testEnv, ALICE), 'areaAlertMatches', 'match1'), { viewedAt: new Date() }));
    await assertFails(deleteDoc(doc(dbFor(testEnv, ADMIN), 'areaAlertMatches', 'match1')));
  });
});

// =====================================================================
describe('notifications -- owner-only read, no admin exception, never client-written', () => {
  beforeEach(async () => {
    await seed(testEnv, async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'notifications', 'notif1'), {
        uid: ALICE, type: 'area_alert_match', read: false,
        payload: { alertId: 'alert1', matchCount: 1 },
      });
    });
  });

  it('the owner can read their own notification', async () => {
    await assertSucceeds(getDoc(doc(dbFor(testEnv, ALICE), 'notifications', 'notif1')));
  });

  it('another user cannot read someone else\'s notification', async () => {
    await assertFails(getDoc(doc(dbFor(testEnv, BOB), 'notifications', 'notif1')));
  });

  it('an admin WITH alerts.review still cannot read someone else\'s notification -- no admin exception exists', async () => {
    await assertFails(getDoc(doc(dbFor(testEnv, ADMIN), 'notifications', 'notif1')));
  });

  it('a notification is never client-written -- not even to mark it read', async () => {
    await assertFails(updateDoc(doc(dbFor(testEnv, ALICE), 'notifications', 'notif1'), { read: true }));
    await assertFails(deleteDoc(doc(dbFor(testEnv, ALICE), 'notifications', 'notif1')));
  });
});
