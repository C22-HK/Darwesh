# Infrastructure & Deployment Remediation (Stage 5 Remediation)

## Round 1 scope (commit `b903411`)

**INFRA-01 through INFRA-04**, per explicit request. INFRA-01 and
INFRA-04 were fixed; INFRA-02 and INFRA-03 could not be safely
implemented from that session's sandbox (no egress to any asset CDN)
and were documented as blocked.

## Round 2 scope (this document, current)

Per explicit follow-up request, with two findings now confirmed
production-verified by you directly (not retested here, per instruction):

- **INFRA-05** (Cloud Run secrets delivery) — **confirmed production-verified**: `OTP_HMAC_SECRET` and `RESEND_API_KEY` are injected via Secret Manager `secretKeyRef`, not plain env vars. Matches the stronger, more auditable pattern `INFRASTRUCTURE_SECURITY_REVIEW.md` recommended. No code or doc change needed beyond marking it closed (below).
- **INFRA-10** (production response headers) — **confirmed production-verified**: `GET /api/v1/health` returns 200 with `x-content-type-options: nosniff`, `referrer-policy: no-referrer`, and `strict-transport-security: max-age=63072000; includeSubDomains` present. Matches `_SecurityHeadersMiddleware`'s code exactly.
- **INFRA-01** — re-reviewed in depth (transaction atomicity, failure modes, clock handling, cost/abuse risk, cleanup strategy) and hardened further; one real gap found and fixed (see below).
- **INFRA-02** — this session's sandbox has different, broader CDN reachability than the one that blocked it in round 1 (`registry.npmjs.org` reachable; `fonts.googleapis.com`/`fonts.gstatic.com` reachable; `unpkg.com`/`cdn.jsdelivr.net`/`www.gstatic.com`/`cdn.tailwindcss.com` still blocked, confirmed directly). Applied SRI where it's realistically safe, and documented two genuine, permanent exceptions rather than forcing SRI where it doesn't apply.
- **INFRA-03** — Tailwind is now self-hosted, built locally from a pinned `tailwindcss@3.4.19` via a committed config, replacing the unpinned Play CDN script entirely. No CDN dependency remains for it at all — a stronger outcome than merely pinning the CDN URL, and one the original finding named as the more thorough fix.
- **INFRA-09** — least-privilege `permissions:` block added to CI.

INFRA-06, INFRA-07, INFRA-08 remain out of scope for both rounds
(hardening-only/deliberate staged rollout, GitHub Pages header
limitation, and HSTS preload decision respectively — none requested).

---

## INFRA-05 — Backend secrets-delivery mechanism (production-verified)

- **Status**: **VERIFIED SAFE IN PRODUCTION** (you confirmed directly; not retested here per instruction)
- **Confirmed state**: `OTP_HMAC_SECRET` and `RESEND_API_KEY` on the live `darwesh-backend` Cloud Run revision are Secret Manager-backed (`secretKeyRef`), not plain environment variables.
- **Action**: None needed. This closes the one open question `INFRASTRUCTURE_SECURITY_REVIEW.md` flagged for INFRA-05.

---

## INFRA-10 — Production HTTP response headers (production-verified)

- **Status**: **VERIFIED SAFE IN PRODUCTION** (you confirmed directly; not retested here per instruction)
- **Confirmed state**: `GET /api/v1/health` → `200`, carrying `x-content-type-options: nosniff`, `referrer-policy: no-referrer`, `strict-transport-security: max-age=63072000; includeSubDomains`.
- **Action**: None needed. This closes the one open question `INFRASTRUCTURE_SECURITY_REVIEW.md` flagged for INFRA-10.

---

## INFRA-01 — Rate limiting: re-review + hardening (round 2)

Round 1 (commit `b903411`) already replaced the in-memory-only
`RateLimiter` with a `Protocol` (`RateLimiter`) plus two implementations
(`InMemoryRateLimiter` for dev/test, `FirestoreRateLimiter` for
production), wired into every rate-limited endpoint by
`cfg.is_production`, backed by a real Firestore transaction. This round
re-reviewed that implementation against each concern raised and made one
real fix.

### Re-review findings

