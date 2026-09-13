# Darwesh Group — Business Logic Model (Stage 4, Part 1)

Derived directly from `firestore.rules`, `storage.rules`, and the actual
frontend code (`signup.html`, `sell.html`, `map.html`, `listing.html`,
`agent-dashboard.html`, `admin.html`, `account.html`) and backend
(`backend/app/otp/*`) as they exist today, post-AUTHZ-01/02/03/04
remediation. No product requirements are invented — every invariant
below is either an actual enforced rule (cited) or a stated design
intent found in code comments, explicitly marked as such where the
rule doesn't itself enforce it.

---

## 1. Signup

- **ACTOR**: Anonymous visitor
- **PRECONDITIONS**: Valid email reachable for OTP; none for phone
- **ACTION**: `POST /api/v1/auth/email-otp/send` → `/verify` → `/signup/complete` (`backend/app/otp/*`, `signup.html`)
- **STATE BEFORE**: No Firebase Auth account, no `users/{uid}` doc
- **STATE AFTER**: Firebase Auth account created; `users/{uid}` doc with `role:'customer'` (always, regardless of `requestedRole`), `companyId` set if `requestedRole=='agent'` and a company name was given
- **AUTHORIZED PARTY**: The person who completed the OTP-email-verification loop for that exact address (token bound server-side to the verified email, never client-supplied)
- **SECURITY-SENSITIVE FIELDS**: `role` (hardcoded `'customer'` server-side, never client-influenced), `requestedRole` (recorded but never a grant), `companyId` (see §2)
- **BUSINESS INVARIANT**: A new account is always `customer`-role and never self-escalates; `email_verified` is genuinely true because OTP already proved it. **Holds** — re-confirmed this stage, no new gap found (see `AUTHENTICATION_SECURITY_REVIEW.md` for the full auth-layer proof).

---

## 2. Company creation / joining

