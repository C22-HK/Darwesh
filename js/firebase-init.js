// Shared Firebase initialization — imported by every page that needs
// auth or the database. Keeping this in one place means the config only
// lives in one file. Every page that touches Firebase, directly or via
// a shared widget (js/notification-bell.js, js/city-nav.js), ends up
// importing THIS module -- and because ES modules are cached/de-duped
// by the browser, its top-level code (including the App Check call
// below) runs exactly once per page load no matter how many different
// scripts import it. That's what makes this the single correct place
// to wire up App Check, rather than repeating it per page.
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-app.js";
import { initializeAppCheck, ReCaptchaEnterpriseProvider } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-app-check.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";
import { getStorage } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-storage.js";

export const firebaseConfig = {
  apiKey: "AIzaSyBZQTkwRZNZL-HmNBx_i33QoSpSjIMin_8",
  authDomain: "darwesh-group.firebaseapp.com",
  projectId: "darwesh-group",
  storageBucket: "darwesh-group.firebasestorage.app",
  messagingSenderId: "353477435585",
  appId: "1:353477435585:web:1c86f48a2e4302cd953440",
  measurementId: "G-QVJBWKFC97"
};

// The reCAPTCHA Enterprise SITE key registered for this project's App
// Check config (Firebase Console -> Build -> App Check -> Apps ->
// Darwesh Group Website). This is meant to be public, the same way
// firebaseConfig.apiKey above is -- it identifies which site is asking
// for a token, it isn't a credential. The matching SECRET key never
// leaves Google Cloud Console and has no reason to ever be near this
// codebase.
const RECAPTCHA_ENTERPRISE_SITE_KEY = "6Lf0R5wtAAAAAOdPlVleLXnMdvbKilzztL27kUNq";

const app = initializeApp(firebaseConfig);

// App Check proves a request is coming from this real web app (via a
// reCAPTCHA Enterprise attestation), not just from someone with the
// public firebaseConfig values -- a separate layer from Firebase Auth
// ("who is this user?"). Initialized immediately after initializeApp(),
// before auth/db/storage are handed to any caller, so no Firebase
// request can leave before App Check is attached to the app instance.
//
// Wrapped in try/catch on purpose: App Check enforcement is NOT enabled
// yet (Firebase Console -> App Check -> Firestore/Storage/Auth all
// still in "unenforced/monitoring" mode as of this change), so a failure
// here -- reCAPTCHA's script blocked by an ad-blocker, offline, a
// misconfigured key -- must never take the whole site down with it.
// Every Firestore/Storage/Auth call below still works without a token
// while enforcement is off; it just won't show up as "verified" in the
// App Check metrics for that session. This is exactly why enforcement
// shouldn't be turned on until those metrics show real traffic getting
// valid tokens -- see docs/APP_CHECK.md.
try {
  initializeAppCheck(app, {
    provider: new ReCaptchaEnterpriseProvider(RECAPTCHA_ENTERPRISE_SITE_KEY),
    isTokenAutoRefreshEnabled: true
  });
} catch (err) {
  console.error('[firebase-init] App Check failed to initialize -- continuing without it', err);
}

export const auth = getAuth(app);
export const db = getFirestore(app);
export const storage = getStorage(app);
