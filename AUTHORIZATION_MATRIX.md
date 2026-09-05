# Darwesh Group — Authorization Matrix (Stage 3, Part 1)

Derived from `ATTACK_SURFACE.md` (Stage 1), `firestore.rules`, and
`storage.rules` as they exist today. Verified/updated against live
emulator testing in this stage — see `AUTHORIZATION_SECURITY_REVIEW.md`
for the evidence behind each row's EXPECTED vs. actual result.

## Roles actually supported by this project

Only **three** roles are real, Firestore-rule-enforced roles:
`customer` (default at signup), `agent`, `admin`. Confirmed by reading
every role check in `firestore.rules` (`myRole()`, `isAgent()`,
`isAdmin()`) — no other role string is ever checked or has any
special meaning to the rules engine.

**"company", "office", "lawyer", "engineer", "designer", "cleaner"
are NOT roles or account types anywhere in this codebase.**
`companies/{id}` is a plain data collection (a real-estate agency
record an agent/admin belongs to via `companyId`, not something a user
"is"). `services.html`'s lawyer/engineer/designer/cleaner categories
are a static, hardcoded directory (confirmed in Stage 1) — there is no
Firestore collection, no signup path, no account type, and therefore
**no privilege-escalation surface** for any of these — a normal user
cannot "become" one because the concept doesn't exist as an
authorization primitive in this application. This is stated here as a
factual scope boundary for Part 5, not assumed.

---

## `users/{uid}`

| RESOURCE | ACTION | ROLE | AUTH REQUIRED | OWNER REQUIRED | SERVER/RULE CHECK | CLIENT-SIDE CHECK | EXPECTED RESULT |
|---|---|---|---|---|---|---|---|
| `users/{uid}` | READ (own) | any | Yes | Yes (self) | `isOwner(uid) \|\| isAdmin() \|\| resource.data.role=='agent'` | none needed | Allowed |
| `users/{uid}` | READ (other, role=customer) | any | Yes | No | Same rule — denied unless admin | N/A | **Denied** for a non-owner, non-admin caller |
| `users/{uid}` | READ (other, role=agent) | any (incl. anonymous per rule, though client always requires sign-in) | rule allows even unauthenticated per the `resource.data.role=='agent'` branch | No | Same rule — agent profiles are intentionally public | N/A | Allowed (by design — public agent directory) |
| `users/{uid}` | READ (unfiltered `users` collection query) | admin (UI-gated) | Yes | No | Rule evaluated **per matched document** | `admin.html` gates the UI, not the query itself | A non-admin issuing the identical query gets only their own doc + agent docs back, never full collection |
| `users/{uid}` | CREATE (self, signup) | customer | Yes (new account) | Yes (self) | `isOwner(uid) && role=='customer' && (requestedRole absent OR in ['customer','agent'])` | signup.html backend flow (server-side, see AUTHENTICATION_SECURITY_REVIEW.md) | Allowed only for the caller's own uid, role forced customer |
| `users/{uid}` | UPDATE (own, safe fields) | any | Yes | Yes | `isOwner(uid) && role/companyId/assignedAgentId/requestedRole unchanged` | `account.html` only exposes displayName/photoURL fields | Allowed |
| `users/{uid}` | UPDATE (own `role`/`requestedRole`/`companyId`/`assignedAgentId`) | any | Yes | Yes | Same rule — locked fields | No UI exposes this | **Denied** |
| `users/{uid}` | UPDATE (another user, any field incl. `role`) | admin | Yes | No | `isAdmin()` | `admin.html`'s role `<select>` | Allowed only for admin |
| `users/{uid}` | DELETE | admin | Yes | No | `isAdmin()` | No delete-user UI found | Rule allows; no call site exercises it |
| `users/{uid}/favorites/*`, `/savedSearches/*` | READ/CREATE/UPDATE/DELETE | any | Yes | Yes (self) | `isOwner(uid)` on parent path | Every call site self-scopes | Allowed only for own subcollection |

---

## `listings/{id}`

