// PHASE 3A -- professional profile media + contact privacy.
//
// Covers exactly what this phase changed in firestore.rules:
//   1. `maintenance` accepted as a serviceType
//   2. coverImageUrl validated against THIS project's Storage bucket
//   3. contactVisibility constrained to a two-value enum
//   4. serviceProviders/{id}/private/contact -- owner/admin only
//   5. nothing existing weakened (ownerId lock, verified lock, old roles)
//   6. professionalPosts still designer-only -- proving 3A opened no
//      publishing capability for any new role
//   7. the capability map in js/professional-roles.js has not drifted from
//      the serviceType enum in firestore.rules
//
// Run with `npm run test:rules`.
import { readFileSync } from 'node:fs';
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { doc, getDoc, setDoc, updateDoc, deleteDoc } from 'firebase/firestore';
import { PROFESSIONAL_SERVICE_TYPES } from '../../js/professional-roles.js';

let testEnv;

const ADMIN = 'admin-uid';
const OWNER = 'provider-owner-uid';
const OTHER = 'other-provider-uid';
const CUSTOMER = 'customer-uid';

// A real download URL shape for this project's own bucket, per
// js/firebase-init.js (storageBucket: darwesh-group.firebasestorage.app).
const OWN_URL = 'https://firebasestorage.googleapis.com/v0/b/darwesh-group.firebasestorage.app/o/professional-media%2Fp1%2Fcover%2Fa.jpg?alt=media&token=x';
const OWN_URL_APPSPOT = 'https://firebasestorage.googleapis.com/v0/b/darwesh-group.appspot.com/o/professional-media%2Fp1%2Fcover%2Fa.jpg?alt=media';
// Right host, SOMEONE ELSE'S project bucket -- the case the pre-existing
// host-only isStorageUrl() would have accepted.
const FOREIGN_BUCKET = 'https://firebasestorage.googleapis.com/v0/b/attacker-project.appspot.com/o/x.jpg?alt=media';
const FOREIGN_HOST = 'https://evil.example.com/x.jpg';

function providerDoc(uid, extra = {}) {
  return {
    serviceType: 'engineer', providerType: 'individual', ownerId: uid,
    displayName: 'Test Provider', verified: false, createdAt: 1, updatedAt: 1,
    ...extra,
  };
}

before(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: 'demo-darwesh',
    firestore: {
      rules: readFileSync(new URL('../../firestore.rules', import.meta.url), 'utf8'),
      host: '127.0.0.1', port: 8080,
    },
  });
});
after(async () => { if (testEnv) await testEnv.cleanup(); });

beforeEach(async () => {
  await testEnv.clearFirestore();
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'users', ADMIN), { role: 'admin', createdAt: 1 });
    await setDoc(doc(db, 'users', OWNER), { role: 'customer', createdAt: 1 });
    await setDoc(doc(db, 'users', OTHER), { role: 'customer', createdAt: 1 });
    await setDoc(doc(db, 'users', CUSTOMER), { role: 'customer', createdAt: 1 });
  });
});

const as = (uid) => (uid === null ? testEnv.unauthenticatedContext() : testEnv.authenticatedContext(uid)).firestore();

async function seedProvider(id, data) {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'serviceProviders', id), data);
  });
}

// ---------------------------------------------------------------------
describe('3A / maintenance role', () => {
  it('a maintenance provider can create their own profile', async () => {
    await assertSucceeds(setDoc(doc(as(OWNER), 'serviceProviders', OWNER),
      providerDoc(OWNER, { serviceType: 'maintenance' })));
  });

  it('every previously-supported role still creates', async () => {
    for (const t of ['engineer', 'designer', 'lawyer', 'landscaping', 'cleaning']) {
      await testEnv.clearFirestore();
      await testEnv.withSecurityRulesDisabled(async (ctx) => {
        await setDoc(doc(ctx.firestore(), 'users', OWNER), { role: 'customer', createdAt: 1 });
      });
      await assertSucceeds(setDoc(doc(as(OWNER), 'serviceProviders', OWNER),
        providerDoc(OWNER, { serviceType: t })));
    }
  });

  it('an unknown serviceType is still rejected', async () => {
    await assertFails(setDoc(doc(as(OWNER), 'serviceProviders', OWNER),
      providerDoc(OWNER, { serviceType: 'plumber' })));
  });

  it('an individual maintenance profile must use the owner uid as its id', async () => {
    await assertFails(setDoc(doc(as(OWNER), 'serviceProviders', 'some-other-id'),
      providerDoc(OWNER, { serviceType: 'maintenance' })));
  });

  it('maintenance cannot be a team/company (cleaning-only)', async () => {
    await assertFails(setDoc(doc(as(OWNER), 'serviceProviders', OWNER),
      providerDoc(OWNER, { serviceType: 'maintenance', providerType: 'team' })));
  });

  it('a new maintenance profile cannot self-verify', async () => {
    await assertFails(setDoc(doc(as(OWNER), 'serviceProviders', OWNER),
      providerDoc(OWNER, { serviceType: 'maintenance', verified: true })));
  });
});

