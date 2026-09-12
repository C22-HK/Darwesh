// RENT SCALING / PRODUCTION QUERY UPGRADE — Firestore Rules regression
// tests for rent.html's new server-side cursor-pagination query shapes
// (private==false, status=='active', dealType=='rent', optionally city
// and/or propertyType, orderBy(createdAt desc) OR orderBy(price asc/desc)
// + a price range, orderBy(documentId()), startAfter, limit). Run with
// `npm run test:rules`.
//
// Scope: this file only covers the NEW query shapes rent.html's
// buildQuery() introduces. isListingPubliclyVisible()/isListingOwnerOrAdmin()
// themselves (single-doc get/create/update/delete) are already covered
// by tests/firestore/estates.test.mjs and earlier stages -- not
// duplicated here.
//
// Note on indexes: the Firestore emulator does not enforce composite-
// index requirements the way production Firestore does (indexes are a
// production performance/scaling concern, not a correctness one), so
// these tests validate query CORRECTNESS and RULES compliance for every
// shape -- they cannot verify that firestore.indexes.json's 12 new
// `listings` entries have actually been deployed to production. That is
// a separate, manual `firebase deploy --only firestore:indexes` step
// (see the Phase completion report).
import { before, after, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { doc, setDoc, getDocs, collection, query, where, orderBy, limit, startAfter, documentId } from 'firebase/firestore';
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

async function seedListing(listingId, data) {
  await seed(testEnv, async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'listings', listingId), data);
  });
}

function validRental(overrides = {}) {
  return {
    title: 'Nice flat', address: '123 Test St', city: 'Erbil', dealType: 'rent',
    propertyType: 'apartment', price: 500, beds: 2, baths: 1, sqft: 90,
    private: false, status: 'active', agentId: 'agent-1', companyId: 'co-1',
    createdAt: 1,
    ...overrides
  };
}

// Mirrors rent.html's buildQuery(): three base equality filters, optional
// city/propertyType, one sort dimension, documentId() tiebreaker, bounded.
function rentQuery(db, { city, type, minPrice, maxPrice, sort = 'newest', pageSize = 10, cursor } = {}) {
  const clauses = [
    where('private', '==', false),
    where('status', '==', 'active'),
    where('dealType', '==', 'rent'),
  ];
  if (city) clauses.push(where('city', '==', city));
  if (type) clauses.push(where('propertyType', '==', type));
  if (minPrice != null) clauses.push(where('price', '>=', minPrice));
  if (maxPrice != null) clauses.push(where('price', '<=', maxPrice));
  if (sort === 'price-asc') clauses.push(orderBy('price', 'asc'));
  else if (sort === 'price-desc') clauses.push(orderBy('price', 'desc'));
  else clauses.push(orderBy('createdAt', 'desc'));
  clauses.push(orderBy(documentId()));
  if (cursor) clauses.push(startAfter(cursor));
  clauses.push(limit(pageSize));
  return query(collection(db, 'listings'), ...clauses);
}