| RESOURCE | ACTION | ROLE | AUTH REQUIRED | OWNER REQUIRED | SERVER/RULE CHECK | CLIENT-SIDE CHECK | EXPECTED RESULT |
|---|---|---|---|---|---|---|---|
| `listings/{id}` | READ (single doc or full collection) | anyone, incl. anonymous | **No** | No | `allow read: if true` — unconditional, no field-based restriction | None — `private`/`status` filtering, where it exists, is client-side only | **Every listing document, including `private:true` and `status:'closed'`, is readable by anyone who queries the collection directly** (see Part 6 findings) |
| `listings/{id}` | CREATE | agent (self `agentId`/`companyId`) or admin | Yes | Yes (self, for agent) | `isAgent() && agentId==auth.uid && companyId==myCompanyId() \|\| isAdmin()` | `agent-dashboard.html`/`admin.html` forms | A `customer` account is rejected by rule regardless of any client bypass |
| `listings/{id}` | UPDATE (any field incl. price/status/agentId reassignment) | owning agent or admin | Yes | Yes (agent) / No (admin) | `(isAgent() && resource.data.agentId==auth.uid) \|\| isAdmin()` | **None** in `agent-dashboard.html`'s `window.editListing`/`window.toggleListingStatus` before the Firestore call | Agent B calling this against Agent A's listing: **expected denied by rule** — tested this stage |
| `listings/{id}` | DELETE | owning agent or admin | Yes | Yes (agent) / No (admin) | Same as UPDATE | **None** in `window.deleteListing` | Agent B against Agent A's listing: **expected denied by rule** — tested this stage |

---

## `submissions/{id}`

