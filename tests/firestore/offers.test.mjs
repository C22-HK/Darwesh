// Offers & Discounts -- Firestore Rules regression tests for the
// `offers/{offerId}` collection and its admin-only `private/` subcollection.
// Run with `npm run test:rules` (real Firestore emulator, never production).
//
// The security shape being proven here, from the brief:
//   * Public  -- may read ONLY publicly publishable offer information.
//   * Admin   -- may create / edit / publish / pause / archive / delete.
//   * Non-admin (signed in, including agents) -- cannot write offers at all.
//
// Two details worth stating because they are easy to get wrong:
//
// 1. "Publicly publishable" is enforced as `status == 'active'`, not as a
//    field mask. A draft or paused offer is not merely hidden by the UI --
//    it is UNREADABLE, so a curious visitor cannot pull an unannounced
//    promotion out of Firestore ahead of its launch. The tests below prove
//    the denial rather than trusting the client filter.
//
// 2. `createdBy`/`updatedBy`/`createdAt`/`updatedAt` are pinned to the
//    verified token and to `request.time`. That is the "do not trust
//    client-supplied admin identity fields" rule made enforceable: an admin
//    cannot write someone else's uid into the audit trail, and cannot
//    backdate or forward-date a change.
import { before, after, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import {
  doc, setDoc, updateDoc, deleteDoc, getDoc, getDocs, collection,
  query, where, serverTimestamp, Timestamp,
} from 'firebase/firestore';
import { makeTestEnv, seed, dbFor } from './helpers.mjs';

let testEnv;

const ADMIN = 'admin-uid';
const OTHER_ADMIN = 'admin-two-uid';
const AGENT = 'agent-uid';

before(async () => { testEnv = await makeTestEnv(); });
after(async () => { await testEnv.cleanup(); });

beforeEach(async () => {
  await testEnv.clearFirestore();
  await seed(testEnv, async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'users', ADMIN), { role: 'admin', accountType: 'admin' });
    await setDoc(doc(db, 'users', OTHER_ADMIN), { role: 'admin', accountType: 'admin' });
    await setDoc(doc(db, 'users', AGENT), { role: 'agent', accountType: 'agent' });
  });
});

// The full 16-field shape the rules allow, minus the server-controlled
// bits each caller has to supply itself.
function offerBody(overrides = {}) {
  return {
    type: 'brokerage_fee',
    title: 'Scan for {percent}% Off Brokerage Fees',
    description: 'Scan the QR code with your phone camera.',
    discountPercent: 10,
    status: 'draft',
    startAt: null,
    endAt: null,
    ctaLabel: 'View Offer Online',
    ctaUrl: '',
    qrUrl: '',
    promoCode: '',
    terms: 'Valid only on eligible Darwesh brokerage transactions.',
    ...overrides,
  };
}

function createPayload(uid, overrides = {}) {
  return {
    ...offerBody(overrides),
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    createdBy: uid,
    updatedBy: uid,
  };
}

/** Seeds a stored offer directly, bypassing rules (the "already exists"
 *  precondition for read/update/delete tests). */
async function seedOffer(id, overrides = {}) {
  await seed(testEnv, async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'offers', id), {
      ...offerBody(overrides),
      createdAt: Timestamp.fromMillis(1_700_000_000_000),
      updatedAt: Timestamp.fromMillis(1_700_000_000_000),
      createdBy: ADMIN,
      updatedBy: ADMIN,
    });
  });
}

describe('offers/{offerId} -- public read boundary', () => {
  it('an unauthenticated visitor can read an ACTIVE offer', async () => {
    await seedOffer('live', { status: 'active' });
    const db = dbFor(testEnv, null);
    await assertSucceeds(getDoc(doc(db, 'offers', 'live')));
  });

  it('an unauthenticated visitor CANNOT read a draft offer', async () => {
    await seedOffer('secret', { status: 'draft' });
    const db = dbFor(testEnv, null);
    await assertFails(getDoc(doc(db, 'offers', 'secret')));
  });

  it('an unauthenticated visitor CANNOT read a paused offer', async () => {
    await seedOffer('onhold', { status: 'paused' });
    await assertFails(getDoc(doc(dbFor(testEnv, null), 'offers', 'onhold')));
  });

  it('an unauthenticated visitor CANNOT read an archived offer', async () => {
    await seedOffer('gone', { status: 'archived' });
    await assertFails(getDoc(doc(dbFor(testEnv, null), 'offers', 'gone')));
  });

  it("the public banner's status=='active' query is allowed", async () => {
    await seedOffer('live', { status: 'active' });
    await seedOffer('secret', { status: 'draft' });
    const db = dbFor(testEnv, null);
    const snap = await assertSucceeds(
      getDocs(query(collection(db, 'offers'), where('status', '==', 'active'))));
    assert.deepEqual(snap.docs.map((d) => d.id), ['live']);
  });

  it('an unfiltered listing of the whole collection is refused', async () => {
    await seedOffer('live', { status: 'active' });
    await seedOffer('secret', { status: 'draft' });
    await assertFails(getDocs(collection(dbFor(testEnv, null), 'offers')));
  });

  it('an admin can read every offer regardless of status', async () => {
    await seedOffer('secret', { status: 'draft' });
    const db = dbFor(testEnv, ADMIN);
    await assertSucceeds(getDoc(doc(db, 'offers', 'secret')));
    await assertSucceeds(getDocs(collection(db, 'offers')));
  });
});

