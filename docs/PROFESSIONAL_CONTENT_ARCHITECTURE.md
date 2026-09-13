# Professional Content Architecture — Phase P1 (Audit + Contract)

Architecture-first step for the Professional Portfolio / Post system, per
the Phase P1 kickoff instructions ("DO NOT blindly implement this schema.
FIRST audit... Then propose the smallest safe additive schema").

**Nothing in this document has been applied to `firestore.rules` or
`storage.rules`.** No production rule changes, no Storage rule changes, no
new collection has been written to in production. This is the proposal to
review before any of that happens. Everything below is additive to what
already exists — nothing already shipped (companies/organizations/
serviceProviders/listings/products, or any existing rule) is renamed,
narrowed, or reinterpreted.

Written against `claude/web-project-hqdo8o` at the commit immediately
before this phase (`2bf1a46`).

---

## 1. Audit findings

### 1.1 Designer profile (current implementation)

`designer.html` + `js/profile-role.js` (`initServiceProviderProfile`,
built in the prior phase) render a single Firestore document —
`serviceProviders/{uid}` — through four tabs: Overview / Portfolio /
Services / Contact. There is no separate "post" or "project" entity: the
Portfolio tab (`renderProjects()` in `js/profile-role.js`) reads the
*document's own* `portfolio` array field directly and renders each array
element as a card. There is:

- **No per-item id.** An item is an array index, not an addressable
  document — nothing can deep-link to "this one project," only to the
  whole profile.
- **No per-item ownership/audit trail, no per-item `createdAt`.** The
  array has one `updatedAt` for the whole document; adding a tenth
  project touches the same timestamp as editing the bio.
- **No category, location, date, or video per item** — only
  `{imageUrl, caption, beforeImageUrl?}` (see 1.2).
- **No cross-document discovery path.** Firestore cannot efficiently
  query "the newest project across every designer" out of an array
  nested inside N separate profile documents — there is no way to build
  a Design Discovery feed on top of this field without reading every
  `serviceProviders` document and flattening client-side, which doesn't
  paginate and doesn't scale past a handful of providers.

This confirms the brief's own diagnosis: the current profile is
information-card-first, and the `portfolio` field is a profile-summary
attachment, not a first-class, independently discoverable, independently
addressable content type. It cannot become the two-place discovery
experience (Design section browse + individual project link) requested
without a new, flat, queryable collection.

### 1.2 `serviceProviders` schema (`firestore.rules:831-906`)

Full current create-time allowlist:

```
serviceType, providerType, ownerId, displayName, companyName,
photoOrLogoUrl, description, city, district, serviceAreas,
experienceYears, specialties, servicesOffered, portfolio, teamSize,
availableDays, availableHours, pricingModel, verified, createdAt,
updatedAt
```

`ownerId` is create-time-set-to-`request.auth.uid` and then **locked for
every subsequent client write, including admin** (same
backend-mediated-ownership-transfer posture as `organizations.ownerId`
and `companies.ownerId`). `verified` is create-time-forced-`false` and
then update-locked to its current value under the owner's own branch —
only `isAdmin()` can flip it (`request.resource.data.get('verified',
false) == resource.data.get('verified', false)` inside the non-admin
branch). `serviceType`/`providerType` are locked post-create too.

`providerOwnerId(providerId)` (`firestore.rules:180-184`) already exists
as a reusable cross-reference helper — it's what the existing
`serviceProviders/{id}/requests` subcollection uses to check "does the
caller own the parent provider profile" without trusting anything the
request itself claims. This is the exact primitive the new collection's
ownership check should reuse, not reinvent.

### 1.3 `portfolio` field — confirmed limitations

- Rules-level, the `portfolio` key is only checked for *presence in the
  allowlist* — there is no per-item shape validation (no rule requires
  `imageUrl` to be a string, no rule bounds array length). This was an
  acceptable simplification when the field was profile-summary data;
  it's the wrong foundation for user-generated, individually-addressable
  content.
- No `status` (published/draft/removed) — an item is visible the instant
  it's in the array, with no admin moderation hook at the data level.
- No stable identity: reordering or removing an earlier item shifts every
  later item's effective "index," so nothing durable can reference "item
  3."

### 1.4 Firestore Rules audit — precedent already established

Three existing patterns are the direct template for the new collection,
confirmed by re-reading `firestore.rules` in full this phase:

1. **`products/{productId}`** (`firestore.rules:917+`) — the closest
   existing precedent for "a flat, queryable collection of content items
   owned by a professional entity." `sellerId` is locked on update
   (BL-01 pattern), gated by `isOrgMember(sellerId) &&
   hasOrgPermission(sellerId, 'create_product')`, `status in
   ['available','out_of_stock','hidden','sold_out']`. This is the model
   for status-enum + locked-owner-field + org/permission gating.
2. **`serviceProviders/{id}/requests/{requestId}`** — the model for
   "child content scoped under a specific owner's path so cross-tenant
   leakage requires a rule written *incorrectly*, not merely configured
   incorrectly." Not directly reused here (posts need to be a flat
   top-level collection for cross-provider discovery queries — see
   §4.4) but its `providerOwnerId()` helper is reused directly.
