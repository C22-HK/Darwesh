# Darwesh Group — Authentication State Machines (Stage 2)

Derived directly from `backend/app/otp/service.py`, `store.py`,
`email_handler.py`, `handler.py` as they exist today, and proven where
noted against real (not simulated-in-prose) test runs. Every "cannot"
claim below is backed by either an existing passing test (cited by
name, re-run fresh this stage) or a new evidence script written for
this review (in the session scratchpad, not committed).

---

## 1. OTP Challenge state machine

One challenge exists per `(purpose, identifier)` pair — the store key
is literally `f"{purpose}:{identifier}"`, so `SIGNUP_EMAIL_VERIFY` and
`PASSWORD_RESET` challenges for the same email are two **entirely
separate** state machines running in parallel, never interacting.

| STATE | ALLOWED ACTION | REQUIRED SECRET/TOKEN | EXPIRY | ATTEMPT LIMIT | REPLAY BEHAVIOR | NEXT STATE |
|---|---|---|---|---|---|---|
| **NO_CHALLENGE** (nothing stored, or previous one pruned/expired) | `POST /email-otp/send` | none | — | — | — | → **PENDING** (or **NOOP** for `PASSWORD_RESET` if no account matches — same HTTP response either way) |
| **PENDING** (`attempts < max`, `now < expires_at`, `consumed=false`) | `POST /email-otp/verify` with correct code | the 6-digit code just emailed | 10 min from creation (`DEFAULT_OTP_TTL_SECONDS`) | 5 (`DEFAULT_MAX_ATTEMPTS`) | Wrong code → `record_failed_attempt` (attempts+1), stays **PENDING** unless that push hits the cap | Correct code → **CONSUMED** (mints a `verifyToken`/`resetToken`). Wrong code, attempts still `<5` after increment → stays **PENDING**. Wrong code, attempts reach `5` → **LOCKED**. Second `/send` request (fresh code) at any point → **overwrites this entire state, back to PENDING with `attempts=0`** (see Finding AUTH-02) |
| **LOCKED** (`attempts >= max`) | None — `/verify` always returns `TOO_MANY_ATTEMPTS`, even with the correct code | — | Same `expires_at` as when it entered PENDING (locking doesn't extend or shorten it) | — | Any `/verify` call, right or wrong code → stays **LOCKED**, no attempt increment beyond the cap (checked before hashing) | A fresh `/send` → **overwrites back to PENDING, `attempts=0`** (same reset as above) — this is the *only* way out of LOCKED short of waiting for natural expiry |
| **EXPIRED** (`now >= expires_at`, regardless of `attempts`/`consumed`) | None — `/verify` returns `INVALID_OR_EXPIRED` indistinguishably from "wrong code" or "never existed" | — | — | — | Any `/verify` → stays **EXPIRED** (same response class) | A fresh `/send` → **PENDING** (a new challenge entirely; the store key is overwritten) |
| **CONSUMED** (`consumed=true`, set the instant `/verify` succeeds) | None — a second `/verify` with the same or any code returns `INVALID_OR_EXPIRED` | — | — | — | Replay attempt → `INVALID_OR_EXPIRED`, not distinguished from any other failure | A fresh `/send` → **PENDING** (new challenge, old one's `verifyToken`/`resetToken` is a *separate* piece of state, unaffected — see §2/§3) |

**Resend cooldown** is a *separate* gate checked only inside `/send`,
not a state of the challenge itself: a new `/send` is rejected with
`429 COOLDOWN` if the current challenge is `PENDING`/`LOCKED` (not yet
consumed) **and** less than 60s old (`DEFAULT_RESEND_COOLDOWN_SECONDS`)
— an already-**CONSUMED** or **EXPIRED** challenge has no cooldown at
all, a fresh `/send` is always allowed immediately.

**Proven by evidence, this stage:**
- Reaching **LOCKED** then presenting the *actually correct* code still
  fails (`too_many_attempts`, not `ok`) — evidence script
  `test_attempt_reset.py`, step 3.
- A fresh `/send` after **LOCKED** resets `attempts` to `0` and the new
  code's full 5-guess budget works independently — same script, steps
  4-6. This is real, reproducible behavior, not a hypothetical (see
  Finding AUTH-02 in the review for the severity/impact discussion —
  this table states *what happens*, not whether it's a problem).
- Cross-purpose codes never verify against each other, and each
  purpose's own challenge is entirely unaffected by activity on the
  other — evidence script `test_purpose_confusion.py`, and pre-existing
  tests `test_signup_otp_cannot_authorize_password_reset`,
  `test_password_reset_otp_cannot_activate_signup` (both re-run this
  stage, both pass).
- Constant-time code comparison (`hmac.compare_digest`), CSPRNG
  generation (`secrets.randbelow`), HMAC-SHA256 storage (never
  plaintext) — confirmed by direct code reading of `app/otp/codes.py`.

---

## 2. Signup state machine

```
   [no verifyToken]
        │
        │ POST /email-otp/send {email, purpose:SIGNUP_EMAIL_VERIFY}
        ▼
  Challenge: PENDING ──(wrong code x5)──▶ LOCKED ──(new /send)──▶ back to PENDING
        │
        │ POST /email-otp/verify {email, purpose:SIGNUP_EMAIL_VERIFY, code} — correct code
        ▼
  verifyToken minted, bound server-side to {identifier: email, purpose: SIGNUP_EMAIL_VERIFY,
  consumed:false, expires_at: now+10min} — challenge is now CONSUMED (dead end, see §1)
        │
        │ POST /signup/complete {verifyToken, fullName, phoneNumber, password, requestedRole?, companyName?}
        │   1. try_consume_reset_token(verifyToken) -- ATOMIC check-and-mark, one winner only
        │   2. purpose must == SIGNUP_EMAIL_VERIFY (defense in depth; nothing else could mint one here)
        │   3. email comes from the TOKEN's own `identifier` field -- request body has no email field at all
        ▼
  Firebase Auth user created (email_verified:true, since OTP already proved it)
        │
        ├─ Firestore users/{uid} profile write succeeds ──▶ mint_custom_token ──▶ SIGNED IN (customToken returned)
        │
        └─ Firestore write FAILS ──▶ compensating rollback: delete_account(uid)
                │
                ├─ rollback succeeds ──▶ 500 returned, NO account exists, email/phone free for retry
                └─ rollback FAILS ──▶ 500 returned, orphan Auth account remains (logged for manual
                                       reconciliation); a retry with a FRESH verifyToken correctly
                                       gets 409 "already exists", never a silent duplicate
```

**Can any step be skipped?** No path reaches `/signup/complete` without
a `verifyToken`, and the only code that ever mints one is
`EmailOtpVerifyHandler.verify()` on a successful OTP check — there is
no alternate route, no default/fallback token, no way to construct a
usable token client-side (it's 32 bytes of `secrets.token_urlsafe`,
looked up server-side against exact string equality). **Confirmed
impossible to skip**, not just "not observed."

**Can `verifyToken` be replayed?** No — `try_consume_reset_token` is
atomic (a single store operation does the check-and-mark, not a
read-then-write), proven under real concurrent HTTP requests via
`ASGITransport`/`asyncio.gather` in the existing, re-run-this-stage
test `test_E_simultaneous_signup_completion_with_the_same_verify_token_creates_only_one_account`
— exactly one of two simultaneous completions succeeds, the other gets
the generic "expired or already used" response, and exactly one
Firebase account is created.

**Can the email be substituted?** No — `SignupCompleteHandler` never
reads an `email` field from the request body at all; the account is
created for `entry.identifier`, the value the *token* carries, fixed at
the moment OTP verification succeeded. Re-confirmed this stage via
`test_signup_complete_email_is_bound_to_the_verified_token_not_client_supplied`.

**Can `requestedRole`/`role` be escalated through this flow?**
`requestedRole` is checked against a hard 2-value allowlist
(`customer`/`agent`) and rejected outright for anything else (including
`"admin"`); the actual Firestore `role` field is hard-coded to
`"customer"` server-side in `create_user_profile`, **never** read from
`requestedRole` or any other request field. Re-confirmed via
`test_signup_complete_rejects_invalid_requested_role`.

---

## 3. Password reset state machine

```
   [no resetToken]
        │
        │ POST /email-otp/send {email, purpose:PASSWORD_RESET}
        │   -- resolves email→uid FIRST; no account found -> NOOP, but the HTTP
        │      response is byte-identical to a real send either way
        ▼
  Challenge: PENDING (uid already bound at this point, from account resolution)
        │  ...same LOCKED/expiry/reset-on-resend mechanics as §1...
        │
        │ POST /email-otp/verify {email, purpose:PASSWORD_RESET, code} — correct code
        ▼
  resetToken minted, bound server-side to {uid, identifier: email, purpose: PASSWORD_RESET,
  consumed:false, expires_at: now+10min}
        │
        │ POST /password-reset/confirm {resetToken, newPassword}
        │   1. try_consume_reset_token(resetToken) -- ATOMIC, one winner only
        │   2. purpose must == PASSWORD_RESET
        ▼
  Firebase Admin SDK: update_user(uid, password=newPassword) then revoke_refresh_tokens(uid)
        │
        ▼
  PASSWORD CHANGED. All refresh tokens revoked -- next silent token refresh
  anywhere this account was signed in will fail, forcing a real login.
  (Any ALREADY-ISSUED, still-live ID token is a separate story -- see
  Finding AUTH-03 in the review; this diagram covers the token/session
  *issuance* chain, not the outer Firebase ID token's own remaining
  lifetime.)
```

**Can this be triggered for account B using account A's flow?** No —
there is no point in this chain where a client supplies a `uid`. The
`resetToken` is opaque to the client; the `uid` inside it was resolved
once, server-side, at `/send` time from the *email address*, and never
touched again. Re-confirmed via
`test_user_a_verification_can_never_produce_a_reset_token_bound_to_user_b`
and `test_firebase_password_change_only_for_the_correct_uid`.

**Can `resetToken` be replayed?** No — same atomic
`try_consume_reset_token` mechanism as signup. Proven this stage with a
**new** concurrent-request evidence script specifically for
`PasswordResetConfirmHandler` (not previously covered by a dedicated
concurrency test at the HTTP layer — the store-level primitive was
already proven purpose-agnostic, this closes the loop with a direct
test): two simultaneous `POST /password-reset/confirm` calls with the
identical token → exactly one `200`, one `400`, exactly one
`set_password_and_revoke_sessions` call made.

**Can a `verifyToken` (signup) be used here, or vice versa?** No —
`entry.purpose != Purpose.PASSWORD_RESET.value` is checked explicitly;
re-confirmed via `test_signup_complete_rejects_password_reset_token`
(the mirror-image check, verified in the other direction).

**Can a step be reordered** (e.g. call `/password-reset/confirm`
before `/email-otp/verify` ever succeeded)? No — there is no
`resetToken` to present without a prior successful verify; the same
"no way to construct one client-side" argument as signup applies.

---

## 4. Login / logout (entirely client-side — the backend is never involved)

```
  login.html
     │ signInWithEmailAndPassword(auth, email, password)   [direct to Firebase Auth]
     │   -- wrong password / no such user / bad credential -> ALL map to the
     │      SAME generic "Incorrect email or password" message (friendlyLoginError,
     │      login.html:180-190) -- confirmed no enumeration signal in the UI layer
     ▼
  Firebase issues an ID token + refresh token, persisted via setPersistence()
  (LOCAL if "Remember me", SESSION otherwise -- Firebase's own mechanism,
  not a custom implementation)
     │
     │ getDoc(users/{uid}) -- reads role to decide redirect target
     ▼
  account.html / agent-dashboard.html  (role read is a UX redirect only;
  every subsequent Firestore/Storage call is independently authorized
  by firestore.rules/storage.rules using Firebase's own validated token,
  not by this redirect)
     │
     │ logoutBtn click -> signOut(auth)
     ▼
  Session cleared client-side. No backend call is made or needed --
  there is no backend-side session to invalidate for a normal logout.
```

The backend never sees a login or logout at all — there is no
`/login`/`/logout` HTTP route, and no Firebase ID token is ever sent to
it (confirmed by exhaustive repo-wide search — zero references to
`getIdToken`/`idToken` in any frontend file, zero references to ID
token verification anywhere in `backend/`). See Finding AUTH-01 in the
review for the full implication of this.

---

## 5. Role/account state transitions (authentication-relevant subset)

*(Full authorization detail already covered in `ATTACK_SURFACE.md`
§B1; this table is the auth-relevant summary only — which states
affect whether someone IS authenticated, not what they're authorized
to do once they are.)*

| From | To | Trigger | Who can trigger it | Notes |
|---|---|---|---|---|
| (no account) | `customer`, `emailVerified:true` | `/signup/complete` | Anyone who completed OTP | `email_verified` is set true at creation, not a separate later step |
| `customer` | `agent` | Admin's "Add Agent" flow (`admin.html`) creates a **new**, separate account — does not promote the customer signing up | Admin only | The applicant's own `customer` account, if they already had one, is untouched; the new agent account is a distinct Firebase user |
| any role | (password changed) | `/password-reset/confirm` | Whoever has a valid `resetToken` (i.e., proved email ownership via OTP) | Does not change role; revokes refresh tokens (see AUTH-03 for the live-token caveat) |
| any role | `disabled:true` (Firebase Auth) | Manual, Firebase Console only | Admin, outside this codebase | **No in-app feature triggers this** — nothing in this repository ever sets or reads `disabled`. Firebase Auth's own native blocking of sign-in for disabled users applies regardless, but interaction with this app's custom-token signup path and with already-issued tokens is a manual-test item (see review's "tests not safely performable" section) |
