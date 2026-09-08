# Firebase App Check

Tracks the App Check rollout the same way `docs/BACKEND_MILESTONES.md`
tracks the backend: as a sequence of real, verified steps — SDK
integrated is not the same claim as tokens verified, which is not the
same claim as enforcement enabled. Each stage below is only claimed once
it's actually true.

**Provider**: reCAPTCHA Enterprise. **Site key**: registered and
generated in Firebase Console (Security → Fraud Defense → reCAPTCHA
Enterprise → "Darwesh Group Website" key) before this code was written —
this file only wires up the existing key, it did not create a new one,
a new reCAPTCHA key, or a new Firebase app.

## Where it's wired up

`js/firebase-init.js` — the one module every Firebase-touching page or
shared script (`js/notification-bell.js`, `js/city-nav.js`) ultimately
imports, directly or dynamically. `initializeAppCheck()` runs
immediately after `initializeApp()`, before `getAuth()`/`getFirestore()`/
`getStorage()` hand out their instances to any caller. Because ES module
top-level code runs exactly once per page regardless of how many
different scripts import the module, this is the single choke point —
no per-page duplication, no risk of initializing it twice.

Wrapped in `try/catch`: if reCAPTCHA Enterprise's script fails to load
(ad-blocker, offline, misconfiguration), the site must keep working —
App Check is a second layer on top of Firebase Auth + Security Rules,
never a replacement for them, and losing it must degrade to "unverified"
for that session, not "site is down."

## Secondary Firebase app (Add Agent) now also uses App Check — closed

`admin.html`'s "Add Agent" flow creates a **second, temporary Firebase
app instance** (`initializeApp(firebaseConfig, 'agent-create-' + ...)`) so
creating a new agent account doesn't sign the admin out of their own
session — `createUserWithEmailAndPassword` signs in as whatever `auth`
instance it's called on, so doing that on the admin's own session would
kick them out of it. App Check is bound per-app-instance, so this
secondary app never inherited App Check from the primary one — its
`createUserWithEmailAndPassword` (Auth) and `setDoc` (Firestore) calls
were completely unprotected, previously flagged here as a gap to close
before Authentication/Firestore enforcement.

**Fix**: `js/firebase-init.js` now exports `waitForAppCheckToken()` and
`RECAPTCHA_ENTERPRISE_SITE_KEY` — the exact wait/timeout/logging logic
the primary app's own gate is built from, generalized to accept any
FirebaseApp instance, not duplicated a second time. `admin.html` calls
`initializeAppCheck(secondaryApp, { provider: new
ReCaptchaEnterpriseProvider(RECAPTCHA_ENTERPRISE_SITE_KEY),
isTokenAutoRefreshEnabled: false })` on the secondary app right after
creating it (same site key, no new key or project), then `await`s
`waitForAppCheckToken(secondaryAppCheck, 'admin:add-agent')` before
*both* `createUserWithEmailAndPassword` and the secondary `setDoc` —
unlike the primary app's calls (which happen well after page load, so
its token is typically already cached by the time anyone clicks
anything), this app instance is created fresh at the moment of
submission and has no such head start, so its very first request would
race the same way Firestore's did sitewide before the earlier fix.
`isTokenAutoRefreshEnabled: false` (vs. `true` on the primary app): this
instance lives for one request cycle and is deleted moments later, so a
background refresh timer would just be torn down unused.

**Also added — rollback on partial failure.** The original code already
cleaned up the secondary *app instance* on any error
(`deleteApp(secondaryApp)`), but if the Auth account had already been
created before a *later* step failed (the company/role Firestore writes
on the primary app), nothing rolled back the just-created Auth account
or its `users/{uid}` doc — a real orphaned account, silently left
behind. The catch block now tracks whether the Auth account
(`cred`) and the Firestore profile doc (`secondaryUserDocCreated`) were
actually created, and on failure: deletes the `users/{uid}` doc via the
**admin's own session** (`db`, not `secondaryDb` — Firestore rules only
grant delete on that collection to `isAdmin()`, not to the document's
own newly-created, `role:'customer'` owner), then deletes the Auth
account itself (`deleteUser(cred.user)`, which needs no special role
since it's operating directly on the Auth user object the code already
holds a reference to). Every rollback step is wrapped so a rollback
*itself* failing (e.g. the delete also errors) is logged clearly rather
than throwing past the user-facing error message.

