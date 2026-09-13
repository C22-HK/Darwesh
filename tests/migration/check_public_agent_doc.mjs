// Post-migration rules check used by scripts/verify-private-profile-migration.sh.
// Runs INSIDE the emulator session, after `--mode apply`, through the real
// client SDK + firestore.rules (not the Admin SDK): proves that the migrated
// documents behave as intended for a signed-out visitor.
import { readFileSync } from 'node:fs';
import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { doc, getDoc } from 'firebase/firestore';

const testEnv = await initializeTestEnvironment({
  projectId: 'demo-darwesh',
  firestore: { rules: readFileSync(new URL('../../firestore.rules', import.meta.url), 'utf8'), host: '127.0.0.1', port: 8080 },
});
const guest = testEnv.unauthenticatedContext().firestore();
const owner = testEnv.authenticatedContext('agent-legacy-1').firestore();
const other = testEnv.authenticatedContext('customer-legacy-1').firestore();
let failures = 0;
function check(label, ok, detail) { console.log((ok ? 'PASS' : 'FAIL') + ' -- ' + label + (detail ? ' :: ' + detail : '')); if (!ok) failures++; }

const pub = await assertSucceeds(getDoc(doc(guest, 'users', 'agent-legacy-1')));
const data = pub.data() || {};
check('guest can still read the public agent document (agent.html / listing cards keep working)', pub.exists() && data.role === 'agent' && data.displayName === 'Legacy Agent');
check('public agent document carries NO private field after migration', !['email', 'phone', 'phoneVerified', 'emailVerified', 'commissionRate'].some((k) => k in data), JSON.stringify(Object.keys(data)));
await assertFails(getDoc(doc(guest, 'users', 'agent-legacy-1', 'privateProfile', 'main')));
check('guest CANNOT read the private profile', true);
await assertFails(getDoc(doc(other, 'users', 'agent-legacy-1', 'privateProfile', 'main')));
check('another signed-in user CANNOT read the private profile', true);
const priv = await assertSucceeds(getDoc(doc(owner, 'users', 'agent-legacy-1', 'privateProfile', 'main')));
check('the owner reads their own private profile with the migrated values', priv.exists() && priv.data().email === 'agent1@example.com' && priv.data().commissionRate === 2.5, JSON.stringify(priv.data()));

await testEnv.cleanup();
if (failures) process.exit(1);