3. **`hasPermission(key)` / KNOWN_PERMISSIONS`** (`backend/app/access/
   constants.py:108-157`) already defines `manage_portfolio` and
   `manage_professional_profile` as known permission keys — **but no
   `rolePermissionDefaults/{accountType}` document exists yet that
   grants either of them to any accountType** (grepped the whole repo
   for a seeding script; none exists). Gating post-creation on
   `hasPermission('manage_portfolio')` alone would, correctly per the
   fail-closed design, currently lock out *every* professional — not a
   bug, just an unfinished rollout step. See §3.2 for how this phase's
   proposal avoids depending on that unfinished step.

There is **no existing `post`, `project`, or `content` collection**
anywhere in `firestore.rules` (confirmed by grep) — this is genuinely
greenfield, not a rename of something partial.

### 1.5 Storage Rules audit (`storage.rules`, read in full)

Six existing paths, all following one of two shapes: unauthenticated/
any-signed-in with a `contentType.matches('image/.*')` + 10 MB cap check
(`sell-submissions`, `listing-photos`), or an owner-scoped path with a
real Firestore cross-check via `firestore.get(...)` (`agent-photos/{uid}`,
`customer-photos/{uid}`, `company-logos/{companyId}`). **Every existing
path allows `image/.*` only — nothing in this codebase currently accepts
video.** Every path is `allow delete: if false` — this codebase never
actually deletes a Storage object anywhere; a removed reference just
stops being pointed to. **There is no path today for `serviceProviders`
media of any kind** (confirmed again this phase — unchanged since the
Designer/Engineer profile phase). No new Storage path is added in this
phase — see §7.

### 1.6 Listings architecture audit — no conflict

`listings/{listingId}` (`firestore.rules:513-586`) is entirely
`agentId`/`companyId`-owned, `dealType`/`propertyType`-shaped, and
serves `map.html`/`buy.html`/`index.html`'s property search. Nothing
about the proposed `professionalPosts` collection touches, queries, or
duplicates it — a Designer's "office design" project post is
conceptually unrelated to a property listing, and the brief is explicit
that Real Estate Office listings stay on the existing listing system.
Confirmed no shared field names, no shared collection, no shared rule
function between the two.

### 1.7 accountType / role / ownership audit

Re-confirmed the three-axis separation already established
(`role`/`accountType`/permissions) is untouched and is the correct
foundation to build on:

- `role` (`customer|agent|admin`) — unrelated to professional publishing
  eligibility; a `professional_designer` accountType holder's `role` is
  typically `customer` (see `docs/PHASE3_PROFILE_FIELD_CONTRACT.md`'s
  own note: "`role` is orthogonal to `accountType`").
- `accountType` — descriptive/routing only, **never itself an
  authorization grant** (`myPermissions()`/`hasPermission()`'s whole
  design point).
- **The actual trust signal for "is this a real professional who may
  publish" is the existence of a real, owned `serviceProviders/{uid}`
  document with a matching `serviceType`** — exactly the same signal
  `office.html`'s owner-only controls already use for companies, and
  exactly what `providerOwnerId()` already resolves. This phase's
  proposal (§3) is built on that existing signal, not a new one.

---

## 2. Proposed collection: `professionalPosts`

One flat, top-level collection (not a subcollection) — a subcollection
under `serviceProviders/{id}` would isolate each provider's own posts
correctly, but (like the array field it replaces) cannot be queried
*across* providers for a discovery feed without N reads. A flat
collection with a `profileId` field, filtered with `where()`, is the
standard Firestore pattern for "one owner's items, but also globally
browsable" — the same shape `listings` already uses (`agentId` field,
not a subcollection under `users/{agentId}`).

```
professionalPosts/{postId}
  id                 -- doc id, generated by addDoc()
  ownerId            -- uid of the authenticated creator; == the
                        serviceProviders doc's ownerId; LOCKED post-create
  profileId          -- the serviceProviders/{profileId} doc this post
                        belongs to; for every serviceType this phase
                        supports (engineer/designer/lawyer/landscaping),
                        providerType is always 'individual', so
                        profileId == ownerId == uid (mirrors
                        serviceProviders' own create-rule invariant,
                        `firestore.rules:853`); LOCKED post-create
  profileType        -- 'engineer' | 'designer' | 'lawyer' | 'landscaping'
                        (cleaning intentionally excluded from posts for
                        now -- see §9); MUST equal
                        get(serviceProviders/{profileId}).data.serviceType
                        at create time (cross-checked server-side, never
                        trusted from the request alone); LOCKED post-create
  status             -- 'published' | 'hidden'; owner may toggle between
                        these two only; a THIRD value, 'removed', is
                        reserved for admin-only moderation (§8) and is
                        never in the owner's own allowed-values set
  title              -- string, required, length-bounded
  category            -- string, from a per-profileType controlled enum
                        (§4.2) -- NOT free text
  description        -- string, optional, length-bounded
  city / district     -- strings, optional (mirrors serviceProviders'
                        own city/district shape)
  coverImageUrl       -- string (a real Storage download URL once uploads
                        exist -- see §7); required for a published post
  media               -- array of {url, type: 'image'|'video', order};
                        bounded length (proposed cap: 12 items); video
                        support is a FUTURE flag, not enabled this phase
                        (§7.3)
  projectDate         -- optional string/epoch, the professional's own
                        "completed on" date -- distinct from createdAt
  createdAt / updatedAt
