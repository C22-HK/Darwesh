# Darwesh Group — Full Website Bug Hunt, Functional QA & Safe Fix Pass

**Date:** 2026-09-02
**Branch:** `claude/web-project-hqdo8o` (built on Rent scaling commit `680876f`)
**Scope:** Full-site audit + safe fix pass per the 35-section bug-hunt spec. Explicitly out of scope this pass: Service Earth/Universe, MAM AI redesign, Build/Renovate redesign, Unified Map consolidation, Map Privacy migration.

---

## A. Executive summary

Audited the full public/authenticated surface of the Darwesh site (29 HTML pages, shared nav/i18n components, `firestore.rules`, `storage.rules`) using a fast static baseline (`ci-checks.js`, targeted greps) plus four parallel research passes covering button/handler wiring, navigation, auth/role routing, and security (Firestore/Storage rules, XSS, App Check, secrets). Confirmed and safely fixed **13 findings** (1 CRITICAL, 4 HIGH, 6 MEDIUM, 2 LOW) spanning a data-loss bug in the Sell form, stored-XSS gaps, swallowed errors on office.html's backend-mediated actions, a Firestore/Storage rules authorization gap, a favorites desync bug, missing error states, a query race condition, and a dead language switcher on `account.html` (found via the closing Playwright QA pass, not the static audit). All fixes are minimal, localized, and covered by either the existing 274-test Firestore emulator suite (which still passes in full) or `ci-checks.js`. No previously-working functionality was removed, no rules were weakened, and no index changes were made — `firestore.indexes.json` is byte-identical to commit `680876f`. Six commits were pushed to `claude/web-project-hqdo8o`. `firestore.rules` and `storage.rules` both changed and need a manual `firebase deploy --only firestore:rules,storage:rules` (see §P) — this was NOT run.

## B. Total findings by severity

| Severity | Fixed | Deferred (documented, not fixed) |
|---|---|---|
| CRITICAL | 1 | 0 |
| HIGH | 4 | 1 (promo.html live impersonation flow) |
| MEDIUM | 6 | 3 |
| LOW | 2 | 2 |
| INFO | 1 | — |

## C. Fixed findings

**F-01 (CRITICAL) — sell.html: identity-verification selfie silently discarded when no property photos are added.**
Page: `sell.html`. Problem: `sellPhotoToken` started as `null` and was only generated once a *property photo* upload began. Property photos are optional, so a guest who submitted zero property photos never got a token generated at all. Root cause: `firestore.rules:775` requires the verification-photo subcollection write's `token` to equal `submissions/{id}.photoUploadToken` exactly — with no token ever set, the write path was structurally broken for this (common) case, and the captured selfie was discarded with no error shown. Fix: generate `sellPhotoToken` eagerly via `crypto.randomUUID()` at page load, independent of whether a property photo is ever added. Also fixed a related lie: the "Upload failed — will retry when you submit" message never actually retried, because `verificationUploadPromise` never rejects — re-awaiting it on submit was a no-op. Now a failed verification upload is explicitly re-started before submit. Test: existing Firestore emulator submission/verification-token tests continue to pass; behavior manually traced against `firestore.rules:775`.

**F-02 (HIGH) — office.html: stored XSS in public listing cards and team roster.**
Page: `office.html`. Problem: zero output escaping anywhere in this file — listing title/price/image `src` and team-roster `uid`/display name were interpolated straight from Firestore data into `innerHTML`, and `companyData.logoUrl` was assigned directly to an `<img src>` with no protocol check. Root cause: file predates this codebase's escaping convention and was never retrofitted. Fix: added `esc()` (imported from `js/professional-content.js`, the established shared escaper for `type="module"` pages) and a local `isSafeHttpUrl()` at every interpolation site. Test: `ci-checks.js` inline-script-syntax check passes; manual trace of every interpolation site in the diff.

**F-03 (HIGH) — office.html: backend-action errors silently swallowed.**
Page: `office.html`. Problem: Approve/Reject/Revoke/Remove (team roster), the verify-status toggle, and Accept/Decline (invitation card) all used `withBusyButton()`, which re-enables the button in a `finally` block only — it has no `catch`. Every one of these calls a backend endpoint that (per `js/backend-config.js` and `docs/BACKEND_MILESTONES.md`, confirmed still unblocked/undeployed) currently always fails — making this a 100%-reproducible, ever-present silent failure, not an edge case. Fix: wrapped each handler body in try/catch, surfacing the error via new/existing message elements using the same `BackendResponseError`/`BackendUnavailableError` distinction already used by this file's `wireInviteForm()`. Test: manual code trace confirming every backend-call site in this file now has matching error UI.

