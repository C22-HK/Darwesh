// LOC-01 — public-map location privacy Firestore Rules regression tests.
//
// The exposure this closes: every public (`private:false`, `status:'active'`)
// listing used to carry its real surveyed `lat`/`lng` — stored to 5 decimal
// places, ~1.1 m — on the same document any anonymous visitor is allowed to
// read, and map.html/listing.html/buy-rent-map.html all plotted that exact
// point. Firestore security rules are DOCUMENT-level for reads: a rule can
// allow or deny reading a listing, but it can never hand back that listing
// with one field removed. So no rule change alone could have fixed this —
// the precise coordinate simply must not live on the publicly-readable
// document.
//
// The split proven here:
//   listings/{id}                   -> publicLat/publicLng only (~111 m)
//   listings/{id}/private/location  -> the real lat/lng, owner/admin only
//
// Two independent guarantees are tested: (1) the precise sub-document is
// unreadable by the public, and (2) a precise lat/lng can never be written
// back onto the public document by ANY role — including admin, whose own
// branch carries no field allowlist — so the invariant survives a buggy or
// malicious client rather than depending on one.
import { before, after, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
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
async function seedListing(listingId, data) {
  await seed(testEnv, async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'listings', listingId), data);
  });
}
async function seedPreciseLocation(listingId, data) {
  await seed(testEnv, async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'listings', listingId, 'private', 'location'), data);
  });
}

const AGENT = 'agent-1';
const OTHER_AGENT = 'agent-2';
const ADMIN = 'admin-1';
const CUSTOMER = 'customer-1';

// The real surveyed pin (Erbil, 5 dp as sell.html/admin.html store it) and
// the ~111 m rounded value the public document is allowed to carry.
const PRECISE = { lat: 36.19113, lng: 44.00934 };
const PUBLIC_COORDS = { publicLat: 36.191, publicLng: 44.009 };

function publicListing(overrides = {}) {
  return {
    title: 'Nice flat', city: 'Erbil', dealType: 'sale', propertyType: 'apartment',
    price: 100000, private: false, status: 'active',
    agentId: AGENT, companyId: 'co-1', createdAt: 1,
    ...PUBLIC_COORDS,
    ...overrides
  };
}

async function seedPeople() {
  await seedUser(AGENT, { role: 'agent', companyId: 'co-1', createdAt: 1 });
  await seedUser(OTHER_AGENT, { role: 'agent', companyId: 'co-1', createdAt: 1 });
  await seedUser(ADMIN, { role: 'admin', createdAt: 1 });
  await seedUser(CUSTOMER, { role: 'customer', createdAt: 1 });
}

describe('LOC-01 — a public listing document can never carry a precise coordinate', () => {
  beforeEach(seedPeople);

  it('an agent CAN create a public listing carrying only rounded publicLat/publicLng', async () => {
    const db = dbFor(testEnv, AGENT);
    await assertSucceeds(setDoc(doc(db, 'listings', 'l1'), publicListing()));
  });

  it('an agent CANNOT create a listing carrying a precise lat/lng', async () => {
    const db = dbFor(testEnv, AGENT);
    await assertFails(setDoc(doc(db, 'listings', 'l1'), publicListing({ lat: PRECISE.lat, lng: PRECISE.lng })));
  });

  it('an ADMIN also cannot create a listing carrying a precise lat/lng (the admin branch has no field allowlist, so this invariant sits outside it)', async () => {
    const db = dbFor(testEnv, ADMIN);
    await assertFails(setDoc(doc(db, 'listings', 'l1'), publicListing({ lat: PRECISE.lat, lng: PRECISE.lng })));
  });

  it('an agent cannot re-introduce lat/lng on a later update', async () => {
    await seedListing('l1', publicListing());
    const db = dbFor(testEnv, AGENT);
    await assertFails(updateDoc(doc(db, 'listings', 'l1'), { lat: PRECISE.lat, lng: PRECISE.lng, updatedAt: 2 }));
  });

  it('an ADMIN cannot re-introduce lat/lng on a later update either', async () => {
    await seedListing('l1', publicListing());
    const db = dbFor(testEnv, ADMIN);
    await assertFails(updateDoc(doc(db, 'listings', 'l1'), { lat: PRECISE.lat, lng: PRECISE.lng, updatedAt: 2 }));
  });

  it('an ordinary edit that touches neither coordinate still works (no regression to normal editing)', async () => {
    await seedListing('l1', publicListing());
    const db = dbFor(testEnv, AGENT);
    await assertSucceeds(updateDoc(doc(db, 'listings', 'l1'), { price: 105000, updatedAt: 2 }));
  });

  it('an agent can move the approximate pin (publicLat/publicLng stay editable)', async () => {
    await seedListing('l1', publicListing());
    const db = dbFor(testEnv, AGENT);
    await assertSucceeds(updateDoc(doc(db, 'listings', 'l1'), { publicLat: 36.192, publicLng: 44.01, updatedAt: 2 }));
  });

  it('an out-of-range publicLat is rejected', async () => {
    const db = dbFor(testEnv, AGENT);
    await assertFails(setDoc(doc(db, 'listings', 'l1'), publicListing({ publicLat: 991 })));
  });

  it('a non-numeric publicLng is rejected', async () => {
    const db = dbFor(testEnv, AGENT);
    await assertFails(setDoc(doc(db, 'listings', 'l1'), publicListing({ publicLng: '44.009' })));
  });

  it('what an anonymous visitor actually receives contains the approximate pin and NO precise field', async () => {
    await seedListing('l1', publicListing());
    await seedPreciseLocation('l1', { ...PRECISE, updatedAt: 1 });
    const db = dbFor(testEnv, null);
    const snap = await getDoc(doc(db, 'listings', 'l1'));
    assert.equal(snap.exists(), true, 'the public listing itself is still publicly readable');
    const data = snap.data();
    assert.equal(data.publicLat, 36.191);
    assert.equal(data.publicLng, 44.009);
    assert.equal('lat' in data, false, 'no precise lat reaches the public payload');
    assert.equal('lng' in data, false, 'no precise lng reaches the public payload');
  });
});

