# WhatsApp OTP — phone-based password recovery

**Superseded.** The product requirement moved to email OTP for signup
verification and password recovery — see `docs/EMAIL_OTP.md`. Nothing
described below is wired into `app.main` anymore (`app/otp/handler.py`'s
`OtpSendHandler`/`OtpVerifyHandler` and `app/otp/whatsapp.py` are no
longer constructed or registered as routes), and no WhatsApp provider
was ever activated, so nothing here has ever run in production. The
code is left in place, still fully covered by `tests/test_otp.py`, as a
reusable component if phone-channel OTP is revisited later — not
deleted. `PasswordResetConfirmHandler` (`app/otp/handler.py`) is the one
piece that carried forward unchanged: it was already channel-agnostic
and is now the live confirm endpoint for the email-OTP flow instead.

Status as of when this was live-in-code (kept for history): **backend
architecture implemented and tested, production delivery NOT enabled.**
No real WhatsApp Business provider was ever wired up — every request
ran against `MockWhatsAppSender`, which delivers nothing anywhere.
Nothing in this document claims a real message was ever sent, because
none was.

## Why this exists

The target login UX for darweshgroup.com is phone number + password by
default (email + password kept as an optional path, particularly for
existing accounts). "Forgot password" for a phone-primary account can't
depend on an email the user may not have supplied, so it goes through a
WhatsApp-delivered one-time code instead. Firebase Authentication has no
native WhatsApp OTP support and no "phone number + password" sign-in
method — this flow is entirely custom, built on top of Firebase Auth's
Admin SDK, not a replacement for it.

## Architecture

```
Client                      Backend                          Firebase Auth (Admin SDK)   WhatsApp
  |  POST /auth/otp/send        |                                     |                      |
  |  {phoneNumber,               |                                     |                      |
  |   purpose:PASSWORD_RESET}   |                                     |                      |
  |----------------------------->|  normalize phone -> E.164          |                      |
  |                              |  rate limit (IP + phone)           |                      |
  |                              |  get_user_by_phone_number ---------->                      |
  |                              |<---------------------------------- uid (or "not found")    |
  |                              |  generate 6-digit OTP (secrets)    |                      |
  |                              |  store HMAC(otp), uid, expiry,     |                      |
  |                              |  attempts=0 (in-memory, keyed      |                      |
  |                              |  PASSWORD_RESET:<phone>)           |                      |
  |                              |  send_otp_message(phone, otp) ------------------------------->
  |<----------------------------- generic "code sent" (always, even   |                      |
  |                              |  if no account matched the phone)  |                      |
  |                              |                                     |                      |
  |  POST /auth/otp/verify       |                                     |                      |
  |  {phoneNumber, purpose, code}|                                     |                      |
  |----------------------------->|  look up challenge by key          |                      |
  |                              |  check: not expired, not consumed, |                      |
  |                              |  attempts < 5, HMAC(code) matches  |                      |
  |                              |  on success: consume challenge,    |                      |
  |                              |  mint opaque resetToken bound to   |                      |
  |                              |  {uid, phone, purpose, 10min TTL}  |                      |
  |<----------------------------- {resetToken}   (or generic error)   |                      |
  |                              |                                     |                      |
  |  POST /password-reset/confirm|                                     |                      |
  |  {resetToken, newPassword}  |                                     |                      |
  |----------------------------->|  look up resetToken: not expired,  |                      |
  |                              |  not consumed, purpose==            |                      |
  |                              |  PASSWORD_RESET -> consume it       |                      |
  |                              |  update_user(uid, password=...) ---->                      |
  |                              |  revoke_refresh_tokens(uid) -------->                      |
  |<----------------------------- "password reset, please log in"    |                      |
```

Key property: **the browser never sees a Firebase Admin credential, a
phone→UID mapping, or which UID a resetToken is bound to.** The token
itself is the only thing the client holds between verify and confirm,
and it's opaque and single-use.

## Why Firebase Auth is still authoritative

Firebase Auth remains the system of record for the password itself
(`firebase_admin.auth.update_user(uid, password=...)` — the Admin SDK
hashes and stores it, this backend never does), the UID, and session
validity (`revoke_refresh_tokens`). This backend only adds the piece
Firebase doesn't provide: verifying *who's asking* via a WhatsApp code
before it will touch that account. No fake-email workaround
(`964xxxxxxxxx@darwesh.local` or similar) was introduced by this change —
existing email/password accounts are completely untouched by this flow.
(A phone-first *signup* — where an account's only identifier is a phone
number, no email at all — is a separate, not-yet-built piece: see
"What's still needed" below. It will need its own explicit design
decision about how Firebase Auth's password-sign-in requirement, which
is keyed on an email field internally, gets satisfied for an
email-less account, and that decision should be reviewed before it's
built, not made silently inside this change.)

## Files

- `backend/app/otp/codes.py` — cryptographically secure 6-digit OTP
  generation (`secrets.randbelow`, not `random`) and HMAC-SHA256 hashing
  (`OTP_HMAC_SECRET`-keyed; the plaintext code is never stored).
- `backend/app/otp/phone.py` — canonical Iraqi E.164 normalization
  (`0750 XXX XXXX` → `+964750XXXXXXX`), rejects anything unrecognizable.
- `backend/app/otp/store.py` — in-memory challenge/reset-token storage.
  Same tradeoff already accepted for `app.auth.reset.RateLimiter`:
  correct for the single backend instance that's actually deployed
  today (nothing is deployed at all yet — see
  `docs/BACKEND_MILESTONES.md`). Swap for a shared store together with
  `RateLimiter` if this ever runs as more than one instance.