describe('Rent pagination — base query shape', () => {
  it('an unauthenticated reader can run the base rent query (private/status/dealType + orderBy(createdAt))', async () => {
    await seedListing('r1', validRental({ createdAt: 3 }));
    await seedListing('r2', validRental({ createdAt: 2 }));
    await seedListing('r3', validRental({ createdAt: 1 }));
    const db = dbFor(testEnv, null);
    const snap = await assertSucceeds(getDocs(rentQuery(db)));
    assert.equal(snap.docs.length, 3);
    // orderBy('createdAt','desc') -- newest first.
    assert.deepEqual(snap.docs.map(d => d.id), ['r1', 'r2', 'r3']);
  });

  it('only dealType=="rent" listings are returned -- a sale listing never appears', async () => {
    await seedListing('rent-1', validRental({ createdAt: 2 }));
    await seedListing('sale-1', validRental({ dealType: 'sale', createdAt: 1 }));
    const db = dbFor(testEnv, null);
    const snap = await assertSucceeds(getDocs(rentQuery(db)));
    assert.deepEqual(snap.docs.map(d => d.id), ['rent-1']);
  });

  it('a private rental never appears in the base query results', async () => {
    await seedListing('public-1', validRental({ createdAt: 2 }));
    await seedListing('private-1', validRental({ private: true, createdAt: 1 }));
    const db = dbFor(testEnv, null);
    const snap = await assertSucceeds(getDocs(rentQuery(db)));
    assert.deepEqual(snap.docs.map(d => d.id), ['public-1']);
  });

  it('a closed (non-active) rental never appears in the base query results', async () => {
    await seedListing('active-1', validRental({ createdAt: 2 }));
    await seedListing('closed-1', validRental({ status: 'closed', createdAt: 1 }));
    const db = dbFor(testEnv, null);
    const snap = await assertSucceeds(getDocs(rentQuery(db)));
    assert.deepEqual(snap.docs.map(d => d.id), ['active-1']);
  });
});

describe('Rent pagination — optional equality filters (city, propertyType)', () => {
  it('city filter restricts results to that exact city', async () => {
    await seedListing('erbil-1', validRental({ city: 'Erbil', createdAt: 2 }));
    await seedListing('duhok-1', validRental({ city: 'Duhok', createdAt: 1 }));
    const db = dbFor(testEnv, null);
    const snap = await assertSucceeds(getDocs(rentQuery(db, { city: 'Erbil' })));
    assert.deepEqual(snap.docs.map(d => d.id), ['erbil-1']);
  });

  it('propertyType filter restricts results to that exact type', async () => {
    await seedListing('apt-1', validRental({ propertyType: 'apartment', createdAt: 2 }));
    await seedListing('villa-1', validRental({ propertyType: 'villa', createdAt: 1 }));
    const db = dbFor(testEnv, null);
    const snap = await assertSucceeds(getDocs(rentQuery(db, { type: 'villa' })));
    assert.deepEqual(snap.docs.map(d => d.id), ['villa-1']);
  });

  it('city + propertyType combine as AND, not OR', async () => {
    await seedListing('match', validRental({ city: 'Erbil', propertyType: 'villa', createdAt: 3 }));
    await seedListing('wrong-city', validRental({ city: 'Duhok', propertyType: 'villa', createdAt: 2 }));
    await seedListing('wrong-type', validRental({ city: 'Erbil', propertyType: 'apartment', createdAt: 1 }));
    const db = dbFor(testEnv, null);
    const snap = await assertSucceeds(getDocs(rentQuery(db, { city: 'Erbil', type: 'villa' })));
    assert.deepEqual(snap.docs.map(d => d.id), ['match']);
  });
});

describe('Rent pagination — price range + price-based sort', () => {
  it('a price range filter combined with orderBy(price asc) returns only in-range listings, correctly ordered', async () => {
    await seedListing('cheap', validRental({ price: 200, createdAt: 1 }));
    await seedListing('mid', validRental({ price: 500, createdAt: 2 }));
    await seedListing('high', validRental({ price: 900, createdAt: 3 }));
    await seedListing('too-expensive', validRental({ price: 2000, createdAt: 4 }));
    const db = dbFor(testEnv, null);
    const snap = await assertSucceeds(getDocs(rentQuery(db, { minPrice: 300, maxPrice: 1000, sort: 'price-asc' })));
    assert.deepEqual(snap.docs.map(d => d.id), ['mid', 'high']);
  });

  it('orderBy(price desc) with no range filter still works across the whole rent set', async () => {
    await seedListing('a', validRental({ price: 300, createdAt: 1 }));
    await seedListing('b', validRental({ price: 900, createdAt: 2 }));
    await seedListing('c', validRental({ price: 600, createdAt: 3 }));
    const db = dbFor(testEnv, null);
    const snap = await assertSucceeds(getDocs(rentQuery(db, { sort: 'price-desc' })));
    assert.deepEqual(snap.docs.map(d => d.id), ['b', 'c', 'a']);
  });
});