```

**Explicitly not included**: no `verified` field on the post itself
(§6), no `likes`/`views`/`comments`/`shares` counters (this is
deliberately not a social feed — the brief is explicit), no free-text
tags beyond the controlled `category` enum.

### 2.1 Why not extend the `portfolio` array instead

Considered and rejected: even a richer per-item shape
(`{id, title, category, ...}`) inside the array would still not be
queryable across providers, still would not support real pagination, and
still would force a full-document read/write for a single project edit
(Firestore's array-update semantics require rewriting the whole array on
any single-element change, which also reintroduces a race condition
between two rapid edits that the current simple "whole array, whole
document" model doesn't need to worry about today but a busier
publishing workflow would). A flat collection avoids all four problems
and is the same shape `products` already proves works for this
codebase's Firestore usage patterns.

---

## 3. Ownership / security model

### 3.1 Create — the "eligible creator" gate

Proposed `firestore.rules` shape (documented here, **not applied**):

```
allow create: if isSignedIn()
  && request.resource.data.ownerId == request.auth.uid
  && providerOwnerId(request.resource.data.profileId) == request.auth.uid
  && get(/databases/$(database)/documents/serviceProviders/$(request.resource.data.profileId))
       .data.serviceType == request.resource.data.profileType
  && request.resource.data.profileType in ['engineer','designer','lawyer','landscaping']
  && request.resource.data.status in ['published','hidden']
  && request.resource.data.title is string && request.resource.data.title.size() > 0
  && request.resource.data.category in <per-profileType enum, §4.2>
  && request.resource.data.media.size() <= 12
  && request.resource.data.keys().hasOnly([...]);