- `backend/app/otp/whatsapp.py` — `WhatsAppSender` protocol +
  `MockWhatsAppSender` (the only implementation that exists right now).
- `backend/app/otp/firebase_admin_ops.py` — the only code that talks to
  the Admin SDK for this flow: `get_user_by_phone_number`,
  `update_user(password=...)`, `revoke_refresh_tokens`.
- `backend/app/otp/service.py` — `OtpService`: send/verify orchestration,
  purpose binding, single-use/expiry/attempt-cap enforcement.
- `backend/app/otp/handler.py` — the three HTTP endpoints.
- `backend/app/main.py` (`build_otp_handlers`) — wiring, only registers
  the routes when `FIREBASE_SERVICE_ACCOUNT_JSON` and `OTP_HMAC_SECRET`
  are both set; logs a loud warning if `APP_ENV=production` and
  `WHATSAPP_PROVIDER` is still `mock`.
- `backend/tests/test_otp.py` — see "Test coverage" below.

## OTP security controls (implemented)

| Requirement | Implementation |
|---|---|
| Cryptographically secure 6-digit OTP | `secrets.randbelow` |
| ~5 minute expiration | `Challenge.expires_at`, checked on every verify |
| One-time use | `Challenge.consumed`, `ResetToken.consumed` |
| Server-side generation & verification only | Entire OTP lifecycle lives in `OtpService`; nothing client-side generates or checks a code |
| Server-side storage only | `InMemoryChallengeStore`, process-local |
| No plaintext OTP storage | Only `HMAC(code, OTP_HMAC_SECRET)` is stored |
| Invalidate on success | `consume_challenge` |
| Invalidate/replace previous OTP | A new `send` overwrites the same `purpose:phone` key |
| Max verification attempts | 5, tracked per challenge |
| Resend cooldown | 60s, checked before creating a new challenge |
| Per-phone rate limiting | `RateLimiter` keyed by normalized phone (send) |
| Per-IP rate limiting | `RateLimiter` keyed by client IP (send + verify) |
| Brute-force protection | Attempt cap + per-IP verify limiter |
| Enumeration protection | `send` returns the identical response whether or not the phone has an account (`SendResult.SENT` vs `NOOP` are indistinguishable at the HTTP layer); `verify` collapses "no challenge"/"wrong code"/"expired"/"already used" into one response |
| Replay protection | Single-use challenges and reset tokens |
| No OTP/password values in logs | Log calls carry `purpose`/`error`/`uid_suffix` only — grep the handler and service modules to verify |
| Cleanup of expired records | Opportunistic pruning on every store access |
| Purpose binding | Challenge key is `{purpose}:{phone}` — a `PASSWORD_RESET` challenge cannot verify against a `SIGNUP` lookup or vice versa (only `PASSWORD_RESET` is accepted at the HTTP layer today; `SIGNUP` exists in the `Purpose` enum and is proven isolated at the service-test level ahead of having an endpoint) |
| Reset scoped to the right account | The `resetToken` is bound server-side to one `uid` at verify time; `password-reset/confirm` never accepts a phone/uid from the caller |
| Session revocation after reset | `revoke_refresh_tokens(uid)` called immediately after `update_user` |

## What's still needed before this is live

1. **A real WhatsApp Business provider account**, created and configured
   by you — this session cannot create third-party accounts or invent
   API credentials. Options, in order of how this document would
   recommend evaluating them:
   - **Meta Cloud API (direct)** — no per-message markup beyond Meta's
     own conversation pricing, but requires Meta Business verification
     (can take several days) and you manage webhooks/templates directly
     against Meta's API.
   - **Twilio's WhatsApp API** — faster to get sending (Twilio's own
     onboarding), simpler dashboard, small per-message markup on top of
     Meta's conversation cost.
   - Either way, an OTP delivery template needs to be submitted for
     WhatsApp's template approval process before it can be used
     outside a 24-hour customer-initiated conversation window — this is
     a WhatsApp Business Platform requirement, not something any code
     change can skip.
2. **A `WhatsAppSender` implementation for the chosen provider** —
   `backend/app/otp/whatsapp.py` defines the interface; a new class
   implementing `send_otp_message` is the only code that needs to
   change. `app/main.py`'s `build_otp_handlers` gets a new branch for
   the provider's name once one exists.
3. **Deployment** — this backend isn't deployed anywhere yet (see
   `docs/BACKEND_MILESTONES.md`, milestone 2). OTP endpoints need a
   real, reachable server before any of this can run against production
   traffic.
4. **A way for a real account to have a verified phone number at all** —
   today, zero existing accounts have `phone_number` set on their
   Firebase Auth record (legacy accounts are email/password only), so
   `get_user_by_phone_number` will not resolve any of them yet and every
   `/otp/send` call against a real phone will correctly return
   `SendResult.NOOP` (the generic "sent" response, but no code actually
   goes anywhere). This is expected, not a bug — it's what "no phone
   attached" is supposed to look like. A phone-first signup flow or an
   authenticated "add/verify phone to my existing account" flow is a
   separate, later piece of work that populates this field for real
   accounts; this document's flow only *consumes* a phone number that's
   already verified on the account, it doesn't attach one.

Until (1)-(4) are addressed, this flow is safe to leave deployed (it
degrades to a harmless no-op against real accounts) but delivers no
real recovery capability. The existing email-based
`/api/v1/auth/forgot-password` (see `docs/BACKEND_MILESTONES.md`
milestone 3) remains the working recovery path for accounts that have
an email — untouched by any of this.
