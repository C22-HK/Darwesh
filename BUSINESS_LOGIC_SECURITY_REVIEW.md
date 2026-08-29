# Darwesh Group — Business Logic Security Review (Stage 4)

Built on `BUSINESS_LOGIC_MODEL.md`, `ATTACK_SURFACE.md`,
`AUTHENTICATION_SECURITY_REVIEW.md`, `AUTH_STATE_MACHINE.md`,
`AUTHORIZATION_MATRIX.md`, `AUTHORIZATION_SECURITY_REVIEW.md`, and
`AUTHORIZATION_REMEDIATION.md`. AUTHZ-01 through AUTHZ-04 are already
fixed and (AUTHZ-01) production-verified — none of that is retested or
reopened here except where this stage's findings specifically build on
top of it (BL-01, BL-07).

**No source code was modified. No rules were deployed or weakened.**
Every emulator test used a fresh, disposable project against the
project's real, current `firestore.rules` — never production.

---

## Evidence legend

- **CODE CONFIRMED** — read directly from source, quoted with file:line
- **EMULATOR CONFIRMED** — proven against a real Firestore Rules emulator this stage, script + result shown
- **LOCAL CONFIRMED** — proven by direct computation/reasoning outside the emulator (e.g., deterministic string transforms)
- **PRODUCTION READ-ONLY CONFIRMED** — a safe, anonymous, non-destructive read against real production data

---

## Findings

> **REMEDIATION UPDATE**: BL-01, BL-02, BL-03, BL-04, BL-05, and BL-08
> are FIXED; BL-06 and BL-07 are PARTIALLY FIXED (each with an
> explicitly documented, deliberately out-of-scope residual, not a
> silent gap); BL-09 received a small proportionate data-quality
> mitigation. **The fixed `firestore.rules` (commit `24462d5`) has since
> been published to the live `darwesh-group` Firebase project** —
> AUTHZ-01 was re-confirmed against production, read-only, post-deploy;
> BL-01/02/04/05 are treated as deployed and fixed on the strength of
> the emulator suite run against this identical, now-live rules text (no
> production write test was performed, per explicit instruction — see
> **Production deployment status** in `BUSINESS_LOGIC_REMEDIATION.md`).
> Full detail — files changed, rule text, tests, before/
> after behavior, and remaining risk per finding — is in
> **`BUSINESS_LOGIC_REMEDIATION.md`**. Each finding below now carries a
> **Remediation status** line; the original finding text is left as
> written (the historical record of what was found).

### BL-01 — A listing's identity (agentId/agentName/companyId) can be silently reassigned after creation, and an admin's `verified` badge survives the swap