- **ACTOR**: Any signup applicant requesting `role:'agent'` (via `signup.html`), or an admin (via `admin.html`'s Add Agent flow)
- **PRECONDITIONS**: A free-text company name is typed
- **ACTION**: Name is slugified (`_slugify_company()` in `backend/app/otp/email_handler.py:42-47`, or `slugifyCompany()` in `admin.html:2999-3003` — two independently-implemented but algorithmically equivalent functions: lowercase, trim, collapse any run of non-`[a-z0-9]` to `-`, strip leading/trailing `-`, fallback `"company"`). `companies/{slug}` is created if it doesn't already exist (`firestore.rules:44-48`, `allow create: if isSignedIn() && !exists(...)`); if it already exists, nothing is written and the new user simply inherits that `companyId`.
- **STATE BEFORE**: `companies/{slug}` may or may not already exist
- **STATE AFTER**: `companies/{slug}` exists (created or pre-existing, unchanged either way); the applicant's `users/{uid}.companyId` is set to `slug`
- **AUTHORIZED PARTY**: Intended to be "the real company," but **nothing verifies the applicant is actually affiliated with an existing company whose name they typed** — see BL-04
- **SECURITY-SENSITIVE FIELDS**: `companyId` (the tenant boundary for team-listing visibility)
- **BUSINESS INVARIANT (stated intent, per `firestore.rules:10-18` comment)**: "signup.html asks for a company name and creates the company doc automatically the first time that name is used — every signup after that with the same name just joins it, no manual Firestore edit needed." **This invariant holds exactly as designed** — join is deterministic and automatic. What is NOT an enforced invariant, but might be assumed: "only genuine members of a company end up with that companyId." That assumption does **not** hold — see BL-04.

---

## 3. Role assignment

- **ACTOR**: Admin only (for `customer→agent`/`agent→admin` promotion); the system itself (for `→customer` at signup)
- **PRECONDITIONS**: Admin is signed in with `role=='admin'`
- **ACTION**: `updateDoc(users/{uid}, {role: newRole})` (`admin.html`'s Users tab, or the Add Agent flow's promotion step)
- **STATE BEFORE/AFTER**: `role` transitions `customer→agent`, `agent→admin`, or any admin-chosen direction (rule imposes no directionality)
- **AUTHORIZED PARTY**: `isAdmin()` only (`firestore.rules:108-115`, the `|| isAdmin()` branch — the only path that can change `role` on a document that isn't the caller's own newly-created one)
- **SECURITY-SENSITIVE FIELDS**: `role`
- **BUSINESS INVARIANT**: No account can ever promote itself or another account without an admin's explicit action. **Holds** — proven in `AUTHORIZATION_SECURITY_REVIEW.md` Part 5 (P5-1 through P5-5) and unchanged by this stage's work.

---

## 4. Customer profile

- **ACTOR**: The customer themself
- **PRECONDITIONS**: Signed in
- **ACTION**: `updateDoc(users/{own uid}, {displayName, photoURL})` (`account.html`)
- **STATE BEFORE/AFTER**: Only `displayName`/`photoURL` change
- **AUTHORIZED PARTY**: `isOwner(uid)` only, and only for the two allowlisted fields (`firestore.rules:108-114`)
- **SECURITY-SENSITIVE FIELDS**: `role`/`companyId`/`assignedAgentId`/`requestedRole` — explicitly locked against self-change
- **BUSINESS INVARIANT**: A customer cannot alter their own privilege-relevant fields. **Holds.**

---

## 5. Agent profile

- **ACTOR**: The agent themself
- **PRECONDITIONS**: Signed in, `role=='agent'`
- **ACTION**: Same `users/{uid}` update path as §4, PLUS an attempted `commissionRate` write via `agent-dashboard.html`'s Finances tab "Save Rate" button (`agent-dashboard.html:936-945`)
- **STATE BEFORE/AFTER**: Intended: `commissionRate` changes. **Actual**: the write is **rejected by `firestore.rules`** — `commissionRate` is not in the `users` UPDATE_ALLOWED_FIELDS allowlist (`displayName`/`photoURL` only). EMULATOR CONFIRMED this stage (BL-7).
- **AUTHORIZED PARTY**: Intended to be the agent themself; in practice, no one can set this field through any UI path found in this codebase
- **SECURITY-SENSITIVE FIELDS**: `commissionRate` (feeds the live commission display, §19)
- **BUSINESS INVARIANT**: Not actually enforced as a working feature — see finding BL-03 (a functional defect, not a security hole: the field simply cannot be set at all via any writable path, so it can't be *manipulated* either).

---

## 6. Property creation

- **ACTOR**: Agent (own `agentId`/own `companyId`) or admin (unrestricted)
- **PRECONDITIONS**: Signed in as agent or admin
- **ACTION**: `addDoc(listings, {...})` (`agent-dashboard.html:653-665`, `admin.html:1600-1609`)
- **STATE BEFORE**: No document
- **STATE AFTER**: New `listings/{id}` with `agentId`, `companyId`, `status:'active'`, `private` (agent's choice), `verified:false` (admin can override with `true`, per `firestore.rules:189` `request.resource.data.get('verified', false) == false` for the agent branch — enforced even at create)
- **AUTHORIZED PARTY**: `isAgent() && agentId==auth.uid && companyId==myCompanyId()`, or `isAdmin()` (`firestore.rules:185-196`)
- **SECURITY-SENSITIVE FIELDS**: `agentId`, `companyId`, `verified`, `private`, `status`
- **BUSINESS INVARIANT**: A listing can only ever be created under its creator's own real identity and real company; `verified` can never be self-granted at creation. **Holds at create time** — but see §7/BL-01 for what happens after.

---

## 7. Property editing

- **ACTOR**: The owning agent (per the listing's *current* `agentId`) or admin
- **PRECONDITIONS**: Signed in, currently owns the listing (or is admin)
- **ACTION**: `updateDoc(listings/{id}, {...})` (`agent-dashboard.html:648-649`, `admin.html:1602`)
- **STATE BEFORE/AFTER**: Any of `title/address/city/lat/lng/dealType/propertyType/price/beds/baths/sqft/img/amenities/private/status/agentId/agentName/companyId/updatedAt` may change (`firestore.rules:211-216`)
- **AUTHORIZED PARTY**: `isAdmin()`, or `isAgent() && resource.data.agentId==auth.uid` — checked against the **pre-write** `agentId` only
- **SECURITY-SENSITIVE FIELDS**: `agentId`, `agentName`, `companyId`, `verified` (the last is the only one re-validated against its own prior value)
- **BUSINESS INVARIANT (assumed but NOT enforced)**: "A listing's `agentId` always identifies a real agent who consented to owning it; `agentName` always describes the same person as `agentId`; `companyId` always equals that agent's real `companyId`." **BROKEN — see BL-01, EMULATOR CONFIRMED (BL-1a, BL-1b, BL-2, BL-3, BL-12).** The rule only ever checks *who owns it right now*, never *what the write claims about ownership after*.

---

## 8. Property privacy

- **ACTOR**: The owning agent or admin
- **PRECONDITIONS**: Same as §7
- **ACTION**: `private: true/false` set via the same edit form
- **STATE BEFORE/AFTER**: `private` flips
- **AUTHORIZED PARTY**: Same as §7 — and per AUTHZ-01's fix, `private==true` now genuinely removes the listing from every public/non-owner read path (`get()` and `list()` both)
- **SECURITY-SENSITIVE FIELDS**: `private`
- **BUSINESS INVARIANT**: A `private:true` listing is invisible to anyone but its own agent/admin. **Holds** — production-verified in the prior remediation turn.

---

## 9. Property verification

- **ACTOR**: Admin only (for granting); any agent (for their own create/edit, blocked from granting)
- **PRECONDITIONS**: Admin signed in
- **ACTION**: `updateDoc(listings/{id}, {verified: true})`
- **STATE BEFORE/AFTER**: `verified` flips `false→true` (or reverse)
- **AUTHORIZED PARTY**: `isAdmin()` exclusively — an agent's own update branch requires `verified` to stay byte-for-byte unchanged (`firestore.rules:210`)
- **SECURITY-SENSITIVE FIELDS**: `verified`
- **BUSINESS INVARIANT (assumed)**: "A `verified:true` listing was reviewed and approved by an admin for the specific agent/property it currently shows." **Technically true at the instant of verification, but does NOT survive a subsequent identity swap — see BL-01/BL-12.** The `verified` flag's own value is protected; the identity it's attached to is not.

---

## 10. Property closing

- **ACTOR**: The owning agent or admin
- **PRECONDITIONS**: Same as §7
- **ACTION**: `updateDoc(listings/{id}, {status:'closed'})` (`agent-dashboard.html:753-762`, `admin.html`'s equivalent)
- **STATE BEFORE/AFTER**: `status` toggles `active↔closed` — genuinely reversible by design ("Mark as Sold" / "Mark as Active" is the same button, per `agent-dashboard.html:730-735`)
- **AUTHORIZED PARTY**: Same as §7
- **SECURITY-SENSITIVE FIELDS**: `status`
- **BUSINESS INVARIANT**: A `closed` listing is not publicly visible (`isListingPubliclyVisible()` requires `status=='active'` exactly). **Holds.** Reopening a closed listing is an *intended*, reversible action, not a bypass.

---

## 11. Property deletion

- **ACTOR**: Owning agent or admin
- **ACTION**: `deleteDoc(listings/{id})`
- **AUTHORIZED PARTY**: `isAgent() && resource.data.agentId==auth.uid`, or `isAdmin()` (`firestore.rules:217`)
- **SECURITY-SENSITIVE FIELDS**: N/A (whole-document action)
- **BUSINESS INVARIANT**: Only the current owner or admin can delete. **Holds** — unaffected by BL-01 since delete still checks the pre-write `agentId`, and there's no "requested new state" to manipulate for a delete.

---

## 12. Property viewing requests

- **ACTOR**: Any visitor (guest or signed-in), from `map.html`/`listing.html`
- **PRECONDITIONS**: None
- **ACTION**: `addDoc(submissions, {type:'viewing', listingId, address, city, priceLabel, lat, lng, name, phone, email, uid, status:'pending'})` — `map.html:709-724`
- **STATE BEFORE/AFTER**: New `submissions` doc
- **AUTHORIZED PARTY**: Anyone (`firestore.rules:228-231` only checks `status`/`type`/`uid`-matches-caller)
- **SECURITY-SENSITIVE FIELDS**: `listingId`, `address`, `city`, `priceLabel`, `lat`, `lng` — **all copied from the client's already-loaded, possibly-stale local copy of a listing, never re-verified against the actual current `listings/{listingId}` document by any rule or by `admin.html`'s review UI**
- **BUSINESS INVARIANT (assumed)**: "A viewing request's `listingId`/`address`/`price` fields accurately describe a real, currently-public listing." **NOT enforced anywhere — see BL-06.**

---

## 13. Property selling submissions

- **ACTOR**: Any visitor (guest or signed-in), from `sell.html`
- **PRECONDITIONS**: None
- **ACTION**: `addDoc(submissions, {type:'sell', status:'pending', uid, ...~20 property fields...})`
- **STATE BEFORE/AFTER**: New `submissions` doc, `status:'pending'`
- **AUTHORIZED PARTY**: Anyone; a signed-in caller cannot forge another's `uid`
- **SECURITY-SENSITIVE FIELDS**: None at the rules layer beyond `status`/`type`/`uid` — every property-detail field is accepted unvalidated (price, beds, baths, etc. can be any value, including negative/absurd — matches Part 13's "not enforced" classification)
- **BUSINESS INVARIANT**: A submission always starts `pending` and is never directly creatable in any other state. **Holds.**

---

## 14. Verification-photo workflow (post-AUTHZ-02)

- **ACTOR**: The submission's own creator (guest or signed-in — identified only by holding the submission's `photoUploadToken`, not by account identity)
- **PRECONDITIONS**: Submission exists, `status=='pending'`, caller knows the token
- **ACTION**: `setDoc(submissions/{id}/verification/{token}, {path, setAt})` — the token itself must equal the submission's own stored `photoUploadToken` (`firestore.rules:277-283`)
- **STATE BEFORE/AFTER**: A capability-scoped subcollection doc records the Storage path of the identity selfie
- **AUTHORIZED PARTY**: Whoever holds the correct token (a 122-bit `crypto.randomUUID()` never readable back by anyone but the submission's own owner or an admin)
- **SECURITY-SENSITIVE FIELDS**: `path` — **still an arbitrary, unvalidated string even for the legitimate token-holder** — see BL-07
- **BUSINESS INVARIANT (AUTHZ-02's fix)**: "An unrelated third party can never set or overwrite another submission's verification-photo path." **Holds — EMULATOR CONFIRMED this stage (BL-8: cross-submission token confusion denied).** A narrower invariant — "the path always points to a photo the submitter actually just captured" — does **not** hold (BL-9: self-spoofing with the correct, legitimately-held token is still possible).

---

## 15. Agent assignment

- **ACTOR**: Admin (the only write path found)
- **ACTION**: `assignedAgentId` is described in `firestore.rules` comments as "never actually set by any write path in this codebase... meant to be set by hand later" — confirmed by repo-wide grep, no UI writes it
- **AUTHORIZED PARTY**: N/A — dormant field, not reachable via any button/form
- **BUSINESS INVARIANT**: N/A — not a live workflow. `account.html`'s "My Assigned Agent" panel reads this field but nothing ever writes it through the app.

---

## 16. Company / team listings

- **ACTOR**: Signed-in agent, viewing `agent-dashboard.html`'s Team Listings tab
- **ACTION**: Two merged queries — `where(companyId==own, private==false, status==active)` (everyone's public listings in the caller's own company) `+ where(agentId==own uid)` (the caller's own listings regardless of visibility)
- **AUTHORIZED PARTY**: Any signed-in agent, scoped to their own `companyId` only
- **SECURITY-SENSITIVE FIELDS**: `companyId` (the tenant boundary)
- **BUSINESS INVARIANT**: An agent never sees another company's private/closed listings, nor a teammate's private listing (post-AUTHZ-01, this is now stricter than before — even a *teammate's own* private listing is invisible to anyone but its own agent/admin). **Holds — EMULATOR CONFIRMED this stage (BL-10, BL-11: cross-company/company-membership-alone access is denied).**

---

## 17. Favorites

- **ACTOR**: Signed-in user, own subcollection only
- **ACTION**: `users/{own uid}/favorites/{listingId}` read/write
- **AUTHORIZED PARTY**: `isOwner(uid)` on the parent path
- **BUSINESS INVARIANT**: Strictly self-scoped. **Holds** — unchanged since Stage 3, not re-tested this stage (no code path touched it).

---

## 18. Saved searches

- Same shape and invariant as §17 (`users/{uid}/savedSearches/{id}`).

---

## 19. Agent transactions / commissions / financial calculations

- **ACTOR**: The agent themself (manual entries); the system (live commission display only, never stored)
- **PRECONDITIONS**: Signed in as agent
- **ACTION**: `addDoc(agentTransactions, {agentId, type, category, amount, date, note})` (`agent-dashboard.html:958-968`); separately, `loadFinances()` computes `commission = listing.price * (agentCommissionRate/100)` **live, at every page load, for every `status=='closed'` listing owned by the caller** (`agent-dashboard.html:879`) — never written to Firestore
- **STATE BEFORE/AFTER**: A new manual ledger entry; the on-screen commission total is recomputed fresh, never persisted or double-counted by repeated close/reopen (see BL discussion)
- **AUTHORIZED PARTY**: `isAgent() && agentId==auth.uid` at create; **at update, only the pre-write `agentId` is checked**, same gap pattern as listings
- **SECURITY-SENSITIVE FIELDS**: `amount` (no sign/bound/NaN validation anywhere), `agentId` (reassignable post-creation — see BL-02)
- **BUSINESS INVARIANT (assumed)**: "Every `agentTransactions` record accurately reflects that agent's own real income/expense, with a sane positive amount." **NOT enforced — see BL-02, EMULATOR CONFIRMED (BL-4, BL-5, BL-6).** Separately: "Closing and reopening a listing never duplicates its commission" — **holds**, because commission is never stored, only recomputed live each time (DISPROVEN as a risk, by design).

---

## 20. MAM AI valuation

- **ACTOR**: Any visitor on `sell.html` (no auth required); the concierge chat on `mam-ai.html`; homepage/city-browse stat widgets (`index.html`, `services.html`, `insights.html`)
- **PRECONDITIONS**: A city + property size entered (sell.html); page load (the others)
- **ACTION**: Query `listings` `where(private==false, status==active)`, compute simple arithmetic mean of `price/sqft` grouped by city, require ≥2 comparables, then `estimate = avgPerSqm * size`, shown as a `low–high` (±15%) range
- **AUTHORIZED PARTY**: N/A — read-only, public data, public feature
- **SECURITY-SENSITIVE FIELDS**: None directly exposed (no new data leak — same public listings already visible elsewhere); but the **comparable set is fully attacker-influenceable** by any real agent account, since listing `price` is agent-controlled with no bound (§7)
- **BUSINESS INVARIANT**: "The estimate is presented as an estimate, not a guarantee." **Holds** — confirmed disclosure strings (`sell.valuationResult`: "Estimated value: {low} – {high}", `sell.valuationBody`: "Get an estimated market value"). A narrower invariant — "the estimate cannot be meaningfully skewed by a small number of listings" — does **not** hold (minimum comparable count is 2, no outlier trimming) — see BL-09.

---

## 21. Admin approval / review workflows

- **ACTOR**: Admin only
- **ACTION (submission review)**: `admin.html`'s "Create Listing from Submission" (`admin.html:2128-2180`) pre-fills the Add Listing form from a `submissions` doc's fields **verbatim, unsanitized at copy time** — the admin must still manually click "Add Listing" to actually publish, which performs its own independent (minimal) validation on the *form's current values*, not the original submission
- **STATE BEFORE/AFTER**: A submission's fields become a brand-new, independent `listings` document — **no field links the new listing back to its source submission**, and the submission's own `status` is untouched by this action (still `pending` unless the admin separately changes it via the status dropdown)
- **AUTHORIZED PARTY**: `isAdmin()` for both the listing create and any submission status change
- **SECURITY-SENSITIVE FIELDS**: Every copied field (title/address/beds/baths/price/photo) — trusted from the original, unauthenticated submitter
- **BUSINESS INVARIANT (assumed)**: "A submission can only ever become one listing." **NOT enforced — see BL-05, CODE CONFIRMED.** No duplicate-conversion guard exists; nothing records "already converted."

---

*Cross-reference: findings referenced above (BL-01 through BL-09, and the disproven candidates) are detailed with full evidence in `BUSINESS_LOGIC_SECURITY_REVIEW.md`.*