```

This is deliberately **not** additionally gated behind
`hasPermission('manage_portfolio')`. Reasoning, explicit per the audit
in §1.4: that permission key exists in the catalog but has no seeded
`rolePermissionDefaults` document for any professional accountType yet —
depending on it now would fail-closed *every* real designer, which is
not what "eligible professional profiles" means here. The
`providerOwnerId(profileId) == request.auth.uid` check **is** the real
eligibility gate: it requires a genuine, already-owned, already-`create`
-validated `serviceProviders` document to exist first — precisely "the
existing trusted account/profile architecture" the brief asks for,
without inventing a second, currently-unseeded gate. Layering
`hasPermission('manage_portfolio')` in *addition* to this, once that
permission is actually seeded for the relevant accountTypes, is a
reasonable future hardening step (tracked in §8) — not required for
correctness today, and deliberately deferred so this phase doesn't quietly
depend on an unfinished rollout.

### 3.2 What this prevents, explicitly (per the brief's list)

| Threat | Prevented by |
|---|---|
| Publish as another professional | `providerOwnerId(profileId) == request.auth.uid` — the profile must be the caller's own, checked server-side against the real doc, never the request body |
| Change `ownerId` after create | locked in the update rule (`request.resource.data.ownerId == resource.data.ownerId`), same pattern as `listings.agentId`/`products.sellerId` |
| Impersonate another profile | same `providerOwnerId()` check; `profileId` itself is also locked post-create |
| Change `profileType` after create to bypass restrictions | locked post-create (`request.resource.data.profileType == resource.data.profileType` in the update rule) and cross-checked against the real `serviceProviders.serviceType` at create time, not merely accepted from the request |
| Self-set verification | no `verified` field exists on the post at all — see §6 |
| Gain publishing rights through client-side fields | the ONLY server-trusted signal is `providerOwnerId()` resolving to a real, already-rules-validated `serviceProviders` document; nothing about the post's own fields (including a hypothetical client-sent `profileType`/`eligible` flag) is ever trusted on its own |

### 3.3 Update / delete

```
allow update: if isAdmin()
  || (providerOwnerId(resource.data.profileId) == request.auth.uid
      && request.resource.data.ownerId == resource.data.ownerId
      && request.resource.data.profileId == resource.data.profileId
      && request.resource.data.profileType == resource.data.profileType
      && request.resource.data.status in ['published','hidden']   // owner can never write 'removed'
      && request.resource.data.diff(resource.data).affectedKeys()
           .hasOnly(['title','category','description','city','district',
                     'coverImageUrl','media','projectDate','status','updatedAt']));
allow delete: if isAdmin() || providerOwnerId(resource.data.profileId) == request.auth.uid;
```

Owner creates, owner edits own content, owner deletes own content; no
other professional can touch it; admin moderation (status → `'removed'`,
or outright delete) uses the *existing* `isAdmin()` primitive — not a
new capability.

### 3.4 Read

```
allow read: if resource.data.status == 'published' || isAdmin()
  || providerOwnerId(resource.data.profileId) == request.auth.uid;