**Verified with Playwright** against a mock that tracks calls per
FirebaseApp instance (by name), covering:
- **Success**: `initializeAppCheck` fires on the *secondary* instance
  specifically (confirmed by app name, not inferred), same site key,
  `isTokenAutoRefreshEnabled: false`. Both `createUserWithEmailAndPassword`
  and the secondary `setDoc` landed strictly after the secondary app's
  own token resolved. The role-promotion `updateDoc` correctly went
  through the *primary* `db`. `signOut` + `deleteApp` fired on the
  secondary app. Exactly one new user ended up in the data, at
  `role: 'agent'` — no duplicates.
- **Failure 1 — secondary App Check token acquisition fails**: caught
  and logged (`[admin:add-agent] App Check getToken() failed...`), the
  operation still completes normally — correct, not a bug: enforcement
  is off, so a missing token was never meant to block the feature, only
  to show up as unverified in Console metrics, same design as the
  primary gate.
- **Failure 2 — Auth account creation itself fails**: friendly error
  shown, `deleteUser`/Firestore write never attempted (nothing was ever
  created), secondary app still deleted.
- **Failure 3 — Firestore write fails after the Auth account already
  exists**: the real test of the rollback. Confirmed `deleteUser` was
  called and succeeded, no `users/{uid}` doc was left behind, and the
  final data set carried zero orphaned entries.
- **Across all four runs** (success + 3 failure modes): zero `signOut`
  calls ever targeted the *primary* `[DEFAULT]` app, and the admin
  dashboard stayed active and rendered throughout — the admin's own
  session was never touched, in success or in any failure mode.

**Repository-wide re-scan** (`grep -rn "initializeApp(" *.html js/*.js`):
exactly two `initializeApp()` calls exist anywhere in this codebase —
the primary one in `js/firebase-init.js` and this secondary one in
`admin.html`. Both are now App-Check-protected. No other FirebaseApp
instance exists anywhere, including `backend/` (Admin SDK, server-side,
not a client-SDK/App-Check concern either way).

The primary app's 5-second circuit-breaker (`APP_CHECK_TOKEN_TIMEOUT_MS`
in `js/firebase-init.js`) was **not modified** as part of this fix — it
was refactored (extracted into the reusable `waitForAppCheckToken()`
so the secondary app's gate could reuse the identical logic instead of
a second hand-rolled copy) but its value and behavior for the primary
app are unchanged. No bug was found in it.

## Race condition fix — first Firestore read on every page now waits for a real token

**Root cause, confirmed from live Console metrics** (see status log
below): Storage and Authentication calls happen after a deliberate user
action (viewing a photo, signing in) — well after reCAPTHA Enterprise's
own script has had time to load and produce a token, so both sat at
100% verified. Firestore gets hit *immediately* on page load on several
pages (`buy.html`/`map.html`/`index.html` fetch `listings` right away;
`js/city-nav.js`/`js/notification-bell.js`/`js/nav-auth.js` do too, on
nearly every page) — these early reads were racing ahead of the token,
landing at 1-5% verified.

**Fix**: `js/firebase-init.js` now also exports gated wrappers —
`getDocs`, `getDoc`, `addDoc`, `setDoc`, `updateDoc`, `deleteDoc` — each
of which `await`s a new `appCheckReady` promise (built from the official
App Check `getToken()` API, raced against a 5s circuit-breaker in case
reCAPTCHA never resolves or rejects at all) before calling the real
Firestore function. `collection`/`doc`/`query`/`where`/`orderBy`/
`serverTimestamp` stay imported directly from the CDN as before — they're
synchronous and local, never touch the network, gating them would do
nothing.

Every page and shared script that reaches Firestore (18 total: 16
`.html` pages, `js/city-nav.js`, `js/notification-bell.js`,
`js/nav-auth.js`) now imports those six functions from
`js/firebase-init.js` instead of the `firebase-firestore.js` CDN module
directly — one choke point, rather than manually inserting
`await appCheckReady` before ~25+ individual call sites scattered across
those files, which would have been much easier to accidentally miss one
of. Storage and Authentication calls were left completely untouched
(different import source, never routed through the gate) — they didn't
have this problem to begin with.

Verified with Playwright using a deliberately delayed (300ms) token mock
across every page + a signed-in `admin.html` (dashboard, Listings,
Network/org-chart tabs) and `sell.html`: every observed Firestore call —
tens of them on `admin.html`'s dashboard alone — landed strictly after
the token resolved, never before. Also verified both failure modes: a
quick `getToken()` rejection and a `getToken()` that never resolves at
all (worst case) — in both, Firestore still proceeds (the 5s
circuit-breaker firing in the second case), the failure is logged with a
clear, non-sensitive message, and the page keeps working. Confirmed by
grep that no Storage/Auth function is imported from `firebase-init.js`
anywhere — their behavior is unchanged by construction, not just by
inference.

