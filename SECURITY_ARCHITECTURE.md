# Darwesh Group — Security Architecture Map (Phase 1)

Built by direct inspection of this repository as it exists today (branch
`claude/web-project-hqdo8o`), not from assumptions. No source code was
modified to produce this document. Where an existing doc already covered
part of this ground (`docs/ARCHITECTURE_AUDIT.md`, `docs/SECURITY_AUDIT.md`,
`docs/APP_CHECK.md`, `docs/EMAIL_OTP.md`) it's cited and reconciled here
rather than repeated — several of those predate the backend described
below and are noted as partially outdated where relevant.

This is the deliverable for **Phase 1 only**: an inventory and map. It
does not contain vulnerability findings or severities — that's Phase 3/5
(`SECURITY_FINDINGS.md`). A few observations that jumped out during
mapping are flagged inline as "Note:" for later phases to investigate,
not as confirmed findings.

---

## 1. System overview

```
Browser (visitor)
  |
  |-- static assets --> GitHub Pages (www.darweshgroup.com, darweshgroup.com)
  |                        20 HTML pages, no build step, no framework
  |
  |-- Firebase Web SDK (client-side, direct) --> Firebase project "darwesh-group"
  |     Auth (email/password) | Firestore | Cloud Storage | App Check (integrated, NOT enforced)
  |
  |-- fetch() to backend-config.js's BACKEND_BASE_URL --> FastAPI backend
  |     (Google Cloud Run, region me-central1 — planned, NOT YET DEPLOYED as of this map;
  |      PRODUCTION_BACKEND_BASE_URL in js/backend-config.js is still a placeholder,
  |      https://api.darweshgroup.com, that resolves nowhere yet)
  |         |
  |         |-- Firebase Admin SDK (service-account key in dev, ADC planned for Cloud Run)
  |         |     --> same Firebase project (Auth + Firestore), server-side/trusted
  |         |-- Resend API (email delivery) -- no real API key configured yet
  |
  |-- fetch() to third-party public APIs, browser-side only --> Nominatim / Overpass
        (map/geocoding, no API key, no server involved)
```

Two independently deployable pieces:
1. **Frontend** — static site on GitHub Pages, talks to Firebase directly
   from the browser (the original, still-primary architecture).