describe('offers/{offerId} -- write boundary', () => {
  it('an admin can create a valid offer', async () => {
    const db = dbFor(testEnv, ADMIN);
    await assertSucceeds(setDoc(doc(db, 'offers', 'new1'), createPayload(ADMIN)));
  });

  it('an anonymous visitor cannot create an offer', async () => {
    const db = dbFor(testEnv, null);
    await assertFails(setDoc(doc(db, 'offers', 'nope'), createPayload('anything')));
  });

  it('a signed-in non-admin (agent) cannot create an offer', async () => {
    const db = dbFor(testEnv, AGENT);
    await assertFails(setDoc(doc(db, 'offers', 'nope'), createPayload(AGENT)));
  });

  it('a signed-in non-admin cannot edit an existing offer', async () => {
    await seedOffer('live', { status: 'active' });
    const db = dbFor(testEnv, AGENT);
    await assertFails(updateDoc(doc(db, 'offers', 'live'), {
      discountPercent: 90, updatedAt: serverTimestamp(), updatedBy: AGENT,
    }));
  });

  it('a signed-in non-admin cannot publish a draft', async () => {
    await seedOffer('secret', { status: 'draft' });
    const db = dbFor(testEnv, AGENT);
    await assertFails(updateDoc(doc(db, 'offers', 'secret'), {
      status: 'active', updatedAt: serverTimestamp(), updatedBy: AGENT,
    }));
  });

  it('a signed-in non-admin cannot delete an offer', async () => {
    await seedOffer('live', { status: 'active' });
    await assertFails(deleteDoc(doc(dbFor(testEnv, AGENT), 'offers', 'live')));
  });

  it('an admin can publish, pause, archive and delete', async () => {
    await seedOffer('flow', { status: 'draft' });
    const db = dbFor(testEnv, ADMIN);
    const touch = (status) => updateDoc(doc(db, 'offers', 'flow'), {
      status, updatedAt: serverTimestamp(), updatedBy: ADMIN,
    });
    await assertSucceeds(touch('active'));
    await assertSucceeds(touch('paused'));
    await assertSucceeds(touch('archived'));
    await assertSucceeds(deleteDoc(doc(db, 'offers', 'flow')));
  });
});

describe('offers/{offerId} -- percentage validation (brief §2)', () => {
  const cases = [
    ['0 is accepted (a 0% offer is a legitimate, if odd, value)', 0, true],
    ['100 is accepted', 100, true],
    ['15 is accepted', 15, true],
    ['-1 is refused', -1, false],
    ['101 is refused', 101, false],
    ['a fractional percent is refused', 12.5, false],
    ['a string percent is refused', '10', false],
    ['null is refused', null, false],
  ];
  cases.forEach(([name, value, shouldPass], i) => {
    it(name, async () => {
      const db = dbFor(testEnv, ADMIN);
      const write = setDoc(doc(db, 'offers', `pct${i}`),
        createPayload(ADMIN, { discountPercent: value }));
      await (shouldPass ? assertSucceeds(write) : assertFails(write));
    });
  });

  it('an admin cannot update an existing offer to an out-of-range percent', async () => {
    await seedOffer('live', { status: 'active' });
    const db = dbFor(testEnv, ADMIN);
    await assertFails(updateDoc(doc(db, 'offers', 'live'), {
      discountPercent: 150, updatedAt: serverTimestamp(), updatedBy: ADMIN,
    }));
    await assertSucceeds(updateDoc(doc(db, 'offers', 'live'), {
      discountPercent: 12, updatedAt: serverTimestamp(), updatedBy: ADMIN,
    }));
  });
});