- **Status**: CONFIRMED
- **Type**: SECURITY VULNERABILITY + BUSINESS LOGIC DEFECT
- **Severity**: **High**
- **CWE**: CWE-863 (Incorrect Authorization) — the check validates the wrong point in time
- **Actor**: Any real, authenticated agent (their own listing only — no anonymous/customer reach)
- **Prerequisites**: A real agent account owning at least one listing
- **Business invariant**: A listing's `agentId` always identifies the real, consenting agent who owns it; `agentName` always describes that same person; `companyId` always equals that agent's real company; a `verified:true` badge means an admin reviewed *this specific identity's* listing.
- **Expected behavior**: An agent editing their own listing can change normal property fields, but not who it's attributed to.
- **Observed behavior**: `firestore.rules`' `listings/{id}` update rule (lines 207-216) authorizes the agent branch by checking only `resource.data.agentId == request.auth.uid` — the value **before** the write. It never checks `request.resource.data.agentId`, `.agentName`, or `.companyId` against anything. All three are in the UPDATE_ALLOWED_FIELDS list with no further constraint. An agent who currently owns a listing can therefore rewrite `agentId` to any uid (real or fabricated), `agentName` to any string, and `companyId` to any value — including another company's real id or one that doesn't exist — in a single update.
- **Affected file + line**: `firestore.rules:207-216` (`allow update` for `listings/{listingId}`)
- **Affected Firestore path**: `listings/{id}` UPDATE
- **Evidence**: EMULATOR CONFIRMED —
  ```
  PASS [BL-1a]: Agent A reassigns own listing agentId to Agent B uid -- ALLOWED
  PASS [BL-1b]: Agent A reassigns own listing agentId to a fake/nonexistent uid -- ALLOWED
  PASS [BL-2]:  Agent A sets agentName to a different real agent's name, keeping own agentId -- ALLOWED
  PASS [BL-3]:  Agent A reassigns own listing companyId to Company B -- ALLOWED
  ```
  And the combined, most severe case — EMULATOR CONFIRMED:
  ```
  PASS [BL-12]: Agent A silently reassigns agentId+agentName+companyId on an
                ALREADY admin-VERIFIED listing (verified field itself
                untouched) -- ALLOWED
  Post-reassignment document state:
  {"status":"active","private":false,"price":500000,"title":"Legit verified listing",
   "verified":true,"agentId":"fabricated-identity-uid","companyId":"company-of-choice",
   "agentName":"Totally Different Person"}
  ```
  The `verified:true` flag is untouched by the write (the rule *does* correctly lock `verified` itself against change on this branch — AUTHZ-03's fix holds), but it now sits on a document claiming an entirely different agent, company, and display name than the one an admin actually reviewed.
- **Realistic abuse scenario**: (1) *Trust laundering*: Agent A gets a normal listing legitimately admin-verified, then reassigns `agentName`/`agentId`/`companyId` to a fabricated or unrelated identity — the public listing now shows "Verified by Darwesh Group" attached to an identity no admin ever actually reviewed. (2) *Tenant-boundary violation*: an agent moves their own listing's `companyId` to a different real company's id, or to a nonsense value, producing a doc where `agentId` (a real Company-A agent) and `companyId` (Company B, or invalid) disagree — corrupting the per-company Team Listings view's data integrity for both companies. (3) *Self-orphaning / griefing*: setting `agentId` to a nonexistent uid instantly and irreversibly removes the agent's own ability to edit or delete the listing (only `isAdmin()` can touch it afterward), which could be used to dodge accountability for a listing under active dispute/review.
- **Impact**: Undermines the integrity of the one trust signal ("Verified by Darwesh Group") the platform offers buyers, and breaks the assumed 1:1 binding between a listing and the real agent/company that created and (if applicable) got it verified — the core relational-identity invariant Part 6 of this review was scoped to test.
- **Root cause**: The update rule was written to answer "does the caller currently own this document" without also answering "does the write itself still describe a coherent, consented ownership state." The same "check the old value, never the new one" pattern that AUTHZ-03 already fixed specifically for `verified` was not generalized to the identity fields.
- **Recommended remediation (not implemented this stage — Stage 4 is analysis-only per your instructions)**: Require `request.resource.data.agentId == resource.data.agentId` (and the same for `companyId`) on the agent branch of the update rule — i.e., an agent's own update path should never be able to change *who* owns the listing at all; only `isAdmin()` should be able to reassign ownership. `agentName` should likewise either be locked to match the agent's own `users/{uid}.displayName` at write time, or simply removed from the agent-writable set and always derived server-side/from the linked profile.
- **Confidence**: High — reproduced twice, independently, including the combined verified-badge scenario.
- **Remediation status**: **FIXED**. Agent-branch update rule now locks `agentId`/`companyId` to their pre-write value AND the caller's own identity/company, and `agentName` to its pre-write value; only `isAdmin()` can reassign any of the three. Verified: 11 new tests (`stage5_bl0104_test.mjs` R1–R11), including the exact combined verified-badge scenario. `agentName`-sync-on-profile-change and verified-reset-on-admin-reassignment are documented open product decisions, not silently resolved. **Deployed to production** (commit `24462d5`'s `firestore.rules` published to `darwesh-group`); no production write test performed, per explicit instruction — treated as fixed live on the strength of this emulator proof against the identical deployed text. Full detail in `BUSINESS_LOGIC_REMEDIATION.md`.

---

### BL-02 — Agent financial ledger entries have no value/ownership validation at the rules layer

- **Status**: CONFIRMED
- **Type**: SECURITY VULNERABILITY + DATA INTEGRITY RISK
- **Severity**: Medium
- **CWE**: CWE-20 (Improper Input Validation), CWE-863 (same "old value only" pattern as BL-01)
- **Actor**: Any real, authenticated agent (own transactions only)
- **Prerequisites**: A real agent account with at least one `agentTransactions` record
- **Business invariant**: Every `agentTransactions` record accurately reflects that agent's own real income/expense, with a sane, positive amount, and stays attributed to the agent who created it.
- **Expected behavior**: An agent can log/edit their own manual financial entries with plausible values.
- **Observed behavior**: `firestore.rules:293-297` imposes zero field-level validation (`hasOnly()` doesn't even exist on this collection — the CREATE rule checks only `isAgent() && agentId==auth.uid`; UPDATE/DELETE check only `isOwner(resource.data.agentId) || isAdmin()`, against the pre-write `agentId`, the exact same time-of-check pattern as BL-01). The client's own `finTxForm` validation (`agent-dashboard.html:950-956`, `amount <= 0` rejected) is JS-only and trivially bypassed by any direct SDK/REST call.
- **Affected file + line**: `firestore.rules:293-297`
- **Affected Firestore path**: `agentTransactions/{id}` CREATE/UPDATE
- **Evidence**: EMULATOR CONFIRMED —
  ```
  PASS [BL-4]: Agent A rewrites own agentTransactions amount to -999999 on update -- ALLOWED
  PASS [BL-5]: Agent A rewrites own agentTransactions agentId to Agent B on update -- ALLOWED
  PASS [BL-6]: Agent A creates agentTransactions with amount:1e300 -- ALLOWED
  ```
- **Realistic abuse scenario**: An agent's own displayed "Net Profit" figure (client-computed, `agent-dashboard.html:890-933`) can be made to show anything at all — including impossible values — by direct SDK writes. More concerning: an agent could reassign a transaction's `agentId` to a colleague's uid, either to falsely inflate/deflate a colleague's records if those numbers are ever consulted for a real business decision (bonus/dispute), or simply as vandalism against a teammate's own ledger.
- **Impact**: Since this is a self-reported ledger with no downstream consumer found in this codebase beyond the agent's own dashboard display (no payroll export, no admin oversight UI for agentTransactions was found), realistic business impact today is bounded to the agent's own view of their own numbers — except for the `agentId`-reassignment vector, which crosses into another agent's data.
- **Root cause**: `agentTransactions` never received the allowlist treatment AUTHZ-04 applied to `users`/`listings` — it has no `hasOnly()` at all, and the update branch has the same unvalidated-new-value gap as BL-01.
- **Recommended remediation**: Add a `hasOnly(['type','category','amount','date','note'])`-style allowlist plus `amount is number && amount > 0` (or an explicit reasonable upper bound) to CREATE, and require `request.resource.data.agentId == resource.data.agentId` on UPDATE (never re-attributable).
- **Confidence**: High.
- **Remediation status**: **FIXED**. `agentTransactions` now has a full field allowlist plus type/positivity validation on `amount`, and UPDATE locks `agentId` to its pre-write value and the caller's own identity — matching the recommended remediation almost exactly. No arbitrary maximum was added (none exists in this app's own source, per your explicit instruction not to invent one). Verified: 10 new tests (`stage5_bl0104_test.mjs` R12–R21). **Deployed to production** (commit `24462d5`); treated as fixed live on the strength of the emulator proof against the identical deployed text, no production write test performed. Full detail in `BUSINESS_LOGIC_REMEDIATION.md`.

