// QA FIXTURE -- fake replacement for the gstatic firebase-storage.js
// module. TEST-ONLY; see fake-firebase-init.js's header comment. Not
// exercised by the People/Properties/Discounts screens this harness
// targets (no photo upload flow is part of that QA pass) -- these
// exist only so the import doesn't throw a missing-export error.
export function getStorage() { return { __qaStorage: true }; }
export function ref() { return { __qaStorageRef: true }; }
export async function uploadBytes() { return { ref: { __qaStorageRef: true } }; }
export async function getDownloadURL() { return 'about:blank'; }
export async function getBytes() { return new Uint8Array(); }
export async function listAll() { return { items: [], prefixes: [] }; }
export async function deleteObject() {}
