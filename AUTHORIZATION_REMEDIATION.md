# Authorization Remediation — AUTHZ-01 through AUTHZ-04

Remediation of the 4 confirmed findings in `AUTHORIZATION_SECURITY_REVIEW.md`,
in the priority order requested. Stage 4 (business logic attacks review)
was explicitly **not** started — this document covers remediation only.

All changes were validated against the Firebase emulator suite (Firestore
+ Storage) before being committed. No production Firestore data was read,
written, or modified during this work.

**Update**: `firestore.rules` has since been published to the live
`darwesh-group` Firebase project (by the user, via the Firebase Console —
this session has no deploy credentials). Production verification of
AUTHZ-01 was performed after that publish — see **Production
verification** at the bottom, which replaces the earlier "not yet run"
note.

---

## AUTHZ-01 — Private/closed/draft listings readable anonymously

**Severity**: High · **Status**: FIXED

### Files changed
- `firestore.rules` — `listings/{listingId}` match block
- `map.html` — `loadListings()`
- `buy.html` — `loadListings()`
- `index.html` — `loadCityApartmentCounts()`, `loadFeaturedListings()`
- `agent-dashboard.html` — `loadTeamListings()`, `renderAgentTeamMap()`

### Old security behavior
`allow read: if true;` — completely unconditional. Any anonymous request,
via `get()` on a known ID or an unfiltered `list()` query, returned every
listing regardless of `private`/`status`. Proven on real production data
(Stage 3): an anonymous REST read of `darwesh-group`'s `listings`
collection returned a real `private:true` document.

Separately (discovered during this remediation, not previously
documented as its own finding, but the same root cause): `buy.html` and
`index.html`'s own normal UI — not just a bypass of it — never filtered
by `private` at all client-side either, so a private listing's full
details (price, address, beds/baths) were shown on the public Buy page
and homepage to any ordinary visitor, no bypass required.