describe('Rent pagination — cursor pagination correctness', () => {
  it('startAfter(cursor) pages through results with no overlap and no gaps', async () => {
    for (let i = 1; i <= 5; i++) {
      await seedListing('l' + i, validRental({ createdAt: i }));
    }
    const db = dbFor(testEnv, null);

    const page1 = await assertSucceeds(getDocs(rentQuery(db, { pageSize: 2 })));
    assert.deepEqual(page1.docs.map(d => d.id), ['l5', 'l4']); // newest first

    const cursor1 = page1.docs[page1.docs.length - 1];
    const page2 = await assertSucceeds(getDocs(rentQuery(db, { pageSize: 2, cursor: cursor1 })));
    assert.deepEqual(page2.docs.map(d => d.id), ['l3', 'l2']);

    const cursor2 = page2.docs[page2.docs.length - 1];
    const page3 = await assertSucceeds(getDocs(rentQuery(db, { pageSize: 2, cursor: cursor2 })));
    assert.deepEqual(page3.docs.map(d => d.id), ['l1']);
    // Fewer docs than pageSize -- the client's fetchPage() reads this as "exhausted".
    assert.ok(page3.docs.length < 2);

    const allIds = [...page1.docs, ...page2.docs, ...page3.docs].map(d => d.id);
    assert.deepEqual(new Set(allIds).size, allIds.length, 'no duplicate documents across pages');
    assert.deepEqual(allIds.sort(), ['l1', 'l2', 'l3', 'l4', 'l5']);
  });

  it('documentId() tiebreaker prevents skipping/duplicating documents that share the exact same sort value', async () => {
    // Three listings with an IDENTICAL price -- without a deterministic
    // secondary orderBy, a naive startAfter(price) cursor could legally
    // skip or repeat whichever of these ties with the cursor's own value.
    await seedListing('tie-a', validRental({ price: 500, createdAt: 1 }));
    await seedListing('tie-b', validRental({ price: 500, createdAt: 2 }));
    await seedListing('tie-c', validRental({ price: 500, createdAt: 3 }));
    const db = dbFor(testEnv, null);

    const page1 = await assertSucceeds(getDocs(rentQuery(db, { sort: 'price-asc', pageSize: 2 })));
    assert.equal(page1.docs.length, 2);
    const cursor = page1.docs[page1.docs.length - 1];
    const page2 = await assertSucceeds(getDocs(rentQuery(db, { sort: 'price-asc', pageSize: 2, cursor })));

    const allIds = [...page1.docs, ...page2.docs].map(d => d.id);
    assert.deepEqual(new Set(allIds).size, 3, 'all three same-price listings appear exactly once across both pages');
  });
});

describe('Rent pagination — under-constrained queries are still denied (new shapes did not loosen this)', () => {
  it('a query missing the status=="active" equality filter is denied, even with city + orderBy added', async () => {
    await seedListing('r1', validRental());
    const db = dbFor(testEnv, null);
    const q = query(
      collection(db, 'listings'),
      where('private', '==', false),
      where('dealType', '==', 'rent'),
      where('city', '==', 'Erbil'),
      orderBy('createdAt', 'desc'),
      orderBy(documentId()),
      limit(10)
    );
    await assertFails(getDocs(q));
  });

  it('a query missing the private==false equality filter is denied', async () => {
    await seedListing('r1', validRental());
    const db = dbFor(testEnv, null);
    const q = query(
      collection(db, 'listings'),
      where('status', '==', 'active'),
      where('dealType', '==', 'rent'),
      orderBy('createdAt', 'desc'),
      orderBy(documentId()),
      limit(10)
    );
    await assertFails(getDocs(q));
  });
});