describe('offers/{offerId} -- field and shape validation', () => {
  it('an unknown field is refused', async () => {
    const db = dbFor(testEnv, ADMIN);
    await assertFails(setDoc(doc(db, 'offers', 'extra'),
      { ...createPayload(ADMIN), isAdmin: true }));
  });

  it('an unknown offer type is refused', async () => {
    const db = dbFor(testEnv, ADMIN);
    await assertFails(setDoc(doc(db, 'offers', 'badtype'),
      createPayload(ADMIN, { type: 'anything_goes' })));
  });

  it("an unknown status is refused (no inventing 'scheduled' as stored state)", async () => {
    const db = dbFor(testEnv, ADMIN);
    await assertFails(setDoc(doc(db, 'offers', 'badstatus'),
      createPayload(ADMIN, { status: 'scheduled' })));
  });

  it('an empty title is refused', async () => {
    const db = dbFor(testEnv, ADMIN);
    await assertFails(setDoc(doc(db, 'offers', 'notitle'),
      createPayload(ADMIN, { title: '' })));
  });

  it('an oversized title is refused', async () => {
    const db = dbFor(testEnv, ADMIN);
    await assertFails(setDoc(doc(db, 'offers', 'longtitle'),
      createPayload(ADMIN, { title: 'x'.repeat(161) })));
  });

  it('oversized terms are refused', async () => {
    const db = dbFor(testEnv, ADMIN);
    await assertFails(setDoc(doc(db, 'offers', 'longterms'),
      createPayload(ADMIN, { terms: 'x'.repeat(2001) })));
  });

  it('a window that ends before it starts is refused', async () => {
    const db = dbFor(testEnv, ADMIN);
    await assertFails(setDoc(doc(db, 'offers', 'backwards'), createPayload(ADMIN, {
      startAt: Timestamp.fromMillis(2_000_000_000_000),
      endAt: Timestamp.fromMillis(1_000_000_000_000),
    })));
  });

  it('a valid window is accepted', async () => {
    const db = dbFor(testEnv, ADMIN);
    await assertSucceeds(setDoc(doc(db, 'offers', 'window'), createPayload(ADMIN, {
      startAt: Timestamp.fromMillis(1_000_000_000_000),
      endAt: Timestamp.fromMillis(2_000_000_000_000),
    })));
  });
});

describe('offers/{offerId} -- audit fields cannot be forged', () => {
  it('createdBy must be the calling admin, not a uid they typed', async () => {
    const db = dbFor(testEnv, ADMIN);
    await assertFails(setDoc(doc(db, 'offers', 'forged'),
      { ...createPayload(ADMIN), createdBy: OTHER_ADMIN }));
  });

  it('createdAt must be the server clock, not a client timestamp', async () => {
    const db = dbFor(testEnv, ADMIN);
    await assertFails(setDoc(doc(db, 'offers', 'backdated'), {
      ...createPayload(ADMIN),
      createdAt: Timestamp.fromMillis(1_000_000_000_000),
    }));
  });

  it('an update cannot rewrite the original author', async () => {
    await seedOffer('live', { status: 'active' });
    const db = dbFor(testEnv, OTHER_ADMIN);
    await assertFails(updateDoc(doc(db, 'offers', 'live'), {
      createdBy: OTHER_ADMIN, updatedAt: serverTimestamp(), updatedBy: OTHER_ADMIN,
    }));
  });

  it('an update cannot rewrite createdAt', async () => {
    await seedOffer('live', { status: 'active' });
    const db = dbFor(testEnv, ADMIN);
    await assertFails(updateDoc(doc(db, 'offers', 'live'), {
      createdAt: serverTimestamp(), updatedAt: serverTimestamp(), updatedBy: ADMIN,
    }));
  });

  it('a second admin editing becomes updatedBy while createdBy is preserved', async () => {
    await seedOffer('live', { status: 'active' });
    const db = dbFor(testEnv, OTHER_ADMIN);
    await assertSucceeds(updateDoc(doc(db, 'offers', 'live'), {
      discountPercent: 20, updatedAt: serverTimestamp(), updatedBy: OTHER_ADMIN,
    }));
  });

  it('updatedBy must be the caller, not another admin', async () => {
    await seedOffer('live', { status: 'active' });
    const db = dbFor(testEnv, OTHER_ADMIN);
    await assertFails(updateDoc(doc(db, 'offers', 'live'), {
      discountPercent: 20, updatedAt: serverTimestamp(), updatedBy: ADMIN,
    }));
  });

  it('updatedAt must be the server clock', async () => {
    await seedOffer('live', { status: 'active' });
    const db = dbFor(testEnv, ADMIN);
    await assertFails(updateDoc(doc(db, 'offers', 'live'), {
      discountPercent: 20,
      updatedAt: Timestamp.fromMillis(1_000_000_000_000),
      updatedBy: ADMIN,
    }));
  });
});

describe('offers/{offerId}/private/admin -- the internal note stays internal', () => {
  beforeEach(async () => {
    await seedOffer('live', { status: 'active' });
    await seed(testEnv, async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'offers', 'live', 'private', 'admin'),
        { note: 'margin approved by finance', updatedBy: ADMIN });
    });
  });

  it('an anonymous visitor cannot read it even though the offer is public', async () => {
    await assertFails(getDoc(doc(dbFor(testEnv, null), 'offers', 'live', 'private', 'admin')));
  });

  it('a signed-in non-admin cannot read it', async () => {
    await assertFails(getDoc(doc(dbFor(testEnv, AGENT), 'offers', 'live', 'private', 'admin')));
  });

  it('a signed-in non-admin cannot write it', async () => {
    await assertFails(setDoc(doc(dbFor(testEnv, AGENT), 'offers', 'live', 'private', 'admin'),
      { note: 'injected' }, { merge: true }));
  });

  it('an admin can read and write it', async () => {
    const db = dbFor(testEnv, ADMIN);
    await assertSucceeds(getDoc(doc(db, 'offers', 'live', 'private', 'admin')));
    await assertSucceeds(setDoc(doc(db, 'offers', 'live', 'private', 'admin'),
      { note: 'updated', updatedAt: serverTimestamp(), updatedBy: ADMIN }, { merge: true }));
  });
});