## Debug tokens (local/dev testing)

Not needed right now — enforcement is off, so an unverified/missing
token doesn't block anything. **When Firestore/Storage/Auth enforcement
is later turned on**, local testing (a dev server on `localhost`, or
Playwright) will need a real debug token: Firebase Console → App Check →
generate a debug token, then set it via a **local-only**,
**never-committed** snippet (e.g. `window.FIREBASE_APPCHECK_DEBUG_TOKEN =
'<token>'` before `firebase-init.js` loads, in a file added to
`.gitignore` at that time — this repo has no build step / env-var
injection, so a debug token must never be hardcoded directly into a
committed `.html`/`.js` file). Production must never set this.

## Firebase services and whether they support App Check enforcement

| Service | Used by this site | Supports App Check enforcement |
|---|---|---|
| Cloud Firestore | Yes — every collection | Yes |
| Cloud Storage | Yes — `sell-submissions`, `sell-verification`, `listing-photos`, `agent-photos`, `customer-photos` | Yes |
| Firebase Authentication | Yes | Yes (Console: App Check → APIs → Authentication) |
| Backend (`backend/`) | Uses the **Admin SDK**, server-side, service-account authenticated | N/A — App Check is a client-SDK concept; Admin SDK calls are already trusted server-to-server and are not gated by App Check either way |

## Status log (Phase 2 — Console metrics, real production traffic)

| Checkpoint | Storage | Firestore | Authentication |
|---|---|---|---|
| 1st reading | 100% verified | 1% verified (99% unverified) | 100% verified |
| 2nd reading | 100% verified | 5% verified (95% unverified) | 100% verified |

Firestore's 1%→5% move is not "it just needed more time" — it's still
overwhelmingly unverified, consistent with the root cause below, not
disproving it. Storage and Auth holding steady at 100% across two
readings is the more meaningful signal so far.

**Why Firestore lags Storage/Auth so far behind**: Storage requests
happen after a deliberate action (viewing/uploading a photo) and Auth
requests after a deliberate sign-in/sign-up click — both well after page
load, giving reCAPTCHA Enterprise's own script time to load and produce
a token. Firestore gets hit immediately on page load on several pages
(`buy.html`/`map.html`/`index.html` all fetch `listings` right away, and
`js/city-nav.js`/`js/notification-bell.js` do the same on nearly every
page) — these early reads are racing ahead of the token being ready, and
once the long-lived real-time `Listen` channel is established without
one, later reads over that same channel don't necessarily get a token
retroactively attached. **Do not enable Firestore enforcement while this
holds** — it would reject the large majority of real traffic.

## Recommended rollout (do not skip stages)

**Phase 1 — done, this change.** SDK integrated, enforcement OFF. Every
Firebase-touching page now attaches an App Check token to its requests
when it can; nothing is rejected yet if it can't.

**Phase 2 — your action, Console only.** Watch Firebase Console → App
Check → Firestore / Storage / Authentication metrics for a few days of
real production traffic. Look for the split between "Verified" and
"Unverified/outdated client" requests. Verified should climb toward
matching your real traffic volume.

**Phase 3 — confirm before enforcing.** Don't enforce until Verified
requests look like your actual traffic pattern (not just a handful of
test hits from you). A low Verified count usually means the reCAPTCHA
Enterprise key's registered domain doesn't match where the site is
actually served from, or a page is loading Firebase before App Check
attaches — worth chasing down before enforcing, not after.

**Phase 4 — enforce one service at a time, starting with the
lowest-blast-radius one:**
1. **Storage first** — narrowest surface (file upload/read paths only),
   easiest to visually confirm broken (an image fails to load/upload).
2. **Firestore second** — the widest surface on this site (every page).
   Enforcing here without Phase 2/3 confirmation first is the one most
   likely to silently break the whole site for real visitors if done too
   early.
3. **Authentication last, and only after fixing the Add Agent gap
   above** — enforcing Auth while the secondary-app flow has no App
   Check would break "Add Agent" specifically.

**Phase 5 — test production immediately after each enforcement
toggle**, not just once at the end: reload the homepage, browse
listings, log in, and (once Storage is enforced) try a photo upload,
before moving to the next service. If anything breaks, the fastest
rollback is the same Console toggle, back to unenforced, while you
investigate.

I did not enable enforcement on any service — that's a Console action
only you take, per Phase 4 above, once Phase 2/3's metrics say it's
safe.

## Update — two real gated-call bypasses found and fixed