### New security behavior
```
function isListingPubliclyVisible() {
  return resource.data.private == false
      && resource.data.status == 'active';
}
function isListingOwnerOrAdmin() {
  return isAdmin() || (isAgent() && resource.data.agentId == request.auth.uid);
}
match /listings/{listingId} {
  allow get, list: if isListingPubliclyVisible() || isListingOwnerOrAdmin();
  ...
}
```
Per your explicit decision (**"Deny get() and list() both, as literally
specified"**), this denies both a direct `get()` and a `list()` query for
any private/closed/draft listing to anyone who is neither the listing's
own agent nor an admin — including a signed-in but unrelated user.

A public page must now query with
`where('private','==',false), where('status','==','active')`; an
unconstrained or partially-constrained query is **rejected outright**,
not silently filtered — this is a real Firestore/Firestore-emulator
behavior, verified empirically (see "Load-bearing implementation detail"
below), not assumed from documentation alone.

### Load-bearing implementation detail: `.get(field, default)` defeats list-query provability
The first rule draft used `resource.data.get('private', false)` (a
safe-default accessor, to tolerate a listing document that might not yet
have the field). Testing against a fresh Firestore emulator instance
showed this was actively dangerous: it correctly denied a direct `get()`
on a private listing, but an **unfiltered anonymous `list()` query still
succeeded and returned every listing, including private ones** — the
exact leak this fix exists to close, reintroduced by the accessor
pattern itself. An isolated, minimal reproduction (a second, throwaway
emulator instance with a 2-field ruleset) confirmed this precisely:
plain dot-access (`resource.data.private`) makes Firestore's list-query
provability analysis work correctly (unconstrained query → denied
outright; a query missing one of two required conditions → denied;
both conditions present in the query → succeeds, returns only matching
docs); `.get(field, default)` silently disables that analysis for `list`
requests specifically, while still working correctly for `get()`. The
final rule uses plain dot-access, and requires `private` and `status`
to be present on every newly-created listing (`'private' in
request.resource.data && 'status' in request.resource.data` added to
the create rule) so this can never regress for new data. A pre-existing
listing document that somehow lacks either field would fail closed (not
readable by the public or other agents) rather than leak — see
**Remaining risk**.

### Frontend changes
- `map.html`: `loadListings()` now queries with both `where()` clauses.
  The existing "reveal private listing on click" UI (`isPrivateHidden()`,
  `revealListing()`, the `cityBadgeIcon` aggregation) is left in place
  unmodified but is now naturally unreachable for a public visitor: since
  the anonymous query can never return a private listing's data at all,
  `l.private` is never `true` for anything in `LISTINGS`, so the
  blurred-card/reveal-button code path simply never triggers. This is a
  real, intentional behavior change: a private listing's existence and
  approximate location are no longer discoverable at all by an
  anonymous or unrelated visitor, not even in aggregate. This was
  explicitly your choice (Option B) after I flagged the conflict with
  this file's original design.
- `buy.html`, `index.html`: same two `where()` clauses added; the
  redundant client-side `status !== 'closed'` filtering was removed
  (now guaranteed server-side).
- `agent-dashboard.html`: `loadTeamListings()` and `renderAgentTeamMap()`
  (Team Map — previously showed a teammate's private listing at its real
  coordinates) each split into two queries — the company's public+active
  listings, plus the viewer's own listings regardless of visibility —
  merged client-side. **Behavior change**: a colleague's private listing
  no longer appears to teammates at all (on the Team Listings table or
  the Team Map), only to its own agent or an admin. A listing predating
  the `companyId` field (no such field at all) can no longer be matched
  by an equality `where()` clause and so won't appear in the team view
  unless it's also the viewer's own — a legacy-data display gap, not a
  security concern.
- **Found after the initial commit, while confirming "does any other
  frontend query need updating" post-deployment**: four more unfiltered
  `listings` fetches existed outside the original edit scope —
  `services.html` and `mam-ai.html` (both public pages, same
  `where('private','==',false), where('status','==','active'))` fix as
  `buy.html`/`index.html`), `sell.html`'s MAM AI Valuation feature
  (comparable-listings average, same fix), and `account.html`'s "My
  Assigned Agent" listings grid, which queried only
  `where('agentId','==', assignedAgentId)` — not enough on its own to
  satisfy either rule branch for a customer viewing their agent's
  listings, so this query would have been **rejected outright** in
  production (not merely returning stale data) until fixed; it now also
  constrains `private==false`/`status=='active'`, narrowing correctly to
  the agent's public active listings. `admin.html`'s several unfiltered
  `listings` fetches were checked and confirmed to still work correctly
  — `isAdmin()` doesn't depend on `resource.data`, so an authenticated
  admin's unfiltered query is provably safe regardless of contents;
  verified empirically against the emulator (admin unfiltered query
  returned all 3 seeded listings, private/closed included), and
  `admin.html` itself gates every page load on `profile.role === 'admin'`
  before any of these calls can run.

### Tests added (`stage3_authz_test.mjs`, Part 6)
`P6-1`–`P6-3` (get on private/closed/draft, anonymous → DENIED),
`P6-4` (unfiltered query → DENIED outright), `P6-5` (query missing one
of two required `where()` clauses → DENIED), `P6-6` (correctly-filtered
query → ALLOWED, returns exactly the public listing), `P6-7` (non-owner
authenticated agent, get on private → DENIED), `P6-8` (owner agent →
ALLOWED), `P6-9` (admin → ALLOWED), `P6-10` (anonymous get on the public
listing → ALLOWED, regression guard), `P6-11` (agent's own
`where('agentId','==',...)` query, the real `loadMyListings()` shape →
ALLOWED, includes their own private/closed/draft).

### Test results
`stage3_authz_test.mjs`: all Part 6 tests pass (11/11). Full suite:
65/65 passing.

### Deployment required
Yes — `firestore.rules` must be published to the live `darwesh-group`
Firebase project. Not performed by this session; see **Deployment**.

### Remaining risk
- A production `listings` document that predates this fix and somehow
  lacks `private` or `status` entirely (never confirmed to exist, but
  not ruled out either — see Production Verification) would become
  invisible to the public and to other agents until an admin or its own
  agent edits it. This fails closed (safe), not open, but is worth a
  one-time data audit if you want to confirm no such document exists.
- The "reveal private listing" feature on `map.html` is now, in effect,
  fully retired for anonymous/unrelated visitors — if that's a bigger
  product change than intended, it needs a follow-up product decision
  (e.g., a real backend endpoint that logs/rate-limits reveals instead
  of relying on client-side Firestore reads), not a rules tweak.

---

## AUTHZ-02 — Verification photo path overwritable by unrelated party

**Severity**: High · **Status**: FIXED

### Files changed
- `firestore.rules` — `submissions/{submissionId}` update rule, new
  `submissions/{submissionId}/verification/{token}` subcollection
- `sell.html` — verification photo upload/attach flow
- `admin.html` — `renderVerificationPhotoArea()`

### Old security behavior
```
allow update: if isAdmin()
              || (resource.data.status == 'pending'
                  && request.resource.data.diff(resource.data).affectedKeys()
                       .hasOnly(['photoUrls', 'photoUploadToken', 'verificationPhotoPath']));
```
Zero ownership check on this branch — any caller, authenticated or not,
related or not, could patch `verificationPhotoPath` on any pending
submission to point at an arbitrary Storage path, corrupting the
integrity of `admin.html`'s manual identity-verification review.

### New security behavior
`verificationPhotoPath` was removed from the allowed-fields list
entirely — it's no longer patchable via `submissions/{id}` at all,
by anyone. In its place, a new subcollection:
```
match /verification/{token} {
  allow read: if isAdmin();
  allow write: if token == get(/databases/$(database)/documents/submissions/$(submissionId)).data.get('photoUploadToken', null)
                && get(/databases/$(database)/documents/submissions/$(submissionId)).data.status == 'pending'
                && request.resource.data.keys().hasOnly(['path', 'setAt']);
  allow delete: if isAdmin();
}
```
The caller must supply the submission's own `photoUploadToken` (already
generated client-side per submission, via `crypto.randomUUID()`) as the
**document ID itself**, not as a field value.

