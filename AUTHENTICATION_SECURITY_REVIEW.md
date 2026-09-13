# Darwesh Group — Authentication Deep Review (Stage 2)

Baseline: `ATTACK_SURFACE.md` (Stage 1). Scope: the 11 flows listed in
the Stage 2 brief, traced frontend → API → FastAPI route → validation
→ Firebase Admin/Auth → Firestore → response → frontend state.

**Methodology**: every claim below is backed by one of — (a) a
pre-existing automated test, re-run fresh this stage and cited by exact
name; (b) a new evidence script written for this review (not committed
— lives in the session scratchpad, reproducible from the exact code
shown); (c) direct, cited source-code inspection where a live test
isn't the right tool (e.g., confirming an absence, like "no code path
sets `disabled`"). No production system was touched, no real account
was tested against, no OTP/email endpoint was flooded. All testing used
the existing pytest suite's fakes (`FakeEmailSender`, `InMemoryChallengeStore`,
`FakeAccountOps`) or new scripts built the same way — nothing here sent
a real email or touched the real Firebase project.

**Full backend suite re-run for this stage**: `135 passed` (no
regressions; this stage made no source changes).

---

## CONFIRMED findings

### AUTH-01 — No Firebase ID token validation exists in the backend (architectural, not a defect)

- **Status**: CONFIRMED (by exhaustive absence-of-evidence search, not inference)
- **Severity**: Informational
- **CWE**: N/A
- **OWASP category**: N/A — documenting an architecture boundary, not a flaw in it
- **Affected endpoint**: All 6 `backend/` routes
- **Affected file**: N/A (absence confirmed across `backend/app/`)
- **Prerequisites**: N/A
- **Expected behavior**: The brief asks to inspect signature/issuer/audience/expiration/subject validation for Firebase ID tokens.
- **Observed behavior**: No backend route ever accepts a Firebase ID token as a credential. `grep -rn "verify_id_token\|Authorization\|Bearer" backend/app` finds zero inbound-token-verification code — the only `Authorization: Bearer` usages are the backend's own *outbound* calls to Resend's API. A repo-wide search for `getIdToken`/`idToken` in every `.html`/`.js` file also returns zero matches — no frontend page ever sends its Firebase ID token to this backend.
- **Security impact**: None directly — but it means every one of the token-validation properties the brief asks about (signature/issuer/audience/expiration/subject/revocation/disabled-user handling) is **entirely delegated to Firebase's own servers**, for every page that talks to Firestore/Storage directly (which is nearly the whole site — see `ATTACK_SURFACE.md` §B). This is the architecturally correct choice: Firebase's own SDK-to-server protocol already does full JWT validation (signature, issuer `securetoken.google.com/{project}`, audience = project ID, expiration, revocation-if-explicitly-checked) and reimplementing any part of that in this codebase would be a strictly worse, error-prone duplicate of infrastructure Google already runs correctly. It does mean this repository has **no code to audit for the specific ID-token-validation bug classes** the brief lists (wrong-audience tokens, malformed tokens, etc.) — those bugs, if they existed, would live in Firebase's own servers, out of this engagement's scope and not independently testable from application code.
- **Evidence**: `grep -rn "verify_id_token\|id_token\|Authorization\|bearer\|Bearer" backend/app` → 3 files, all either CORS header allowlisting or outbound Resend calls. `grep -rn "getIdToken\|idToken" *.html js/*.js` → zero matches.
- **Root cause**: N/A — intentional design (custom, backend-minted, purpose-bound, single-use tokens for the two flows the backend does own; Firebase's own tokens for everything else).
- **Recommended remediation**: None required. Worth stating explicitly in project documentation (already partially done in `docs/EMAIL_OTP.md`) so a future contributor doesn't assume the backend is meant to gate Firestore access and add a redundant, out-of-sync token-validation layer.
- **Confidence**: High.

---

### AUTH-02 — Resending an OTP unconditionally resets the per-challenge attempt counter to zero

- **Status**: CONFIRMED
- **Severity**: Low (its real-world impact depends entirely on AUTH-04 below — see combined analysis)
- **CWE**: CWE-307 (Improper Restriction of Excessive Authentication Attempts) — partial: the *per-challenge* cap works exactly as designed; the *composability* across sends is the gap
- **OWASP category**: API4:2023 Unrestricted Resource Consumption
- **Affected endpoint**: `POST /api/v1/auth/email-otp/send`
- **Affected file + line**: `backend/app/otp/service.py:140-155` (`send()` always constructs a fresh `Challenge(..., attempts=0 [default])` and overwrites the store key), `backend/app/otp/store.py:36-51` (`Challenge.attempts: int = 0` default)
- **Prerequisites**: Ability to call `/email-otp/send` again after exhausting a challenge's attempts (bounded by the resend cooldown and rate limiter — see AUTH-04)
- **Expected behavior**: A brute-force attempt budget against one target's OTP should not be trivially renewable.
- **Observed behavior**: Every successful `/send` creates a brand-new `Challenge` object and calls `store.create_challenge(key, challenge)`, which **overwrites** whatever challenge previously existed at that key — including its `attempts` count. There is no code path that preserves or caps a cumulative attempt count across multiple sends.
- **Security impact**: An attacker who exhausts the 5-guess budget against one code can request a new code and get a fresh 5-guess budget, and repeat this for as many `/send` calls as the rate limiter and resend cooldown allow.
- **Evidence**: New evidence script (`test_attempt_reset.py`, run this stage against the real `OtpService`/`InMemoryChallengeStore`), output:
  ```
  After 1st send: attempts=0, max_attempts=5
  ... 5 wrong guesses ... attempts=5/5
  Verify with the REAL code after exhausting attempts: result=too_many_attempts
  After 2nd send (fresh OTP): attempts=0/5  <-- reset confirmed
  ... 4 more wrong guesses ...
  Verify with the 2nd code's real value, after 4 more wrong guesses: result=ok, got_token=True
  ```
- **Root cause**: `send()` treats every call as "create a new challenge" rather than "create a new challenge, but cap cumulative attempts against this identifier+purpose over a longer window."
- **Recommended remediation**: Not fixed in this stage (Stage 2 is review-only). If pursued: track a longer-window (e.g. 1-hour) cumulative failed-attempt counter per `identifier+purpose`, independent of the per-challenge counter, and reject `/verify` (or even `/send`) once that's exceeded — this is additive to the existing rate limiter, not a replacement for it, and should be designed together with AUTH-04's fix rather than separately.
- **Confidence**: High (directly reproduced).

---

### AUTH-03 — Password-reset session revocation does not invalidate an already-issued, still-live Firebase ID token

- **Status**: CONFIRMED
- **Severity**: Low (narrow exploit window — requires the attacker to already possess a stolen, unexpired ID token *before* the legitimate user resets their password; Firebase ID tokens are short-lived, ~1 hour max)
- **CWE**: CWE-613 (Insufficient Session Expiration)
- **OWASP category**: A07:2021 – Identification and Authentication Failures
- **Affected endpoint**: `POST /api/v1/auth/password-reset/confirm` (the gap is in what it *doesn't* additionally do)
- **Affected file + line**: `backend/app/otp/firebase_admin_ops.py:100-110` (`set_password_and_revoke_sessions` calls `revoke_refresh_tokens`, correctly, but that's the limit of server-side revocation); `firestore.rules` (repo root — no rule anywhere checks `request.auth.token.auth_time`)
- **Prerequisites**: An attacker must have already obtained a valid, unexpired Firebase ID token for the victim's account (via a separate compromise this review does not evaluate — e.g. XSS, device theft, network interception) *before* the legitimate owner completes a password reset.
- **Expected behavior**: After a password reset, no previously issued credential should remain usable.
- **Observed behavior**: `revoke_refresh_tokens(uid)` invalidates *refresh* tokens — the next time that device tries to silently mint a new ID token, it fails and the app is forced back to `login.html`. It does **not** retroactively invalidate an ID token that was already issued and is still within its own expiration (Firebase ID tokens are JWTs, self-contained, and are honored by Firestore/Storage security rules purely based on their own signature and `exp` claim **unless** rules explicitly cross-check `request.auth.token.auth_time` against a stored revocation timestamp — a documented Firebase pattern this project does not use).
- **Security impact**: A narrow window (up to the token's remaining lifetime, capped at ~1 hour by Firebase) during which a *different*, already-stolen credential for the same account keeps working against Firestore/Storage even after the account holder "secures" their account via password reset.
- **Evidence**: `grep -n "auth_time" firestore.rules` → no matches. This is a standard, documented Firebase limitation (Firebase's own docs describe the `auth_time`-check pattern specifically for this scenario), not a bug unique to this codebase — but this project doesn't implement the mitigation.
- **Root cause**: Missing `auth_time`-based revocation check in `firestore.rules`; not something the backend alone can fix, since the backend isn't in the Firestore-access path at all (see AUTH-01).
- **Recommended remediation**: Not fixed in this stage. If pursued: store a `tokensValidAfter`-style timestamp (Firebase Admin SDK actually already tracks this internally for `revoke_refresh_tokens`; the pattern is to check `request.auth.token.auth_time > <that timestamp>` in `firestore.rules` for security-sensitive collections). This is a `firestore.rules` change, not a backend change — flagged for a future stage/decision, not implemented here.
- **Confidence**: High for the mechanism (well-documented Firebase behavior); the *practical* severity depends on how the token was stolen in the first place, which is outside this review's scope to evaluate.

---

### AUTH-04 — Rate limiters are per-process, not shared across Cloud Run instances

- **Status**: CONFIRMED
- **Severity**: Medium
- **CWE**: CWE-799 (Improper Control of Interaction Frequency) / CWE-307
- **OWASP category**: API4:2023 Unrestricted Resource Consumption
- **Affected endpoint**: All 5 rate-limited backend routes — `/forgot-password`, `/email-otp/send`, `/email-otp/verify`, `/signup/complete`, `/password-reset/confirm`
- **Affected file + line**: `backend/app/auth/reset.py:58-90` (`RateLimiter` — plain in-process `dict`, no shared backing store); every construction site in `backend/app/main.py` (lines 73, 156-159) passes a bare `RateLimiter(...)`, unlike `app/otp/store.py`'s `FirestoreChallengeStore`, which *was* redesigned this session specifically for Cloud Run's multi-instance scaling.
- **Prerequisites**: The backend running as more than one Cloud Run instance at once — the default/expected behavior under any real concurrent load, not an edge case.
- **Expected behavior**: A configured limit (e.g. "5 sends per 15 minutes per email") should hold regardless of which backend instance handles which request.
- **Observed behavior**: `RateLimiter.__init__` stores counts in `self._requests: dict[str, list[float]] = {}` — pure Python process memory. Two separate Cloud Run instances each enforce their **own independent** 5/15min budget for the same email/IP. The class's own docstring (`app/auth/reset.py:58-67`) explicitly acknowledges this tradeoff ("at this project's current traffic... a single instance's own memory is sufficient... If traffic ever grows enough to run multiple instances, this is the component to swap") — written when the OTP *store* had the identical problem, before this session fixed that one specifically. The rate limiter was not part of that fix and still has the gap.
- **Security impact**: Every brute-force/enumeration/abuse throttle in the entire backend degrades proportionally to Cloud Run's instance count. Concretely, combined with AUTH-02: on N concurrently running instances, an attacker's effective OTP-guessing budget against one target becomes up to `N × 5 sends/15min × 5 guesses/send = 25N guesses/15min` against a 1,000,000-value 6-digit space, instead of the intended 25. Cloud Run's own autoscaling means the busier an attacker makes the service (by sending enough concurrent requests), the *more* instances get created, the *larger* their effective budget becomes — the throttle weakens exactly when it's under the most load, the opposite of the intended effect.
- **Evidence**: Direct code inspection — no Firestore/Redis/shared-state import anywhere in `RateLimiter`; contrasted directly against `FirestoreChallengeStore` (same file family, deliberately fixed for this exact class of problem earlier this session — see `docs/EMAIL_OTP.md`'s "Shared production storage" section, which this rate limiter was never included in).
- **Root cause**: The multi-instance-safety pass earlier this session scoped itself to the OTP challenge/token store only; the rate limiter is a separate, still-single-instance component that was not in scope for that fix.
- **Recommended remediation**: Not fixed in this stage. If pursued: back `RateLimiter` with `FirestoreChallengeStore`'s pattern (a Firestore-backed counter with a transaction, or a `expireAt`-TTL'd document per key) — same shared-Firestore-client approach already proven this session, no new infrastructure needed. Should be sized/tested against real Cloud Run concurrency numbers, not assumed.
- **Confidence**: High — the gap is structural and provable from the code alone; the exact real-world instance count (and thus exact severity multiplier) depends on production traffic/scaling settings not observable from this repository.

---

### AUTH-05 — `OtpService.send()`'s cooldown check is not atomic (minor race, not a security bypass)

- **Status**: CONFIRMED (HARDENING ONLY — no security control is bypassed)
- **Severity**: Low
- **CWE**: CWE-362 (Concurrent Execution using Shared Resource with Improper Synchronization)
- **OWASP category**: N/A (not an authorization/authentication bypass; a UX-correctness issue)
- **Affected endpoint**: `POST /api/v1/auth/email-otp/send`
- **Affected file + line**: `backend/app/otp/service.py:100-108` (`get_challenge` then, several lines later, `create_challenge` — two separate store calls, not one atomic operation, unlike `try_consume_reset_token`'s pattern used elsewhere in the same module)
- **Prerequisites**: Two `/send` requests for the same `identifier+purpose` arriving concurrently (e.g. a double-clicked "Resend" button, or two browser tabs)
- **Expected behavior**: Concurrent sends should not corrupt challenge state.
- **Observed behavior**: Both requests can read "no cooldown active" before either writes, then both write — the store's last-write-wins, so one of the two just-sent codes silently stops being the valid one, while its email was still sent to the user.
- **Security impact**: None — this cannot be used to bypass the attempt cap, extend a cooldown, or read anyone else's challenge; at worst it wastes one Resend send and momentarily confuses a user who has two emails but only the second code works.
- **Evidence**: Direct code inspection; not separately reproduced with a race script since the failure mode (wasted email, no security property affected) doesn't warrant it — distinguished here explicitly from AUTH-02 (which *was* reproduced) to avoid overstating this one.
- **Root cause**: `send()` predates the atomic-consume pattern (`try_consume_reset_token`) added later this session for the reset/verify token race; that pattern was never retrofitted onto the cooldown check.
- **Recommended remediation**: Not fixed in this stage. If pursued: fold the cooldown check into a single atomic store operation (same transactional pattern as `try_consume_reset_token`), or accept it as a known, harmless UX rough edge.
- **Confidence**: High for the mechanism; this is a straightforward TOCTOU read from the code, not requiring live reproduction to be confident about.

---

## FALSE POSITIVE findings (Stage 1 candidates and Stage 2 checklist items, disproven with evidence)

### AUTH-06 — OTP "purpose confusion" (the specific candidate carried from Stage 1)

- **Status**: FALSE POSITIVE — disproven
- **Affected endpoint**: `/email-otp/send`, `/email-otp/verify`
- **Claim tested**: Could a `SIGNUP_EMAIL_VERIFY` code for `alice@x.com` be used to satisfy a `PASSWORD_RESET` verification for the same address (or vice versa)?
- **Evidence**: New evidence script `test_purpose_confusion.py`, requesting both purposes for the identical email back-to-back, then cross-testing:
  ```
  Using the SIGNUP code against PASSWORD_RESET purpose: result=invalid_or_expired, token=None
  Using the PASSWORD_RESET code against SIGNUP_EMAIL_VERIFY purpose: result=invalid_or_expired, token=None
  Using the SIGNUP code against its OWN purpose (after failed cross-attempts): result=ok, got_token=True
  Using the PASSWORD_RESET code against its OWN purpose (after failed cross-attempts): result=ok, got_token=True
  Purpose isolation HOLDS
  ```
  Plus 7 pre-existing tests re-run fresh and passing:
  `test_signup_otp_cannot_authorize_password_reset`,
  `test_password_reset_otp_cannot_activate_signup`,
  `test_signup_complete_rejects_password_reset_token`,
  `test_signup_complete_rejects_invalid_requested_role`,
  `test_purpose_binding_a_challenge_for_one_purpose_cannot_verify_under_another`,
  `test_http_send_rejects_missing_purpose`, `test_http_send_rejects_unsupported_purpose`.
- **Root cause of why it's safe**: The store key is `f"{purpose}:{identifier}"` — different purposes are structurally different dictionary/document keys, not different values under one key. There is no code path that ever compares a code against the "wrong" purpose's stored hash.
- **Confidence**: High.

### AUTH-07 — "Multiple valid OTPs at the same time" for one identifier

- **Status**: FALSE POSITIVE for the exploitable framing / clarified as intentional-by-design
- **Nuance**: Within a *single* `(purpose, identifier)`, only one challenge can ever be valid — every `/send` overwrites the previous one (see AUTH-02's mechanism, and `AUTH_STATE_MACHINE.md` §1). **Across different purposes** for the same email, yes, two independent codes can be outstanding simultaneously (e.g. a signup code and, separately, a password-reset code) — this is intentional, safe (see AUTH-06), and not the "multiple valid codes racing each other for the same action" scenario the brief is asking about.
- **Evidence**: Same as AUTH-06.
- **Confidence**: High.

### AUTH-08 — Login and password-reset response differences (account enumeration)

- **Status**: FALSE POSITIVE — confirmed clean
- **Affected endpoint**: `login.html`'s `signInWithEmailAndPassword` handling; `/forgot-password`; `/email-otp/send`
- **Login**: `friendlyLoginError()` (`login.html:180-190`) maps `auth/invalid-credential`, `auth/wrong-password`, **and** `auth/user-not-found` to the identical string `"Incorrect email or password."` — no UI-level distinction between "wrong password" and "no such account," regardless of which of these codes the installed Firebase SDK version actually returns.
- **Password reset / signup OTP send**: `GENERIC_SEND_MESSAGE`/`GENERIC_RESPONSE_MESSAGE` returned identically for registered and unregistered emails; re-confirmed via `test_forgot_password_unregistered_email_returns_identical_response_and_sends_no_email`, `test_account_enumeration_protection_works_end_to_end`, `test_http_send_returns_identical_response_regardless_of_account_existence` (all re-run this stage, all pass).
- **Confidence**: High.

### AUTH-09 — Sensitive auth data in `localStorage`/`sessionStorage`/URL/console logs

- **Status**: FALSE POSITIVE — confirmed clean, repo-wide
- **Evidence**:
  - `grep -rn "sessionStorage\." *.html js/*.js` → **zero matches anywhere in the repository.**
  - `grep -rn "localStorage\." *.html js/*.js` → only `darwesh_lang` (a UI language preference), in every file that uses it — never a token, password, or OTP code.
  - `verifyToken`/`resetToken` (`signup.html`, `reset-password.html`) live only in local JS variables (`let resetToken = null;`), are explicitly nulled out after use (`reset-password.html:500`), and are never interpolated into a URL, `<a href>`, or passed to `console.*`.
  - `grep -rn "console\.(log|debug|info|warn)\([^)]*(password|token|otp|code)" *.html js/*.js -i` → zero matches.
  - Backend: request/response logging (`app/server.py`'s `_RequestLoggingMiddleware`) explicitly logs only method/path/status/latency/client-IP — never the body — confirmed by reading the middleware in full (no request/response body ever touches a log call anywhere in `backend/app`).
- **Confidence**: High.

### AUTH-10 — `verifyToken`/`resetToken` replay

- **Status**: FALSE POSITIVE — confirmed protected, including under real concurrency
- **Evidence**: `try_consume_reset_token` (`backend/app/otp/store.py`) is a single atomic store operation (in-process lock for `InMemoryChallengeStore`, a Firestore transaction for `FirestoreChallengeStore`, both already verified against a real Firestore emulator in an earlier phase this session). Sequential replay: `test_signup_complete_verify_token_is_single_use`, `test_old_reset_token_cannot_be_reused` (both re-run, pass). Concurrent replay: `test_E_simultaneous_signup_completion_with_the_same_verify_token_creates_only_one_account` (signup, pre-existing, re-run, passes) plus a **new** evidence script for the password-reset side (`test_reset_confirm_race.py`, not previously covered by a dedicated concurrency test at the HTTP layer), output:
  ```
  Response 1: 200 {'message': 'Your password has been reset...'}
  Response 2: 400 {'error': 'This reset link has expired or already been used...'}
  Firebase password_updates: [('victim-uid', 'attacker-password-123')]
  PASS: exactly one confirm succeeded, exactly one password_update call made
  ```
- **Confidence**: High.

### AUTH-11 — Reset token usable for a different account or a different purpose

- **Status**: FALSE POSITIVE — confirmed structurally impossible, not just untested
- **Evidence**: Neither `/signup/complete` nor `/password-reset/confirm` accepts a `uid` or `email` field from the client at all — `email`/`uid` are read exclusively from the token's own server-side-bound `identifier`/`uid` fields. There is no parameter to substitute. Re-confirmed: `test_signup_complete_email_is_bound_to_the_verified_token_not_client_supplied`, `test_user_a_verification_can_never_produce_a_reset_token_bound_to_user_b`, `test_firebase_password_change_only_for_the_correct_uid`. Purpose substitution: `test_signup_complete_rejects_password_reset_token` (all re-run, all pass).
- **Confidence**: High.

### AUTH-12 — Mass assignment on `/signup/complete` (role/requestedRole escalation)

- **Status**: FALSE POSITIVE — confirmed blocked at two independent layers
- **Evidence**: `requestedRole` validated server-side against a hard `{"customer", "agent"}` allowlist, rejecting anything else outright (`email_handler.py:201-202`); the actual Firestore `role` field is hard-coded `"customer"` in `create_user_profile` (`firebase_admin_ops.py:181`), **never** derived from `requestedRole` or any other request field. Re-confirmed: `test_signup_complete_rejects_invalid_requested_role`. This mirrors the equivalent Firestore-rules-level protection audited in an earlier phase this session (client-side `setDoc` attempts to self-grant a role are independently blocked by `firestore.rules`).
- **Confidence**: High.

---

## HARDENING ONLY / MANUAL REVIEW RECOMMENDED

### AUTH-13 — Disabled/revoked-user handling has no in-app feature, and native Firebase behavior wasn't live-tested

- **Status**: LIKELY safe (relies on well-documented native Firebase Auth behavior), but **cannot be marked CONFIRMED** — this specific interaction was not live-tested against a real Firebase project in this stage
- **Severity**: Informational / process gap, not a code defect found
- **Affected component**: Firebase Auth (native), interacting with this app's custom-token signup path
- **What's confirmed by code inspection**: No file in this repository ever reads or writes a user's `disabled` flag — there is no "suspend user" feature anywhere in `admin.html` or the backend. `mint_custom_token` (`fb_auth.create_custom_token`) is a pure JWT-signing operation and, per Firebase Admin SDK's documented behavior, does not itself check `disabled` status — that check happens when the client later calls `signInWithCustomToken()`, which goes through Firebase's normal sign-in path (expected to reject a disabled account, per Firebase's own documentation).
- **What's NOT confirmed here**: Live behavior of `signInWithCustomToken()` against a genuinely disabled account was not exercised against a real or emulated Firebase Auth backend in this stage — Firebase Auth itself (unlike Firestore) has no local emulator equivalent this session has stood up, and testing this live against the real `darwesh-group` project would mean disabling a real account, explicitly excluded by the rules of engagement ("do not disable real users").
- **Recommended remediation**: If/when this becomes a real feature (an admin "suspend agent" button), (a) confirm live in the Firebase Auth emulator (`firebase emulators:start --only auth`) that `signInWithCustomToken` and `signInWithEmailAndPassword` both correctly reject a `disabled:true` account before shipping the feature, and (b) pair it with an `firestore.rules` check (same `auth_time`/custom-claim pattern as AUTH-03) so an already-issued live token doesn't outlive the disable action either.
- **Confidence**: Medium (high confidence in the documented Firebase behavior; explicitly not independently verified live, and said so rather than assumed).

### AUTH-14 — Client-side role-based redirects are UX only (cross-reference, not a new finding)

- **Status**: Already covered as design-intentional in `ATTACK_SURFACE.md`/`SECURITY_ARCHITECTURE.md` — restated here only to confirm it was explicitly re-checked from the *authentication* angle this stage, not just authorization
- **Finding**: `agent-dashboard.html`/`admin.html`'s `if (profile.role !== 'agent'/'admin') redirect` is a **UX** gate, not a security boundary — the real boundary is `firestore.rules`, evaluated server-side by Firebase regardless of what the page's own JS does. From an *authentication* standpoint (is this session real/valid at all) this is a non-issue: the redirect only ever runs after `onAuthStateChanged` confirms a real, Firebase-validated session exists; it's the *role check that follows* that's UX-only, which is an authorization question already tracked in `ATTACK_SURFACE.md` (items B3.3/B3.4/B7.3), not restated as a new authentication finding here.
- **Confidence**: High.

---

## Tests performed (this stage, exact list)

1. Full backend suite: `pytest -q` → 135 passed (baseline, no regressions from this review-only stage).
2. Targeted re-runs, by exact test name, as evidence for specific claims above: `test_signup_otp_cannot_authorize_password_reset`, `test_password_reset_otp_cannot_activate_signup`, `test_http_send_rejects_missing_purpose`, `test_signup_complete_rejects_invalid_requested_role`, `test_signup_complete_rejects_password_reset_token`, `test_purpose_binding_a_challenge_for_one_purpose_cannot_verify_under_another`, `test_http_send_rejects_unsupported_purpose`, `test_E_simultaneous_signup_completion_with_the_same_verify_token_creates_only_one_account`, `test_E_store_level_atomic_consume_never_lets_a_second_caller_win`, `test_F_retry_with_a_fresh_token_after_a_successful_rollback_completes_cleanly`, `test_F_retry_after_partial_failure_with_orphan_still_present_gets_a_clean_conflict_not_a_duplicate`, `test_full_password_reset_flow_end_to_end`, `test_forgot_password_registered_email_sends_link_and_returns_generic_message`, `test_forgot_password_unregistered_email_returns_identical_response_and_sends_no_email`, `test_forgot_password_invalid_email_format_returns_distinct_validation_error`, `test_forgot_password_generator_failure_still_returns_generic_success_message`, `test_forgot_password_rate_limit_blocks_burst`, `test_signup_complete_email_is_bound_to_the_verified_token_not_client_supplied`, `test_firebase_password_change_only_for_the_correct_uid`.
3. New evidence script — OTP attempt-counter behavior across a resend (`test_attempt_reset.py`): proved attempts reset to 0 on every new `/send`, and that a locked challenge rejects even the genuinely correct code.
4. New evidence script — OTP purpose isolation for the same email, both purposes outstanding simultaneously (`test_purpose_confusion.py`): proved cross-purpose codes always fail, same-purpose codes remain independently valid.
5. New evidence script — concurrent `POST /password-reset/confirm` with the identical `resetToken` via real HTTP requests over `httpx.AsyncClient`/`ASGITransport` (`test_reset_confirm_race.py`): proved exactly one of two simultaneous confirmations succeeds.
6. Repo-wide `grep` sweeps (not simulated, actually run) for: ID-token verification code in the backend; `getIdToken`/`idToken` in the frontend; `sessionStorage`/`localStorage` usage repo-wide; `console.*` calls containing password/token/otp/code substrings; `auth_time` in `firestore.rules`; `disabled` anywhere in the repo.
7. Direct source reading, line-cited above, of: `service.py`, `store.py`, `email_handler.py`, `handler.py`, `firebase_admin_ops.py`, `codes.py` (confirmed CSPRNG + constant-time comparison), `main.py` (rate-limiter wiring), `reset.py` (`RateLimiter` implementation), `login.html`, `signup.html`, `reset-password.html`.

## Tests NOT safely performable in this environment (and why)

1. **Live Firebase Auth behavior for malformed/expired/revoked/wrong-audience ID tokens.** N/A per AUTH-01 — there's no backend code path that accepts one to test against. Testing Firebase's *own* token verification would mean testing Google's infrastructure, outside this engagement's authorized scope (Darwesh Group's own systems only) and not meaningfully different from trusting Firebase's own security documentation.
2. **`disabled:true` account behavior against `signInWithCustomToken`/`signInWithEmailAndPassword`**, live (AUTH-13). Excluded explicitly by the rules of engagement ("do not disable real users"); no local Firebase Auth emulator is currently running in this environment (only the Firestore emulator from an earlier session phase is up) — standing one up and testing against it is a reasonable next step but wasn't performed this stage since it requires new setup, not a quick check.
3. **Real Resend email delivery / real OTP receipt in an actual inbox.** Explicitly out of scope this stage per "do not spam OTP email endpoints" — all OTP testing used `FakeEmailSender`/`RecordingSender`, which capture the generated code without any real send. This matches the project's own existing test-suite convention.
4. **Real-world timing measurements of the constant-time comparison** (`hmac.compare_digest`) — confirmed the correct primitive is used by reading the code; did not attempt to empirically measure timing variance, since Python-level timing side-channel measurement is unreliable in a shared/virtualized CI-like environment and the primitive itself is the standard, correct answer regardless.
5. **Live multi-instance Cloud Run reproduction of AUTH-04.** The backend isn't deployed yet (per this session's own separate deployment-planning work) — the finding is proven from code structure (no shared state) rather than by actually running two instances and hitting the rate limit twice. Recommended once deployed: a real two-instance (or `--concurrency` forced) test hitting `/email-otp/send` from both to confirm the predicted bypass magnitude.

---

## Summary counts

- **CONFIRMED**: 5 (AUTH-01 informational-architectural, AUTH-02, AUTH-03, AUTH-04, AUTH-05)
- **LIKELY** (not fully live-verifiable in this environment): 1 (AUTH-13)
- **FALSE POSITIVE** (disproven with evidence): 7 (AUTH-06 through AUTH-12)
- **HARDENING ONLY**: AUTH-05, AUTH-13 (severity-wise, both are hardening-flavored even though classified CONFIRMED/LIKELY above)
- **Highest real severity this stage**: **Medium** (AUTH-04) — no Critical or High findings in authentication specifically; the two most concrete, evidence-proven behaviors worth fixing are AUTH-02 and AUTH-04, and they compound with each other.

No source code was modified. No fixes were applied — Stage 2 is review-only per your instruction.
