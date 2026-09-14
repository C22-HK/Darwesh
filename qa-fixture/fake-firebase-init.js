// =====================================================================
// QA FIXTURE -- fake replacement for js/firebase-init.js, TEST-ONLY.
//
// Served in place of the real ./js/firebase-init.js by Playwright route
// interception (see run-qa-screenshots.mjs) so admin.html can render
// fully against fixture data with no live Firebase project reachable.
// Exports the exact same names the real module does, self-contained
// (no network calls of its own). Never loaded by production -- the
// real js/firebase-init.js on disk is completely untouched.
// =====================================================================
import { collection, doc, getDocs, getDoc, setDoc, updateDoc, addDoc, deleteDoc, runTransaction } from './fake-firebase-firestore.js';

export const firebaseConfig = { apiKey: 'qa-fixture', authDomain: 'qa-fixture.test', projectId: 'qa-fixture', storageBucket: 'qa-fixture', messagingSenderId: '0', appId: 'qa-fixture' };
export const RECAPTCHA_ENTERPRISE_SITE_KEY = 'qa-fixture-site-key';

export const QA_ADMIN_UID = 'qa-u-01';

const qaAdminUser = {
  uid: QA_ADMIN_UID,
  email: 'rezan.ahmadi@example.test',
  displayName: 'Rezan Ahmadi',
  getIdToken: async () => 'qa-fixture-id-token',
  getIdTokenResult: async () => ({ claims: { role: 'admin' } }),
};

export const auth = {
  currentUser: qaAdminUser,
  // The standalone onAuthStateChanged() in fake-firebase-auth.js is what
  // admin.html actually calls; this method form exists only in case
  // some code path calls auth.onAuthStateChanged() directly.
  onAuthStateChanged(cb) { queueMicrotask(() => cb(qaAdminUser)); return () => {}; },
};
export const db = { __qaDb: true };
export const storage = { __qaStorage: true };

export async function waitForAppCheckToken() { return true; }

export { getDoc, setDoc, updateDoc, addDoc, deleteDoc, getDocs, runTransaction };

// Small, unmissable, dismissable-free banner so a screenshot can never
// be mistaken for production -- this module only ever loads during a
// QA fixture run (see the header comment above).
(function stampQaBanner() {
  function add() {
    if (document.getElementById('qaFixtureBanner')) return;
    const el = document.createElement('div');
    el.id = 'qaFixtureBanner';
    el.textContent = 'QA FIXTURE DATA — not production Firebase data';
    el.setAttribute('dir', 'ltr');
    el.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:2147483647;background:#7a1f1f;color:#fff;font:700 11px/1.6 -apple-system,Segoe UI,Roboto,sans-serif;text-align:center;padding:3px 8px;letter-spacing:.02em;pointer-events:none;';
    document.body.appendChild(el);
  }
  if (document.body) add(); else document.addEventListener('DOMContentLoaded', add);
})();
