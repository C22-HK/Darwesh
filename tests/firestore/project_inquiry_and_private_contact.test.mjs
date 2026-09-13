// Targeted regression tests for this pass's additions:
//   1. submissions/{id} 'project_inquiry' type -- real-project existence
//      check (mirrors the existing BL-06 'viewing' pattern), guest
//      (unauthenticated) create allowed, read restricted to the
//      submitter/admin.
//   2. organizations/{orgId} no longer accepts a 'contactInfo' field on
//      create/update (moved to the private subcollection below).
//   3. organizations/{orgId}/private/contact and
//      projects/{projectId}/private/contact -- not publicly readable,
//      readable by an org member/admin, writable only with the right
//      permission.
// Run with `npm run test:rules`.
import { before, after, beforeEach, describe, it } from 'node:test';
import { assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { doc, setDoc, addDoc, collection, getDoc } from 'firebase/firestore';
import { makeTestEnv, seed, dbFor } from './helpers.mjs';

let testEnv;
before(async () => { testEnv = await makeTestEnv(); });
after(async () => { await testEnv.cleanup(); });
beforeEach(async () => { await testEnv.clearFirestore(); });

async function seedOrg(orgId, data) { await seed(testEnv, (ctx) => setDoc(doc(ctx.firestore(), 'organizations', orgId), data)); }
async function seedOrgMember(orgId, uid, data) { await seed(testEnv, (ctx) => setDoc(doc(ctx.firestore(), 'organizations', orgId, 'members', uid), data)); }
async function seedRoleDefaults(accountType, permissions) { await seed(testEnv, (ctx) => setDoc(doc(ctx.firestore(), 'rolePermissionDefaults', accountType), { permissions })); }
async function seedProject(projectId, data) { await seed(testEnv, (ctx) => setDoc(doc(ctx.firestore(), 'projects', projectId), data)); }
// roleDefaultPermissions() resolves via users/{uid}.accountType -- a
// rolePermissionDefaults/{accountType} doc alone does nothing for a
// caller whose own user doc isn't tagged with that accountType.
async function seedUserAccountType(uid, accountType) { await seed(testEnv, (ctx) => setDoc(doc(ctx.firestore(), 'users', uid), { accountType })); }

describe('submissions: project_inquiry', () => {
  it('a guest (unauthenticated) can create a project_inquiry for a REAL project', async () => {
    await seedOrg('org1', { ownerId: 'dev1', type: 'developer_project', name: 'Dev Co' });
    await seedProject('proj1', { organizationId: 'org1', name: 'Test Towers', city: 'Kirkuk' });
    const db = dbFor(testEnv, null);
    await assertSucceeds(addDoc(collection(db, 'submissions'), {
      type: 'project_inquiry', projectId: 'proj1', projectName: 'Test Towers', city: 'Kirkuk',
      name: 'Ali', phone: '+9647701234567', uid: null, status: 'pending', createdAt: new Date()
    }));
  });

  it('a signed-in customer can create a project_inquiry naming themselves', async () => {
    await seedProject('proj1', { organizationId: 'org1', name: 'Test Towers', city: 'Kirkuk' });
    const db = dbFor(testEnv, 'customer1');
    await assertSucceeds(addDoc(collection(db, 'submissions'), {
      type: 'project_inquiry', projectId: 'proj1', projectName: 'Test Towers', city: 'Kirkuk',
      name: 'Ali', phone: '+9647701234567', uid: 'customer1', status: 'pending', createdAt: new Date()
    }));
  });

  it('rejects a project_inquiry naming a projectId that does not exist (BL-06 parity)', async () => {
    const db = dbFor(testEnv, null);
    await assertFails(addDoc(collection(db, 'submissions'), {
      type: 'project_inquiry', projectId: 'does-not-exist', projectName: 'Fake', city: 'Kirkuk',
      name: 'Ali', phone: '+9647701234567', uid: null, status: 'pending', createdAt: new Date()
    }));
  });

  it('rejects a project_inquiry whose uid does not match the caller', async () => {
    await seedProject('proj1', { organizationId: 'org1', name: 'Test Towers', city: 'Kirkuk' });
    const db = dbFor(testEnv, 'customer1');
    await assertFails(addDoc(collection(db, 'submissions'), {
      type: 'project_inquiry', projectId: 'proj1', projectName: 'Test Towers', city: 'Kirkuk',
      name: 'Ali', phone: '+9647701234567', uid: 'someone-else', status: 'pending', createdAt: new Date()
    }));
  });

  it('only the submitter and an admin can READ a project_inquiry -- not an unrelated signed-in user', async () => {
    await seed(testEnv, (ctx) => setDoc(doc(ctx.firestore(), 'submissions', 'sub1'), {
      type: 'project_inquiry', projectId: 'proj1', uid: 'customer1', status: 'pending'
    }));
    await assertSucceeds(getDoc(doc(dbFor(testEnv, 'customer1'), 'submissions', 'sub1')));
    await assertFails(getDoc(doc(dbFor(testEnv, 'someone-else'), 'submissions', 'sub1')));
    await assertFails(getDoc(doc(dbFor(testEnv, null), 'submissions', 'sub1')));
  });
});

describe('organizations: contactInfo no longer public', () => {
  it('rejects creating an organization with a contactInfo field (not in the public allowlist)', async () => {
    const db = dbFor(testEnv, 'dev1');
    await assertFails(setDoc(doc(db, 'organizations', 'org1'), {
      ownerId: 'dev1', type: 'developer_project', name: 'Dev Co',
      contactInfo: { phone: '+9647701234567' }, verified: false
    }));
  });

  it('still accepts creating an organization WITHOUT contactInfo', async () => {
    const db = dbFor(testEnv, 'dev1');
    await assertSucceeds(setDoc(doc(db, 'organizations', 'org1'), {
      ownerId: 'dev1', type: 'developer_project', name: 'Dev Co', verified: false
    }));
  });
});

describe('organizations/{orgId}/private/contact', () => {
  beforeEach(async () => {
    await seedOrg('org1', { ownerId: 'dev1', type: 'developer_project', name: 'Dev Co', verified: false });
  });

  it('a random public/unauthenticated reader CANNOT read the private contact doc', async () => {
    await seed(testEnv, (ctx) => setDoc(doc(ctx.firestore(), 'organizations', 'org1', 'private', 'contact'), { phone: '+9647701234567' }));
    await assertFails(getDoc(doc(dbFor(testEnv, null), 'organizations', 'org1', 'private', 'contact')));
    await assertFails(getDoc(doc(dbFor(testEnv, 'random-user'), 'organizations', 'org1', 'private', 'contact')));
  });

  it('the org OWNER can read and write the private contact doc once granted manage_organization_profile', async () => {
    await seedUserAccountType('dev1', 'developer_project');
    await seedRoleDefaults('developer_project', { manage_organization_profile: true });
    const db = dbFor(testEnv, 'dev1');
    await assertSucceeds(setDoc(doc(db, 'organizations', 'org1', 'private', 'contact'), { phone: '+9647701234567', updatedAt: new Date() }));
    await assertSucceeds(getDoc(doc(db, 'organizations', 'org1', 'private', 'contact')));
  });

  it('the org owner CANNOT write the private contact doc without the permission (no role defaults / override configured)', async () => {
    // No seedRoleDefaults call here -- this is the real, disclosed
    // production gap this session's report calls out: ownership alone is
    // not hasOrgPermission()'s bar.
    const db = dbFor(testEnv, 'dev1');
    await assertFails(setDoc(doc(db, 'organizations', 'org1', 'private', 'contact'), { phone: '+9647701234567', updatedAt: new Date() }));
  });
});

describe('projects/{projectId}/private/contact', () => {
  beforeEach(async () => {
    await seedOrg('org1', { ownerId: 'dev1', type: 'developer_project', name: 'Dev Co', verified: false });
    await seedProject('proj1', { organizationId: 'org1', name: 'Test Towers', city: 'Kirkuk' });
  });

  it('a random public/unauthenticated reader CANNOT read the project private contact doc', async () => {
    await seed(testEnv, (ctx) => setDoc(doc(ctx.firestore(), 'projects', 'proj1', 'private', 'contact'), { phone: '+9647701234567' }));
    await assertFails(getDoc(doc(dbFor(testEnv, null), 'projects', 'proj1', 'private', 'contact')));
  });

  it('the org owner can write it once granted edit_own_project', async () => {
    await seedUserAccountType('dev1', 'developer_project');
    await seedRoleDefaults('developer_project', { edit_own_project: true });
    const db = dbFor(testEnv, 'dev1');
    await assertSucceeds(setDoc(doc(db, 'projects', 'proj1', 'private', 'contact'), { phone: '+9647701234567', updatedAt: new Date() }));
  });

  it('an unrelated signed-in user cannot write it even with unrelated role defaults', async () => {
    await seedRoleDefaults('developer_project', { edit_own_project: true });
    const db = dbFor(testEnv, 'random-user');
    await assertFails(setDoc(doc(db, 'projects', 'proj1', 'private', 'contact'), { phone: '+9647701234567', updatedAt: new Date() }));
  });
});
