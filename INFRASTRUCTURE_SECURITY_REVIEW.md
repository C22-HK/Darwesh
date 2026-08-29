# Darwesh Group — Infrastructure & Deployment Security Review (Stage 5)

Built on direct inspection of `.github/workflows/`, `backend/Dockerfile`,
`backend/app/config.py`, `backend/app/server.py`, `backend/app/auth/reset.py`,
`backend/README.md`, `docs/APP_CHECK.md`, `docs/SECURITY_AUDIT.md`, every
frontend HTML page's CDN script tags, and the production `darwesh-backend`
Cloud Run service (revision `darwesh-backend-00002-sdc`, `me-central1`,
confirmed live and health-verified by the user in the prior turn).

**No source code was modified. No infrastructure or deployment
configuration was changed.** This is analysis only, matching every
prior stage's review-then-remediate pattern. A few checks that would
normally be read-only-safe (fetching production HTTP response headers
from `api.darweshgroup.com`) could not be performed from this sandbox
— its egress proxy blocks that specific domain by organization policy,
confirmed by a direct attempt, not assumed. Flagged as **not safely
testable from here**, not silently skipped.

An older, pre-session `docs/SECURITY_AUDIT.md` already covers some of
this ground but is now significantly stale (e.g. it says "no App
Check" — App Check was integrated later in this session's history; it
predates every AUTHZ/BL fix). Findings below either supersede or
explicitly reconcile with it.

---

## Evidence legend

- **CODE CONFIRMED** — read directly from source/config, quoted
- **PRODUCTION READ-ONLY CONFIRMED** — a safe, non-destructive check against the live deployment
- **NOT SAFELY TESTABLE FROM HERE** — this sandbox's network policy blocks the check; not attempted via a workaround

---

## Findings

> **REMEDIATION UPDATE**: INFRA-01 and INFRA-04 are **FIXED** (code
> changed and validated; INFRA-01 additionally needs a Cloud Run
> redeploy and a `firestore.rules` publish to take effect in
> production — see **Deployment** in `INFRASTRUCTURE_REMEDIATION.md`).
> INFRA-02 and INFRA-03 remain **NOT SAFELY IMPLEMENTABLE FROM THIS
> SANDBOX** — the egress proxy that already blocked INFRA-10's
> production header check also blocks every asset CDN
> (`cdn.tailwindcss.com`, `gstatic.com`), so neither a real SRI hash nor
> a verified Tailwind version pin could be produced without risking a
> sitewide styling/script break on a wrong guess; exact steps to close
> both yourself are in `INFRASTRUCTURE_REMEDIATION.md`. INFRA-05 through
> INFRA-10 are unchanged. Full detail — files changed, tests, before/
> after, remaining risk — is in **`INFRASTRUCTURE_REMEDIATION.md`**.
> Each finding below now carries a **Remediation status** line; the
> original finding text is left as written (the historical record of
> what was found).

### INFRA-01 — Rate limiting is per-instance, in-memory, with no cross-instance coordination — now a live concern since the backend is confirmed deployed