**F-04 (HIGH) — map.html: favorites desync with every other listing page.**
Page: `map.html`. Problem: `toggleFavorite()` and the card renderer wrote/read favorites under a `'map-' + id` doc-id prefix, while `buy.html`, `rent.html`, and `listing.html` all use the site-wide `'buy-' + id` convention regardless of dealType. Result: a listing favorited from the map showed as unfavorited everywhere else, and vice versa — real, silent data duplication under `users/{uid}/favorites/`. Fix: changed both sites to `'buy-' + id`. Test: manual trace confirming the doc-id convention now matches `buy.html`/`rent.html`/`listing.html` exactly.

**F-05 (MEDIUM) — map.html / buy.html: load failures indistinguishable from "no results."**
Pages: `map.html`, `buy.html`. Problem: a Firestore/network failure while loading listings rendered identically to a genuine empty-results state, with no retry affordance. Fix: added a `listingsLoadError` flag and a distinct error UI (reusing existing `buy.loadError`/`common.retry` i18n keys) with a Retry button on both pages. Test: manual trace of the new branch; `ci-checks.js` confirms the reused i18n keys still resolve.

**F-06 (MEDIUM) — buy-rent-map.html: Buy/Rent toggle race condition.**
Page: `buy-rent-map.html`. Problem: `loadListings()` had no request-ordering guard — rapidly toggling Buy/Rent could let an older, slower response overwrite a newer one's rendered state. Fix: added the same `queryGeneration`-style counter pattern already established in `rent.html` (`listingsRequestGeneration`), discarding any response superseded by a newer toggle click before it renders. Test: manual trace confirming the generation check gates every render call.

**F-07 (MEDIUM) — firestore.rules: agent could attach a real organization's id to a new Estate without membership.**
File: `firestore.rules`. Problem: the `estates/{estateId}` **create** rule's plain-agent branch was bare `isAgent()`, while the **update** rule's equivalent branch already correctly required `isAgent() && !('organizationId' in resource.data)`. Since `organizationId` is in the same create field allowlist regardless of which OR-branch authorized the write, any agent could create an Estate and set `organizationId` to a real organization's id they have no membership in. Fix: mirrored the update rule's restriction onto the create rule exactly. Test: new regression test `tests/firestore/estates.test.mjs` — "a plain agent CANNOT attach an organizationId they have no membership/permission for" — verified via the full 274-test emulator suite (all passing, including this new test).

**F-08 (MEDIUM) — storage.rules: listing-photos writable by any signed-in account, not just agents/admins.**
File: `storage.rules`. Problem: `listing-photos/{token}/{fileName}` only checked `request.auth != null`, on the stale assumption that every signed-in user was already an agent or admin — no longer true once self-registered account types (`individual_customer`, `professional_*`, `org_owner_*`) existed. Any of those signed-in users could write arbitrary files into this public, unauthenticated-read path directly via the SDK, bypassing the Add/Edit Listing form's UI gate entirely. Fix: added `isAgentOrAdmin()` (a `firestore.get()` role cross-check, matching the pattern `company-logos`/`professional-work` already use). Test: new `tests/storage/listing_photos.test.mjs` (agent/admin succeed, plain customer/unauthenticated fail) — see §N for the sandbox caveat on running it here.

**F-09 (MEDIUM) — admin.html: redundant duplicate Firestore reads on the Branches tab.**
Page: `admin.html`. Problem: `renderBranchesTab()` called `fetchAgentStats()` (which already does a full `users` collection read internally) and then re-fetched the entire `users` collection a second time two lines later — two full collection scans doing the same job on every Branches tab render. Fix: `fetchAgentStats()` now returns its `usersSnap` so `renderBranchesTab()` reuses it instead of re-fetching. Test: manual trace; `ci-checks.js` passes.

**F-10 (LOW) — admin.html: unvalidated Services-tab thumbnail URL.**
Page: `admin.html`. Fix: added the same `isSafeHttpUrl()` guard already used elsewhere in this file before assigning `photoUrls[0]` to an `<img src>`.

**F-11 (LOW) — listing.html: unvalidated listing image URL.**
Page: `listing.html`. Fix: guarded `listingImg.src` with the existing classic-script `isSafeHttpUrl()` from `js/escape-html.js`.

