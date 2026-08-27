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

## Milestone 4+ — everything else, only as justified

PostgreSQL, Redis, the commission/contracts/audit-log engine, RBAC beyond
what Firestore rules already enforce, AI backend, Cloudflare, CI/CD
security scanning, backups, VPS hardening. Each of these gets its own
milestone, started only when a specific real feature needs it — not
pre-built speculatively. Current read (see `docs/ARCHITECTURE_AUDIT.md`
and `docs/SECURITY_AUDIT.md`): at 4 test listings and no live inventory,
none of these are load-bearing yet. That assessment gets revisited as
real usage grows, not assumed to hold forever.