2. **Backend** (`backend/`) — a FastAPI service, added later, specifically
   for the email-OTP signup/password-recovery flow. Not deployed to
   production yet (per this session's own deployment-planning work) —
   every current visitor hitting a backend-dependent page (Forgot
   Password, the OTP step of Signup) gets a handled "couldn't reach the
   server" error, not a crash.

---

## 2. Frontend pages (20 HTML files, all in repo root)

| Page | Purpose | Auth requirement | Notes |
|---|---|---|---|
| `index.html` | Homepage, featured listings, MAM AI search box | None | Reads `listings` |
| `map.html` | Map-based property browse/search | None (viewing request form works for guests too) | Reads `listings`, creates `submissions` (type `viewing`); calls Nominatim/Overpass (browser-side) |
| `buy.html` | Buy-listing browse/filter | None | Reads `listings` |
| `rent.html` | Rent-listing browse/filter | None | Reads `listings` |
| `listing.html` | Single listing detail | None | Reads one `listings` doc + its agent's public profile |
| `sell.html` | Sell/list-a-property submission form | **None — guest submission is by design** | Creates `submissions` (type `sell`), uploads to Storage (`sell-submissions`, `sell-verification` — a "selfie" identity-verification photo) |
| `services.html` | Directory of offices/agencies/lawyers/engineers/designers/cleaners | None | Static/config-driven content (not Firestore-backed as far as inspected) |
| `about.html`, `insights.html`, `promo.html`, `build.html`, `renovate.html` | Marketing/content pages | None | `insights.html` reads aggregate stats from `listings` |
| `mam-ai.html` | Client-side "AI assistant" (keyword matcher, no LLM/backend) | None | Reads `listings` for a few grounded reply generators |
| `login.html` | Email/password sign-in | None (destination page) | Firebase Auth `signInWithEmailAndPassword` |
| `signup.html` | Customer/Agent signup, now via backend email-OTP flow | None (destination page) | Calls backend `/email-otp/*`, `/signup/complete` (see §4) |
| `reset-password.html` | Forgot-password, code-based (not the Firebase link flow) | None (destination page) | Calls backend `/email-otp/*`, `/password-reset/confirm` |
| `account.html` | Customer's own profile/favorites/saved searches | Signed in (redirects to `login.html` if not) | Reads/writes only the signed-in user's own docs |
| `agent-dashboard.html` | Agent's own listings, team listings, finances ledger | Signed in + `role == 'agent'` (client-side redirect check; real enforcement is `firestore.rules`) | Largest page after admin (994 lines) |
| `admin.html` | Full admin console: users/roles, listings (all), companies, submissions, Add Agent | Signed in + `role == 'admin'` (same client-side-redirect pattern) | Largest page (3,213 lines) — highest-privilege surface in the whole app |
| `verification.html`, `profile.html` | **Orphaned** — unlinked from any nav, reachable only by guessing the URL, static mockup/placeholder data | None | Previously flagged (`docs/SECURITY_AUDIT.md` M2); still present |

**Note for Phase 3**: every role gate above (`agent-dashboard.html`,
`admin.html`) is enforced client-side only as a *redirect* — the actual
authorization boundary is `firestore.rules` (§6). This is the correct
model (client-side checks are UX, not security), but worth explicitly
re-verifying in Phase 3/4 that no admin/agent page renders any sensitive
data *before* that redirect fires, and that no admin-only read ever
happens without a rule that would independently reject it.

---

## 3. Shared frontend JS (`js/`)

| File | Role | Security relevance |
|---|---|---|
| `firebase-init.js` | Single Firebase app init, App Check init, exports App-Check-gated Firestore wrappers (`getDocs`/`getDoc`/`addDoc`/`setDoc`/`updateDoc`/`deleteDoc`) | The one place `initializeApp`/`initializeAppCheck` run for the primary app. See §7. |
| `backend-config.js` | Picks `BACKEND_BASE_URL` by hostname (`localhost` → dev, else production placeholder) | No secrets — a URL is not sensitive. Currently points at a domain with nothing deployed. |
| `backend-api.js` | Thin `fetch()` wrappers for the 4 backend OTP/signup/reset endpoints | Normalizes network failure vs. backend error response into two distinct error types; never rethrows raw error text (could leak the request URL) |
| `otp-ui.js` | OTP input widget, `maskEmail()` | `maskEmail` used both client-side and mirrored server-side (`scripts/find_orphaned_auth_accounts.py`) |
| `escape-html.js` | `escapeHtml()`, `isSafeHttpUrl()` — shared XSS-prevention helpers | Used by 7 pages (`admin.html`, `mam-ai.html`, `index.html`, `map.html`, `buy.html`, `listing.html`, `profile.html`). **Note**: `agent-dashboard.html` and `js/notification-bell.js`/`js/city-nav.js` each define an equivalent function locally instead of importing this one — functionally consistent everywhere checked so far, but duplicated rather than shared (Phase 3/7 candidate for consolidation, not a vulnerability by itself). |
| `nav-auth.js` | Shows the signed-in user's name/link in nav | Uses `textContent` only, no `innerHTML` |
| `notification-bell.js` | "My Activity" notification panel (reads own `submissions`) | Uses `escapeHtml()` on all Firestore-sourced text before `innerHTML` |
| `city-nav.js` | City picker/nav dropdown | Local escaping equivalent, same pattern as above |
| `i18n.js` | English/Kurdish Sorani/Arabic dictionary (~750 keys/language), `tr()`/`trDash()` | Static dictionary content only, not user input |
| `error-monitor.js` | Optional Sentry wiring | **Currently a no-op** — `SENTRY_DSN` is empty; does nothing until a real DSN is set |

**Note for Phase 3**: `innerHTML =` appears in 16 of the 20 HTML files
plus 3 shared JS files. Confirmed-escaped (via `escapeHtml`/`escapeFin`/
local equivalents) in every case spot-checked during this mapping pass
(`agent-dashboard.html`, `notification-bell.js`, `city-nav.js`, plus the
7 files importing `escape-html.js`). The remainder (`sell.html`,
`services.html`, `promo.html`, `insights.html`, `account.html`,
`js/i18n.js`) were only spot-checked, not exhaustively — most observed
usages there are static template chrome, loading/empty states, or the
user's own filename during their own upload (a self-XSS candidate at
worst). Full line-by-line confirmation is Phase 3 work, not concluded
here.