### Why a plain "resend the token unchanged" field check was rejected
An earlier design considered requiring a resent token *field* to match
the stored one. This is unsound in Firestore Rules: `updateDoc` performs
a partial merge, and an **omitted** field is treated as unchanged for
`diff()`/equality purposes — an attacker who never mentions the field at
all trivially "matches" it without ever knowing its real value. A
document path segment has no such escape hatch: the request must target
the exact correct subcollection document ID or it doesn't match any
permitted write at all. This also avoids inventing a new backend
endpoint (no deployment credentials available in this session, and a new
Cloud Run dependency would be a materially larger change than the
finding warrants) — it reuses the `photoUploadToken` field the app
already generates and sends today.

### Frontend changes
- `sell.html`: `verificationPhotoPath` removed from both the initial
  `addDoc` payload and the background `updateDoc` patch. A new
  `attachVerificationPhoto(path)` helper writes
  `submissions/{id}/verification/{photoUploadToken}` with
  `{ path, setAt: serverTimestamp() }`, called right after the
  submission document is created (if the selfie upload already
  finished) and again from the background-patch path if it finishes
  later. The guest submission flow otherwise works exactly as before —
  no new fields required from the user, no new round-trip they'd notice.
- `admin.html`: `renderVerificationPhotoArea()` now gates on
  `s.photoUploadToken` (not `s.verificationPhotoPath`), and on "View
  Verification Photo" click, first reads
  `submissions/{id}/verification/{token}` (admin-only per the rule
  above) to get the real Storage path, then fetches the image bytes as
  before.

### Tests added (`stage3_authz_test.mjs`, Parts 7 & 9)
`P7-3` (updated: anonymous cross-user `verificationPhotoPath` patch →
now DENIED, field no longer writable at all). `P9-1` (legitimate guest
flow, correct token → ALLOWED), `P9-2` (unrelated anonymous caller,
wrong token → DENIED), `P9-3` (different authenticated user, wrong token
→ DENIED), `P9-4` (correct token on a signed-in-owner's submission →
ALLOWED — token knowledge is the capability, not identity, matching the
guest-compatible design), `P9-5` (admin read → ALLOWED), `P9-6`
(non-admin read, including the legitimate writer — → DENIED, read stays
admin/reviewer-only), `P9-7` (replay after the submission left `pending`
→ DENIED even with the correct token), `P9-8` (extra field injection →
DENIED).

### Test results
All Part 7 + Part 9 tests pass. Full suite: 65/65 passing.

### Deployment required
Yes — same `firestore.rules` publish as AUTHZ-01 (single file, single
deploy covers all four findings).

### Remaining risk
None identified for the fixed mechanism itself. Note the create rule for
`submissions/{id}` still has no field-shape validation at all (a guest
can still set arbitrary fields at creation, since that's their own new
document) — this is unchanged, pre-existing, out of scope for this
finding, and not a new gap introduced here.

---

## AUTHZ-03 — Agent can self-certify own listing as Verified

**Severity**: Medium · **Status**: FIXED

### Files changed
- `firestore.rules` — `listings/{listingId}` create and update rules
- `agent-dashboard.html` — Add/Edit Listing form

### Old security behavior
No restriction on the `verified` field beyond the general
`agentId == auth.uid` ownership check — an agent could set `verified:true`
on their own listing at create or update time via the live `fVerified`
checkbox in their own dashboard form.

