// Shared Firebase initialization — imported by every page that needs
// auth or the database. Keeping this in one place means the config only
// lives in one file. Every page that touches Firebase, directly or via
// a shared widget (js/notification-bell.js), ends up
// importing THIS module -- and because ES modules are cached/de-duped
// by the browser, its top-level code (including the App Check call
// below) runs exactly once per page load no matter how many different
// scripts import it. That's what makes this the single correct place
// to wire up App Check, rather than repeating it per page.
import { initializeApp, getApps, getApp } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-app.js";
import { initializeAppCheck, ReCaptchaEnterpriseProvider, getToken as getAppCheckToken } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-app-check.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-auth.js";
import {
  getFirestore,
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
  queryEqual,
  getDocs as _getDocs,
  getDoc as _getDoc,
  addDoc as _addDoc,
  setDoc as _setDoc,
  updateDoc as _updateDoc,
  deleteDoc as _deleteDoc,
  runTransaction as _runTransaction,
  getCountFromServer as _getCountFromServer
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";
import { getStorage } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-storage.js";
import { dedupeDocRequest, dedupeQueryRequest } from "./data-cache.js";

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
// codebase. Exported so any page that creates its OWN secondary/
// temporary FirebaseApp instance (App Check is bound per-app-instance,
// so the primary app's token doesn't cover a second instance -- see
// admin.html's "Add Agent" flow) can attach App Check to it too,
// without hardcoding the key a second time.
export const RECAPTCHA_ENTERPRISE_SITE_KEY = "6Lf0R5wtAAAAAOdPlVleLXnMdvbKilzztL27kUNq";

// 5s: a bounded circuit breaker against a hard-hung external dependency
// (e.g. an ad-blocker silently swallowing the reCAPTCHA request with
// neither success nor error), not a blanket "wait a bit and hope" delay
// -- normal reCAPTCHA Enterprise round trips complete in a small
// fraction of this. Exported so a secondary app instance's own gate
// (see waitForAppCheckToken below) uses the identical value rather than
// a second hardcoded number that could drift out of sync.
export const APP_CHECK_TOKEN_TIMEOUT_MS = 5000;

// Builds an "appCheckReady"-style promise for ANY FirebaseApp instance,
// not just the primary one -- reused below for `app`, and reusable by
// any page that creates its own secondary/temporary FirebaseApp
// instance and needs the same guarantee: no request against THAT app's
// Firestore/Auth/Storage should be sent before a real App Check token
// has had a fair chance to attach to it. Written once, here, rather
// than duplicating the wait/timeout/logging logic at every call site
// that needs it.
export function waitForAppCheckToken(appCheckInstance, label) {
  if (!appCheckInstance) return Promise.resolve();
  return Promise.race([
    getAppCheckToken(appCheckInstance).then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), APP_CHECK_TOKEN_TIMEOUT_MS))
  ])
    .then((gotToken) => {
      if (!gotToken) {
        // Logged, not swallowed -- this is exactly the "unverified"
        // outcome the App Check metrics are meant to surface, so it
        // must show up somewhere a developer can actually see it, not
        // just quietly disappear into a proceeding request.
        console.error('[' + label + '] App Check token not obtained within ' + APP_CHECK_TOKEN_TIMEOUT_MS + 'ms -- proceeding without one for this session');
      }
    })
    .catch((err) => {
      console.error('[' + label + '] App Check getToken() failed -- proceeding without one for this session', err);
    });
}

