// LOC-01 — public listing coordinate privacy.
//
// The invariant under test: no publicly-readable listing document may carry
// an exact lat/lng, and the exact pin that replaces it (in
// listings/{id}/private/location) is readable only by the listing's own
// agent or an admin — the same set that may edit the listing itself, per
// this platform's actual role model (users/{uid}.role of customer/agent/
// admin, no organizations or permission system).
//
// Run with:  npm run test:rules
import { readFileSync } from 'node:fs';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
} from '@firebase/rules-unit-testing';
import {
  doc, getDoc, setDoc, updateDoc, deleteDoc,
} from 'firebase/firestore';
import {
  toPublicCoord, publicCoordsFrom, publicListingCoords, PUBLIC_COORD_DECIMALS,
} from '../../js/listing-location.js';

let testEnv;

const ADMIN = 'admin-uid';
const AGENT = 'agent-uid';         // owns the listings below
const OTHER_AGENT = 'other-agent-uid'; // same company, different agent
const CUSTOMER = 'customer-uid';
const COMPANY = 'company-1';

// The approximate pair a migrated listing carries. Deliberately 2 dp — a
// value with more precision than this must not be writable as a "public"
// coordinate in the first place, which is what the invariant is about.
const PUBLIC_COORDS = { publicLat: 36.19, publicLng: 44.01 };
const EXACT = { lat: 36.19113, lng: 44.00934 };

function listingPayload(extra = {}) {
  return {
    title: 'Test listing',
    address: 'Somewhere',
    city: 'Erbil',
    dealType: 'sale',
    propertyType: 'apartment',
    price: 100000,
    agentId: AGENT,
    companyId: COMPANY,
    status: 'active',
    private: false,
    verified: false,
    ...PUBLIC_COORDS,
    ...extra,
  };
}

before(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: 'demo-darwesh',
    firestore: {
      rules: readFileSync(new URL('../../firestore.rules', import.meta.url), 'utf8'),
      host: '127.0.0.1',
      port: 8080,
    },
  });

  // Seed the user documents the rules' myRole()/myCompanyId() read, plus a
  // baseline migrated listing. withSecurityRulesDisabled is the only way to
  // create state the rules themselves would forbid.
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'users', ADMIN), { role: 'admin', companyId: COMPANY });
    await setDoc(doc(db, 'users', AGENT), { role: 'agent', companyId: COMPANY });
    await setDoc(doc(db, 'users', OTHER_AGENT), { role: 'agent', companyId: COMPANY });
    await setDoc(doc(db, 'users', CUSTOMER), { role: 'customer', companyId: COMPANY });

    await setDoc(doc(db, 'listings', 'listing-1'), listingPayload());
    await setDoc(doc(db, 'listings', 'listing-1', 'private', 'location'), EXACT);

    // A legacy listing that still carries exact coordinates, i.e. one the
    // backfill has not reached yet.
    await setDoc(doc(db, 'listings', 'legacy-1'), { ...listingPayload(), ...EXACT });
  });
});

after(async () => {
  if (testEnv) await testEnv.cleanup();
});

const asAdmin = () => testEnv.authenticatedContext(ADMIN).firestore();
const asAgent = () => testEnv.authenticatedContext(AGENT).firestore();
const asOtherAgent = () => testEnv.authenticatedContext(OTHER_AGENT).firestore();
const asCustomer = () => testEnv.authenticatedContext(CUSTOMER).firestore();
const asAnon = () => testEnv.unauthenticatedContext().firestore();

