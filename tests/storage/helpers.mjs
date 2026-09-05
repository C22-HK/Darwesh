// Shared Storage Rules emulator test setup. Run via `npm run
// test:storage-rules` -- starts real Firestore + Storage emulators
// together (storage.rules' professional-work path cross-checks
// firestore.get() against serviceProviders, so both must be running),
// points these tests at them, and tears them down afterward. Never
// touches production.
//
// KNOWN ENVIRONMENT LIMITATION (documented, not a bug in these tests or
// in storage.rules): the Storage emulator's own rules-runtime process
// needs outbound access to firebase-public.firebaseio.com to service a
// firestore.get() cross-service call. In a network-restricted sandbox
// that blocks that host, EVERY firestore.get() call inside storage.rules
// -- including the pre-existing, unmodified isAdmin() helper -- throws a
// generic "Null value error" regardless of the actual rule logic or
// seeded data, which makes assertFails() cases look like they pass for
// the wrong reason (a crash is still "not succeeded") while assertSucceeds()
// cases correctly and visibly fail. If these tests fail with exactly
// that symptom, verify network access to firebase-public.firebaseio.com
// before concluding storage.rules itself is wrong -- compare against the
// already-shipped company-logos/{companyId} block, which uses the
// identical firestore.get() cross-check pattern.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { initializeTestEnvironment } from '@firebase/rules-unit-testing';
import { doc, setDoc } from 'firebase/firestore';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..', '..');

export const PROJECT_ID = 'demo-darwesh';

export async function makeTestEnv() {
  return initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: {
      rules: readFileSync(join(repoRoot, 'firestore.rules'), 'utf8'),
      host: '127.0.0.1',
      port: 8080,
    },
    storage: {
      rules: readFileSync(join(repoRoot, 'storage.rules'), 'utf8'),
      host: '127.0.0.1',
      port: 9199,
    },
  });
}

// Seeds a Firestore document bypassing security rules (the Admin-SDK
// equivalent) -- used here only to set up the serviceProviders record
// storage.rules cross-references, never to touch Storage objects
// directly (those go through the rules-enforced client contexts below,
// which is the actual thing under test).
export async function seedFirestore(testEnv, path, data) {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), ...path), data);
  });
}

export function storageFor(testEnv, uid) {
  return uid === null ? testEnv.unauthenticatedContext().storage() : testEnv.authenticatedContext(uid).storage();
}