| Concern | Finding |
|---|---|
| **Multi-instance safety under Cloud Run autoscaling** | Confirmed correct. `FirestoreRateLimiter` reads/writes a shared Firestore document per `{name}__{key}`, not process memory — two independently-constructed clients (standing in for two Cloud Run instances) see each other's writes immediately, re-verified this round (see Tests below). |
| **Transaction atomicity / race conditions** | Confirmed correct. The read-check-append-write is one `@fb_firestore.transactional` function — two concurrent callers on the same key can never both slip past a limit already at capacity, re-verified under both realistic (4-way) and extreme (10-way) concurrency this round. |
| **TTL / expiry behavior** | Correct and unchanged: correctness never depends on Firestore's own TTL deletion — the read-side pruning (`kept = [t for t in existing if t > cutoff]`) ignores stale timestamps regardless of whether the document has physically been deleted yet. Each document carries an `updatedAt` field for a native TTL policy as storage hygiene only. **Not yet configured** (a Console/`gcloud` action, not code) — exact command below. |
| **Clock handling** | Uses `time.time()` (wall clock), correctly — `time.monotonic()` (what `InMemoryRateLimiter` uses) has no defined relationship across separate processes, only within one. Residual, accepted assumption: this depends on Cloud Run instances' clocks being reasonably NTP-synced, which is a standard property of the underlying infrastructure, not something this code can control or needs to — the same assumption every wall-clock-based distributed rate limiter makes. |
| **Failure modes** | **Real gap found and fixed.** The transaction's exception handler only caught `(google_api_exceptions.Aborted, ValueError)` — narrow enough that a genuine Firestore-side error *other* than a lost transaction race (a transient outage, `DeadlineExceeded`, a retry-budget exhaustion below the API-call layer) would have escaped uncaught, propagated out of the awaiting HTTP handler, and surfaced as an unhandled 500 instead of the same clean "denied, logged, fail closed" outcome contention already got. **Fixed**: broadened to `google_api_exceptions.GoogleAPIError` — the true common base class covering both `GoogleAPICallError` (an actual error response) and `RetryError` (retries exhausted before one was ever received), two separate exception families under `google-api-core` that a narrower catch would have missed. Either way — contention or a broader outage — the endpoint still fails closed: it never proceeds to the real work (sending an email, resolving a UID) on a failed check, so there is no path where a Firestore-side failure here lets more requests through than intended, only a path where it makes the endpoint briefly unavailable rather than silently over-permissive (the safer of the two failure directions for a rate limiter). |
| **Firestore contention** | Verified empirically, not just reasoned about — see Tests below. Under realistic concurrency (a handful of simultaneous requests, well under the configured limit) contention alone never causes a false deny. Under deliberately extreme contention (10-way against `limit=5`, far beyond this endpoint's real production concurrency) some requests correctly get denied by the fail-closed path rather than ever letting more than 5 through. |
| **Cost-abuse risk** | **Documented, not fixed** (an accepted architectural tradeoff, not a bug): every `allow()` call is one Firestore transaction — one read plus one write (each retry adds another). At scale, this is itself a real, billable resource the rate limiter consumes on every request, including requests it goes on to deny — meaning a determined attacker generating pure rate-limited traffic still costs real Firestore read/write operations, not nothing. This is bounded (denied requests still terminate immediately, at one transaction, not the far more expensive email-send or Firebase-Admin calls those requests were trying to reach) but not zero. No code change proposed for this round — mitigating it further (e.g. a cheaper pre-check, a WAF/Cloud Armor layer in front) is a genuine architectural decision, not something to guess at here. |
| **Cleanup strategy** | `updatedAt` field is present and ready for a TTL policy; the policy itself is a one-time Console/`gcloud` action, not yet applied: `gcloud firestore fields ttls update updatedAt --collection-group=rateLimits --enable-ttl` (mirrors the exact command `app/otp/store.py`'s own docstring already gives for `otpChallenges`/`otpResetTokens`'s `expiresAt` field). Not required for correctness (see TTL/expiry row above) — purely storage hygiene, so left as a manual step rather than something this session can run. |
| **Fail-open / fail-closed** | Confirmed fails closed in every failure path after this round's fix — no path was found (or now remains) where a Firestore-side error results in a request being allowed through that should have been denied. |
| **All 4 flows use the shared limiter correctly** | Confirmed by direct code read: `app/main.py`'s `build_auth_handler` (forgot-password) and `build_email_otp_handlers` (email-OTP send/verify/signup-complete) both branch on `cfg.is_production` to select `FirestoreRateLimiter` vs. `InMemoryRateLimiter` for every limiter they construct — no call site anywhere constructs `InMemoryRateLimiter` unconditionally outside that branch. Grepped for every `RateLimiter(` / `.allow(` call site in `app/`; none fall back to in-memory-only. |

### Fix applied this round

`backend/app/auth/reset.py` — `FirestoreRateLimiter.allow()`'s exception
handler widened from `(google_api_exceptions.Aborted, ValueError)` to
`(google_api_exceptions.GoogleAPIError, ValueError)`, with the class
docstring updated to explain why. No behavior change for the contention
case already covered (`Aborted` is a subclass of `GoogleAPIError`, so
still caught) — purely additive coverage for failure modes that
previously weren't.

### Tests (round 2)

- **New committed regression file**: `backend/tests/test_ratelimiter_firestore_emulator.py` — formalizes this round's (and round 1's) one-off emulator scratch scripts into permanent, skippable pytest coverage (`pytest.mark.skipif` when `FIRESTORE_EMULATOR_HOST` isn't set — CI has no Firestore emulator, the same constraint `app/otp/store.py`'s `FirestoreChallengeStore` already lives with). Five tests, all run and passing against a real local Firestore emulator this round:
  - Limit is shared and enforced across two independently-constructed clients (two "instances").
  - Two different limiter `name`s never share state for the same key.
  - An entry outside the window is pruned and stops counting.
  - Realistic concurrency (4-way, well under the limit) across two instances: no false denies.
  - Extreme concurrency (10-way against `limit=5`): never raises, never allows more than 5 through.