// ---------------------------------------------------------------------
// 1 + 2. A public listing document may never carry exact lat/lng.
// ---------------------------------------------------------------------
describe('LOC-01 / public listing documents carry no exact coordinate', () => {
  it('an agent cannot CREATE a listing containing lat/lng', async () => {
    await assertFails(setDoc(
      doc(asAgent(), 'listings', 'new-agent-precise'),
      listingPayload({ ...EXACT }),
    ));
  });

  it('an agent CAN create a listing with only the public pair', async () => {
    await assertSucceeds(setDoc(
      doc(asAgent(), 'listings', 'new-agent-public'),
      listingPayload(),
    ));
  });

  it('an ADMIN cannot create a listing containing lat/lng either', async () => {
    // The whole point of putting hasNoPreciseCoordFields() outside the
    // per-role branches: the admin branch carries no field allowlist, so
    // without this the invariant would be advisory for the one role most
    // likely to bulk-import data.
    await assertFails(setDoc(
      doc(asAdmin(), 'listings', 'new-admin-precise'),
      listingPayload({ ...EXACT, agentId: ADMIN, companyId: null }),
    ));
  });

  it('an ADMIN can create a listing with only the public pair', async () => {
    await assertSucceeds(setDoc(
      doc(asAdmin(), 'listings', 'new-admin-public'),
      listingPayload({ agentId: ADMIN, companyId: null }),
    ));
  });

  it('an agent cannot UPDATE a listing to add lat/lng back', async () => {
    await assertFails(updateDoc(
      doc(asAgent(), 'listings', 'listing-1'),
      { lat: EXACT.lat, lng: EXACT.lng },
    ));
  });

  it('an ADMIN cannot update a listing to add lat/lng back', async () => {
    await assertFails(updateDoc(
      doc(asAdmin(), 'listings', 'listing-1'),
      { lat: EXACT.lat, lng: EXACT.lng },
    ));
  });

  it('adding only ONE half of the exact pair is still rejected', async () => {
    await assertFails(updateDoc(doc(asAgent(), 'listings', 'listing-1'), { lat: EXACT.lat }));
    await assertFails(updateDoc(doc(asAgent(), 'listings', 'listing-1'), { lng: EXACT.lng }));
  });

  it('an ordinary edit that touches no coordinate still succeeds', async () => {
    await assertSucceeds(updateDoc(doc(asAgent(), 'listings', 'listing-1'), { price: 123000 }));
  });

  it('an out-of-range public coordinate is rejected', async () => {
    await assertFails(updateDoc(doc(asAgent(), 'listings', 'listing-1'), { publicLat: 91 }));
    await assertFails(updateDoc(doc(asAgent(), 'listings', 'listing-1'), { publicLng: -181 }));
  });

  it('a non-numeric public coordinate is rejected', async () => {
    await assertFails(updateDoc(doc(asAgent(), 'listings', 'listing-1'), { publicLat: '36.19' }));
  });

  it('deleting a listing still works (the invariant must not break delete)', async () => {
    // `delete` has no request.resource, so hasNoPreciseCoordFields() cannot
    // be evaluated on it -- the rule splits update and delete for exactly
    // this reason. A regression here would lock every listing in place.
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'listings', 'to-delete'), listingPayload());
    });
    await assertSucceeds(deleteDoc(doc(asAgent(), 'listings', 'to-delete')));
  });
});

// ---------------------------------------------------------------------
// 3. The approximate pair stays public.
// ---------------------------------------------------------------------
describe('LOC-01 / the approximate pair remains publicly readable', () => {
  it('an anonymous visitor can read the listing and its publicLat/publicLng', async () => {
    const snap = await assertSucceeds(getDoc(doc(asAnon(), 'listings', 'listing-1')));
    assert.equal(snap.data().publicLat, PUBLIC_COORDS.publicLat);
    assert.equal(snap.data().publicLng, PUBLIC_COORDS.publicLng);
    // ...and the exact coordinate is simply not on the document.
    assert.equal(snap.data().lat, undefined);
    assert.equal(snap.data().lng, undefined);
  });
});

// ---------------------------------------------------------------------
// 4 + 5 + 6. Who may read the exact pin.
// ---------------------------------------------------------------------
describe('LOC-01 / exact location authorization', () => {
  const loc = (db) => doc(db, 'listings', 'listing-1', 'private', 'location');

  it('an anonymous visitor CANNOT read the exact location', async () => {
    await assertFails(getDoc(loc(asAnon())));
  });

  it('a signed-in customer CANNOT read the exact location', async () => {
    await assertFails(getDoc(loc(asCustomer())));
  });

  it('a different agent at the same company CANNOT read the exact location', async () => {
    // Mirrors the parent listing's own update rule, which is owner-agent or
    // admin only. A colleague cannot edit this listing, so they do not get
    // its exact pin either -- granting that would widen access, not mirror it.
    await assertFails(getDoc(loc(asOtherAgent())));
  });

  it("the listing's own agent CAN read the exact location", async () => {
    const snap = await assertSucceeds(getDoc(loc(asAgent())));
    assert.equal(snap.data().lat, EXACT.lat);
  });

  it('an admin CAN read the exact location', async () => {
    await assertSucceeds(getDoc(loc(asAdmin())));
  });

  it('a different agent CANNOT write the exact location', async () => {
    await assertFails(setDoc(loc(asOtherAgent()), { lat: 1, lng: 1 }));
  });

  it('a customer CANNOT write the exact location', async () => {
    await assertFails(setDoc(loc(asCustomer()), { lat: 1, lng: 1 }));
  });

  it("the listing's own agent CAN write the exact location", async () => {
    await assertSucceeds(setDoc(loc(asAgent()), { lat: EXACT.lat, lng: EXACT.lng }));
  });

  it('an unexpected field on the location document is rejected', async () => {
    await assertFails(setDoc(loc(asAgent()), { lat: 1, lng: 1, address: 'leak' }));
  });

  it('a non-numeric or out-of-range exact coordinate is rejected', async () => {
    await assertFails(setDoc(loc(asAgent()), { lat: '36.19', lng: 44.01 }));
    await assertFails(setDoc(loc(asAgent()), { lat: 91, lng: 44.01 }));
  });

  it("the listing's own agent CAN delete the exact location", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'listings', 'listing-1', 'private', 'location'), EXACT);
    });
    await assertSucceeds(deleteDoc(loc(asAgent())));
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'listings', 'listing-1', 'private', 'location'), EXACT);
    });
  });
});

