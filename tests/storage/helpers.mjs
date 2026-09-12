// Shared Storage Rules emulator test setup. Run via `npm run
// test:storage-rules` -- starts real Firestore + Storage emulators
// together (storage.rules' professional-work path cross-checks
// firestore.get() against serviceProviders, so both must be running),
// points these tests at them, and tears them down afterward. Never
// touches production.
//
// SEEDING REQUIREMENT (documented, not a bug in these tests or in
// storage.rules): every uid these tests authenticate as needs a real
// users/{uid} document -- storage.rules' isAdmin()/isAgentOrAdmin() do
// firestore.get(.../users/$(uid)).data.role, and a get() against a
// document that does not exist throws a generic "Null value error"
// rather than resolving .data to something a safe accessor could
// default -- regardless of the actual rule logic being exercised. That
// makes an assertFails() case "pass" for the wrong reason (a crash is
// still "not succeeded") while an assertSucceeds() case fails outright.
// If a test fails with exactly that symptom, check first whether every
// principal it authenticates as has a matching users/{uid} doc seeded
// (role: 'customer' is enough unless the test needs 'agent'/'admin') --
// this was misdiagnosed once as a sandbox network limitation (this
// comment used to say so); it was not one. A prior local sandbox
// separately had firebase-tools' own HTTP client (lib/apiv2.js) ignore
// NO_PROXY and route the Storage emulator's local firestore.get() bridge
// through an outbound proxy that then refused the loopback destination
// -- that was a real, distinct issue, but it is an environment/tooling
// interaction, not something to assume by default; verify with a
// one-authorized-plus-one-unauthorized minimal probe before attributing
// any future failure here to either cause.
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