### New security behavior
```
allow create: if isAdmin()
              || (isAgent()
                    && ...
                    && request.resource.data.get('verified', false) == false
                    && 'private' in request.resource.data
                    && 'status' in request.resource.data
                    && request.resource.data.keys().hasOnly([... no 'verified' ...]));

allow update: if isAdmin()
              || (isAgent()
                    && resource.data.agentId == request.auth.uid
                    && request.resource.data.get('verified', false) == resource.data.get('verified', false)
                    && request.resource.data.diff(resource.data).affectedKeys().hasOnly([... no 'verified' ...]));
```
An agent's create request fails outright if it tries to set
`verified:true` (not silently ignored). An agent's update request fails
outright if it changes `verified` at all, in either direction — only
`isAdmin()`'s unrestricted branch can flip it. This is enforced in
`firestore.rules`, not merely in the UI.

### Frontend changes
`agent-dashboard.html`: the `fVerified` checkbox and all 3 JS references
to it (the HTML input, the save-payload read, the edit-form populate)
were **removed**, not merely hidden — per your explicit instruction not
to rely only on hiding the control. An agent's save payload no longer
includes `verified` at all, so ordinary edits are unaffected by the new
rule (nothing in a normal save collides with the "must stay unchanged"
check).

### Tests added (`stage3_authz_test.mjs`, Parts 4 & 10)
`P4-5` (updated: agent sets `verified:true` on own listing → now
DENIED). `P10-1` (agent create, verified omitted → ALLOWED), `P10-2`
(agent create, `verified:true` → DENIED even at creation), `P10-3`
(agent edits a normal field → ALLOWED, regression guard), `P10-4` (agent
sets `verified:true` on existing listing → DENIED), `P10-5` (agent
re-sends `verified:false` unchanged from its actual stored value →
ALLOWED — only a real change is blocked), `P10-6` (admin sets
`verified:true` → ALLOWED, the only legitimate path).

### Test results
All Part 4 + Part 10 tests pass. Full suite: 65/65 passing.

### Deployment required
Yes — same `firestore.rules` publish as AUTHZ-01/02.

### Remaining risk
None identified. The only remaining path to `verified:true` is an
admin write, matching the intended trust model.

---

## AUTHZ-04 — Denylist instead of allowlist for `users`/`listings` writable fields

**Severity**: Low / structural hardening · **Status**: FIXED for `users`/`listings` Firestore rules (the two resources this pass was scoped to)

### Files changed
- `firestore.rules` — `users/{uid}` update rule, `listings/{listingId}` create/update rules

### Old security behavior
Both rules only blocked specific named dangerous fields
(`role`/`companyId`/`assignedAgentId`/`requestedRole` on `users`;
nothing at all on `listings` beyond ownership) — any other field name,
known or not-yet-meaningful, could be written by any authenticated
owner. Confirmed not currently exploitable (nothing in the app reads an
unlisted field, e.g. `isAdmin`, as an authorization signal), but latent.

### New security behavior
```
// users/{uid} update
request.resource.data.diff(resource.data).affectedKeys().hasOnly(['displayName', 'photoURL'])

// listings/{listingId} create
request.resource.data.keys().hasOnly([
  'title', 'address', 'city', 'lat', 'lng', 'dealType', 'propertyType',
  'price', 'beds', 'baths', 'sqft', 'img', 'amenities', 'private',
  'agentId', 'agentName', 'companyId', 'status', 'createdAt'
])

// listings/{listingId} update
request.resource.data.diff(resource.data).affectedKeys().hasOnly([
  'title', 'address', 'city', 'lat', 'lng', 'dealType', 'propertyType',
  'price', 'beds', 'baths', 'sqft', 'img', 'amenities', 'private',
  'status', 'agentId', 'agentName', 'companyId', 'updatedAt'
])
```
Every allowlist was derived from grepping the actual save payloads in
`agent-dashboard.html`/`admin.html` (not guessed), and explicitly
excludes `verified` (AUTHZ-03) and every field named in your original
"protect at least" list (`role`, `isAdmin`, `admin`, `permissions`,
`verified`, `approved`, `status`-where-privileged, owner identity,
verification-authority fields) beyond what each resource's own
legitimate write flow already needs.

`agentId`/`agentName`/`companyId` were deliberately kept in the
`listings` **update** allowlist (not further restricted) — the outer
`resource.data.agentId == request.auth.uid` condition already means
their value can never actually change through the agent-update branch,
and locking them out of the diff allowlist too would risk breaking a
legitimate edit if a client ever resent a stale-but-matching value for
one of them.

### Frontend changes
None required — every allowlisted field set was derived from what the
real save code already sends, so no legitimate save was narrowed.