// ---------------------------------------------------------------------
// 10. The location document cannot precede or outlive its parent listing.
// ---------------------------------------------------------------------
describe('LOC-01 / the exact location cannot exist without its parent listing', () => {
  it('cannot create a location document for a listing that does not exist', async () => {
    // canAccessListingPreciseLocation() fails closed on a missing parent.
    // This is what forces write ordering in admin.html/agent-dashboard.html
    // (listing first, pin second) and stops orphan location documents being
    // planted under arbitrary ids.
    await assertFails(setDoc(
      doc(asAgent(), 'listings', 'does-not-exist', 'private', 'location'),
      { lat: EXACT.lat, lng: EXACT.lng },
    ));
  });

  it('an admin cannot plant a location document under a nonexistent listing either', async () => {
    await assertFails(setDoc(
      doc(asAdmin(), 'listings', 'also-does-not-exist', 'private', 'location'),
      { lat: EXACT.lat, lng: EXACT.lng },
    ));
  });

  it('once the parent listing is gone, its orphaned location is unreadable', async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      await setDoc(doc(db, 'listings', 'orphan-parent'), listingPayload());
      await setDoc(doc(db, 'listings', 'orphan-parent', 'private', 'location'), EXACT);
    });
    await assertSucceeds(getDoc(doc(asAgent(), 'listings', 'orphan-parent', 'private', 'location')));
    // Deleting a listing does not cascade in Firestore, so the sub-document
    // survives. It must not become readable to anyone once the parent -- the
    // thing the authorization decision is made from -- is gone.
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await deleteDoc(doc(ctx.firestore(), 'listings', 'orphan-parent'));
    });
    await assertFails(getDoc(doc(asAgent(), 'listings', 'orphan-parent', 'private', 'location')));
    await assertFails(getDoc(doc(asAdmin(), 'listings', 'orphan-parent', 'private', 'location')));
    await assertFails(getDoc(doc(asAnon(), 'listings', 'orphan-parent', 'private', 'location')));
  });
});

// ---------------------------------------------------------------------
// 11. Existing, unrelated listing authorization must not have been weakened.
// ---------------------------------------------------------------------
describe('LOC-01 / pre-existing listing authorization is unchanged', () => {
  it('a customer still cannot create a listing', async () => {
    await assertFails(setDoc(
      doc(asCustomer(), 'listings', 'customer-attempt'),
      listingPayload({ agentId: CUSTOMER }),
    ));
  });

  it('an agent still cannot create a listing assigned to someone else', async () => {
    await assertFails(setDoc(
      doc(asAgent(), 'listings', 'wrong-owner'),
      listingPayload({ agentId: OTHER_AGENT }),
    ));
  });

  it("an agent still cannot create a listing under another company's id", async () => {
    await assertFails(setDoc(
      doc(asAgent(), 'listings', 'wrong-company'),
      listingPayload({ companyId: 'some-other-company' }),
    ));
  });

  it("an agent still cannot edit another agent's listing", async () => {
    await assertFails(updateDoc(doc(asOtherAgent(), 'listings', 'listing-1'), { price: 1 }));
  });

  it("an agent still cannot delete another agent's listing", async () => {
    await assertFails(deleteDoc(doc(asOtherAgent(), 'listings', 'listing-1')));
  });

  it('listings are still publicly readable to anonymous visitors', async () => {
    await assertSucceeds(getDoc(doc(asAnon(), 'listings', 'listing-1')));
  });

  it('a legacy listing that still carries lat/lng is still readable and editable', async () => {
    // The rule blocks WRITING lat/lng, not reading a document that already
    // has it. During the migration window such listings must keep working --
    // otherwise deploying the rules would break every unmigrated listing
    // before the backfill could clean it up.
    await assertSucceeds(getDoc(doc(asAnon(), 'listings', 'legacy-1')));
    // Editing one does require dropping the legacy fields, which is the
    // intended forcing function: the next save cleans the document up.
    await assertFails(updateDoc(doc(asAgent(), 'listings', 'legacy-1'), { price: 1 }));
  });
});