// ---------------------------------------------------------------------
describe('3A / coverImageUrl', () => {
  it('accepts a URL in this project\'s own bucket', async () => {
    await assertSucceeds(setDoc(doc(as(OWNER), 'serviceProviders', OWNER),
      providerDoc(OWNER, { coverImageUrl: OWN_URL })));
  });

  it('accepts the appspot.com alias of the same bucket', async () => {
    await assertSucceeds(setDoc(doc(as(OWNER), 'serviceProviders', OWNER),
      providerDoc(OWNER, { coverImageUrl: OWN_URL_APPSPOT })));
  });

  it('rejects another Firebase project\'s bucket on the right host', async () => {
    await assertFails(setDoc(doc(as(OWNER), 'serviceProviders', OWNER),
      providerDoc(OWNER, { coverImageUrl: FOREIGN_BUCKET })));
  });

  it('rejects an entirely foreign host', async () => {
    await assertFails(setDoc(doc(as(OWNER), 'serviceProviders', OWNER),
      providerDoc(OWNER, { coverImageUrl: FOREIGN_HOST })));
  });

  it('rejects a non-string cover', async () => {
    await assertFails(setDoc(doc(as(OWNER), 'serviceProviders', OWNER),
      providerDoc(OWNER, { coverImageUrl: 42 })));
  });

  it('is optional -- a profile without one is valid', async () => {
    await assertSucceeds(setDoc(doc(as(OWNER), 'serviceProviders', OWNER), providerDoc(OWNER)));
  });

  it('the owner can add one later; a stranger cannot', async () => {
    await seedProvider(OWNER, providerDoc(OWNER));
    await assertSucceeds(updateDoc(doc(as(OWNER), 'serviceProviders', OWNER), { coverImageUrl: OWN_URL }));
    await assertFails(updateDoc(doc(as(OTHER), 'serviceProviders', OWNER), { coverImageUrl: OWN_URL }));
  });

  it('an update cannot smuggle in a foreign cover', async () => {
    await seedProvider(OWNER, providerDoc(OWNER));
    await assertFails(updateDoc(doc(as(OWNER), 'serviceProviders', OWNER), { coverImageUrl: FOREIGN_HOST }));
  });

  it('photoOrLogoUrl is deliberately NOT tightened in this phase', async () => {
    // A Google OAuth avatar must still be storable -- tightening this field
    // without auditing live values first would reject the next profile save
    // of any provider whose photo came from their Google account.
    await assertSucceeds(setDoc(doc(as(OWNER), 'serviceProviders', OWNER),
      providerDoc(OWNER, { photoOrLogoUrl: 'https://lh3.googleusercontent.com/a/abc123' })));
  });
});

// ---------------------------------------------------------------------
describe('3A / contactVisibility', () => {
  it('accepts the two supported values', async () => {
    for (const v of ['public', 'onRequest']) {
      await testEnv.clearFirestore();
      await testEnv.withSecurityRulesDisabled(async (ctx) => {
        await setDoc(doc(ctx.firestore(), 'users', OWNER), { role: 'customer', createdAt: 1 });
      });
      await assertSucceeds(setDoc(doc(as(OWNER), 'serviceProviders', OWNER),
        providerDoc(OWNER, { contactVisibility: v })));
    }
  });

  it('rejects any other value', async () => {
    await assertFails(setDoc(doc(as(OWNER), 'serviceProviders', OWNER),
      providerDoc(OWNER, { contactVisibility: 'everyone' })));
  });

  it('is optional', async () => {
    await assertSucceeds(setDoc(doc(as(OWNER), 'serviceProviders', OWNER), providerDoc(OWNER)));
  });
});

// ---------------------------------------------------------------------
describe('3A / private/contact authorization', () => {
  const CONTACT = { phone: '+9647500000000', whatsapp: '+9647500000000', email: 'a@b.com' };
  const path = (db, id = OWNER) => doc(db, 'serviceProviders', id, 'private', 'contact');

  beforeEach(async () => {
    await seedProvider(OWNER, providerDoc(OWNER));
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'serviceProviders', OWNER, 'private', 'contact'), CONTACT);
    });
  });

  it('an anonymous visitor CANNOT read it', async () => {
    await assertFails(getDoc(path(as(null))));
  });

  it('a signed-in customer CANNOT read it', async () => {
    await assertFails(getDoc(path(as(CUSTOMER))));
  });

  it('a DIFFERENT provider CANNOT read it', async () => {
    await seedProvider(OTHER, providerDoc(OTHER));
    await assertFails(getDoc(path(as(OTHER))));
  });

  it('the owner CAN read it', async () => {
    const snap = await assertSucceeds(getDoc(path(as(OWNER))));
    assert.equal(snap.data().phone, CONTACT.phone);
  });

  it('an admin CAN read it', async () => {
    await assertSucceeds(getDoc(path(as(ADMIN))));
  });

  it('the owner can write it; a stranger cannot', async () => {
    await assertSucceeds(setDoc(path(as(OWNER)), { phone: '+9647511111111' }));
    await assertFails(setDoc(path(as(OTHER)), { phone: '+9647522222222' }));
  });

  it('rejects an unexpected field', async () => {
    await assertFails(setDoc(path(as(OWNER)), { phone: '+964750', role: 'admin' }));
  });

  it('rejects an over-long value', async () => {
    await assertFails(setDoc(path(as(OWNER)), { phone: 'x'.repeat(41) }));
  });

  it('cannot be written for a provider profile that does not exist', async () => {
    await assertFails(setDoc(
      doc(as(OWNER), 'serviceProviders', 'no-such-profile', 'private', 'contact'),
      { phone: '+964750' }));
  });

  it('the owner can delete it', async () => {
    await assertSucceeds(deleteDoc(path(as(OWNER))));
  });

  it('the public profile document itself stays world-readable', async () => {
    // The split only works if the parent is still public -- that is the
    // whole point (public profile, private number).
    await assertSucceeds(getDoc(doc(as(null), 'serviceProviders', OWNER)));
  });
});