A newer Console reading (screenshot, this update) showed Storage at
14% verified / 86% unverified, Firestore at 36%/64%, Authentication at
40%/60% — all worse than the readings logged above. Auditing every
file that imports Firestore functions directly from the
`firebase-firestore.js` CDN module (rather than through
`js/firebase-init.js`'s gated wrappers) found two real bypasses that
had crept in since this doc was written, both from code shipped after
the original App Check work:

1. **`js/mam-command-registry.js`** (MAM AI Command Center's save/
   unsave-listing action) imported `getDoc`, `setDoc`, `deleteDoc`
   straight from the CDN. Every "save this listing" / "unsave this
   listing" voice/chat action sent its Firestore request with no
   App Check token at all, unconditionally — not racing the token like
   the original page-load problem this doc describes, just never
   attaching one.
2. **`admin.html`**'s listing-creation `runTransaction` call (the
   Estate ID allocator transaction) imported `runTransaction` directly
   from the CDN instead of `js/firebase-init.js`'s gated version, for
   the same reason.

**Fixed**: both now import from `js/firebase-init.js` like every other
call site. Re-scanned the full codebase (every file importing anything
from the Firestore CDN module) for the same pattern — `getDocs`,
`getDoc`, `addDoc`, `setDoc`, `updateDoc`, `deleteDoc`,
`runTransaction`, `getCountFromServer` imported directly from the CDN
anywhere else — and found none. `collection`/`doc`/`query`/`where`/
`orderBy`/`limit`/`serverTimestamp`/`startAfter`/`deleteField` are
still imported directly everywhere, correctly — those are synchronous
and local, never touch the network, per the original design note
above. `admin.html`'s secondary-app instance (Add Agent flow) is
unaffected: its `setDoc(doc(secondaryDb, ...), ...)` call already
waits on `secondaryAppCheckReady` before firing, and the secondary
Firestore instance carries its own App Check token automatically via
`initializeAppCheck(secondaryApp, ...)` regardless of which gate the
imported `setDoc` wrapper itself awaits.

These two gaps explain some of Firestore's regression from the earlier
5% reading, but not Storage's — see below.

## Critical: Storage enforcement will break every publicly displayed photo — do not enable it under the current architecture

This is a structural finding, not a "wait for more metrics" one, and
it means Storage should **not** move to Phase 4 the way Firestore/Auth
eventually can.

Every listing photo, professional-work photo, and agent/customer photo
on this site is displayed with a plain `<img src="https://
firebasestorage.googleapis.com/...">` tag — `js/listing-image.js` and
the per-page card renderers (`index.html`, `buy.html`, `rent.html`,
`map.html`, `listing.html`, `work.html`, `designer.html`, etc.) all
render the download URL directly, not through the Storage SDK's
`getDownloadURL()` at render time. `storage.rules` deliberately allows
`read: if true` on these paths (`listing-photos`, `agent-photos`,
`customer-photos`, `professional-work`, etc.) specifically so a plain
image tag can load them with no auth round trip.

**A browser `<img>` tag cannot attach a custom HTTP header.** App
Check's enforcement mechanism *requires* an `X-Firebase-AppCheck`
header on every Storage REST request — including plain GET downloads —
and rejects any request without a valid one, independent of what
`storage.rules` allows. It is not possible to exempt specific paths;
enforcement applies to the whole bucket's API surface. If Storage
enforcement is switched on in Console, every one of these plain `<img>`
requests site-wide gets rejected (403) the moment the token-carrying
SDK calls (the deliberate upload/`getDownloadURL()` actions behind a
button) are the only Storage traffic that could ever pass — and those
are a small minority of all Storage requests, which is almost
certainly the real explanation for the 14%/86% split, not client
regressions or bot traffic.

**Before Storage enforcement is ever considered**: the image-delivery
architecture would need to change — e.g. a Cloud Function or Cloud
Run proxy that serves these images and performs its own authorization,
or accepting that Storage simply stays unenforced indefinitely while
Firestore/Auth (which the site *does* reach exclusively through the
gated SDK) can still be enforced once their own metrics justify it.
This is a real product decision, not something to flip from this
audit — flagging it here so it isn't discovered by every photo on the
site going blank.

## What I can and cannot do here

Enforcement itself is switched on per-API in Firebase Console → App
Check → APIs — a Console action, not a code change. I have no Firebase
Console credentials in this environment and cannot flip that toggle.
What's above is the code-side audit and fix; the toggle decision
(and, for Storage, the architecture decision that has to precede it)
stays with whoever has Console access.
