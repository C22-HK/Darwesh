# Orchestrates OTP generation, delivery, verification, and the
# short-lived reset token issued afterward. This is the one place that
# understands "what does a successful verification actually authorize" --
# HTTP handlers (app/otp/handler.py) never touch a Challenge or
# ResetToken directly.
from __future__ import annotations

import logging
import secrets
import time
from dataclasses import dataclass
from enum import StrEnum

from app.otp.codes import generate_otp, hash_otp
from app.otp.codes import verify_otp as verify_otp_hash
from app.otp.firebase_admin_ops import UidResolver
from app.otp.store import Challenge, ChallengeStore, ResetToken
from app.otp.whatsapp import WhatsAppSender

# Production defaults -- overridable per-instance (tests use small
# values plus a real time.sleep, matching the existing
# RateLimiter test pattern, rather than an injected fake clock).
DEFAULT_OTP_TTL_SECONDS = 5 * 60
DEFAULT_RESEND_COOLDOWN_SECONDS = 60
DEFAULT_MAX_ATTEMPTS = 5
DEFAULT_RESET_TOKEN_TTL_SECONDS = 10 * 60


class Purpose(StrEnum):
    PASSWORD_RESET = "PASSWORD_RESET"
    # Reserved for the future phone-first signup flow. Not accepted by
    # any HTTP endpoint yet (see app/otp/handler.py) -- only defined
    # here so the purpose-binding mechanism itself (a challenge for one
    # purpose can never verify against another) is real and testable
    # ahead of that endpoint existing, not bolted on later.
    SIGNUP = "SIGNUP"


class SendResult(StrEnum):
    SENT = "sent"  # a real OTP was generated and delivery was attempted
    NOOP = "noop"  # no account owns this phone number -- caller shows the same response as SENT
    COOLDOWN = "cooldown"  # a code was already sent too recently for this phone+purpose


class VerifyResult(StrEnum):
    OK = "ok"
    # Deliberately one bucket for "no such challenge", "wrong code",
    # "expired", and "already used" -- an attacker who can distinguish
    # these gets a working oracle (e.g. telling apart "this phone never
    # got a code" from "wrong code" narrows down account existence and
    # timing). Only the attempt-cap is safe to reveal distinctly, since
    # it's about the challenge, not about whether an account exists.
    INVALID_OR_EXPIRED = "invalid_or_expired"
    TOO_MANY_ATTEMPTS = "too_many_attempts"


@dataclass
class OtpService:
    store: ChallengeStore
    sender: WhatsAppSender
    uids: UidResolver
    otp_secret: str
    logger: logging.Logger
    otp_ttl_seconds: float = DEFAULT_OTP_TTL_SECONDS
    resend_cooldown_seconds: float = DEFAULT_RESEND_COOLDOWN_SECONDS
    max_attempts: int = DEFAULT_MAX_ATTEMPTS
    reset_token_ttl_seconds: float = DEFAULT_RESET_TOKEN_TTL_SECONDS

    @staticmethod
    def _challenge_key(phone_e164: str, purpose: Purpose) -> str:
        return f"{purpose.value}:{phone_e164}"

    async def send(self, phone_e164: str, purpose: Purpose) -> SendResult:
        key = self._challenge_key(phone_e164, purpose)
        existing = self.store.get_challenge(key)
        if (
            existing is not None
            and not existing.consumed
            and (time.time() - existing.created_at) < self.resend_cooldown_seconds
        ):
            return SendResult.COOLDOWN

        try:
            uid = await self.uids.resolve(phone_e164)
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
            # No account has this phone number verified on its Firebase
            # Auth record. No challenge is created and the WhatsApp API
            # is never called -- but the HTTP handler still returns the
            # exact same response as SENT either way (see
            # app/otp/handler.py), so this is invisible to whoever's
            # asking. Same enumeration-safety pattern as
            # app.auth.reset.Handler.forgot_password's ErrUserNotFound
            # handling for email.
            self.logger.info("otp send: no account for this phone", extra={"purpose": purpose.value})
            return SendResult.NOOP

        code = generate_otp()
        now = time.time()
        challenge = Challenge(
            phone_e164=phone_e164,
            purpose=purpose.value,
            otp_hash=hash_otp(code, self.otp_secret),
            uid=uid,
            created_at=now,
            expires_at=now + self.otp_ttl_seconds,
            max_attempts=self.max_attempts,
        )
        # Overwriting the same key immediately invalidates whatever OTP
        # was pending before it -- only the newest code for a given
        # phone+purpose is ever valid ("invalidate/replace previous OTP
        # when appropriate").
        self.store.create_challenge(key, challenge)

        try:
            await self.sender.send_otp_message(phone_e164, code)
        except Exception as exc:
            # Never reveal a delivery failure to the caller -- same
            # reasoning as forgot_password's email-send failure path.
            # The code value itself is never part of this log line.
            self.logger.error(
                "otp send: whatsapp provider failed", extra={"purpose": purpose.value, "error": str(exc)}
            )
        else:
            self.logger.info("otp send: delivery attempted", extra={"purpose": purpose.value})
        return SendResult.SENT

    def verify(self, phone_e164: str, purpose: Purpose, code: str) -> tuple[VerifyResult, str | None]:
        """Returns (result, reset_token). reset_token is only non-None on
        VerifyResult.OK."""
        key = self._challenge_key(phone_e164, purpose)
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

        reset_token = secrets.token_urlsafe(32)
        now = time.time()
        self.store.create_reset_token(
            reset_token,
            ResetToken(
                uid=challenge.uid,
                phone_e164=phone_e164,
                purpose=purpose.value,
                created_at=now,
                expires_at=now + self.reset_token_ttl_seconds,
            ),
        )
        return VerifyResult.OK, reset_token