// Safe to import this exact module more than once under a different URL
// -- sell.html's submission flow retries its dynamic imports under a
// cache-busting query param if one fails, because a browser permanently
// blacklists a URL that ever failed to fetch, even after the network
// recovers, and this module's own transitive imports (e.g.
// firebase-storage.js, needed below for getStorage) can be part of what
// failed. Reuses the existing default app instance if one was already
// created by an earlier successful import, instead of calling
// initializeApp() again -- which would throw Firebase's own "app named
// '[DEFAULT]' already exists" error.
const app = getApps().some((a) => a.name === '[DEFAULT]') ? getApp() : initializeApp(firebaseConfig);

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
let appCheckInstance = null;
try {
  appCheckInstance = initializeAppCheck(app, {
    provider: new ReCaptchaEnterpriseProvider(RECAPTCHA_ENTERPRISE_SITE_KEY),
    isTokenAutoRefreshEnabled: true
  });
} catch (err) {
  console.error('[firebase-init] App Check failed to initialize -- continuing without it', err);
}

// Closes the race between App Check and the very first Firestore
// request: initializeAppCheck() above returns immediately, but actually
// obtaining a token means reCAPTCHA Enterprise injecting and loading ITS
// OWN script and completing a real round trip -- easily slower than a
// page's first Firestore read, which several pages/widgets
// (js/notification-bell.js, buy.html/map.html/index.html loading
// `listings` right away) fire immediately on load. Measured on
// the live site: Storage/Auth (whose calls happen after a deliberate
// user action, well after this settles) sit at 100% verified, while
// Firestore sat at 1-5% verified -- direct evidence of this exact race,
// not a hypothetical. getAppCheckToken() is the official App Check API
// for "wait until a valid token is actually available" (Firebase Auth/
// Storage's own SDKs already handle this internally for their calls,
// which is exactly why they don't need this).
//
// This does not add a new security boundary by itself -- App Check
// enforcement is still off for every service (Console: App Check ->
// Firestore/Storage/Authentication all "Monitoring") -- it only makes
// the *metrics* honest by giving every Firestore call a real chance to
// carry a token before it's sent, which is what the phased rollout in
// docs/APP_CHECK.md is waiting on before enforcement can safely turn on.
export const appCheckReady = waitForAppCheckToken(appCheckInstance, 'firebase-init');

export const auth = getAuth(app);

// Firestore with a persistent (IndexedDB) local cache instead of the
// default memory-only one. Two concrete wins, no behaviour change:
//
//   * A document this browser has already downloaded survives a full page
//     navigation and a tab reload. This site is many separate HTML
//     documents, not an SPA, so without this every navigation starts from
//     an empty cache -- buy.html downloads a listing, and listing.html
//     immediately downloads the very same document again.
//   * Firestore can answer a repeat query from disk while it revalidates,
//     and a brief network drop stops being a blank page.
//
// persistentMultipleTabManager() rather than the single-tab default: this
// site is routinely opened in several tabs (a listing in one, the map in
// another), and the single-tab manager fails to enable persistence at all
// in the second tab. The multi-tab manager coordinates them instead.
//
// This changes NOTHING about authorization. The cache only ever holds
// documents the server already agreed to send this client under
// firestore.rules, and every read still goes to the server for freshness
// unless a caller explicitly asks for the cached copy. It is a latency
// change, not a permission change.
//
// ORDERING, AND WHY getFirestore IS STILL IMPORTED.
//
// initializeFirestore() must run before anything calls getFirestore() on
// this app; afterwards the settings can no longer be changed and the call
// throws FirebaseError code 'failed-precondition'. That ordering holds
// here structurally, not by convention: getFirestore(app) below is
// reachable ONLY from the catch block, so on the success path it is never
// called at all, and on the failure path initializeFirestore() has
// already run. This module is also the only place that touches the
// DEFAULT app's Firestore -- admin.html's getFirestore() call is against
// its own short-lived secondary app instance ('agent-create-<ts>'), which
// has a separate Firestore of its own and is unaffected by any of this.
//
// Both calls return the SAME per-app singleton, so the catch path adopts
// the existing instance rather than creating a second one. Verified
// against firebase 12.18.0, the exact version pinned in the CDN imports
// above: a second initializeFirestore() throws 'failed-precondition', and
// the getFirestore(app) that follows returns an instance identical (===)
// to the one the first call produced -- persistent cache and all.
//
// The throw is an expected, benign path, not a malfunction: sell.html
// deliberately re-imports this module under a cache-busting query string
// when a dynamic import fails, which re-runs this top-level code against
// an app whose Firestore is already started. So it is separated from a
// real failure below and logged at debug level -- warning that the
// "persistent cache is unavailable" there would be actively false, since
// the adopted instance is the persistent-cache one.
//
// Note what this try/catch does NOT do: it is not what handles a browser
// that cannot support persistence (a private window, site data disabled,
// a quota refusal). initializeFirestore() returns synchronously without
// validating the environment; the SDK detects that asynchronously on
// first use and degrades to an in-memory cache on its own, logging its
// own warning. So unsupported environments already fall back gracefully,
// one layer below this -- correctness there does not depend on this
// catch, and a page keeps working either way.
function createFirestore() {
  try {
    return initializeFirestore(app, {
      localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() })
    });
  } catch (err) {
    if (!(err && err.code === 'failed-precondition')) {
      // Anything else is genuinely unexpected and worth surfacing.
      console.warn('[firebase-init] initializeFirestore() failed -- adopting the default Firestore instance', err);
    }
    return getFirestore(app);
  }
}
export const db = createFirestore();

