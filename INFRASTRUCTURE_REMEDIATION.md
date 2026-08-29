# Infrastructure & Deployment Remediation (Stage 5 Remediation)

Scope: **INFRA-01 through INFRA-04 only**, per explicit request. INFRA-05
through INFRA-10 are unchanged from `INFRASTRUCTURE_SECURITY_REVIEW.md` —
either genuinely not testable from this sandbox (INFRA-05, INFRA-10),
hardening-only with no current abuse path (INFRA-06, INFRA-09), or a real
infrastructure/hosting-migration decision out of scope for a code change
(INFRA-07, INFRA-08).

Of the four in scope, two were fixed and validated; two could not be
safely implemented from this sandbox and are documented below with exact
steps to close them.

---

## INFRA-01 — Rate limiting is per-instance, in-memory, with no cross-instance coordination

- **Status**: **FIXED** (backend code change; needs a Cloud Run redeploy to take effect in production — see "Deployment" below)
- **Root cause** (from the review): `RateLimiter` was a plain in-process `dict` guarded by a `threading.Lock` — correct only for a single backend instance. Cloud Run autoscales by default, so the *effective* limit for an attacker distributing requests across instances silently became `(configured limit) × (instance count)`.

### Fix

Followed the exact architectural precedent this codebase already
established for the same problem in `app/otp/store.py`
(`ChallengeStore`/`InMemoryChallengeStore`/`FirestoreChallengeStore`):

- `app/auth/reset.py`:
  - `RateLimiter` is now a `Protocol` (`async def allow(self, key: str) -> bool`), not a concrete class.
  - `InMemoryRateLimiter` — the old implementation, renamed, `allow()` made `async` (no behavior change otherwise; still process-local, still keyed by an arbitrary string, still uses `time.monotonic()` since it never needs to compare against another process).
  - `FirestoreRateLimiter` — new. Shared, atomic, cross-instance-safe fixed-window limiter backed by Firestore via the Admin SDK (never the client SDK). Each instance is constructed with a `name` that namespaces its keys from every other `FirestoreRateLimiter` sharing the collection (e.g. the email-OTP send endpoint's IP limiter and its verify endpoint's IP limiter both key on the caller's IP — without a namespace they'd silently share one counter). Uses `time.time()` (wall clock), not `time.monotonic()` — monotonic time has no defined relationship across separate processes. The read-check-append-write is a single Firestore transaction, same pattern as `FirestoreChallengeStore.record_failed_attempt`. On transaction-retry-budget exhaustion under extreme contention it **fails closed** (denies the request) rather than open — unlike `ChallengeStore`, where failing "safe" means denying one operation, silently letting an unbounded burst through here would defeat the whole point of a rate limiter.
- `app/auth/firebase_reset.py` — `FirebaseResetLinkGenerator` gained a `firestore_client` property (mirrors `FirebaseAccountOps.firestore_client`) so `build_auth_handler` has a Firestore client to hand its limiter, without opening a second client.
- `app/main.py` — `build_auth_handler` and `build_email_otp_handlers` now select `FirestoreRateLimiter` in production (`cfg.is_production`) and `InMemoryRateLimiter` otherwise, exactly mirroring the existing `ChallengeStore` selection. Five limiters total, each with its own `name`: `forgot_password_ip`, `email_otp_send_email`, `email_otp_send_ip`, `email_otp_verify_ip`, `email_otp_complete_ip`. Limits/windows are unchanged from before.
- `app/otp/email_handler.py`, `app/otp/handler.py` — the 7 call sites now `await self.<x>_limiter.allow(...)`.
- `firestore.rules` — added a `rateLimits/{key}` deny-all block, matching `otpChallenges`/`otpResetTokens`'s existing pattern (Admin SDK access bypasses rules entirely regardless; this documents that no client can ever read/write rate-limit state directly).

### Tests

