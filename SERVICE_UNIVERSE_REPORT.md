# Darwesh Group — Service Earth/Universe: Premium Interactive Services Discovery

**Date:** 2026-09-02
**Branch:** `claude/web-project-hqdo8o`
**Scope:** Rebuild `services.html` into an original, cinematic "Service Universe" connecting to Darwesh's real professional-service marketplace, plus the reusable discovery architecture it needed. Explicitly out of scope and not touched: MAM AI redesign, Unified Map consolidation, Build/Renovate redesign, exact-location privacy migration.

---

## A. Service architecture audit

Inspected `services.html`, `engineer.html`, `designer.html`, `design.html`, `office.html`, `work.html`, `add-work.html`, `js/profile-role.js`, `js/professional-content.js`, `signup-professional.html`, `firestore.rules` (`serviceProviders`, `professionalPosts`, `organizations` match blocks), and grepped the whole repo for `organizations` collection usage before writing a line of new code.

| Service domain | Status | Evidence |
|---|---|---|
| **Engineering** | REAL, but no directory (only single-profile view existed) | `firestore.rules:945` allows `serviceType=='engineer'`; `signup-professional.html:332` offers real signup; `engineer.html` (via `js/profile-role.js`) is a real, live, owner-editable, admin-verifiable profile page. No page listed *multiple* engineers before this pass. |
| **Interior/Architectural Design** | REAL + DISCOVERABLE (most mature) | Same `serviceProviders` schema, plus a full published-work system: `professionalPosts` collection, `design.html` (category-filtered discovery grid), `add-work.html` (publish/edit), `work.html` (detail page). |
| **Legal (Lawyer)** | REAL BUT PARTIAL | `firestore.rules:945` and `signup-professional.html:334` both support it fully; **no `lawyer.html` existed at all** and no directory. |
| **Landscaping** | REAL BUT PARTIAL | Same as Legal — schema + signup real, `signup-professional.html:335`; **no `landscaping.html` existed**. |
| **Cleaning** (individual/team/company) | REAL BUT PARTIAL | `firestore.rules:930-937,947` has the most detailed schema of all five (`providerType` individual/team/company, a fixed `servicesOffered` catalog of 9 real cleaning categories); `signup-professional.html:336-337` offers both individual and team/company signup; **no `cleaning.html` existed**. |
| **Maintenance/Repair** | NOT IMPLEMENTED | Zero matches anywhere for a `maintenance` serviceType. Not in the rules allowlist, no signup option, no collection. |
| **Moving/Transport** | NOT IMPLEMENTED | Same — no schema, no signup, no collection. |
| **Finance/Installments** | NOT IMPLEMENTED (for this purpose) | `organizations/{orgId}` exists ONLY as a `firestore.rules` match block from an earlier architecture-planning phase (confirmed via repo-wide grep: **zero** frontend files reference the `organizations` collection). No `finance_provider` UI, no signup, nothing queryable. |
| **Furniture/Home Goods** | NOT IMPLEMENTED | No `products`/`productCategories` collection exists in this repo at all — confirmed absent. |

Per this phase's explicit instruction ("Do NOT invent providers just to populate planets"), the four NOT IMPLEMENTED domains above are **excluded from the Universe's planet set entirely** — not shown as "coming soon" placeholders either, since that would still overstate what exists. They're documented here and in §Q as a known gap for a future phase.

## B. Final enabled planet list

Five planets, all REAL, defined in one place — `js/service-catalog.js` — so the set is trivially auditable and never duplicated in markup:

1. Engineering
2. Interior & Architectural Design
3. Legal
4. Landscaping
5. Cleaning

## C. Data source used by each service

All five read the same real, public-read `serviceProviders` collection (`firestore.rules:939`, `allow read: if true`), filtered by `serviceType`. Design's directory additionally reads the real `professionalPosts` collection (published work, category-filtered) via the already-existing `js/professional-content.js`. No data is invented, cached from a mock, or hardcoded — every card, count, and profile field traces to a real Firestore document.

## D. Dedicated destination for each planet

