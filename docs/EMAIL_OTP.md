# Email OTP — signup verification + password recovery

Status: **backend architecture implemented and tested, production email
delivery NOT enabled.** No real Resend API key is configured anywhere.
In production, the email-OTP routes structurally do not register at all
without one -- there is no mock-in-production fallback to worry about,
unlike a warn-and-continue design. Nothing in this document claims a
real email was ever delivered, because none has been.

This replaces the earlier WhatsApp-OTP product requirement
(`docs/WHATSAPP_OTP.md`, now marked superseded). It reuses that phase's
generic, channel-agnostic pieces (OTP generation/hashing, in-memory
challenge storage, purpose binding, rate limiting, Firebase UID
resolution/password-reset/session-revocation patterns) rather than
rebuilding them.

## Why email, and why this shape

- **Only two purposes use OTP at all**: `SIGNUP_EMAIL_VERIFY` and
  `PASSWORD_RESET`. Normal login never sends or requires an OTP.
- **Phone number remains the primary account identity** (per the
  project's phone-first direction), but email verification is what
  gates account creation and password recovery in this phase --
  Phone + Password login itself is explicitly a separate, later phase
  (see "What's still needed" below).
- **A 6-digit code, not a clickable link**, for both flows -- the
  existing link-based `/api/v1/auth/forgot-password` (milestone 3)
  stays as-is and untouched, available as a fallback.

## Architecture

```
Client                       Backend                            Firebase Auth (Admin SDK)   Resend
  |  POST /email-otp/send        |                                        |                    |
  |  {email, purpose:             |                                        |                    |
  |   SIGNUP_EMAIL_VERIFY}       |                                        |                    |
  |------------------------------>|  normalize email                     |                    |
  |                               |  rate limit (IP + email)             |                    |
  |                               |  SIGNUP_EMAIL_VERIFY does NOT         |                    |
  |                               |  resolve an account -- proving        |                    |
  |                               |  ownership IS the point               |                    |
  |                               |  generate 6-digit OTP (secrets)      |                    |
  |                               |  store HMAC(otp), uid=None, expiry,  |                    |
  |                               |  attempts=0 (in-memory, keyed         |                    |
  |                               |  SIGNUP_EMAIL_VERIFY:<email>)         |                    |
  |                               |  send_otp(email, code, purpose) --------------------------->
  |<------------------------------ generic "code sent" (always)          |                    |
  |                               |                                        |                    |
  |  POST /email-otp/verify       |                                        |                    |
  |  {email, purpose, code}      |                                        |                    |
  |------------------------------>|  check: not expired, not consumed,   |                    |
  |                               |  attempts < 5, HMAC(code) matches     |                    |
  |                               |  on success: consume challenge,       |                    |
  |                               |  mint opaque token bound to           |                    |
  |                               |  {uid=None, email, purpose, 10min}    |                    |
  |<------------------------------ {verifyToken}                          |                    |
  |                               |                                        |                    |
  |  POST /signup/complete        |                                        |                    |
  |  {verifyToken, fullName,     |                                        |                    |
  |   phoneNumber, password}     |                                        |                    |
  |------------------------------>|  look up verifyToken: not expired,   |                    |
  |                               |  not consumed, purpose ==             |                    |
  |                               |  SIGNUP_EMAIL_VERIFY -> consume it    |                    |
  |                               |  email comes from the TOKEN, never    |                    |
  |                               |  from the request body                |                    |
  |                               |  normalize phone -> E.164             |                    |
  |                               |  create_user(email, phone, password, --->                  |
  |                               |    email_verified=True) ------------->|                    |
  |                               |  (duplicate email/phone -> 409,       |                    |
  |                               |   Admin SDK's own atomic check)       |                    |
  |                               |  write users/{uid} profile doc ------>| (Firestore, Admin) |
  |                               |  create_custom_token(uid) ----------->|                    |
  |<------------------------------ {customToken, uid}                     |                    |
  |  client: signInWithCustomToken(auth, customToken)                     |                    |
```

Password reset follows the same `/email-otp/send` -> `/email-otp/verify`
path with `purpose: PASSWORD_RESET` (which DOES resolve an existing
account and stays enumeration-safe -- see "Purpose-specific behavior"
below), then:

```
  POST /password-reset/confirm  {resetToken, newPassword}
  -> update_user(uid, password=newPassword)   [Firebase Admin SDK]
  -> revoke_refresh_tokens(uid)                [old sessions killed]
```

`PasswordResetConfirmHandler` (`app/otp/handler.py`) is reused
**unchanged** from the WhatsApp-OTP phase -- it was already
channel-agnostic (consumes an opaque token, never a phone number or
email directly).

## Purpose-specific behavior (the key design decision)

`OtpService.send()` (`app/otp/service.py`) branches on purpose:

- **`PASSWORD_RESET`** resolves the email to a Firebase UID first
  (`get_user_by_email`). No account -> `SendResult.NOOP`, and the HTTP
  layer returns the *exact same* response as a real send either way.
  This is the enumeration-safe case: revealing "no account for this
  email" during password reset is a real vulnerability.
- **`SIGNUP_EMAIL_VERIFY`** never resolves an account at all -- there
  is deliberately no account yet. A challenge is always created and a
  code always sent, regardless of whether that email is already
  registered. "Already registered" is instead checked once, plainly,
  at final account creation (`SignupCompleteHandler`, HTTP 409): normal,
  expected signup UX, not a sensitive disclosure the way password-reset
  enumeration is.

## Files

- `backend/app/otp/service.py` -- `OtpService`, now channel-agnostic
  (`identifier` rather than a phone-specific name), `Purpose` enum
  (`SIGNUP_EMAIL_VERIFY`, `PASSWORD_RESET`), the per-purpose
  account-requirement split above, `OtpSender` protocol
  (purpose-aware, unlike the original WhatsApp-only version).
- `backend/app/otp/store.py` -- `Challenge`/`ResetToken`, `identifier`
  generalized from `phone_e164`, `uid` now `str | None` (None for
  `SIGNUP_EMAIL_VERIFY`, since no account exists at send time). Two
  storage implementations behind the same async `ChallengeStore`
  Protocol -- see "Shared production storage" below.
- `backend/app/otp/email_address.py` -- email normalization
  (lowercase, trim).
- `backend/app/otp/email_templates.py` -- the two branded HTML emails
  (signup verify, password reset) -- see "Email design" below.
- `backend/app/otp/email_sender.py` -- `MockEmailSender` (dev/test
  only) and `ResendOtpEmailSender` (real, mirrors
  `app/auth/resend_email.py`'s existing pattern).
- `backend/app/otp/firebase_admin_ops.py` -- renamed
  `FirebaseAccountOps` (was `FirebasePhoneAuthManager`); adds
  `resolve_uid_by_email`, `create_account`, `create_user_profile`,
  `delete_account` (compensating rollback -- see "Orphan-account
  rollback" below), `mint_custom_token`, `AccountAlreadyExists`; keeps
  `resolve_uid_by_phone` (unused today, reserved for the future
  Phone + Password phase) and `set_password_and_revoke_sessions`
  (reused unchanged).
- `backend/app/otp/email_handler.py` -- `EmailOtpSendHandler`,
  `EmailOtpVerifyHandler`, `SignupCompleteHandler`.
- `backend/app/main.py` (`build_email_otp_handlers`) -- wiring; the
  hard production gate (see below); registers
  `PasswordResetConfirmHandler` from `app/otp/handler.py`.
- `backend/app/otp/handler.py`, `backend/app/otp/whatsapp.py`,
  `backend/app/otp/phone.py` -- **superseded but preserved**, not
  deleted (see "WhatsApp code disposition" below). `phone.py` is still
  actively used (E.164 normalization for the phone number captured at
  signup).
- `backend/tests/test_otp.py`, `backend/tests/test_email_otp.py`,
  `backend/tests/test_email_templates.py`.

## OTP security controls (implemented)

Same control set as the WhatsApp-OTP phase, reused via the shared
`OtpService`, plus what's new for signup/email specifically:

| Requirement | Implementation |
|---|---|
| Cryptographically secure 6-digit OTP | `secrets.randbelow` (`app/otp/codes.py`) |
| ~10 minute expiration | `DEFAULT_OTP_TTL_SECONDS = 10 * 60` |
| One-time use | `Challenge.consumed`, `ResetToken.consumed` |
| Server-side generation & verification only | Entire lifecycle lives in `OtpService`; the browser never generates or checks a code |
| No plaintext OTP storage | Only `HMAC(code, OTP_HMAC_SECRET)` is stored |
| Max verification attempts | 5 per challenge |
| Resend cooldown | ~60s, checked before creating a new challenge |
| Per-email rate limiting | `RateLimiter` keyed by normalized email (send) |
| Per-IP rate limiting | `RateLimiter` keyed by client IP (send, verify, and signup/complete each have their own) |
| Invalidate/replace previous code | A new send overwrites the same `purpose:email` key |
| Replay protection | Single-use challenges and tokens |
| No OTP/password values in logs | Log calls carry `purpose`/`error`/`uid_suffix` only |
| Account enumeration protection | `PASSWORD_RESET` send is indistinguishable whether or not the account exists; `verify` collapses wrong/expired/reused/no-challenge into one response |
| Generic responses | `"If this email is registered, a verification code has been sent."` regardless of outcome |
| Purpose binding | `SIGNUP_EMAIL_VERIFY` and `PASSWORD_RESET` challenges live under different store keys -- a signup code cannot verify a password-reset challenge or vice versa (tested directly both ways) |
| Reset/verify scoped to the right account | `resetToken`/`verifyToken` bound server-side to a specific uid (or, for signup, to no uid yet) at verify time; neither endpoint that consumes one accepts a phone/email/uid from the caller |
| Session revocation after reset | `revoke_refresh_tokens(uid)` called immediately after `update_user` |
| Never store plaintext passwords | Firebase Admin SDK owns password hashing/storage throughout; this backend never persists a password anywhere, in Firestore or otherwise |

## Shared production storage

`InMemoryChallengeStore` (process-local, guarded by a lock) is correct
only for a single backend instance/worker. Cloud Run (the recommended
host -- see `backend/README.md`) scales to multiple instances by
default, and a signup's `/send` hitting one instance while `/verify`
hits another would see no matching challenge at all under that store.
`app.main.build_email_otp_handlers` now selects between the two
implementations automatically:

- **`cfg.is_production` true** -> `FirestoreChallengeStore`
  (`app/otp/store.py`), backed by the same Firestore client
  `FirebaseAccountOps` already holds (`accounts.firestore_client`) --
  no second client, no new service to provision. Every OTP
  challenge/reset-token write goes through the backend's own Admin SDK
  credential, which bypasses `firestore.rules` entirely (as any Admin
  SDK access does) -- `firestore.rules` additionally denies all
  client read/write on `otpChallenges/{key}` and
  `otpResetTokens/{token}` explicitly, so this is never reachable from
  the browser even in principle, not just "the frontend doesn't call
  it."
- **Otherwise (development/tests)** -> `InMemoryChallengeStore`, no
  Firestore round-trips needed.

No paid dependency was introduced -- Firestore is already provisioned
for this same Firebase project. Redis (e.g. Cloud Memorystore, ~$35+/mo
minimum) was considered and rejected for this phase on cost/complexity
grounds; Firestore is free-tier-eligible at OTP-store traffic volumes
and needs no new infrastructure.

**Correctness properties, verified against a real Firestore emulator
(not just read from the rules/code) before this was reported ready:**
a challenge created via one store instance is immediately visible to a
second, independently-constructed store instance (the property
`InMemoryChallengeStore` cannot provide once there's more than one
backend instance); `record_failed_attempt` -- the one operation two
concurrent wrong-guesses could race on -- runs inside a real Firestore
transaction and was confirmed atomic and lossless under realistic
concurrency (multiple simultaneous guesses against one challenge, split
across two independent store/client instances simulating two backend
workers). Under artificial, far-beyond-realistic contention (10-way,
zero backoff, well past what `max_attempts=5` would ever allow to
build up against a single challenge) the Firestore client's own commit
retries can be exhausted; `record_failed_attempt` catches that and
returns `None`, which `OtpService.verify` already treats identically to
"no such challenge" (`VerifyResult.INVALID_OR_EXPIRED`) -- logged at
error level so repeated occurrences get attention, but never an
unhandled exception reaching the HTTP layer.

**Expiration** is enforced by application logic (`OtpService` checks
`expires_at` on every read) regardless of which store is active, so
correctness never depends on Firestore actually deleting expired
documents. For storage hygiene (not correctness), configure a native
Firestore TTL policy on the `expiresAt` field of both collections --
via Console (Firestore -> a collection -> the field's TTL setting) or
`gcloud firestore fields ttls update expiresAt --collection-group=otpChallenges ...`
-- once this is deployed; this is a manual, one-time infrastructure
step, not something application code can set.

## Orphan-account rollback

`SignupCompleteHandler.complete()` does two Firebase operations that
have no shared transaction: create the Auth account
(`FirebaseAccountOps.create_account`), then write its Firestore profile
(`create_user_profile`, plus `ensure_company` for an agent signup). If
the first succeeds and the second fails (a transient Firestore error,
for example), the naive outcome is an Auth account with no
`users/{uid}` doc -- a real user record they could sign into but that
none of the rest of the app can find. This is now handled as a
best-effort compensating action, not left as a silent partial state:

1. `try_consume_reset_token` (see "Shared production storage" -- this
   fix reuses the same atomic primitive) checks-and-marks the
   `verifyToken` consumed in one step, so two concurrent completions of
   the same token can never both reach account creation -- only one
   request ever gets to be the one that might need to roll back.
2. `create_account` either fails outright (nothing to roll back -- an
   `AccountAlreadyExists` 409, or a generic 500) or returns a `uid`
   Firebase's Admin SDK generated fresh for this exact call. There is
   no partial-success state for `create_user` and no way that `uid`
   could belong to any other account, existing or otherwise -- so this
   is the one and only account this request is ever allowed to delete.
3. If `ensure_company`/`create_user_profile` then fails,
   `FirebaseAccountOps.delete_account(uid)` is called with exactly that
   `uid` as a compensating rollback, and the endpoint returns a plain
   500 ("Could not complete your signup right now") -- never the 200 +
   `customToken` the old behavior returned for a profile-less account.
4. If the rollback itself also fails (no shared transaction means this
   is genuinely possible), that's logged at error level as needing
   manual reconciliation, and the account remains -- but a later retry
   with a fresh token cannot silently duplicate it: `create_account`'s
   own atomic email/phone check turns it into a normal 409 "already
   exists" response, the same one a genuine duplicate signup gets.

What this does NOT do: roll back `ensure_company`. A company doc is
create-if-not-exists and never carries per-user data, so leaving one
behind after a failed signup is harmless (a future signup for that
company just joins it) and not part of the "orphan account" problem
this fix targets. It also doesn't touch the `mint_custom_token` failure
path -- by the time that call happens, both the Auth account AND its
Firestore profile already exist; a token-minting failure there just
means the sign-in convenience token didn't mint, not a partial account,
so the existing "account created, please log in" response is correct
and unchanged.

Logging throughout this path carries only `uid_suffix` (last 6 chars,
for correlating log lines) and `str(exc)`/`str(rollback_exc)` from
Firebase/Firestore client errors -- never the password, the OTP code,
the `verifyToken`, the minted custom token, or any credential; none of
those values are ever passed into a log call in this file.

Verified directly in `tests/test_email_otp.py` (scenarios A-F, matching
the same lettering used to request this fix): (A) profile failure after
successful Auth creation never returns 200; (B) a successful rollback
actually frees the email/phone for reuse, not just marks something
deleted; (C) a rollback that itself fails still returns a safe generic
error rather than crashing, and leaves the account queryable via the
normal duplicate-email path; (D) rollback is proven, end to end, to
never touch a pre-existing account created outside the failing request
(the fake account-ops layer additionally asserts this invariant
directly: it refuses to "delete" any uid it didn't itself create); (E)
two genuinely concurrent completions of the same verifyToken (issued
through the real ASGI stack via `httpx.AsyncClient`/`ASGITransport`,
not just two sequential calls) produce exactly one success and one
clean rejection, plus a deterministic store-level test of the same
atomic-consume guarantee; (F) retrying with a fresh token after a
successful rollback completes cleanly with exactly one surviving
account, and retrying after a *failed* rollback gets a clean 409
instead of a second orphan.

## Email design

Original Darwesh Group branding (reuses this project's own established
brand colors from `app/auth/resend_email.py`'s existing template, for
consistency across every email this project sends) -- table-based
layout with inline CSS for cross-client reliability (Gmail/Outlook/
mobile), a large monospace code with wide letter-spacing rendered via a
single table cell (not six separate cells, which many clients render
inconsistently), a 10-minute expiry note, and a security warning. The
CyberShield UX concept (card / heading / big code / expiry / warning)
is followed at the level of "what sections exist", never as copied
markup, CSS, or wording -- verified directly:
`backend/tests/test_email_templates.py::test_no_external_or_sensitive_information_embedded`
asserts the string `"cybershield"` does not appear anywhere in the
rendered output. Signup and password-reset emails have distinct
subjects and body wording throughout, tested explicitly.

## Email provider

**Resend**, per your approval -- the project already has a tested
Resend integration (`app/auth/resend_email.py`), reused via a sibling
module (`app/otp/email_sender.py`) for the code-based templates.
**No paid plan has been purchased or activated.** Free tier: 3,000
emails/month, 100/day, 1 verified sending domain.

## WhatsApp code disposition

`app/otp/handler.py`'s `OtpSendHandler`/`OtpVerifyHandler` (phone-
specific) and `app/otp/whatsapp.py` (`WhatsAppSender`/
`MockWhatsAppSender`) are **not wired into `app.main` anymore** -- no
WhatsApp provider was ever activated in production, so nothing here has
ever actually run in production. Both files are left in place, still
fully covered by `tests/test_otp.py`, as reusable components if
phone-channel OTP is revisited later, rather than deleted. Only one
live password-reset-confirmation architecture exists at a time
(`PasswordResetConfirmHandler`), shared by both the (dormant) phone
flow's design and the (live) email flow.

## What's still needed before this is live

1. **A real Resend API key and verified sending domain** -- create a
   free Resend account, verify a domain you control (e.g.
   `darweshgroup.com`), generate an API key, set `RESEND_API_KEY` and
   `RESET_EMAIL_FROM` on wherever this is deployed. Not done in this
   session -- no paid plan should be activated without your explicit
   go-ahead, and none was.
2. **Deployment** -- this backend isn't deployed anywhere yet (see
   `docs/BACKEND_MILESTONES.md`, milestone 2). Email-OTP endpoints need
   a real, reachable server before any of this can run against
   production traffic. The multi-instance OTP-storage concern that
   would otherwise block a scale-to-many-instances host like Cloud Run
   is already resolved (see "Shared production storage" above) --
   deployment itself, not this, is what's outstanding.
3. **Frontend integration** -- `signup.html` and a rebuilt
   `reset-password.html` (or new pages) need to actually call these
   four endpoints with a 6-digit code entry UI. Not built in this
   phase -- this was a backend-architecture phase by design (staged
   rollout, per your instruction not to big-bang this), and the
   endpoints' exact request/response shapes needed to be settled and
   tested first. Proposed as the next phase.
4. **Phone + Password login** -- explicitly deferred to a later phase,
   per your instruction. `resolve_uid_by_phone` and `PhoneUidResolver`
   are already in place in `firebase_admin_ops.py`, unused, ready for
   that phase's design (which still needs to solve Identity Platform's
   password-sign-in-requires-an-email constraint -- see the
   architecture discussion from the earlier audit turn in this
   conversation).
5. ~~Firestore profile write reconciliation gap~~ -- **resolved.** If
   `create_user_profile` (or `ensure_company`) fails after
   `create_account` succeeds, `SignupCompleteHandler` now attempts a
   compensating rollback (`FirebaseAccountOps.delete_account(uid)`)
   rather than returning success for a half-provisioned account -- see
   "Orphan-account rollback" below for the full design and
   `tests/test_email_otp.py`'s scenario A-F tests for coverage.

Until (1)-(3) are addressed, the backend is safe to leave deployed (no
route runs mock delivery in production; everything degrades to a 404
without real credentials) but delivers no real capability yet. The
existing email-based `/api/v1/auth/forgot-password` (milestone 3)
remains untouched and available as a fallback for any account with an
email.