- **Status**: CONFIRMED
- **Type**: HARDENING / INFRASTRUCTURE WEAKNESS (not an active exploit — a scaling-dependent effectiveness gap)
- **Severity**: Medium
- **Evidence**: CODE CONFIRMED — `backend/app/auth/reset.py:58-90`, `RateLimiter` is a plain in-process `dict` guarded by a `threading.Lock`, with its own docstring explicitly acknowledging the limitation: *"Deliberately not backed by Redis: at this project's current traffic... a single instance's own memory is sufficient... If traffic ever grows enough to run multiple instances, this is the component to swap."* It backs every auth-related limiter in `backend/app/main.py:73,156-159` (OTP send/verify/complete, password-reset, 5-30 requests per 15 minutes depending on endpoint).
- **What changed since that decision was made**: the docstring's premise ("a single instance") was written when, per `backend/README.md`, *"nothing in this directory is deployed anywhere yet."* The backend is now confirmed live on Cloud Run (`darwesh-backend-00002-sdc`), a platform that **autoscales to multiple instances under concurrent load by default** unless `max-instances` is explicitly capped at 1 (which this codebase has no way to control or verify from here — that's a Cloud Run service setting, not application code). If more than one instance is ever running simultaneously, each holds its own independent rate-limit state — the *effective* limit for an attacker distributing requests across instances is `(configured limit) × (instance count)`, silently, with nothing in this codebase surfacing that fact.
- **Realistic abuse scenario**: An attacker grinding the OTP endpoint's attempt budget (a concern this session's own `AUTH_STATE_MACHINE.md` already analyzed under the single-instance assumption) gets a materially larger effective budget than the documented "5 per 15 min" if Cloud Run happens to be running 2+ instances when the attack runs — entirely possible under even moderate concurrent legitimate traffic, not just as a deliberate scaling side-channel.
- **Root cause**: A deliberate, documented, single-instance-era trade-off that was never revisited once the backend actually reached production.
- **Recommended remediation**: Not implemented this stage (analysis only). If pursued: either (a) cap Cloud Run `max-instances=1` for this service if its request volume tolerates that (simplest, matches the existing code's assumption exactly, but forfeits Cloud Run's own scaling/availability benefit), or (b) swap `RateLimiter`'s storage for Firestore/Redis-backed state (the code's own docstring already names this as the intended upgrade path). Whichever is chosen is a real architectural decision, not something to guess at here.
- **Confidence**: High for the mechanism (read directly from source); the actual current Cloud Run `max-instances` setting is unknown from this session — genuinely unverified, not assumed either way.
- **Remediation status**: **FIXED**, matching remediation option (b) above — a `FirestoreRateLimiter` now backs every auth-related limiter in production, selected via the exact same `cfg.is_production` pattern `app.otp.store.ChallengeStore` already used. Verified: 4 new wiring tests (`test_main_wiring.py`) proving production selects the Firestore-backed limiter with a distinct namespace per call site; a one-off script against a real Firestore emulator proved cross-instance sharing, per-`name` isolation, correct pruning, and safe fail-closed behavior under extreme contention (never exceeds the configured limit, never raises). **Not yet deployed to production** — needs a Cloud Run redeploy plus a `firestore.rules` publish (the new `rateLimits` deny-all block). Full detail in `INFRASTRUCTURE_REMEDIATION.md`.

---

### INFRA-02 — Zero Subresource Integrity (SRI) on any CDN-loaded script, across all 21 pages that load one

- **Status**: CONFIRMED
- **Type**: SECURITY VULNERABILITY (supply-chain)
- **Severity**: Medium
- **CWE**: CWE-829 (Inclusion of Functionality from Untrusted Control Sphere)
- **Evidence**: CODE CONFIRMED — repo-wide sweep: `grep -l 'script src="https://' *.html` → 21 files; `grep -l "integrity="` → 0 files. Every `<script src="https://...">` tag in this codebase (Firebase SDK, Tailwind, Leaflet, any other CDN dependency) loads with no `integrity`/`crossorigin` attribute pinning its expected content hash.
- **Impact**: If any of the CDN providers this site depends on (`gstatic.com`, `cdn.tailwindcss.com`, whichever serves Leaflet) were ever compromised, or a request to them were tampered with in transit (a scenario TLS mostly closes, but doesn't eliminate — a compromised/malicious CDN edge node, or a supply-chain compromise of the CDN operator's own build pipeline, both bypass TLS entirely since the tampered content is what TLS faithfully delivers), the browser has no way to detect the substitution and will execute whatever JavaScript arrives. Given this site handles Firebase Auth credentials and Firestore/Storage writes client-side, a compromised script here is a full account-takeover/data-exfiltration vector, not a cosmetic issue.
- **Root cause**: SRI was never adopted; likely because the Firebase SDK's own CDN URLs are versioned per-release (making a hash pin low-maintenance) but Tailwind's is not (see INFRA-03), and SRI was probably never separately considered for either.
- **Recommended remediation**: Not implemented this stage. If pursued: add `integrity="sha384-..."` + `crossorigin="anonymous"` to every CDN `<script>` tag, computed from each pinned version's actual served bytes. This is mechanical but touches all 21 HTML files and needs re-verification any time a CDN version is bumped — a real, if bounded, maintenance cost worth weighing against the risk it closes.
- **Confidence**: High.
- **Remediation status**: **NOT SAFELY IMPLEMENTABLE FROM THIS SANDBOX**. A correct `integrity` hash has to be computed from the real served bytes; this sandbox's egress proxy hard-blocks every CDN this site depends on (confirmed directly — `curl` to `cdn.tailwindcss.com` fails at the proxy's own CONNECT-tunnel stage, `403`, before ever reaching a real server), so no hash produced here could be trusted. A wrong or fabricated hash doesn't degrade gracefully — the browser silently refuses to execute the script at all, which for Firebase's SDK means auth/data breaking sitewide. Exact commands to compute and apply real hashes yourself are in `INFRASTRUCTURE_REMEDIATION.md`.