export const storage = getStorage(app);

// Gated wrappers around every Firestore call that actually issues a
// network request. collection()/doc()/query()/where()/orderBy()/
// serverTimestamp() etc. are deliberately NOT wrapped here -- they're
// synchronous and purely local (building a reference/query object),
// never touch the network on their own, and gating them would add
// nothing. Every page imports getDocs/getDoc/addDoc/setDoc/updateDoc/
// deleteDoc from HERE instead of directly from the firebase-firestore.js
// CDN module, so the gate lives in exactly one place -- impossible to
// accidentally miss a call site the way manually inserting
// `await appCheckReady` before each of the ~20+ individual call sites
// across this codebase would risk.
//
// getDocs/getDoc additionally de-duplicate CONCURRENT identical requests:
// two callers asking for the same document or the same query while the
// first request is still in flight share one network round trip and one
// Promise. index.html is the proof this was needed -- its city-counts
// loader and its featured-listings loader fired the identical unbounded
// `listings where private==false and status==active` query at the same
// moment on every page load, downloading the entire active collection
// twice for one render.
//
// This is a concurrency dedupe, NOT a result cache: an entry is dropped
// the moment the request settles, so a later call still goes to the
// network and still sees fresh data. Nothing that reads its own write
// afterwards can be handed a stale snapshot by this. Freshness semantics
// are unchanged; only the redundant simultaneous copy is removed.
export async function getDocs(...args) {
  await appCheckReady;
  const [queryOrRef] = args;
  return dedupeQueryRequest(queryOrRef, queryEqual, () => _getDocs(...args));
}
export async function getDoc(...args) {
  await appCheckReady;
  const [ref] = args;
  const path = ref && typeof ref.path === 'string' ? ref.path : null;
  return dedupeDocRequest(path, () => _getDoc(...args));
}
export async function addDoc(...args) { await appCheckReady; return _addDoc(...args); }
export async function setDoc(...args) { await appCheckReady; return _setDoc(...args); }
export async function updateDoc(...args) { await appCheckReady; return _updateDoc(...args); }
export async function deleteDoc(...args) { await appCheckReady; return _deleteDoc(...args); }
export async function runTransaction(...args) { await appCheckReady; return _runTransaction(...args); }
// Aggregation COUNT query -- server-side count, never downloads the
// matching documents themselves. Used for honest "N providers" style
// copy (e.g. the Service Universe's focus panel) where reading every
// document just to report a number would violate the "bounded reads"
// rule for no reason -- this is the bounded-by-design alternative.
export async function getCountFromServer(...args) { await appCheckReady; return _getCountFromServer(...args); }
