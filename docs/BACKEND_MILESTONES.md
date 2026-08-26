# Backend Milestones

The full platform spec calls for a Go/Gin backend, PostgreSQL, Redis, a
commission/contracts/audit-log engine, CI/CD, a VPS or cloud deployment,
and more. Building all of that in one pass would mean writing thousands
of lines of code connected to nothing -- no database has been
provisioned, no server has been deployed, no hosting decision has been
made. This document tracks it as a sequence of small, real, verified
steps instead, per the spec's own rule: *"Do not try to implement
everything in one massive change. Use milestones."*

Each milestone below is only started once the previous one is real,
tested, and (where it needs one) deployed -- not just written.

## Milestone 1 — Server foundation ✅ done

`backend/` — a real Gin HTTP server. No database, no external services.

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
- Graceful shutdown on SIGINT/SIGTERM
- A Dockerfile (multi-stage, non-root user)
- 5 tests, all passing (`go test ./...`)

**Verified for real**, not just written: built (`go build`), run, hit
with `curl` — health endpoints return 200, CORS correctly rejects an
unlisted origin and allows a listed one, security headers are present,
graceful shutdown drains cleanly. The Docker image could not be built
in this environment (its network policy blocks pulling from Docker Hub)
but the Dockerfile follows a standard, widely-used pattern and the
binary itself already runs correctly outside a container.

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

## Milestone 3 — First real endpoint (candidate: branded password-reset email)

The smallest, already-scoped-and-wanted real feature: a Cloud Function/
endpoint that generates a Firebase password-reset link server-side
(Admin SDK) and sends a branded HTML email via a transactional email API
(Resend/SendGrid/etc.). Exercises real secrets (Firebase service account,
email API key) via environment variables for the first time — a good
forcing function to get secret management right before anything bigger
depends on it.

## Milestone 4+ — everything else, only as justified

PostgreSQL, Redis, the commission/contracts/audit-log engine, RBAC beyond
what Firestore rules already enforce, AI backend, Cloudflare, CI/CD
security scanning, backups, VPS hardening. Each of these gets its own
milestone, started only when a specific real feature needs it — not
pre-built speculatively. Current read (see `docs/ARCHITECTURE_AUDIT.md`
and `docs/SECURITY_AUDIT.md`): at 4 test listings and no live inventory,
none of these are load-bearing yet. That assessment gets revisited as
real usage grows, not assumed to hold forever.
