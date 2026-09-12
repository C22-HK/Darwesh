// Shared Firestore Rules emulator test setup.
//
// Run via `npm run test:rules` (wraps `firebase emulators:exec` around
// `node --test tests/firestore/`) -- that command starts a real Firestore
// emulator, points these tests at it, and tears it down afterward. These
// tests never touch production; the emulator has no real credentials and
// only exists for the life of the test run.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { initializeTestEnvironment } from '@firebase/rules-unit-testing';

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
  });
}

// Seeds documents bypassing security rules entirely -- the emulator-test
// equivalent of "written by the backend's Admin SDK credential," which is
// exactly the write path every access-control collection in Phase 1 is
// restricted to (see firestore.rules' new "Admin Access & Permissions"
// section and every `ownerId`/`permissionOverrides` lock).
export async function seed(testEnv, fn) {
  return testEnv.withSecurityRulesDisabled(fn);
}

export function dbFor(testEnv, uid) {
  return uid === null ? testEnv.unauthenticatedContext().firestore() : testEnv.authenticatedContext(uid).firestore();
}