### Tests added / updated (`stage3_authz_test.mjs`, Part 4)
`P4-2` (updated: unknown-field injection on `users/{uid}` → now
DENIED), `P4-6` (updated: unknown-field injection on `listings/{id}` →
now DENIED).

### Test results
Both tests pass. Full suite: 65/65 passing.

### Deployment required
Yes — same `firestore.rules` publish as AUTHZ-01/02/03.

### Remaining risk
- **Storage `listing-photos/*`** write rule (any signed-in user, not
  role-gated) was named in the original finding but is a *Storage*
  rule, not a `users`/`listings` *Firestore* rule, and was explicitly
  out of this remediation's scope (your instructions named
  `firestore.rules`/`storage.rules` "if changed" for the 4 prioritized
  findings, and this specific gap wasn't one of the 4). It remains open.
- The `listings` create rule's allowlist does not (and cannot, at the
  rules layer alone) validate the *values* of most fields (e.g. `price`
  being a sane number) — only which field *names* may be present. This
  matches the original finding's scope (mass assignment / field
  presence), not a value-validation finding.

---

## Combined test totals

| Suite | Before this remediation | After |
|---|---|---|
| `stage3_authz_test.mjs` (Firestore, Stage 3 + this pass) | 45 | **65** (20 new: `P6-6`–`P6-11`, `P9-1`–`P9-8`, `P10-1`–`P10-6`; `P4-2`, `P4-5`, `P4-6`, `P6-1`–`P6-5`, `P7-3` expectations flipped to match new correct behavior, none deleted) |
| `stage3_storage_test.mjs` (Storage, Stage 3) | 15 | 15 (unchanged — `storage.rules` not modified this pass) |
| `rules_test.mjs` (earlier audit phase) | 14 | 14 (unchanged, still passing) |
| `otp_rules_test.mjs` (earlier audit phase) | 5 | 5 (unchanged, still passing) |
| Backend `pytest` (`backend/tests`) | 135 | **135** (unchanged — this remediation touched no backend/Python code) |

All suites green: **65 + 15 + 14 + 5 = 99 Firestore/Storage emulator
tests, 135 backend tests, 0 failures.**

---

## Deployment

**Performed by the user**, via the Firebase Console (this session has no
Firebase CLI/`gcloud`/service-account credentials and cannot deploy
directly). `storage.rules` was **not** changed this pass — no Storage
deployment was needed or performed.

## Production verification (read-only, anonymous, safe — performed)

Run after the user confirmed the publish was complete. No write, no auth
token, no sensitive collection touched; all three checks are the exact
methods specified for this validation.

**1. Unfiltered anonymous collection query** —
`GET https://firestore.googleapis.com/v1/projects/darwesh-group/databases/(default)/documents/listings`
→ **`403 PERMISSION_DENIED`** (`"Missing or insufficient permissions."`).
The entire query is now rejected outright, not silently filtered —
matches the intended list-query-provability behavior exactly.

**2. Direct `get()` on the specific listing previously confirmed
`private:true`** (id `bguFdoO8NpbT4C0tK73k`, live in production) —
`GET .../listings/bguFdoO8NpbT4C0tK73k` → **`403 PERMISSION_DENIED`**.
The same document that was freely anonymously readable before deployment
is now denied.

**3. Correctly-filtered public query** (`private == false AND status ==
"active"`, via `:runQuery` with a `StructuredQuery` — read-only, no data
modified) → **`200 OK`, 5 documents returned**, all with
`private:false`/`status:"active"`; `bguFdoO8NpbT4C0tK73k` is **not**
among them. This is the same 5 public listings that were already visible
before deployment (production has 6 listings total: 5 public + the 1
private one) — legitimate public browsing is fully intact.

**Verdict: AUTHZ-01 is FIXED in production.** Both the collection-query
leak and the direct-get leak are closed, and legitimate public listing
reads are unaffected — all three of this validation's pass conditions
are met.

### Frontend queries that needed updating for the stricter rules
Already fixed in this same commit, discovered via a full repo sweep
prompted by this question (see the AUTHZ-01 "Frontend changes" section
above for the complete list and reasoning): `map.html`, `buy.html`,
`index.html`, `services.html`, `mam-ai.html`, `sell.html` (valuation
feature), `account.html`, and `agent-dashboard.html`'s two team-scoped
queries. `admin.html`'s several unfiltered `listings` fetches were
checked and confirmed to need no change (admin's unfiltered query is
provably safe under the rule, verified empirically against the
emulator, and the whole page is gated on `role === 'admin'` before any
of these can run). No further frontend query changes are needed.
