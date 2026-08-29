# Darwesh Group — Authorization / IDOR / BOLA Deep Review (Stage 3)

Baseline: `ATTACK_SURFACE.md` (Stage 1), `AUTHORIZATION_MATRIX.md` (this
stage, Part 1). Every finding below is backed by a live Firestore/
Storage emulator test (evidence quoted verbatim), a real production
read (explicitly labeled), or a direct source citation — never by
reading a rule and assuming its effect.

**Evidence-labeling discipline used throughout, per your instruction:**
- **EMULATOR CONFIRMED** — proven against a real Firestore/Storage
  emulator running the actual `firestore.rules`/`storage.rules` from
  this repository (synced immediately before each run).
- **PRODUCTION CONFIRMED** — proven with a real, read-only HTTPS
  request against the live `darwesh-group` Firebase project.
- **CODE-ONLY OBSERVATION** — a fact established by reading source
  directly (e.g., "no code reads this field"), where a live test isn't
  the right tool for proving a negative.
- **LOCAL CONFIRMED** — proven with the backend's own pytest suite.

No production data was created, modified, or deleted. All production
interaction was a small number of anonymous, read-only GET requests.

---

## PART 1 — Authorization matrix

See `AUTHORIZATION_MATRIX.md` (updated this stage).

---

## PART 2 & PART 3 — User A vs. User B / agent-dashboard.html candidate

All tests below ran against a fresh emulator instance seeded with
`agentA`/`agentB` (different `companyId`s), `customerA`/`customerB`,
and `admin1`, plus one listing and one `agentTransaction` owned by
`agentA`. Full script: `stage3_authz_test.mjs` (session scratchpad).

