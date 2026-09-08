// Regression tests for this pass's two new workflows:
//   1. Admin-approval-before-publication for projects/{id} -- draft ->
//      pending_review -> published/changes_requested/rejected, and the
//      private/pendingRevision mechanism for revising an already-published
//      project without the live public content changing until approved.
//   2. Mark-as-sold for units/{id} -- an owner can only ever REPORT a sale
//      (saleReportStatus none -> pending); only isAdmin() can confirm it
//      (status -> sold/rented, saleReportStatus -> confirmed), backed by an
//      immutable-once-resolved saleReports/{id} audit record.
// Run with `npm run test:rules`.
import { before, after, beforeEach, describe, it } from 'node:test';
import { assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { doc, setDoc, addDoc, updateDoc, collection, getDoc, getDocs, query, where, deleteDoc } from 'firebase/firestore';
import { makeTestEnv, seed, dbFor } from './helpers.mjs';

let testEnv;
before(async () => { testEnv = await makeTestEnv(); });
after(async () => { await testEnv.cleanup(); });
beforeEach(async () => { await testEnv.clearFirestore(); });

async function seedDoc(path, data) { await seed(testEnv, (ctx) => setDoc(doc(ctx.firestore(), ...path), data)); }
async function seedOrg(orgId, data) { await seedDoc(['organizations', orgId], data); }
async function seedUser(uid, data) { await seedDoc(['users', uid], data); }
async function seedProject(projectId, data) { await seedDoc(['projects', projectId], data); }
async function seedUnit(unitId, data) { await seedDoc(['units', unitId], data); }
async function seedRoleDefaults(accountType, permissions) { await seedDoc(['rolePermissionDefaults', accountType], { permissions }); }

async function seedOwnerContext(uid = 'dev1', orgId = 'org1') {
  await seedOrg(orgId, { ownerId: uid, type: 'developer_project', name: 'Dev Co', verified: false });
  await seedUser(uid, { role: 'customer', accountType: 'developer_project' });
  await seedRoleDefaults('developer_project', {
    create_project: true, edit_own_project: true, create_unit: true, edit_own_unit: true, manage_organization_profile: true
  });
}

function validProject(overrides = {}) {
  return {
    organizationId: 'org1', name: 'Zaytoon Hills', city: 'Kirkuk', constructionStatus: 'under_construction',
    currency: 'USD', startingPrice: 120000, publicationStatus: 'draft', createdAt: 1, updatedAt: 1,
    ...overrides
  };
}
function omit(obj, key) { const copy = { ...obj }; delete copy[key]; return copy; }

function validUnit(overrides = {}) {
  return {
    // city must match validProject()'s city -- isValidUnitContent()
    // requires a unit's location fields to provably match its parent
    // project's current values whenever either side sets them.
    organizationId: 'org1', projectId: 'proj1', unitNumber: 'A-101', propertyType: 'apartment',
    listingType: 'sale', status: 'available', priceAmount: 150000, currency: 'USD', city: 'Kirkuk',
    saleReportStatus: 'none', createdAt: 1, updatedAt: 1,
    ...overrides
  };
}

describe('projects: admin-approval-before-publication', () => {
  it('a brand-new project cannot be created already published (self-certification denied)', async () => {
    await seedOwnerContext();
    const db = dbFor(testEnv, 'dev1');
    await assertFails(setDoc(doc(db, 'projects', 'proj1'), validProject({ publicationStatus: 'published' })));
    await assertSucceeds(setDoc(doc(db, 'projects', 'proj1'), validProject({ publicationStatus: 'draft' })));
  });

  it('a draft/pending_review project is NOT publicly readable (get denied to an outsider), but IS readable by its own org', async () => {
    await seedOwnerContext();
    await seedProject('proj1', validProject({ publicationStatus: 'pending_review' }));
    await assertFails(getDoc(doc(dbFor(testEnv, null), 'projects', 'proj1')));
    await assertFails(getDoc(doc(dbFor(testEnv, 'random-user'), 'projects', 'proj1')));
    await assertSucceeds(getDoc(doc(dbFor(testEnv, 'dev1'), 'projects', 'proj1')));
  });

  it('a bare public list() query with no publicationStatus constraint is denied outright (cannot leak drafts via an under-constrained query)', async () => {
    await seedOwnerContext();
    await seedProject('proj1', validProject({ publicationStatus: 'pending_review', city: 'Kirkuk' }));
    await assertFails(getDocs(query(collection(dbFor(testEnv, null), 'projects'), where('city', '==', 'Kirkuk'))));
  });

  it('once published, a public query correctly returns it', async () => {
    await seedOwnerContext();
    await seedProject('proj1', validProject({ publicationStatus: 'published', city: 'Kirkuk' }));
    await assertSucceeds(getDocs(query(collection(dbFor(testEnv, null), 'projects'), where('city', '==', 'Kirkuk'), where('publicationStatus', '==', 'published'))));
    const snap = await getDocs(query(collection(dbFor(testEnv, null), 'projects'), where('city', '==', 'Kirkuk'), where('publicationStatus', '==', 'published')));
    if (snap.empty) throw new Error('expected the published project to be returned');
  });

  it('the owner can move draft -> pending_review (submit) but can never self-set published/rejected/changes_requested', async () => {
    await seedOwnerContext();
    await seedProject('proj1', validProject({ publicationStatus: 'draft' }));
    const db = dbFor(testEnv, 'dev1');
    await assertSucceeds(updateDoc_(db, 'proj1', { publicationStatus: 'pending_review', updatedAt: 2 }));
    await assertFails(updateDoc_(db, 'proj1', { publicationStatus: 'published', updatedAt: 3 }));
    await assertFails(updateDoc_(db, 'proj1', { publicationStatus: 'rejected', updatedAt: 3 }));
  });
  async function updateDoc_(db, id, data) {
    return updateDoc(doc(db, 'projects', id), data);
  }

  it('only isAdmin() can publish a pending_review project', async () => {
    await seedOwnerContext();
    await seedUser('admin1', { role: 'admin' });
    await seedProject('proj1', validProject({ publicationStatus: 'pending_review' }));
    await assertFails(updateDoc(doc(dbFor(testEnv, 'dev1'), 'projects', 'proj1'), { publicationStatus: 'published', updatedAt: 2 }));
    await assertSucceeds(updateDoc(doc(dbFor(testEnv, 'admin1'), 'projects', 'proj1'), { publicationStatus: 'published', updatedAt: 2 }));
  });

  it('once published, the owner cannot edit the live content directly -- only stage a revisionStatus:"pending_review" marker', async () => {
    await seedOwnerContext();
    await seedProject('proj1', validProject({ publicationStatus: 'published', name: 'Zaytoon Hills' }));
    const db = dbFor(testEnv, 'dev1');
    await assertFails(updateDoc(doc(db, 'projects', 'proj1'), { name: 'Renamed Without Review', updatedAt: 2 }));
    await assertSucceeds(updateDoc(doc(db, 'projects', 'proj1'), { revisionStatus: 'pending_review', updatedAt: 2 }));
    // The live public name is completely untouched.
    const snap = await getDoc(doc(dbFor(testEnv, null), 'projects', 'proj1'));
    if (snap.data().name !== 'Zaytoon Hills') throw new Error('live content changed without admin approval');
  });

  it('the proposed revision is staged in private/pendingRevision -- readable by the org/admin, denied to a public/random reader', async () => {
    await seedOwnerContext();
    await seedProject('proj1', validProject({ publicationStatus: 'published' }));
    const db = dbFor(testEnv, 'dev1');
    await assertSucceeds(setDoc(doc(db, 'projects', 'proj1', 'private', 'pendingRevision'), omit(validProject({ name: 'Zaytoon Hills Phase 2' }), 'publicationStatus')));
    await assertFails(getDoc(doc(dbFor(testEnv, null), 'projects', 'proj1', 'private', 'pendingRevision')));
    await assertFails(getDoc(doc(dbFor(testEnv, 'random-user'), 'projects', 'proj1', 'private', 'pendingRevision')));
    await assertSucceeds(getDoc(doc(db, 'projects', 'proj1', 'private', 'pendingRevision')));
  });

  it('admin approving a revision merges it onto the live doc and clears the pending flag', async () => {
    await seedOwnerContext();
    await seedUser('admin1', { role: 'admin' });
    await seedProject('proj1', validProject({ publicationStatus: 'published', name: 'Old Name', revisionStatus: 'pending_review' }));
    await seedDoc(['projects', 'proj1', 'private', 'pendingRevision'], omit(validProject({ name: 'New Approved Name' }), 'publicationStatus'));
    const adminDb = dbFor(testEnv, 'admin1');
    await assertSucceeds(updateDoc(doc(adminDb, 'projects', 'proj1'), { name: 'New Approved Name', revisionStatus: 'none', updatedAt: 3 }));
    await assertSucceeds(deleteDoc(doc(adminDb, 'projects', 'proj1', 'private', 'pendingRevision')));
    const snap = await getDoc(doc(dbFor(testEnv, null), 'projects', 'proj1'));
    if (snap.data().name !== 'New Approved Name') throw new Error('approved revision was not applied');
  });
});

describe('units: mark-as-sold admin-confirmation workflow', () => {
  beforeEach(async () => {
    await seedOwnerContext();
    await seedProject('proj1', validProject({ publicationStatus: 'published' }));
  });

  it('a unit cannot be created without saleReportStatus:"none" explicitly (guards the public query gate)', async () => {
    const db = dbFor(testEnv, 'dev1');
    await assertFails(setDoc(doc(db, 'units', 'unit1'), omit(validUnit(), 'saleReportStatus')));
    await assertSucceeds(setDoc(doc(db, 'units', 'unit1'), validUnit()));
  });

  it('the owning org can report a sale (saleReportStatus -> pending) but cannot self-confirm status -> sold', async () => {
    await seedUnit('unit1', validUnit({ status: 'available' }));
    const db = dbFor(testEnv, 'dev1');
    await assertFails(updateDoc(doc(db, 'units', 'unit1'), { status: 'sold', updatedAt: 2 }));
    await assertSucceeds(updateDoc(doc(db, 'units', 'unit1'), { saleReportStatus: 'pending', updatedAt: 2 }));
    await assertFails(updateDoc(doc(db, 'units', 'unit1'), { saleReportStatus: 'confirmed', updatedAt: 3 }));
  });

  it('a saleReports doc can be created by the owning org, referencing a real unit it actually owns', async () => {
    await seedUnit('unit1', validUnit({ status: 'available' }));
    const db = dbFor(testEnv, 'dev1');
    await assertSucceeds(addDoc(collection(db, 'saleReports'), {
      organizationId: 'org1', unitId: 'unit1', projectId: 'proj1', reportedByUid: 'dev1',
      saleDate: '2026-01-15', status: 'pending', evidenceRequired: false, createdAt: 1, updatedAt: 1
    }));
  });

  it('an org cannot report a sale for a unit belonging to a DIFFERENT organization', async () => {
    await seedOrg('org2', { ownerId: 'dev2', type: 'developer_project', name: 'Rival Co', verified: false });
    await seedUser('dev2', { role: 'customer', accountType: 'developer_project' });
    await seedRoleDefaults('developer_project', { create_unit: true, edit_own_unit: true, create_project: true, edit_own_project: true });
    await seedUnit('unit1', validUnit({ organizationId: 'org1', status: 'available' }));
    const db = dbFor(testEnv, 'dev2');
    await assertFails(addDoc(collection(db, 'saleReports'), {
      organizationId: 'org2', unitId: 'unit1', projectId: 'proj1', reportedByUid: 'dev2',
      saleDate: '2026-01-15', status: 'pending', createdAt: 1, updatedAt: 1
    }));
  });

  it('only the reporting org and an admin can read a saleReport -- not an unrelated org', async () => {
    await seedOrg('org2', { ownerId: 'dev2', type: 'developer_project', name: 'Rival Co', verified: false });
    await seedUser('admin1', { role: 'admin' });
    await seedDoc(['saleReports', 'sr1'], { organizationId: 'org1', unitId: 'unit1', projectId: 'proj1', reportedByUid: 'dev1', saleDate: '2026-01-15', status: 'pending', createdAt: 1 });
    await assertSucceeds(getDoc(doc(dbFor(testEnv, 'dev1'), 'saleReports', 'sr1')));
    await assertSucceeds(getDoc(doc(dbFor(testEnv, 'admin1'), 'saleReports', 'sr1')));
    await assertFails(getDoc(doc(dbFor(testEnv, 'dev2'), 'saleReports', 'sr1')));
    await assertFails(getDoc(doc(dbFor(testEnv, null), 'saleReports', 'sr1')));
  });

  it('only admin can confirm a pending saleReport; the owner cannot resolve their own report (no self-approval)', async () => {
    await seedDoc(['saleReports', 'sr1'], { organizationId: 'org1', unitId: 'unit1', projectId: 'proj1', reportedByUid: 'dev1', saleDate: '2026-01-15', status: 'pending', createdAt: 1 });
    await seedUser('admin1', { role: 'admin' });
    await assertFails(updateDoc(doc(dbFor(testEnv, 'dev1'), 'saleReports', 'sr1'), { status: 'confirmed', updatedAt: 2 }));
    await assertSucceeds(updateDoc(doc(dbFor(testEnv, 'admin1'), 'saleReports', 'sr1'), { status: 'confirmed', updatedAt: 2 }));
  });

  it('rejection (clarification_requested) must carry both an adminNote and an explicit availabilityDecision -- cannot silently resolve', async () => {
    await seedDoc(['saleReports', 'sr1'], { organizationId: 'org1', unitId: 'unit1', projectId: 'proj1', reportedByUid: 'dev1', saleDate: '2026-01-15', status: 'pending', createdAt: 1 });
    await seedUser('admin1', { role: 'admin' });
    const adminDb = dbFor(testEnv, 'admin1');
    await assertFails(updateDoc(doc(adminDb, 'saleReports', 'sr1'), { status: 'clarification_requested', updatedAt: 2 }));
    await assertSucceeds(updateDoc(doc(adminDb, 'saleReports', 'sr1'), {
      status: 'clarification_requested', adminNote: 'Please attach the signed contract.', availabilityDecision: 'keep_unavailable', updatedAt: 2
    }));
  });

  it('a resolved saleReport is immutable -- not even admin can change it again (preserves audit history)', async () => {
    await seedDoc(['saleReports', 'sr1'], { organizationId: 'org1', unitId: 'unit1', projectId: 'proj1', reportedByUid: 'dev1', saleDate: '2026-01-15', status: 'confirmed', createdAt: 1 });
    await seedUser('admin1', { role: 'admin' });
    await assertFails(updateDoc(doc(dbFor(testEnv, 'admin1'), 'saleReports', 'sr1'), { status: 'pending', updatedAt: 2 }));
    await assertFails(deleteDoc(doc(dbFor(testEnv, 'admin1'), 'saleReports', 'sr1')));
  });

  it('confirming one unit sold never touches a sibling unit in the same project (no project-wide cascade)', async () => {
    await seedUnit('unit1', validUnit({ unitNumber: 'A-101', status: 'available' }));
    await seedUnit('unit2', validUnit({ unitNumber: 'A-102', status: 'available' }));
    await seedUser('admin1', { role: 'admin' });
    const adminDb = dbFor(testEnv, 'admin1');
    await assertSucceeds(updateDoc(doc(adminDb, 'units', 'unit1'), { status: 'sold', saleReportStatus: 'confirmed', updatedAt: 2 }));
    const sibling = await getDoc(doc(dbFor(testEnv, null), 'units', 'unit2'));
    if (sibling.data().status !== 'available') throw new Error('sibling unit was affected by marking a different unit sold');
  });

  it('a unit that is pending sale confirmation is excluded from the public "available units" query shape', async () => {
    await seedUnit('unit1', validUnit({ status: 'available', saleReportStatus: 'pending' }));
    await seedUnit('unit2', validUnit({ unitNumber: 'A-102', status: 'available', saleReportStatus: 'none' }));
    const snap = await getDocs(query(
      collection(dbFor(testEnv, null), 'units'),
      where('projectId', '==', 'proj1'),
      where('status', 'in', ['coming_soon', 'available']),
      where('saleReportStatus', '==', 'none')
    ));
    const ids = []; snap.forEach((d) => ids.push(d.id));
    if (ids.includes('unit1')) throw new Error('a unit with a pending sale report leaked into the public available-units query');
    if (!ids.includes('unit2')) throw new Error('a genuinely available unit was wrongly excluded');
  });
});