- `backend/tests/test_reset.py`, `test_otp.py`, `test_email_otp.py` — updated for the renamed class and async signature (`RateLimiter(...)` → `InMemoryRateLimiter(...)`; the handful of tests that call `.allow()` directly are now `async def` with `await`).
- `backend/tests/test_main_wiring.py` — 4 new tests proving the wiring decision itself (not just that the classes work in isolation): production selects `FirestoreRateLimiter` for every limiter in both `build_auth_handler` and `build_email_otp_handlers`, with 4 distinct namespace `name`s; development selects `InMemoryRateLimiter` even with a real-looking email provider configured.
- **Real Firestore emulator verification** (one-off script, same pattern this session already used to verify `FirestoreChallengeStore`, not part of the committed suite — CI has no Firestore emulator): confirmed against a live local Firestore emulator, using two independently-constructed clients standing in for two separate backend instances:
  - The limit is genuinely shared and enforced across two instances (not just two calls on one instance).
  - Two different `name`s never share a counter for the identical key.
  - An entry outside the window is correctly pruned and stops counting.
  - 4 realistic-concurrency requests (well under the limit) across two instances all succeed — contention alone doesn't cause a false deny.
  - 10-way extreme contention (far beyond real production concurrency) against `limit=5` never raises an exception and never allows more than 5 through — it degrades by failing some requests closed, exactly as designed, never by overcounting past the limit.
- Full backend suite: **144 passed**. `ruff check` and `ruff format --check`: clean.

### Deployment

This is a **backend-only** change — nothing here affects the frontend or Firestore Rules' actual behavior for any client-facing collection (the new `rateLimits` block only restates the existing deny-all-except-Admin-SDK posture). To take effect in production:

1. Redeploy `darwesh-backend` to Cloud Run (`gcloud run deploy` per `backend/README.md`'s Deployment section, or Cloud Console "Deploy from source").
2. Publish the updated `firestore.rules` (Firebase Console → Firestore → Rules → Publish), same manual step used for every prior Rules change this session — no automated deploy pipeline exists for this.

Until step 1 happens, production keeps running the old in-memory limiter — functionally unchanged from before, not broken, just not yet fixed live.

---

## INFRA-04 — `backend/README.md` stale relative to actual production state

- **Status**: **FIXED**
- **Fix**: `backend/README.md` no longer says "nothing in this directory is deployed anywhere yet" or "Deployment (not yet done -- needs your decision)". It now states plainly that the service is deployed and live on Cloud Run (`darwesh-backend`, `me-central1`), that a merged change here doesn't take effect until redeployed, and documents the actual deployment command plus how to verify whether secrets are plain env vars or Secret Manager-backed (pointing at INFRA-05, still an open question).
- **Deployment**: None needed — documentation-only change, already reflected on this branch.

---

## INFRA-02 — Zero Subresource Integrity (SRI) on any CDN-loaded script

- **Status**: **NOT SAFELY IMPLEMENTABLE FROM THIS SANDBOX** — blocked, not skipped
- **Why**: A correct `integrity="sha384-..."` attribute has to be the actual cryptographic hash of the bytes the CDN serves. This sandbox's egress proxy hard-blocks every asset CDN this site depends on (`gstatic.com`, `cdn.tailwindcss.com`, any Leaflet CDN) — confirmed directly, not assumed: a `curl` to `cdn.tailwindcss.com` fails with `CONNECT tunnel failed, response 403` *at the proxy's tunnel stage*, before the request ever reaches Tailwind's real servers, and `$HTTPS_PROXY/__agentproxy/status` confirms this is a fixed, organization-level allowlist (package registries and Anthropic's own API domains only) with recorded rejections for exactly this kind of request. There is no workaround available from inside this session.
- **Why a fabricated or guessed hash would be actively harmful, not just unhelpful**: a mismatched `integrity` attribute doesn't degrade gracefully — the browser silently refuses to execute the script at all. For Firebase's SDK or Tailwind, that's not a cosmetic bug; it's the site's auth, data layer, or all styling going dark in production, discovered only after users hit it.
- **How to close this** (safe to do yourself, or hand to a session with real network access):
  1. For each CDN script tag, fetch the exact pinned URL and compute its hash: `curl -s <script-url> | openssl dgst -sha384 -binary | openssl base64 -A`.
  2. Add `integrity="sha384-<that hash>" crossorigin="anonymous"` to the tag.
  3. Firebase's SDK URLs are already version-pinned (`.../firebasejs/12.18.0/...`) — safe to hash directly. Tailwind's CDN is not yet pinned at all (see INFRA-03 below) — pin it first, then hash the pinned URL, not the floating one.
  4. Re-verify after any future CDN version bump — a stale SRI hash breaks the page identically to a wrong one.