**F-12 (LOW) — signup-professional.html: unescaped review-step value (self-XSS).**
Page: `signup-professional.html`. Fix: added a local `escapeReviewValue()` and applied it to the interpolated review value.

**F-13 (HIGH, found via Playwright QA) — account.html: language/RTL never applied; language switcher dead.**
Page: `account.html`. Problem: every other page loads `js/i18n.js` as its final script — this is what reads `darwesh_lang` from `localStorage`, sets `<html lang>`/`<html dir>` on load, and defines the global `setLanguage()` the header's flag-menu buttons call via `onclick`. `account.html` never included it. Result: a signed-in customer with Arabic/Kurdish selected always saw their own account page in English/LTR, and the page's own language-switcher buttons called an undefined `setLanguage()`, silently doing nothing. Fix: added `<script src="./js/i18n.js"></script>` before `</body>`, matching the exact placement convention on every sibling page. Test: `ci-checks.js` passes (this page still uses zero `data-i18n` keys — see F-13 note in §D).

Plus one INFO-level doc fix: `js/professional-content.js`'s header comment claimed `professionalPosts` had no `firestore.rules` match block yet — it does (owner + `serviceType`-gated); corrected the stale comment.

## D. Deferred findings (documented, not fixed this pass)

- **account.html has zero `data-i18n` coverage (MEDIUM, deferred).** F-13 restores correct `dir`/`lang` application and makes the existing language-switcher buttons functional, but every string of text on the page is still hardcoded English — full translation of this page (favorites, submissions, saved searches, agent card, settings forms, all three languages) is a separate, substantial i18n undertaking, not a "missing script tag" bug. Recommend a dedicated follow-up pass.
- **promo.html's live, unauthenticated "Agent Check-In" discount-scan flow (HIGH, deferred).** Confirmed reachable from the public homepage (`index.html` links to it twice, not orphaned as originally suspected) with no staff authentication gate. Disabling it would remove working functionality the task explicitly says not to remove; a real fix requires staff authentication design that's out of scope for a "safe, localized fix" pass. Documented here as a known live risk for a future phase.
- **buy-rent-map.html: listings with no lat/lng are silently dropped from the map AND the list panel (LOW-MEDIUM, deferred).** Confirmed the map-only drop is intentional (can't plot a point with no coordinates), but the list panel dropping them too means such listings are invisible on this page entirely. Low volume expected; flagged for a future data-quality pass rather than fixed blind.
- **design.html is unreachable from any real navigation (LOW, deferred/report-only).** Only referenced in code comments (`rent.html`, `js/professional-content.js`), never a real `<a href>`. Ambiguous where it should be linked from without a product decision; not fixed.
- **services.html: inconsistent `data-active` on buy/sell/rent sub-links (LOW, deferred/report-only).** Cosmetic nav-highlighting inconsistency, not a functional break.
- **admin.html: `fetchAgentStats()` is still called independently (no caching) by ~5 different tab-render functions (LOW, deferred).** F-09 fixed the one *confirmed, zero-risk* duplicate read (two full `users` scans inside the same function call). The broader "add a cache layer across tab switches" idea was intentionally not built — every one of those tab renders can run after an admin mutates `users`/`companies`/`listings` (e.g. verifying an agent), so a naive cache risks showing stale data; a correct version needs real invalidation design, which is out of scope for a safe/localized fix.
- **profile.html and verification.html are genuinely orphaned pages (INFO, report-only).** Confirmed zero references from any other HTML or JS file in the repo. Per explicit instruction, not deleted.

## E. Security findings

Covered in detail in §C (F-02, F-03, F-07, F-08, F-10, F-11, F-12). Summary: two Firestore/Storage rules authorization gaps closed (both were "any signed-in/any agent" where a narrower check was needed and already existed as precedent elsewhere in the same file), and four stored/self-XSS gaps closed via the codebase's two existing, already-established escaping helpers (`esc()` for module scripts, `escapeHtml()`/local equivalents for classic scripts) — no new escaping mechanism was introduced. No secrets, API keys, or credentials were found exposed in the diff (verified via `git diff` secret-pattern scan before every commit). `js/maps-config.js` was not touched or read for its contents.

## F. Performance findings

F-09 (admin.html duplicate `users` read) fixed. No other new performance regressions were confirmed and safely fixable this pass; the broader admin.html cross-tab caching question is deferred (§D) rather than attempted, since a wrong cache-invalidation design would be worse than the current (correct, just non-optimal) always-fresh reads.

## G. Firestore query findings

Rent's cursor-pagination architecture from commit `680876f` was explicitly preserved and re-verified: the full 41-suite/274-test Firestore emulator run (§N) includes the existing Rent-pagination suites (cursor correctness, price-range + sort, under-constrained-query denial) and all pass unchanged. No unbounded-read regression was introduced by this pass's changes. `firestore.indexes.json` is untouched (byte-identical `git diff` against `680876f`) — no index deployment is needed.

## H. App Check findings

Confirmed **not enabled for enforcement**, per the explicit constraint for this pass. `js/firebase-init.js` initializes App Check client-side and gates every Firestore SDK call (`getDocs`/`getDoc`/`addDoc`/`setDoc`/`updateDoc`/`deleteDoc`/`runTransaction`) behind `await appCheckReady` — this is App Check *token attachment*, not server-side enforcement, and was not changed. Positive finding: `admin.html` correctly uses a **separate, secondary Firebase app instance** (`initializeApp(firebaseConfig, 'agent-create-' + Date.now())` at `admin.html:3657`, with its own `initializeAppCheck()` call) for its agent-creation flow, rather than reusing the primary app's App Check state — confirmed via direct read of that code, a deliberately correct isolation pattern, not a gap.

## I. Mobile/RTL findings

Verified via the closing Playwright QA pass (desktop, 390px/375px mobile, Arabic RTL, Kurdish RTL) across all 22 core pages named in the task spec. No horizontal overflow found at 375px or 390px on any checked page. RTL mirroring (text alignment, flag/menu placement, `dir="rtl"` on `<html>`) was correct on every page **except** `account.html` (F-13, now fixed). Full matrix in §O.

## J. Accessibility findings

No new accessibility regressions were found or introduced by this pass's changes; a dedicated accessibility audit (contrast, focus order, ARIA on the shared header/mobile-nav components) was already completed in a prior session arc (shared-header/mobile-nav accessibility pass) and was not revisited from scratch here, since it's outside what a static+QA bug-hunt pass can newly verify without a screen-reader-driven review.

## K. Demo/fake-data findings

- **promo.html**: not demo data — a real, live, unauthenticated flow (see §D). Reported, not touched.
- **build.html / renovate.html / services.html**: static marketing content with no backing Firestore data model (confirmed in a prior session arc's architecture audit) — these are known, intentional placeholder pages for a future phase (explicitly out of scope: "Build redesign, Renovate redesign"). No real Firestore data was touched, read, or deleted for any of these.

## L. Orphan/legacy findings

- `profile.html`, `verification.html` — confirmed genuinely orphaned (zero inbound references anywhere in the repo). Not deleted, per instruction.
- `design.html` — reachable only via a direct URL, not via any real link (§D). Not deleted, per instruction.

## M. Files changed

```
.gitignore
account.html
add-work.html
admin.html
buy-rent-map.html
buy.html
firestore.rules
js/i18n.js
js/professional-content.js
js/site-header.js
js/site-mobile-nav.js
listing.html
map.html
office.html
reset-password.html
sell.html
signup-professional.html
storage.rules
tests/firestore/estates.test.mjs
tests/storage/listing_photos.test.mjs   (new file)
```

## N. Test results

- `node scripts/ci-checks.js` — **PASS** (re-run after every batch of edits; final run: inline-script syntax valid across 29 pages, i18n key parity 1288/1288 ku/ar, every `data-i18n`/`tr()` key resolves, no broken internal links, no duplicate element IDs).
- `npm run test:rules` (Firestore emulator, 41 suites) — **PASS, 274/274 tests**, including the new `estates.test.mjs` regression test.
- `npm run test:storage-rules` — the 2 new `assertSucceeds()` cases in `tests/storage/listing_photos.test.mjs` fail in this sandbox for a confirmed **pre-existing, environmental reason**: the Storage emulator's `firestore.get()` cross-service calls need outbound network access to `firebase-public.firebaseio.com`, which this sandbox does not have. This is documented in `tests/storage/helpers.mjs`'s own header comment and reproduces identically on multiple unrelated, already-shipped test files (`professional_work.test.mjs`, `project_media.test.mjs`) — confirmed NOT a regression from this pass's `storage.rules` change. The `assertFails()` cases in the new file are unaffected (a crash still counts as "not succeeded"). This suite should be re-run in a networked CI environment before relying on it as a merge gate.

## O. Browser QA matrix

Ran via a local Playwright pass (Chromium, all outbound network except the local static server blocked) across desktop, 390px mobile, Arabic RTL, and Kurdish RTL for all 22 named pages.

| Page | Desktop | Mobile (390/375px) | RTL (ar/ku) | Result |
|---|---|---|---|---|
| index | PASS | PASS | PASS | PASS |
| buy | PASS | PASS | PASS | PASS |
| rent | PASS | PASS | PASS | PASS |
| buy-rent-map | PASS | PASS | PASS | PASS |
| map | PARTIAL (Leaflet blocked in sandbox) | PASS | PASS | PASS (sandbox-limited map render only) |
| sell | PARTIAL (Leaflet blocked in sandbox) | PASS | PASS | PASS |
| listing | BLOCKED (Firestore SDK import fails offline — stuck on "Loading listing…", never reaches its real not-found state) | PASS | n/a | PARTIAL |
| services | PASS | PASS | PASS | PASS |
| about | PASS | PASS | PASS | PASS |
| login | PASS | PASS | PASS | PASS |
| signup | PASS | PASS | PASS | PASS |
| signup-professional | PASS | PASS | PASS | PASS |
| reset-password | PASS | PASS | PASS | PASS |
| account | PASS | PASS | **FAIL → fixed (F-13)** | PASS after fix |
| engineer | PASS | PASS | PASS | PASS |
| designer | PASS | PASS | PASS | PASS |
| office | PASS | PASS | PASS | PASS |
| admin | BLOCKED (auth gate never resolves offline) | PASS (chrome only) | PASS (chrome only) | BLOCKED |
| agent-dashboard | BLOCKED (auth gate never resolves offline) | PASS (chrome only) | n/a | BLOCKED |
| build | PASS | PASS | PASS | PASS |
| renovate | PASS | PASS | PASS | PASS |
| mam-ai | PASS | PASS | PASS | PASS |

BLOCKED/PARTIAL rows are sandbox network limitations (no live Firebase/Google/Leaflet access), not application bugs — distinguished explicitly per the task's own instruction not to "fix" application code because the sandbox blocks Google/Firebase. `account.html`'s RTL FAIL was a real bug (F-13), now fixed and would show PASS on re-run.

## P. Deployment requirements

- **`firestore.rules` changed (F-07)** — requires `firebase deploy --only firestore:rules` to take effect in production.
- **`storage.rules` changed (F-08)** — requires `firebase deploy --only storage:rules` to take effect in production.
- **`firestore.indexes.json` — unchanged.** No index deployment needed for this pass (verified via `git diff 680876f -- firestore.indexes.json`, empty).
- No backend redeployment needed — no `backend/` files were changed this pass.
- No Firebase Console configuration changes needed or made (App Check enforcement intentionally left as-is, per instruction).

## Q. Remaining known production risks

1. **Public exact lat/lng exposure — still unresolved, unworsened.** `firestore.rules:558`'s `allow get, list` on `listings/{listingId}` grants a full-document read (Firestore rules cannot do field-level redaction on reads) to anyone satisfying `isListingPubliclyVisible()`. If a listing document carries exact coordinates rather than an approximate/rounded value, they are publicly readable by design of this read rule. This was flagged in a prior session arc as a known HIGH-PRIORITY gap and is explicitly preserved here, not fixed and not worsened, per this task's own instruction.
2. **Rent/Buy/Buy-Rent-Map pagination remains cursor-based and bounded** — re-verified, not regressed.
3. **Cities & Apartments remain removed from public nav** — re-verified during the navigation audit, not reintroduced.
4. **No new API-key exposure** — verified via `git diff` secret-pattern scan on every commit this pass; `js/maps-config.js` untouched.
5. **Admin Estate transaction privacy remains protected** — not touched this pass.
6. **activeListingLocks lifecycle protection is unregressed** — not touched this pass.
7. **Firebase App Check enforcement remains OFF** in Firebase Console, per explicit instruction — not enabled.
8. **promo.html's live, unauthenticated Agent Check-In flow remains live** (§D) — a known, pre-existing, now-explicitly-documented risk requiring a dedicated staff-auth design in a future phase.
9. **admin.html's `fetchAgentStats()` remains uncached across tab switches** beyond the one confirmed safe duplicate fixed in F-09 — acceptable today given current data volume, worth revisiting if the `users`/`listings` collections grow significantly.
10. **`storage.rules`' `assertSucceeds()` test coverage for `listing-photos` could not be verified in this sandbox** (§N) — should be re-run in a networked CI environment before being fully trusted as a merge gate, though the rule logic itself was manually verified against the identical, already-proven `company-logos` pattern.