| Planet | First click (focus) | Second click / CTA (navigate) |
|---|---|---|
| Engineering | Shows panel with real title/tagline/live counts | `service.html?type=engineer` (new reusable directory) |
| Design | Shows panel | `design.html` (existing, richer published-work discovery — reused per this phase's explicit instruction to prefer existing architecture) |
| Legal | Shows panel | `service.html?type=lawyer` |
| Landscaping | Shows panel | `service.html?type=landscaping` |
| Cleaning | Shows panel | `service.html?type=cleaning` |

Each directory card then links to that provider's own profile page (`engineer.html`/`designer.html`/`lawyer.html`/`landscaping.html`/`cleaning.html`, all `?id=<providerId>`) — a real destination, never a dead link.

## E. Files created

- `js/service-catalog.js` — single source of truth for the 5 real planets (title/tagline/icon/destinations), with the audit reasoning for why exactly these five in its own header comment.
- `js/service-universe.js` — the orbital interaction engine (drag/swipe/wheel/keyboard/focus/panel/deep-link/reduced-motion/fallback).
- `css/service-universe.css` — all Universe + directory-page visual styling, built entirely from the existing `cine-scope`/`--cine-*`/`--ps-color-*` design tokens (no new palette introduced).
- `service.html` — the reusable provider-directory page (`?type=engineer|lawyer|landscaping|cleaning`), replacing what would otherwise have been 4 near-duplicate HTML files.
- `lawyer.html`, `landscaping.html`, `cleaning.html` — thin profile-view shells, each a ~15-line difference from `engineer.html`, all three reusing the exact same shared engine (`js/profile-role.js`'s `initServiceProviderProfile()`) that already powers `engineer.html`/`designer.html` — no new profile logic was written.
- `SERVICE_UNIVERSE_REPORT.md` — this report.

## F. Files modified

- `services.html` — removed the old "Core Capabilities" grid (8 generic real-estate categories with hotlinked `lh3.googleusercontent.com/aida-public/...` placeholder images and fabricated feature lists — itself a pre-existing demo-data issue this rebuild replaces) and its modal; added the Universe hero + mount point + always-present accessible list. Kept the real, working Browse-by-City, Smart Map promo, and MAM AI sections unchanged (not part of this rebuild's scope, still functioning, not removed).
- `js/firebase-init.js` — added one new wrapped export, `getCountFromServer`, following the file's own established App-Check-gating pattern exactly (used for the Universe's real provider-count stats, §I).
- `js/i18n.js` — added ~40 new `svc.*` keys plus `rp.role.lawyer/landscaping/cleaning` and `lawyer.*/landscaping.*/cleaning.*` tab/empty-state keys, in both `ku` and `ar` (parity verified by `ci-checks.js`).
- `css/cinematic.css` — added `.rp-hero--lawyer/landscaping/cleaning` and `.rp-fallback--lawyer/landscaping/cleaning` visual variants, matching the existing per-role procedural-texture pattern (no new visual language invented — same technique as the existing Engineer/Designer variants).

## G. Firestore queries introduced

All bounded, none added to `firestore.indexes.json` (deliberately — see reasoning below):

- `service.html`: one query per page load — `where('serviceType','==',type)` + `limit(60)`, no `orderBy` (a single equality filter with a cap needs no composite index; sorting, where wanted, is done client-side over the already-bounded 60-doc result).
- `js/service-universe.js`: **10 total** `getCountFromServer()` aggregation queries (2 per service — total count, verified count), run **exactly once** at page load, fully decoupled from the animation/render loop (see §I). A COUNT aggregation never downloads the matching documents.
- `services.html`'s pre-existing `loadCityApartmentCounts()` (Browse-by-City) is unchanged.

No new collection, no new index, no change to `firestore.rules` (all reads use its pre-existing public `serviceProviders`/`professionalPosts` read rules) — **no rules or index deployment is needed for this pass.**

## H. Security impact

- No `firestore.rules`/`storage.rules` changes. Every read goes through existing, already-audited public-read rules.
- All Firestore-sourced data (provider name, city, photo/logo URL, specialties) is rendered via `esc()`/manual escaping and `isSafeHttpUrl()` before touching `innerHTML` or an `<img src>` — the exact pattern the prior bug-hunt pass established, applied consistently in `service.html`'s new `providerCard()` renderer.
- No private/admin-only fields are read or shown (`serviceProviders`' public fields only — no `permissionOverrides`, no verification notes, no organization internals).
- No API keys, secrets, or `js/maps-config.js` were touched (verified via `git diff` secret-pattern scan before every commit).

## I. Performance strategy

- **Zero WebGL/canvas/animation library.** The whole Universe is CSS `transform`/`opacity` driven by one JS number (`orbitAngle`), positioned via plain 2D trigonometry (see the design-iteration note in §N) — no new dependency, no bundle-size impact, CSP-compatible with the existing meta-delivered policy (no new script/style origins needed).
- **Firestore reads are structurally isolated from rendering**: `js/service-universe.js` imports `firebase-init.js` **dynamically**, only inside its one-time `loadCounts()` call — not as a static top-level import. This was a real bug found during this pass's own QA (see §N): a static import would have failed the *entire* interactive layer (planets, drag, keyboard — none of which need Firestore) if the Firebase CDN were ever unreachable. The fix also makes `service.html`'s page shell resilient the same way.
- The drag/idle/snap loop only ever mutates CSS `transform`/`opacity` on already-built DOM nodes — no layout thrashing, no per-frame Firestore call, confirmed via the QA pass's console-error and network-request checks.
- Idle auto-orbit pauses via the Page Visibility API when the tab is hidden, and is skipped entirely under `prefers-reduced-motion`.
- Resize handling is `requestAnimationFrame`-throttled (one recompute per frame, not per pixel).

## J. Mobile behavior

Verified via Playwright at 390×844 (Arabic RTL) and 375/430px checks: drag/swipe rotates the ring naturally, the focused planet stays fully visible, the panel renders **in-flow below the stage** (not a fixed overlay — explicitly chosen so it can never cover the page on a small screen), the CTA button is 44px-tall (thumb-friendly), and — after a fix made during this pass's own QA (§N) — **zero horizontal page overflow** at any tested width.

## K. RTL/i18n results

All new user-visible strings use `data-i18n`/`tr()` with real `ku` and `ar` translations (parity verified by `ci-checks.js`: 1337 keys in both). RTL-specific handling: the prev/next chevron icons are mirrored via `[dir="rtl"] .su-nav-btn .material-symbols-outlined { transform: scaleX(-1); }` (a directional control, correctly mirrored per this phase's own instruction) while the orbit's own geometry — a left-right arrangement, not literal artwork — was verified to still read correctly in RTL without any special-casing needed. `service.html`'s back-link arrow is mirrored the same way.

## L. Accessibility results

- Every planet is a real `<button>` (not a styled `<div>`) with `role="option"`, `aria-selected`, and an `aria-label` set to the real translated service name — confirmed reachable via native Tab order, with Enter/Space working for free (native button semantics), plus explicit ArrowLeft/ArrowRight handling for faster browsing.
- Visible focus ring (`box-shadow: var(--ps-focus-ring)`) on every interactive element (planets, prev/next, panel close, filter chips).
- The accessible list (`#allServicesList`) is a plain set of real `<a>` links, always present in the DOM regardless of whether the 3D layer initializes — fully keyboard-usable on its own, never gated behind the interactive layer.

## M. Reduced-motion behavior

Verified via Playwright with `reducedMotion: 'reduce'`: the idle auto-orbit drift is fully suppressed (planet transform confirmed byte-identical across a 1.5s window), and `snapTo()` (used after a drag, wheel gesture, keyboard press, or prev/next click) skips its eased tween entirely and jumps straight to the target angle. Selection and navigation remain fully functional — only the continuous ambient motion and the large transition animations are removed, exactly as required.

## N. Browser QA results

QA was **not** a single pass — it caught three real bugs during this phase, each investigated and fixed before moving on (all verified via a local Playwright harness against the static site, same pattern used throughout this project):

1. **Static Firestore import could fail the entire interactive layer.** `js/service-universe.js` (and `service.html`) originally imported `firebase-init.js` at the top of the module. A failed/unreachable Firebase CDN request (this sandbox has none; a real ad-blocker or network hiccup would too) fails a static `import` before any of the importing module's own code runs — including a `try/catch` around `build()` that was supposed to be the "Fallback Mode" safety net. **Fixed** by moving both to a dynamic `import()` inside the one function that actually needs Firestore, matching this codebase's own established resilient pattern (`buy.html`'s `loadCityApartmentCounts()`).
2. **`setPointerCapture` silently broke every planet click.** The original drag handler captured the pointer on `pointerdown`, which redirects the browser's synthesized `click` event away from the actual button under the pointer — so first-click-to-focus never fired. **Fixed** by removing pointer capture and distinguishing a drag from a click with a small movement threshold instead (the standard, robust technique) — verified via a real simulated mouse drag (front planet correctly advances one step) and via a sub-threshold "click with jitter" (still registers as a click).
3. **Two design/rendering bugs found via screenshot review**, not caught by functional tests alone: (a) the front planet always sat exactly on top of the Darwesh Core, permanently hiding it — fixed by vertically separating the Core (above) from the orbit band (below); (b) a nested `rotateY`/`translateZ`/counter-rotate "billboard" 3D technique rendered the two outermost planets as degenerate paper-thin slivers, and separately those same two planets overlapped their neighbors because `sin(angle)` isn't monotonic past 90° with 5 planets at 72° spacing — fixed by replacing the whole positioning scheme with plain, monotonic 2D trigonometry (`x = (rel/180) * radiusX`), which is both mathematically simpler to verify and visually correct.
4. **A real mobile-overflow bug** (17px horizontal scroll on a 390px viewport in Arabic) traced to side planets painting outside the stage's box during the initial 3D approach — fixed with `overflow: hidden` on the stage container, then reverified at 0px after the full positioning rewrite.

Final state, confirmed via Playwright: 5 planets render; first click focuses (real title/tagline/honest fallback copy since the sandbox has no Firestore); second click on the same planet navigates to its real directory URL; ArrowRight/Enter keyboard flow works; deep-link `?service=lawyer` correctly pre-focuses Legal; a real drag gesture rotates the ring by exactly one step; Prev/Next buttons work and are reversible; reduced-motion freezes the idle drift; mobile Arabic RTL shows `dir="rtl"`, 0px horizontal overflow, and a working focus/close flow; zero console errors across every page and condition tested, including `service.html?type=bogus` (shows the real "unknown type" state, not a crash) and `lawyer.html`/`landscaping.html`/`cleaning.html` (render their real header/nav; the profile content itself stays on its loading state in this sandbox because `js/profile-role.js`'s Firestore dependency is a pre-existing, already-shipped static import shared with `engineer.html`/`designer.html` — a documented sandbox limitation, not a regression introduced here).

## O. Test results

- `node scripts/ci-checks.js` — **PASS** (inline script syntax valid across 33 pages, i18n parity 1337/1337 ku/ar, every `data-i18n`/`tr()` key resolves, no broken internal links — confirming every new page-to-page link this phase added, e.g. `service.html?type=engineer`, `lawyer.html`, resolves to a real file — no duplicate element IDs).
- `npm run test:rules` — **PASS, 274/274** (run as an explicit regression check per this phase's own instruction, since `firestore.rules` was not touched — confirms this pass introduced no rules regression).
- `node --check` on both new `.js` module files — clean syntax.
- Local Playwright QA — see §N for the full narrative; final state is a clean pass across desktop, mobile (390px, Arabic RTL), keyboard, deep-link, reduced-motion, and drag/prev-next interaction.

## P. Known limitations

- **`serviceProviders` currently has no real production data to browse** (this is a brand-new feature on a fresh collection) — every directory/panel honestly shows "Explore available professionals" / "No verified providers are available yet" rather than a fabricated count, exactly as instructed. This is expected launch-day behavior, not a bug.
- **This sandbox has no outbound network access to Firebase**, so the live count stats and directory listings could not be verified against real data end-to-end here — only their fallback/error paths were verified. The query shapes themselves were manually verified against the exact same, already-proven rule (`allow read: if true`) and pattern (`where` + `limit`, no `orderBy`) used elsewhere in this codebase.
- **No image/portfolio upload exists yet for Lawyer/Landscaping/Cleaning** (same limitation `engineer.html`/`designer.html`'s own profile already documents — `storage.rules` has no service-provider media path this phase; out of scope, not something this pass was asked to add).
- `service.html`'s directory is a single bounded read (up to 60 providers, no cursor pagination) — reasonable for a launch with zero-to-few real providers per category; would need real cursor pagination if any one category ever exceeds that.

## Q. Deferred future work

- Cursor-paginated `service.html` directory, once a category's real provider count approaches the 60-doc bound.
- Maintenance/Repair, Moving/Transport, Finance/Installments, and Furniture/Home Goods planets — all confirmed NOT IMPLEMENTED (§A), would each need their own schema/signup/rules work (a `finance_provider`/`furniture_store` build-out on the already-designed-but-never-implemented `organizations` collection, or new collections entirely) before they could honestly become real planets.
- Image/portfolio uploads for the three new service types (Lawyer/Landscaping/Cleaning), mirroring what a future phase might add for Engineer/Designer.
- Real analytics wiring for the `darwesh:analytics` CustomEvents this phase already emits (`service_focus`, `service_open`) — structured and ready, no vendor connected per instruction.

---

## Deployment safety

`git status`/`git diff` reviewed before every commit: no `backend/env.yaml`, no `js/maps-config.js`, no API keys or secrets, no scratch/debug files, no Playwright screenshots committed. `firestore.rules`, `storage.rules`, and `firestore.indexes.json` are all **untouched** this pass — **no manual deployment is required.**