---

## INFRA-03 — Tailwind CSS loaded from the CDN with no version pin

- **Status**: **NOT SAFELY IMPLEMENTABLE FROM THIS SANDBOX** — blocked, not skipped
- **Why**: Same network block as INFRA-02 — `cdn.tailwindcss.com` is unreachable from this sandbox, so a pinned URL cannot be fetched to confirm it actually resolves and serves working CSS before shipping it to all ~21 pages. Some general facts were confirmed via web search rather than a direct fetch (Tailwind v4's *newer* Play CDN moved to `cdn.jsdelivr.net/npm/@tailwindcss/browser@4`; this site currently uses the older, still-supported v3-style `cdn.tailwindcss.com?plugins=...` form) — but web search does not substitute for actually loading the pinned URL in a browser and confirming every page still renders correctly, especially since this site depends on two Play CDN plugins (`forms`, `container-queries`) whose availability/config syntax could differ between a pinned v3 URL and any v4 migration.
- **Why an unverified edit here is a real risk, not just unfinished work**: if the pinned syntax or version is wrong, Tailwind's CDN script either 404s or fails to initialize — every page's styling breaks simultaneously, sitewide, the moment this deploys. That is a materially worse outcome than staying on "latest" a while longer.
- **How to close this** (safe to do yourself, or hand to a session with real network access):
  1. Pick a specific Tailwind v3 release and load `https://cdn.tailwindcss.com/<version>?plugins=forms,container-queries` (or check Tailwind's own current Play CDN docs for the exact pinning syntax at the time you do this — it has changed between releases) in a real browser against a copy of one page, and confirm the page renders identically to today's unpinned "latest" load.
  2. Once confirmed working, update the `<script>` tag on all ~21 HTML pages to the pinned URL (a single, mechanical find/replace once the exact string is verified).
  3. Consider doing INFRA-02's SRI pin for this same script right after, per that section's step 3 (must happen in this order — hash the pinned URL, not the floating one).
  4. Revisit periodically — a pin means CSS updates and any upstream Tailwind bug fixes require a deliberate version bump, not automatic pass-through.

---

## Regression results

- Backend: `pytest` — **144 passed**, 0 failed.
- Backend: `ruff check app tests scripts` — all checks passed. `ruff format --check app tests scripts` — clean.
- Firestore Rules: no automated rules-emulator suite exists for the new `rateLimits` collection specifically (it's a deny-all block, identical in shape and intent to the two pre-existing OTP collections, which are already covered by the same reasoning rather than a dedicated test) — the change was hand-verified to match `otpChallenges`/`otpResetTokens`'s exact syntax.
- No frontend files were touched this remediation round (INFRA-02/03 blocked; INFRA-04 is backend-only).

## Production deployment status

| Finding | Code change | Deployed to production? |
|---|---|---|
| INFRA-01 | Yes (backend + `firestore.rules`) | **No** — needs a Cloud Run redeploy and a Firestore Rules publish (see INFRA-01's "Deployment" above) |
| INFRA-04 | Yes (`backend/README.md`) | Documentation only — no deployment needed |
| INFRA-02 | Not made — blocked | N/A |
| INFRA-03 | Not made — blocked | N/A |

---

Stopping here — INFRA-05 through INFRA-10 remain out of scope for this remediation round, unchanged from the review.