- Confirmed these 5 tests are correctly **skipped** (not failed, not silently absent) when no emulator is configured — the exact condition CI runs under.
- Full backend suite: **144 passed, 5 skipped** (the new emulator-only file) under CI-equivalent conditions; **149 passed** when run with `FIRESTORE_EMULATOR_HOST` set locally.
- `ruff check` / `ruff format --check`: clean.

---

## INFRA-02 — CDN integrity audit (round 2 — was blocked in round 1)

Full inventory of every external `<script src=...>` / `<link href=...>`
across all 21 HTML pages, decided per-dependency rather than applying
SRI uniformly:

| Dependency | Where | SRI applied? | Reasoning |
|---|---|---|---|
| **Leaflet** (`unpkg.com/leaflet@1.9.4`) | `admin.html`, `agent-dashboard.html`, `listing.html`, `map.html`, `sell.html` (both `.css` and `.js`) | **Yes** | Already version-pinned, single-file, no dynamic child-module imports — exactly the case SRI is designed for. |
| **Tailwind** (was `cdn.tailwindcss.com`) | All 21 pages | **N/A — dependency removed entirely** | Self-hosted this round (INFRA-03 below); SRI protects a resource fetched from a separate, potentially-compromised origin, and there is no longer a separate origin serving this file — it ships from the same repo/origin as the page itself. Eliminating the CDN dependency is a strictly stronger outcome than pinning+hashing it would have been. |
| **Firebase SDK** (`gstatic.com/firebasejs/12.18.0/...`) | Loaded via ES module `import` statements *inside* `js/firebase-init.js` and other local `.js` files — never as an HTML `<script src="https://...">` tag | **Not applied — justified exception** | SRI's `integrity` attribute only covers a `<script>` tag's own fetch; it has no native mechanism for verifying bare `import ... from "https://..."` statements inside a module's own source (that would need Import Maps with integrity metadata bound to bare specifiers, a materially larger restructuring of how every page loads Firebase — not attempted here). The version is already pinned (`12.18.0`) identically everywhere it's used, and `gstatic.com` is first-party Google infrastructure (Firebase's own CDN), a different trust tier than a third-party CDN — this is the realistic ceiling for this loading pattern without a larger architecture change. |
| **Google Fonts** (`fonts.googleapis.com/css2?...`) | All 21 pages, `<link rel="stylesheet">` | **Not applied — justified exception** | Confirmed reachable from this sandbox and fetched directly (unlike round 1's blocked sandbox) — but Google Fonts' CSS API deliberately returns **different CSS per requesting User-Agent** (different `@font-face src` URLs/formats depending on the visitor's browser), by design, so any single hash computed here would not match what most real visitors' browsers actually receive. Applying SRI to a knowingly UA-negotiated response is not a safety measure, it's a guaranteed breakage for some fraction of real visitors — this is a widely-documented reason Google itself doesn't publish SRI hashes for the Fonts API. Self-hosting the font files instead would remove this constraint, but is a materially larger content change (downloading and committing binary font files for every family/weight combination in use, rewriting every `@font-face`) than "smallest safe option" calls for here — left as a genuine, larger follow-up if wanted, not attempted this round. |
| `fonts.googleapis.com`, `fonts.gstatic.com` (bare, `rel="preconnect"`) | `profile.html`, `rent.html` | **N/A** | Preconnect hints establish a connection only — they don't fetch or execute content, so SRI doesn't apply. |
| `lh3.googleusercontent.com` (various) | Several pages, `<img src>` | **N/A** | SRI only applies to `<script>`/`<link>` fetches, not images — and these are per-user dynamic content (profile photos) that couldn't be pinned/hashed meaningfully regardless. |
| Social media links (Facebook/Instagram/Threads/TikTok) | Footer `<a href>` | **N/A** | Plain navigation links, nothing is fetched/executed. |

### How the Leaflet hash was computed

`unpkg.com` is blocked from this sandbox (confirmed: `curl` fails with
`CONNECT tunnel failed, response 403` at the proxy's tunnel stage,
before ever reaching unpkg's real servers) — the same block round 1
hit. `registry.npmjs.org` **is** reachable, and is the authoritative
source unpkg is documented to serve npm package contents from,
unmodified. Method used, fully reproducible:

```bash
npm install leaflet@1.9.4 --no-save   # into a scratch directory
openssl dgst -sha384 -binary node_modules/leaflet/dist/leaflet.js  | openssl base64 -A
openssl dgst -sha384 -binary node_modules/leaflet/dist/leaflet.css | openssl base64 -A
```

The fetched `dist/leaflet.js`'s own version banner confirms `Leaflet
1.9.4` — the exact version already pinned in every affected page's URL.
Resulting hashes, applied to all 5 pages:

- `leaflet.css`: `sha384-sHL9NAb7lN7rfvG5lfHpm643Xkcjzp4jFvuavGOndn6pjVqS6ny56CAt3nsEVT4H`
- `leaflet.js`: `sha384-cxOPjt7s7Iz04uaHJceBmS+qpjv2JkIHNVcuOrM+YHwZOmJGBXI00mdUXEq65HTH`

**Residual risk, stated plainly**: this assumes unpkg serves the exact
same bytes npm publishes for this version — unpkg's own documented
behavior, and the reason it's usable as a CDN at all, but not something
this session could independently confirm by fetching from unpkg
directly (it's blocked). If you have real network access, the cheapest
independent check is `curl -sI https://unpkg.com/leaflet@1.9.4/dist/leaflet.js`
and confirming the page still loads Leaflet correctly after this
deploy — a hash mismatch would show up immediately and loudly (the map
simply wouldn't render, with a `Failed to find a valid digest` in the
browser console), not silently.

### Tests

- Repo-wide grep confirms exactly 5 pages load Leaflet, all 5 now carry
  matching `integrity`/`crossorigin` attributes on both the `.css` and
  `.js` tag — verified the CSS hash and JS hash weren't accidentally
  swapped between the two tags (an early draft of this edit had them
  backwards; caught and fixed before committing).
- Rendered `map.html`, `admin.html`, `agent-dashboard.html`, `sell.html`,
  `listing.html` locally (Playwright/Chromium) — page structure and
  non-Leaflet styling intact; Leaflet's own tiles/markers couldn't be
  exercised end-to-end in this sandbox since `unpkg.com` itself is
  blocked here (the browser can't fetch the real file to validate the
  hash against, for the same reason `curl` can't) — this is an inherent
  sandbox limitation, not a gap in the hash computation method above.

---

## INFRA-03 — Tailwind self-hosted, unpinned CDN removed entirely (round 2 — was blocked in round 1)

- **Status**: **FIXED** — more thoroughly than the originally-scoped "pin
  the CDN version" fix: the CDN dependency is gone completely, replaced
  with a locally-built, committed static stylesheet.

### Why self-hosting instead of pinning the CDN URL

Round 1 was blocked because `cdn.tailwindcss.com` itself is unreachable
from that sandbox, so even a *pinned* CDN URL couldn't be verified
before shipping. This round's sandbox has `registry.npmjs.org` reachable
(same allowlist as always — package registries, not asset CDNs), which
makes the *actually* recommended fix in the original
`INFRASTRUCTURE_SECURITY_REVIEW.md` finding buildable without needing
`cdn.tailwindcss.com` at all: *"a bundled/built Tailwind (removing the
CDN dependency entirely) would be the more thorough fix."* Also matches
this round's own instruction to prefer a locally generated static build
over pinning a CDN version.

### What changed

- **`tailwind.config.js`** (new, root) — `content: ["./*.html",
  "./js/**/*.js"]`, `darkMode: "class"`, and a `theme.extend` block
  copied verbatim from the `tailwind.config` object every page
  previously embedded inline for the Play CDN to read at runtime.
  Confirmed byte-for-byte identical custom theme (colors, spacing,
  fontFamily, fontSize) across all 21 pages before consolidating to one
  file — the 21 inline blocks differed only in whitespace/key-ordering,
  never in content. Plugins: `@tailwindcss/forms@0.5.11`,
  `@tailwindcss/container-queries@0.1.1` — the same two the CDN URL's
  `?plugins=forms,container-queries` query string requested.
- **`css/tailwind-src.css`** (new) — the 3-line `@tailwind base;
  components; utilities;` entrypoint Tailwind's CLI builds from.
- **`css/tailwind.css`** (new, committed, minified, ~57KB) — the actual
  built output. Committed rather than built in CI because this is a
  static site with **no build/deploy step at all** — GitHub Pages
  serves whatever's in the repo directly, so the final CSS has to
  already exist in the tree, the same reason this codebase has
  consistently avoided introducing a build step elsewhere (per
  `scripts/ci-checks.js`'s own header comment: *"no build step, no
  framework"*). Regenerate after any markup/config change with `npm
  install && npm run build:css`.
- **`package.json` / `package-lock.json`** (new, root) — pinned exact
  versions (`tailwindcss@3.4.19`, matching the latest available 3.x at
  build time — this codebase's existing Play CDN usage was v3-style, so
  staying on v3 rather than migrating to Tailwind v4's materially
  different CDN/build model was the smaller, lower-risk move).
  **Build-time only** — nothing in `package.json` runs at request time
  or is needed by the deployed site; no Node process runs in
  production, matching the instruction not to introduce Node tooling
  into runtime.
- **All 21 HTML pages**: `<script src="https://cdn.tailwindcss.com?plugins=forms,container-queries"></script>`
  replaced with `<link href="css/tailwind.css" rel="stylesheet"/>`; the
  now-dead `<script id="tailwind-config">tailwind.config = {...}</script>`
  block removed from each (config is baked into the build output, so a
  runtime config object has nothing left to configure).
- **`.gitignore`** (new, root) — `node_modules/`, so the installed
  dependency tree itself is never committed.

### Class-coverage risk, checked before trusting the build

Tailwind's JIT scanner only outputs a class if the literal string
appears somewhere in a `content`-matched file. Audited every dynamic
`class="..."`/`className` site across all HTML and JS for **true**
runtime string construction (e.g. `` `bg-${color}-500` ``, which the
scanner cannot see) versus a ternary between complete literal strings
(which it can, regardless of which branch executes) — found only the
latter pattern everywhere in this codebase (e.g. `l.dealType === 'sale'
? 'badge-sale' : 'badge-rent'`, `l.verified ? 'pin-verified' :
'pin-unverified'`). `content` includes every `.html` and every
`js/**/*.js` file, so every literal class string in this codebase is
scanned regardless of which JS branch actually runs at request time.

### Tests

- `npx tailwindcss -i css/tailwind-src.css -o css/tailwind.css --minify` — builds clean, no errors.
- Spot-checked the built CSS contains real selectors for the custom
  theme (`.bg-primary`, `.text-on-surface`, `.font-body-md`,
  `.text-body-md`, `.rounded-full`) and for the forms plugin's base
  reset (`appearance:none` present, applied globally to form controls).
  Confirmed container-queries-plugin output (`@container`/`@sm:` etc.)
  is correctly absent — no page in this codebase actually uses
  container-query syntax, so the Play CDN would never have generated
  anything for it either; this is not a regression.
- **Rendered 4 representative pages with a real headless browser**
  (Playwright/Chromium, served locally over plain HTTP) and visually
  confirmed: `index.html` (hero, cards, colors, gold accent button all
  correct), `login.html` (card layout, form-plugin checkbox styling,
  button colors correct), `buy.html` (filter pills, toggle buttons,
  dropdowns correct), `admin.html` (auth-gated "Loading…" state
  correctly styled, confirming the stylesheet loads even there). The
  only visual gaps (icon-font glyphs showing as literal text, map
  tiles/Firestore data missing) are this sandbox's own network block on
  Google Fonts/Leaflet/Firebase in a headless browser — unrelated to
  this change and present before it too.
- `node scripts/ci-checks.js` — passes (one unrelated, pre-existing
  failure found and confirmed present on `b903411` *before* this
  round's changes too — see "Pre-existing issue found, not fixed"
  below).
- Repo-wide `grep -rn "cdn.tailwindcss.com"` across every `.html`/`.js`
  file: **zero matches**. No unversioned (or any) Tailwind CDN reference
  remains anywhere in the codebase.

### Deployment

Frontend-only change. GitHub Pages serves the repo directly — once this
branch is merged/deployed the same way the frontend always has been (no
separate build step to run), `css/tailwind.css` and the updated HTML
ship automatically. Nothing to run manually beyond the normal frontend
publish process already in place.

---

## INFRA-09 — CI workflow least-privilege token permissions

- **Status**: **FIXED**
- **Fix**: `.github/workflows/ci.yml` — added a top-level `permissions: contents: read` block. Neither job (`checks`, `backend`) does anything beyond `actions/checkout@v4`'s own read (no PR comments, no releases, no pushes, no third-party action that writes with this token), so `contents: read` is the correct least-privilege default; a future job needing more should set its own job-level `permissions:` to just what it needs, per the comment left in the file.
- **Tests**: YAML re-parsed with `yaml.safe_load` after the edit — valid; confirmed `permissions: {contents: read}` present and both jobs still listed.

---

## Pre-existing issue found, not fixed (out of scope)

`node scripts/ci-checks.js` reports one failure on this branch:
`admin.html: i18n key(s) used but not defined in js/i18n.js:
admin.submissionAlreadyConverted`. **Confirmed pre-existing** — present
identically on `b903411` before any of this round's changes (verified
by stashing this round's diff and re-running the check). Not touched by
anything in this remediation (no i18n keys were added, removed, or
edited by any change here) and out of scope for an infrastructure
remediation — flagged here for visibility rather than silently left
unmentioned, not fixed.

---

## Regression results (this round)

- Backend: `pytest` — **144 passed, 5 skipped** (new Firestore-emulator-only file, correctly skipped under CI-equivalent conditions with no `FIRESTORE_EMULATOR_HOST` set) — **149 passed, 0 skipped** when run against a real local Firestore emulator.
- Backend: `ruff check app tests scripts` / `ruff format --check app tests scripts` — clean.
- Frontend: `node scripts/ci-checks.js` — passes except the one confirmed-pre-existing, unrelated i18n gap above.
- CI workflow YAML: re-parsed and valid after the INFRA-09 edit.
- Firestore/Storage rules: **unchanged this round** — `firestore.rules`/`storage.rules` carry no diff against `b903411`, so no rules-emulator regression run was needed (nothing new to test; the existing rules suite from prior stages already covers current rules content).
- Repo-wide search: zero remaining `cdn.tailwindcss.com` references anywhere in the tree.
- Leaflet SRI: hash values double-checked against the exact npm-published `leaflet@1.9.4` package files after catching and fixing an initial CSS/JS hash swap.

## Production deployment status (this round)

| Finding | Code change | Deployed to production? |
|---|---|---|
| INFRA-01 (hardening) | Yes (`backend/app/auth/reset.py` exception handling) | **No** — bundled into the same not-yet-deployed backend change as round 1; needs the same Cloud Run redeploy |
| INFRA-02 | Yes (5 HTML pages, Leaflet SRI) | **No** — frontend-only; ships on the next GitHub Pages publish, no separate deploy step |
| INFRA-03 | Yes (21 HTML pages + new `css/`, `tailwind.config.js`, `package.json`) | **No** — same as INFRA-02, ships on the next GitHub Pages publish |
| INFRA-09 | Yes (`.github/workflows/ci.yml`) | Takes effect on the next CI run automatically — no manual deploy step |
| INFRA-05 | N/A — verified, not changed | Already live (you confirmed) |
| INFRA-10 | N/A — verified, not changed | Already live (you confirmed) |

**No Cloud Run redeploy or `firestore.rules` publish was performed by
this session**, per explicit instruction. The backend code change
(INFRA-01's broadened exception handling) is bundled with round 1's
still-undeployed Firestore-backed rate limiter — one Cloud Run redeploy
covers both once you're ready to run it yourself.

---

Stopping here — INFRA-06, INFRA-07, INFRA-08 remain out of scope,
unchanged from the review. Stage 6 not started, per instruction.