| RESOURCE | ACTION | ROLE | AUTH REQUIRED | OWNER REQUIRED | SERVER/RULE CHECK | CLIENT-SIDE CHECK | EXPECTED RESULT |
|---|---|---|---|---|---|---|---|
| `submissions/{id}` | CREATE | anyone (guest or signed in) | **No** | No | `status=='pending' && type in ['sell','viewing'] && (uid==null \|\| uid==auth.uid)` | `sell.html`/`map.html` forms | Allowed for anyone; a signed-in caller cannot forge someone else's `uid` |
| `submissions/{id}` | READ (own) | signed-in owner | Yes | Yes | `isAdmin() \|\| (isSignedIn() && resource.data.uid==auth.uid)` | `account.html`, `notification-bell.js` | Allowed only for the doc's own `uid` |
| `submissions/{id}` | READ (guest's own, `uid:null`) | guest | N/A | N/A | Rule requires `auth.uid==resource.data.uid`, impossible to satisfy for `null` | N/A | **Structurally unreadable by the guest who created it** — expected/by-design, not a bug |
| `submissions/{id}` | READ (another user's) | signed-in non-owner, non-admin | Yes | No | Same rule | N/A | **Denied** — tested this stage |
| `submissions/{id}` | READ (unfiltered collection) | admin (UI-gated) | Yes | No | Per-document rule eval | `admin.html` | Non-admin issuing the identical query gets nothing back except their own |
| `submissions/{id}` | UPDATE (status) | admin | Yes | No | `isAdmin() \|\| (status=='pending' && diff().affectedKeys().hasOnly(['photoUrls','photoUploadToken','verificationPhotoPath']))` | `admin.html`'s status `<select>` | Non-admin cannot change `status`; can only patch the 3 named photo fields while still `pending` |
| `submissions/{id}` | UPDATE (`verificationPhotoPath` to an arbitrary string) | anyone (same guest/creator session, while pending) | No | No (rule doesn't check `uid` on this branch at all) | `status=='pending' && affectedKeys().hasOnly([...])` — **no check that the caller created this specific doc** | `sell.html`'s background-upload patch | See Part 7 finding — this branch has **no ownership check whatsoever**, not even the creator's own uid; ANY signed-in-or-not caller can patch ANY pending submission's photo fields |
| `submissions/{id}` | DELETE | admin | Yes | No | `isAdmin()` | No delete UI found | Rule allows; not exercised by any page |

---

## `companies/{id}`

| RESOURCE | ACTION | ROLE | AUTH REQUIRED | OWNER REQUIRED | SERVER/RULE CHECK | CLIENT-SIDE CHECK | EXPECTED RESULT |
|---|---|---|---|---|---|---|---|
| `companies/{id}` | READ | any signed-in user | Yes | No | `isSignedIn()` | none | Allowed for any account, any company |
| `companies/{id}` | CREATE | any signed-in user | Yes | No | `isSignedIn() && !exists(...)` (create-if-not-exists) | `signup.html` backend, `admin.html` Add Agent | A `customer` account could create a company doc directly via SDK if it ever wanted to — not gated by role, only by non-existence |
| `companies/{id}` | UPDATE/DELETE | admin | Yes | No | `isAdmin()` | `admin.html` branch-address edit | Non-admin denied |

---

## `agentTransactions/{id}`

| RESOURCE | ACTION | ROLE | AUTH REQUIRED | OWNER REQUIRED | SERVER/RULE CHECK | CLIENT-SIDE CHECK | EXPECTED RESULT |
|---|---|---|---|---|---|---|---|
| `agentTransactions/{id}` | READ | owner or admin | Yes | Yes (agent) | `isOwner(resource.data.agentId) \|\| isAdmin()` | `agent-dashboard.html` self-scoped query | Denied for a non-owning agent |
| `agentTransactions/{id}` | CREATE | agent (self `agentId`) | Yes | Yes (self) | `isAgent() && agentId==auth.uid` | client hardcodes `agentId:currentUid` | A forged `agentId` for another agent is rejected by rule |
| `agentTransactions/{id}` | UPDATE/DELETE | owner or admin | Yes | Yes (agent) / No (admin) | `isOwner(resource.data.agentId) \|\| isAdmin()` | **None** in `window.deleteFinTx(id)` before the call | Agent B against Agent A's transaction: **expected denied by rule** — tested this stage |

---

## `otpChallenges/{key}`, `otpResetTokens/{token}`

| RESOURCE | ACTION | ROLE | AUTH REQUIRED | SERVER/RULE CHECK | EXPECTED RESULT |
|---|---|---|---|---|---|
| Both | ALL | N/A | N/A | `allow read, write: if false` unconditional | Denied to every client, always — only reachable via the backend's Admin SDK (bypasses rules entirely) |

---

## Cloud Storage

| PATH | PUBLIC READ | AUTH READ | OWNER READ | PUBLIC WRITE | AUTH WRITE | OWNER WRITE | EXPECTED RESULT |
|---|---|---|---|---|---|---|---|
| `sell-submissions/{token}/{file}` | Yes | — | — | Yes (any file `<10MB`, `image/*`) | — | — | Fully public read+write, size/type-bounded only |
| `sell-verification/{token}/{file}` | **No** | **No** | — (admin-only, not owner-only) | Yes (same bounds) | — | — | Read requires `role=='admin'` via cross-service `firestore.get()`; write remains public (guest flow) |
| `listing-photos/{token}/{file}` | Yes | — | — | No | Yes (any signed-in user, not role-gated) | — | Read public; write requires only `auth != null`, not agent/admin role |
| `agent-photos/{uid}/{file}` | Yes | — | — | No | No | Yes (`auth.uid==uid`) | Read public; write strictly self-scoped |
| `customer-photos/{uid}/{file}` | Yes | — | — | No | No | Yes (`auth.uid==uid`) | Same as agent-photos |

---

## Admin functionality (`admin.html`)

| CAPABILITY | WHAT ACTUALLY BLOCKS A NORMAL USER | CLIENT-SIDE GATE (NOT the boundary) |
|---|---|---|
| View all users | `firestore.rules` per-document read rule | Page redirect on `role!=='admin'` |
| Change any user's role | `firestore.rules` `isAdmin()` on `users/{uid}` update | Role `<select>`, disabled for own row |
| Create/edit/delete any listing | `firestore.rules` `isAdmin()` OR-branch on `listings` | None beyond page redirect |
| View/change submission status | `firestore.rules` `isAdmin()` OR-branch on `submissions` | None beyond page redirect |
| Create/edit companies | `firestore.rules` `isAdmin()` (edit) / any signed-in user can create (see companies table) | None beyond page redirect |
| View `sell-verification` identity photos | `storage.rules`' `isAdmin()` cross-service check | None beyond page redirect |
| Add Agent (create + promote a new account) | `firestore.rules`: self-create at `role:'customer'` only, then `isAdmin()` for the promotion `updateDoc` | Page redirect; the flow itself runs under the *admin's own* authenticated session for the promotion step |

**`admin.html` is confirmed NOT the security boundary for any of the above** — every capability listed has an independent `firestore.rules`/`storage.rules` check that does not depend on which page or button initiated the call. This matches the Stage 1 finding and is the premise this stage tests empirically rather than re-asserts.

---

*This matrix is cross-referenced throughout `AUTHORIZATION_SECURITY_REVIEW.md`; rows marked "tested this stage" have direct emulator evidence cited there, not just rule-reading.*