---

### INFRA-03 — Tailwind CSS is loaded from the CDN entirely unpinned (no version at all)

- **Status**: CONFIRMED
- **Type**: SECURITY VULNERABILITY (supply-chain) + reliability risk
- **Severity**: Medium
- **Evidence**: CODE CONFIRMED — every page: `<script src="https://cdn.tailwindcss.com?plugins=forms,container-queries"></script>` — no version segment in the URL at all, unlike the Firebase SDK (`.../firebasejs/12.18.0/...`, pinned everywhere it's used). This was already flagged, unresolved, in this session's own `SECURITY_ARCHITECTURE.md` (*"unpinned (always latest;..."*, cut off mid-sentence in that doc — re-confirmed and completed here).
- **Impact**: Every page load fetches whatever Tailwind's CDN currently serves as "latest" — combines the INFRA-02 supply-chain concern (this specific dependency can never have SRI applied at all, since there's no fixed version/content to hash against) with a pure reliability risk (an upstream breaking change ships to production instantly, with zero warning and no code review, the moment Tailwind publishes it).
- **Root cause**: The CDN `<script>` tag was set up during initial development and never revisited for pinning.
- **Recommended remediation**: Not implemented this stage. If pursued: pin to a specific Tailwind CDN version (`cdn.tailwindcss.com/3.4.x` or similar, per Tailwind's own CDN versioning docs) at minimum; a bundled/built Tailwind (removing the CDN dependency entirely) would be the more thorough fix but is a real build-tooling change this static-site-with-no-build-step architecture has so far deliberately avoided (per `SECURITY_ARCHITECTURE.md`'s own stated design).
- **Confidence**: High.
- **Remediation status**: **NOT SAFELY IMPLEMENTABLE FROM THIS SANDBOX**. Same network block as INFRA-02 — `cdn.tailwindcss.com` is unreachable, so a pinned URL cannot be confirmed to actually resolve and serve working CSS (with this site's `forms`/`container-queries` plugins intact) before shipping it to all ~21 pages. If the pinned syntax or version is wrong, the CDN script 404s or fails to initialize and every page's styling breaks simultaneously — a materially worse outcome than staying unpinned a while longer. Exact verification steps to do this yourself are in `INFRASTRUCTURE_REMEDIATION.md`.

---

### INFRA-04 — `backend/README.md` is significantly stale relative to actual production state

- **Status**: CONFIRMED
- **Type**: DATA INTEGRITY RISK (documentation accuracy) — not a security vulnerability directly, but an operational-risk multiplier
- **Severity**: Low
- **Evidence**: CODE CONFIRMED — `backend/README.md:10-12`: *"Nothing in this directory is deployed anywhere yet. It exists, its tests pass, but it isn't running in production..."*; `README.md:53`: *"## Deployment (not yet done -- needs your decision)"*. Both are now factually wrong — the user has confirmed `darwesh-backend` is live on Cloud Run, revision `darwesh-backend-00002-sdc`, serving 100% of production traffic, health-verified.
- **Impact**: A future contributor (human or AI) reading this file at face value would believe the backend is inert and could make a change — or redeploy — without the operational care a live, traffic-serving service actually warrants. This is exactly the kind of stale-documentation gap that causes real incidents, even though the doc itself has no direct security mechanism.
- **Root cause**: The README was written before the first production deployment and never updated afterward.
- **Recommended remediation**: Not implemented this stage (would be a documentation edit, not infrastructure config — flagged here since it surfaced directly from this stage's own investigation, actual fix deferred to a remediation pass if you want it).
- **Confidence**: High.
- **Remediation status**: **FIXED**. `backend/README.md` now states plainly that the service is deployed and live on Cloud Run, that a merged change here doesn't take effect until redeployed, and documents the real deployment command plus how to check whether secrets are plain env vars or Secret Manager-backed (INFRA-05). Documentation-only — no deployment step needed.

---

### INFRA-05 — Backend secrets-delivery mechanism to Cloud Run is unverified from this session

- **Status**: **NOT SAFELY TESTABLE FROM HERE** — genuinely unknown, not assumed either way
- **Type**: Open question, not a confirmed finding
- **Severity**: Unrated (depends entirely on the unknown answer)
- **What's known**: `backend/app/config.py` reads `OTP_HMAC_SECRET`, `RESEND_API_KEY`, `FIREBASE_SERVICE_ACCOUNT_JSON` (dev-only path) purely from environment variables (`os.environ.get(...)`), with safe empty defaults and no fallback that would silently downgrade security if unset (confirmed in this session's own earlier credential-remediation work). `backend/README.md:69-72` recommends *"real secrets supplied through that platform's environment/secret manager -- never committed to this repo"* but doesn't mandate Google Secret Manager specifically over plain `--set-env-vars`.
- **What's not known**: Whether the actual live Cloud Run revision (`darwesh-backend-00002-sdc`) receives these values via plain environment variables (visible in the Cloud Run Console/`gcloud run services describe` output to anyone with IAM read access to the service) or via Secret Manager-backed env vars (`--set-secrets`, which keeps the value out of the revision's own visible config, only resolved at container-start time). This session has no `gcloud`/Cloud Console access to check.
- **Why it matters**: Plain env vars aren't a vulnerability by themselves (Cloud Run revision configs are only visible to project IAM members, not the public), but Secret Manager is the stronger, more auditable pattern (access logging, rotation without a redeploy, no accidental exposure via `gcloud run services describe` output pasted into a support ticket, chat log, or screenshot).
- **Recommended action**: Not a code fix — verify directly: `gcloud run services describe darwesh-backend --region=me-central1 --format=json` and check whether the sensitive env vars appear as plain `env` entries or `secretKeyRef`-style entries. If plain, consider migrating to Secret Manager — low effort, meaningful hardening for a live service holding an OTP-signing secret and an email-provider API key.
- **Confidence**: N/A — explicitly an open question, not a finding.