// ---------------------------------------------------------------------
describe('3A / nothing existing was weakened', () => {
  it('ownerId is still locked on update, including for an admin', async () => {
    await seedProvider(OWNER, providerDoc(OWNER));
    await assertFails(updateDoc(doc(as(OWNER), 'serviceProviders', OWNER), { ownerId: OTHER }));
    await assertFails(updateDoc(doc(as(ADMIN), 'serviceProviders', OWNER), { ownerId: OTHER }));
  });

  it('verified is still admin-only', async () => {
    await seedProvider(OWNER, providerDoc(OWNER));
    await assertFails(updateDoc(doc(as(OWNER), 'serviceProviders', OWNER), { verified: true }));
    await assertSucceeds(updateDoc(doc(as(ADMIN), 'serviceProviders', OWNER), { verified: true }));
  });

  it('serviceType is still immutable for the owner', async () => {
    await seedProvider(OWNER, providerDoc(OWNER));
    await assertFails(updateDoc(doc(as(OWNER), 'serviceProviders', OWNER), { serviceType: 'designer' }));
  });

  it('a document created before this phase still updates cleanly', async () => {
    await seedProvider(OWNER, providerDoc(OWNER)); // no coverImageUrl, no contactVisibility
    await assertSucceeds(updateDoc(doc(as(OWNER), 'serviceProviders', OWNER), { displayName: 'Renamed' }));
  });

  it('an unrelated field is still rejected', async () => {
    await seedProvider(OWNER, providerDoc(OWNER));
    await assertFails(updateDoc(doc(as(OWNER), 'serviceProviders', OWNER), { isAdmin: true }));
  });
});

// ---------------------------------------------------------------------
describe('3A / professionalPosts opened nothing', () => {
  const post = (uid, profileId, profileType) => ({
    ownerId: uid, profileId, profileType, status: 'published',
    title: 'A project', category: 'residential',
    coverImageUrl: OWN_URL, createdAt: 1, updatedAt: 1,
  });

  it('a designer can still create a post -- existing behaviour intact', async () => {
    await seedProvider(OWNER, providerDoc(OWNER, { serviceType: 'designer' }));
    await assertSucceeds(setDoc(doc(as(OWNER), 'professionalPosts', 'p1'),
      post(OWNER, OWNER, 'designer')));
  });

  it('maintenance still CANNOT publish -- 3A adds no post capability', async () => {
    await seedProvider(OWNER, providerDoc(OWNER, { serviceType: 'maintenance' }));
    await assertFails(setDoc(doc(as(OWNER), 'professionalPosts', 'p2'),
      post(OWNER, OWNER, 'maintenance')));
  });

  it('engineer, landscaping, cleaning and lawyer still cannot publish', async () => {
    for (const t of ['engineer', 'landscaping', 'cleaning', 'lawyer']) {
      await testEnv.clearFirestore();
      await testEnv.withSecurityRulesDisabled(async (ctx) => {
        await setDoc(doc(ctx.firestore(), 'users', OWNER), { role: 'customer', createdAt: 1 });
      });
      await seedProvider(OWNER, providerDoc(OWNER, { serviceType: t }));
      await assertFails(setDoc(doc(as(OWNER), 'professionalPosts', `p-${t}`),
        post(OWNER, OWNER, t)));
    }
  });
});

// ---------------------------------------------------------------------
describe('3A / capability map <-> rules drift guard', () => {
  it('js/professional-roles.js matches the serviceType enum in firestore.rules', () => {
    const rules = readFileSync(new URL('../../firestore.rules', import.meta.url), 'utf8');
    const m = rules.match(/request\.resource\.data\.serviceType in \[([^\]]+)\]/);
    assert.ok(m, 'could not locate the serviceType enum in firestore.rules');
    const inRules = [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]).sort();
    const inMap = [...PROFESSIONAL_SERVICE_TYPES].sort();
    assert.deepEqual(inRules, inMap,
      `drift: firestore.rules has [${inRules}], js/professional-roles.js has [${inMap}]`);
  });
});
