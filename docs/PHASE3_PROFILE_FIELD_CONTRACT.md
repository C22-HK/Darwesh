# Phase 3 — Profile Field Contract

Data-contract-first step for Phase 3 (Profile UI/Dashboards), per the
Phase 3 kickoff instructions ("perform a short repository review and
document the actual existing profile fields available for each profile
type ... based only on existing backend/Firestore schema").

This document does not introduce any new schema. Every field listed below
is read directly from `firestore.rules` (the enforced allowlists) and
`backend/app/access/constants.py`/`organization_ops.py`/`permission_ops.py`
(the enforced write/read shapes), as they exist on `claude/web-project-hqdo8o`
at commit `caa9747`. Anything a future UI might want that isn't listed here
is marked **unavailable/deferred** — see the companion blocker note at the
bottom, which must be resolved before "Real Estate Office" specifically can
get the premium profile treatment the Phase 3 brief describes.

## accountType → data-model mapping

`users/{uid}.accountType` is one of 14 self-settable values
(`SELF_ACCOUNT_TYPES`, `backend/app/access/constants.py:23-38`) plus the
protected `admin`. Each maps to a different backing collection for its
*profile-specific* (non-`users`) data:

| accountType | role | Org-context collection | Notes |
|---|---|---|---|
| `individual_customer` | `customer` | none | `users/{uid}` only |
| `real_estate_agent` | `agent` | none (`companyId` null) | independent agent, no office |
| `office_owner` | `agent` | `companies/{id}` (legacy) | **thin schema — see blocker** |
| `office_employee` | `agent` | `companies/{id}` (legacy, via `users.companyId`) | **thin schema — see blocker** |
| `professional_engineer` | `customer` or `agent`* | `serviceProviders/{uid}` | providerType always `individual` |
| `professional_designer` | * | `serviceProviders/{uid}` | providerType always `individual` |
| `professional_lawyer` | * | `serviceProviders/{uid}` | providerType always `individual` |
| `professional_landscaping` | * | `serviceProviders/{uid}` | providerType always `individual` |
| `cleaning_individual` | * | `serviceProviders/{uid}` | providerType `individual` |
| `cleaning_team_or_company_owner` | * | `serviceProviders/{generatedId}` | providerType `team` or `company` |
| `org_owner_residential_community` | * | `organizations/{id}`, `type='residential_community'` | rich schema |
| `org_owner_developer` | * | `organizations/{id}`, `type='developer_project'` | rich schema |
| `org_owner_finance_provider` | * | `organizations/{id}`, `type='finance_provider'` | rich schema |
| `org_owner_furniture_store` | * | `organizations/{id}`, `type='furniture_store'` | rich schema + `products` |
| `admin` | `admin` | none | full access via `isAdmin()` |

\* `role` is orthogonal to `accountType` (Phase 1/2 invariant) — the
professional/organization account types have no fixed `role` requirement
in the rules; in practice they'll be `customer` unless an admin also grants
`agent`/`admin`. The UI must read `role` and `accountType` independently
and never infer one from the other.

**Critical, load-bearing fact for Phase 3 layout decisions**: `office_owner`
and `office_employee` do **not** use the `organizations` collection at all
— they use the legacy `companies` collection, which was deliberately left
unmigrated in Phase 1 (see the blocker note below). Every other
organization-shaped accountType (`org_owner_*`) uses the full-featured
`organizations` collection built across Phases 1–2.2. This is the single
most important fact this document establishes: **"Real Estate Office" and
"the rest of the organization-shaped profiles" are backed by two
structurally different, non-interchangeable data models today.**

## `users/{uid}` — every profile type

Source: `firestore.rules:261-274` (create allowlist), `:318-334` (update
allowlist + locked fields).

| Field | Public | Owner-editable | Backend/admin-only | Notes |
|---|---|---|---|---|
| `email` | no (owner/admin only read) | no (set at signup) | — | |
| `displayName` | yes* | yes | — | *public only if `role=='agent'`, else owner/admin read only (`firestore.rules:213`) |
| `firstName`/`lastName` | no | no (create-only) | — | not in update allowlist — effectively immutable post-signup today |
| `phone` | no | no (create-only) | — | same as above |
| `photoURL` | yes* | yes | — | same visibility rule as `displayName` |
| `role` | no | **no** | admin only | `'customer'\|'agent'\|'admin'` |
| `requestedRole` | no | **no** | admin only | signup-intent signal, never itself a grant |
| `companyId` | no | **no** | admin only | legacy real-estate-office pointer |
| `requestedCompanyId`/`requestedCompanyName` | no | **no** | admin only | BL-04: name-match grants nothing |
| `accountType` | no | **no** (write-once at signup) | admin/backend only | UI-routing hint only, never an authorization grant |
| `activeOrganizationId` | no | **no** | backend only, via `POST /me/active-organization` | Phase 2.2: UX pointer only, never authorization |
| `permissionOverrides` | no | **no client path at all**, ever | backend Admin SDK only | never client-writable, not even by admin |
| `commissionRate` | no | yes (0–100 bound) | — | agent-only in practice |
| `phoneVerified`/`phoneVerifiedAt`/`emailVerified` | no | no (create-only) | — | |
| `createdAt` | no | no (create-only) | — | |
| `assignedAgentId` | no | — | — | **dead field** — never written by any code path (Phase 1 finding, still true) |

## `companies/{companyId}` — Real Estate Office (legacy model)

Source: `firestore.rules:193-197` (no field allowlist exists at all —
rules only gate document existence, not shape), confirmed against the one
real production writer, `admin.html:3149` (`{ name, createdAt }`) and the
address-edit flow (`admin.html:2760`, `{ address }`).

| Field | Exists today | Notes |
|---|---|---|
| `name` | yes | only field set at creation besides `createdAt` |
| `createdAt` | yes | |
| `address` | yes | set via a **separate** edit-address flow, not at creation |
| `ownerId` | **no** | membership/ownership is inferred by scanning `users` where `companyId==id`, not stored on the company doc |
| `logoUrl` | **no** | |
| `description` | **no** | |
| `verified` | **no** | |
| `contactInfo` (phone/email/whatsapp) | **no** | |
| `city`/`district`/`location` | **no** | |
| members subcollection | **no** | membership = `users.companyId` equality, no queryable roster |

**Every field a "premium business page" needs beyond a bare name/address
does not exist in production for real estate offices.** See blocker note.

## `organizations/{orgId}` — Residential Community / Developer / Finance Provider / Furniture Store

Source: `firestore.rules:675-742`.

| Field | Public read | Owner-editable | Admin-only | Notes |
|---|---|---|---|---|
| `type` | yes | no (locked after create) | yes | one of the 4 non-office types |
| `ownerId` | yes | **no** (backend-only reassignment) | no client path | Phase 2.6 invariant |
| `name` | yes | yes | yes | required, non-empty |
| `description` | yes | yes | yes | |
| `logoUrl` | yes | yes | yes | |
| `coverImageUrl` | yes | yes | yes | |
| `city`/`district`/`location` | yes | yes | yes | |
| `contactInfo` | yes | yes | yes | shape unconstrained beyond `is map` |
| `details` | yes | yes | yes | type-specific free-form map (units/amenities for residential; downPayment/eligibility for finance; deliveryAreas for furniture, etc. — **not itself schema-validated per type**, so the UI must render defensively, not assume specific `details.*` keys exist) |
| `verified` | yes | **no** (admin only) | yes | |
| `createdAt`/`updatedAt` | yes | yes (`updatedAt` only) | yes | |

`organizations/{orgId}/members/{memberUid}` (source: `:736-741`):
readable by admin, the org's own owner, or the member themself; **never
client-writable by anyone, including admin** (backend-only). Shape (from
`organization_ops.py`): `status` (`pending`/`invited`/`active`), `role`,
`permissions` (map), `uid` (denormalized, Phase 2.2), `addedAt`/`addedBy`.

## `serviceProviders/{providerId}` — Engineer/Designer/Lawyer/Landscaping/Cleaning

Source: `firestore.rules:749-802`.

| Field | Public read | Owner-editable | Admin-only |
|---|---|---|---|
| `serviceType` | yes | no (locked) | yes |
| `providerType` | yes | no (locked) | yes |
| `ownerId` | yes | **no** | no client path |
| `displayName`/`companyName` | yes | yes | yes |
| `photoOrLogoUrl` | yes | yes | yes |
| `description` | yes | yes | yes |
| `city`/`district`/`serviceAreas` | yes | yes | yes |
| `experienceYears` | yes | yes | yes |
| `specialties` | yes | yes | yes |
| `servicesOffered` | yes | yes (cleaning only; allowlisted 9 values) | yes |
| `portfolio` | yes | yes | yes |
| `teamSize`/`availableDays`/`availableHours`/`pricingModel` | yes | yes | yes |
| `verified` | yes | **no** (admin only) | yes |

`serviceProviders/{id}/requests/{requestId}` (`:810-823`): customer-created
(`customerUid`, `status`, `message`, `contactPhone`), provider can update
only `status`/`providerNote`. Scoped per-provider path, never a flat
collection — one provider structurally cannot see another's requests.

## `products/{productId}` — Furniture Store catalog

Source: `firestore.rules:835-883`. `sellerId` (locked, must reference an
`organizations` doc with `type=='furniture_store'`), `name`, `categoryId`,
`description`, `price`, `currency`, `discountPrice`, `images`, `status`
(`available`/`out_of_stock`/`hidden`/`sold_out`), `condition`,
`dimensions`, `material`, `color`, `deliveryAvailable`, `createdAt`/`updatedAt`.
`productCategories/{id}`: `name`, `parentId` (admin-only writable, flat
tree, publicly readable).

## Backend-resolved fields (never read directly from Firestore by the frontend)

- `GET /api/v1/access/me/permissions[?organizationId=]` → `{ uid, role,
  accountType, activeOrganizationId, globalPermissions, organization:
  { organizationId, membershipStatus, memberRole, organizationPermissions,
  effectivePermissions } | null }` (`permission_ops.py:212-261`). The
  frontend must call this rather than re-deriving permission state from
  raw Firestore reads — this is the resolved, fail-closed source of truth.
- `GET /api/v1/access/me/organizations` → array of `{ organizationId, name,
  type, membershipStatus ('owner'|'active'|'pending'|'invited'), memberRole,
  isOwner }` — **only ever returns `organizations`-backed orgs**; a real
  estate office never appears here (see blocker).
- `POST /api/v1/access/me/active-organization` → `{ organizationId: string
  | null }` — writes `users.activeOrganizationId` after re-validating real
  membership; UX pointer only.

## Verification status — what exists today

There is **no dedicated verification-status field set** beyond
`organizations.verified` / `serviceProviders.verified` (both booleans,
admin-only-settable) and the pre-existing `listings.verified`. There is no
`identityVerified`/`professionalVerified`/`organizationVerified`/
`listingVerified` split anywhere in the schema. Phase 3 UI showing a
"Verified" badge should read the one boolean that exists for that
collection (`verified`) and must not invent a richer verification
taxonomy client-side.

## Public vs. private — summary

Public (no auth required): `companies.name/address`, all of
`organizations` (whole doc, `allow read: if true`), all of
`serviceProviders` (whole doc), all of `products`/`productCategories`, an
agent's `users.displayName`/`photoURL` (only when `role=='agent'`), all
`listings` fields for a listing that `isListingPubliclyVisible()`.

Private (owner/admin only): everything else on `users/{uid}` for a
non-agent, `favorites`/`savedSearches` subcollections, `submissions`,
`agentTransactions`, `organizations/{id}/members` (owner/admin/self only),
`serviceProviders/{id}/requests` (provider/customer/admin only),
`permissionOverrides`, all access-control collections
(`rolePermissionDefaults`, `accessAuditLog`, `permissionDefinitions`).

---

## ⚠ Blocker: Real Estate Office cannot get the Phase 3 "premium business
page" treatment on today's schema

The Phase 3 brief explicitly prefers **Real Estate Office** as the one
representative profile type to build end-to-end first, and asks for: logo,
verified state, short intro, location, contact actions,
listings/team/services, and "organization ownership/management controls
for authorized users" (§9), plus employee membership "tied to existing
organization membership... never infer membership from company name" (§9).

Today, `companies/{id}` (the real estate office's actual backing
collection, confirmed above) has exactly **three fields**: `name`,
`createdAt`, `address`. It has no `ownerId`, no `logoUrl`, no
`description`, no `verified` flag, no `contactInfo`, and — most
importantly for §9's explicit "never infer membership from company name"
requirement — **no members subcollection at all**: membership is still
inferred by scanning `users` where `companyId==id`, exactly the model
Phase 1's plan document flagged as staying unmigrated on purpose ("Real
estate offices keep using `companies` unchanged initially... full
unification into `organizations` is a reasonable **later** phase").

By contrast, `organizations/{id}` (used by the four `org_owner_*` types)
already has every one of those fields today: `ownerId`, `logoUrl`,
`description`, `verified`, `contactInfo`, `city`/`district`/`location`,
and a real, queryable `members` subcollection with actual membership
records (`pending`/`invited`/`active`) — exactly the premium-profile
building blocks §9 describes, already built and tested across Phases 1–2.2.

This is a genuine backend/schema gap, not a frontend design question, and
per the Phase 3 kickoff's own instruction ("If a backend/schema blocker is
found: stop and report it clearly before changing architecture" / "Do not
redesign the backend architecture... unless a real implementation blocker
is found"), **I'm stopping here rather than silently working around it** —
e.g. rather than inventing frontend-only fields, faking a `logoUrl` some
other way, or quietly starting a `companies`→`organizations` migration
that Phase 2.2 explicitly deferred and that this kickoff also forbids
("Do not change the authorization model from Phase 2.2").

I'll lay out the options in my reply rather than in this document, since
that's a decision for you, not something to resolve unilaterally.
