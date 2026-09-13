# Business Logic Remediation (Stage 4 Remediation)

Remediation of the findings in `BUSINESS_LOGIC_SECURITY_REVIEW.md`, in the
priority order requested: BL-01, BL-02, BL-04, BL-05, then the low
findings (BL-03/06/07/08), then a small BL-09 mitigation. Stage 5 was
**not** started — this document covers remediation only.

All previously-fixed authorization protections (AUTHZ-01 through
AUTHZ-04) were re-verified against this session's own regression suite
after every change in this document — none were weakened. See
**Regression results** at the bottom.

All rules changes were validated against a local Firestore emulator
using the project's real, current `firestore.rules` text — never
production. No production data was read, written, or modified.

> **DEPLOYMENT UPDATE**: The `firestore.rules` text from commit
> `24462d5` (this document's own commit) has been published to the live
> `darwesh-group` Firebase project — done manually via the Firebase
> Console, confirmed by a fresh rules version appearing after
> publishing. Full detail in **Production deployment status** below.

---

## BL-01 — Listing identity / verified badge (HIGH)

- **Status**: **FIXED**
- **Root cause**: `firestore.rules`' `listings/{id}` update rule authorized
  an agent's edit by checking only `resource.data.agentId ==
  request.auth.uid` — the value **before** the write — and never
  validated what the write itself claimed about `agentId`/`agentName`/
  `companyId` afterward.
- **Files changed**: `firestore.rules`
- **Rule changes**: The agent branch of the `listings` update rule now
  requires:
  ```
  request.resource.data.agentId == resource.data.agentId
  request.resource.data.agentId == request.auth.uid
  request.resource.data.get('agentName', null) == resource.data.get('agentName', null)
  request.resource.data.companyId == resource.data.companyId
  request.resource.data.companyId == myCompanyId()
  ```
  `agentId`/`companyId` use direct access (the create rule's own
  equality checks already force both to always be present, so a direct
  comparison never throws on a missing field). `agentName` uses
  `.get(field, null)` on both sides instead — unlike `agentId`/
  `companyId`, it was never a required-at-create field, so some real or
  test-fixture documents legitimately lack it; direct access there would
  have thrown and permanently denied every future edit on such a
  document (caught during this session's own regression run, not
  assumed — see **Regression results**).
- **Design decision — agentName (immutable vs. derived)**: Chose **A) immutable
  through the agent-edit branch**, not re-derived live from the agent's
  profile. A rules-based live lookup (mirroring `myRole()`/`myCompanyId()`)
  would need to replicate `agent-dashboard.html`'s own `displayName ||
  email` fallback exactly, which is fragile to keep in sync from inside
  a rules file with no shared code path to the frontend. Locking it is
  the smaller, more robust fix.
  **Open product decision, not guessed at here**: if a listing's
  displayed agent name should stay in sync with later profile
  `displayName` changes, that requires either (a) a Cloud Function
  triggered on `users/{uid}` writes that cascades to that agent's
  listings, or (b) a rules-based live lookup accepting the fragility
  above. Neither was implemented — flagging for your decision rather
  than silently picking one.
- **Admin reassignment behavior**: Deliberately **left unrestricted** —
  `isAdmin()`'s branch can still change `agentId`/`agentName`/`companyId`
  freely, matching "Admin-only reassignment may remain possible if that
  is intentional."
- **Verified-reset-on-reassignment**: **Not implemented — flagged as an
  open product/security decision, not guessed at.** Today, if an admin
  reassigns identity fields on an already-`verified:true` listing, the
  `verified` flag is untouched (stays `true`) — this matches existing
  behavior for every other admin edit (the update rule never
  auto-resets `verified` on any admin write) and no product requirement
  establishing "reassignment should reset verification" exists anywhere
  in this app's source. If you want admin-driven identity reassignment
  to automatically clear `verified`, that's a deliberate rule addition
  (`request.resource.data.get('verified', false) == false` whenever
  `agentId`/`companyId` changes, but only for that specific case) —
  tell me and I'll implement it as its own scoped change.
- **Tests added** (`stage5_bl0104_test.mjs`, R1–R11): edit title → ALLOW;
  edit price → ALLOW; change agentId → DENY; change agentName → DENY;
  change companyId → DENY; change agentId on a VERIFIED listing while
  `verified` stays true → DENY; change companyId on a VERIFIED listing →
  DENY; Agent B modifying Agent A's listing → DENY; admin reassigning
  identity fields → ALLOW (intentional); agent resending their own
  unchanged identity fields alongside a real edit → ALLOW (regression
  guard — a legitimate edit must not break); AUTHZ-03 create-time
  self-verify guard still enforced.
- **Test results**: 11/11 passing.
- **Before/after**: Before — any agent could silently transfer/hijack a
  listing's ownership, or point a colleague's public display name at
  their own listing, or move it to another company, all through the
  normal edit path, and a prior admin verification survived that swap
  unnoticed. After — none of that is possible through the agent-edit
  path; only `isAdmin()` can change who a listing belongs to.
- **Remaining risk**: The agentName-sync and verified-reset-on-reassignment
  product decisions above are open, not silently resolved.

---

## BL-02 — Agent transaction integrity (MEDIUM)

- **Status**: **FIXED**
- **Root cause**: `agentTransactions` had no field allowlist at all, and
  neither CREATE nor UPDATE validated `amount`'s type or sign; UPDATE
  also never re-checked `agentId` post-write.
- **Files changed**: `firestore.rules`
- **Rule changes**: New `isValidAgentTransaction()` helper, required on
  both CREATE and UPDATE:
  ```
  type in ['income', 'expense']
  category is string && category.size() > 0
  amount is (int or float) && amount > 0
  date is string && date.size() > 0
  keys().hasOnly(['agentId','type','category','amount','date','note','createdAt'])
  ```
  UPDATE additionally requires `request.resource.data.agentId ==
  resource.data.agentId == request.auth.uid` (agentId can never be
  reassigned after creation, admin excepted).
- **No arbitrary maximum imposed**: per your explicit instruction, no
  product-defined upper bound on `amount` exists anywhere in this app's
  own source, so none was invented — only type and strict positivity are
  enforced. A very large but finite `amount` (e.g. `1e300`) is still
  accepted; this is a documented, deliberate choice, not an oversight.
- **Tests added** (`stage5_bl0104_test.mjs`, R12–R21): valid create →
  ALLOW; negative amount → DENY; zero amount → DENY; string amount
  (wrong type) → DENY; `1e300` amount → ALLOW (per the no-invented-max
  decision above); agent reassigning agentId on update → DENY; Agent B
  "adopting" Agent A's transaction → DENY; invalid `type` value → DENY;
  unknown extra field → DENY; legitimate amount-only update → ALLOW.
- **Test results**: 10/10 passing.
- **Before/after**: Before — negative/zero/wrong-typed amounts and
  cross-agent reassignment were all silently accepted. After — all
  rejected at the rules layer; legitimate income/expense/purchase entry
  is unaffected (no frontend changes were needed — `agent-dashboard.html`
  already only ever sends the now-allowlisted fields with the
  already-positive values its own client-side check produces).
- **Remaining risk**: None identified for the fixed mechanism. No
  product maximum exists to enforce even if desired.

---

## BL-04 — Company join / slug collision (MEDIUM)

- **Status**: **FIXED**
- **Root cause**: Typing a name that normalized to an existing company's
  slug silently, automatically granted that company's trusted
  `companyId` to the new account — merely typing a matching name was
  treated as sufficient proof of membership.
- **Business invariant determined from source**: company membership
  (`companyId`) is meant to be a real tenant boundary (team-scoped
  listing visibility) — per your framing, "automatic membership based
  solely on a normalized company name is not a trustworthy authorization
  mechanism" for that kind of relationship. **Confirmed this was never
  actually a live privilege-escalation path on its own** (see the
  disproven-candidate table in `BUSINESS_LOGIC_SECURITY_REVIEW.md`,
  re-confirmed here — `role` stays `customer` regardless, and a
  customer with a shared `companyId` gets zero elevated access, tested
  this stage in R26/T-series). The real risk was the *silent, ungated*
  nature of the companyId assignment itself, ahead of the one
  human-reviewed gate (role promotion) the system does have.
- **Design chosen — smallest safe workflow, not a full approval system**:
  - **Founding a brand-new company** (the typed name does not match any
    existing `companies/{id}`) is still fully automatic — there's no
    existing team/business relationship being claimed, so this remains
    safe and ungated exactly as before.
  - **Requesting an existing company** now records `requestedCompanyId`/
    `requestedCompanyName` (untrusted, informational) and leaves the
    trusted `companyId` **unset**. No elevated access follows from this
    alone.
  - An admin promoting that applicant to `role:'agent'` now sees the
    requested company name in the "Wants Agent Access" badge and, if
    approving, is asked to explicitly confirm granting that specific
    company's access — the promotion action itself sets the real
    `companyId` at that moment, not before.
  - This reuses the **existing** role-promotion action (`admin.html`'s
    Users tab) rather than inventing a new approval UI/workflow —
    the "safe minimum," with the remaining gap (no way for an *existing
    company's own members* to approve a join, only a platform admin)
    explicitly flagged as a larger product decision, not implemented.
- **Files changed**: `firestore.rules`, `backend/app/otp/email_handler.py`,
  `backend/app/otp/firebase_admin_ops.py`, `admin.html`,
  `backend/tests/test_email_otp.py`
- **Rule changes**: `users/{uid}` CREATE now requires, when `companyId`
  is present: `companyId == null || !exists(companies/{companyId})` —
  i.e. a self-create (signup **or** `admin.html`'s own Add Agent
  self-create step) can never directly claim an *already-existing*
  company's id; only founding a new one is allowed at create time.
  `requestedCompanyId`/`requestedCompanyName` added to the allowlist
  (self-editable at create, locked against later self-edit exactly like
  `companyId`/`requestedRole` already were).
- **Backend changes**: `email_handler.py`'s signup-complete flow now
  checks `company_exists(company_id)` *before* deciding whether to trust
  or merely record the claim; `firebase_admin_ops.py` gained
  `company_exists()` and `create_user_profile()` now writes
  `requestedCompanyId`/`requestedCompanyName` alongside the (possibly
  null) trusted `companyId`.
- **Frontend changes**: `admin.html`'s Add Agent flow no longer sets
  `companyId` in its own self-create step (the company was just
  resolved by the admin's own trusted session moments earlier, so it
  already exists — the new create-time rule would reject it) — it's set
  immediately after via the admin's already-authorized `updateDoc`
  instead, unaffected by the new restriction. The Users tab's
  role-promotion handler now surfaces `requestedCompanyName` and, when
  promoting a pending agent request, explicitly confirms and grants that
  companyId as part of the same action.
- **Tests added**:
  - Backend (`test_email_otp.py`): new parametrized test,
    `test_signup_complete_as_agent_with_existing_company_name_never_auto_grants_membership`,
    covering `"Darwesh Group"`, `"darwesh group"`, `"Darwesh-Group"`,
    `"Darwesh_Group"`, and `"  Darwesh   Group  "` — all five normalize
    to the same slug and all five now record a request only, never a
    trusted `companyId`. Existing new-company test updated to also
    assert `requestedCompanyId`/`requestedCompanyName` are `null` in
    that case (5 backend tests total for this finding).
  - Rules (`stage5_bl0104_test.mjs`, R22–R26; `rules_test.mjs`, 2 updated
    + 2 new): self-create claiming an existing companyId directly →
    DENY; self-create founding a brand-new companyId → ALLOW; self-create
    with only `requestedCompanyId` → ALLOW; later self-update trying to
    set `companyId` directly → still DENY; a customer merely sharing a
    companyId → still no elevated access.
- **Test results**: Backend 6/6 (5 name variants + 1 revised assertion)
  passing; rules 5/5 new + 2/2 updated passing.
- **Before/after**: Before — typing "Darwesh Group" a second time
  silently, automatically attached the new account to the real company,
  with zero signal to anyone. After — only founding a genuinely new
  company is automatic; joining an existing one is recorded as a
  request and requires the admin's own promotion action to become real
  access, with the requested company now visible to that admin at
  decision time.
- **Remaining risk**: The admin remains the sole approver for joining an
  existing company — there's still no mechanism for an existing
  company's own agents/owner to approve a new member themselves. Not
  implemented (would be a larger product feature, not a security fix at
  this scope) — flagged, not silently deferred.

---

## BL-05 — Submission → listing conversion (MEDIUM)

- **Status**: **FIXED**
- **Root cause**: The conversion flow prefilled the Add Listing form from
  a submission's fields (already an explicit field-by-field mapping, not
  a spread — no change needed there), but nothing validated the copied
  values, nothing prevented converting the same submission twice, and no
  link was ever recorded between a submission and the listing it became.
- **Files changed**: `firestore.rules`, `admin.html`
- **Trace confirmed** (re-verified this stage, matches
  `BUSINESS_LOGIC_SECURITY_REVIEW.md`'s BL-05 write-up): `verified` was
  never inherited from submission input (always the checkbox's own
  default, `false`) — already correct, unchanged. `agentId`/`agentName`/
  `companyId` were always set from trusted admin-session values
  (`currentUid`, `currentAdminName + ' (Admin)'`, `null`), never from the
  submission — already correct, unchanged.
- **Rule changes**: New `isValidSourceSubmissionOrNone()` — when a new
  listing carries `sourceSubmissionId`, requires the referenced
  submission to exist, be `type=='sell'`, and have no
  `convertedListingId` already set. New `hasSaneListingNumbers()` (see
  Part 13 note below) — required on both agent and admin listing
  CREATE, and the agent branch of UPDATE: `price` required, positive
  number; `beds`/`baths`/`sqft`, when present, non-negative numbers. No
  arbitrary maximum imposed, matching the same reasoning as BL-02.
- **Frontend changes**: `createListingFromSubmission()` now checks
  `s.convertedListingId` before prefilling at all (early, honest UI
  exit) and tracks the source submission in a new hidden
  `sourceSubmissionId` field. `onListingFormSubmit()`'s own numeric
  validation was widened (`!price` → `!(price > 0)`, catching negative
  prices a truthy-only check missed; added `beds/baths/sqft < 0`
  checks). When a `sourceSubmissionId` is present, the create now runs
  inside a real `runTransaction()`: read the submission, verify it's
  `type=='sell'` and not already converted, then atomically create the
  listing (with `sourceSubmissionId` recorded on it) and mark the
  submission `convertedListingId` in the same transaction — a genuine
  Firestore transaction, not a plain read-then-write, so two truly
  concurrent conversion attempts can't both succeed. The ordinary "Add
  Listing" path (no submission involved) is unaffected — same plain
  `addDoc` as before.
- **Idempotency mechanism**: `sourceSubmissionId` on the listing +
  `convertedListingId` on the submission, exactly the
  architecture-compatible pattern requested, enforced both by the
  client-side transaction (true atomicity against real concurrency) and
  independently by `firestore.rules` (defense in depth against a direct
  API call bypassing the UI, or a future bug in the transaction code).
- **Tests added** (`stage5_bl05_test.mjs`, S1–S9): valid conversion →
  ALLOW; sourceSubmissionId pointing at a nonexistent submission →
  DENY; wrong type (`viewing`, not `sell`) → DENY; already-converted
  submission → DENY; negative price on an ordinary create → DENY; zero
  price → DENY; negative beds → DENY; ordinary create with no
  `sourceSubmissionId` at all → ALLOW (existing flow unaffected);
  **concurrent duplicate conversion** — two simultaneous
  `runTransaction()` calls racing the same submission, replicating
  `admin.html`'s actual logic exactly (not a simplified stand-in) →
  exactly 1 of 2 succeeds, proven directly, not assumed.
- **Test results**: 9/9 passing.
- **Before/after**: Before — an admin could publish a listing straight
  from unvalidated (including negative-priced) submission data, and
  clicking "Add Listing" twice from the same submission created two
  independent public listings with no trace they came from the same
  source. After — numeric sanity is enforced, one submission can become
  at most one listing even under genuine concurrency, and every
  submission-derived listing is traceably linked back to its source.
- **Remaining risk**: Full field-by-field cross-validation (does the
  admin-edited title/address still resemble the original submission?)
  is not attempted — that's a human-review question, not a rules
  question, and was out of scope for "validate numeric/required fields."

---

## Low findings

### BL-03 — commissionRate write silently rejected

- **Status**: **FIXED**
- **Files changed**: `firestore.rules`
- **Fix**: Added `commissionRate` to the `users/{uid}` self-update
  allowlist, bounded `0 <= commissionRate <= 100`.
- **Tests**: `stage5_bl0307_test.mjs` T1–T3 — valid rate → ALLOW;
  150 (out of range) → DENY; negative → DENY. 3/3 passing.
- **Before/after**: Before — every "Save Rate" click on
  `agent-dashboard.html`'s Finances tab silently failed. After — it
  works, bounded to a sane percentage.

### BL-06 — Viewing requests not tied to a real listing

- **Status**: **PARTIALLY FIXED**
- **Files changed**: `firestore.rules`
- **Fix**: A `type=='viewing'` submission naming a `listingId` must now
  reference a real, existing `listings` document (a rules-internal
  `exists()` check — never exposes the referenced listing's data to the
  caller, so this can't be used to newly discover whether a private
  listing exists beyond what the caller already claimed).
- **Not fixed**: Full field-by-field cross-validation (does the
  submitted `address`/`city`/`price` actually match that listing?) —
  explicitly out of scope for a proportionate rules-only fix; documented
  as remaining risk, not silently dropped.
- **Private/closed listings intentionally NOT made newly readable**:
  confirmed the `exists()` check does not require or grant `get`/`list`
  access to the referenced listing — the listings `get`/`list` rule
  (AUTHZ-01's fix) is completely untouched by this change.
- **Tests**: `stage5_bl0307_test.mjs` T4–T6 — real listingId → ALLOW;
  nonexistent listingId → DENY; no listingId at all (field optional) →
  ALLOW. 3/3 passing.
- **Before/after**: Before — a viewing request could reference any
  `listingId` string, real or not. After — it must reference a real
  listing document (existence only, not full content match).

### BL-07 — Verification-photo path residual self-spoofing

- **Status**: **PARTIALLY FIXED**
- **Files changed**: `firestore.rules`
- **Fix**: The `path` field on `submissions/{id}/verification/{token}`
  must now match `^sell-verification/[^/]+/selfie\.jpg$` — the exact
  shape `sell.html`'s own upload flow produces. A submitter (still
  correctly required to hold the real token, per AUTHZ-02) can no
  longer point their own verification record at a completely unrelated,
  already-public object elsewhere in Storage (e.g. an agent's profile
  photo).
- **Not fixed, by design**: This cannot fully prove the referenced
  object was freshly captured through the real camera flow — a
  submitter could still reference *some other* `sell-verification/*`
  object if its exact 122-bit random token were somehow known (not
  realistically guessable). Closing that residual gap needs a
  Storage-triggered Cloud Function verifying the object's actual upload
  provenance, which is new infrastructure, not a "small, well-understood
  change" within the current architecture — correctly left unimplemented
  per your explicit instruction to keep low-finding fixes small.
- **Tests**: `stage5_bl0307_test.mjs` T7–T9 — correct shape → ALLOW;
  path outside `sell-verification/` entirely → DENY; path inside
  `sell-verification/` but wrong filename → DENY. 3/3 passing.
- **Before/after**: Before — `path` was any string at all. After — it's
  constrained to the one legitimate prefix/shape; pointing at an
  unrelated public object is closed, pointing at another real
  verification upload (if its unguessable token were somehow known)
  remains a documented residual.

### BL-08 — "Add Transaction" double-submit

- **Status**: **FIXED**
- **Files changed**: `agent-dashboard.html`
- **Fix**: The submit button (`finTxSubmitBtn`, newly given an `id` to
  target) is now disabled for the duration of the write and
  re-enabled in a `finally` block — the same pattern `sell.html`'s own
  submit handler already used.
- **Tests**: Frontend-only fix (a UI race condition, not a rules
  question) — verified by direct code review that the disable/enable
  wraps the entire `addDoc` call including its error path; no emulator
  test applies (BL-02's rules-layer fix independently ensures even a
  genuine double-submit can never create financially-invalid records,
  only a legitimate duplicate of a valid one, which this fix now
  prevents at the source).
- **Before/after**: Before — a rapid double-click could create two
  identical ledger entries. After — the second click is a no-op while
  the first is still in flight.

---

## BL-09 — MAM AI valuation (DATA INTEGRITY / MODEL QUALITY, not a security fix)

- **Status**: **FIXED** (small, proportionate mitigation, per your
  explicit instruction not to over-engineer this)
- **Files changed**: `sell.html`
- **Confirmed already correct, unchanged**: comparables already use only
  `private == false` and `status == 'active'` (the AUTHZ-01 fix, in
  place since the prior remediation turn) — private/closed listings were
  already excluded before this change.
- **Fix**: Replaced the plain arithmetic mean of comparable price/sqft
  values with the **median** — one array sort, no added complexity, and
  far more resistant to a small number of extreme-priced comparables
  dominating a low-inventory city's estimate.
- **Not changed**: The minimum-comparable-count floor (still 2) and the
  ±15% low/high band are untouched — raising the floor or changing the
  band would be a product decision this fix doesn't make unilaterally.
- **Tests**: No new emulator test (this is pure client-side arithmetic,
  not a rules question) — verified by reading the updated calculation
  directly; the query shape itself (private/status filtering) is already
  covered by the existing AUTHZ-01 regression tests.
- **Before/after**: Before — one or two extreme listings could
  meaningfully skew every visitor's estimate for that city. After — the
  same small number of extreme listings has far less influence on the
  reported figure.

---

## Regression results

All suites run against this session's final, combined `firestore.rules`
(BL-01 through BL-09 fixes all applied together), on a freshly restarted
local emulator, never production:

| Suite | Previous baseline | This session |
|---|---|---|
| `rules_test.mjs` (earlier audit phase) | 14 | **16** (2 updated to reflect the intentional BL-04 behavior change, 2 new added — see below) |
| `otp_rules_test.mjs` | 5 | 5 (unchanged) |
| `stage3_authz_test.mjs` (AUTHZ-01..04 regression suite) | 65 | **65** (unchanged — confirms AUTHZ-01/02/03/04 are still fully intact; one pre-existing bug in this session's own BL-01 rule, caught by this exact suite, was fixed before landing — see note below) |
| `stage3_storage_test.mjs` | 15 | 15 (unchanged) |
| `stage5_bl0104_test.mjs` (new, BL-01/02/04) | — | **26** new |
| `stage5_bl05_test.mjs` (new, BL-05) | — | **9** new |
| `stage5_bl0307_test.mjs` (new, BL-03/06/07) | — | **9** new |
| Backend `pytest` | 135 | **140** (5 new BL-04 name-collision variants; zero regressions) |

**Total: 145 Firestore/Storage emulator tests, 140 backend tests, 0
failures.**

**Self-caught regression, fixed before landing**: the first version of
BL-01's `agentName` lock used direct dot-access comparison
(`request.resource.data.agentName == resource.data.agentName`), which
throws (denies) when `agentName` is legitimately absent from a document
— this was caught by `stage3_authz_test.mjs`'s own pre-existing P3-8/
P10-3/P10-5 tests failing with `"Property agentName is undefined on
object"` on the first full-suite run after the BL-01 change, exactly
the kind of regression those tests exist to catch. Fixed by switching to
`.get('agentName', null)` on both sides (matching the established
pattern already used for `assignedAgentId`/`companyId`/`requestedRole`
elsewhere in this same rules file, for the identical reason), then
re-verified clean. No test was weakened or deleted to make this pass —
the rule was fixed to match the tests' correct expectation.

**AUTHZ-01/02/03/04 explicitly re-confirmed intact**: `stage3_authz_test.mjs`
is the exact suite that proved each of those fixes originally; its full,
unmodified 65/65 pass here confirms none of this session's changes
reopened any of them.

---

## Production deployment status

The `firestore.rules` text committed at `24462d5` (identical to what
every test above ran against) has been **published to the live
`darwesh-group` Firebase project** — done manually, by the user, via the
Firebase Console (this session has no deploy credentials and did not
perform the publish itself). The user confirmed a fresh rules version
appeared in the Console after publishing, consistent with the publish
having taken effect.

**AUTHZ-01, post-deploy, re-confirmed** (read-only, anonymous,
non-destructive — no data written, modified, or deleted):

| Check | Result |
|---|---|
| Unfiltered anonymous `listings` collection query | `403 PERMISSION_DENIED` |
| Direct `get()` on the specific listing previously proven `private:true`-readable (`bguFdoO8NpbT4C0tK73k`) | `403 PERMISSION_DENIED` |
| Correctly-filtered `private==false AND status=='active'` query | `200 OK`, exactly the 5 legitimate public listings, that document excluded |

Identical to the result obtained right after the original AUTHZ-01
deployment — no regression from any Stage 4 rule addition.

**BL-01/BL-02/BL-04/BL-05 (and BL-03/06/07/09) — deployed and fixed,
by direction, without a production write test**: unlike AUTHZ-01, none
of the Stage 4 findings have a safe anonymous *read*-only production
check (they're all write-authorization or business-logic questions —
confirming them live would mean actually attempting the fixed
write against real data, which the user explicitly declined per "do
not modify real listings/transactions/submissions for testing"). Per
the user's explicit direction, these are treated as **deployed and
fixed in production** on the strength of the emulator regression suite
already run against this exact, now-live rules text (`stage5_bl0104_test.mjs`
26/26, `stage5_bl05_test.mjs` 9/9, `stage5_bl0307_test.mjs` 9/9, plus
the updated `rules_test.mjs` 16/16 — all listed in **Regression
results** above), not an independent live re-test. This is a documented
methodology choice, not an assumption made silently.

**Backend deploy status — deployed and health-verified**: the BL-04
backend changes (`email_handler.py`/`firebase_admin_ops.py`) live in the
FastAPI service on Cloud Run, a **separate deployment** from Firestore
Rules — publishing `firestore.rules` does not by itself deploy the
backend. The user has confirmed this separate deployment happened:

| Detail | Value |
|---|---|
| Cloud Run service | `darwesh-backend` |
| Revision | `darwesh-backend-00002-sdc` |
| Region | `me-central1` |
| Traffic | 100% on this revision |
| Health check | `GET /api/v1/health` → `{"status":"ok", ...}` |

The health check confirms the service is up and this revision is the
one actually serving traffic; it's a generic liveness endpoint, not a
functional exercise of the BL-04 signup-flow code path specifically —
the revision serving 100% of traffic is what ties the *deployed* code to
this commit's changes, the same way the emulator suite ties the
*correctness* of those changes to the identical source text. Both the
Firestore Rules half (`firestore.rules`, commit `24462d5`) and the
backend half (`darwesh-backend-00002-sdc`) of BL-04 are now confirmed
live in production.

---

## Credential and GitHub Secret-Scanning Remediation

### Credential classification

The flagged value is a **Firebase Web API key** (`apiKey` in
`js/firebase-init.js`'s `firebaseConfig` object, format `AIzaSy...`),
for Firebase project `darwesh-group`. This is **not** a service-account
private key, an OAuth client secret, or any other genuinely private
Google credential.

Per Google/Firebase's own published guidance, a Firebase Web API key is
**meant to be public** — it identifies which Firebase project a client
request is for, not a bearer credential that grants access on its own.
The actual authorization boundary for this app is, and was already
correctly documented as being, `firestore.rules`/`storage.rules` plus
Firebase Authentication — never the secrecy of this key. This app's own
`SECURITY_ARCHITECTURE.md` (written in an earlier session, independently
re-confirmed here) already stated this correctly: *"`js/firebase-init.js`'s
`apiKey`/`authDomain`/etc. are the Firebase Web config — intentionally
public per Firebase's own documentation."*

### Locations found

| Location | Type | Status |
|---|---|---|
| `js/firebase-init.js` | Legitimate, required client-side Firebase Web config | **Kept as-is** — required for the browser app to function; not a vulnerability |
| `backend/tests/test_firebase_reset.py` | Unnecessary hardcoded duplicate, inside a URL-parsing test fixture that never needed the real value | **Fixed this session** — replaced with an obvious placeholder string |
| `backend/internal/auth/firebase_reset_test.go` | Obsolete Go-era file — **does not exist in the current repository at all** | Confirmed via `git log`: added in commit `49a9ca0` ("Backend milestone 3"), removed in `10a0fac` ("Port backend from Go/Gin to Python/FastAPI") when the backend was rewritten. Nothing to clean up in the current tree — it's gone. Only reachable via git history (see **Git-history assessment** below). |
| `SECURITY_ARCHITECTURE.md:278` | A truncated `AIzaSy...` prefix inside descriptive text about a prior git-history scan — not the actual key value | Not a leak; no action needed |

### Files changed (this session)

- `backend/tests/test_firebase_reset.py` — real key replaced with
  `"FAKE-TEST-API-KEY-NOT-A-REAL-CREDENTIAL"`; verified the affected
  tests (`test_extract_oob_code_parses_real_firebase_link_format` and
  the rest of the file) still pass, since `extract_oob_code()` only
  parses the `oobCode` query parameter and never reads or validates
  `apiKey` at all — confirmed by reading the function, not assumed.

### Backend/test cleanup

Done — see above. No other backend or test file contained a hardcoded
copy (confirmed by a repo-wide `grep -rl "AIzaSy"` sweep, restricted to
tracked, non-vendored files).

### Frontend decision

**No change made to `js/firebase-init.js`.** Per your explicit
instruction, this key is not being treated as a secret to hide — moving
it to another file, obfuscating it, or otherwise trying to "protect" it
client-side would be false security theater for a value every visitor's
browser already receives in plain text on every page load. Security
here correctly depends on Firebase Auth + `firestore.rules` +
`storage.rules` (all independently audited across this session's
earlier stages), not on this key's confidentiality.

### Google Cloud key restriction recommendation

**Not performed from this sandbox** — no Google Cloud / Firebase
credentials or console access are available here. Exact manual steps for
you:

1. Open the [Google Cloud Console](https://console.cloud.google.com/)
   → **APIs & Services** → **Credentials**, project `darwesh-group`.
2. Find the API key matching `js/firebase-init.js`'s `apiKey` (the
   Firebase Console → Project Settings → General tab also shows/links
   to this same key).
3. Under **Application restrictions**, choose **HTTP referrers (web
   sites)** and add exactly the real origins this app is served from:
   - `https://www.darweshgroup.com/*`
   - `https://darweshgroup.com/*` (the bare domain, if it doesn't just
     redirect to `www` — confirm from your DNS/hosting config)
   - `https://darwesh-group.firebaseapp.com/*` — Firebase's own default
     Hosting/Auth-action domain; Firebase Auth's email-link action
     pages (password reset, the ones `backend/app/auth/firebase_reset.py`
     parses) are served from here even though the main site is on
     GitHub Pages, so this must stay allowed or password reset/email
     verification links will break.
   - `https://darwesh-group.web.app/*` — Firebase's alternate default
     domain; include it only if you've confirmed nothing depends on it,
     otherwise it's safe to include defensively (an unused allowed
     origin has no downside).
   - If you (or any contributor) run this site locally against the real
     `darwesh-group` project (not just the Firestore/Storage emulators
     this session used) for development, add
     `http://localhost:<port>/*` too — omit this if all local dev
     already uses the emulator suite exclusively.
4. Under **API restrictions**, restrict the key to only the specific
   Firebase APIs this app actually uses (Identity Toolkit API /
   Firebase Auth, Cloud Firestore API, Cloud Storage API, Token Service
   API) rather than leaving it unrestricted — Firebase Console's own
   "Apps" page for this key usually pre-populates the correct list.
5. **Do not** apply an IP-address restriction (this key is used from
   arbitrary visitors' browsers, not a fixed server) and **do not**
   remove or regenerate the key as part of this step — see rotation
   guidance below.

### Git-history assessment

**Rewriting history is not recommended for this credential.** The value
is a Firebase Web API key, which — per the classification above — is
designed to be safe even when fully public; it appears in the *current*
`js/firebase-init.js` anyway (intentionally, required for the app to
function), so scrubbing it from history would not actually remove it
from anywhere a real attacker could see it (the live site itself). The
value also exists historically in the deleted Go test file
(`backend/internal/auth/firebase_reset_test.go`, commits `49a9ca0`
through `10a0fac`) — same reasoning applies there.

History rewriting (`git filter-repo`/`BFG`, force-push) carries real
cost — it rewrites every downstream clone's history, breaks any open
PRs, and risks losing work if done incorrectly — and is the kind of
destructive operation this session was explicitly told not to perform
automatically. Given the key's actual sensitivity, that cost is not
justified here. **This assessment would be different for a genuinely
private credential** (a service-account key, an API secret, a password)
— none were found anywhere in this repository, current or historical
(see the real-secret sweep below).

### Real-secret sweep result

A dedicated sweep (current tracked files **and** full `git log --all
--full-history`) for every category you listed, values never printed:

| Type | File | Line | Tracked/Untracked | Current/Historical | Action required |
|---|---|---|---|---|---|
| Firebase Web API key (not a private credential — see classification) | `js/firebase-init.js` | 25 | Tracked | Current | None — intentionally public, required |
| Firebase Web API key (duplicate) | `backend/tests/test_firebase_reset.py` | 15 | Tracked | Current (now fixed) | **Done** — replaced with a placeholder this session |
| Firebase Web API key (duplicate, Go era) | `backend/internal/auth/firebase_reset_test.go` | — | N/A — file doesn't exist in current tree | Historical only (commits `49a9ca0`–`10a0fac`) | None recommended — see git-history assessment above |
| Synthetic RSA keypair (`private_key`/`private_key_id`) | `backend/tests/test_main_wiring.py` | 32–44 | Tracked | Current | None — freshly generated at test-run time (`rsa.generate_private_key(...)`), never a real credential; this is the correct pattern, called out as a positive example |
| `.env.example` variable names (no values) | `backend/.env.example` | — | Tracked | Current | None — all sensitive-looking variable names (`FIREBASE_SERVICE_ACCOUNT_JSON`, `OTP_HMAC_SECRET`, `RESEND_API_KEY`) have empty values, confirmed |

Checked and found **nothing** for: PEM/private-key headers
(`BEGIN...PRIVATE KEY`) anywhere in tracked files; a real `.env` ever
committed (only `.env.example` is tracked, and the real `.env` is
`.gitignore`d); `GOOGLE_APPLICATION_CREDENTIALS` referenced with a real
path/value; Resend API key shape (`re_...`); hardcoded passwords outside
test fixtures; bearer tokens; OAuth `client_secret`; JWT-shaped tokens
(`eyJ...`); any service-account JSON ever added to git history.

### Rotation required: **NO**

Per the classification above, this is a Firebase Web API key, not a
private credential — rotating it would not close any real exposure
(the key is meant to be, and already is, visible in the live site's own
JavaScript), and would require updating every place `firebaseConfig` is
referenced across every HTML page and the Go-era historical commits for
no security benefit. The one actionable step is the Google Cloud Console
**restriction** recommended above (limiting which domains/APIs the key
can be used from) — that's hardening, not rotation, and is the
appropriate response to this credential type.

### Manual actions required (summary)

1. Apply the HTTP-referrer and API restrictions in Google Cloud Console
   — steps given above, cannot be performed from this sandbox.
2. Resolve the GitHub Secret Scanning alert per the recommendation
   below (your call, not performed automatically).

### Recommended GitHub alert resolution

**"Used in tests"** is the most truthful resolution for the
`backend/tests/test_firebase_reset.py` location — that's exactly what it
was, and it's now fixed. For the overall alert (which also names the
already-removed Go file and the intentionally-public frontend config),
**"False positive"** or GitHub's closest equivalent (some orgs use
"Won't fix" for an intentionally-public value) is the more accurate
description of `js/firebase-init.js` itself — it isn't a mistake, it's
required, public-by-design configuration. Neither **"Revoked"** nor
**"Rotated"** is truthful, since neither action was taken or is
warranted per the classification above. This is a recommendation, not
an action taken — **the alert has not been closed by this session**, per
your explicit instruction.