describe('LOC-01 — listings/{id}/private/location is owner/admin-only', () => {
  beforeEach(async () => {
    await seedPeople();
    await seedListing('l1', publicListing());
    await seedPreciseLocation('l1', { ...PRECISE, updatedAt: 1 });
  });

  it('an anonymous visitor CANNOT read the precise location', async () => {
    const db = dbFor(testEnv, null);
    await assertFails(getDoc(doc(db, 'listings', 'l1', 'private', 'location')));
  });

  it('a signed-in customer CANNOT read the precise location', async () => {
    const db = dbFor(testEnv, CUSTOMER);
    await assertFails(getDoc(doc(db, 'listings', 'l1', 'private', 'location')));
  });

  it('a DIFFERENT agent cannot read another agent\'s precise location', async () => {
    const db = dbFor(testEnv, OTHER_AGENT);
    await assertFails(getDoc(doc(db, 'listings', 'l1', 'private', 'location')));
  });

  it('the owning agent CAN read the precise location', async () => {
    const db = dbFor(testEnv, AGENT);
    await assertSucceeds(getDoc(doc(db, 'listings', 'l1', 'private', 'location')));
  });

  it('an admin CAN read the precise location (admin intelligence/requests maps keep full precision)', async () => {
    const db = dbFor(testEnv, ADMIN);
    await assertSucceeds(getDoc(doc(db, 'listings', 'l1', 'private', 'location')));
  });

  it('the owning agent can write the precise location', async () => {
    const db = dbFor(testEnv, AGENT);
    await assertSucceeds(setDoc(doc(db, 'listings', 'l1', 'private', 'location'), { lat: 36.2, lng: 44.02, updatedAt: 2 }));
  });

  it('a different agent cannot write it', async () => {
    const db = dbFor(testEnv, OTHER_AGENT);
    await assertFails(setDoc(doc(db, 'listings', 'l1', 'private', 'location'), { lat: 36.2, lng: 44.02, updatedAt: 2 }));
  });

  it('smuggling an extra field into the location document is rejected', async () => {
    const db = dbFor(testEnv, AGENT);
    await assertFails(setDoc(doc(db, 'listings', 'l1', 'private', 'location'), { lat: 36.2, lng: 44.02, ownerNotes: 'x', updatedAt: 2 }));
  });

  it('an out-of-range precise coordinate is rejected', async () => {
    const db = dbFor(testEnv, AGENT);
    await assertFails(setDoc(doc(db, 'listings', 'l1', 'private', 'location'), { lat: 991, lng: 44.02, updatedAt: 2 }));
  });
});

describe('LOC-01 — the location document cannot outlive or precede its listing', () => {
  beforeEach(seedPeople);

  it('writing a location document for a listing that does not exist is denied (forces listing-first ordering)', async () => {
    const db = dbFor(testEnv, AGENT);
    await assertFails(setDoc(doc(db, 'listings', 'ghost', 'private', 'location'), { lat: 36.2, lng: 44.02, updatedAt: 1 }));
  });

  it('reading a location document for a listing that does not exist is denied rather than erroring open', async () => {
    const db = dbFor(testEnv, ADMIN);
    await assertFails(getDoc(doc(db, 'listings', 'ghost', 'private', 'location')));
  });
});