---

### BL-03 — Agent commission rate cannot actually be set (rules/UI mismatch)

- **Status**: CONFIRMED
- **Type**: UX/PRODUCT ISSUE (not a security vulnerability)
- **Severity**: Low
- **Actor**: N/A (affects the legitimate feature, not exploitable by an attacker)
- **Business invariant**: An agent can set their own commission percentage.
- **Expected behavior**: Clicking "Save Rate" persists `users/{uid}.commissionRate`.
- **Observed behavior**: `firestore.rules:108-115` restricts a self-update of `users/{uid}` to exactly `['displayName','photoURL']`. `commissionRate` isn't in that list, so the write is rejected outright.
- **Affected file + line**: `firestore.rules:108-115`; `agent-dashboard.html:936-945` (the button)
- **Evidence**: EMULATOR CONFIRMED —
  ```
  PASS [BL-7]: Agent A self-updates users/{uid} to set commissionRate=50 -- DENIED
  ```
- **Realistic abuse scenario**: None — this makes the feature *less* capable, not more exploitable. Flagged because it means the live commission total shown in §19 of the model is computed against whatever `commissionRate` value already exists (likely `0`/`undefined` for every real account, since no write path can ever set it), which could mislead an agent about their own numbers.
- **Impact**: Functional defect only.
- **Root cause**: AUTHZ-04's allowlist was derived from `account.html`'s actual save payload, which doesn't include `commissionRate` — a legitimate, separate write path (`agent-dashboard.html`'s Finances tab) was missed since it wasn't in scope for that remediation.
- **Recommended remediation**: Add `commissionRate` to the `users` UPDATE_ALLOWED_FIELDS allowlist (with a sane bound, e.g. `0 <= commissionRate <= 100`) if the feature is meant to work; otherwise remove the dead "Save Rate" button.
- **Confidence**: High.
- **Remediation status**: **FIXED**. `commissionRate` added to the allowlist, bounded 0–100. Verified: 3 new tests (`stage5_bl0307_test.mjs` T1–T3).

---

### BL-04 — Company name slugification is collision-prone, and joining an existing company requires zero approval

- **Status**: CONFIRMED (structural) — severity **bounded** by a disproven escalation path (see below)
- **Type**: BUSINESS LOGIC DEFECT
- **Severity**: Medium
- **CWE**: CWE-863 (borderline — the real gap is a missing identity-verification step in a business process, not a rules bug)
- **Actor**: Any signup applicant (customer OR agent-applicant)
- **Prerequisites**: Knowledge of (or a guess at) an existing company's display name
- **Business invariant**: Only genuine members of a real estate company end up sharing that company's `companyId`.
- **Expected behavior**: Attaching to an *existing* company's tenant boundary should require some verification that the applicant is actually affiliated with it.
- **Observed behavior**: `_slugify_company()` (`backend/app/otp/email_handler.py:42-47`) and `slugifyCompany()` (`admin.html:2999-3003`) are two independently hand-written but algorithmically identical functions: `trim → lowercase → collapse any run of non-[a-z0-9] to "-" → strip leading/trailing "-" → fallback "company"`. This is deterministic and intentionally collision-prone for near-duplicates (`"Darwesh Group"`, `"darwesh group"`, `"Darwesh-Group"`, `"Darwesh_Group"`, extra whitespace all → `"darwesh-group"`) — explicitly the documented "join" design (`firestore.rules:10-18`). The transform is also ASCII-only: any non-`[a-z0-9]` character, including all Unicode letters, is treated as a separator, so it silently discards distinguishing information for non-English names too. `companies/{slug}` creation is `allow create: if isSignedIn() && !exists(...)` (`firestore.rules:44-48`) — pure create-if-not-exists, no ownership/approval concept at all. A second signup typing the same (or colliding) name simply inherits the *existing* `companyId` with **zero approval gate**.
- **Affected file + line**: `backend/app/otp/email_handler.py:42-47`, `admin.html:2999-3003`, `firestore.rules:44-48`
- **Affected Firestore path**: `companies/{id}` CREATE; `users/{uid}.companyId` at signup
- **Evidence**: LOCAL CONFIRMED (deterministic string-transform analysis, both functions read and compared verbatim) + CODE CONFIRMED (exact quotes above, gathered by direct source reading this stage).
- **Escalation path tested and DISPROVEN — severity bounded**: Simply sharing a `companyId` as a `role:'customer'` account grants **no** elevated access on its own. EMULATOR CONFIRMED:
  ```
  PASS [BL-10]: Customer who merely joined company-a via signup (role still
                customer) GETs a private company-a listing -- DENIED
  PASS [BL-11]: Same customer, companyId-scoped query for company-a private
                listings -- DENIED (query unprovable, isAgent() is false)
  ```
  Real privilege (agent-level, company-scoped visibility) still requires a **separate, human admin action** (`role:'agent'` promotion) that the automatic company-join step does not grant and does not gate.