---

## 4. Backend API surface (`backend/`, FastAPI on Cloud Run — planned, not yet deployed)

All routes are registered conditionally (`app/server.py`'s `create_app`)
— a route that isn't fully configured simply doesn't exist (404), never
"exists and half-works."

| Method + path | Purpose | Auth | Registered when |
|---|---|---|---|
| `GET /healthz` | Health check (platform probe) | None | Always |
| `GET /api/v1/health` | Health check (app namespace) | None | Always |
| `POST /api/v1/auth/forgot-password` | **Legacy** link-based password reset (predates the OTP flow, kept as fallback) | None (rate-limited, enumeration-safe) | `FIREBASE_SERVICE_ACCOUNT_JSON`-or-ADC + `RESEND_API_KEY` + `RESET_EMAIL_FROM` + `RESET_PASSWORD_CONTINUE_URL` all present |
| `POST /api/v1/auth/email-otp/send` | Send a 6-digit code for `SIGNUP_EMAIL_VERIFY` or `PASSWORD_RESET` | None (IP + per-email rate-limited) | Firebase credential + `OTP_HMAC_SECRET`; real Resend key required in production (hard gate, no mock-in-prod) |
| `POST /api/v1/auth/email-otp/verify` | Verify the code → mints `verifyToken`/`resetToken` | None (IP-rate-limited, attempt-capped) | Same as above |
| `POST /api/v1/auth/signup/complete` | Consumes `verifyToken`, creates Firebase Auth user + `users/{uid}` profile, mints a custom token | Bearer of a valid, single-use `verifyToken` | Same as above |
| `POST /api/v1/auth/password-reset/confirm` | Consumes `resetToken`, sets new password, revokes sessions | Bearer of a valid, single-use `resetToken` | Same as above |

No `/api/v1/auth/otp/*` (phone/WhatsApp) routes are wired up — that
code (`app/otp/handler.py`'s `OtpSendHandler`/`OtpVerifyHandler`,
`app/otp/whatsapp.py`) exists but is dormant, kept as a reusable
component, never registered by `app/main.py`.

**Middleware** (`app/server.py`): request-logging (method/path/status/
latency/client IP only — never body/headers/query string),
`X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`,
`Strict-Transport-Security` (2yr, includeSubDomains), CORS
(`allow_origins` from `ALLOWED_ORIGINS` env var, empty by default,
`allow_credentials=False`, no wildcard).

**Storage layer**: `InMemoryChallengeStore` (dev/test) vs.
`FirestoreChallengeStore` (production, `otpChallenges`/`otpResetTokens`
collections — denied to all client reads/writes in `firestore.rules`,
reachable only via the backend's Admin SDK credential). Every OTP is
stored as `HMAC(code, OTP_HMAC_SECRET)`, never plaintext.

**Operational script**: `backend/scripts/find_orphaned_auth_accounts.py`
— manually run, read-only, not part of the deployed service.

Full design/threat-model detail already documented in `docs/EMAIL_OTP.md`
(this session's own prior work) — not repeated here.

---

## 5. Authentication & account flows

- **Primary identity**: Firebase Auth, email/password only. No Google/
  social sign-in wired up anywhere in the codebase (confirmed: no
  `signInWithPopup`/`GoogleAuthProvider` reference exists).
- **Signup**: `signup.html` → backend email-OTP send/verify →
  `/signup/complete` creates the Firebase Auth user (`email_verified:
  true`, since OTP just proved it) and `users/{uid}` (`role` is
  **always** `"customer"` server-side regardless of what the client
  requests; `requestedRole` is a recorded-but-untrusted signal for an
  admin to review) → mints a custom token → client
  `signInWithCustomToken`.
- **Login**: `login.html`, direct Firebase `signInWithEmailAndPassword`
  — the backend is not involved in normal login at all.
- **Password reset**: two parallel paths exist —
  (a) the **live, primary** code-based flow (`reset-password.html` →
  backend `/email-otp/*` + `/password-reset/confirm`, sets the new
  password via Admin SDK, revokes all refresh tokens), and
  (b) the **legacy** link-based flow (`/api/v1/auth/forgot-password`,
  generates a real Firebase reset link server-side, rewritten to point
  at this project's own `reset-password.html` instead of
  `*.firebaseapp.com`) — kept as a fallback, not removed.
- **Role promotion**: no self-service or admin-UI-driven path exists to
  grant `agent`/`admin` from `customer` — `firestore.rules` locks `role`
  against self-modification at both `create` and `update`; the only
  path is `admin.html`'s "Add Agent" flow (an admin explicitly creating
  a *new* agent account, via a second, temporary Firebase app instance
  so the admin's own session isn't disturbed — see `docs/APP_CHECK.md`
  for the App-Check/rollback design already built around this).
- **Session mechanics** (token issuance, refresh, revocation, rate
  limiting on sign-in attempts) are entirely Firebase Auth's own
  responsibility — not reimplemented, not independently inspectable
  from this codebase.

---

## 6. Firestore — collections & rules (`firestore.rules`)

| Collection | Read | Create | Update | Delete |
|---|---|---|---|---|
| `users/{uid}` | Owner, admin, or anyone if `role == 'agent'` (public agent profiles) | Owner only, `role` forced `'customer'`, `requestedRole` restricted to `customer`/`agent` | Owner (role/companyId/assignedAgentId/requestedRole locked against self-change) or admin | Admin only |
| `users/{uid}/favorites/{id}`, `/savedSearches/{id}` | Owner only | Owner only | Owner only | Owner only |
| `companies/{id}` | Any signed-in user | Any signed-in user, **only if the doc doesn't already exist** (create-if-not-exists) | Admin only | Admin only |
| `listings/{id}` | **Public** (`if true`) | Agent (self `agentId`, own `companyId`) or admin | Owning agent or admin | Owning agent or admin |
| `submissions/{id}` | Owner (by `uid`) or admin | Anyone (`status:'pending'`, own `uid` or guest `null`) — `sell.html`/`map.html`'s viewing-request path requires no login | Admin, or the pending doc's own creator patching only photo fields (background upload continuation) | Admin only |
| `agentTransactions/{id}` | Owner (`agentId`) or admin | Agent, self `agentId` only | Owner or admin | Owner or admin |
| `otpChallenges/{key}`, `otpResetTokens/{token}` | **Denied to everyone**, unconditionally | Denied | Denied | Denied — only the backend's Admin SDK (which bypasses rules entirely) ever touches these |

This ruleset, and the `.get(field, null)`-vs-direct-access correctness
bug it previously had, were already reviewed and fixed earlier this
session (self-promotion via `requestedRole`, a legacy-account self-edit
bug from `assignedAgentId` — see prior session history / git log for
`c23f943`). Re-verification against a live Firestore emulator, not just
reading, is planned as part of Phase 3/4 rather than re-litigated here.

## Cloud Storage — `storage.rules`

| Path | Read | Write | Delete |
|---|---|---|---|
| `sell-submissions/{token}/{file}` | Public | Anyone, `<10MB`, `image/*` only | Never |
| `sell-verification/{token}/{file}` (identity-verification selfie) | **Admin only** (cross-service `firestore.get()` role check) | Anyone, `<10MB`, `image/*` only | Never |
| `listing-photos/{token}/{file}` | Public | Any signed-in user, `<10MB`, `image/*` | Never |
| `agent-photos/{uid}/{file}`, `customer-photos/{uid}/{file}` | Public | Owner only (`request.auth.uid == uid`), `<10MB`, `image/*` | Never |

**Note carried over from `docs/ARCHITECTURE_AUDIT.md`**: the Storage
*bucket itself* was reported as not provisioned on the live project as
of that audit (every upload failing after a timeout) — this map does
not re-verify that live status (Phase 4 territory, requires live
non-destructive testing) but flags it as a known open item, not
something newly discovered here.

---

## 7. Firebase App Check

Fully mapped in the existing `docs/APP_CHECK.md` — summarized here for
completeness, not re-derived: reCAPTCHA Enterprise provider, integrated
on both the primary and the `admin.html` secondary Firebase app
instances, Firestore calls gated behind a real token-or-5s-circuit-
breaker wait. **Enforcement is OFF on every service** (Firestore,
Storage, Authentication) — SDK-integrated only, per this session's
explicit, repeated instruction not to enable it. Firestore verification
rate was last measured at only 5% in Console metrics (root-caused to
early page-load reads racing the token) — explicitly documented as not
yet safe to enforce.

---

## 8. CORS, secrets, and environment configuration

**CORS** (backend only — GitHub Pages can't set custom headers at all,
so the frontend has no CORS policy of its own to review): config-driven
via `ALLOWED_ORIGINS`, empty (deny-all cross-origin) by default,
`allow_credentials=False`, verified live this session to return `200` +
`access-control-allow-origin` for an allowed origin and `400 Disallowed
CORS origin` for one that isn't listed. Planned production value:
`https://www.darweshgroup.com,https://darweshgroup.com` — not yet set
anywhere live, since the backend isn't deployed.

**Environment variables / secrets** (`backend/.env.example` is the
authoritative list):

| Var | Secret? | Notes |
|---|---|---|
| `PORT`, `APP_ENV` | No | Platform-injected / deployment-mode flag |
| `ALLOWED_ORIGINS` | No | Public origin list |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | **Yes** | Dev/fallback only as of this session's ADC work — planned production Cloud Run config omits this entirely in favor of Application Default Credentials |
| `FIREBASE_PROJECT_ID` | No | Public (same value already in `js/firebase-init.js`) |
| `RESET_PASSWORD_CONTINUE_URL` | No | Public URL |
| `OTP_HMAC_SECRET` | **Yes** | HMACs OTP codes before storage; never the plaintext code itself |
| `RESEND_API_KEY` | **Yes** | Not yet issued/configured anywhere live |
| `RESET_EMAIL_FROM` | No | Public sender address |

**Frontend "secrets"**: `js/firebase-init.js`'s `apiKey`/`authDomain`/
etc. are the Firebase Web config — intentionally public per Firebase's
own documentation; the actual authorization boundary is
`firestore.rules`/`storage.rules`, not this key. No other credential of
any kind is present in frontend code (confirmed by this pass's grep for
`fetch(` external-call sites — only Nominatim/Overpass, both keyless
public APIs).

**Git history**: a first-pass pattern scan (`AIzaSy...` Firebase-key
shape, PEM private-key headers, `service_account` blobs, Stripe/Resend-
style live-key prefixes) across full `git log -p` found no committed
secret value beyond the intentionally-public Firebase Web API key
already in `js/firebase-init.js`. This is a first-pass signal, not the
full Phase 3 secrets sweep (which should also check for high-entropy
strings generically, not just known prefixes).

---

## 9. Dependencies

**Backend (Python, pinned exactly in `requirements.txt`)**:
`fastapi==0.141.1`, `uvicorn[standard]==0.52.4`, `httpx==0.28.1`,
`firebase-admin==7.5.0` (pulls in `google-auth`, `google-cloud-
firestore`, `cryptography`, `PyJWT` transitively). Dev-only:
`requirements-dev.txt` — `pytest==9.1.1`, `pytest-asyncio==1.3.0`,
`ruff==0.16.5`.

**Frontend**: no `package.json`, no npm dependency tree at all. Every
third-party script is CDN-loaded directly in HTML:
- `https://cdn.tailwindcss.com` — **unpinned** (always latest; a
  supply-chain consideration, not a version this project controls)
- `https://www.gstatic.com/firebasejs/12.18.0/firebase-*.js` — pinned
  to `12.18.0` across every import site checked
- `https://fonts.googleapis.com/...` — Google Fonts CSS, no JS execution
- `https://browser.sentry-cdn.com/8.9.2/bundle.min.js` — pinned, but
  currently never loaded (`SENTRY_DSN` empty, see §3)
- Nominatim/Overpass — API calls, not script includes

No automated dependency-vulnerability scanning exists in CI today
(`.github/workflows/ci.yml` runs lint/test/static-HTML-checks only,
`scripts/ci-checks.js` checks i18n/link/duplicate-id integrity, not
CVEs). Flagged for Phase 2/7, not treated as a finding here.

---

## 10. Business-logic domains present in this codebase

Directly relevant to the "one role acting as another" concern in the
brief — what actually exists today, so later phases test against real
surface, not a hypothetical:

- **Listings** (`listings` collection): create/update/delete scoped to
  the owning agent or admin, price/status/dealType/verified/private are
  all plain writable fields on the doc subject to the same agent-or-
  admin rule — no separate, more permissive path for changing price
  alone.
- **Commission** (`agent-dashboard.html`'s Finances tab): calculated
  **client-side, live, from that agent's own closed listings** — never
  stored as its own writable field an agent (or anyone) could directly
  set. `agentTransactions` (manual income/expense/purchase entries) are
  strictly owner+admin scoped.
- **Sellers/buyers**: no distinct account type — `sell.html` accepts
  guest submissions (no account required at all); a signed-in
  `customer` is the only real "buyer" role, no separate schema.
- **Offices/agencies/lawyers/engineers/designers/cleaners**
  (`services.html`): a static/config-driven directory as far as this
  pass found — not a Firestore-backed, user-editable profile type.
  Worth confirming in Phase 3 whether any of this is actually dynamic
  data with its own write path this map missed.
- **Company/agency** (`companies` collection): create-if-not-exists by
  any signed-in user (this is how `signup.html`'s agent-signup company
  field auto-provisions a company on first use); edit/delete admin-only.
- **User verification**: `sell.html`'s identity-verification selfie
  (`sell-verification` Storage path) is the only "verification" concept
  found — admin-read-only, tied to a specific sell submission, not a
  general user-verification badge/flag on `users/{uid}`.

No installment/payment-processing code exists anywhere in this
repository (no Stripe/PayPal/payment-gateway integration found) —
"installment/payment-related information" in the brief does not
correspond to an implemented feature to review.

---

## 11. What Phase 1 deliberately does not answer

- Whether the live production Storage bucket is actually provisioned
  (requires a live, non-destructive check — Phase 4).
- Whether every `innerHTML` site not spot-checked here is actually safe
  (Phase 3).
- Live behavior of the backend, since it isn't deployed yet — CORS/OTP/
  rate-limit behavior above is verified against the *code*, run
  locally, not against a live Cloud Run URL.
- A full, generic (not just known-prefix) secrets sweep of git history.
- Dependency CVE status for the pinned versions above (Phase 2/3).

Ready to proceed to Phase 2 (public vulnerability-pattern research and a
checklist) on your go-ahead — no source code has been modified in this
phase.