// ---------------------------------------------------------------------
// 7 + 8 + 9. The rounding contract itself (pure helper, no emulator).
// ---------------------------------------------------------------------
describe('LOC-01 / public coordinate rounding contract', () => {
  it('rounds to exactly 2 decimal places', () => {
    assert.equal(PUBLIC_COORD_DECIMALS, 2);
    assert.equal(toPublicCoord(36.19113), 36.19);
    assert.equal(toPublicCoord(44.00934), 44.01);
    assert.equal(toPublicCoord(35.56081), 35.56);
    assert.equal(toPublicCoord(-45.678), -45.68);
  });

  it('is deterministic — never jittered', () => {
    // Jitter would be averaging-attackable across repeated reads, and would
    // make the backfill non-idempotent.
    const first = toPublicCoord(36.191134);
    for (let i = 0; i < 50; i++) assert.equal(toPublicCoord(36.191134), first);
  });

  it('rejects every unusable input rather than coercing it to 0', () => {
    // Number(null), Number(''), Number(false) and Number([]) are all 0, which
    // would put a listing with a missing coordinate at 0,0 -- a real point in
    // the Gulf of Guinea -- instead of flagging it as unusable.
    for (const bad of [null, undefined, '', '   ', false, true, [], {}, NaN, Infinity, -Infinity, 'abc', '36.19abc']) {
      assert.equal(toPublicCoord(bad), null, `expected null for ${JSON.stringify(bad)}`);
    }
  });

  it('accepts numeric strings (sell.html stores its pin as a .toFixed(5) string)', () => {
    assert.equal(toPublicCoord('36.19113'), 36.19);
  });

  it('rejects a half pair rather than writing one lone axis', () => {
    assert.deepEqual(publicCoordsFrom(36.19113, null), {});
    assert.deepEqual(publicCoordsFrom(null, 44.00934), {});
    assert.deepEqual(publicCoordsFrom(36.19113, ''), {});
    assert.deepEqual(publicCoordsFrom(undefined, undefined), {});
    assert.deepEqual(publicCoordsFrom(36.19113, 44.00934), PUBLIC_COORDS);
  });

  it('never displaces a point further than one grid cell can account for', () => {
    // 2 dp at Kurdistan latitudes is a ~1.11 km x ~0.90 km cell, so the worst
    // case is half its diagonal, ~715 m. Checked over the real bounding box
    // rather than asserted from the comment.
    const R = 6371000, toRad = (d) => (d * Math.PI) / 180;
    const haversine = (a, b, c, d) => {
      const dLat = toRad(c - a), dLng = toRad(d - b);
      const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a)) * Math.cos(toRad(c)) * Math.sin(dLng / 2) ** 2;
      return 2 * R * Math.asin(Math.sqrt(h));
    };
    let worst = 0;
    for (let i = 0; i < 2000; i++) {
      const lat = 35 + Math.random() * 2.5;   // ~35.0 - 37.5
      const lng = 42.5 + Math.random() * 3.5; // ~42.5 - 46.0
      worst = Math.max(worst, haversine(lat, lng, toPublicCoord(lat), toPublicCoord(lng)));
    }
    assert.ok(worst <= 715, `worst-case displacement ${Math.round(worst)} m exceeded 715 m`);
    // And it must actually BE approximate -- a rounding that barely moved the
    // point would defeat the purpose.
    assert.ok(worst > 300, `worst-case displacement ${Math.round(worst)} m is suspiciously small for a 2 dp grid`);
  });

  it('reads a migrated listing, a legacy listing, and a coordinate-less one', () => {
    assert.deepEqual(publicListingCoords({ publicLat: 36.19, publicLng: 44.01 }), { lat: 36.19, lng: 44.01 });
    // The legacy fallback rounds on read, so an unmigrated listing is never
    // rendered at building precision even before the backfill runs.
    assert.deepEqual(publicListingCoords({ lat: 36.19113, lng: 44.00934 }), { lat: 36.19, lng: 44.01 });
    assert.equal(publicListingCoords({}), null);
    assert.equal(publicListingCoords({ lat: 36.19113 }), null);
    assert.equal(publicListingCoords({ lat: null, lng: null }), null);
    assert.equal(publicListingCoords(null), null);
  });
});
