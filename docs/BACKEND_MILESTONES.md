# Backend Milestones

The full platform spec calls for a backend API, PostgreSQL, Redis, a
commission/contracts/audit-log engine, CI/CD, a VPS or cloud deployment,
and more. Building all of that in one pass would mean writing thousands
of lines of code connected to nothing -- no database has been
provisioned, no server has been deployed, no hosting decision has been
made. This document tracks it as a sequence of small, real, verified
steps instead, per the spec's own rule: *"Do not try to implement
everything in one massive change. Use milestones."*

Each milestone below is only started once the previous one is real,
tested, and (where it needs one) deployed -- not just written.

**Language note:** `backend/` was originally written in Go/Gin and was
later ported to Python/FastAPI (`app/`), file-for-file, preserving every
documented design decision and its full test coverage (same 18 tests, now
as `pytest`). The milestones below describe the same behavior either way
-- only the run/build/test commands in `backend/README.md` changed.

## Milestone 1 — Server foundation ✅ done

`backend/` — a real FastAPI HTTP server. No database, no external
services.

- Health checks (`/healthz`, `/api/v1/health`)
- Structured JSON logging (method/path/status/latency/IP only — never
  headers, bodies, or query strings, so it can't leak a token or
  password once endpoints that accept them exist)
- CORS with an explicit allowlist (empty by default — no origin is
  trusted until named)
- The two response headers this API can actually set on its own
  (`X-Content-Type-Options`, `Referrer-Policy`) — see
  `docs/SECURITY_AUDIT.md` L1 for why the rest (CSP/HSTS/etc.) don't
  apply to a JSON API with no HTML responses
- Graceful shutdown on SIGINT/SIGTERM (handled natively by Uvicorn)
- A Dockerfile (multi-stage, non-root user)
- 5 tests, all passing (`pytest`)

**Verified for real**, not just written: installed dependencies, ran the
actual Uvicorn server, hit it with `curl` — health endpoints return 200,
CORS correctly rejects an unlisted origin and allows a listed one
(including a real OPTIONS preflight request), security headers are
present. The Docker image could not be built in this environment (its
network policy blocks pulling base images) but the Dockerfile follows a
standard, widely-used pattern and the server itself already runs
correctly outside a container.

**Not done yet, deliberately:** it isn't deployed anywhere. It exists in
this repo and works locally; nothing on the live site talks to it.

## Milestone 2 — Deployment decision + first real deploy

Blocked on you, not on code: **where does this run?** (Cloud Run
recommended — see `backend/README.md` "Deployment" for the tradeoffs.)
Whichever is chosen needs an account with billing, and I'd need
temporary deploy access or you'd run the deploy command yourself from
the steps I provide — I have no credentials to any cloud provider or
VPS from this session.

Once deployed: confirm `https://<wherever>/healthz` responds from the
real internet, and only then wire the live frontend to call it for
anything.

## Milestone 3 — Branded password-reset email ✅ code done, not deployed

`POST /api/v1/auth/forgot-password` — generates a Firebase password-reset
link server-side (Admin SDK) and sends a branded HTML email via Resend.
Only registers at all when `FIREBASE_SERVICE_ACCOUNT_JSON`,
`RESET_PASSWORD_CONTINUE_URL`, `RESEND_API_KEY`, and `RESET_EMAIL_FROM`
are all set — otherwise it's a 404, not a route that silently fails.

**A real bug fix falls out of this, not just a feature add:** the
Admin SDK's generated link *also* routes through
`<project>.firebaseapp.com/__/auth/action` first — the same domain that
turned out to be unreachable on some networks earlier (why
`reset-password.html` exists as a custom page in the first place). Since
this endpoint builds its own email, it extracts just the `oobCode` from
Firebase's link and constructs a URL pointing straight at
`reset-password.html`, so the visitor's browser never has to load
anything from `firebaseapp.com` at all. Verified against the exact link
format Firebase produced in production (see
`tests/test_firebase_reset.py`).

**Verified for real:**
- 18 tests across the auth/server modules, all passing — including the
  enumeration-safety property itself (a registered vs. unregistered
  email get byte-identical responses, asserted directly, not just
  "looks right"), rate limiting (a burst gets blocked, a different IP
  is tracked independently, the window expiring unblocks it), the
  oobCode-extraction bug fix against the real link format, and HTML
  injection can't break out of the email's `href`.