| Test | Request | Rule/backend path | Expected | Actual | Evidence |
|---|---|---|---|---|---|
| P3-1 | Agent B `updateDoc(listings/listing-A-public, {price:1})` | `firestore.rules` listings update: `isAgent() && resource.data.agentId==auth.uid \|\| isAdmin()` | DENIED | **DENIED** | `PASS [P3-1]` |
| P3-2 | Agent B `deleteDoc(listings/listing-A-public)` | same | DENIED | **DENIED** | `PASS [P3-2]` |
| P3-3 | Agent B `updateDoc(..., {status:'closed'})` (status-toggle) | same | DENIED | **DENIED** | `PASS [P3-3]` |
| P3-4 | Agent B `deleteDoc(agentTransactions/tx-A)` | `isOwner(resource.data.agentId) \|\| isAdmin()` | DENIED | **DENIED** | `PASS [P3-4]` |
| P3-5/6/7 | Same three ops, **unauthenticated** | same rules | DENIED | **DENIED** | `PASS [P3-5..7]` |
| P3-8/9 | Sanity: Agent A on their **own** listing/transaction | same rules | ALLOWED | **ALLOWED** | `PASS [P3-8/9]` (proves the denials above aren't a broken test, e.g. a rules syntax error denying everything) |

**Verdict on the Stage 1 candidate**: **FALSE POSITIVE / DEFENSE-IN-DEPTH**,
exactly per your instruction's classification rule — `agent-dashboard.html`'s
`window.editListing`/`window.deleteListing`/`window.toggleListingStatus`/
`window.deleteFinTx` genuinely have no in-JS ownership check, and are
directly console-callable, but every single cross-agent and
unauthenticated attempt against them is independently rejected by
`firestore.rules`, proven live, not inferred. **This is CONFIRMED
DEFENSE-IN-DEPTH, not a live vulnerability** — no bypass of the rules
layer was found.

**Part 2 (impersonation via forged owner fields on create)** — same
script, `P2-6` through `P2-9`:

| Test | Forged field | Result |
|---|---|---|
| Customer B creates a `listings` doc with `agentId:'agentA'` | ownership impersonation | **DENIED** (customer isn't even an agent — `isAgent()` fails first) |
| Agent B creates a `listings` doc with `agentId:'agentA'` (impersonating a *different real* agent) | ownership impersonation | **DENIED** (`agentId==auth.uid` fails) |
| Agent B creates a `submissions` doc with `uid:'customerA'` | identity impersonation | **DENIED** |
| Customer B creates an `agentTransactions` doc with `agentId:'agentA'` | ownership impersonation | **DENIED** |

**Verdict**: **FALSE POSITIVE** for all forged-owner-field create attempts — confirmed blocked in every tested combination.

Cross-user read/write on `favorites`/`savedSearches` (Part 2's other
requirement): `P2-1/2/3` — Customer B read/write/delete against
Customer A's favorites subcollection, all **DENIED**. **FALSE POSITIVE.**

---

## PART 4 — Mass assignment / protected fields

| ID | Field tested | Where | Result | Status |
|---|---|---|---|---|
| P4-1 | `role: 'admin'` | self-update, `users/{own}` | **DENIED** | FALSE POSITIVE |
| P4-3 | `companyId` | self-update | **DENIED** | FALSE POSITIVE |
| P4-4 | `assignedAgentId` | self-update | **DENIED** | FALSE POSITIVE |
| P4-7 | `companyId` set to a **different** company than the agent's own, alongside a valid `agentId:self` | listing create | **DENIED** (`companyId==myCompanyId()` enforced) | FALSE POSITIVE |
| P4-8 | `status: 'approved'` at submission create time | `submissions` create | **DENIED** (`status=='pending'` required) | FALSE POSITIVE |
| P4-9/9b/10 | `role:'admin'`, `requestedRole:'admin'` at signup-shaped create | `users` create | **DENIED** | FALSE POSITIVE |
| **P4-2** | **`isAdmin: true`** (a field name the rules never mention at all) | self-update, `users/{own}` | **the WRITE SUCCEEDS** — no rule blocks an unrecognized field name | See **AUTHZ-04** below |
| **P4-5** | **`verified: true`** | agent updating their **own** listing | **the WRITE SUCCEEDS** | See **AUTHZ-03** below |
| **P4-6** | **`approvedBy: 'agentA-self-approved'`** (arbitrary unknown field) | agent updating their own listing | **the WRITE SUCCEEDS** | Same root cause as AUTHZ-03/04 — no schema validation on unlisted fields |

**Root cause (both confirmed-succeeding cases)**: `firestore.rules`'
`users/{uid}` update rule enumerates exactly four locked fields
(`role`, `assignedAgentId`, `companyId`, `requestedRole`) and lets
*everything else* through if the caller is the doc's owner; the
`listings/{id}` update rule only checks `agentId==auth.uid`, with zero
field-level restriction beyond that. Neither rule uses an allowlist
(only fields X, Y, Z may ever be written) — both use a denylist (every
field EXCEPT these specific ones is free to change). This is the
textbook shape of a mass-assignment gap (CWE-915).

---

## PART 5 — Role escalation

| ID | Attempt | Result |
|---|---|---|
| P5-1 | Customer B direct `role:'agent'` self-write | **DENIED** |
| P5-2 | Customer B sets `requestedRole:'agent'` then tries `role:'agent'` anyway | **DENIED** — `requestedRole` is not a grant path, confirmed live, not just by design intent |
| P5-3 | Agent B `role:'admin'` self-promotion | **DENIED** |
| P5-4 | Agent B promotes **another** user (`customerB`) to `role:'agent'` | **DENIED** — being an agent is not `isAdmin()` |
| P5-5 | Sanity: Admin promotes `customerB` to `agent` | **ALLOWED** (proves the promotion mechanism itself works when the caller genuinely is admin) |

Per your scope note in Part 1: `company`/`office`/`lawyer`/`engineer`/
`designer`/`cleaner` are **not roles or account types anywhere in this
codebase** (confirmed in `AUTHORIZATION_MATRIX.md`'s opening section) —
there is no privilege to escalate *to* for any of them, so "can a
normal user become one" doesn't apply; documented as **NOT APPLICABLE**
rather than assumed safe.

**Verdict**: **FALSE POSITIVE** for every tested role-escalation path.

---

## PART 6 — Collection query authorization (private/closed/draft listings)

Seeded 4 listings under `agentA`: one `active`/public, one
`private:true`, one `status:'closed'`, one `status:'draft'` — then
read them as a completely unauthenticated caller, both by direct `get()`
**and** by unfiltered collection query.

```
PASS [P6-1]: Unauthenticated GET listing-A-private (direct doc get) -- ALLOWED
PASS [P6-2]: Unauthenticated GET listing-A-closed (direct doc get) -- ALLOWED
PASS [P6-3]: Unauthenticated GET listing-A-draft (direct doc get) -- ALLOWED
PASS [P6-4]: Unauthenticated COLLECTION QUERY over all listings (no where clause)
    -> confirmed: unfiltered collection query returned 4 docs including private/closed/draft
PASS [P6-5]: Unauthenticated query WHERE private==false explicitly excludes the private one
    -> confirms rules do NOT block this query type either way; app must apply the filter itself
```

**This is EMULATOR CONFIRMED and then independently PRODUCTION
CONFIRMED** — see **AUTHZ-01** below for the full writeup and the real
production evidence (one genuinely `private:true` listing exists in
the live `darwesh-group` project right now and was returned by an
anonymous, unauthenticated read).

`firestore.rules`' `listings/{id}`: `allow read: if true;` is
completely unconditional — there is no per-document field check of any
kind on reads, so this isn't a query-semantics subtlety, it's the rule
text itself.

---

## PART 7 — Submissions / verification

```
PASS [P7-1]: Customer B READ Customer A's submission -- DENIED
PASS [P7-2]: Customer B UPDATE Customer A's submission status -- DENIED
PASS [P7-3]: Anonymous (guest) UPDATE ANOTHER user's (customerA's) pending submission photo fields -- ALLOWED
PASS [P7-4]: Anonymous UPDATE status alongside a photo field on someone else's pending submission -- DENIED
PASS [P7-5]: Anonymous UPDATE photo fields on a NON-pending submission -- DENIED
PASS [P7-6]: Guest CREATE submission with verificationPhotoPath pointing at an arbitrary/unrelated Storage path -- ALLOWED
```

**P7-1/P7-2 verdict**: **FALSE POSITIVE** — normal cross-user
read/status-write on submissions is correctly blocked.

**P7-3 + P7-6 combined verdict**: **CONFIRMED** — see **AUTHZ-02**
below. This is the Stage-1 "`verificationPhotoPath` identity-confusion"
candidate, and it is real: the rule branch that lets a submission's
photo fields be patched in the background
(`status=='pending' && diff().affectedKeys().hasOnly(['photoUrls','photoUploadToken','verificationPhotoPath'])`)
has **no ownership check whatsoever** — not even comparing against the
document's own recorded `uid`. It doesn't matter whether the target
submission belongs to a guest or a signed-in customer, and it doesn't
matter whether the caller is signed in either. Combined with P7-6
(the value written is never validated against any expected path shape),
an attacker can point *any* pending submission's `verificationPhotoPath`
at any other Storage object path they choose.

---

## PART 8 — Storage authorization

Full matrix (rules-cited, then emulator-proven):

| PATH | PUBLIC READ | AUTH READ | OWNER READ | PUBLIC WRITE | AUTH WRITE (non-owner) | OWNER WRITE | Emulator evidence |
|---|---|---|---|---|---|---|---|
| `sell-submissions/*` | **Yes** | — | — | **Yes** (image, <10MB) | — | — | P8-1, P8-2, P8-3 (non-image denied), P8-4 (oversized denied) |
| `sell-verification/*` | **No** | **No** (non-admin denied) | admin-only, cross-service | **Yes** (guest write, image, <10MB) | — | — | P8-5 (guest denied), P8-6 (agent — non-admin — denied) |
| `listing-photos/*` | **Yes** | **Yes** (any signed-in, not role-gated) | — | No | — | — | P8-13 (a plain **customer**, not agent/admin, can write here) |
| `agent-photos/{uid}/*` | **Yes** | — | **Yes** | No | **No** | **Yes** | P8-7 (cross-agent write denied), P8-8 (own write allowed), P8-9 (public read allowed), P8-12 (unauthenticated cross-user write denied) |
| `customer-photos/{uid}/*` | **Yes** | — | **Yes** | No | **No** | **Yes** | P8-10 (own write allowed), P8-11 (cross-role write denied) |
| ALL paths | — | — | — | — | — | — | P8-14: **delete is denied for everyone, everywhere** (`allow delete: if false` on every match block) |

**P8-15** (predictable-path probe): reading a non-existent object at a
guessable path returns `storage/object-not-found`, not a permission
error — confirms the *rule itself* would allow the read if an object
existed there; the only thing standing between an attacker and reading
any `agent-photos`/`customer-photos`/`listing-photos`/`sell-submissions`
object is knowing/guessing its exact path (these are all intentionally
public-read paths by design, so this isn't a new finding — restated
here only because Part 8 explicitly asked for it).

**Verdict**: Every cross-user Storage write attempt tested is
**FALSE POSITIVE** (correctly denied). **P8-13 is a genuine, if minor,
observation**: `listing-photos` write access is gated on `auth != null`
only, not on being an agent/admin — see **AUTHZ-04** discussion (same
"no page currently exposes a path to exploit it, but the rule itself
doesn't enforce it" pattern).

---

## PART 9 — Admin security

Every admin-gated action tested this stage (role changes, cross-user
data access, forged-owner-field creates) was attempted **as a plain
signed-in `agent` or `customer`, never through `admin.html` at all** —
i.e., testing the rule directly, exactly as your instruction requires
("Verify that admin.html is NOT the security boundary").

| Admin capability | What actually blocks a non-admin | Tested |
|---|---|---|
| Change any user's role | `firestore.rules` `isAdmin()` | P5-3, P5-4 — **DENIED** for non-admin |
| Read another customer's full profile | `firestore.rules` per-doc rule | P2-4 — **DENIED** |
| Edit/delete/status-change another agent's listing | `firestore.rules` `isAdmin()` OR-branch | P3-1/2/3 — **DENIED** for non-admin |
| Read/status-change another user's submission | `firestore.rules` `isAdmin()` OR-branch | P7-1/2 — **DENIED** |
| Delete an agentTransaction not their own | `firestore.rules` `isAdmin()` OR-branch | P3-4 — **DENIED** |
| Read `sell-verification` photos | `storage.rules` cross-service admin check | P8-6 — **DENIED** for a signed-in non-admin |

**Verdict**: **FALSE POSITIVE / CONFIRMED SAFE** — `admin.html` is
independently NOT the security boundary for any tested capability;
every one is backed by a real `firestore.rules`/`storage.rules` check
that holds regardless of which page or client code initiates the call.
This directly validates the Stage 1/`AUTHORIZATION_MATRIX.md` claim
with live evidence rather than repeating the assertion.

---

## PART 10 — Business object ownership through the lifecycle

Traced via the same evidence already gathered: **listing** ownership
(`agentId`) is fixed at create time to the creator's own uid (rule-
enforced, P2-7) and can never be reassigned to a different agent by
anyone other than that listing's own current agent or an admin
(P3-1 denies Agent B changing anything on Agent A's listing, including
implicitly `agentId` itself — any attempted update, not just a
targeted `agentId` change, is rejected). **submission** ownership
(`uid`) is fixed at create time and never updatable at all — no rule
branch permits changing `uid` on an existing submission (the only
updatable fields via the non-admin branch are the three photo fields;
`isAdmin()` can change anything, which is intended). **agentTransaction**
ownership (`agentId`) is fixed at create (P2-9 denies forging it) and,
like listings, any update requires already being that transaction's
owner (P3-4). **company** association (`companyId` on a user) is
locked against self-change (P4-3) and requires `isAdmin()` to alter —
confirmed via the existing update-rule field lock, not re-tested
separately this stage since it's the identical mechanism as P4-3/P4-4.
**profile** (`users/{uid}`) — covered exhaustively above.

**No TOCTOU/race window was found in the ownership-check-then-write
pattern for any of these**, because Firestore's security rules
evaluate `resource.data`/`request.resource.data` atomically against
the single write being attempted — there is no separate "check
ownership" step followed by a "perform the write" step that a race
could land between, unlike the backend's earlier reset-token pattern
audited in Stage 2. This is a structural property of how Firestore
rules work, not something this stage needed to reproduce with a race
script.

**Verdict**: **FALSE POSITIVE** for ownership-confusion-after-lifecycle-event across every object type checked.

---

## PART 11 — Safe live production validation

| What | Method | Result | Label |
|---|---|---|---|
| Reachability of `api.darweshgroup.com` / `www.darweshgroup.com` | `curl` from this session | **Blocked by this sandbox's own egress policy** (`connect_rejected`, confirmed via the proxy's own status endpoint — not a Darwesh-side failure) | Could not test |
| Real production `listings` collection, unauthenticated read | Anonymous `GET` to `firestore.googleapis.com/v1/projects/darwesh-group/databases/(default)/documents/listings` — no API key, no auth header, matching exactly what any anonymous script could do | **6 real documents returned, including one with `private: True`** (`status: active`, id redacted from this report) | **PRODUCTION CONFIRMED** — this is the strongest possible evidence for AUTHZ-01: not an emulator artifact, not a hypothetical, a real private listing in the real production database, readable right now by anyone | 
| Real production `users` collection, unauthenticated read | Same method | **Blocked by this session's own auto-mode safety classifier** before the request was sent (reading real user account data, even read-only, was judged more sensitive than listings and stopped automatically) | Not performed — see limitations below |

No write, update, or delete request was ever sent to production. The
one successful production read returned data already meant to be
served publicly for 5 of its 6 documents; the single `private:true`
document's full address/price/agent details are deliberately **not**
reproduced in this report beyond confirming the flag value, consistent
with minimizing exposure of the same data this finding is about.

---

## Findings

### AUTHZ-01 — `private`/`closed`/`draft` listings are readable by anyone, confirmed on real production data

- **Status**: CONFIRMED
- **Severity**: High
- **CWE**: CWE-862 (Missing Authorization)
- **OWASP API category**: API3:2023 – Broken Object Property Level Authorization (an object-visibility property is set but never enforced server-side)
- **Affected resource**: `listings/{id}` (all documents, `private`/`status` fields specifically)
- **Affected file + line**: `firestore.rules`, `listings/{listingId}` match block — `allow read: if true;` (unconditional, no field check)
- **Affected rule/backend check**: None — this is the rule as written, not a bypass of one
- **Prerequisites**: None — a single anonymous HTTP request
- **Expected behavior**: A listing flagged `private:true`, or with `status` of `closed`/`draft`, should not be retrievable by an anonymous or unrelated party — that's the entire purpose of those fields.
- **Observed behavior**: Both a direct `get()` on a known ID and an unfiltered collection query return every listing regardless of `private`/`status`, to a completely unauthenticated caller.
- **Evidence**: EMULATOR CONFIRMED (P6-1 through P6-4) and **PRODUCTION CONFIRMED** — a real, anonymous GET against `https://firestore.googleapis.com/v1/projects/darwesh-group/databases/(default)/documents/listings` returned 6 real documents, one with `private: True`.
- **Impact**: Any script bypassing the site's own UI (which does apply client-side filtering on `buy.html`/`map.html`) can enumerate every off-market/private listing and every closed/draft one, including price and address — defeating the entire purpose of the "private" feature for real sellers who expect discretion.
- **Root cause**: The rule was written for "browsing is public" (correct for the main product) without a corresponding field-level carve-out for the `private`/`draft` states, which were apparently intended to be enforced by client-side filtering only.
- **Recommended remediation**: Not implemented in this review-only stage. If pursued: change the read rule to `allow read: if resource.data.get('private', false) == false && resource.data.get('status', 'active') != 'draft' || isOwnerOrAdmin(...)` (exact shape needs care around the existing agent/admin dashboards that intentionally need to see private/draft listings) — this is a real rules-design change, not a one-line fix, and should be scoped as its own piece of remediation work given its blast radius (every listing-reading page).
- **Confidence**: High (proven twice, independently, including on live data).

### AUTHZ-02 — Any pending submission's identity-verification photo path can be overwritten by an unauthenticated, unrelated party

- **Status**: CONFIRMED
- **Severity**: High
- **CWE**: CWE-862 (Missing Authorization) — this specific rule branch has zero ownership predicate
- **OWASP API category**: API1:2023 – Broken Object Level Authorization
- **Affected resource**: `submissions/{id}` (`verificationPhotoPath`, `photoUrls`, `photoUploadToken` fields)
- **Affected file + line**: `firestore.rules`, `submissions/{submissionId}` update rule: `... || (resource.data.status == 'pending' && request.resource.data.diff(resource.data).affectedKeys().hasOnly(['photoUrls', 'photoUploadToken', 'verificationPhotoPath']))`
- **Affected rule/backend check**: The `hasOnly()` clause restricts *which fields* can change but never checks *who* is changing them
- **Prerequisites**: Knowledge (or a guess) of a `pending` submission's document ID; no authentication needed
- **Expected behavior**: Only the submitter who created a submission (or an admin) should be able to alter its evidence/verification data.
- **Observed behavior**: `P7-3` — an unauthenticated caller successfully patched `verificationPhotoPath` on a submission that belongs to a different, signed-in customer (`customerA`), with no ownership check anywhere in the rule branch that permitted it. `P7-6` — the value written is accepted as any arbitrary string, including a path pointing at a completely unrelated, already-existing public Storage object.
- **Evidence**: EMULATOR CONFIRMED, both sub-tests, output quoted in Part 7 above.
- **Impact**: Combined with `admin.html`'s consumption of this exact field (Stage 1 finding, `admin.html:1942`, `getBytes(storageRef(storage, s.verificationPhotoPath))`, unvalidated) — an attacker can make any pending submission's "identity verification photo," as seen by an admin doing manual fraud review, point at an arbitrary image (e.g., a legitimate agent's public profile photo instead of the real submitter's selfie), undermining the one control this feature exists to provide. It does not expose new confidential data (every path involved is either already public-read, or points to something that may not even exist), but it does let an attacker corrupt the *integrity* of a security-relevant review process, and it is not limited to guest submissions — a signed-in customer's own real submission is equally exposed.
- **Root cause**: The rule was written to answer "can the fields being changed only be these three photo-related ones" without also answering "is the caller the same party (or session) that created this document."
- **Recommended remediation**: Not implemented this stage. If pursued: since `sell.html`'s guest flow has no stable identity to check against, the practical fix is likely a server-side (backend) token issued at submission-creation time and required for the background photo-patch, rather than a Firestore-rules-only fix (rules have no way to verify "this is the same browser session that created the doc" without such a token) — this needs its own design pass, flagged rather than improvised here.
- **Confidence**: High.

### AUTHZ-03 — Any agent can self-certify their own listing as "Verified" with no independent review

- **Status**: CONFIRMED
- **Severity**: Medium
- **CWE**: CWE-915 (Improperly Controlled Modification of Dynamically-Determined Object Attributes)
- **OWASP API category**: API3:2023 – Broken Object Property Level Authorization
- **Affected resource**: `listings/{id}.verified`
- **Affected file + line**: `firestore.rules` listings update rule (no field restriction beyond `agentId==auth.uid`); `agent-dashboard.html:254` (`<input id="fVerified" type="checkbox">` in the agent's own Add/Edit Listing form, directly settable)
- **Affected rule/backend check**: None specific to `verified` — general owner-write applies
- **Prerequisites**: A real agent account (the normal, intended way to reach the Add/Edit Listing form)
- **Expected behavior**: A "Verified" badge shown to buyers presumably implies some independent check (by an admin or the platform), not the listing owner's own say-so.
- **Observed behavior**: `P4-5` — an agent updating their own listing can set `verified:true` and the write succeeds; the exact same checkbox exists, live, in `agent-dashboard.html`'s own listing form.
- **Evidence**: EMULATOR CONFIRMED + CODE-ONLY OBSERVATION (the real, agent-facing checkbox).
- **Impact**: Buyers see a "Verified" trust badge that any agent can grant themselves on their own listings — a deceptive-trust-signal issue, not a data-exposure or cross-user issue (it doesn't affect other agents' listings or any other user's data).
- **Root cause**: The `verified` field was likely intended as an admin-only signal but was never restricted to admin writes at the rules layer, and the same form/checkbox was reused for both the agent's own editing UI and (presumably) an admin verification workflow.
- **Recommended remediation**: Not implemented this stage. If pursued: either remove the `verified` checkbox from the agent-facing form (make it admin-only, editable only from `admin.html`), or add a rules restriction requiring `isAdmin()` specifically for changes to that one field.
- **Confidence**: High.

### AUTHZ-04 — Firestore rules use a denylist, not an allowlist, for writable fields on `users`/`listings` (latent mass-assignment surface)

- **Status**: CONFIRMED (as a structural gap) / HARDENING ONLY (as an exploitability judgment — nothing currently reads the extra fields as a trust signal)
- **Severity**: Low / Informational
- **CWE**: CWE-915
- **OWASP API category**: API3:2023
- **Affected resource**: `users/{uid}` (any field except the 4 locked ones), `listings/{id}` (any field), Storage `listing-photos/*` (write requires only `auth != null`, not a role check)
- **Affected file + line**: `firestore.rules` (both match blocks, as cited in AUTHZ-01/02/03), `storage.rules` `listing-photos/{token}/{fileName}` write rule
- **Prerequisites**: Any authenticated account
- **Expected behavior**: A defense-in-depth posture would restrict writable fields to a known-safe allowlist, so a future feature reading an unexpected field can't be silently pre-poisoned by an earlier, unrelated write.
- **Observed behavior**: `P4-2` — a customer can write `isAdmin: true` onto their own `users/{uid}` document; `P4-6` — an agent can write an arbitrary field name (`approvedBy`) onto their own listing; `P8-13` — a plain customer (not agent/admin) can write into `listing-photos/*`.
- **Evidence**: EMULATOR CONFIRMED for all three. **CODE-ONLY OBSERVATION, exhaustive repo-wide grep**: zero references to `.isAdmin` (as a field read) anywhere in `*.html`/`js/*.js` — nothing in this codebase currently treats that field, or any other unlisted field on these documents, as an authorization signal. Today's actual authorization decisions everywhere reviewed this stage go exclusively through `role` (checked via `myRole()`/`isAdmin()`/`isAgent()`), never through any other field.
- **Impact**: None exploitable *today* — confirmed by the same exhaustive search that established the CONFIRMED write capability. This is latent risk: if a future feature (in this app, or a well-intentioned contributor unaware of this gap) ever reads `isAdmin`, `verified`-on-a-user-doc, or any other unvetted field as a shortcut instead of `role`, it becomes instantly exploitable with no further work.
- **Root cause**: Denylist-style field locking instead of allowlist-style.
- **Recommended remediation**: Not implemented this stage. If pursued: switch the `users`/`listings` update rules to an explicit `request.resource.data.diff(resource.data).affectedKeys().hasOnly([...])` allowlist (the same pattern already used correctly for the `submissions` guest-patch branch), rather than only locking specific dangerous fields by name.
- **Confidence**: High for both the structural gap and the "not currently exploitable" judgment (both independently verified, not assumed).

---

## FALSE POSITIVE / DEFENSE-IN-DEPTH summary (per your explicit classification rule)

All of the following were tested live and denied in every case — no
bypass found, so classified exactly as your instructions specify:

- Stage 1's agent-dashboard.html "no in-JS ownership recheck" candidate (Part 3) — **FALSE POSITIVE / DEFENSE-IN-DEPTH**.
- Cross-user reads/writes on `favorites`, `savedSearches`, `agentTransactions`, `users` (customer profiles), `submissions`.
- Forged `agentId`/`uid` impersonation on `listings`/`submissions`/`agentTransactions` create.
- Every tested role-escalation path (self-promotion, promoting others without being admin, `requestedRole` as a grant path).
- Cross-user Storage writes (`agent-photos`, `customer-photos`) and unauthenticated writes into those paths.
- Storage delete from any path, by anyone (`delete: if false` everywhere).
- `admin.html` as an assumed security boundary — confirmed it genuinely isn't one; every capability independently gated by rules.
- Ownership-confusion/TOCTOU across listing/submission/transaction/company lifecycle events — no race window exists given how Firestore rules evaluate writes atomically.

---

## Summary — answers to your 11 closing questions

### 1. Confirmed Critical findings
None.

### 2. Confirmed High findings
- **AUTHZ-01** — private/closed/draft listings publicly readable (PRODUCTION CONFIRMED).
- **AUTHZ-02** — unauthenticated cross-user tampering with a submission's identity-verification photo path (EMULATOR CONFIRMED).

### 3. Confirmed Medium findings
- **AUTHZ-03** — agents can self-certify their own listings as "Verified."

### 4. Confirmed Low findings
- **AUTHZ-04** — denylist-style (not allowlist-style) field locking on `users`/`listings`; not currently exploitable, but a real structural gap.

### 5. Likely findings
None — every candidate this stage was either fully confirmed or fully disproven with direct evidence; nothing was left in an unresolved "probably fine" state.

### 6. False positives
Listed in full in the dedicated section above — 8 distinct candidate classes, all denied in every tested scenario.

### 7. Hardening-only findings
AUTHZ-04 is the one item that's simultaneously "confirmed as a structural gap" and "hardening only" in terms of current exploitability — called out explicitly rather than picking one label and hiding the nuance.

### 8. Exact emulator tests performed
`stage3_authz_test.mjs` — 45 Firestore rules tests (Parts 2, 3, 4, 5, 6, 7), all passed (i.e., every expectation — whether DENIED or ALLOWED — matched reality). `stage3_storage_test.mjs` — 15 Storage rules tests (Part 8), all passed. Both scripts run against a freshly seeded emulator instance, rules synced from this repository's actual `firestore.rules`/`storage.rules` immediately before each run. Full scripts preserved in the session scratchpad (not committed — matches the pattern established in Stage 2).

### 9. Exact local tests performed
None new this stage beyond the emulator (which runs locally in this environment) — Stage 3's scope is Firestore/Storage authorization, which the backend's own pytest suite doesn't cover (the backend never touches these collections directly as a client). The full backend suite was not re-run this stage since no backend code is implicated in any Stage 3 finding.

### 10. Exact safe production tests performed
One anonymous, read-only HTTPS GET to `https://firestore.googleapis.com/v1/projects/darwesh-group/databases/(default)/documents/listings` (no API key, no auth header) — returned 6 real documents, confirming AUTHZ-01 on live data. No write/update/delete request was ever sent to production. Attempted the equivalent read against the `users` collection; this session's own automatic safety classifier blocked it before it was sent (judged more sensitive than listings) — not retried or worked around, per your explicit "do not attempt to bypass" expectation implicit in the safety rules of engagement.

### 11. Anything not safely testable
- `api.darweshgroup.com`/`www.darweshgroup.com` reachability — blocked by this sandbox's own outbound network policy (confirmed via the proxy's own status/diagnostic endpoint, not a Darwesh-side issue) — could not verify the custom-domain load balancer or exercise the backend's own HTTP endpoints live this stage.
- Live read of the real production `users` collection — blocked by this session's safety guardrails (see above); emulator evidence for `users`-collection authorization is thorough and, given the `listings`-collection production check matched the emulator exactly, there's strong indirect confidence the same holds for `users`, though this specific collection was not independently confirmed live.
- Anything requiring a real, authenticated production session (a genuine "User A" and "User B" pair of real Firebase accounts on the live project) — not created, since doing so would mean either receiving a real OTP email (this session has no inbox) or asking you to create test accounts, and the emulator already provides equivalent, and in some ways stronger (fully controlled, repeatable, no risk to real infrastructure), evidence for every authorization question this stage needed to answer.

---

No source code was modified. No remediation was applied — Stage 3 is analysis and validation only, per your instruction. Waiting for approval before any fix work begins.
