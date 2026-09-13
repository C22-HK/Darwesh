# Darwesh Group — Attack Surface Map (Stage 1)

Built by direct, line-level inspection of every frontend page, every
shared JS module, and every backend route in this repository (branch
`claude/web-project-hqdo8o`). No source code was modified to produce
this document, and no live requests were sent to production.

This is an **inventory**, not a findings report. Where a data-flow trace
surfaced something worth a closer look in later stages, it's called out
as a "Candidate for Stage 3/4/7/12" — an unconfirmed observation, not a
confirmed vulnerability. Each such item is cross-referenced against the
actual `firestore.rules`/`storage.rules` text (already fully reviewed
this session) rather than left as a guess.

Architecture reminder (full detail in `SECURITY_ARCHITECTURE.md`): this
is a Firebase-client-direct app. Most of the "API" is not HTTP routes —
it's Firestore/Storage operations called straight from browser JS,
authorized by `firestore.rules`/`storage.rules`, not by any server the
client talks to. The FastAPI backend is a second, narrower surface
added specifically for email-OTP signup/password-recovery. Both are
mapped below using the same 8-column format.

---

## A. Backend HTTP API (`backend/`, FastAPI on Cloud Run)

| # | METHOD / PATH | AUTH REQUIRED | ROLE REQUIRED | INPUTS | DATA ACCESSED | SECURITY CONTROLS | POTENTIAL ABUSE CASES |
|---|---|---|---|---|---|---|---|
| A1 | `GET /healthz` | None | None | None | None | None needed | Trivial — no state-changing action, no data. |
| A2 | `GET /api/v1/health` | None | None | None | None | None needed | Same as A1. |
| A3 | `POST /api/v1/auth/forgot-password` (legacy link-based reset) | None | None | JSON body: `email` (string) | Firebase Auth (`generate_password_reset_link`) | Per-IP `RateLimiter(5/15min)`; generic response regardless of account existence (enumeration-safe); route only registered when Firebase cred + Resend key + continue-URL all present | Enumeration via response-timing/shape (needs live check, Stage 12); rate-limit bypass via IP rotation (out of scope to test — no real distributed brute-force per rules of engagement) |
| A4 | `POST /api/v1/auth/email-otp/send` | None | None | JSON body: `email` (string), `purpose` (`"SIGNUP_EMAIL_VERIFY"` \| `"PASSWORD_RESET"`) | `OtpService.send` — resolves account only for `PASSWORD_RESET`; writes an OTP challenge (HMAC only) | Per-IP + per-email `RateLimiter`; identical response for registered/unregistered email on `PASSWORD_RESET` (enumeration-safe by design); resend cooldown; hard-blocked in production without a real Resend key | **Candidate for Stage 2**: OTP purpose confusion (does a `SIGNUP_EMAIL_VERIFY` challenge and a `PASSWORD_RESET` challenge for the *same* email/purpose key ever collide?); resend-cooldown bypass via purpose-switching |
| A5 | `POST /api/v1/auth/email-otp/verify` | None | None | JSON body: `email`, `purpose`, `code` (6-digit string) | Reads/mutates the OTP challenge (attempt counter, consumed flag); mints `verifyToken`/`resetToken` on success | Per-IP `RateLimiter`; max-attempts cap per challenge; expiry check; **Candidate for Stage 2**: is the per-challenge attempt cap the only brake, or can an attacker open many *new* challenges (via A4) to reset the attempt counter and grind the 6-digit space? Needs a concrete math check in Stage 2, not assumed safe. |
| A6 | `POST /api/v1/auth/signup/complete` | Bearer of a valid, single-use `verifyToken` (in JSON body, not a header) | None | JSON body: `verifyToken`, `fullName`, `phoneNumber`, `password`, `requestedRole?` (`"customer"`\|`"agent"`), `companyName?` | Creates Firebase Auth user + `users/{uid}` Firestore profile; mints custom token | `verifyToken` bound server-side to the email that completed OTP verify (email is **not** taken from the request body — Stage 2 candidate to confirm this is still true after the async/rollback refactor); `role` hard-coded to `"customer"` server-side regardless of `requestedRole`; per-IP `RateLimiter`; orphan-account rollback on partial failure (already built this session) | **Candidate for Stage 3**: does anything let `requestedRole` or another unexpected JSON field influence anything beyond the recorded-but-untrusted signal? (mass-assignment check) |
| A7 | `POST /api/v1/auth/password-reset/confirm` | Bearer of a valid, single-use `resetToken` (in JSON body) | None | JSON body: `resetToken`, `newPassword` | Sets new password via Admin SDK, revokes all refresh tokens | `resetToken` atomically single-use (`try_consume_reset_token`); token bound server-side to a specific `uid` at verify time, never client-supplied | **Candidate for Stage 2**: replay of an already-consumed token (should already be blocked — verify live); token-substitution (using account A's resetToken to reset account B — should be structurally impossible since the uid is baked into the token server-side, not supplied by the client at all) |

No `docs_url`/`redoc_url`/`openapi_url` — all three explicitly `None` in `FastAPI(...)` (`app/server.py`), so no OpenAPI schema or Swagger UI is exposed. No `/api/v1/auth/otp/*` (phone/WhatsApp) routes are ever registered — dormant code, not reachable at any URL.

---

## B. Firestore surface (client-direct, authorized by `firestore.rules`)

Format note: METHOD is the Firestore operation type; PATH is the
collection/document pattern. "Rule (verified)" in the SECURITY CONTROLS
column means the exact `firestore.rules` clause was re-checked against
this operation while writing this document — not assumed.

### B1. `users/{uid}`

| # | METHOD | PATH | AUTH | ROLE | INPUTS / caller | DATA ACCESSED | SECURITY CONTROLS | ABUSE CASES |
|---|---|---|---|---|---|---|---|---|
| B1.1 | READ (own) | `users/{own uid}` | Signed in | Any | `account.html`, `agent-dashboard.html`, `admin.html`, `login.html`, `signup.html`, `nav-auth.js` — on auth-state-change | Own profile | Rule: `isOwner(uid) \|\| isAdmin() \|\| resource.data.role=='agent'` (verified) | None — self-read |
| B1.2 | READ (any agent) | `users/{agentId}` | None required for public agent profiles | None | `listing.html` (agent photo/name for a listing) | Any agent's public profile fields | Rule: `resource.data.role=='agent'` branch makes agent profiles world-readable by design | Confirms agent PII (display name, photo, whatever else is on the doc) is intentionally public — **Candidate for Stage 6/9**: confirm no sensitive field (phone? email?) is stored on the same doc without a narrower read rule |
| B1.3 | READ-ALL | `users` (full collection) | Admin only, enforced client-side by page gate | Admin (UI), but **rule allows any signed-in caller to attempt it** | `admin.html` — Users/Dashboard/Branches/Network tabs (5+ call sites, all unfiltered `getDocs`) | Every user's full profile doc | Rule: read is `isOwner \|\| isAdmin \|\| role=='agent'` **per-document**, evaluated per doc in the result set — a non-admin, non-agent-role caller attempting this exact call would have each non-owned/non-agent doc denied individually, not the whole query. **Candidate for Stage 5/12**: live-verify this per-document semantics actually holds for a `getDocs(collection(...))` with no `where()` (Firestore does apply security rules per-matched-document for unfiltered listing reads) — do NOT assume from code alone |
| B1.4 | UPDATE (self) | `users/{own uid}` | Signed in | Any | `account.html` (displayName, photoURL) | Own profile only | Rule locks `role`/`assignedAgentId`/`companyId`/`requestedRole` against self-change (verified `.get(field,null)` pattern) | Already audited this session — PASS |
| B1.5 | UPDATE (another user's `role`) | `users/{other uid}` | Signed in | **Must be admin per rule** | `admin.html` L1231 — `updateDoc({role:newRole})`, `newRole` from a fixed 3-option `<select>` | Target user's `role` field | Rule: `isAdmin()` required for any non-owner update (verified) | Client sends only fixed values (`customer`/`agent`/`admin`) but **rule, not the dropdown, is what actually blocks a non-admin caller from sending an arbitrary value here** — correct design, but Stage 3 should confirm live that a *non-admin* signed-in user calling this exact `updateDoc` shape against another uid is rejected |
| B1.6 | CREATE (Add Agent, self-create) | `users/{new uid}` | New Auth account's own session (secondary Firebase app) | N/A (the account creating this doc is itself brand new) | `admin.html` L3142, secondary app | New agent's own profile, `role` hard-coded `'customer'` | Rule requires `role=='customer'` at create — matches (verified) | None found — this is the documented reason a second app/create-then-promote pattern exists at all |
| B1.7 | UPDATE (Add Agent promotion) | `users/{new uid}` | Admin's own session | Admin | `admin.html` L3147 — `{role:'agent', companyId}` | Same new user | Rule: `isAdmin()` (verified) | **The admin UI never offers `role:'admin'` here** — hard-coded literal, so even a compromised admin session can't use *this specific flow* to mint a second admin account with one click; a full role-escalation attempt would have to go through B1.5 instead |
| B1.8 | DELETE (Add Agent rollback only) | `users/{new uid}` | Admin's own session | Admin | `admin.html` L3172, only on a failure path | Same new user | Rule: `isAdmin()` for delete (verified) | Rollback-only, not a general delete UI |

### B2. `users/{uid}/favorites/{id}`, `users/{uid}/savedSearches/{id}`

| # | METHOD | PATH | AUTH | INPUTS | SECURITY CONTROLS | ABUSE CASES |
|---|---|---|---|---|---|---|
| B2.1 | READ/CREATE/UPDATE/DELETE | `users/{own uid}/favorites/*`, `/savedSearches/*` | Signed in | `account.html`, `map.html`, `listing.html` — every call site scopes the path to the caller's own `auth.currentUser.uid` | Rule: `isOwner(uid)` on the parent path (verified — subcollection rules inherit the `{uid}` match) | None found — every call site self-scopes; rule independently enforces it regardless |

### B3. `listings/{id}`

| # | METHOD | PATH | AUTH | ROLE | INPUTS / caller | SECURITY CONTROLS | ABUSE CASES |
|---|---|---|---|---|---|---|---|
| B3.1 | READ | `listings` (full collection, unfiltered) / `listings/{id}` | **None — public by design** | None | `index.html`, `buy.html`, `listing.html`, `map.html`, `services.html`, `insights.html`, `mam-ai.html`, `agent-dashboard.html`, `admin.html`, `js/city-nav.js` | Rule: `allow read: if true` (verified) | Includes `private:true`/`closed` listings if any code path doesn't filter them out client-side — **Candidate for Stage 6**: confirm every page that's supposed to hide `private`/`closed` listings from the public actually filters client-side, since the *rule itself does not restrict read by `private`/`status` at all* — a direct Firestore SDK/REST call bypassing the UI would see everything regardless of `private` flag |
| B3.2 | CREATE | `listings/{new id}` | Signed in | Agent (self `agentId`) or admin | `agent-dashboard.html` L653 (`agentId:currentUid`), `admin.html` L1609 (`agentId:currentUid` = the *admin's own* uid, `agentName` suffixed "(Admin)") | Rule: `isAgent() && agentId==request.auth.uid && companyId==myCompanyId()` OR `isAdmin()` (verified) | A plain `customer` account attempting this create would be rejected by rule regardless of client code — needs live confirmation (Stage 3/12), not assumed |
| B3.3 | UPDATE / status toggle | `listings/{id}` | Signed in | Owning agent or admin | `agent-dashboard.html` L649/755 (**no in-JS ownership re-check before the call** — id trusted from a hidden field/button param), `admin.html` L1602/L1722 (admin, intentionally any listing) | Rule: `(isAgent() && resource.data.agentId==request.auth.uid) \|\| isAdmin()` (verified) | **Primary IDOR candidate for Stage 3.** `agent-dashboard.html`'s `window.editListing`/`window.toggleListingStatus` are directly console-callable with an arbitrary listing ID (confirmed by sub-agent trace, exact line numbers above) with zero in-function ownership check — the *only* thing standing between a signed-in agent and editing another agent's listing is the Firestore rule. **Must be live-verified in Stage 3/12 against a real or emulated Firestore, not assumed safe from reading the rule text alone.** |
| B3.4 | DELETE | `listings/{id}` | Signed in | Owning agent or admin | `agent-dashboard.html` L692 `window.deleteListing(id)` — same no-recheck pattern as B3.3; `admin.html` L1651 (admin, intentional) | Rule: same as B3.3 (verified) | Same primary IDOR candidate as B3.3, delete variant |
| B3.5 | UPDATE (ownership reassignment side-effect) | `listings/{id}` | Agent | Self | `agent-dashboard.html` L641-643 — on **any** edit, `agentId`/`agentName`/`companyId` are unconditionally overwritten to the *current* signed-in user's values | Rule allows this since it only checks the resulting `agentId==request.auth.uid`, which this code always satisfies by construction | **Candidate for Stage 4 (business logic)**: if the IDOR in B3.3 is somehow reachable (e.g. a future rules regression), editing another agent's listing wouldn't just modify it — it would silently **reassign its ownership** to the attacker. Worth a regression test that a rules change can never make this combination possible, not just that today's rules block it. |

### B4. `submissions/{id}` (Sell form + Request Viewing — guest-accessible)

| # | METHOD | PATH | AUTH | INPUTS | SECURITY CONTROLS | ABUSE CASES |
|---|---|---|---|---|---|---|
| B4.1 | CREATE | `submissions/{new id}` | **None — guest by design** | `sell.html` (type `'sell'`, ~20 fields, full list in sub-agent report above — every field except `status`/`createdAt`/`type` is attacker/user-typed or computed from user input); `map.html` (type `'viewing'`, name/phone/email user-typed, listingId/address/city/lat/lng copied from an already-public listing) | Rule: `status=='pending' && type in ['sell','viewing'] && (uid==null \|\| uid==auth.uid)` (verified) — no field-content validation beyond that at the rules layer | `uid` is client-set from `auth.currentUser.uid` or `null` — rule only checks it matches the *caller's own* uid when signed in, so a signed-in user cannot forge another uid on a submission they create (verified: `request.resource.data.uid == request.auth.uid` required when not null). A guest (`uid:null`) submission is unattributed by design. **Candidate for Stage 4**: no upper bound on any numeric field (`price`, `size`, counts) enforced by rules — a submission with a nonsensical price (e.g. negative, or 10^300) would be accepted at the rules layer; only the frontend's `validateStep()` stops a normal user, not a direct API/SDK call. Confirmed exploitable via direct SDK call by both sub-agents' traces (no server-side bound exists). |
| B4.2 | READ (own) | `submissions` filtered `where uid==` | Signed in | `account.html`, `js/notification-bell.js` | Rule: `isAdmin() \|\| (isSignedIn() && resource.data.uid==request.auth.uid)` (verified) | A guest's own submission (`uid:null`) is **not readable back by that guest** (no session to match `null` against) — expected, not a bug, but worth confirming that's the intended UX (a guest can never check their own sell-submission status after leaving the page) |
| B4.3 | READ-ALL | `submissions` (unfiltered) | Admin only, client-gated | `admin.html` (3 call sites) | Rule: `isAdmin()` branch required for the non-owner case (verified) | Per-document semantics same caveat as B1.3 |
| B4.4 | UPDATE (status) | `submissions/{id}` | Admin | `admin.html` L1808 — `status` from a fixed `<select>` | Rule: `isAdmin() \|\| (status=='pending' && diff().affectedKeys().hasOnly(['photoUrls','photoUploadToken','verificationPhotoPath']))` (verified) | Correctly admin-gated for status changes |
| B4.5 | UPDATE (background photo-upload patch, guest continuation) | `submissions/{id}` | **None — same guest session continues** | `sell.html` L1809 — patches `photoUrls`/`photoUploadToken`/`verificationPhotoPath` on the just-created doc after uploads finish | Rule restricts this exact unauthenticated patch path to *only* those three field names via `hasOnly()` (verified) — cannot be used to change `status`, `name`, `phone`, etc. | **Candidate for Stage 3/9**: `verificationPhotoPath` is one of the three patchable fields and is **never validated against an expected path prefix by the rule** (rules can't easily do string-prefix validation cheaply here, and don't). A guest could set `verificationPhotoPath` to an arbitrary string. See B5.2 for the consuming side (`admin.html`'s "View Verification Photo") — this is the more concrete half of that same finding. |

### B5. Cloud Storage (`storage.rules`)

| # | METHOD | PATH TEMPLATE | AUTH | SECURITY CONTROLS | ABUSE CASES |
|---|---|---|---|---|---|
| B5.1 | WRITE | `sell-submissions/{token}/{filename}` | None (guest) | Rule: `size<10MB && contentType matches image/.*` (verified, server-side — **not** just the client's `accept="image/*"`) | `token`=`crypto.randomUUID()` (sell.html) — unguessable, but **the write rule doesn't check the token corresponds to a real/expected `submissions` doc at all** — anyone can write arbitrary "image/*"-typed, <10MB blobs under any token, whether or not a matching submission exists. Low impact (public-read images, 10MB/image/type-bounded) but an unbounded-count storage-abuse vector — **Candidate for Stage 6 (resource consumption)**, not urgent given the explicit no-DoS-testing rule of engagement. |
| B5.2 | READ | `sell-verification/{token}/{filename}` | **Admin only** (`firestore.get()` cross-service role check, verified) | Rule correctly requires `role=='admin'` | The *path itself* fed to this read (`admin.html` L1942, `getBytes(storageRef(storage, s.verificationPhotoPath))`) comes verbatim from a `submissions` document field that, per B4.5, an unauthenticated guest can set to an arbitrary string. **This is the clearest concrete Stage-3/9 candidate in this map**: an attacker-controlled string is used, unvalidated, to construct the exact Storage path an *admin's browser* then fetches and renders as if it were that submission's identity-verification selfie. Worst case explored in Stage 4/12: could this be used to make an admin view (not exfiltrate — everything else is public-read anyway) a *different* real selfie under a *misattributed* submission, i.e. an identity-confusion issue during manual fraud review — not a new data-exposure, since `agent-photos`/`customer-photos`/`listing-photos` are already public-read, but a genuine trust/logic issue worth confirming or ruling out with evidence, not left as a code-reading guess. |
| B5.3 | WRITE | `listing-photos/{token}/{filename}` | Any signed-in user | Rule: `request.auth != null && size<10MB && image/*` (verified) — **not** scoped to agent/admin role, since (per rules' own comment) every signed-in user on this project is already an agent or admin | Confirmed by rule text: a plain `customer` account, if one ever existed with a raw Firestore/Storage SDK call (not through any page's UI, since no customer-facing page offers this), could write to this path. Low realistic impact (still can't attach it to a `listings` doc without the separate `listings` create rule), but not a defense-in-depth "every write here is agent/admin" guarantee at the Storage layer alone — worth noting for Stage 5. |
| B5.4 | WRITE | `agent-photos/{uid}/{filename}`, `customer-photos/{uid}/{filename}` | Signed in, own uid only | Rule: `auth.uid==uid && size<10MB && image/*` (verified) | None found — correctly self-scoped at the rules layer, matches every call site |
| B5.5 | READ | `sell-submissions/*`, `listing-photos/*`, `agent-photos/*`, `customer-photos/*` | None — public by design | Rule: `allow read: if true` on all four | Intentional; every one of these paths is meant to back a public `<img>` tag |

### B6. `companies/{id}`

| # | METHOD | PATH | AUTH | INPUTS | SECURITY CONTROLS | ABUSE CASES |
|---|---|---|---|---|---|---|
| B6.1 | READ | `companies` | Signed in (any role) | `admin.html`, `account.html` (indirectly) | Rule: `isSignedIn()` (verified) | None found |
| B6.2 | CREATE | `companies/{id}` | Signed in | `signup.html` (agent-signup path, via backend not client — see A6), `admin.html` Add Agent flow L3134 | Rule: `isSignedIn() && !exists(...)` — create-if-not-exists (verified) | **Candidate for Stage 4 (business logic, not security)**: `admin.html`'s `companyId = slugifyCompany(freeTextName)` (L3072) has no uniqueness check beyond exact-slug collision. Two differently-named companies that slugify identically (e.g. punctuation/case differences) would cause the *second* admin's "new company" creation to silently attach the new agent to the *first*, unrelated, pre-existing company instead of creating a new one — a data-integrity bug, not a privilege escalation (the rule's create-if-not-exists is doing exactly what it's designed to do; the bug is in the slugification not being collision-checked against intent). Confirmed as a real code path by the sub-agent trace, not a hypothetical. |
| B6.3 | UPDATE | `companies/{id}` | Admin | `admin.html` L2743 (branch address edit, free-text, no validation) | Rule: `isAdmin()` (verified) | Free-text address stored unvalidated — XSS-relevance is a Stage 7 question (is it escaped wherever rendered?), not a Stage 3 authorization question |
| B6.4 | DELETE | `companies/{id}` | Admin | No delete UI found in admin.html | Rule: `isAdmin()` (verified) | Rule exists but no call site found — not reachable via any page in this repo |

### B7. `agentTransactions/{id}`

| # | METHOD | PATH | AUTH | INPUTS | SECURITY CONTROLS | ABUSE CASES |
|---|---|---|---|---|---|---|
| B7.1 | READ | `agentTransactions` filtered `where agentId==` | Signed in agent | `agent-dashboard.html` L867 — self-scoped by query | Rule: `isOwner(resource.data.agentId) \|\| isAdmin()` (verified) | None found |
| B7.2 | CREATE | `agentTransactions/{new id}` | Signed in agent | `agent-dashboard.html` L945 — `agentId` hard-coded to `currentUid` client-side, full field list in sub-agent report | Rule: `isAgent() && agentId==request.auth.uid` (verified) | None found — client can't forge `agentId` even if it tried, since the rule independently checks it |
| B7.3 | DELETE | `agentTransactions/{id}` | Signed in agent | `agent-dashboard.html` L958 `window.deleteFinTx(id)` — **no in-JS ownership recheck**, same pattern as B3.3/B3.4 | Rule: `isOwner(resource.data.agentId) \|\| isAdmin()` (verified) | Same class of Stage-3 candidate as B3.3/B3.4 — client trusts the caller-supplied id, rule is the only real backstop, needs live verification not just rule-reading |

### B8. `otpChallenges/{key}`, `otpResetTokens/{token}` (backend-only)

| # | METHOD | PATH | AUTH | SECURITY CONTROLS | ABUSE CASES |
|---|---|---|---|---|---|
| B8.1 | ALL | `otpChallenges/*`, `otpResetTokens/*` | N/A — no client path reaches these at all | Rule: `allow read, write: if false` unconditionally (verified); only the backend's Admin SDK (bypasses rules entirely) ever touches these | None found — already reviewed this session, deny-all confirmed against a live Firestore emulator (14+5 checks passing, prior work this session) |

---

## C. External third-party calls (browser-side, no server involved)

| # | Call site | Destination | User input flow | Notes |
|---|---|---|---|---|
| C1 | `map.html`, `admin.html` | `overpass-api.de/api/interpreter` (POST) | Fixed hardcoded `bbox` constant only — **no user input reaches this request at all** | Not attacker-influenced |
| C2 | `sell.html` | `nominatim.openstreetmap.org/search`, `/reverse` | User-typed location search text, `encodeURIComponent`'d; lat/lng are numeric-only | Standard geocoding, no API key involved, third-party service (out of scope to attack per rules of engagement) |

No SSRF surface exists — every external call here originates from the visitor's own browser, not from any server this project controls, so there's no "trick our server into fetching an internal URL" pattern to test.

---

## D. Reachable-but-orphaned pages

| # | Page | Reachability | Data | Notes |
|---|---|---|---|---|
| D1 | `verification.html` | Direct URL only, linked from nowhere | Zero Firebase integration — confirmed no `firebase-init`/Firestore import anywhere in the file | Static mockup, fabricated placeholder data |
| D2 | `profile.html` | Same | Same — zero Firebase integration confirmed | Static mockup, fabricated placeholder data |

Both already flagged in `docs/SECURITY_AUDIT.md` (M2); re-confirmed here directly rather than assumed still true.

---

## E. Add Agent — the highest-privilege single flow in the app

Not a single "endpoint" but a multi-step client-side flow
(`admin.html`, lines ~3049-3190) worth mapping as its own unit since it
touches Auth account creation + two Firestore writes + a secondary
Firebase app instance + App Check + a rollback path, all client-side,
gated only by the outer page's admin-role check:

1. Admin fills a form (all free text except company selection):
   name/phone/email/password (password pre-filled random but
   **admin-editable, plaintext `<input type="text">`, not masked**),
   company (existing, or free-text new name + address).
2. A **second, temporary Firebase app instance** is created so the
   admin's own session survives (`initializeApp(..., 'agent-create-' +
   Date.now())`).
3. App Check initialized on that secondary app (best-effort — continues
   without it if it fails, matching the site-wide "App Check is
   defense-in-depth, never a hard requirement" design, per
   `docs/APP_CHECK.md`).
4. `createUserWithEmailAndPassword` creates the real Firebase Auth
   account on the secondary app.
5. Company doc resolved/created (B6.2 above — the slug-collision
   candidate lives here).
6. New user **self-creates** their own `users/{uid}` doc at
   `role:'customer'` (forced by rules, per B1.6), using the secondary
   app's own auth context.
7. Admin's own session immediately promotes that doc to `role:'agent'`
   (B1.7) — **the UI never offers `role:'admin'`** as a choice anywhere
   in this flow.
8. Secondary app torn down (`signOut` + `deleteApp`).
9. On any failure after step 4, a tracked rollback deletes the
   Firestore profile (if created) then the Auth account itself,
   logged, not silently left as an orphan — this exact rollback
   pattern was verified with Playwright per `docs/APP_CHECK.md`.
10. On success, the **plaintext password is displayed back to the
    admin** in the modal, for manual, out-of-band sharing with the new
    agent — no email/invite-link mechanism is used for this path.

**Candidate for Stage 4/9**: step 10's plaintext-password display is a
deliberate design choice (no email infrastructure existed for this flow
at the time it was built), not an oversight — but it means the new
agent's initial password is only as safe as however the admin chooses
to transmit it out-of-band, entirely outside this codebase's control.
Worth flagging as a hardening candidate (e.g., force a password change
on first login) rather than a vulnerability in this code.

---

## F. Summary — candidates carried forward to later stages

Nothing below is a confirmed finding. Each needs the specific
validation named before it can be classified in Stage 12.

1. **B3.3/B3.4/B7.3** — client-side "no ownership recheck before the
   Firestore call" pattern in `agent-dashboard.html`'s `window.*`
   globals (listings edit/delete/status-toggle, `agentTransactions`
   delete). Rules text, re-verified while building this map, appears
   to independently block a cross-agent attempt in every case — **but
   this must be proven live** (against the Firestore emulator this
   session already has set up, or an authenticated staging test — never
   against another real user's data) in Stage 3/12, not accepted from
   reading the rule text alone. This is the single highest-priority
   item for Stage 3.
2. **B4.5 / B5.2** — `verificationPhotoPath`, guest-writable via B4.5,
   consumed unvalidated as a raw Storage path by `admin.html`'s
   verification-photo viewer (B5.2). Needs Stage 4/9 analysis of
   realistic impact (identity-confusion during fraud review, not new
   data exposure, since all other Storage paths are already
   public-read) — and a decision on whether a path-prefix check is
   warranted regardless.
3. **B6.2** — company-name slugification collision, a business-logic
   data-integrity bug (wrong company attribution), not a privilege
   issue.
4. **B3.1** — confirm every "public" listing browse page actually
   filters `private`/`closed` client-side, since the rule itself
   imposes no such restriction on direct reads.
5. **B1.3 / B4.3** — per-document rule evaluation semantics for
   unfiltered `getDocs(collection(...))` calls against `users`/
   `submissions` from a *non-admin* context — should already be safe by
   rule design, worth one concrete emulator test to remove all doubt
   rather than relying on documentation of how Firestore rules work in
   general.
6. **A4/A5** — OTP purpose-confusion and attempt-limit-vs-resend
   interaction, needs a concrete walk-through with numbers in Stage 2
   before ruling in or out.
7. **A6** — mass-assignment re-confirmation on `/signup/complete` after
   this session's own recent async/rollback refactor of that handler.

Ready for Stage 2 (authentication deep review) on your go-ahead. No
source code was modified to produce this map.