- Ran the actual Uvicorn server three ways: fully unconfigured (route
  correctly absent, health checks unaffected), with invalid credentials
  present (logs the specific error, still doesn't crash or half-register
  the route), and confirmed `ruff check`/`ruff format --check`/`pytest`
  all clean.
- **Not tested against real Firebase or Resend** — no real service
  account or API key exists yet. The interfaces (`ResetLinkGenerator`,
  `EmailSender`) are exactly what make the parts that *can* be verified
  without real credentials (validation, enumeration-safety, rate
  limiting, the link fix) actually get verified, rather than everything
  being an unverifiable black box behind two API calls.

**To actually turn this on:** create a Firebase service account key
(Console → Project Settings → Service Accounts) and a free Resend
account with a verified sending domain, then set the four env vars above
on wherever this ends up deployed (milestone 2).

## Milestone 4 — WhatsApp OTP password recovery ⚠️ superseded by milestone 4b

Code built and fully tested (18 tests at the time), never deployed, no
real WhatsApp provider ever activated. The product requirement moved to
email OTP before this went live — see milestone 4b and
`docs/WHATSAPP_OTP.md` (now marked superseded there). The code
(`app/otp/handler.py`'s `OtpSendHandler`/`OtpVerifyHandler`,
`app/otp/whatsapp.py`) is preserved, not deleted, and still covered by
`backend/tests/test_otp.py`, but is no longer wired into `app.main`.

## Milestone 4b — Email OTP: signup verification + password recovery ✅ code done, not deployed, no real provider

`POST /api/v1/auth/email-otp/send`, `POST /api/v1/auth/email-otp/verify`,
`POST /api/v1/auth/signup/complete`, `POST /api/v1/auth/password-reset/confirm`
— a 6-digit email code for both new-account verification and password
recovery, replacing milestone 4's WhatsApp design as the current product
requirement. Full architecture, security controls, and what's still
needed before real delivery works: `docs/EMAIL_OTP.md`.

Only registers when `FIREBASE_SERVICE_ACCOUNT_JSON` and `OTP_HMAC_SECRET`
are both set — same "route doesn't exist if unconfigured" rule as
milestone 3. Unlike milestone 4's warn-and-continue approach, this is a
**hard gate**: in a production environment, missing `RESEND_API_KEY`/
`RESET_EMAIL_FROM` means the routes are NOT registered at all — mock
email delivery cannot run in production, structurally, not just by
convention.

**Verified for real:** the full OTP lifecycle (generation, HMAC hashing,
~10-minute expiry, single use, attempt cap, resend cooldown, per-email/
per-IP rate limits, purpose binding between `SIGNUP_EMAIL_VERIFY` and
`PASSWORD_RESET`, verify/reset-token issuance and consumption, Firebase
UID resolution by email, account creation with duplicate-email/phone
rejection, custom-token minting, password update, session revocation)
is exercised by `backend/tests/test_email_otp.py` and
`backend/tests/test_email_templates.py` against fakes for the Resend
send and the Firebase Admin SDK calls — including wrong/expired/reused/
too-many-attempts OTP, a signup code that can't authorize a password
reset and vice versa, user A's verification never producing a token
usable on user B's account, and the production mock-delivery gate
itself (confirmed via 4 real server-startup scenarios: unconfigured,
configured/dev-with-mock, configured/production-without-Resend-creds
[routes absent], configured/production-with-Resend-creds [routes live]).

**Not tested against a real Resend account or a real Firebase project**
— no API key or valid service-account credentials exist for this yet.
**Not wired into any frontend page** — this milestone is backend-only;
`signup.html`/a rebuilt `reset-password.html` with a 6-digit code UI are
separate, later work now that the backend's exact request/response
shapes are settled and tested.

## Milestone 5+ — everything else, only as justified

PostgreSQL, Redis, the commission/contracts/audit-log engine, RBAC beyond
what Firestore rules already enforce, AI backend, Cloudflare, CI/CD
security scanning, backups, VPS hardening. Each of these gets its own
milestone, started only when a specific real feature needs it — not
pre-built speculatively. Current read (see `docs/ARCHITECTURE_AUDIT.md`
and `docs/SECURITY_AUDIT.md`): at 4 test listings and no live inventory,
none of these are load-bearing yet. That assessment gets revisited as
real usage grows, not assumed to hold forever.
