# Orchestrates OTP generation, delivery, verification, and the
# short-lived token issued afterward. This is the one place that
# understands "what does a successful verification actually authorize" --
# HTTP handlers (app/otp/email_handler.py) never touch a Challenge or
# ResetToken directly.
#
# Channel-agnostic on purpose: `identifier` is whatever the OTP was sent
# to (a normalized email today; the original design -- see
# docs/WHATSAPP_OTP.md -- used a normalized phone number, and
# app/otp/handler.py's phone-flavored HTTP layer still works against
# this same service unchanged). Nothing in this module assumes a
# particular channel or a particular shape for `identifier`.
from __future__ import annotations

import logging
import secrets
import time
from dataclasses import dataclass
from enum import StrEnum
from typing import Protocol

from app.otp.codes import generate_otp, hash_otp
from app.otp.codes import verify_otp as verify_otp_hash
from app.otp.firebase_admin_ops import UidResolver
from app.otp.store import Challenge, ChallengeStore, ResetToken

# Production defaults -- overridable per-instance (tests use small
# values plus a real time.sleep, matching the existing
# RateLimiter test pattern, rather than an injected fake clock).
DEFAULT_OTP_TTL_SECONDS = 10 * 60
DEFAULT_RESEND_COOLDOWN_SECONDS = 60
DEFAULT_MAX_ATTEMPTS = 5
DEFAULT_RESET_TOKEN_TTL_SECONDS = 10 * 60


class Purpose(StrEnum):
    SIGNUP_EMAIL_VERIFY = "SIGNUP_EMAIL_VERIFY"
    PASSWORD_RESET = "PASSWORD_RESET"


# Purposes that must only operate on an identifier already tied to a real
# account -- OtpService.send() resolves a UID first and silently no-ops
# (same generic response as a real send, so it stays enumeration-safe)
# if none exists. SIGNUP_EMAIL_VERIFY is deliberately absent: there is no
# account yet at send time -- proving the applicant owns the email is
# the whole point, and account-already-exists is instead checked once,
# plainly, at final account creation (see app/otp/email_handler.py's
# SignupCompleteHandler) -- that's normal signup UX, not an
# enumeration-sensitive fact the way "does this email have an account"
# is for password reset.
_REQUIRES_EXISTING_ACCOUNT = {Purpose.PASSWORD_RESET}


class SendResult(StrEnum):
    SENT = "sent"  # a real OTP was generated and delivery was attempted
    NOOP = (
        "noop"  # this purpose requires an account and none exists here -- caller shows the same response as SENT
    )
    COOLDOWN = "cooldown"  # a code was already sent too recently for this identifier+purpose


class VerifyResult(StrEnum):
    OK = "ok"
    # Deliberately one bucket for "no such challenge", "wrong code",
    # "expired", and "already used" -- an attacker who can distinguish
    # these gets a working oracle (e.g. telling apart "this identifier
    # never got a code" from "wrong code" narrows down account existence
    # and timing). Only the attempt-cap is safe to reveal distinctly,
    # since it's about the challenge, not about whether an account exists.
    INVALID_OR_EXPIRED = "invalid_or_expired"
    TOO_MANY_ATTEMPTS = "too_many_attempts"


class OtpSender(Protocol):
    """Delivers a code to an identifier for a given purpose. Purpose is
    part of the contract (unlike the earlier WhatsApp-only design) so an
    implementation can choose different wording/templates per purpose --
    see app/otp/email_sender.py's two Resend templates (signup vs.
    password reset)."""

    async def send_otp(self, identifier: str, code: str, purpose: Purpose) -> None: ...


