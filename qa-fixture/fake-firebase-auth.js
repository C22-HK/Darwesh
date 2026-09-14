// QA FIXTURE -- fake replacement for the gstatic firebase-auth.js
// module. TEST-ONLY; see fake-firebase-init.js's header comment.
//
// admin.html's own auth gate calls the standalone onAuthStateChanged()
// (imported directly from this URL), passing the `auth` object it
// imported from firebase-init.js -- so this fires the callback with
// THAT object's currentUser, keeping identity consistent with the rest
// of the fixture (same QA admin, same uid) rather than minting a
// second disconnected fake user here.
export function onAuthStateChanged(authObj, cb) {
  queueMicrotask(() => cb(authObj && authObj.currentUser));
  return () => {};
}
export function getAuth() {
  return { currentUser: null, onAuthStateChanged: (cb) => onAuthStateChanged({ currentUser: null }, cb) };
}
export async function signInWithEmailAndPassword() { throw new Error('QA fixture: sign-in is disabled in this harness.'); }
export async function signOut() {}
export async function sendPasswordResetEmail() {}
export async function createUserWithEmailAndPassword() { throw new Error('QA fixture: account creation is disabled in this harness.'); }
export async function updateProfile() {}
export async function deleteUser() {}