---

### INFRA-06 — App Check remains integrated but enforcement OFF on every service (restated, still current)

- **Status**: CONFIRMED (re-confirmed current, not new — already known and already a deliberate, documented, staged rollout plan)
- **Type**: HARDENING (defense-in-depth not yet activated, not a vulnerability by itself — Firestore/Storage Rules remain the real authorization boundary regardless)
- **Severity**: Low
- **Evidence**: CODE CONFIRMED — `docs/APP_CHECK.md:172-173`: *"enforcement is off, so an unverified/missing token doesn't block anything"*; `docs/APP_CHECK.md:255`: *"I did not enable enforcement on any service -- that's a Console action"* (deliberately left for the user, per that document's own staged rollout plan — Phase 3/4 not yet executed).
- **Why this belongs in an infrastructure/deployment review**: enabling App Check enforcement is a **Console/deployment-tier action**, not a code change — squarely in this stage's scope even though the finding itself isn't new. Restated here rather than silently omitted, since Stage 5 is specifically the review that should surface it as an actionable deployment step.
- **Recommended action**: Not implemented this stage — this is explicitly a Console action per the existing rollout plan in `docs/APP_CHECK.md`, which already documents the exact phased steps (confirm Verified-request metrics first, then enforce one service at a time, Firestore/Storage before Auth). No new guidance needed; pointing back to that existing plan rather than re-deriving it.
- **Confidence**: High.

---

### INFRA-07 — No security headers possible on the GitHub Pages-hosted frontend (restated from the older audit, still true, now contrasted against the backend's own header posture)

- **Status**: CONFIRMED (re-confirmed current)
- **Type**: HARDENING — bounded by the same mitigating factor the older audit already identified
- **Severity**: Low
- **Evidence**: CODE CONFIRMED — `CNAME` confirms GitHub Pages hosting (`www.darweshgroup.com`); GitHub Pages does not support custom response headers for static sites, so no CSP/`X-Frame-Options`/`Permissions-Policy`/`Referrer-Policy` can be set for any of the 21+ HTML pages. Contrast: the **backend** (a JSON API, no HTML rendering) *does* set `X-Content-Type-Options`, `Referrer-Policy`, and `Strict-Transport-Security` (`backend/app/server.py:112-135`) — correctly scoped to what a JSON API can meaningfully protect (per that code's own comment, CSP/X-Frame-Options/Permissions-Policy are deliberately omitted there too, since there's no HTML document to protect).
- **Mitigating factor** (unchanged from the prior audit, re-verified not just assumed): this is a static site with no `eval`/unsanitized-`innerHTML`-of-arbitrary-input pattern found across this session's many passes through the frontend code — the actual clickjacking/CSP-relevant XSS surface a header would protect against is narrow, though not zero (this session did find and this document restates INFRA-02/03's supply-chain angle, which CSP's `script-src` would meaningfully mitigate if it existed).
- **Recommended remediation**: Not implemented this stage — matches the older audit's own conclusion: closing this fully requires moving hosting behind a platform that supports custom headers (Cloudflare Pages, Netlify, Firebase Hosting), a real infrastructure migration decision, not a small fix.
- **Confidence**: High.

---

### INFRA-08 — HSTS preload-list reasoning in `server.py` is now stale

- **Status**: CONFIRMED (minor, self-caught documentation drift)
- **Type**: DATA INTEGRITY RISK (comment accuracy) — no functional issue
- **Severity**: Low
- **Evidence**: CODE CONFIRMED — `backend/app/server.py:129-133`: *"2 years, includes subdomains -- long enough to be a durable commitment once this is actually deployed on a real domain, short of preload-list submission (which requires production traffic on a stable domain first, not appropriate to opt into from a codebase that isn't deployed anywhere yet)."* The backend is now deployed on a real domain with real production traffic — the precondition this comment says isn't met is, per the user's own confirmation this session, now met.
- **Impact**: None functional (the header is already set correctly, `preload` just isn't in the directive) — purely a "this decision's stated precondition has changed, worth someone re-deciding" flag, not a vulnerability.
- **Recommended remediation**: Not implemented this stage. If pursued: decide whether to add `; preload` to the `Strict-Transport-Security` header and submit `api.darweshgroup.com` (or whichever domain actually fronts this service) to the HSTS preload list — a one-way, hard-to-reverse commitment (removal from the preload list takes months to propagate through browsers), so this is a deliberate decision, not a mechanical fix.
- **Confidence**: High.

---

### INFRA-09 — CI workflow has no explicit `permissions:` block

- **Status**: CONFIRMED
- **Type**: HARDENING ONLY — no exploit path found
- **Severity**: Informational
- **Evidence**: CODE CONFIRMED — `.github/workflows/ci.yml` has no top-level or job-level `permissions:` key, so the default `GITHUB_TOKEN` permissions (repo-setting-dependent, historically broad by default on many repos) apply implicitly.
- **Why this is hardening-only, not a vulnerability**: the workflow never actually uses `GITHUB_TOKEN` for anything beyond `actions/checkout@v4`'s own read (no PR comments, no releases, no pushes, no third-party actions that consume the token for a write). There is no step in this workflow that could currently abuse a broader-than-needed token.
- **Also confirmed safe**: triggers are `push`/`pull_request` to `main` only (not the higher-risk `pull_request_target`), and both jobs (`actions/checkout@v4`, `actions/setup-node@v4`, `actions/setup-python@v5`) are official, verified GitHub actions pinned to major-version tags — no arbitrary/unpinned third-party action usage.
- **Recommended remediation**: Not implemented this stage. If pursued: add `permissions: contents: read` at the workflow level — standard least-privilege hygiene, zero functional risk to apply, but genuinely optional given no current abuse path exists.
- **Confidence**: High.

---

### INFRA-10 — Production HTTP response headers not independently re-verifiable from this sandbox

- **Status**: **NOT SAFELY TESTABLE FROM HERE**
- **Evidence**: A direct, read-only `curl -I https://api.darweshgroup.com/api/v1/health` attempt from this session failed — the sandbox's own egress proxy rejected the connection per organization policy (`connect_rejected`), not a finding about the actual site. `firestore.googleapis.com` (used throughout this session's AUTHZ-01 production verification) is reachable from this sandbox; arbitrary custom domains like `api.darweshgroup.com` are not.
- **What this means**: `_SecurityHeadersMiddleware`'s actual presence on live production responses (`X-Content-Type-Options`, `Referrer-Policy`, `Strict-Transport-Security`) is confirmed **in code** (INFRA-07/08 evidence) but not independently re-confirmed against a live response this session. The user's own health-check confirmation (`{"status":"ok"}`) proves the service responds; it doesn't by itself prove these specific headers are present on that response (they didn't check headers, only body).
- **Recommended action**: If you want this independently confirmed, run `curl -sI https://api.darweshgroup.com/api/v1/health` yourself (read-only, safe) and check for the three headers named above — I can't do this from here.
- **Confidence**: N/A — explicitly unverified, not claimed either way.