@dataclass
class OtpService:
    store: ChallengeStore
    sender: OtpSender
    uids: UidResolver
    otp_secret: str
    logger: logging.Logger
    otp_ttl_seconds: float = DEFAULT_OTP_TTL_SECONDS
    resend_cooldown_seconds: float = DEFAULT_RESEND_COOLDOWN_SECONDS
    max_attempts: int = DEFAULT_MAX_ATTEMPTS
    reset_token_ttl_seconds: float = DEFAULT_RESET_TOKEN_TTL_SECONDS

    @staticmethod
    def _challenge_key(identifier: str, purpose: Purpose) -> str:
        return f"{purpose.value}:{identifier}"

    async def send(self, identifier: str, purpose: Purpose) -> SendResult:
        key = self._challenge_key(identifier, purpose)
        existing = self.store.get_challenge(key)
        if (
            existing is not None
            and not existing.consumed
            and (time.time() - existing.created_at) < self.resend_cooldown_seconds
        ):
            return SendResult.COOLDOWN

        uid: str | None = None
        if purpose in _REQUIRES_EXISTING_ACCOUNT:
            try:
                uid = await self.uids.resolve(identifier)
            except Exception as exc:
                # A resolver failure (e.g. a transient Firebase outage) must
                # degrade the same way "no such account" does -- NOT bubble
                # up and 500 the endpoint, which would both break the
                # enumeration-safety guarantee (a 500 vs. 200 is itself a
                # distinguishing signal) and needlessly scare a real user
                # who just hit a passing glitch. Logged at error level,
                # unlike the plain not-found case below, since this
                # specifically needs someone's attention.
                self.logger.error(
                    "otp send: uid resolution failed", extra={"purpose": purpose.value, "error": str(exc)}
                )
                return SendResult.NOOP

            if uid is None:
                # No account has this identifier verified on its Firebase
                # Auth record. No challenge is created and the email
                # provider is never called -- but the HTTP handler still
                # returns the exact same response as SENT either way (see
                # app/otp/email_handler.py), so this is invisible to
                # whoever's asking. Same enumeration-safety pattern as
                # app.auth.reset.Handler.forgot_password's ErrUserNotFound
                # handling.
                self.logger.info("otp send: no account for this identifier", extra={"purpose": purpose.value})
                return SendResult.NOOP

        code = generate_otp()
        now = time.time()
        challenge = Challenge(
            identifier=identifier,
            purpose=purpose.value,
            otp_hash=hash_otp(code, self.otp_secret),
            uid=uid,
            created_at=now,
            expires_at=now + self.otp_ttl_seconds,
            max_attempts=self.max_attempts,
        )
        # Overwriting the same key immediately invalidates whatever OTP
        # was pending before it -- only the newest code for a given
        # identifier+purpose is ever valid ("invalidate/replace previous
        # OTP when appropriate").
        self.store.create_challenge(key, challenge)

        try:
            await self.sender.send_otp(identifier, code, purpose)
        except Exception as exc:
            # Never reveal a delivery failure to the caller -- same
            # reasoning as forgot_password's email-send failure path.
            # The code value itself is never part of this log line.
            self.logger.error("otp send: provider failed", extra={"purpose": purpose.value, "error": str(exc)})
        else:
            self.logger.info("otp send: delivery attempted", extra={"purpose": purpose.value})
        return SendResult.SENT

    def verify(self, identifier: str, purpose: Purpose, code: str) -> tuple[VerifyResult, str | None]:
        """Returns (result, token). token is only non-None on
        VerifyResult.OK -- callers name it resetToken or verifyToken
        depending on purpose (see app/otp/email_handler.py); it's the
        same underlying single-use, purpose-bound token either way."""
        key = self._challenge_key(identifier, purpose)
        challenge = self.store.get_challenge(key)

        if challenge is None or challenge.consumed or challenge.expires_at < time.time():
            return VerifyResult.INVALID_OR_EXPIRED, None
        if challenge.attempts >= challenge.max_attempts:
            return VerifyResult.TOO_MANY_ATTEMPTS, None

        if not verify_otp_hash(code, challenge.otp_hash, self.otp_secret):
            updated = self.store.record_failed_attempt(key)
            if updated is not None and updated.attempts >= updated.max_attempts:
                return VerifyResult.TOO_MANY_ATTEMPTS, None
            return VerifyResult.INVALID_OR_EXPIRED, None

        self.store.consume_challenge(key)
        self.logger.info("otp verify: success", extra={"purpose": purpose.value})

        token = secrets.token_urlsafe(32)
        now = time.time()
        self.store.create_reset_token(
            token,
            ResetToken(
                uid=challenge.uid,
                identifier=identifier,
                purpose=purpose.value,
                created_at=now,
                expires_at=now + self.reset_token_ttl_seconds,
            ),
        )
        return VerifyResult.OK, token