- **Realistic abuse scenario**: An attacker signs up requesting `role:'agent'` with a company name matching (or colliding with) a real, established company. If an admin, reviewing the "Wants Agent Access" queue in `admin.html`, approves the promotion without independently verifying the applicant's real-world affiliation with that company (the UI shows the *requested* company but nothing flags "this is an existing company with N other members" vs. "this creates a brand-new company"), the attacker gains genuine agent-level, company-scoped access to that company's private/closed team listings.
- **Impact**: The technical escalation still requires a human admin's mistake, but the system provides no signal to help the admin avoid that mistake, and the underlying identity claim ("I work at Darwesh Group") is entirely self-asserted and silently accepted at the data layer.
- **Root cause**: Company membership was designed as a convenience ("no manual Firestore edit needed") without a parallel identity-verification concept — the design assumes the admin-promotion step is where real diligence happens, but doesn't surface the information (is this a new or existing company? how many current members?) the admin would need to do that diligence well.
- **Recommended remediation**: Not implemented this stage. If pursued: surface "joining existing company with N members" vs. "creating a new company" distinctly in the admin's promotion-review UI; consider requiring an existing company-admin/owner's approval (a concept that doesn't exist yet) before a new applicant's `companyId` takes effect, rather than trusting free-text at signup.
- **Confidence**: High for the structural mechanism; Medium for real-world exploitability (depends entirely on admin diligence, which wasn't observable from code).
- **Remediation status**: **FIXED**. Founding a brand-new company remains automatic (no existing relationship claimed); joining an EXISTING company's name now only records `requestedCompanyId`/`requestedCompanyName` (untrusted) — the trusted `companyId` stays unset until an admin's promotion action explicitly grants it, and that action now surfaces the requested company name rather than granting silently. The admin's promotion-review UI signal recommended above is now partially addressed (the requested company name is shown; a member-count/new-vs-existing indicator was not added — smallest-safe-workflow scope). Verified: 5 name-collision variants (backend, `test_email_otp.py`) proving normalization alone never grants trusted membership, plus 5 rules tests (`stage5_bl0104_test.mjs` R22–R26). **`firestore.rules` half deployed to production** (commit `24462d5`); the backend half (`email_handler.py`/`firebase_admin_ops.py`) requires a separate Cloud Run redeploy, not yet confirmed live — see `BUSINESS_LOGIC_REMEDIATION.md`'s Production deployment status section. Full detail in `BUSINESS_LOGIC_REMEDIATION.md`.

---

### BL-05 — Submission-to-listing "one-click publish" trusts unvalidated attacker data and has no duplicate-conversion guard

- **Status**: CONFIRMED
- **Type**: BUSINESS LOGIC DEFECT (confused-deputy pattern) + DATA INTEGRITY RISK
- **Severity**: Medium
- **CWE**: CWE-441 (Unintended Proxy/Confused Deputy)
- **Actor**: Any anonymous visitor (via `sell.html`, the confused deputy is the reviewing admin)
- **Prerequisites**: A submitted `type:'sell'` submission; an admin who clicks through without independently verifying every field
- **Business invariant**: A submission can only ever become one listing, and an admin-published listing's content should be admin-reviewed, not merely admin-clicked.
- **Expected behavior**: Converting a submission to a real listing should be a deliberate, re-validated action, and idempotent (can't accidentally publish the same submission twice).
- **Observed behavior**: `createListingFromSubmission()` (`admin.html:2128-2180`) copies the submission's `title`/`address`/`beds`/`baths`/`size`/`photoUrls[0]`/etc. **verbatim** into the Add Listing form's input fields — no re-validation at copy time beyond what the form's own minimal submit-time check does (non-empty title/address/price, a pinned lat/lng). The eventual `addDoc` (`admin.html:1600-1609`) writes `agentId: currentUid` (the admin's own uid) and `agentName: currentAdminName + ' (Admin)'` — so a fabricated submission, if clicked through without edits, becomes a real public listing carrying Darwesh Group's own admin identity. **No field on the submission or the new listing links them together** (no `submissionId` stored on the listing), and **no atomicity or duplicate-guard exists at all** — the code never even reads back the submission before creating the listing. Clicking "Add Listing" N times (or two admins acting on the same submission) produces N independent `listings` documents.
- **Affected file + line**: `admin.html:2128-2180` (prefill), `admin.html:1600-1609` (create)
- **Affected Firestore path**: `listings/{new id}` CREATE (indirectly sourced from `submissions/{id}`, no link recorded)
- **Evidence**: CODE CONFIRMED (exact quotes gathered this stage via direct source reading of both functions).
- **Realistic abuse scenario**: An attacker submits a fabricated "sell" listing (fake address, inflated size, a stolen/misleading photo URL as `photoUrls[0]`) hoping a busy admin reviews quickly and clicks "Add Listing" without cross-checking each field against reality. The result is a real, public, seemingly Darwesh-Group-authored listing built entirely from unverified attacker input — the platform's own credibility is the thing being borrowed. Separately, an admin double-clicking (or a slow network causing a retry) silently creates duplicate public listings for the same property.
- **Impact**: Reputational/data-integrity, bounded by requiring an admin's own click to actually publish (this is not a direct, unauthenticated create-listing bypass — `firestore.rules`' listings CREATE rule is unaffected and still correctly admin/agent-gated).
- **Root cause**: The admin-review UI was built as a convenience prefill, not a verified promotion pipeline — no submission↔listing linkage or state tracking was ever added.
- **Recommended remediation**: Not implemented this stage. If pursued: record `sourceSubmissionId` on the created listing and a corresponding `converted:true`/`convertedListingId` on the submission (checked before allowing a second conversion), and consider highlighting which fields the admin has *not* edited from the raw submission value as a review aid.
- **Confidence**: High.
- **Remediation status**: **FIXED**, matching the recommended remediation exactly: `sourceSubmissionId` recorded on the listing, `convertedListingId` recorded on the submission, both inside a real Firestore `runTransaction()` (true atomicity, not just a read-then-write) plus an independent `firestore.rules` guard. Numeric fields (price/beds/baths/sqft) now validated too. Verified: 9 new tests (`stage5_bl05_test.mjs` S1–S9), including a genuine concurrent-conversion race proving exactly one of two simultaneous attempts succeeds. **Deployed to production** (commit `24462d5`'s `firestore.rules`; the `admin.html` transaction logic ships via the normal GitHub Pages frontend deploy) — treated as fixed live on the strength of this emulator proof, no production write test performed. Full detail in `BUSINESS_LOGIC_REMEDIATION.md`.

---

### BL-06 — Viewing-request submissions are not tied server-side to a real listing

- **Status**: CONFIRMED
- **Type**: DATA INTEGRITY RISK (not a security vulnerability — no authorization boundary is crossed)
- **Severity**: Low–Medium
- **CWE**: CWE-345 (Insufficient Verification of Data Authenticity)
- **Actor**: Any visitor, guest or signed-in
- **Prerequisites**: None
- **Business invariant**: A viewing request's `listingId`/`address`/`city`/`priceLabel` accurately describe a real, currently-public listing.
- **Expected behavior**: The admin reviewing "Customer Services" viewing requests should be able to trust that the referenced property is real and the details shown are accurate.
- **Observed behavior**: `map.html:709-724` and `listing.html:482-490` build the submission entirely from the browser's own already-loaded `listing` object — `listingId`, `address`, `city`, `priceLabel`, `lat`, `lng` are all client-supplied. `firestore.rules:228-231` validates only `status`/`type`/`uid` at create — nothing checks `listingId` exists, is public, or that `address`/`priceLabel` match the real document at that id. `admin.html`'s viewing-request detail view (`VIEWING_DETAIL_FIELDS`, `admin.html:1908-1912`) displays exactly these client-supplied fields with no cross-lookup against `listings/{listingId}`.
- **Affected file + line**: `map.html:709-724`, `listing.html:482-490`, `admin.html:1908-1912`, `firestore.rules:228-231`
- **Affected Firestore path**: `submissions/{new id}` CREATE (`type:'viewing'`)
- **Evidence**: CODE CONFIRMED.
- **Realistic abuse scenario**: A direct API/SDK call (bypassing the site's own UI, same class of actor as AUTHZ-01's original finding) could submit a "viewing request" for a nonexistent `listingId`, or one whose `address`/`priceLabel` don't match the real listing — polluting the admin's queue with unreliable data, or being used as a low-effort spam/nuisance vector against the Customer Services workflow. It does not expose or escalate access to anything not already public.
- **Impact**: Data-quality/nuisance, bounded — no private data is read or exposed by this path.
- **Root cause**: The submission schema trusts the same client-side convenience copy the rest of the UI relies on, with no equivalent of AUTHZ-01's "prove the query" requirement applied to write-time content validation.
- **Recommended remediation**: Not implemented this stage. If pursued: since `firestore.rules` cannot itself fetch-and-compare two documents' arbitrary string fields cheaply within the create rule for every write, consider deriving the display fields the admin sees from a server-side/Cloud-Function-verified re-fetch of `listings/{listingId}` rather than trusting the submission's own copies, or at minimum requiring `exists(/databases/$(database)/documents/listings/$(request.resource.data.listingId))` in the create rule as a floor.
- **Confidence**: High for the mechanism; the realistic impact is intentionally not inflated (no CWE for injection/auth here — this is a trust/data-quality gap).
- **Remediation status**: **PARTIALLY FIXED** — implemented exactly the "floor" option named above: `firestore.rules` now requires `exists(listings/{listingId})` when a viewing submission names one, without exposing any listing data to the caller. Full field-by-field content cross-validation (address/price actually matching) was not implemented — documented as remaining risk, not silently dropped. Private/closed listings were NOT made newly readable by this change (verified the `exists()` check grants no read access). Verified: 3 new tests (`stage5_bl0307_test.mjs` T4–T6).

---

### BL-07 — Verification-photo path can still be self-spoofed by the legitimate token holder (residual, post-AUTHZ-02)

- **Status**: CONFIRMED
- **Type**: BUSINESS LOGIC DEFECT (verification-integrity weakness)
- **Severity**: Low
- **CWE**: CWE-345 (Insufficient Verification of Data Authenticity)
- **Actor**: The submission's own creator (guest or signed-in) — **not** an unrelated third party (that vector is the part AUTHZ-02 fixed)
- **Prerequisites**: A pending submission the caller legitimately created (i.e., they legitimately hold the token)
- **Business invariant**: The `path` recorded in `submissions/{id}/verification/{token}` always points to a photo genuinely captured during that submission's own verification step.
- **Expected behavior**: A submitter can only ever attach the selfie they actually just took.
- **Observed behavior**: The AUTHZ-02 fix correctly requires the caller to hold the exact token (closing the third-party-tampering hole), but the write rule (`firestore.rules:279-281`) still only checks `keys().hasOnly(['path','setAt'])` — `path` itself remains an arbitrary, unvalidated string, even for the legitimate holder.
- **Affected file + line**: `firestore.rules:277-283`
- **Affected Firestore path**: `submissions/{id}/verification/{token}` WRITE
- **Evidence**: EMULATOR CONFIRMED —
  ```
  PASS [BL-9]: Guest with sub-A's own real token sets verification path to an
               unrelated arbitrary Storage path (self-spoofed evidence, not a
               third-party attack) -- ALLOWED
  ```
  Cross-submission confusion (the more severe variant, using submission A's token against submission B) remains correctly blocked — EMULATOR CONFIRMED:
  ```
  PASS [BL-8]: Guest attempts to write submissions/sub-B/verification/token-AAA
               using sub-A's real token against sub-B -- DENIED
  ```
- **Realistic abuse scenario**: A guest completing the sell-submission identity-verification step (bypassing the UI, via direct SDK call while legitimately holding their own token) could set `path` to point at any already-public Storage object (e.g., an agent's own public profile photo) instead of a genuine selfie, defeating the purpose of manual fraud review without needing anyone else's credentials.
- **Impact**: Narrower than the original AUTHZ-02 finding — this is the submitter potentially deceiving the platform about their own identity evidence, not an attacker tampering with someone else's; the admin review step is still the actual safety net either way.
- **Root cause**: `path` has no server-side way (within Firestore Rules alone) to prove it corresponds to a blob that was actually just uploaded through the real capture flow — this would require either a Storage-triggered Cloud Function or accepting it as an inherent limitation of a client-only capture UI.
- **Recommended remediation**: Not implemented this stage (Stage 4 is analysis-only). If pursued: this is likely only closable with a small Storage-triggered Cloud Function that validates the referenced object was uploaded to the expected `sell-verification/{token}/` prefix, rather than a Firestore-Rules-only fix.
- **Confidence**: High.
- **Remediation status**: **PARTIALLY FIXED**. `path` is now constrained to `^sell-verification/[^/]+/selfie\.jpg$` — pointing at any object outside that one dedicated, admin-only-readable prefix (e.g. an agent's public photo) is closed. Full provenance proof (was this object genuinely just captured?) still requires the Storage-triggered Cloud Function named above — correctly not implemented, per your instruction to keep low-finding fixes small and well-understood rather than adding new infrastructure. Verified: 3 new tests (`stage5_bl0307_test.mjs` T7–T9).

---

### BL-08 — "Add Transaction" has no double-submit guard

- **Status**: CONFIRMED
- **Type**: DATA INTEGRITY RISK
- **Severity**: Low
- **Actor**: The agent themself (not exploitable by anyone else — this is an own-data footgun, not a cross-user attack)
- **Business invariant**: One "Add Transaction" click creates exactly one ledger entry.
- **Expected behavior**: The submit button disables during the async write, or an in-flight guard prevents a second concurrent submission.
- **Observed behavior**: `agent-dashboard.html:947-977`'s submit handler never sets `btn.disabled = true` before `await addDoc(...)`, and has no in-flight flag. A rapid double-click (or a slow network causing the user to click again) fires the handler twice, each producing an independent `addDoc`.
- **Affected file + line**: `agent-dashboard.html:947-977`
- **Affected Firestore path**: `agentTransactions/{new id}` CREATE (×2)
- **Evidence**: CODE CONFIRMED.
- **Realistic abuse scenario**: Not really an "attack" — an ordinary user's accidental double-click duplicates their own manual income/expense entry, silently inflating their own displayed totals until they notice and manually delete the duplicate.
- **Impact**: Self-inflicted data-quality nuisance only; no cross-user or authorization impact.
- **Root cause**: Missing standard "disable while submitting" UX pattern — present elsewhere in the app (e.g. `sell.html`'s submit button does disable) but missed here.
- **Recommended remediation**: Not implemented this stage. `btn.disabled = true` before the write, re-enabled in a `finally`/on error, matching the pattern already used by `sell.html`'s own submit handler.
- **Confidence**: High.
- **Remediation status**: **FIXED**, exactly matching the recommended remediation — submit button disabled for the duration of the write, re-enabled in a `finally` block.

---

### BL-09 — MAM AI valuation's comparable set can be skewed by a small number of agent-controlled listings

- **Status**: CONFIRMED (mechanism)
- **Type**: DATA-QUALITY RISK / BUSINESS-LOGIC WEAKNESS — **explicitly not classified as a security vulnerability**
- **Severity**: Low–Medium
- **Actor**: A real, authenticated agent account (not anonymous — creating listings requires the same `firestore.rules` gate as always)
- **Business invariant**: The valuation estimate reasonably reflects genuine market comparables.
- **Expected behavior**: A small number of extreme listings shouldn't be able to dominate a city's estimate.
- **Observed behavior**: `sell.html:934-936` (post-remediation) queries `where(private==false, status==active)` — correctly excludes private/closed listings (the AUTHZ-01 fix already closes the "can private/closed data poison this" half of Part 12's question). The comparable-count floor is `comparable.length < 2` (`sell.html:943`) — as few as 2 listings in a city are enough to produce an estimate — and the average (`sell.html:947`) is a plain, unweighted arithmetic mean of `price/sqft` with no outlier trimming, cap, or per-agent/per-listing weight limit. Since listing `price` itself has no server-side bound (confirmed in this and the prior stage), an agent with real create/edit rights could list one or two extreme-priced properties in a low-inventory city and materially shift the shown estimate for every prospective seller in that city.
- **Affected file + line**: `sell.html:924-957` (`getValuationBtn` click handler)
- **Affected Firestore path**: `listings` (read-only query, no write path involved in the valuation itself)
- **Evidence**: CODE CONFIRMED (the query and averaging logic were both directly authored/verified during this session's own prior AUTHZ-01 remediation, and re-confirmed by reading here).
- **Realistic abuse scenario**: An agent wanting to encourage sellers in a specific low-inventory city to list at a higher (or lower) price than the real market supports creates one or two throwaway listings at an extreme price/sqft, nudging the "estimate" every visitor to `sell.html` sees for that city.
- **Impact**: The feature explicitly and consistently labels its output as an estimate (`sell.valuationBody`: "Get an estimated market value", `sell.valuationResult`: "Estimated value: {low} – {high}", `sell.valuationNoData`: "Not enough comparable listings yet") — no binding financial or contractual decision is made by this number alone. Real-world impact is limited to nudging a seller's initial price expectations, not a direct financial loss or authorization bypass — this is why it is classified as a **data-quality/business-logic weakness**, not a security vulnerability, per your explicit instruction not to inflate severity for "unusual data can be created."
- **Root cause**: No minimum-sample-size floor beyond 2, no outlier resistance, in a feature that's inherently vulnerable to low-inventory cities having few real comparables to dilute manipulation.
- **Recommended remediation**: Not implemented this stage. If pursued: raise the minimum comparable count, use a median or trimmed mean instead of a plain average, and/or weight by recency, without needing any rules change (this is a pure client-side computation choice).
- **Confidence**: High for the mechanism; Medium for real-world likelihood (requires a real agent account and deliberate intent, and only affects a soft estimate).
- **Remediation status**: **FIXED (small, proportionate mitigation)**. Switched to median instead of a plain mean — one added `sort()`, no other complexity. Minimum comparable count (2) and the ±15% band were deliberately left unchanged (product decisions, not this fix's call). Still correctly classified as data-quality/model-quality, not a security vulnerability.

---

## Investigated and DISPROVEN / FALSE POSITIVE (explicitly tested, not just assumed safe)

| ID | Candidate | Result | Evidence |
|---|---|---|---|
| FP-1 | Agent can view another company's private/team-only listings | **DISPROVEN** — `isListingOwnerOrAdmin()` requires the caller's own `agentId`; cross-company access denied regardless of shared or attacker-chosen `companyId` | EMULATOR CONFIRMED (`BL-10`, `BL-11`) |
| FP-2 | A non-admin can modify another company's (or any company's) metadata | **DISPROVEN** — `companies/{id}` update/delete requires `isAdmin()` unconditionally, no owner/member concept exists to abuse | CODE CONFIRMED (`firestore.rules:44-48`) |
| FP-3 | Repeated close/reopen of a listing duplicates or inflates stored commission | **DISPROVEN** — commission is never stored; it's recomputed live from `status=='closed'` listings on every page load (`agent-dashboard.html:866-887`), so there is nothing to double-count | CODE CONFIRMED |
| FP-4 | Verification-token capability can be reused/collided across different submissions | **DISPROVEN** — the token is checked against the exact submission it's nested under (`get(.../submissions/$(submissionId))`, the same path segment as the URL); a token valid for submission A is rejected against submission B | EMULATOR CONFIRMED (`BL-8`) |
| FP-5 | A demoted/deleted agent retains privileges through stale listing data | **DISPROVEN (by design, not independently re-tested this stage)** — `isAgent()`/`myRole()` reads `users/{uid}.role` live on every single rule evaluation (no caching, no denormalized role stored on the listing itself); the instant an admin changes `role` away from `'agent'`, every rule branch depending on `isAgent()` re-evaluates false on the very next request | CODE CONFIRMED (`firestore.rules:24-30`) |
| FP-6 | A `closed` listing can still be publicly visible through some other combination of fields | **DISPROVEN** — `isListingPubliclyVisible()` requires `status=='active'` as a strict equality; no other field combination substitutes for it | CODE CONFIRMED (`firestore.rules:168-171`) |

---

## Hardening-only items (no realistic exploit path found, worth noting)

- **H-1**: `storage.rules`' `listing-photos/*` write path still isn't role-gated (any signed-in user, not agent/admin-only) — carried over, unchanged, from AUTHZ-04's "not addressed" note; still bounded by `listings` creation itself requiring the real Firestore-level agent/admin gate to actually attach a photo to a public listing.
- **H-2**: No rate-limiting or per-IP/per-session throttling on `submissions` creation (`sell.html`/`map.html`) — a scripted actor could flood the admin's Customer Services queue with junk submissions. Explicitly out of this review's scope per your no-DoS-testing instruction; noted for awareness only.
- **H-3**: `agentTransactions` has no `hasOnly()` field allowlist at all (see BL-02) — structurally the same class of gap AUTHZ-04 closed for `users`/`listings`, just never extended to this collection.

---

## Summary

### 1. Confirmed Critical
None.

### 2. Confirmed High
- **BL-01** — Listing identity (agentId/agentName/companyId) reassignable post-creation; admin `verified` badge survives an identity swap.

### 3. Confirmed Medium
- **BL-02** — `agentTransactions` amount/ownership unvalidated at the rules layer.
- **BL-04** — Company-name slugification collision + zero-approval auto-join (severity bounded — escalation still requires a separate human admin action, which was tested and disproven as automatic).
- **BL-05** — Submission→listing "one-click publish" trusts unvalidated data; no duplicate-conversion guard.

### 4. Confirmed Low
- **BL-03** — `commissionRate` write silently rejected (functional defect, not exploitable).
- **BL-06** — Viewing-request fields not tied server-side to a real listing.
- **BL-07** — Verification-photo path still self-spoofable by the legitimate token holder (residual, post-AUTHZ-02, narrower than the original finding).
- **BL-08** — "Add Transaction" missing a double-submit guard.

### 5. Data-integrity risks
BL-02 (financial), BL-05 (duplicate listings from one submission), BL-06 (unverified viewing-request content), BL-08 (duplicate transactions) — all listed above with full detail; none independently escalate to a new authorization bypass.

### 6. Likely findings
None carried forward as "likely but unconfirmed" — every candidate investigated this stage was either concretely proven (CONFIRMED, EMULATOR or CODE) or concretely disproven (see the DISPROVEN table). Nothing was left in an ambiguous state.

### 7. False positives
FP-1 through FP-6 (table above) — each investigated with the same rigor as a confirmed finding, not assumed safe from documentation.

### 8. Hardening-only items
H-1, H-2, H-3 (above).

### 9. Exact emulator tests performed
All run against `firestore.rules` (unmodified, current, production-matching text) via `@firebase/rules-unit-testing` against a local Firestore emulator, fresh project per test file, this stage:
- `stage4_probe.mjs` — `BL-1a`, `BL-1b`, `BL-2`, `BL-3` (listing identity reassignment)
- `stage4_probe2.mjs` — `BL-4`, `BL-5`, `BL-6` (financial manipulation), `BL-7` (commissionRate denial), `BL-8` (cross-submission token confusion, denied), `BL-9` (self-spoofed verification path, allowed)
- `stage4_probe3.mjs` — `BL-10`, `BL-11` (company-membership-alone escalation, disproven)
- `stage4_probe4.mjs` — `BL-12` (verified badge surviving identity swap — the combined, most severe scenario)

All scripts are in the session scratchpad (`/tmp/.../scratchpad/fbtest/stage4_probe*.mjs`), not committed to the repo (matching this session's existing pattern of keeping test-harness scratch files out of the tracked codebase; the *results* are what's preserved here).

### 10. Exact local tests performed
Deterministic string-transform comparison of `_slugify_company()` (Python) vs. `slugifyCompany()` (JS) for BL-04 — both read verbatim and traced by hand against the listed example inputs (case/whitespace/punctuation/Unicode variants of "Darwesh Group").

### 11. Safe production read-only checks
None were necessary or performed this stage — every finding here is a rules/logic-mechanism question fully answerable and provable against the emulator using the project's real, current rules text, without needing to touch live data. (AUTHZ-01's own production verification, performed in the prior remediation turn, is unaffected and unchanged by this stage.)

### 12. Anything not safely testable
- Real-world admin diligence for BL-04/BL-05 (whether an actual admin would notice a suspicious company-join or an unedited fabricated submission) is a human-process question, not something testable from code or an emulator — noted as a confidence-bounding factor on both findings rather than left untested silently.
- BL-09's real-world likelihood (would an agent actually bother manipulating a handful of listings to skew an estimate) is a behavioral/economic question outside what static analysis or emulator testing can answer — the mechanism itself is fully confirmed, only the "would someone actually do this" judgment is inherently unverifiable without real usage data.