---

## Investigated and confirmed still-accurate from the older `docs/SECURITY_AUDIT.md` (not re-litigated as new findings)

- **L2 (no MFA for admin/agent)** — still true, still unaddressed, still a Firebase Auth Console configuration action, not a code question. Restated for completeness, not re-analyzed.
- **M2 (orphaned `verification.html`/`profile.html`)** — not re-checked this stage (out of infrastructure/deployment scope specifically — that's a content/routing question, already covered in `ATTACK_SURFACE.md`'s Stage 1 mapping).

## Superseded by this session's later work (do not treat the older audit as current for these)

- **H1 (Storage bucket not provisioned)** — this session's own extensive Storage Rules testing (Stage 3 `stage3_storage_test.mjs`, 15/15 passing against a real Storage emulator, plus references throughout to real Storage paths in production data) confirms Storage is provisioned and in active use. The older audit's H1 is stale.
- **M1 (No Firebase App Check)** — App Check was integrated later in this session's history (see `docs/APP_CHECK.md`); restated with current, accurate status as INFRA-06 above, not "none."
- **M3 (no rate limiting beyond Firestore's own quota)** — the *auth* endpoints do have explicit application-level rate limiting (`RateLimiter`, see INFRA-01) — the older audit's claim was scoped to `agentTransactions`/`listings` writes specifically, which remains true (Firestore Rules enforce ownership/validity, not request throughput) and is a distinct, narrower point than INFRA-01.

---

## Summary

### Confirmed Critical
None.

### Confirmed High
None.

### Confirmed Medium
- **INFRA-01** — Rate limiting is per-instance/in-memory; effectiveness now depends on an unverified Cloud Run scaling setting. **FIXED** (code) — not yet deployed. See `INFRASTRUCTURE_REMEDIATION.md`.
- **INFRA-02** — Zero SRI on any CDN script, 21/21 pages. **Not safely implementable from this sandbox** — blocked on egress-proxy access to any asset CDN. See `INFRASTRUCTURE_REMEDIATION.md`.
- **INFRA-03** — Tailwind CDN entirely unpinned (no version). **Not safely implementable from this sandbox** — same block as INFRA-02. See `INFRASTRUCTURE_REMEDIATION.md`.

### Confirmed Low
- **INFRA-04** — `backend/README.md` stale relative to actual production deployment state. **FIXED**. See `INFRASTRUCTURE_REMEDIATION.md`.
- **INFRA-07** — No security headers possible on GitHub Pages frontend (bounded, restated).
- **INFRA-08** — HSTS preload reasoning in code comment is now stale.

### Hardening-only
- **INFRA-06** — App Check integrated, enforcement off (known, staged, deliberate).
- **INFRA-09** — CI workflow missing an explicit `permissions:` block (no current abuse path).

### Not safely testable from this sandbox
- **INFRA-05** — Cloud Run secrets-delivery mechanism (plain env var vs. Secret Manager) — genuinely unknown, needs a `gcloud`/Console check you can run.
- **INFRA-10** — Live production response headers — proxy-blocked from here; a safe `curl -I` you can run yourself would close this.

### Data-integrity risks
INFRA-04, INFRA-08 (both documentation/comment staleness, not functional bugs).

### False positives
None identified this stage — every candidate investigated was either confirmed with evidence or explicitly marked not-testable, not silently assumed safe.

### Exact checks performed
- Read `.github/workflows/ci.yml`, `backend/Dockerfile`, `.dockerignore`, `.gitignore` in full.
- Read `backend/app/config.py`, `backend/app/server.py` (CORS + security-headers middleware), `backend/app/auth/reset.py` (`RateLimiter` implementation) in full.
- Read `backend/README.md`, `docs/APP_CHECK.md`, `docs/SECURITY_AUDIT.md` in full.
- Repo-wide `grep` sweep for `integrity=` and CDN `<script src=` across all `*.html` (21 files with CDN scripts, 0 with SRI).
- Confirmed via `git`-independent direct read that Tailwind's CDN URL carries no version segment, contrasted against the Firebase SDK's pinned `12.18.0` references.
- Attempted a live, read-only `curl -I` against the production backend — blocked by this sandbox's own egress policy, reported as such rather than skipped silently.

### Anything not safely testable
INFRA-05 and INFRA-10, both explained above with the exact command you can run yourself to close them.

---

Stopping here — this is Stage 5's review only, matching the established pattern (analysis first, remediation on request). No fixes were applied.