```

Public discovery only ever sees `published` posts; the owner can still
see their own `hidden` drafts; admin sees everything (moderation).

---

## 4. Allowed professional creators / discovery relationship

### 4.1 Who may create posts (this phase's proposal)

Exactly the four `serviceType` values with a real, owned
`serviceProviders` document: `engineer`, `designer`, `lawyer`,
`landscaping`. `cleaning` is deliberately excluded from `professionalPosts`
for now — see §9 (Future roles) for why it needs its own shape
(before/after pairs are a distinct content shape the brief itself
flags, not identical to a project gallery). Real Estate Office
(`companies`) and the four `organizations`-backed business types
(`residential_community`/`developer_project`/`finance_provider`/
`furniture_store`) are **not** included — per the brief, listings stay
on the listings system, and furniture needs a separate commerce model
(§9).

### 4.2 Category enum (proposed, controlled — not yet enforced anywhere)

For `profileType == 'designer'`, proposed enum (from the brief's own
suggested list, narrowed to what a controlled enum needs — no free
text):

```
residential, apartment, villa, office, cafe, commercial, interior, exterior
```

This is a **proposal**, stored nowhere yet. Before P3 implements writes,
this needs the same treatment `CLEANING_SERVICE_CATEGORIES` already got
in `backend/app/access/constants.py` — a named frozenset, mirrored
byte-for-byte into a `firestore.rules` allowlist. Engineer/Lawyer/
Landscaping each need their own proposed enum before their posts are
implemented (out of scope this phase — Designer only).

### 4.3 Profile relationship

A post always resolves its creator by reading `serviceProviders/{profileId}`
live at render time — never by trusting fields the post document itself
might carry (see §6). "Open their profile" is simply
`designer.html?id={profileId}` — the existing profile page and URL
pattern (§10), unchanged.

### 4.4 Discovery relationship

The discovery feed (`design.html`, proposed) queries `professionalPosts`
directly — `where('profileType','==','designer')
.where('status','==','published') .orderBy('createdAt','desc')` — never
the `serviceProviders` collection. This is exactly why a flat collection
(§2) rather than a subcollection was required.

---

## 5. Edit/delete model

Covered in §3.3. Summary: owner-only self-service edit/delete via the
Firestore client SDK, identical operational shape to how
`serviceProviders` itself is already edited today (`updateDoc` from
`engineer.html`/`designer.html`'s existing owner-only form) — no new
backend endpoint is required for the basic CRUD shape, consistent with
this codebase's existing pattern of doing non-ownership-affecting writes
directly against rules-enforced Firestore rather than routing through the
backend (see the Phase J summary: "No backend Python CRUD endpoints exist
for serviceProviders — all reads/writes are direct client-SDK Firestore
calls").

---

## 6. Verification — never copied onto a post

`professionalPosts` documents carry **no `verified` field at all** — by
design, not by omission. Every place a post's creator is rendered (the
Discovery grid, the Work Detail creator block, "More work by this
Designer") must resolve the verified badge from a **live read of
`serviceProviders/{profileId}.verified`**, the same trusted source
`designer.html` already reads today. This structurally prevents "copy a
client-provided verified value into a post" — there is no field to copy
it into.

---

## 7. Media / future Storage plan (not implemented this phase)

No Storage path is added in P1/P2. Proposed shape for a future phase,
matching the existing `company-logos/{companyId}` cross-check pattern
exactly:

```
match /professional-work/{profileId}/{fileName} {
  allow read: if true;
  allow write: if request.auth != null
    && firestore.get(/databases/(default)/documents/serviceProviders/$(profileId)).data.ownerId == request.auth.uid
    && request.resource.size < 10 * 1024 * 1024
    && request.resource.contentType.matches('image/(jpeg|png|webp)');
  allow delete: if false;   // matches every existing path's convention
}
```

Explicit decisions to carry into that future phase:

- **MIME allowlist, not just a prefix match.** Every existing path in
  this codebase accepts `image/.*` unconditionally — that includes
  `image/svg+xml`, which can carry an embedded `<script>` and is a real
  stored-XSS vector if ever rendered directly rather than as a CSS
  `background-image`. This phase's proposal narrows the future
  professional-work path to `image/(jpeg|png|webp)` explicitly. This is
  a **stricter** rule than the existing paths use, proposed for this new
  path only — not a change to any existing path (out of scope, and the
  brief's freeze covers Storage Rules entirely this phase).
- **Never trust a filename extension** — the existing paths already only
  check `request.resource.contentType`, which Firebase Storage derives
  from the actual upload, not the client-supplied filename; the proposal
  keeps that.
- **Video is explicitly an open question, not a decision.** The brief
  allows for "project video where supported." No existing path in this
  codebase supports video at all. Video needs its own size cap (likely
  far larger than 10 MB), its own MIME allowlist (`video/mp4` at
  minimum), and a real decision about whether unprocessed video should
  ever be served directly (bandwidth/cost) or requires transcoding
  (infrastructure this codebase doesn't have). **Not decided here** —
  flagged for a dedicated media-phase discussion before any video upload
  path is built.
- **`media[].url` must be validated as belonging to this codebase's own
  Storage bucket** once uploads exist, not accepted as an arbitrary
  string — otherwise a post could embed an arbitrary external URL as
  "media." Deferred to the same future phase (no data is written this
  phase, so nothing to validate yet).

---

## 8. Moderation — future plan (not implemented this phase)

`status: 'removed'` is reserved in the schema (§2) but only ever settable
by `isAdmin()` (§3.3's update rule already excludes it from the owner's
own allowed values, by construction — the owner's branch requires
`status in ['published','hidden']`). A future admin.html tab can read/
write it through the existing `isAdmin()` primitive with no new
authorization concept — mirrors exactly how `listings.verified` and
`companies.verified`/`serviceProviders.verified` are already admin-only
flippable today. `KNOWN_PERMISSIONS` already has `moderate_content` as a
non-protected permission key for a future finer-grained "moderator, not
full admin" role, if that's ever wanted — not required for MVP moderation
since `isAdmin()` alone already covers it.

---

## 9. Future roles — shape differences (not implemented, direction only)

Per the brief, explicitly **not** one identical schema forced onto every
role:

- **Engineer / Landscaping**: same `professionalPosts` shape as Designer
  works structurally (image-led project gallery), each with their own
  proposed `category` enum (construction/engineering-work/blueprints/
  site-progress for Engineer; garden-design/before-after/outdoor for
  Landscaping) — not designed in detail this phase (Designer only, per
  the brief).
- **Cleaning**: excluded from `professionalPosts` in this proposal.
  Before/after is close to Landscaping's shape but the brief also
  distinguishes cleaning as its own role family with its own
  `providerType` (`individual`/`team`/`company`) — proposed to get its
  own before/after-shaped collection or a `postKind` discriminator field
  later, not decided here.
- **Lawyer**: explicitly **not** image-heavy per the brief. A future
  `professionalPosts` variant for Lawyer would need a text/article-shaped
  content type (title + body + maybe a single cover image) — a
  meaningfully different card/detail rendering, not a re-skin of the
  Designer masonry grid. Not designed further this phase.
- **Real Estate Office**: no post type at all — listings remain the
  listings system, unchanged, per explicit instruction.
- **Furniture Seller**: explicitly flagged in the brief as needing a
  separate commerce model — the existing `products` collection already
  covers "catalog," and forcing it into `professionalPosts`' shape would
  misuse both. Not touched by this proposal.

---

## 10. URLs / deep linking (design only, no routing code changed this phase)

- `designer.html?id={profileId}` — unchanged, already the pattern from
  the prior phase.
- `work.html?id={postId}` — proposed for a post detail page, mirroring
  `office.html?id=`/`designer.html?id=`'s existing query-param pattern
  (this codebase's established convention for static-hosting-friendly
  deep links — confirmed no client-side router exists anywhere in this
  repo, so this is the only pattern consistent with "do not break
  existing URLs").
- `design.html` — proposed discovery page, no query param needed for the
  unfiltered view; a future `?category=` param is additive.

A work detail page must resolve its creator the same way `office.html`/
`designer.html` already resolve profile data — by reading the real
`profileId` field on the post document, never a value passed in the URL
independent of the post record itself.

---

## 11. Indexes (proposed, not applied to `firestore.indexes.json`)

`firestore.indexes.json` currently has zero composite indexes
(confirmed — only two `fieldOverrides` entries for collection-group
`uid` lookups). Two composite indexes will eventually be required:

```json
{
  "collectionGroup": "professionalPosts",
  "queryScope": "COLLECTION",
  "fields": [
    { "fieldPath": "profileType", "order": "ASCENDING" },
    { "fieldPath": "status", "order": "ASCENDING" },
    { "fieldPath": "createdAt", "order": "DESCENDING" }
  ]
}
```
— for the Discovery feed (`where profileType == X, where status ==
'published', orderBy createdAt desc`), and:

```json
{
  "collectionGroup": "professionalPosts",
  "queryScope": "COLLECTION",
  "fields": [
    { "fieldPath": "profileId", "order": "ASCENDING" },
    { "fieldPath": "status", "order": "ASCENDING" },
    { "fieldPath": "createdAt", "order": "DESCENDING" }
  ]
}
```
— for "all of this Designer's published work," used both on the profile
page's Work tab (public view, `status == 'published'` only) and by the
owner's own view (a third variant without the `status` filter, or a
client-side merge of `hidden` + `published` for the owner — resolved when
P3 implements real writes). A future `profileType + status + category +
createdAt` index would be needed once category filtering ships on the
Discovery page. **Not applied this phase** — `firestore.indexes.json` is
left untouched, since no query against a nonexistent collection runs yet
(§12 covers how P2's UI handles that).

Query-abuse guardrails (design intent, enforced at implementation time,
not this phase): every list query is `limit(24)`-bounded with a
`startAfter(lastDoc)` cursor for "load more" — no unbounded query, per
the brief's explicit instruction.

---

## 12. Security threat model

| Threat | Status |
|---|---|
| Ownership spoofing | Prevented — §3.1/3.2, `providerOwnerId()` cross-check, not request-trusted |
| `profileType` spoofing | Prevented — cross-checked against the real `serviceProviders.serviceType` at create, locked post-create |
| Unauthorized professional publishing | Prevented — create requires an already-owned, already-validated `serviceProviders` doc; a plain `individual_customer` has no such doc to point at |
| Cross-user edits | Prevented — update/delete require `providerOwnerId(profileId) == request.auth.uid` or `isAdmin()` |
| Malicious media | Deferred — no upload path exists yet (§7); when built, MIME-allowlist (narrower than existing paths) + size cap + no filename trust |
| Oversized upload | Deferred to §7 (10 MB image cap proposed, video cap TBD) |
| Unsupported MIME | Deferred to §7 (`image/(jpeg|png|webp)` only, explicitly excluding `image/svg+xml`) |
| Stored XSS via title/description | Mitigated at render time by convention already established this session (`js/profile-role.js`'s `esc()` helper / `textContent`-only rendering, never raw `innerHTML` interpolation of user data) — every new component in P2 follows the same rule (§13 below) |
| Unsafe URL rendering | Deferred to §7 — once uploads exist, `media[].url`/`coverImageUrl` must be validated as this project's own Storage bucket URLs, not accepted as arbitrary strings; not yet a concern since P1/P2 write no real URLs |
| Deleted/suspended professional content | Handled by `status` (`published`/`hidden` self-service, `removed` admin-only) — §3.3/§8 |
| Verification spoofing | Prevented structurally — no `verified` field exists on a post at all (§6) |
| Duplicate submissions | Not hardened this phase; flagged as a natural extension of the existing INFRA-01 Firestore-backed rate limiter pattern once real writes exist |
| Query abuse / unbounded reads | Prevented by design — every proposed list query is `limit()`-bounded with cursor pagination (§11); P2 ships zero real queries against production data anyway |

No existing security control is weakened by this proposal: `role`,
`isAgent()`, `isAdmin()`, every `listings`/`companies`/`organizations`/
`serviceProviders`/`products` rule, and the fail-closed
`hasPermission()`/`hasOrgPermission()` machinery are all read-only
referenced here, never modified.

---

## 13. Migration / compatibility with the current `portfolio` field

`serviceProviders.portfolio` is **not removed, renamed, or migrated**.
It keeps working exactly as it does today — the existing owner-only edit
form in `js/profile-role.js` is untouched this phase. `professionalPosts`
is purely additive.

For P2's Work tab specifically (read-only, no writes), the proposed
compatibility behavior: query `professionalPosts` for the profile's
published posts first (today, against real production Firestore, this
query is rejected with `permission-denied` because the collection has no
rule yet — see §14); if that resolves to zero real posts (whether from a
denied read treated as empty, or a future real empty query), and the
profile's own `serviceProviders.portfolio` array has real entries, render
those through the same `ProfessionalWorkCard` component as a fallback so
a Designer who already added Phase-J-era portfolio photos doesn't see
real content disappear. This is a read-only UI compatibility decision,
not a schema migration — no data is copied, moved, or duplicated between
the two locations.

---

## 14. What P2's UI does about a collection that doesn't exist in rules yet

Because `firestore.rules` has no explicit `match` block for
`professionalPosts` and the file ends in an implicit deny (confirmed —
the file has no closing wildcard `allow` block), any real `getDocs()`
call against it today throws `FirebaseError: permission-denied`, not an
empty snapshot. P2's UI code treats that specific, expected error the
same as a genuine empty result — never surfaced as a scary error state,
and never worked around by disabling rules or writing fake data. This is
the literal implementation of the brief's "if the new collection does not
exist yet, use EMPTY STATES / loading-safe UI."

---

## Summary of what changes in production this phase

**Nothing.** `firestore.rules`, `storage.rules`, and
`firestore.indexes.json` are unmodified. This document, plus a read-only
Designer-only UI prototype (§ companion phase report), are the only
output of Phase P1.
